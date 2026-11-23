// DuckDB IR executor — same shape as the Postgres executor (DuckDB SQL is
// PG-compatible for the queries forge emits), wired to a DuckdbQueryable
// from `./driver.ts`.

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
import { withDuckdbErrors } from './errors';
import { decodeWideIntegerRows, decodeWideIntegers } from '../shared/wide-int';
import { decodeJsonColumns } from '../shared/json-columns';
import type { DuckdbQueryable } from './driver';
import type { Dialect } from '../postgres/dialect';
import { hydrateManyRelation, hydrateOneRelation, liftRelationCounts, type WindowedPaging } from '../../ir/hydrate-many';

// Window functions are always available here, so a nested page is one query.
const WINDOWED: WindowedPaging = { enabled: true };

export interface DuckdbExecOpts {
  /** Transaction-bound queryable (passed by `withTransaction`). */
  client?: DuckdbQueryable;
  /** The adapter's dialect when it differs from the static one (a full-text index found). */
  dialect?: Dialect;
}

export async function executeDuckdbSelect(
  driver: DuckdbQueryable,
  node: SelectNode,
  model: ModelDef<any>,
  opts: DuckdbExecOpts = {},
): Promise<any[]> {
  const exec = opts.client ?? driver;
  const artifact = compileSelect(node, model, opts.dialect);
  const { rows } = await withDuckdbErrors(() => exec.query(artifact.sql, artifact.params));

  let out = decodeWideIntegerRows(model, decodeJsonColumns(model, rows));
  if (node.distinct?.length) out = dedupeBy(out, node.distinct);

  // Fallback geoPoint refinement — exact-circle + sort post-process.
  const { refineFallbackGeo } = await import('../shared/haversine');
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

export async function executeDuckdbGroupBy(
  driver: DuckdbQueryable,
  node: GroupByNode,
  model: ModelDef<any>,
  opts: DuckdbExecOpts = {},
): Promise<any[]> {
  const exec = opts.client ?? driver;
  const artifact = compileGroupBy(node, model);
  const { rows } = await withDuckdbErrors(() => exec.query(artifact.sql, artifact.params));
  return rows.map((r: any) => reshapeGroupByRow(r, node.by));
}

export async function executeDuckdbCount(
  driver: DuckdbQueryable,
  node: CountNode,
  model: ModelDef<any>,
  opts: DuckdbExecOpts = {},
): Promise<number> {
  const exec = opts.client ?? driver;
  const artifact = compileCount(node, model, opts.dialect);
  const { rows } = await withDuckdbErrors(() => exec.query(artifact.sql, artifact.params));
  return Number(rows[0]?.count ?? 0);
}

export async function executeDuckdbInsert(
  driver: DuckdbQueryable,
  node: InsertNode,
  model: ModelDef<any>,
  opts: DuckdbExecOpts = {},
): Promise<{ docs: any[]; count: number }> {
  const exec = opts.client ?? driver;
  const artifact = compileInsert(node, model, opts.dialect);
  const { rows, rowCount } = await withDuckdbErrors(() => exec.query(artifact.sql, artifact.params));
  return { docs: decodeWideIntegerRows(model, decodeJsonColumns(model, rows)), count: rowCount ?? rows.length };
}

export async function executeDuckdbUpdate(
  driver: DuckdbQueryable,
  node: UpdateNode,
  model: ModelDef<any>,
  opts: DuckdbExecOpts = {},
): Promise<{ doc?: any; count: number }> {
  const exec = opts.client ?? driver;
  const artifact = compileUpdate(node, model, opts.dialect);
  const { rows, rowCount } = await withDuckdbErrors(() => exec.query(artifact.sql, artifact.params));
  if (node.many) return { count: rowCount ?? rows.length };
  return { doc: decodeWideIntegers(model, decodeJsonColumns(model, rows)[0]), count: rows.length };
}

export async function executeDuckdbDelete(
  driver: DuckdbQueryable,
  node: DeleteNode,
  model: ModelDef<any>,
  opts: DuckdbExecOpts = {},
): Promise<{ doc?: any; count: number }> {
  const exec = opts.client ?? driver;
  const artifact = compileDelete(node, model, opts.dialect);
  const { rows, rowCount } = await withDuckdbErrors(() => exec.query(artifact.sql, artifact.params));
  if (node.many) return { count: rowCount ?? rows.length };
  return { doc: decodeWideIntegers(model, decodeJsonColumns(model, rows)[0]), count: rows.length };
}

async function hydrate(
  exec: DuckdbQueryable,
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
  exec: DuckdbQueryable,
  rows: any[],
  rel: RelationPlan,
  targetModel: ModelDef<any>,
): Promise<void> {
  await hydrateOneRelation({
    rows, rel, parentField: rel.on, targetField: rel.refs, keyOf: stringKey,
    runSelect: (node) => executeDuckdbSelect(exec, node, targetModel),
  });
}

async function hydrateInverseOne(
  exec: DuckdbQueryable,
  rows: any[],
  rel: RelationPlan,
  targetModel: ModelDef<any>,
): Promise<void> {
  await hydrateOneRelation({
    rows, rel, parentField: rel.refs, targetField: rel.on, keyOf: stringKey,
    runSelect: (node) => executeDuckdbSelect(exec, node, targetModel),
  });
}

async function hydrateMany(
  exec: DuckdbQueryable,
  rows: any[],
  rel: RelationPlan,
  targetModel: ModelDef<any>,
): Promise<void> {
  await hydrateManyRelation({
    rows, rel, keyOf: stringKey,
    runSelect: (node) => executeDuckdbSelect(exec, node, targetModel),
    windowed: WINDOWED,
  });
}

function stringKey(v: any): string { if (v == null) return '\x00'; return String(v); }
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
