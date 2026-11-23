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
  jsonRelationEligible,
} from './compile-from-ir';
import { JSON_ORD_ALIAS, JSON_REL_ALIAS_PREFIX } from '../../ir/types';
import { withPgErrors } from './errors';
import { decodeWideIntegerRows, decodeWideIntegers } from '../shared/wide-int';
import { hydrateManyRelation, hydrateOneRelation, liftRelationCounts, type WindowedPaging } from '../../ir/hydrate-many';
import { refineFallbackGeo } from '../shared/haversine';

// Postgres IR executor — wires SQLArtifacts to a pg pool.
//
// Hydration is one SELECT per include level, `WHERE fk IN (…)`, paged per
// parent with ROW_NUMBER() when the include has a take or skip.

const WINDOWED: WindowedPaging = { enabled: true };

export interface PgPoolHandle {
  query(sql: string, params?: unknown[]): Promise<{ rows: any[]; rowCount: number | null }>;
}

export interface PgExecOpts {
  // A pg.PoolClient (when inside a $transaction) — overrides the pool for the
  // duration of the call so all queries land on the same connection / txn.
  client?: PgPoolHandle;
}

export async function executePgSelect(
  pool: PgPoolHandle,
  node: SelectNode,
  model: ModelDef<any>,
  opts: PgExecOpts = {},
): Promise<any[]> {
  const exec = opts.client ?? pool;
  const artifact = compileSelect(node, model);
  const { rows } = await withPgErrors(() => exec.query(artifact.sql, artifact.params));

  let out = decodeWideIntegerRows(model, rows);
  if (node.distinct?.length) out = dedupeBy(out, node.distinct);

  // Fallback geoPoint post-processing — when a `near` filter or `nearTo`
  // orderBy references a fallback-mode geo column, the SQL emitted a bbox
  // prefilter only (over-inclusive). Refine to the exact circle + annotate
  // _distanceMeters in app.
  out = refineFallbackGeo(out, node, model);

  if (node.projection?.counts?.length) {
    liftRelationCounts(out, node.projection.counts);
  }
  if (node.hydration?.length) {
    const rest = liftJsonRelations(out, model, node.hydration);
    if (rest.length) await hydrate(exec, out, model, rest);
  }
  return out;
}

// The relations compileSelect loaded as JSON columns: decode them onto each
// row and hand back the ones still to load per level.
function liftJsonRelations(rows: any[], model: ModelDef<any>, hydration: RelationPlan[]): RelationPlan[] {
  const rest: RelationPlan[] = [];
  for (const rel of hydration) {
    if (!jsonRelationEligible(model, rel)) { rest.push(rel); continue; }
    const key = JSON_REL_ALIAS_PREFIX + rel.name;
    const target = (schema as any)[rel.target] as ModelDef<any>;
    for (const r of rows) {
      let v = r[key];
      delete r[key];
      if (typeof v === 'string') v = JSON.parse(v);
      if (rel.kind === 'one') r[rel.name] = v == null ? null : decodeJsonRow(target, rel, v);
      else {
        const list = v ?? [];
        for (let i = 0; i < list.length; i++) list[i] = decodeJsonRow(target, rel, list[i]);
        r[rel.name] = list;
      }
    }
  }
  return rest;
}

const JSON_FLOATS: Record<string, number> = { NaN: NaN, Infinity: Infinity, '-Infinity': -Infinity };
const jsonDecodePlans = new WeakMap<object, Array<[string, (v: any) => any]>>();

function jsonDecodePlan(model: ModelDef<any>): Array<[string, (v: any) => any]> {
  let plan = jsonDecodePlans.get(model);
  if (plan) return plan;
  plan = [];
  for (const [name, f] of Object.entries(model.fields)) {
    const kind = (f as { kind: string }).kind;
    if (kind === 'dateTime') {
      plan.push([name, (v) => (typeof v !== 'string' ? v
        : v === 'infinity' ? Infinity : v === '-infinity' ? -Infinity : new Date(v))]);
    } else if (kind === 'float') {
      plan.push([name, (v) => (typeof v === 'string' && v in JSON_FLOATS ? JSON_FLOATS[v] : v)]);
    }
  }
  jsonDecodePlans.set(model, plan);
  return plan;
}

function decodeJsonRow(model: ModelDef<any>, rel: RelationPlan, row: any): any {
  const plan = jsonDecodePlan(model);
  for (let i = 0; i < plan.length; i++) {
    const [k, c] = plan[i];
    const v = row[k];
    if (v != null) row[k] = c(v);
  }
  if (JSON_ORD_ALIAS in row) delete row[JSON_ORD_ALIAS];
  row = decodeWideIntegers(model, row);
  const n = rel.nested;
  if (n?.projection?.counts?.length) liftRelationCounts([row], n.projection.counts);
  if (n?.hydration?.length) liftJsonRelations([row], model, n.hydration);
  return row;
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

export async function executePgInsert(
  pool: PgPoolHandle,
  node: InsertNode,
  model: ModelDef<any>,
  opts: PgExecOpts = {},
): Promise<{ docs: any[]; count: number }> {
  const exec = opts.client ?? pool;
  const artifact = compileInsert(node, model);
  const { rows, rowCount } = await withPgErrors(() => exec.query(artifact.sql, artifact.params));
  return { docs: decodeWideIntegerRows(model, rows), count: rowCount ?? rows.length };
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
  if (node.many || node.noReturn) return { count: rowCount ?? rows.length };
  return { doc: decodeWideIntegers(model, rows[0]), count: rows.length };
}

export async function executePgDelete(
  pool: PgPoolHandle,
  node: DeleteNode,
  model: ModelDef<any>,
  opts: PgExecOpts = {},
): Promise<{ doc?: any; count: number }> {
  const exec = opts.client ?? pool;
  // DELETE … RETURNING * gives us the removed row; cascade behaviour is
  // delegated to the DB engine via ON DELETE clauses set in DDL.
  const artifact = compileDelete(node, model);
  const { rows, rowCount } = await withPgErrors(() => exec.query(artifact.sql, artifact.params));
  if (node.many || node.noReturn) return { count: rowCount ?? rows.length };
  return { doc: decodeWideIntegers(model, rows[0]), count: rows.length };
}

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
  await hydrateOneRelation({
    rows, rel, parentField: rel.on, targetField: rel.refs, keyOf: stringKey,
    runSelect: (node) => executePgSelect(exec, node, targetModel),
  });
}

async function hydrateInverseOne(
  exec: PgPoolHandle,
  rows: any[],
  rel: RelationPlan,
  targetModel: ModelDef<any>,
): Promise<void> {
  await hydrateOneRelation({
    rows, rel, parentField: rel.refs, targetField: rel.on, keyOf: stringKey,
    runSelect: (node) => executePgSelect(exec, node, targetModel),
  });
}

async function hydrateMany(
  exec: PgPoolHandle,
  rows: any[],
  rel: RelationPlan,
  targetModel: ModelDef<any>,
): Promise<void> {
  await hydrateManyRelation({
    rows, rel, keyOf: stringKey,
    runSelect: (node) => executePgSelect(exec, node, targetModel),
    windowed: WINDOWED,
  });
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
