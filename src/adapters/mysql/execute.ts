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
import { withMysqlErrors } from './errors';
import { buildSelect, buildWhereTree } from '../../ir/build';

// MySQL IR executor — wraps mysql2's promise pool.
//
// MySQL doesn't support RETURNING, so insert/update/delete are two-statement:
//   1. perform the mutation (capture affected ids if possible)
//   2. SELECT the affected rows by `where` to satisfy forge's "return the
//      row(s) that were written" contract that callers expect.
//
// For UPDATE/DELETE single, we re-run the SELECT inside the same connection
// to read your own write. For INSERT, we use the ids we generated (or that
// mysql2 surfaces as `insertId` for auto-increment cases) to do the SELECT.

export interface MysqlConn {
  query(sql: string, params?: unknown[]): Promise<[any, any]>;
  execute(sql: string, params?: unknown[]): Promise<[any, any]>;
  release?(): void;
}

export interface MysqlPool extends MysqlConn {
  getConnection(): Promise<MysqlConn>;
  end?(): Promise<void>;
}

export interface MysqlExecOpts {
  conn?: MysqlConn;
}

// ─── Decode rows ────────────────────────────────────────────────────────
//
// mysql2 returns booleans as numeric (0/1), dates as Date objects, JSON as
// already-parsed (when the column is JSON type). We re-hydrate based on the
// schema so callers see proper JS types.

function decodeRow(model: ModelDef<any>, row: any): any {
  if (!row || typeof row !== 'object') return row;
  const out: any = {};
  for (const k of Object.keys(row)) {
    const field = model.fields[k];
    const v = row[k];
    if (!field || v == null) { out[k] = v; continue; }
    switch (field.kind) {
      case 'bool':       out[k] = v === 1 || v === true; break;
      case 'json':
      case 'embed':
      case 'embedMany':
      case 'stringArray':
      case 'intArray':
        // mysql2 auto-parses JSON columns; but if a TEXT-backed column ended
        // up here with a string, JSON.parse it.
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

// ─── Reads ──────────────────────────────────────────────────────────────────

export async function executeMysqlSelect(
  pool: MysqlPool,
  node: SelectNode,
  model: ModelDef<any>,
  opts: MysqlExecOpts = {},
): Promise<any[]> {
  const exec = opts.conn ?? pool;
  const a = compileSelect(node, model);
  const [rows] = await withMysqlErrors(() => exec.query(a.sql, a.params));
  let out = (rows as any[]).map((r) => decodeRow(model, r));
  if (node.distinct?.length) out = dedupeBy(out, node.distinct);
  if (node.projection?.counts?.length) await applyRelationCounts(exec, out, model, node.projection.counts);
  if (node.hydration?.length) await hydrate(pool, opts, out, model, node.hydration);
  return out;
}

export async function executeMysqlCount(
  pool: MysqlPool,
  node: CountNode,
  model: ModelDef<any>,
  opts: MysqlExecOpts = {},
): Promise<number> {
  const exec = opts.conn ?? pool;
  const a = compileCount(node, model);
  const [rows] = await withMysqlErrors(() => exec.query(a.sql, a.params));
  return Number((rows as any[])[0]?.count ?? 0);
}

export async function executeMysqlGroupBy(
  pool: MysqlPool,
  node: GroupByNode,
  model: ModelDef<any>,
  opts: MysqlExecOpts = {},
): Promise<any[]> {
  const exec = opts.conn ?? pool;
  const a = compileGroupBy(node, model);
  const [rows] = await withMysqlErrors(() => exec.query(a.sql, a.params));
  return (rows as any[]).map((r) => reshapeGroupByRow(r, node.by));
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

// ─── Writes ─────────────────────────────────────────────────────────────────

export async function executeMysqlInsert(
  pool: MysqlPool,
  node: InsertNode,
  model: ModelDef<any>,
  opts: MysqlExecOpts = {},
): Promise<{ docs: any[]; count: number }> {
  const exec = opts.conn ?? pool;
  const a = compileInsert(node, model);
  const [result]: any = await withMysqlErrors(() => exec.execute(a.sql, a.params));
  // INSERT returned. Now re-SELECT to get the rows back — by id if user
  // provided ids, or by insertId range for auto-increment.
  const ids = node.rows.map((r) => r.id).filter((id) => id != null);
  if (ids.length === 0) {
    // No ids supplied — assume INSERT auto-incremented. Use insertId / affectedRows.
    if (result.insertId != null && result.affectedRows > 0) {
      const placeholders = Array.from({ length: result.affectedRows }, () => '?').join(',');
      const ranged = Array.from({ length: result.affectedRows }, (_, i) => result.insertId + i);
      const [docs] = await withMysqlErrors(() => exec.query(
        `SELECT * FROM \`${model.collection}\` WHERE \`id\` IN (${placeholders})`,
        ranged,
      ));
      return { docs: (docs as any[]).map((r) => decodeRow(model, r)), count: result.affectedRows };
    }
    return { docs: [], count: result.affectedRows };
  }
  const placeholders = ids.map(() => '?').join(',');
  const [docs] = await withMysqlErrors(() => exec.query(
    `SELECT * FROM \`${model.collection}\` WHERE \`id\` IN (${placeholders})`, ids,
  ));
  return { docs: (docs as any[]).map((r) => decodeRow(model, r)), count: result.affectedRows };
}

export async function executeMysqlUpdate(
  pool: MysqlPool,
  node: UpdateNode,
  model: ModelDef<any>,
  opts: MysqlExecOpts = {},
): Promise<{ doc?: any; count: number }> {
  const exec = opts.conn ?? pool;
  const a = compileUpdate(node, model);
  const [result]: any = await withMysqlErrors(() => exec.execute(a.sql, a.params));
  if (node.many) return { count: result.affectedRows };
  // Single-row update — follow up with SELECT (using node.where) to fetch
  // the updated row.
  const selectArtifact = compileSelect(
    buildSelect(node.model, model, { where: irWhereToObject(node.where), take: 1 }, 'one'),
    model,
  );
  const [rows] = await withMysqlErrors(() => exec.query(selectArtifact.sql, selectArtifact.params));
  const doc = (rows as any[])[0];
  return { doc: doc ? decodeRow(model, doc) : undefined, count: result.affectedRows };
}

export async function executeMysqlDelete(
  pool: MysqlPool,
  node: DeleteNode,
  model: ModelDef<any>,
  opts: MysqlExecOpts = {},
): Promise<{ doc?: any; count: number }> {
  const exec = opts.conn ?? pool;
  if (node.many) {
    const a = compileDelete(node, model);
    const [result]: any = await withMysqlErrors(() => exec.execute(a.sql, a.params));
    return { count: result.affectedRows };
  }
  // Single-row delete: SELECT first to capture the row, then DELETE.
  const selectArtifact = compileSelect(
    buildSelect(node.model, model, { where: irWhereToObject(node.where), take: 1 }, 'one'),
    model,
  );
  const [rows] = await withMysqlErrors(() => exec.query(selectArtifact.sql, selectArtifact.params));
  const doc = (rows as any[])[0];
  if (!doc) return { doc: undefined, count: 0 };
  const a = compileDelete(node, model);
  const [result]: any = await withMysqlErrors(() => exec.execute(a.sql, a.params));
  return { doc: decodeRow(model, doc), count: result.affectedRows };
}

// Convert an IR WhereTree back to a Prisma-shape object so we can re-build
// a SelectNode for the follow-up SELECT. We only need to handle the common
// case (top-level eq leaves AND'd together) — that covers update/delete by
// id / unique field.
function irWhereToObject(tree: any): any {
  if (!tree) return undefined;
  if (tree.kind === 'leaf' && tree.op === 'eq') return { [tree.field]: tree.value };
  if (tree.kind === 'and') {
    const out: any = {};
    for (const c of tree.children) Object.assign(out, irWhereToObject(c) ?? {});
    return out;
  }
  // Fallback: just trust it (covers most realistic update/delete where clauses).
  return tree;
}

// ─── Hydration / counts ─────────────────────────────────────────────────────

async function hydrate(
  pool: MysqlPool,
  opts: MysqlExecOpts,
  rows: any[],
  parentModel: ModelDef<any>,
  hydration: RelationPlan[],
): Promise<void> {
  if (rows.length === 0) return;
  for (const rel of hydration) {
    const targetModel = (schema as any)[rel.target] as ModelDef<any> | undefined;
    if (!targetModel) continue;
    const isOwningOne = rel.kind === 'one' && parentModel.fields[rel.on] != null;
    if (isOwningOne) await hydrateOne(pool, opts, rows, rel, targetModel, true);
    else if (rel.kind === 'one') await hydrateOne(pool, opts, rows, rel, targetModel, false);
    else await hydrateMany(pool, opts, rows, rel, targetModel);
  }
}

async function hydrateOne(
  pool: MysqlPool, opts: MysqlExecOpts,
  rows: any[], rel: RelationPlan, targetModel: ModelDef<any>, owning: boolean,
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
  const found = await executeMysqlSelect(pool, subNode, targetModel, opts);
  const byKey = new Map<string, any>();
  for (const t of found) byKey.set(String(t[toField]), t);
  for (const r of rows) {
    const k = r[fromField];
    r[rel.name] = k == null ? null : (byKey.get(String(k)) ?? null);
  }
}

async function hydrateMany(
  pool: MysqlPool, opts: MysqlExecOpts,
  rows: any[], rel: RelationPlan, targetModel: ModelDef<any>,
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
  const found = await executeMysqlSelect(pool, subNode, targetModel, opts);
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
  exec: MysqlConn, rows: any[], parentModel: ModelDef<any>, counts: string[],
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
    const placeholders = refs.map(() => '?').join(',');
    const sql = `SELECT \`${rel.on}\` AS fk, COUNT(*) AS c FROM \`${targetModel.collection}\` WHERE \`${rel.on}\` IN (${placeholders}) GROUP BY \`${rel.on}\``;
    const [groups]: any = await withMysqlErrors(() => exec.query(sql, refs));
    const byFk = new Map<string, number>();
    for (const g of groups as any[]) byFk.set(String(g.fk), Number(g.c));
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
