import type {
  CountNode,
  DeleteNode,
  GroupByNode,
  InsertNode,
  OrderByEntry,
  ProjectionPlan,
  SelectNode,
  UpdateNode,
  WhereTree,
} from '../../ir/types';
import type { SQLArtifact } from '../../compile';
import type { FieldDef, ModelDef } from '../../schema/types';
import { schema } from '../../schema';
import { PostgresDialect, type Dialect } from './dialect';
import { multiPolygonBbox } from '../shared/wkt';

// Hard rules:
//   • Never interpolate values into the SQL string — always via params.
//   • Quote every identifier so case + reserved words don't bite.
//   • Escape LIKE metacharacters on the value, not the SQL.

const escapeForLike = (s: string) => String(s).replace(/[%_\\]/g, (m) => '\\' + m);

function modelDef(modelKey: string, override?: ModelDef<any>): ModelDef<any> {
  if (override) return override;
  const m = (schema as any)[modelKey] as ModelDef<any> | undefined;
  if (!m) throw new Error(`[forge:postgres] unknown model '${modelKey}' in IR`);
  return m;
}

interface CompileCtx {
  d: Dialect;
  table: string;          // quoted identifier of the current row source
  model: ModelDef<any>;
  params: unknown[];
  // Alias counter so nested EXISTS subqueries get unique table aliases.
  aliasCount: { n: number };
  // Lets tests drive relation EXISTS with ad-hoc models not in the schema map.
  schemaOverride?: Record<string, ModelDef<any>>;
}

function compileWhere(ctx: CompileCtx, tree: WhereTree | undefined): string {
  if (!tree) return '';
  return compileWhereNode(ctx, tree);
}

function compileWhereNode(ctx: CompileCtx, tree: WhereTree): string {
  switch (tree.kind) {
    case 'and': {
      const parts = tree.children.map((c) => compileWhereNode(ctx, c)).filter(notEmpty);
      if (parts.length === 0) return '';
      if (parts.length === 1) return parts[0];
      return `(${parts.join(' AND ')})`;
    }
    case 'or': {
      const parts = tree.children.map((c) => compileWhereNode(ctx, c)).filter(notEmpty);
      if (parts.length === 0) return '';
      if (parts.length === 1) return parts[0];
      return `(${parts.join(' OR ')})`;
    }
    case 'not': {
      const inner = compileWhereNode(ctx, tree.child);
      return inner ? `NOT (${inner})` : '';
    }
    case 'relation':
      return compileRelationFilter(ctx, tree);
    case 'leaf':
      return compileLeaf(ctx, tree);
  }
}

const SQL_CMP_OPS: Partial<Record<string, string>> = {
  eq: '=', ne: '<>', lt: '<', lte: '<=', gt: '>', gte: '>=',
};

function compileLeaf(ctx: CompileCtx, leaf: Extract<WhereTree, { kind: 'leaf' }>): string {
  const col = `${ctx.table}.${ctx.d.quoteIdent(leaf.field)}`;
  const ph = (v: unknown) => ctx.d.placeholder(ctx.params, v);

  // Field-to-field comparison (`col('rhsField')`) → `lhsCol <op> rhsCol`. No
  // placeholder: the right-hand side is a column, not a bound parameter.
  if (leaf.rhsField !== undefined) {
    const sqlOp = SQL_CMP_OPS[leaf.op];
    if (!sqlOp) {
      throw new Error(`[forge] col() comparison not supported for op '${leaf.op}'`);
    }
    const rhsCol = `${ctx.table}.${ctx.d.quoteIdent(leaf.rhsField)}`;
    return `${col} ${sqlOp} ${rhsCol}`;
  }

  switch (leaf.op) {
    case 'eq':       return leaf.value === null ? `${col} IS NULL`      : `${col} = ${ph(leaf.value)}`;
    case 'ne':       return leaf.value === null ? `${col} IS NOT NULL`  : `${col} <> ${ph(leaf.value)}`;
    case 'in': {
      const arr = leaf.value as unknown[];
      if (!arr.length) return 'FALSE';
      return `${col} IN (${arr.map(ph).join(', ')})`;
    }
    case 'nin': {
      const arr = leaf.value as unknown[];
      if (!arr.length) return 'TRUE';
      return `${col} NOT IN (${arr.map(ph).join(', ')})`;
    }
    case 'lt':  return `${col} < ${ph(leaf.value)}`;
    case 'lte': return `${col} <= ${ph(leaf.value)}`;
    case 'gt':  return `${col} > ${ph(leaf.value)}`;
    case 'gte': return `${col} >= ${ph(leaf.value)}`;
    case 'contains':
      return likeOp(ctx, col, `%${escapeForLike(String(leaf.value))}%`, !!leaf.caseInsensitive);
    case 'startsWith':
      return likeOp(ctx, col, `${escapeForLike(String(leaf.value))}%`, !!leaf.caseInsensitive);
    case 'endsWith':
      return likeOp(ctx, col, `%${escapeForLike(String(leaf.value))}`, !!leaf.caseInsensitive);
    case 'has':
      return `${ph(leaf.value)} = ANY(${col})`;
    case 'hasSome': {
      const arr = leaf.value as unknown[];
      if (!arr.length) return 'FALSE';
      return `${col} && ARRAY[${arr.map(ph).join(', ')}]`;
    }
    case 'hasEvery': {
      const arr = leaf.value as unknown[];
      if (!arr.length) return 'TRUE';
      return `${col} @> ARRAY[${arr.map(ph).join(', ')}]`;
    }
    case 'isEmpty':
      return leaf.value ? `coalesce(array_length(${col}, 1), 0) = 0`
                        : `coalesce(array_length(${col}, 1), 0) > 0`;
    case 'search':
      return ctx.d.searchClause(col, ph(String(leaf.value)), {
        rawColumn: leaf.field,
        baseTable: ctx.model.collection,
        quoteIdent: (s: string) => ctx.d.quoteIdent(s),
      });
    case 'jsonPath': {
      if (!leaf.jsonPath) return 'TRUE';
      const { path, subOp } = leaf.jsonPath;
      const rawCol = `${ctx.table}.${ctx.d.quoteIdent(leaf.field)}`;
      const rendered = ctx.d.jsonPathExpr
        ? ctx.d.jsonPathExpr(rawCol, path, leaf.value)
        : pgJsonPath(rawCol, path, leaf.value);
      // Compare the extracted value against the user-supplied operand using
      // the same operator vocabulary as scalar leaves.
      const ph = (v: unknown) => ctx.d.placeholder(ctx.params, v);
      switch (subOp) {
        case 'eq':  return leaf.value === null ? `${rendered} IS NULL` : `${rendered} = ${ph(coerceJsonOperand(leaf.value))}`;
        case 'ne':  return leaf.value === null ? `${rendered} IS NOT NULL` : `${rendered} <> ${ph(coerceJsonOperand(leaf.value))}`;
        case 'lt':  return `${rendered} < ${ph(coerceJsonOperand(leaf.value))}`;
        case 'lte': return `${rendered} <= ${ph(coerceJsonOperand(leaf.value))}`;
        case 'gt':  return `${rendered} > ${ph(coerceJsonOperand(leaf.value))}`;
        case 'gte': return `${rendered} >= ${ph(coerceJsonOperand(leaf.value))}`;
        case 'contains': {
          const v = String(leaf.value);
          return `${rendered} LIKE ${ph('%' + escapeForLike(v) + '%')}`;
        }
        case 'in': {
          const arr = leaf.value as unknown[];
          if (!arr.length) return 'FALSE';
          return `${rendered} IN (${arr.map((v) => ph(coerceJsonOperand(v))).join(', ')})`;
        }
        case 'has': {
          // Array containment — the extracted value is itself a JSON array.
          // Cheapest cross-dialect: cast to text + LIKE on the JSON repr.
          return `${rendered}::text LIKE ${ph('%' + JSON.stringify(leaf.value) + '%')}`;
        }
      }
      return 'TRUE';
    }
    case 'near': {
      const fld = ctx.model.fields[leaf.field];
      if (!fld) throw new Error(`[forge] where.${leaf.field}.near: unknown field.`);
      if (fld.kind === 'vector') {
        const v = leaf.value as { vector: number[]; withinDistance?: number };
        if (!ctx.d.vectorDistanceClause) {
          throw new Error(`[forge] dialect '${ctx.d.name}' does not implement vectorDistanceClause`);
        }
        return ctx.d.vectorDistanceClause(col, fld, v, ctx.params);
      }
      if (fld.kind !== 'geoPoint') {
        throw new Error(`[forge] where.${leaf.field}.near requires a geoPoint or vector field.`);
      }
      const point = leaf.value as { lng: number; lat: number; withinMeters?: number };
      if (fld.geo?.fallback) {
        return haversineBboxPrefilter(ctx, leaf.field, point);
      }
      if (!ctx.d.geoNearClause) {
        throw new Error(`[forge] dialect '${ctx.d.name}' does not implement geoNearClause`);
      }
      return ctx.d.geoNearClause(col, fld, point, ctx.params);
    }
    case 'withinPolygon': {
      const fld = ctx.model.fields[leaf.field];
      if (!fld || fld.kind !== 'geoPoint') {
        throw new Error(`[forge] where.${leaf.field}.withinPolygon requires a geoPoint field.`);
      }
      // IR-normalised shape: { multiPolygon: Polygon[] }. A simple ring still
      // arrives here as a single-polygon-single-ring [[ring]]. Older callers
      // that hand-wrote leaf.value.polygon (private API) still resolve via
      // the fallback branch below.
      const v = leaf.value as { multiPolygon?: Array<Array<Array<{ lng: number; lat: number }>>>; polygon?: Array<{ lng: number; lat: number }> };
      const multiPolygon = v.multiPolygon ?? (v.polygon ? [[v.polygon]] : []);
      if (multiPolygon.length === 0) {
        throw new Error(`[forge] where.${leaf.field}.withinPolygon: empty polygon set.`);
      }
      if (fld.geo?.fallback) {
        // Fallback storage is JSON {lng, lat}. Emit a bbox prefilter from
        // the union envelope of every ring; the exact point-in-multi-polygon
        // refinement happens in app via ray-casting (see haversine.ts).
        return polygonBboxPrefilter(ctx, leaf.field, multiPolygon);
      }
      if (!ctx.d.geoWithinPolygonClause) {
        throw new Error(`[forge] dialect '${ctx.d.name}' does not implement geoWithinPolygonClause`);
      }
      return ctx.d.geoWithinPolygonClause(col, fld, multiPolygon, ctx.params);
    }
  }
}

// PG jsonb path extraction. Numeric path segments stay text-keyed (PG's
// `->`/`->>` always treats string keys; numeric segments index into arrays).
// We emit ->> at the LEAF (text extraction) and cast based on the operand
// type for the comparison.
function pgJsonPath(rawCol: string, path: string[], operand: unknown): string {
  if (path.length === 0) return rawCol;
  // Build the navigation chain with -> for all but the last, ->> for the last
  // so we get text back.
  let expr = rawCol;
  for (let i = 0; i < path.length - 1; i++) {
    const seg = path[i];
    expr = /^\d+$/.test(seg) ? `${expr}->${Number(seg)}` : `${expr}->'${seg.replace(/'/g, "''")}'`;
  }
  const last = path[path.length - 1];
  expr = /^\d+$/.test(last) ? `${expr}->>${Number(last)}` : `${expr}->>'${last.replace(/'/g, "''")}'`;
  // Cast based on the operand type so comparisons make sense.
  if (typeof operand === 'number') return `(${expr})::numeric`;
  if (typeof operand === 'boolean') return `(${expr})::boolean`;
  if (operand instanceof Date) return `(${expr})::timestamptz`;
  return expr; // text
}

function coerceJsonOperand(v: unknown): unknown {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return v;
  if (v instanceof Date) return v.toISOString();
  return JSON.stringify(v);
}

function polygonBboxPrefilter(
  ctx: CompileCtx,
  field: string,
  multiPolygon: Array<Array<Array<{ lng: number; lat: number }>>>,
): string {
  const { minLng, maxLng, minLat, maxLat } = multiPolygonBbox(multiPolygon);
  const ph = (v: unknown) => ctx.d.placeholder(ctx.params, v);
  const lngCol = `(${ctx.table}.${ctx.d.quoteIdent(field)}->>'lng')::float8`;
  const latCol = `(${ctx.table}.${ctx.d.quoteIdent(field)}->>'lat')::float8`;
  return `(${lngCol} BETWEEN ${ph(minLng)} AND ${ph(maxLng)} AND ` +
         `${latCol} BETWEEN ${ph(minLat)} AND ${ph(maxLat)})`;
}

// Bounding-box prefilter for fallback geoPoint columns (JSON {lng, lat}).
// Uses degrees-per-meter approximation: 1 deg latitude ≈ 111_320 m, 1 deg
// longitude ≈ 111_320 * cos(lat) m. The post-filter runs in app code.
function haversineBboxPrefilter(
  ctx: CompileCtx,
  field: string,
  point: { lng: number; lat: number; withinMeters?: number },
): string {
  const radiusM = point.withinMeters ?? 1e9;
  const latDeg = radiusM / 111_320;
  const lngDeg = radiusM / (111_320 * Math.cos(point.lat * Math.PI / 180) || 1e-9);
  const ph = (v: unknown) => ctx.d.placeholder(ctx.params, v);
  // PG: extract lng/lat from the jsonb. SQLite/MySQL use the same expression
  // via the dialect's quoteIdent + ->> path operator (dialect-specific).
  // For PG we use `->>` to get text and cast to float8.
  const lngCol = `(${ctx.table}.${ctx.d.quoteIdent(field)}->>'lng')::float8`;
  const latCol = `(${ctx.table}.${ctx.d.quoteIdent(field)}->>'lat')::float8`;
  return `(${lngCol} BETWEEN ${ph(point.lng - lngDeg)} AND ${ph(point.lng + lngDeg)} AND ` +
         `${latCol} BETWEEN ${ph(point.lat - latDeg)} AND ${ph(point.lat + latDeg)})`;
}

function likeOp(ctx: CompileCtx, col: string, pattern: string, ci: boolean): string {
  const ph = ctx.d.placeholder(ctx.params, pattern);
  return ci ? `${col} ILIKE ${ph}` : `${col} LIKE ${ph}`;
}

function compileRelationFilter(
  ctx: CompileCtx,
  tree: Extract<WhereTree, { kind: 'relation' }>,
): string {
  const relations = ctx.model.relations();
  const rel = relations[tree.relation];
  if (!rel) return 'TRUE';
  const targetModel =
    ctx.schemaOverride?.[rel.target] ??
    ((schema as any)[rel.target] as ModelDef<any> | undefined);
  if (!targetModel) return 'TRUE';

  // Unique alias for this subquery — `t1`, `t2`, ... — so nested EXISTS
  // don't shadow each other.
  ctx.aliasCount.n += 1;
  const alias = `t${ctx.aliasCount.n}`;
  const aliasQ = ctx.d.quoteIdent(alias);
  const subTable = ctx.d.quoteIdent(targetModel.collection);

  // Owning side: parent.<rel.on> = target.<rel.refs>
  // Inverse side: target.<rel.on>  = parent.<rel.refs>
  const isOwning = ctx.model.fields[rel.on] != null;
  const parentCol = isOwning ? rel.on  : rel.refs;
  const targetCol = isOwning ? rel.refs : rel.on;
  const joinCondition =
    `${aliasQ}.${ctx.d.quoteIdent(targetCol)} = ${ctx.table}.${ctx.d.quoteIdent(parentCol)}`;

  const inner = tree.nested
    ? compileWhereNode(
        {
          d: ctx.d, model: targetModel, table: aliasQ, params: ctx.params,
          aliasCount: ctx.aliasCount, schemaOverride: ctx.schemaOverride,
        },
        tree.nested,
      )
    : '';
  const innerClause = inner ? ` AND ${inner}` : '';

  const baseExists = `EXISTS (SELECT 1 FROM ${subTable} ${aliasQ} WHERE ${joinCondition}${innerClause})`;

  switch (tree.mode) {
    case 'is':
    case 'some':
      return baseExists;
    case 'isNot':
    case 'none':
      return `NOT ${baseExists}`;
    case 'every': {
      // "every related row matches" = no related row violates the condition.
      // i.e. NOT EXISTS (rows where the inner condition is FALSE).
      if (!inner) return baseExists;
      const notInner = `NOT (${inner})`;
      return `NOT EXISTS (SELECT 1 FROM ${subTable} ${aliasQ} WHERE ${joinCondition} AND ${notInner})`;
    }
  }
}

function notEmpty(s: string): boolean {
  return s.length > 0;
}

function compileProjectionCols(
  d: Dialect,
  table: string,
  model: ModelDef<any>,
  plan: ProjectionPlan | undefined,
): string {
  if (!plan) {
    // Stable-ordered by schema declaration.
    const cols = Object.keys(model.fields).map((f) => `${table}.${d.quoteIdent(f)}`);
    return cols.join(', ');
  }
  if (plan.exclusive && plan.fields.length) {
    return plan.fields.map((f) => `${table}.${d.quoteIdent(f)}`).join(', ');
  }
  if (plan.omit?.length) {
    const drop = new Set(plan.omit);
    const cols = Object.keys(model.fields)
      .filter((f) => !drop.has(f))
      .map((f) => `${table}.${d.quoteIdent(f)}`);
    return cols.join(', ');
  }
  return Object.keys(model.fields).map((f) => `${table}.${d.quoteIdent(f)}`).join(', ');
}

function compileOrder(d: Dialect, table: string, orderBy: OrderByEntry[] | undefined, model?: ModelDef<any>): string {
  if (!orderBy?.length) return '';
  const parts = orderBy.map((e) => {
    if (e.nearTo) {
      const fld = model?.fields?.[e.field];
      // A fallback geoPoint has no distance column in the SELECT — sorting
      // happens in app, after the haversine pass. Referencing the alias
      // here would be an ORDER BY over a column that does not exist.
      if (fld?.kind === 'geoPoint' && fld.geo?.fallback) return null;
      // Reference the synthetic alias emitted in SELECT.
      const alias = fld?.kind === 'vector' ? '_distance' : '_distanceMeters';
      return d.orderClause(d.quoteIdent(alias), e.direction);
    }
    return d.orderClause(`${table}.${d.quoteIdent(e.field)}`, e.direction, e.nulls);
  }).filter((p): p is string => p !== null);
  if (!parts.length) return '';
  return `ORDER BY ${parts.join(', ')}`;
}

function compileCursor(
  d: Dialect,
  table: string,
  params: unknown[],
  cursor: SelectNode['cursor'],
): string {
  if (!cursor?.fields) return '';
  const keys = Object.keys(cursor.fields);
  if (keys.length === 0) return '';
  if (keys.length === 1) {
    const k = keys[0];
    return `${table}.${d.quoteIdent(k)} > ${d.placeholder(params, cursor.fields[k])}`;
  }
  // Composite cursor: tuple comparison. PG supports (a, b) > (?, ?).
  const cols = keys.map((k) => `${table}.${d.quoteIdent(k)}`).join(', ');
  const vals = keys.map((k) => d.placeholder(params, cursor.fields[k])).join(', ');
  return `(${cols}) > (${vals})`;
}

export function compileSelect(
  node: SelectNode,
  modelOverride?: ModelDef<any>,
  dialect: Dialect = PostgresDialect,
  schemaOverride?: Record<string, ModelDef<any>>,
): SQLArtifact {
  const m = modelDef(node.model, modelOverride);
  const params: unknown[] = [];
  const table = dialect.quoteIdent(m.collection);
  const ctx: CompileCtx = { d: dialect, model: m, table, params, aliasCount: { n: 0 }, schemaOverride };

  let cols = compileProjectionCols(dialect, table, m, node.projection);
  const distinctClause = node.distinct?.length
    ? `DISTINCT ON (${node.distinct.map((f) => `${table}.${dialect.quoteIdent(f)}`).join(', ')}) `
    : '';

  // Geo / vector: if any orderBy entry has `nearTo`, synthesize a distance
  // column. Geo → `_distanceMeters` from geoDistanceExpr; vector → `_distance`
  // from vectorDistanceExpr. Render BEFORE WHERE so placeholders end up in
  // natural-read order ($1, $2 first; $3+ = WHERE params).
  const nearToEntry = node.orderBy?.find((e) => e.nearTo);
  if (nearToEntry?.nearTo) {
    const fld = m.fields[nearToEntry.field];
    if (!fld) {
      throw new Error(`[forge] orderBy.${nearToEntry.field}.nearTo: unknown field.`);
    }
    if (fld.kind === 'vector') {
      const nt = nearToEntry.nearTo as { vector?: number[] };
      if (!Array.isArray(nt.vector)) {
        throw new Error(`[forge] orderBy.${nearToEntry.field}.nearTo for vector fields requires a vector array.`);
      }
      if (!dialect.vectorDistanceExpr) {
        throw new Error(`[forge] dialect '${dialect.name}' does not implement vectorDistanceExpr`);
      }
      const distExpr = dialect.vectorDistanceExpr(
        `${table}.${dialect.quoteIdent(nearToEntry.field)}`,
        fld, nt.vector, params,
      );
      cols = `${cols}, ${distExpr} AS _distance`;
    } else if (fld.kind === 'geoPoint' && !fld.geo?.fallback) {
      if (!dialect.geoDistanceExpr) {
        throw new Error(`[forge] dialect '${dialect.name}' does not implement geoDistanceExpr`);
      }
      const distExpr = dialect.geoDistanceExpr(
        `${table}.${dialect.quoteIdent(nearToEntry.field)}`,
        fld, nearToEntry.nearTo as { lng: number; lat: number }, params,
      );
      cols = `${cols}, ${distExpr} AS _distanceMeters`;
    } else if (fld.kind === 'geoPoint') {
      // fallback: true — the column is JSON, not a geography, so there is no
      // ST_Distance to call. `where.near` already knew this and emitted a
      // bbox prefilter; ORDER BY did not, and asked Postgres for
      // ST_GeogFromText against a jsonb column. The executor computes
      // _distanceMeters by haversine and sorts on it afterwards, so the
      // right SQL here is none at all.
    } else {
      throw new Error(`[forge] orderBy.${nearToEntry.field}.nearTo requires a geoPoint or vector field.`);
    }
  }

  const whereParts: string[] = [];
  const w = compileWhere(ctx, node.where);
  if (w) whereParts.push(w);
  const c = compileCursor(dialect, table, params, node.cursor);
  if (c) whereParts.push(c);
  const whereClause = whereParts.length ? `WHERE ${whereParts.join(' AND ')}` : '';

  const orderClause = compileOrder(dialect, table, node.orderBy, m);
  const limit = node.limit != null ? `LIMIT ${Number(node.limit)}` : '';
  const offset = node.offset != null ? `OFFSET ${Number(node.offset)}` : '';

  const sql = [
    `SELECT ${distinctClause}${cols} FROM ${table}`,
    whereClause, orderClause, limit, offset,
  ].filter(Boolean).join(' ');

  return { kind: 'sql', dialect: dialect.name, sql, params };
}

export function compileCount(
  node: CountNode,
  modelOverride?: ModelDef<any>,
  dialect: Dialect = PostgresDialect,
  schemaOverride?: Record<string, ModelDef<any>>,
): SQLArtifact {
  const m = modelDef(node.model, modelOverride);
  const params: unknown[] = [];
  const table = dialect.quoteIdent(m.collection);
  const ctx: CompileCtx = { d: dialect, model: m, table, params, aliasCount: { n: 0 }, schemaOverride };
  const where = compileWhere(ctx, node.where);
  const distinctClause = node.distinct?.length
    ? `COUNT(DISTINCT (${node.distinct.map((f) => `${table}.${dialect.quoteIdent(f)}`).join(', ')}))`
    : 'COUNT(*)';
  const sql = [
    `SELECT ${distinctClause} AS count FROM ${table}`,
    where ? `WHERE ${where}` : '',
  ].filter(Boolean).join(' ');
  return { kind: 'sql', dialect: dialect.name, sql, params };
}

export function compileInsert(
  node: InsertNode,
  modelOverride?: ModelDef<any>,
  dialect: Dialect = PostgresDialect,
  schemaOverride?: Record<string, ModelDef<any>>,
): SQLArtifact {
  const m = modelDef(node.model, modelOverride);
  const params: unknown[] = [];
  const table = dialect.quoteIdent(m.collection);
  if (node.rows.length === 0) {
    return { kind: 'sql', dialect: dialect.name, sql: `SELECT 0 WHERE FALSE`, params };
  }
  // Stable column list: union of all keys across rows, schema-ordered.
  const allKeys = new Set<string>();
  for (const r of node.rows) for (const k of Object.keys(r)) allKeys.add(k);
  const cols = Object.keys(m.fields).filter((f) => allKeys.has(f));
  for (const k of allKeys) if (!cols.includes(k)) cols.push(k);

  const colList = cols.map((c) => dialect.quoteIdent(c)).join(', ');
  const valueRows = node.rows.map((row) => {
    const vals = cols.map((c) => {
      const fld = m.fields[c];
      // valueExpr is the dialect's per-field value emitter (handles geoPoint
      // wrapping etc.); fall back to a plain placeholder for older dialects.
      if (fld && dialect.valueExpr) return dialect.valueExpr(fld, params, row[c] ?? null);
      return dialect.placeholder(params, row[c] ?? null);
    });
    return `(${vals.join(', ')})`;
  }).join(', ');

  const onConflict = node.skipDuplicates ? ' ON CONFLICT DO NOTHING' : '';
  const returning = node.returning?.exclusive && node.returning.fields.length
    ? ` RETURNING ${node.returning.fields.map((f) => dialect.quoteIdent(f)).join(', ')}`
    : ' RETURNING *';

  const sql = `INSERT INTO ${table} (${colList}) VALUES ${valueRows}${onConflict}${returning}`;
  return { kind: 'sql', dialect: dialect.name, sql, params };
}

/**
 * True when an update node carries nothing to write.
 *
 * Exported because MySQL rewrites the assignment list and has to know the
 * difference between a real assignment and the no-op emitted for an empty
 * payload — see `compileUpdate` there.
 */
export function hasNoUpdatePayload(node: UpdateNode): boolean {
  return (
    !node.set ||
    Object.keys(node.set).length === 0
  ) &&
    !node.increment &&
    !node.multiply &&
    !node.push &&
    !node.unset?.length;
}

export function compileUpdate(
  node: UpdateNode,
  modelOverride?: ModelDef<any>,
  dialect: Dialect = PostgresDialect,
  schemaOverride?: Record<string, ModelDef<any>>,
): SQLArtifact {
  const m = modelDef(node.model, modelOverride);
  const params: unknown[] = [];
  const table = dialect.quoteIdent(m.collection);
  const ctx: CompileCtx = { d: dialect, model: m, table, params, aliasCount: { n: 0 }, schemaOverride };

  // Build set clauses lazily so that for upsert we can push VALUES params
  // first (more intuitive $1, $2, $3 ordering in the emitted SQL).
  const buildSet = (): string[] => {
    const parts: string[] = [];
    // Per-field value emitter — wraps geoPoint, falls through to placeholder.
    const valExpr = (col: string, v: unknown): string => {
      const fld = m.fields[col];
      if (fld && dialect.valueExpr) return dialect.valueExpr(fld, params, v);
      return dialect.placeholder(params, v);
    };
    if (node.set) {
      for (const [k, v] of Object.entries(node.set)) {
        parts.push(`${dialect.quoteIdent(k)} = ${valExpr(k, v)}`);
      }
    }
    if (node.increment) {
      for (const [k, v] of Object.entries(node.increment)) {
        // SET col = col + $n — atomic at PG's row-lock level.
        parts.push(`${dialect.quoteIdent(k)} = ${table}.${dialect.quoteIdent(k)} + ${dialect.placeholder(params, v)}`);
      }
    }
    if (node.multiply) {
      for (const [k, v] of Object.entries(node.multiply)) {
        parts.push(`${dialect.quoteIdent(k)} = ${table}.${dialect.quoteIdent(k)} * ${dialect.placeholder(params, v)}`);
      }
    }
    if (node.push) {
      for (const [k, v] of Object.entries(node.push)) {
        parts.push(`${dialect.quoteIdent(k)} = array_append(${table}.${dialect.quoteIdent(k)}, ${dialect.placeholder(params, v)})`);
      }
    }
    if (node.unset?.length) {
      for (const k of node.unset) {
        parts.push(`${dialect.quoteIdent(k)} = NULL`);
      }
    }
    return parts;
  };

  // A SET list can legitimately come out empty.
  //
  //   db.user.upsert({ where, create, update: {} })   ← "insert if missing,
  //                                                      otherwise leave it"
  //   db.user.update({ where, data: {} })
  //
  // Both emitted `SET` with nothing after it, which every dialect rejects —
  // and because `RETURNING *` follows, the parser blames the next token and
  // reports `near "RETURNING": syntax error`, pointing at the one part of
  // the statement that was fine.
  //
  // A column assigned to its own current value is valid SQL, changes no
  // row, and keeps RETURNING yielding the row — which upsert's contract
  // requires: it must hand back the record whether it inserted or not.
  // `DO NOTHING` would parse, but returns NO row on conflict, so upsert
  // would resolve to undefined exactly when the row already existed.
  const noopSet = (): string => {
    const idCol =
      Object.keys(m.fields).find((k) => (m.fields[k] as FieldDef).kind === 'id') ??
      Object.keys(m.fields)[0];
    if (!idCol) throw new Error(`[forge] model '${m.collection}' has no columns to update`);
    const q = dialect.quoteIdent(idCol);
    return `${q} = ${table}.${q}`;
  };

  // Upsert: emit INSERT … ON CONFLICT (...) DO UPDATE SET …
  // VALUES params are pushed first so reading the SQL top-down also reads
  // the params in $1, $2, $3 order.
  if (node.upsertCreate) {
    const cols = Object.keys(node.upsertCreate);
    const colList = cols.map((c) => dialect.quoteIdent(c)).join(', ');
    // Through valueExpr, not a bare placeholder: geoPoint and vector need
    // the dialect's wrapping (ST_GeogFromText(...), `[…]::vector`). INSERT
    // and the SET clause both did this; upsert's VALUES did not, so an
    // upsert carrying either type sent the raw JS value and Postgres
    // rejected it — "Vector contents must start with [".
    const valList = cols
      .map((c) => {
        const fld = m.fields[c];
        return fld && dialect.valueExpr
          ? dialect.valueExpr(fld, params, node.upsertCreate![c])
          : dialect.placeholder(params, node.upsertCreate![c]);
      })
      .join(', ');
    const upsertSet = buildSet();
    const setParts = upsertSet.length ? upsertSet : [noopSet()];
    const conflictCols = whereLeafColumns(node.where).map((c) => dialect.quoteIdent(c));
    const conflictClause = conflictCols.length
      ? dialect.upsertConflictClause(conflictCols, setParts.join(', '))
      : 'ON CONFLICT DO NOTHING';
    const sql = `INSERT INTO ${table} (${colList}) VALUES (${valList}) ${conflictClause} RETURNING *`;
    return { kind: 'sql', dialect: dialect.name, sql, params };
  }

  const built = buildSet();
  const setParts = built.length ? built : [noopSet()];

  const where = compileWhere(ctx, node.where);
  const whereClause = where ? `WHERE ${where}` : '';
  const limitClause = node.many ? '' : 'WHERE ctid = (SELECT ctid FROM ' + table + (where ? ' WHERE ' + where : '') + ' LIMIT 1)';
  // For updateOne (many=false), we constrain to a single row via ctid — PG's
  // standard idiom since UPDATE … LIMIT isn't valid SQL on its own.
  const finalWhere = node.many ? whereClause : limitClause;
  const returning = node.returning?.exclusive && node.returning.fields.length
    ? ` RETURNING ${node.returning.fields.map((f) => dialect.quoteIdent(f)).join(', ')}`
    : ' RETURNING *';

  const sql = `UPDATE ${table} SET ${setParts.join(', ')} ${finalWhere}${returning}`;
  return { kind: 'sql', dialect: dialect.name, sql, params };
}

export function compileDelete(
  node: DeleteNode,
  modelOverride?: ModelDef<any>,
  dialect: Dialect = PostgresDialect,
  schemaOverride?: Record<string, ModelDef<any>>,
): SQLArtifact {
  const m = modelDef(node.model, modelOverride);
  const params: unknown[] = [];
  const table = dialect.quoteIdent(m.collection);
  const ctx: CompileCtx = { d: dialect, model: m, table, params, aliasCount: { n: 0 }, schemaOverride };
  const where = compileWhere(ctx, node.where);
  const whereClause = where ? `WHERE ${where}` : '';
  const limitClause = node.many
    ? whereClause
    : `WHERE ctid = (SELECT ctid FROM ${table}${where ? ' WHERE ' + where : ''} LIMIT 1)`;
  const finalWhere = node.many ? whereClause : limitClause;
  const sql = `DELETE FROM ${table} ${finalWhere} RETURNING *`;
  return { kind: 'sql', dialect: dialect.name, sql, params };
}

// Helper: collect column names from a where tree's eq leaves (used to guess
// the upsert ON CONFLICT target).
function whereLeafColumns(tree: WhereTree | undefined): string[] {
  if (!tree) return [];
  if (tree.kind === 'leaf' && tree.op === 'eq') return [tree.field];
  if (tree.kind === 'and') return tree.children.flatMap(whereLeafColumns);
  return [];
}

// Aggregation SELECT-list entries are aliased with a wire-stable name
// (`__agg_count_all`, `__agg_avg_age`, …) so the executor can reshape rows back
// into Prisma's nested `{ _count, _avg, … }` payload on the way out.
export function compileGroupBy(
  node: GroupByNode,
  modelOverride?: ModelDef<any>,
  dialect: Dialect = PostgresDialect,
  schemaOverride?: Record<string, ModelDef<any>>,
): SQLArtifact {
  const m = modelDef(node.model, modelOverride);
  const params: unknown[] = [];
  const table = dialect.quoteIdent(m.collection);
  const ctx: CompileCtx = { d: dialect, model: m, table, params, aliasCount: { n: 0 }, schemaOverride };

  const byCols = node.by.map((f) => `${table}.${dialect.quoteIdent(f)}`);

  const aggSelect: string[] = [];
  const pushAgg = (bucket: '_count' | '_avg' | '_sum' | '_min' | '_max', field: string, fn: string) => {
    const colExpr = field === '_all'
      ? '*'
      : `${table}.${dialect.quoteIdent(field)}`;
    const alias = `__agg_${bucket.slice(1)}_${field}`;
    aggSelect.push(`${fn}(${colExpr}) AS ${dialect.quoteIdent(alias)}`);
  };
  if (node._count) for (const [k, v] of Object.entries(node._count)) if (v) pushAgg('_count', k, 'COUNT');
  if (node._avg)   for (const [k, v] of Object.entries(node._avg))   if (v) pushAgg('_avg',   k, 'AVG');
  if (node._sum)   for (const [k, v] of Object.entries(node._sum))   if (v) pushAgg('_sum',   k, 'SUM');
  if (node._min)   for (const [k, v] of Object.entries(node._min))   if (v) pushAgg('_min',   k, 'MIN');
  if (node._max)   for (const [k, v] of Object.entries(node._max))   if (v) pushAgg('_max',   k, 'MAX');

  const selectList = [...byCols, ...aggSelect].join(', ');
  const where = compileWhere(ctx, node.where);
  const groupByClause = node.by.length ? `GROUP BY ${byCols.join(', ')}` : '';

  // having: Prisma's nested aggregation filter. We compile a small subset —
  // `{ _count: { id: { gt: 5 } } }` — to `HAVING COUNT(id) > $n`. Unsupported
  // shapes are silently ignored (returning `''`).
  const havingParts: string[] = [];
  if (node.having && typeof node.having === 'object') {
    for (const [bucket, inner] of Object.entries(node.having)) {
      const fnName = (({ _count: 'COUNT', _avg: 'AVG', _sum: 'SUM', _min: 'MIN', _max: 'MAX' }) as Record<string, string>)[bucket];
      if (!fnName || !inner || typeof inner !== 'object') continue;
      for (const [field, opObj] of Object.entries(inner as any)) {
        if (!opObj || typeof opObj !== 'object') continue;
        const colExpr = field === '_all' ? '*' : `${table}.${dialect.quoteIdent(field)}`;
        for (const [op, val] of Object.entries(opObj as Record<string, any>)) {
          const cmp = (({ gt: '>', gte: '>=', lt: '<', lte: '<=', equals: '=', not: '<>' }) as Record<string, string>)[op];
          if (!cmp) continue;
          havingParts.push(`${fnName}(${colExpr}) ${cmp} ${dialect.placeholder(params, val)}`);
        }
      }
    }
  }
  const havingClause = havingParts.length ? `HAVING ${havingParts.join(' AND ')}` : '';

  const orderClause = (() => {
    if (!node.orderBy?.length) return '';
    // Order by either a by-column or an aggregation alias — Prisma orders on
    // grouped fields by default, so we just emit `field DIR` and let PG
    // resolve it against the GROUP BY columns.
    return `ORDER BY ${node.orderBy.map((e) =>
      dialect.orderClause(`${table}.${dialect.quoteIdent(e.field)}`, e.direction, e.nulls),
    ).join(', ')}`;
  })();
  const limit = node.limit != null ? `LIMIT ${Number(node.limit)}` : '';
  const offset = node.offset != null ? `OFFSET ${Number(node.offset)}` : '';

  const sql = [
    `SELECT ${selectList} FROM ${table}`,
    where ? `WHERE ${where}` : '',
    groupByClause,
    havingClause,
    orderClause,
    limit,
    offset,
  ].filter(Boolean).join(' ');

  return { kind: 'sql', dialect: dialect.name, sql, params };
}
