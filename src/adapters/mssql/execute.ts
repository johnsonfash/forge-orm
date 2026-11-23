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
import { decodeWideIntegerRows, decodeWideIntegers } from '../shared/wide-int';
import { decodeJsonColumns } from '../shared/json-columns';

const MSSQL_JSON = { arrays: true };
import type { MssqlQueryable } from './driver';
import type { Dialect } from '../postgres/dialect';
import { hydrateManyRelation, hydrateOneRelation, liftRelationCounts, type WindowedPaging } from '../../ir/hydrate-many';
import { refineFallbackGeo } from '../shared/haversine';

// Window functions are always available here, so a nested page is one query.
const WINDOWED: WindowedPaging = { enabled: true };

export interface MssqlExecOpts {
  client?: MssqlQueryable;
  /** The adapter's dialect when a full-text index was found. */
  dialect?: Dialect;
}

export async function executeMssqlSelect(
  driver: MssqlQueryable,
  node: SelectNode,
  model: ModelDef<any>,
  opts: MssqlExecOpts = {},
): Promise<any[]> {
  const exec = opts.client ?? driver;
  const artifact = compileSelect(node, model, opts.dialect);
  const { rows } = await withMssqlErrors(() => exec.query(artifact.sql, artifact.params));

  let out = decodeWideIntegerRows(model, decodeJsonColumns(model, rows, MSSQL_JSON));
  if (node.distinct?.length) out = dedupeBy(out, node.distinct);

  // Fallback geoPoint refinement — exact-circle + sort post-process.
  out = refineFallbackGeo(out, node, model);

  if (node.projection?.counts?.length) {
    liftRelationCounts(out, node.projection.counts);
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
  const artifact = compileCount(node, model, opts.dialect);
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
  return { docs: decodeWideIntegerRows(model, decodeJsonColumns(model, rows, MSSQL_JSON)), count: rowCount ?? rows.length };
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
  return { doc: decodeWideIntegers(model, decodeJsonColumns(model, rows, MSSQL_JSON)[0]), count: rows.length };
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
  return { doc: decodeWideIntegers(model, decodeJsonColumns(model, rows, MSSQL_JSON)[0]), count: rows.length };
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
  await hydrateOneRelation({
    rows, rel, parentField: rel.on, targetField: rel.refs, keyOf: stringKey,
    runSelect: (node) => executeMssqlSelect(exec, node, targetModel),
  });
}

async function hydrateInverseOne(exec: MssqlQueryable, rows: any[], rel: RelationPlan, targetModel: ModelDef<any>): Promise<void> {
  await hydrateOneRelation({
    rows, rel, parentField: rel.refs, targetField: rel.on, keyOf: stringKey,
    runSelect: (node) => executeMssqlSelect(exec, node, targetModel),
  });
}

async function hydrateMany(exec: MssqlQueryable, rows: any[], rel: RelationPlan, targetModel: ModelDef<any>): Promise<void> {
  await hydrateManyRelation({
    rows, rel, keyOf: stringKey,
    runSelect: (node) => executeMssqlSelect(exec, node, targetModel),
    windowed: WINDOWED,
  });
}

function stringKey(v: any): string { if (v == null) return '\x00'; return String(v); }
function dedupeBy(rows: any[], fields: string[]): any[] {
  const seen = new Set<string>(); const out: any[] = [];
  for (const r of rows) { const k = fields.map((f) => JSON.stringify(r[f] ?? null)).join('\x1e'); if (seen.has(k)) continue; seen.add(k); out.push(r); }
  return out;
}
