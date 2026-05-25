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
import { withPgErrors } from './errors';

// Postgres IR executor — wires SQLArtifacts to a pg pool. Same shape as the
// Mongo executor; both implement the Adapter's executor methods.
//
// Design notes:
//   • Defaults are handled by the DB engine (DEFAULT clauses) — the wrapper
//     passes only user-provided fields. For now (Wave 2b), the wrapper still
//     pre-coerces via Mongo's coerce.ts because the existing tests assume it;
//     Wave 2c's PG DDL generator will replace defaulting with native DEFAULTs.
//   • Hydration is batched-IN: for each include relation, one SELECT with
//     `WHERE fk = ANY($1)`. JOIN-style hydration for one-side relations is a
//     Wave 2c optimisation flag (`relationLoadStrategy: 'join'`).

export interface PgPoolHandle {
  query(sql: string, params?: unknown[]): Promise<{ rows: any[]; rowCount: number | null }>;
}

export interface PgExecOpts {
  // A pg.PoolClient (when inside a $transaction) — overrides the pool for the
  // duration of the call so all queries land on the same connection / txn.
  client?: PgPoolHandle;
}

// ─── Reads ──────────────────────────────────────────────────────────────────

export async function executePgSelect(
  pool: PgPoolHandle,
  node: SelectNode,
  model: ModelDef<any>,
  opts: PgExecOpts = {},
): Promise<any[]> {
  const exec = opts.client ?? pool;
  const artifact = compileSelect(node, model);
  const { rows } = await withPgErrors(() => exec.query(artifact.sql, artifact.params));

  let out = rows;
  if (node.distinct?.length) out = dedupeBy(out, node.distinct);

  if (node.projection?.counts?.length) {
    await applyRelationCounts(exec, out, model, node.projection.counts);
  }
  if (node.hydration?.length) {
    await hydrate(exec, out, model, node.hydration);
  }
  return out;
}

// Reshape flat `__agg_<bucket>_<field>` aliases back into the Prisma-shape
// nested payload `{ <by-cols>, _count: { ... }, _avg: { ... }, ... }`.
// Numeric aggregates come back as strings on PG (NUMERIC type); coerce.
function reshapeGroupByRow(row: any, byCols: string[]): any {
  const out: any = {};
  for (const c of byCols) out[c] = row[c];
  for (const k of Object.keys(row)) {
    const m = k.match(/^__agg_(count|avg|sum|min|max)_(.+)$/);
    if (!m) continue;
    const bucketKey = `_${m[1]}`;
    const field = m[2];
    out[bucketKey] ??= {};
    let val = row[k];
    if (val != null && typeof val === 'string' && /^-?\d+(\.\d+)?$/.test(val)) {
      val = Number(val);
    }
    out[bucketKey][field] = val;
  }
  return out;
}

export async function executePgGroupBy(
  pool: PgPoolHandle,
  node: GroupByNode,
  model: ModelDef<any>,
  opts: PgExecOpts = {},
): Promise<any[]> {
  const exec = opts.client ?? pool;
  const artifact = compileGroupBy(node, model);
  const { rows } = await withPgErrors(() => exec.query(artifact.sql, artifact.params));
  return rows.map((r) => reshapeGroupByRow(r, node.by));
}

export async function executePgCount(
  pool: PgPoolHandle,
  node: CountNode,
  model: ModelDef<any>,
  opts: PgExecOpts = {},
): Promise<number> {
  const exec = opts.client ?? pool;
  const artifact = compileCount(node, model);
  const { rows } = await withPgErrors(() => exec.query(artifact.sql, artifact.params));
  // PG returns COUNT(*) as a string (bigint) — coerce to number. Safe up to
  // 2^53; for billion-row counts add a guard upstream.
  return Number(rows[0]?.count ?? 0);
}

// ─── Writes ─────────────────────────────────────────────────────────────────

export async function executePgInsert(
  pool: PgPoolHandle,
  node: InsertNode,
  model: ModelDef<any>,
  opts: PgExecOpts = {},
): Promise<{ docs: any[]; count: number }> {
  const exec = opts.client ?? pool;
  const artifact = compileInsert(node, model);
  const { rows, rowCount } = await withPgErrors(() => exec.query(artifact.sql, artifact.params));
  return { docs: rows, count: rowCount ?? rows.length };
}

export async function executePgUpdate(
  pool: PgPoolHandle,
  node: UpdateNode,
  model: ModelDef<any>,
  opts: PgExecOpts = {},
): Promise<{ doc?: any; count: number }> {
  const exec = opts.client ?? pool;
  const artifact = compileUpdate(node, model);
  const { rows, rowCount } = await withPgErrors(() => exec.query(artifact.sql, artifact.params));
  if (node.many) return { count: rowCount ?? rows.length };
  return { doc: rows[0], count: rows.length };
}

export async function executePgDelete(
  pool: PgPoolHandle,
  node: DeleteNode,
  model: ModelDef<any>,
  opts: PgExecOpts = {},
): Promise<{ doc?: any; count: number }> {
  const exec = opts.client ?? pool;
  // DELETE … RETURNING * gives us the row that was removed; cascade behaviour
  // is delegated to the DB engine via ON DELETE clauses (set in DDL — Wave 2c).
  const artifact = compileDelete(node, model);
  const { rows, rowCount } = await withPgErrors(() => exec.query(artifact.sql, artifact.params));
  if (node.many) return { count: rowCount ?? rows.length };
  return { doc: rows[0], count: rows.length };
}

// ─── Hydration ──────────────────────────────────────────────────────────────

async function hydrate(
  exec: PgPoolHandle,
  rows: any[],
  parentModel: ModelDef<any>,
  hydration: RelationPlan[],
): Promise<void> {
  if (rows.length === 0) return;
  for (const rel of hydration) {
    const targetModel = (schema as any)[rel.target] as ModelDef<any> | undefined;
    if (!targetModel) continue;
    const isOwningOne = rel.kind === 'one' && parentModel.fields[rel.on] != null;
    if (isOwningOne) await hydrateOwningOne(exec, rows, rel, targetModel);
    else if (rel.kind === 'one') await hydrateInverseOne(exec, rows, rel, targetModel);
    else await hydrateMany(exec, rows, rel, targetModel);
  }
}

async function hydrateOwningOne(
  exec: PgPoolHandle,
  rows: any[],
  rel: RelationPlan,
  targetModel: ModelDef<any>,
): Promise<void> {
  const fks = unique(rows.map((r) => r[rel.on]).filter(notNull));
  if (fks.length === 0) { for (const r of rows) r[rel.name] = null; return; }
  const subNode: SelectNode = {
    kind: 'select', model: rel.target, cardinality: 'many',
    where: { kind: 'leaf', field: rel.refs, op: 'in', value: fks },
    ...(rel.nested ?? {}),
  };
  const found = await executePgSelect(exec, subNode, targetModel);
  const byRef = new Map<string, any>();
  for (const t of found) byRef.set(stringKey(t[rel.refs]), t);
  for (const r of rows) {
    const k = r[rel.on];
    r[rel.name] = k == null ? null : (byRef.get(stringKey(k)) ?? null);
  }
}

async function hydrateInverseOne(
  exec: PgPoolHandle,
  rows: any[],
  rel: RelationPlan,
  targetModel: ModelDef<any>,
): Promise<void> {
  const refs = unique(rows.map((r) => r[rel.refs]).filter(notNull));
  if (refs.length === 0) { for (const r of rows) r[rel.name] = null; return; }
  const subNode: SelectNode = {
    kind: 'select', model: rel.target, cardinality: 'many',
    where: { kind: 'leaf', field: rel.on, op: 'in', value: refs },
    ...(rel.nested ?? {}),
  };
  const found = await executePgSelect(exec, subNode, targetModel);
  const byFk = new Map<string, any>();
  for (const t of found) byFk.set(stringKey(t[rel.on]), t);
  for (const r of rows) {
    const k = r[rel.refs];
    r[rel.name] = k == null ? null : (byFk.get(stringKey(k)) ?? null);
  }
}

async function hydrateMany(
  exec: PgPoolHandle,
  rows: any[],
  rel: RelationPlan,
  targetModel: ModelDef<any>,
): Promise<void> {
  const refs = unique(rows.map((r) => r[rel.refs]).filter(notNull));
  if (refs.length === 0) { for (const r of rows) r[rel.name] = []; return; }
  // Combine any caller-supplied nested.where with the FK IN-filter via AND.
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
  const found = await executePgSelect(exec, subNode, targetModel);
  const byParent = new Map<string, any[]>();
  for (const t of found) {
    const k = stringKey(t[rel.on]);
    const list = byParent.get(k);
    if (list) list.push(t);
    else byParent.set(k, [t]);
  }
  for (const r of rows) r[rel.name] = byParent.get(stringKey(r[rel.refs])) ?? [];
}

async function applyRelationCounts(
  exec: PgPoolHandle,
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
    const refs = unique(rows.map((r) => r[rel.refs]).filter(notNull));
    if (refs.length === 0) { for (const row of rows) row._count[relName] = 0; continue; }
    const sql =
      `SELECT "${rel.on}" AS fk, COUNT(*)::bigint AS c ` +
      `FROM "${targetModel.collection}" ` +
      `WHERE "${rel.on}" = ANY($1) GROUP BY "${rel.on}"`;
    const { rows: groups } = await exec.query(sql, [refs]);
    const byFk = new Map<string, number>();
    for (const g of groups) byFk.set(stringKey(g.fk), Number(g.c));
    for (const row of rows) row._count[relName] = byFk.get(stringKey(row[rel.refs])) ?? 0;
  }
}

// ─── Utils ──────────────────────────────────────────────────────────────────

function notNull<T>(v: T | null | undefined): v is T { return v != null; }

function unique<T>(arr: T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const v of arr) { const k = stringKey(v); if (seen.has(k)) continue; seen.add(k); out.push(v); }
  return out;
}

function stringKey(v: any): string {
  if (v == null) return '\x00';
  return String(v);
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
