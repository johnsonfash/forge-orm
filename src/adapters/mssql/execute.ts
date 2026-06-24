// SQL Server IR executor — same shape as the Postgres executor with
// MssqlDriver as the underlying transport.

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
import { withMssqlErrors } from './errors';
import type { MssqlQueryable } from './driver';

export interface MssqlExecOpts {
  client?: MssqlQueryable;
}

export async function executeMssqlSelect(
  driver: MssqlQueryable,
  node: SelectNode,
  model: ModelDef<any>,
  opts: MssqlExecOpts = {},
): Promise<any[]> {
  const exec = opts.client ?? driver;
  const artifact = compileSelect(node, model);
  const { rows } = await withMssqlErrors(() => exec.query(artifact.sql, artifact.params));

  let out = rows;
  if (node.distinct?.length) out = dedupeBy(out, node.distinct);

  // Fallback geoPoint refinement — exact-circle + sort post-process.
  const { extractFallbackGeoOps, applyHaversinePostFilter } = await import('../shared/haversine');
  const geoOps = extractFallbackGeoOps(node, model);
  if (geoOps.near || geoOps.nearTo || geoOps.withinPolygon) {
    out = applyHaversinePostFilter(out, geoOps.near, geoOps.nearTo, geoOps.withinPolygon);
  }

  if (node.projection?.counts?.length) {
    await applyRelationCounts(exec, out, model, node.projection.counts);
  }
  if (node.hydration?.length) {
    await hydrate(exec, out, model, node.hydration);
  }
  return out;
}

function reshapeGroupByRow(row: any, byCols: string[]): any {
  const out: any = {};
  for (const c of byCols) out[c] = row[c];
  for (const k of Object.keys(row)) {
    const m = k.match(/^__agg_(count|avg|sum|min|max)_(.+)$/);
    if (!m) continue;
    const bucketKey = `_${m[1]}`;
    out[bucketKey] ??= {};
    out[bucketKey][m[2]] = row[k];
  }
  return out;
}

export async function executeMssqlGroupBy(
  driver: MssqlQueryable,
  node: GroupByNode,
  model: ModelDef<any>,
  opts: MssqlExecOpts = {},
): Promise<any[]> {
  const exec = opts.client ?? driver;
  const artifact = compileGroupBy(node, model);
  const { rows } = await withMssqlErrors(() => exec.query(artifact.sql, artifact.params));
  return rows.map((r: any) => reshapeGroupByRow(r, node.by));
}

export async function executeMssqlCount(
  driver: MssqlQueryable,
  node: CountNode,
  model: ModelDef<any>,
  opts: MssqlExecOpts = {},
): Promise<number> {
  const exec = opts.client ?? driver;
  const artifact = compileCount(node, model);
  const { rows } = await withMssqlErrors(() => exec.query(artifact.sql, artifact.params));
  return Number(rows[0]?.count ?? 0);
}

export async function executeMssqlInsert(
  driver: MssqlQueryable,
  node: InsertNode,
  model: ModelDef<any>,
  opts: MssqlExecOpts = {},
): Promise<{ docs: any[]; count: number }> {
  const exec = opts.client ?? driver;
  const artifact = compileInsert(node, model);
  const { rows, rowCount } = await withMssqlErrors(() => exec.query(artifact.sql, artifact.params));
  return { docs: rows, count: rowCount ?? rows.length };
}

export async function executeMssqlUpdate(
  driver: MssqlQueryable,
  node: UpdateNode,
  model: ModelDef<any>,
  opts: MssqlExecOpts = {},
): Promise<{ doc?: any; count: number }> {
  const exec = opts.client ?? driver;
  const artifact = compileUpdate(node, model);
  const { rows, rowCount } = await withMssqlErrors(() => exec.query(artifact.sql, artifact.params));
  if (node.many) return { count: rowCount ?? rows.length };
  return { doc: rows[0], count: rows.length };
}

export async function executeMssqlDelete(
  driver: MssqlQueryable,
  node: DeleteNode,
  model: ModelDef<any>,
  opts: MssqlExecOpts = {},
): Promise<{ doc?: any; count: number }> {
  const exec = opts.client ?? driver;
  const artifact = compileDelete(node, model);
  const { rows, rowCount } = await withMssqlErrors(() => exec.query(artifact.sql, artifact.params));
  if (node.many) return { count: rowCount ?? rows.length };
  return { doc: rows[0], count: rows.length };
}

// Hydration (same shape as PG/DuckDB).

async function hydrate(
  exec: MssqlQueryable, rows: any[], parentModel: ModelDef<any>, hydration: RelationPlan[],
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

async function hydrateOwningOne(exec: MssqlQueryable, rows: any[], rel: RelationPlan, targetModel: ModelDef<any>): Promise<void> {
  const fks = unique(rows.map((r) => r[rel.on]).filter(notNull));
  if (fks.length === 0) { for (const r of rows) r[rel.name] = null; return; }
  const subNode: SelectNode = { kind: 'select', model: rel.target, cardinality: 'many', where: { kind: 'leaf', field: rel.refs, op: 'in', value: fks }, ...(rel.nested ?? {}) };
  const found = await executeMssqlSelect(exec, subNode, targetModel);
  const byRef = new Map<string, any>();
  for (const t of found) byRef.set(stringKey(t[rel.refs]), t);
  for (const r of rows) { const k = r[rel.on]; r[rel.name] = k == null ? null : (byRef.get(stringKey(k)) ?? null); }
}

async function hydrateInverseOne(exec: MssqlQueryable, rows: any[], rel: RelationPlan, targetModel: ModelDef<any>): Promise<void> {
  const refs = unique(rows.map((r) => r[rel.refs]).filter(notNull));
  if (refs.length === 0) { for (const r of rows) r[rel.name] = null; return; }
  const subNode: SelectNode = { kind: 'select', model: rel.target, cardinality: 'many', where: { kind: 'leaf', field: rel.on, op: 'in', value: refs }, ...(rel.nested ?? {}) };
  const found = await executeMssqlSelect(exec, subNode, targetModel);
  const byFk = new Map<string, any>();
  for (const t of found) byFk.set(stringKey(t[rel.on]), t);
  for (const r of rows) { const k = r[rel.refs]; r[rel.name] = k == null ? null : (byFk.get(stringKey(k)) ?? null); }
}

async function hydrateMany(exec: MssqlQueryable, rows: any[], rel: RelationPlan, targetModel: ModelDef<any>): Promise<void> {
  const refs = unique(rows.map((r) => r[rel.refs]).filter(notNull));
  if (refs.length === 0) { for (const r of rows) r[rel.name] = []; return; }
  const nestedWhere = (rel.nested as any)?.where;
  const fkLeaf = { kind: 'leaf' as const, field: rel.on, op: 'in' as const, value: refs };
  const where = nestedWhere ? { kind: 'and' as const, children: [nestedWhere, fkLeaf] } : fkLeaf;
  const subNode: SelectNode = { kind: 'select', model: rel.target, cardinality: 'many', ...(rel.nested ?? {}), where };
  const found = await executeMssqlSelect(exec, subNode, targetModel);
  const byParent = new Map<string, any[]>();
  for (const t of found) {
    const k = stringKey(t[rel.on]);
    const list = byParent.get(k); if (list) list.push(t); else byParent.set(k, [t]);
  }
  for (const r of rows) r[rel.name] = byParent.get(stringKey(r[rel.refs])) ?? [];
}

async function applyRelationCounts(exec: MssqlQueryable, rows: any[], parentModel: ModelDef<any>, counts: string[]): Promise<void> {
  if (rows.length === 0) return;
  const relMap = parentModel.relations();
  for (const r of rows) r._count = r._count ?? {};
  for (const relName of counts) {
    const rel = relMap[relName]; if (!rel) continue;
    const targetModel = (schema as any)[rel.target] as ModelDef<any> | undefined;
    if (!targetModel) continue;
    const refs = unique(rows.map((r) => r[rel.refs]).filter(notNull));
    if (refs.length === 0) { for (const row of rows) row._count[relName] = 0; continue; }
    // T-SQL doesn't have ANY(@p). Build an IN list with positional placeholders.
    const placeholders = refs.map((_, i) => `@p${i + 1}`).join(', ');
    const sqlText = `SELECT [${rel.on}] AS fk, COUNT(*) AS c FROM [${targetModel.collection}] WHERE [${rel.on}] IN (${placeholders}) GROUP BY [${rel.on}]`;
    const { rows: groups } = await exec.query(sqlText, refs);
    const byFk = new Map<string, number>();
    for (const g of groups) byFk.set(stringKey(g.fk), Number(g.c));
    for (const row of rows) row._count[relName] = byFk.get(stringKey(row[rel.refs])) ?? 0;
  }
}

function notNull<T>(v: T | null | undefined): v is T { return v != null; }
function unique<T>(arr: T[]): T[] { const seen = new Set<string>(); const out: T[] = []; for (const v of arr) { const k = stringKey(v); if (seen.has(k)) continue; seen.add(k); out.push(v); } return out; }
function stringKey(v: any): string { if (v == null) return '\x00'; return String(v); }
function dedupeBy(rows: any[], fields: string[]): any[] {
  const seen = new Set<string>(); const out: any[] = [];
  for (const r of rows) { const k = fields.map((f) => JSON.stringify(r[f] ?? null)).join('\x1e'); if (seen.has(k)) continue; seen.add(k); out.push(r); }
  return out;
}
