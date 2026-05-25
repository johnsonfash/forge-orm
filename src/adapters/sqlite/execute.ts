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

// SQLite IR executor.
//
// `better-sqlite3` is a SYNCHRONOUS driver — every call returns immediately,
// no Promises. To keep forge's executor surface async, we wrap each call in
// Promise.resolve(). This isn't actually concurrent — Node won't yield mid-
// query — but it preserves the contract callers expect.
//
// Why no async driver? `better-sqlite3` is dramatically faster than
// alternatives for typical use cases precisely because it doesn't pay the
// async overhead. SQLite is a local file; there's no I/O to overlap.

// Minimal shape of better-sqlite3.Database that the executor uses. Lets us
// stub it in tests.
export interface SqliteDb {
  prepare(sql: string): SqliteStatement;
  pragma(name: string): unknown;
  exec(sql: string): unknown;
  inTransaction?: boolean;
}

export interface SqliteStatement {
  all(...params: unknown[]): any[];
  get(...params: unknown[]): any;
  run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint };
}

export interface SqliteExecOpts {
  // When inside a $transaction, the same db handle is passed back through
  // here (better-sqlite3 doesn't have per-call sessions — transactions are
  // implicit via BEGIN/COMMIT statements).
  db?: SqliteDb;
}

// ─── Decode rows ─────────────────────────────────────────────────────────
//
// SQLite returns booleans as 0/1, dates as ISO strings, JSON columns as
// strings. We re-hydrate at the executor edge so callers see proper JS
// types matching the schema.

export function decodeRow(model: ModelDef<any>, row: any): any {
  if (!row || typeof row !== 'object') return row;
  const out: any = {};
  for (const k of Object.keys(row)) {
    const field = model.fields[k];
    if (!field) { out[k] = row[k]; continue; }
    const v = row[k];
    if (v == null) { out[k] = v; continue; }
    switch (field.kind) {
      case 'bool':       out[k] = v === 1 || v === true; break;
      case 'dateTime':   out[k] = typeof v === 'string' ? new Date(v) : v; break;
      case 'json':
      case 'embed':
      case 'embedMany':
      case 'stringArray':
      case 'intArray':
        out[k] = typeof v === 'string' ? safeParse(v) : v;
        break;
      default:           out[k] = v;
    }
  }
  return out;
}

function safeParse(s: string): any {
  try { return JSON.parse(s); } catch { return s; }
}

// Encode params for the driver: dates → ISO strings, bools → 0/1, JSON-ish
// values → JSON.stringify. The compiler already did some of this for known
// fields; this is a safety net for raw queries.
function encodeParams(params: unknown[]): unknown[] {
  return params.map((v) => {
    if (v == null) return v;
    if (v instanceof Date) return v.toISOString();
    if (typeof v === 'boolean') return v ? 1 : 0;
    if (typeof v === 'object' && !Buffer.isBuffer(v) && !Array.isArray(v)) {
      // structuredClone-ish — most plain objects get JSON-stringified by the
      // schema field type at row build time; this catches stragglers.
      return JSON.stringify(v);
    }
    if (Array.isArray(v)) return JSON.stringify(v);
    return v;
  });
}

// ─── Reads ──────────────────────────────────────────────────────────────────

export async function executeSqliteSelect(
  db: SqliteDb,
  node: SelectNode,
  model: ModelDef<any>,
  opts: SqliteExecOpts = {},
): Promise<any[]> {
  const exec = opts.db ?? db;
  const artifact = compileSelect(node, model);
  const raw = await withSqliteErrors(() =>
    exec.prepare(artifact.sql).all(...encodeParams(artifact.params)),
  );
  let rows = raw.map((r) => decodeRow(model, r));
  if (node.distinct?.length) rows = dedupeBy(rows, node.distinct);
  if (node.projection?.counts?.length) await applyRelationCounts(exec, rows, model, node.projection.counts);
  if (node.hydration?.length) await hydrate(exec, rows, model, node.hydration);
  return rows;
}

export async function executeSqliteCount(
  db: SqliteDb,
  node: CountNode,
  model: ModelDef<any>,
  opts: SqliteExecOpts = {},
): Promise<number> {
  const exec = opts.db ?? db;
  const artifact = compileCount(node, model);
  const r = await withSqliteErrors(() =>
    exec.prepare(artifact.sql).get(...encodeParams(artifact.params)),
  );
  return Number(r?.count ?? 0);
}

export async function executeSqliteGroupBy(
  db: SqliteDb,
  node: GroupByNode,
  model: ModelDef<any>,
  opts: SqliteExecOpts = {},
): Promise<any[]> {
  const exec = opts.db ?? db;
  const artifact = compileGroupBy(node, model);
  const rows = await withSqliteErrors(() =>
    exec.prepare(artifact.sql).all(...encodeParams(artifact.params)),
  );
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

// ─── Writes — RETURNING * works since SQLite 3.35 (2021) ────────────────────

export async function executeSqliteInsert(
  db: SqliteDb,
  node: InsertNode,
  model: ModelDef<any>,
  opts: SqliteExecOpts = {},
): Promise<{ docs: any[]; count: number }> {
  const exec = opts.db ?? db;
  const artifact = compileInsert(node, model);
  const raw = await withSqliteErrors(() =>
    exec.prepare(artifact.sql).all(...encodeParams(artifact.params)),
  );
  const docs = raw.map((r) => decodeRow(model, r));
  return { docs, count: docs.length };
}

export async function executeSqliteUpdate(
  db: SqliteDb,
  node: UpdateNode,
  model: ModelDef<any>,
  opts: SqliteExecOpts = {},
): Promise<{ doc?: any; count: number }> {
  const exec = opts.db ?? db;
  const artifact = compileUpdate(node, model);
  const raw = await withSqliteErrors(() =>
    exec.prepare(artifact.sql).all(...encodeParams(artifact.params)),
  );
  const decoded = raw.map((r) => decodeRow(model, r));
  if (node.many) return { count: decoded.length };
  return { doc: decoded[0], count: decoded.length };
}

export async function executeSqliteDelete(
  db: SqliteDb,
  node: DeleteNode,
  model: ModelDef<any>,
  opts: SqliteExecOpts = {},
): Promise<{ doc?: any; count: number }> {
  const exec = opts.db ?? db;
  const artifact = compileDelete(node, model);
  const raw = await withSqliteErrors(() =>
    exec.prepare(artifact.sql).all(...encodeParams(artifact.params)),
  );
  const decoded = raw.map((r) => decodeRow(model, r));
  if (node.many) return { count: decoded.length };
  return { doc: decoded[0], count: decoded.length };
}

// ─── Hydration / counts (same pattern as PG, sync wrapped) ──────────────────

async function hydrate(
  db: SqliteDb,
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
  db: SqliteDb,
  rows: any[],
  rel: RelationPlan,
  targetModel: ModelDef<any>,
  owning: boolean,
): Promise<void> {
  const fromField = owning ? rel.on : rel.refs;
  const toField   = owning ? rel.refs : rel.on;
  const fks = unique(rows.map((r) => r[fromField]).filter((v) => v != null));
  if (fks.length === 0) { for (const r of rows) r[rel.name] = null; return; }
  const subNode: SelectNode = {
    kind: 'select', model: rel.target, cardinality: 'many',
    where: { kind: 'leaf', field: toField, op: 'in', value: fks },
    ...(rel.nested ?? {}),
  };
  const found = await executeSqliteSelect(db, subNode, targetModel);
  const byKey = new Map<string, any>();
  for (const t of found) byKey.set(String(t[toField]), t);
  for (const r of rows) {
    const k = r[fromField];
    r[rel.name] = k == null ? null : (byKey.get(String(k)) ?? null);
  }
}

async function hydrateMany(
  db: SqliteDb,
  rows: any[],
  rel: RelationPlan,
  targetModel: ModelDef<any>,
): Promise<void> {
  const refs = unique(rows.map((r) => r[rel.refs]).filter((v) => v != null));
  if (refs.length === 0) { for (const r of rows) r[rel.name] = []; return; }
  const nestedWhere = (rel.nested as any)?.where;
  const fkLeaf = { kind: 'leaf' as const, field: rel.on, op: 'in' as const, value: refs };
  const where = nestedWhere
    ? { kind: 'and' as const, children: [nestedWhere, fkLeaf] }
    : fkLeaf;
  const subNode: SelectNode = {
    kind: 'select', model: rel.target, cardinality: 'many',
    ...(rel.nested ?? {}),
    where,
  };
  const found = await executeSqliteSelect(db, subNode, targetModel);
  const byParent = new Map<string, any[]>();
  for (const t of found) {
    const k = String(t[rel.on]);
    const list = byParent.get(k);
    if (list) list.push(t);
    else byParent.set(k, [t]);
  }
  for (const r of rows) r[rel.name] = byParent.get(String(r[rel.refs])) ?? [];
}

async function applyRelationCounts(
  db: SqliteDb,
  rows: any[],
  parentModel: ModelDef<any>,
  counts: string[],
): Promise<void> {
  if (rows.length === 0) return;
  const relMap = parentModel.relations();
  for (const r of rows) r._count = r._count ?? {};
  for (const relName of counts) {
    const rel = relMap[relName];
    if (!rel) continue;
    const targetModel = (schema as any)[rel.target] as ModelDef<any> | undefined;
    if (!targetModel) continue;
    const refs = unique(rows.map((r) => r[rel.refs]).filter((v) => v != null));
    if (refs.length === 0) { for (const r of rows) r._count[relName] = 0; continue; }
    // SQLite supports IN (?, ?, ?, …) but not ANY($1) array syntax.
    const placeholders = refs.map(() => '?').join(', ');
    const sql = `SELECT "${rel.on}" AS fk, COUNT(*) AS c FROM "${targetModel.collection}" WHERE "${rel.on}" IN (${placeholders}) GROUP BY "${rel.on}"`;
    const groups = await withSqliteErrors(() => db.prepare(sql).all(...encodeParams(refs)));
    const byFk = new Map<string, number>();
    for (const g of groups) byFk.set(String(g.fk), Number(g.c));
    for (const r of rows) r._count[relName] = byFk.get(String(r[rel.refs])) ?? 0;
  }
}

// ─── Utils ──────────────────────────────────────────────────────────────────

function unique<T>(arr: T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const v of arr) { const k = String(v); if (seen.has(k)) continue; seen.add(k); out.push(v); }
  return out;
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
