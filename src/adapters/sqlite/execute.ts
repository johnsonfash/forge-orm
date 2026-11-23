import type {
  CountNode,
  DeleteNode,
  GroupByNode,
  InsertNode,
  RelationPlan,
  SelectNode,
  UpdateNode,
} from '../../ir/types';
import type { ModelDef } from '../../schema/types';
import { schema } from '../../schema';
import {
  compileCount,
  compileDelete,
  compileGroupBy,
  compileInsert,
  compileSelect,
  compileUpdate,
} from './compile-from-ir';
import { withSqliteErrors } from './errors';
import { rowDecoder, parseJsonText, type Convert } from '../shared/row-decoder';
import type { SqliteDriver } from './driver';
import { fromDriverBytes } from '../../bytes';
import { hydrateManyRelation, hydrateOneRelation, liftRelationCounts, type WindowedPaging } from '../../ir/hydrate-many';
import { refineFallbackGeo } from '../shared/haversine';

// Window functions are always available here, so a nested page is one query.
const WINDOWED: WindowedPaging = { enabled: true };

// SQLite IR executor. Talks to a SqliteDriver port (see driver.ts), so it works
// over a synchronous driver (better-sqlite3) or an async one (expo-sqlite,
// op-sqlite, libsql) without change — every call is awaited.

// Retained as an alias: callers still refer to `SqliteDb` as the handle type.
export type SqliteDb = SqliteDriver;

export interface SqliteExecOpts {
  // Inside a $transaction the same driver handle is passed back here.
  db?: SqliteDriver;
}

// SQLite returns bools as 0/1, dates as ISO strings, JSON columns as strings;
// re-hydrate at the executor edge to the schema's JS types.
const decodePlans = new WeakMap<object, any>();
const toBool = (v: any) => v === 1 || v === true;
const toDate = (v: any) => (typeof v === 'string' ? new Date(v) : v);
function sqliteConvert(kind: string): Convert | null {
  switch (kind) {
    // better-sqlite3 / mysql2 hand back a Buffer, the wasm build a
    // Uint8Array. Normalise so the row shape is driver-independent.
    case 'bytes': return fromDriverBytes;
    case 'bool': return toBool;
    case 'dateTime': return toDate;
    case 'json': case 'embed': case 'embedMany': case 'stringArray': case 'intArray':
      return parseJsonText;
    default: return null;
  }
}

/** Decodes a driver row in place (the driver hands each call fresh objects). */
export function decodeRow(model: ModelDef<any>, row: any): any {
  return rowDecoder(decodePlans, model, sqliteConvert)(row);
}

function decodeRows(model: ModelDef<any>, rows: any[]): any[] {
  const dec = rowDecoder(decodePlans, model, sqliteConvert);
  for (let i = 0; i < rows.length; i++) rows[i] = dec(rows[i]);
  return rows;
}


// Encode params for the driver: dates → ISO strings, bools → 0/1, JSON-ish
// values → JSON.stringify. The compiler already coerces known schema fields;
// this is the safety net for raw queries.
function encodeParams(params: unknown[]): unknown[] {
  return params.map((v) => {
    if (v == null) return v;
    if (v instanceof Date) return v.toISOString();
    if (typeof v === 'boolean') return v ? 1 : 0;
    // Buffer is Node-only — guard so wasm/browser bundles don't blow up at
    // module-eval time. Uint8Array passes through untouched in either runtime.
    if (typeof v === 'object' && !isBufferLike(v) && !Array.isArray(v)) {
      return JSON.stringify(v);
    }
    if (Array.isArray(v)) return JSON.stringify(v);
    return v;
  });
}

function isBufferLike(v: unknown): boolean {
  if (v instanceof Uint8Array) return true;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const B = (globalThis as any).Buffer;
  return !!B && typeof B.isBuffer === 'function' && B.isBuffer(v);
}

export async function executeSqliteSelect(
  db: SqliteDriver,
  node: SelectNode,
  model: ModelDef<any>,
  opts: SqliteExecOpts = {},
): Promise<any[]> {
  const exec = opts.db ?? db;
  const artifact = compileSelect(node, model);
  const raw = await withSqliteErrors(() => exec.all(artifact.sql, encodeParams(artifact.params)));
  let rows = decodeRows(model, raw);
  if (node.distinct?.length) rows = dedupeBy(rows, node.distinct);
  // Fallback geoPoint refinement — exact-circle + sort post-process.
  rows = refineFallbackGeo(rows, node, model);
  if (node.projection?.counts?.length) liftRelationCounts(rows, node.projection.counts);
  if (node.hydration?.length) await hydrate(exec, rows, model, node.hydration);
  return rows;
}

export async function executeSqliteCount(
  db: SqliteDriver,
  node: CountNode,
  model: ModelDef<any>,
  opts: SqliteExecOpts = {},
): Promise<number> {
  const exec = opts.db ?? db;
  const artifact = compileCount(node, model);
  const r = await withSqliteErrors(() => exec.get(artifact.sql, encodeParams(artifact.params)));
  return Number(r?.count ?? 0);
}

export async function executeSqliteGroupBy(
  db: SqliteDriver,
  node: GroupByNode,
  model: ModelDef<any>,
  opts: SqliteExecOpts = {},
): Promise<any[]> {
  const exec = opts.db ?? db;
  const artifact = compileGroupBy(node, model);
  const rows = await withSqliteErrors(() => exec.all(artifact.sql, encodeParams(artifact.params)));
  return rows.map((r) => reshapeGroupByRow(r, node.by));
}

function reshapeGroupByRow(row: any, byCols: string[]): any {
  const out: any = {};
  for (const c of byCols) out[c] = row[c];
  for (const k of Object.keys(row)) {
    const m = k.match(/^__agg_(count|avg|sum|min|max)_(.+)$/);
    if (!m) continue;
    out[`_${m[1]}`] ??= {};
    out[`_${m[1]}`][m[2]] = row[k];
  }
  return out;
}

// Writes use RETURNING * (SQLite 3.35+, 2021).

export async function executeSqliteInsert(
  db: SqliteDriver,
  node: InsertNode,
  model: ModelDef<any>,
  opts: SqliteExecOpts = {},
): Promise<{ docs: any[]; count: number }> {
  const exec = opts.db ?? db;
  const artifact = compileInsert(node, model);
  if (node.countOnly) {
    const r = await withSqliteErrors(() => exec.run(artifact.sql, encodeParams(artifact.params)));
    return { docs: [], count: r.changes };
  }
  const raw = await withSqliteErrors(() => exec.all(artifact.sql, encodeParams(artifact.params)));
  const docs = raw.map((r) => decodeRow(model, r));
  return { docs, count: docs.length };
}

export async function executeSqliteUpdate(
  db: SqliteDriver,
  node: UpdateNode,
  model: ModelDef<any>,
  opts: SqliteExecOpts = {},
): Promise<{ doc?: any; count: number }> {
  const exec = opts.db ?? db;
  const artifact = compileUpdate(node, model);
  if (node.many) {
    const r = await withSqliteErrors(() => exec.run(artifact.sql, encodeParams(artifact.params)));
    return { count: r.changes };
  }
  const raw = await withSqliteErrors(() => exec.all(artifact.sql, encodeParams(artifact.params)));
  return { doc: raw.length ? decodeRow(model, raw[0]) : undefined, count: raw.length };
}

export async function executeSqliteDelete(
  db: SqliteDriver,
  node: DeleteNode,
  model: ModelDef<any>,
  opts: SqliteExecOpts = {},
): Promise<{ doc?: any; count: number }> {
  const exec = opts.db ?? db;
  const artifact = compileDelete(node, model);
  if (node.many) {
    const r = await withSqliteErrors(() => exec.run(artifact.sql, encodeParams(artifact.params)));
    return { count: r.changes };
  }
  const raw = await withSqliteErrors(() => exec.all(artifact.sql, encodeParams(artifact.params)));
  return { doc: raw.length ? decodeRow(model, raw[0]) : undefined, count: raw.length };
}

async function hydrate(
  db: SqliteDriver,
  rows: any[],
  parentModel: ModelDef<any>,
  hydration: RelationPlan[],
): Promise<void> {
  if (rows.length === 0) return;
  for (const rel of hydration) {
    const targetModel = (schema as any)[rel.target] as ModelDef<any> | undefined;
    if (!targetModel) continue;
    const isOwningOne = rel.kind === 'one' && parentModel.fields[rel.on] != null;
    if (isOwningOne) await hydrateOne(db, rows, rel, targetModel, /*owning*/ true);
    else if (rel.kind === 'one') await hydrateOne(db, rows, rel, targetModel, /*owning*/ false);
    else await hydrateMany(db, rows, rel, targetModel);
  }
}

async function hydrateOne(
  db: SqliteDriver,
  rows: any[],
  rel: RelationPlan,
  targetModel: ModelDef<any>,
  owning: boolean,
): Promise<void> {
  await hydrateOneRelation({
    rows, rel,
    parentField: owning ? rel.on : rel.refs,
    targetField: owning ? rel.refs : rel.on,
    keyOf: (v) => String(v),
    runSelect: (node) => executeSqliteSelect(db, node, targetModel),
  });
}

async function hydrateMany(
  db: SqliteDriver,
  rows: any[],
  rel: RelationPlan,
  targetModel: ModelDef<any>,
): Promise<void> {
  await hydrateManyRelation({
    rows, rel, keyOf: (v) => String(v),
    runSelect: (node) => executeSqliteSelect(db, node, targetModel),
    windowed: WINDOWED,
  });
}

function dedupeBy(rows: any[], fields: string[]): any[] {
  const seen = new Set<string>();
  const out: any[] = [];
  for (const r of rows) {
    const k = fields.map((f) => JSON.stringify(r[f] ?? null)).join('\x1e');
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(r);
  }
  return out;
}
