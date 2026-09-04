// `db.$explain()` — see the query without running it.
//
// The standing complaint about a Prisma-shaped ORM is that you cannot see
// what it sends. `.compile.<op>()` has always answered that for a single
// op, but you had to know the op's name and rebuild the call by hand,
// which is exactly the moment you stop bothering.
//
//     const report = await db.$explain((q) => q.user.findMany({ where }));
//     console.log(report.toString());
//
// Nothing executes. The callback's query is intercepted, compiled, and
// handed back as SQL + params — plus, with `{ analyze: true }`, the
// database's own query plan.
//
// ── Why EXPLAIN and never EXPLAIN ANALYZE ─────────────────────────────
//
// `EXPLAIN` plans a statement. `EXPLAIN ANALYZE` *runs* it and reports
// what really happened — which on `deleteMany` deletes the rows. A dry-run
// API that deletes data on a flag is the kind of silent-consequence bug R2
// exists to prevent, so forge does not emit ANALYZE at all, and says so
// rather than leaving you to discover the distinction.

import type { CompiledArtifact, MongoArtifact, SQLArtifact, SQLDialect } from './compile';
import type { SqlFragment } from './raw-sql';

export interface ExplainedQuery {
  /** Schema name, as written — `User`. */
  model: string;
  /** Table or collection the query targets — `users`. */
  table: string;
  /** `findMany`, `count`, `updateMany`, … */
  op: string;
  /** SQL + params, or the Mongo command bundle. */
  artifact: CompiledArtifact;
  /**
   * The same SQL with parameters substituted, for reading.
   *
   * NOT for executing. The values are quoted for legibility, not for
   * safety, and re-parsing this string is how a parameterised query
   * becomes an injection. `artifact.sql` + `artifact.params` is the pair
   * you run. Absent on Mongo.
   */
  readable?: string;
  /** The database's own plan. Only present with `{ analyze: true }`. */
  plan?: unknown;
}

export interface ExplainReport {
  dialect: SQLDialect | 'mongo';
  queries: ExplainedQuery[];
  /** Whether a plan was fetched from the database. */
  analyzed: boolean;
  toString(): string;
}

// ── Placeholder tokenizing ────────────────────────────────────────────
//
// Splitting compiled SQL back at its placeholders looks like a one-line
// regex and is not. `?` and `$1` both appear inside string literals and
// quoted identifiers, and Postgres additionally uses `$` to open a
// dollar-quoted string — so `$1` is a placeholder and `$tag$` is the start
// of a literal that may itself contain `$1`. A regex gets this wrong on
// exactly the queries that matter (a LIKE pattern containing `?`), and it
// gets it wrong silently, producing SQL that still parses.

export interface SplitSql {
  /** Literal chunks. Always `holes.length + 1` of them. */
  chunks: string[];
  /**
   * The parameter index each gap binds to. Sequential for `?` dialects;
   * for Postgres it is `$n - 1`, so a repeated or out-of-order `$n` maps
   * to the right value.
   */
  holes: number[];
}

const QUOTE_CLOSERS: Record<string, string> = { "'": "'", '"': '"', '`': '`', '[': ']' };

/** Split compiled SQL at its parameter placeholders. */
export function splitSql(sql: string, dialect: SQLDialect): SplitSql {
  const numbered = dialect === 'postgres';
  const chunks: string[] = [];
  const holes: number[] = [];
  let buf = '';
  let i = 0;
  let seq = 0;

  while (i < sql.length) {
    const c = sql[i]!;

    // Line comment — to end of line, placeholders inside are text.
    if (c === '-' && sql[i + 1] === '-') {
      const nl = sql.indexOf('\n', i);
      const end = nl === -1 ? sql.length : nl + 1;
      buf += sql.slice(i, end);
      i = end;
      continue;
    }
    // Block comment. Postgres nests these; the others do not. Counting
    // depth is correct for Postgres and harmless elsewhere, because an
    // unnested `/*` inside a comment is not legal SQL anyway.
    if (c === '/' && sql[i + 1] === '*') {
      let depth = 1;
      let j = i + 2;
      while (j < sql.length && depth > 0) {
        if (sql[j] === '/' && sql[j + 1] === '*') { depth++; j += 2; }
        else if (sql[j] === '*' && sql[j + 1] === '/') { depth--; j += 2; }
        else j++;
      }
      buf += sql.slice(i, j);
      i = j;
      continue;
    }
    // Quoted string or identifier. A doubled closer is an escaped closer,
    // not the end — 'it''s' is one literal, and treating it as two is how
    // the rest of the statement shifts out of alignment.
    const closer = QUOTE_CLOSERS[c];
    if (closer) {
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === closer) {
          if (sql[j + 1] === closer) { j += 2; continue; }
          j++;
          break;
        }
        j++;
      }
      buf += sql.slice(i, j);
      i = j;
      continue;
    }
    // Postgres dollar-quoting: $$…$$ or $tag$…$tag$. Must be settled
    // BEFORE `$n`, or the `1` in `$1` and the `x` in `$x$` look alike.
    if (numbered && c === '$') {
      const tag = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i));
      if (tag) {
        const marker = tag[0];
        const close = sql.indexOf(marker, i + marker.length);
        const end = close === -1 ? sql.length : close + marker.length;
        buf += sql.slice(i, end);
        i = end;
        continue;
      }
      const num = /^\$(\d+)/.exec(sql.slice(i));
      if (num) {
        chunks.push(buf);
        buf = '';
        holes.push(Number(num[1]) - 1);
        i += num[0].length;
        continue;
      }
    }
    if (!numbered && c === '?') {
      chunks.push(buf);
      buf = '';
      holes.push(seq++);
      i++;
      continue;
    }
    buf += c;
    i++;
  }

  chunks.push(buf);
  return { chunks, holes };
}

/**
 * Rebuild compiled SQL as a `SqlFragment`, so it can go back through
 * `$queryRaw` with its parameters still bound rather than pasted in.
 *
 * A repeated Postgres `$1` becomes two separately-bound parameters
 * carrying the same value. Same plan, same result — the numbering is an
 * artifact of the round trip, not a change of meaning.
 */
export function fragmentFromSql(
  sql: string,
  params: readonly unknown[],
  dialect: SQLDialect,
  prefix = '',
): SqlFragment {
  const { chunks, holes } = splitSql(sql, dialect);
  const values = holes.map((h) => params[h]);
  const strings = chunks.slice();
  strings[0] = prefix + strings[0];
  return { __forgeSql: true, strings, values } as SqlFragment;
}

/** Render a value as a SQL literal. For reading only — see `readable`. */
function literal(v: unknown): string {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number' || typeof v === 'bigint') return String(v);
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  if (v instanceof Date) return `'${v.toISOString()}'`;
  if (Array.isArray(v)) return `(${v.map(literal).join(', ')})`;
  if (v instanceof Uint8Array) return `<${v.byteLength} bytes>`;
  if (typeof v === 'object') return `'${JSON.stringify(v).replace(/'/g, "''")}'`;
  return `'${String(v).replace(/'/g, "''")}'`;
}

/**
 * The SQL with its parameters substituted, for reading and for handing to
 * somebody else.
 *
 * Never execute the result. Quoting here serves legibility, not safety.
 */
export function inlineParams(
  sql: string,
  params: readonly unknown[],
  dialect: SQLDialect,
): string {
  const { chunks, holes } = splitSql(sql, dialect);
  let out = chunks[0]!;
  for (let i = 0; i < holes.length; i++) {
    out += literal(params[holes[i]!]) + chunks[i + 1]!;
  }
  return out;
}

// ── Formatting ────────────────────────────────────────────────────────

const isSql = (a: CompiledArtifact): a is SQLArtifact => a.kind === 'sql';
const isMongo = (a: CompiledArtifact): a is MongoArtifact => a.kind === 'mongo';

function indent(text: string, pad = '  '): string {
  return text.split('\n').map((l) => (l ? pad + l : l)).join('\n');
}

/**
 * A plan as text.
 *
 * SQLite returns a row per step whose `detail` is the sentence you
 * actually want ("SEARCH users USING INDEX users_age (age>?)"), wrapped
 * in `id`/`parent`/`notused` columns that are noise at a glance. Those
 * lines are lifted out; `query.plan` still holds the raw rows for anyone
 * walking the tree. Postgres and MySQL return structured JSON, which is
 * left as JSON because that is what their own tooling reads.
 */
function renderPlan(plan: unknown): string {
  if (typeof plan === 'string') return plan;
  if (
    Array.isArray(plan) &&
    plan.length > 0 &&
    plan.every((r) => r && typeof (r as any).detail === 'string')
  ) {
    return plan.map((r) => (r as any).detail as string).join('\n');
  }
  return JSON.stringify(plan, null, 2);
}

/** Human-readable report — what `report.toString()` returns. */
export function formatExplain(r: ExplainReport): string {
  if (r.queries.length === 0) return '(no queries captured)';
  const out: string[] = [];

  r.queries.forEach((q, n) => {
    const head = r.queries.length > 1 ? `${n + 1}. ` : '';
    out.push(`${head}${q.model}.${q.op}  →  ${q.table}  [${r.dialect}]`);
    out.push('');

    if (isSql(q.artifact)) {
      out.push(indent(q.artifact.sql));
      if (q.artifact.params.length) {
        out.push('');
        out.push(indent(`params: ${q.artifact.params.map((p) => literal(p)).join(', ')}`));
      }
      if (q.readable) {
        out.push('');
        out.push(indent('-- with values inlined (for reading, not for running):'));
        out.push(indent(q.readable));
      }
    } else if (isMongo(q.artifact)) {
      out.push(indent(`db.${q.table}.${q.artifact.op}(`));
      out.push(indent(JSON.stringify(q.artifact.args, null, 2), '    '));
      out.push(indent(')'));
    }

    if (q.plan !== undefined) {
      out.push('');
      out.push(indent('-- plan:'));
      out.push(indent(renderPlan(q.plan)));
    }
    if (n < r.queries.length - 1) out.push('');
  });

  return out.join('\n');
}

// ── Per-dialect EXPLAIN prefixes ──────────────────────────────────────
//
// Every one of these PLANS the statement. None of them run it. That is
// the whole reason `EXPLAIN ANALYZE` is absent: it would execute, and a
// dry run that deletes rows is not a dry run.

export function explainPrefix(dialect: SQLDialect): string {
  switch (dialect) {
    case 'postgres': return 'EXPLAIN (FORMAT JSON) ';
    case 'mysql':    return 'EXPLAIN FORMAT=JSON ';
    case 'sqlite':   return 'EXPLAIN QUERY PLAN ';
    case 'duckdb':   return 'EXPLAIN ';
    case 'mssql':
      throw new Error(
        `[forge] $explain({ analyze: true }) is not available on SQL Server. ` +
        `Its plan comes from SET SHOWPLAN_XML ON, which must be the only ` +
        `statement in its batch and changes connection state — forge will not ` +
        `do that behind your back on a pooled connection.\n` +
        `  → run $explain() without 'analyze' for the SQL and params, then ` +
        `paste it into SSMS with 'Include Actual Execution Plan'.`,
      );
  }
}
