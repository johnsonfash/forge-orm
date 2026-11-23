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
import { refineFallbackGeo } from '../shared/haversine';

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

/**
 * The rows a cascading delete targets, plus per child relation whether any
 * child row points at one of them: an EXISTS column per probe around the
 * select, so the walker can skip empty relations in the same round trip.
 */
export async function executeDuckdbSelectWithChildPresence(
  driver: DuckdbQueryable,
  node: SelectNode,
  model: ModelDef<any>,
  probes: Array<{ collection: string; on: string; refs: string }>,
  opts: DuckdbExecOpts = {},
): Promise<{ rows: any[]; present: boolean[] }> {
  const exec = opts.client ?? driver;
  const artifact = compileSelect(node, model, opts.dialect);
  const q = (s: string) => `"${s.replace(/"/g, '""')}"`;
  const flags = probes.map((p, i) =>
    `EXISTS (SELECT 1 FROM ${q(p.collection)} ${q(`p${i}`)} WHERE ${q(`p${i}`)}.${q(p.on)} = ${q('__t')}.${q(p.refs)}) AS ${q(`__forge_has_${i}`)}`);
  const sql = `SELECT ${q('__t')}.*${flags.length ? ', ' + flags.join(', ') : ''} FROM (${artifact.sql}) ${q('__t')}`;
  const { rows } = await withDuckdbErrors(() => exec.query(sql, artifact.params));
  const present = probes.map(() => false);
  for (const r of rows) {
    probes.forEach((_, i) => { const k = `__forge_has_${i}`; if (r[k]) present[i] = true; delete r[k]; });
  }
  return { rows: decodeWideIntegerRows(model, decodeJsonColumns(model, rows)), present };
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
  const counted = node.countOnly && exec.reportsChangedRows === true;
  const artifact = compileInsert(counted ? { ...node, driverReportsCount: true } : node, model, opts.dialect);
  const { rows, rowCount } = await withDuckdbErrors(() => exec.query(artifact.sql, artifact.params));
  if (counted) return { docs: [], count: rowCount ?? 0 };
  return { docs: decodeWideIntegerRows(model, decodeJsonColumns(model, rows)), count: rowCount ?? rows.length };
}

export async function executeDuckdbUpdate(
  driver: DuckdbQueryable,
  node: UpdateNode,
  model: ModelDef<any>,
  opts: DuckdbExecOpts = {},
): Promise<{ doc?: any; count: number }> {
  const exec = opts.client ?? driver;
  const countOnly = node.many && exec.reportsChangedRows === true;
  const artifact = compileUpdate(countOnly ? { ...node, countOnly } : node, model, opts.dialect);
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
  const countOnly = node.many && exec.reportsChangedRows === true;
  const artifact = compileDelete(countOnly ? { ...node, countOnly } : node, model, opts.dialect);
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
