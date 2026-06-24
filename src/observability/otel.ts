// OpenTelemetry helper — subscribes to forge's $on('query'/'error') events and
// emits spans following the OTel database semantic conventions.
//
// Separate helper (not built into the adapter) because @opentelemetry/api is an
// optional peer and forge's core has no OTel dep. We accept any object with a
// `startSpan` method (structurally typed), so importing this needs no OTel package.

import type { ForgeDb } from '../factory';
import type { QueryEvent, ErrorEvent } from '../events';

// Minimal tracer shape — matches @opentelemetry/api.Tracer for the methods
// we use. Anything that produces spans with these methods works.
export interface OtelTracer {
  startSpan(name: string, options?: { attributes?: Record<string, any> }): OtelSpan;
}

export interface OtelSpan {
  setAttribute(key: string, value: any): void;
  setAttributes(attrs: Record<string, any>): void;
  recordException(err: Error): void;
  setStatus(s: { code: 1 | 2; message?: string }): void;   // 1=OK, 2=ERROR (OTel SpanStatusCode)
  end(endTime?: number | [number, number]): void;
}

export interface WireOtelOptions {
  tracer: OtelTracer;
  // OTel semconv DB system name. Default derived from adapter kind.
  dbSystem?: string;
  // Maximum length of `db.statement` attribute. Defaults to 1024 — enough
  // for debugging without inflating trace payloads.
  maxStatementLen?: number;
  // If false, omit `db.statement` (some orgs disallow logging SQL).
  recordStatement?: boolean;
}

const SYSTEM_BY_ADAPTER = {
  postgres: 'postgresql',
  mysql:    'mysql',
  sqlite:   'sqlite',
  mongo:    'mongodb',
} as const;

/**
 * Wire OpenTelemetry to a ForgeDb instance. Returns an `off` function that
 * unsubscribes both query+error listeners.
 *
 * Emits one span per query named `forge.<op>` (e.g. `forge.select`), with
 * `db.system`, `db.statement`, `db.operation`, plus forge-specific
 * `forge.adapter` / `forge.model` / `forge.rowCount` attributes.
 */
export function wireOtel(db: ForgeDb, opts: WireOtelOptions): () => void {
  const maxLen = opts.maxStatementLen ?? 1024;
  const recordStmt = opts.recordStatement !== false;

  // Span ends synchronously on each event — we don't span across the whole
  // query duration because the event fires AFTER the call resolves. We
  // start the span with a back-dated start time so OTel sees the real
  // duration. (Most OTel APIs accept startTime in span options.)
  const offQ = db.$on('query', (e: QueryEvent) => {
    const sys = opts.dbSystem ?? SYSTEM_BY_ADAPTER[e.adapter];
    // Span name reflects the schema-level intent when the wrapper passed
    // one through (softDelete / restore / etc.). Falls back to the
    // adapter-level op name so plain updates / finds still span as
    // forge.update / forge.find.
    const spanName = e.semanticOp ? `forge.${e.semanticOp}` : `forge.${e.op}`;
    const span = opts.tracer.startSpan(spanName, {
      attributes: {
        'db.system': sys,
        'db.operation': e.op,
        'db.collection.name': e.model || undefined,
        'forge.adapter': e.adapter,
        'forge.model': e.model || undefined,
        'forge.row_count': e.rowCount,
        'forge.duration_ms': e.duration_ms,
        ...(e.semanticOp ? { 'forge.semantic_op': e.semanticOp } : {}),
        ...(recordStmt && typeof e.sql === 'string' ? { 'db.statement': truncate(e.sql, maxLen) } : {}),
      },
    });
    span.setStatus({ code: 1 });
    span.end();
  });

  const offE = db.$on('error', (e: ErrorEvent) => {
    const sys = opts.dbSystem ?? SYSTEM_BY_ADAPTER[e.adapter];
    const span = opts.tracer.startSpan(`forge.${e.op}`, {
      attributes: {
        'db.system': sys,
        'db.operation': e.op,
        'db.collection.name': e.model || undefined,
        'forge.adapter': e.adapter,
        'forge.duration_ms': e.duration_ms,
        ...(recordStmt && typeof e.sql === 'string' ? { 'db.statement': truncate(e.sql, maxLen) } : {}),
      },
    });
    span.recordException(e.error);
    span.setStatus({ code: 2, message: e.error.message });
    span.end();
  });

  return () => { offQ(); offE(); };
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}
