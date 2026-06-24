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
import type { SqliteDriver } from './driver';

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
  let rows = raw.map((r) => decodeRow(model, r));
  if (node.distinct?.length) rows = dedupeBy(rows, node.distinct);
  // Fallback geoPoint refinement — exact-circle + sort post-process.
  const { extractFallbackGeoOps, applyHaversinePostFilter } = await import('../shared/haversine');
  const geoOps = extractFallbackGeoOps(node, model);
  if (geoOps.near || geoOps.nearTo || geoOps.withinPolygon) {
    rows = applyHaversinePostFilter(rows, geoOps.near, geoOps.nearTo, geoOps.withinPolygon);
  }
  if (node.projection?.counts?.length) await applyRelationCounts(exec, rows, model, node.projection.counts);
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
  const raw = await withSqliteErrors(() => exec.all(artifact.sql, encodeParams(artifact.params)));
  const decoded = raw.map((r) => decodeRow(model, r));
  if (node.many) return { count: decoded.length };
  return { doc: decoded[0], count: decoded.length };
}

export async function executeSqliteDelete(
  db: SqliteDriver,
  node: DeleteNode,
  model: ModelDef<any>,
  opts: SqliteExecOpts = {},
): Promise<{ doc?: any; count: number }> {
  const exec = opts.db ?? db;
  const artifact = compileDelete(node, model);
  const raw = await withSqliteErrors(() => exec.all(artifact.sql, encodeParams(artifact.params)));
  const decoded = raw.map((r) => decodeRow(model, r));
  if (node.many) return { count: decoded.length };
  return { doc: decoded[0], count: decoded.length };
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
  db: SqliteDriver,
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
  db: SqliteDriver,
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
    const groups = await withSqliteErrors(() => db.all(sql, encodeParams(refs)));
    const byFk = new Map<string, number>();
    for (const g of groups) byFk.set(String(g.fk), Number(g.c));
    for (const r of rows) r._count[relName] = byFk.get(String(r[rel.refs])) ?? 0;
  }
}

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
