import type {
  CountNode,
  DeleteNode,
  GroupByNode,
  InsertNode,
  OrderByEntry,
  ProjectionPlan,
  RowLockSpec,
  SelectNode,
  UpdateNode,
  WhereTree,
} from '../../ir/types';
import { COUNT_ALIAS_PREFIX, JSON_ORD_ALIAS, JSON_REL_ALIAS_PREFIX, PARTITION_ROW_ALIAS } from '../../ir/types';
import type { RelationPlan } from '../../ir/types';
import type { SQLArtifact } from '../../compile';
import type { FieldDef, ModelDef } from '../../schema/types';
import { rowLockSql } from '../row-lock';
import { schema } from '../../schema';
import { PostgresDialect, type Dialect } from './dialect';
import { multiPolygonBbox } from '../shared/wkt';
import { softDeleteField } from '../../ir/build/soft-delete';
import { hasFallbackGeo } from '../shared/haversine';

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
  // SQLite, a statement that reads every matching row (no LIMIT, no pinned
  // row): a positive owning `is` filter compiles to `fk IN (SELECT …)`.
  preferIn?: boolean;
  negated?: boolean;
}

// some <-> none, is <-> isNot, and NOT every(p) = some(NOT p).
function negateRelation(t: WhereTree): WhereTree | null {
  if (t.kind !== 'relation') return null;
  switch (t.mode) {
    case 'some': return { ...t, mode: 'none' };
    case 'none': return { ...t, mode: 'some' };
    case 'is': return { ...t, mode: 'isNot' };
    case 'isNot': return { ...t, mode: 'is' };
    case 'every': return t.nested ? { ...t, mode: 'some', nested: { kind: 'not', child: t.nested } } : null;
  }
  return null;
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
      // NOT of a relation filter is the opposite filter, so the planner gets a
      // plain EXISTS / NOT EXISTS it can turn into a semi- or anti-join:
      // `NOT (NOT EXISTS …)` was planned as a subplan per row, 25% slower.
      const flipped = negateRelation(tree.child);
      if (flipped) return compileWhereNode(ctx, flipped);
      if (tree.child.kind === 'not') return compileWhereNode(ctx, tree.child.child);
      const inner = compileWhereNode(ctx.negated ? ctx : { ...ctx, negated: true }, tree.child);
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
    case 'eq':
      if (leaf.value === null) return `${col} IS NULL`;
      // `mode: 'insensitive'` on equals (it used to be ignored). `=` on both
      // sides lowered, not a wildcard-free LIKE: an index on LOWER(col)
      // serves it, and it is what a hand-written query says.
      if (leaf.caseInsensitive && typeof leaf.value === 'string') return `LOWER(${col}) = LOWER(${ph(leaf.value)})`;
      return `${col} = ${ph(leaf.value)}`;
    case 'ne':
      if (leaf.value === null) return `${col} IS NOT NULL`;
      if (leaf.caseInsensitive && typeof leaf.value === 'string') return `LOWER(${col}) <> LOWER(${ph(leaf.value)})`;
      return `${col} <> ${ph(leaf.value)}`;
    /*
     * A `null` INSIDE THE LIST IS A MEMBER, NOT A COMPARISON.
     *
     * `{ loc: { in: ['L1', null] } }` means "L1, or not set" — which is what
     * it means on Mongo, where `$in` with a null member matches a null AND a
     * missing key. SQL has no such rule: `loc IN ('L1', NULL)` is `loc =
     * 'L1' OR loc = NULL`, and the second half is UNKNOWN rather than true,
     * so a row with no value matched nothing.
     *
     * Measured on the two engines with the same three rows — one 'L1', one
     * explicit null, one with the key absent:
     *
     *   Mongo     $in: ['L1', null]   →  all three
     *   Postgres  IN ('L1', NULL)     →  only the 'L1' row
     *
     * That is not a near-miss, it is a silently smaller answer. The idiom it
     * breaks is a common one: scoping rows to a branch while keeping the
     * org-wide ones that have no branch set. Every such query came back
     * missing all of its org-wide rows, with nothing raised.
     *
     * `notIn` is worse still. `loc NOT IN ('L1', NULL)` is UNKNOWN for every
     * row, including the ones that plainly are not 'L1', so the filter
     * matched NOTHING AT ALL rather than too little.
     *
     * So a null in either list is pulled out and asked about separately, with
     * the `IS NULL` form that is the only one SQL has.
     */
    case 'in': {
      const arr = leaf.value as unknown[];
      if (leaf.caseInsensitive && arr.length && arr.every((v) => typeof v === 'string')) {
        return `LOWER(${col}) IN (${arr.map((v) => `LOWER(${ph(v)})`).join(', ')})`;
      }
      // `in: []` matches nothing. Emitting `IN ()` would be a syntax error and
      // a bare `FALSE` is not valid T-SQL, so the literal comes from the dialect.
      if (!arr.length) return ctx.d.falseLiteral;
      const vals = arr.filter((v) => v !== null && v !== undefined);
      if (vals.length === arr.length) return `${col} IN (${vals.map(ph).join(', ')})`;
      // Only nulls were asked for.
      if (!vals.length) return `${col} IS NULL`;
      return `(${col} IN (${vals.map(ph).join(', ')}) OR ${col} IS NULL)`;
    }
    case 'nin': {
      const arr = leaf.value as unknown[];
      if (!arr.length) return ctx.d.trueLiteral;
      const vals = arr.filter((v) => v !== null && v !== undefined);
      if (vals.length === arr.length) return `${col} NOT IN (${vals.map(ph).join(', ')})`;
      if (!vals.length) return `${col} IS NOT NULL`;
      return `(${col} NOT IN (${vals.map(ph).join(', ')}) AND ${col} IS NOT NULL)`;
    }
    case 'lt':  return `${col} < ${ph(leaf.value)}`;
    case 'lte': return `${col} <= ${ph(leaf.value)}`;
    case 'gt':  return `${col} > ${ph(leaf.value)}`;
    case 'gte': return `${col} >= ${ph(leaf.value)}`;
    case 'contains':
      return likeOp(ctx, col, `%${escapeForLike(String(leaf.value))}%`, !!leaf.caseInsensitive, leaf.field);
    case 'startsWith':
      return likeOp(ctx, col, `${escapeForLike(String(leaf.value))}%`, !!leaf.caseInsensitive, leaf.field);
    case 'endsWith':
      return likeOp(ctx, col, `%${escapeForLike(String(leaf.value))}`, !!leaf.caseInsensitive, leaf.field);
    // A `json` / `embed` / `embedMany` field is `jsonb`, not a real array
    // column, and none of the array operators exist for it — see arrayFilter
    // in the dialect.
    case 'has':
      return ctx.d.arrayFilter('has', col, [leaf.value], ctx.params, isJsonField(ctx, leaf.field));
    case 'hasSome': {
      const arr = leaf.value as unknown[];
      if (!arr.length) return ctx.d.falseLiteral;
      return ctx.d.arrayFilter('hasSome', col, arr, ctx.params, isJsonField(ctx, leaf.field));
    }
    case 'hasEvery': {
      const arr = leaf.value as unknown[];
      if (!arr.length) return ctx.d.trueLiteral;
      return ctx.d.arrayFilter('hasEvery', col, arr, ctx.params, isJsonField(ctx, leaf.field));
    }
    case 'isEmpty': {
      const empty = ctx.d.arrayFilter('isEmpty', col, [], ctx.params, isJsonField(ctx, leaf.field));
      return leaf.value ? empty : `NOT (${empty})`;
    }
    case 'search': {
      const sctx = {
        rawColumn: leaf.field,
        baseTable: ctx.model.collection,
        quoteIdent: (s: string) => ctx.d.quoteIdent(s),
      };
      if (ctx.d.searchExpr) {
        const pk = Object.entries(ctx.model.fields).find(([, fd]) => (fd as FieldDef).kind === 'id')?.[0] ?? 'id';
        return ctx.d.searchExpr(col, { ...sctx, term: String(leaf.value), primaryKey: pk, placeholder: ph });
      }
      return ctx.d.searchClause(col, ph(String(leaf.value)), sctx);
    }
    case 'jsonPath': {
      if (!leaf.jsonPath) return ctx.d.trueLiteral;
      const { path, subOp } = leaf.jsonPath;
      const rawCol = `${ctx.table}.${ctx.d.quoteIdent(leaf.field)}`;
      const rendered = ctx.d.jsonPathExpr
        ? ctx.d.jsonPathExpr(rawCol, path, leaf.value, ctx.params, subOp)
        : pgJsonPath(rawCol, path, leaf.value);
      // Compare the extracted value against the user-supplied operand using
      // the same operator vocabulary as scalar leaves.
      const ph = (v: unknown) => ctx.d.placeholder(ctx.params, v);
      switch (subOp) {
        case 'eq':
          if (leaf.value === null) return `${rendered} IS NULL`;
          if (leaf.caseInsensitive && typeof leaf.value === 'string') return `LOWER(${rendered}) = LOWER(${ph(leaf.value)})`;
          return `${rendered} = ${ph(coerceJsonOperand(leaf.value))}`;
        case 'ne':
          if (leaf.value === null) return `${rendered} IS NOT NULL`;
          if (leaf.caseInsensitive && typeof leaf.value === 'string') return `LOWER(${rendered}) <> LOWER(${ph(leaf.value)})`;
          return `${rendered} <> ${ph(coerceJsonOperand(leaf.value))}`;
        case 'lt':  return `${rendered} < ${ph(coerceJsonOperand(leaf.value))}`;
        case 'lte': return `${rendered} <= ${ph(coerceJsonOperand(leaf.value))}`;
        case 'gt':  return `${rendered} > ${ph(coerceJsonOperand(leaf.value))}`;
        case 'gte': return `${rendered} >= ${ph(coerceJsonOperand(leaf.value))}`;
        case 'contains': {
          // `likeOp`, not a bare LIKE: a path `contains` has to honour
          // `mode: 'insensitive'` exactly as the scalar form does, or a
          // case-insensitive search inside a json blob silently matches
          // only the case it was given.
          const v = String(leaf.value);
          return likeOp(ctx, rendered, `%${escapeForLike(v)}%`, !!leaf.caseInsensitive);
        }
        case 'in': {
          const arr = leaf.value as unknown[];
          if (leaf.caseInsensitive && arr.length && arr.every((v) => typeof v === 'string')) {
            // One mention of `rendered`: on positional-parameter dialects its
            // bound path would otherwise need re-binding for every value.
            return `LOWER(${rendered}) IN (${arr.map((v) => `LOWER(${ph(v)})`).join(', ')})`;
          }
          if (!arr.length) return ctx.d.falseLiteral;
          return `${rendered} IN (${arr.map((v) => ph(coerceJsonOperand(v))).join(', ')})`;
        }
        case 'has': {
          // Array containment — the extracted value is itself a JSON array.
          // Cheapest cross-dialect: cast to text + LIKE on the JSON repr.
          return `${rendered}::text LIKE ${ph('%' + JSON.stringify(leaf.value) + '%')}`;
        }
      }
      return ctx.d.trueLiteral;
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
  const lngCol = jsonNumber(ctx, field, 'lng');
  const latCol = jsonNumber(ctx, field, 'lat');
  return `(${lngCol} BETWEEN ${ph(minLng)} AND ${ph(maxLng)} AND ` +
         `${latCol} BETWEEN ${ph(minLat)} AND ${ph(maxLat)})`;
}

// A number read out of a fallback geoPoint's JSON. `->>` and `::float8` are
// Postgres (DuckDB speaks them too); SQLite and SQL Server have their own.
function jsonNumber(ctx: CompileCtx, field: string, key: 'lng' | 'lat'): string {
  const col = `${ctx.table}.${ctx.d.quoteIdent(field)}`;
  return ctx.d.jsonNumberExpr ? ctx.d.jsonNumberExpr(col, key) : `(${col}->>'${key}')::float8`;
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
  const lngCol = jsonNumber(ctx, field, 'lng');
  const latCol = jsonNumber(ctx, field, 'lat');
  return `(${lngCol} BETWEEN ${ph(point.lng - lngDeg)} AND ${ph(point.lng + lngDeg)} AND ` +
         `${latCol} BETWEEN ${ph(point.lat - latDeg)} AND ${ph(point.lat + latDeg)})`;
}

function likeOp(ctx: CompileCtx, col: string, pattern: string, ci: boolean, field?: string): string {
  const ph = ctx.d.placeholder(ctx.params, pattern);
  // ILIKE is Postgres-only; every other dialect gets its own form.
  const sql = ci ? ctx.d.caseInsensitiveLike(col, ph, field != null && hasInvertedIndex(ctx.model, field)) : `${col} LIKE ${ph}`;
  // escapeForLike() uses a backslash. Postgres and MySQL take that as the
  // default escape; SQLite, DuckDB and SQL Server have none, so there a
  // searched `_` or `%` was compared as `\_` and matched nothing.
  return ctx.d.likeEscapeClause ? `${sql}${ctx.d.likeEscapeClause}` : sql;
}

// A GIN / GiST index on the column (a pg_trgm index, typically) serves ILIKE
// but not lower(col) LIKE, so such a column keeps ILIKE.
const invertedIndexCache = new WeakMap<object, Set<string>>();
function hasInvertedIndex(model: ModelDef<any>, field: string): boolean {
  let set = invertedIndexCache.get(model);
  if (!set) {
    set = new Set();
    for (const ix of (model as any).indexes ?? []) {
      if (ix?.method !== 'gin' && ix?.method !== 'gist') continue;
      for (const k of Object.keys(ix.keys ?? {})) set.add(k);
      if (typeof ix.expression === 'string') {
        for (const name of Object.keys(model.fields)) if (ix.expression.includes(name)) set.add(name);
      }
    }
    invertedIndexCache.set(model, set);
  }
  return set.has(field);
}

function compileRelationFilter(
  ctx: CompileCtx,
  tree: Extract<WhereTree, { kind: 'relation' }>,
): string {
  const relations = ctx.model.relations();
  const rel = relations[tree.relation];
  if (!rel) return ctx.d.trueLiteral;
  const targetModel =
    ctx.schemaOverride?.[rel.target] ??
    ((schema as any)[rel.target] as ModelDef<any> | undefined);
  if (!targetModel) return ctx.d.trueLiteral;

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
  // The soft-delete scope goes on the JOIN condition, not into `nested`.
  // It has to: `every` compiles to NOT EXISTS of the NEGATED inner condition,
  // so a scope folded into `nested` would be negated with it and `every`
  // would come to mean "every related row is live AND matches" — failing for
  // any parent that has ever deleted a child. On the join condition it
  // restricts which rows the subquery considers, which is right for all five
  // modes.
  const sd = tree.withDeleted ? undefined : softDeleteField(targetModel);
  const scopeClause = sd ? ` AND ${aliasQ}.${ctx.d.quoteIdent(sd)} IS NULL` : '';
  const joinCondition =
    `${aliasQ}.${ctx.d.quoteIdent(targetCol)} = ${ctx.table}.${ctx.d.quoteIdent(parentCol)}` +
    scopeClause;

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

  // SQLite runs a correlated EXISTS once per outer row, while an uncorrelated
  // IN list is built once: on a statement that reads every matching row
  // (count, groupBy, updateMany, an unpaged findMany) that is 7x to 80x
  // faster. Under a LIMIT, or for a pinned row, EXISTS stops early and wins,
  // so it stays there. Only the positive owning `is`: under NOT, a NULL key
  // makes `NOT (fk IN …)` unknown where NOT EXISTS is true.
  if (ctx.preferIn && !ctx.negated && isOwning && tree.mode === 'is') {
    const where = [scopeClause.replace(/^ AND /, ''), inner].filter(Boolean).join(' AND ');
    return `${ctx.table}.${ctx.d.quoteIdent(parentCol)} IN (SELECT ${aliasQ}.${ctx.d.quoteIdent(targetCol)} FROM ${subTable} ${aliasQ}${where ? ` WHERE ${where}` : ''})`;
  }

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

// `_count: { posts: true }` as a correlated subquery per relation, in the
// parent's own SELECT: one round trip instead of one grouped query per
// relation. Soft-deleted children are excluded so the count agrees with what
// `include` hands back.
function compileRelationCountCols(ctx: CompileCtx, counts: string[] | undefined): string {
  return relationCountExprs(ctx, counts)
    .map(([key, expr]) => `${expr} AS ${ctx.d.quoteIdent(key)}`)
    .join(', ');
}

// `[alias, (SELECT COUNT(*) …)]` per counted relation.
function relationCountExprs(ctx: CompileCtx, counts: string[] | undefined): Array<[string, string]> {
  if (!counts?.length) return [];
  const relations = ctx.model.relations();
  const out: Array<[string, string]> = [];
  for (const relName of counts) {
    const rel = relations[relName];
    if (!rel) continue;
    const target =
      ctx.schemaOverride?.[rel.target] ?? ((schema as any)[rel.target] as ModelDef<any> | undefined);
    if (!target) continue;
    ctx.aliasCount.n += 1;
    const alias = ctx.d.quoteIdent(`c${ctx.aliasCount.n}`);
    const sd = softDeleteField(target);
    const where =
      `${alias}.${ctx.d.quoteIdent(rel.on)} = ${ctx.table}.${ctx.d.quoteIdent(rel.refs)}` +
      (sd ? ` AND ${alias}.${ctx.d.quoteIdent(sd)} IS NULL` : '');
    out.push([COUNT_ALIAS_PREFIX + relName, `(SELECT COUNT(*) FROM ${ctx.d.quoteIdent(target.collection)} ${alias} WHERE ${where})`]);
  }
  return out;
}

// ─── MySQL: a relation as JSON in the parent's SELECT ───────────────────────
//
//   (SELECT COALESCE(JSON_ARRAYAGG(JSON_OBJECT('id', t.id, …, '__forge_ord', JSON_ARRAY(t.k0, …))), JSON_ARRAY())
//      FROM (SELECT j1.id, …, HEX(WEIGHT_STRING(j1.title)) AS k0 FROM posts j1
//            WHERE j1.author_id = users.id AND … ORDER BY … LIMIT n) t)
//
// JSON_ARRAYAGG takes no ORDER BY and promises no order, so each object
// carries its sort key and the executor sorts. A string key is sent as the
// collation's own weight (WEIGHT_STRING), so the client sorts exactly as the
// server would; numbers and DATETIME text sort as they are. A derived table
// that reads its parent's columns needs MySQL 8.0.14; the executor turns
// this on only for MySQL (not MariaDB) at that version or later, and only
// for the relations it decided to (planMysqlIncludes).

const MYSQL_JSON_KINDS = new Set([
  'id', 'objectId', 'string', 'text', 'int', 'float', 'uuid', 'bool',
  'dateTime', 'json', 'enum', 'embed', 'embedMany', 'stringArray', 'intArray',
]);
const MYSQL_SORT_KINDS = new Set(['id', 'objectId', 'string', 'text', 'int', 'float', 'uuid', 'bool', 'dateTime', 'enum']);
const MYSQL_TEXT_SORT = new Set(['id', 'objectId', 'string', 'text', 'uuid', 'enum']);
export const MYSQL_ORD_KEY = '__forge_ord';

function mysqlJsonField(fd: FieldDef | undefined, sort = false): boolean {
  if (!fd) return false;
  if (fd.kind === 'id' && (fd as any).idType === 'bigserial') return false;
  return (sort ? MYSQL_SORT_KINDS : MYSQL_JSON_KINDS).has(fd.kind);
}

/** Whether `rel` (and everything below it) can be loaded as JSON on MySQL. */
export function mysqlJsonEligible(
  parent: ModelDef<any>,
  rel: RelationPlan,
  schemaOverride?: Record<string, ModelDef<any>>,
): boolean {
  const target = relTarget(rel, schemaOverride);
  if (!target) return false;
  const n = (rel.nested ?? {}) as Partial<SelectNode>;
  if (n.distinct?.length || n.cursor || n.lock || n.partitionBy) return false;
  if (n.orderBy?.some((e) => e.nearTo || e.agg || e.nulls || !mysqlJsonField(target.fields[e.field] as FieldDef, true))) return false;
  if (rel.kind === 'one' && (n.limit != null || n.offset != null || n.orderBy?.length)) return false;
  if (n.offset != null && n.limit == null) return false;
  if (hasGeoOp(n.where)) return false;
  const owning = rel.kind === 'one' && parent.fields[rel.on] != null;
  if (owning ? target.fields[rel.refs] == null : target.fields[rel.on] == null) return false;
  for (const f of selectedFields(target, n.projection)) {
    if (!mysqlJsonField(target.fields[f] as FieldDef)) return false;
  }
  return (n.hydration ?? []).every((h) => mysqlJsonEligible(target, h, schemaOverride));
}

function compileMysqlJsonRelation(ctx: CompileCtx, rel: RelationPlan): string {
  const d = ctx.d;
  const target = relTarget(rel, ctx.schemaOverride)!;
  const n = (rel.nested ?? {}) as Partial<SelectNode>;
  ctx.aliasCount.n += 1;
  const alias = d.quoteIdent(`j${ctx.aliasCount.n}`);
  const sub: CompileCtx = { ...ctx, model: target, table: alias };

  const pairs: Array<[string, string]> = selectedFields(target, n.projection).map((f) => [f, `${alias}.${d.quoteIdent(f)}`]);
  pairs.push(...relationCountExprs(sub, n.projection?.counts));
  for (const h of n.hydration ?? []) pairs.push([JSON_REL_ALIAS_PREFIX + h.name, compileMysqlJsonRelation(sub, h)]);

  const owning = rel.kind === 'one' && ctx.model.fields[rel.on] != null;
  const join = owning
    ? `${alias}.${d.quoteIdent(rel.refs)} = ${ctx.table}.${d.quoteIdent(rel.on)}`
    : `${alias}.${d.quoteIdent(rel.on)} = ${ctx.table}.${d.quoteIdent(rel.refs)}`;
  const w = compileWhere(sub, n.where);
  const where = `WHERE ${join}${w ? ` AND ${w}` : ''}`;
  const from = `FROM ${d.quoteIdent(target.collection)} ${alias}`;
  const key = (k: string) => `'${k.replace(/'/g, "''")}'`;

  if (rel.kind === 'one') {
    return `(SELECT JSON_OBJECT(${pairs.map(([k, e]) => `${key(k)}, ${e}`).join(', ')}) ${from} ${where} LIMIT 1)`;
  }
  const order = compileOrder(d, alias, n.orderBy, target);
  if (!order && n.limit == null) {
    return `(SELECT COALESCE(JSON_ARRAYAGG(JSON_OBJECT(${pairs.map(([k, e]) => `${key(k)}, ${e}`).join(', ')})), JSON_ARRAY()) ${from} ${where})`;
  }
  const t = d.quoteIdent('t');
  const inner = pairs.map(([k, e]) => `${e} AS ${d.quoteIdent(k)}`);
  const sortKeys: string[] = [];
  for (const [i, e] of (n.orderBy ?? []).entries()) {
    const col = `${alias}.${d.quoteIdent(e.field)}`;
    const k = `__forge_k${i}`;
    inner.push(`${MYSQL_TEXT_SORT.has((target.fields[e.field] as FieldDef).kind) ? `HEX(WEIGHT_STRING(${col}))` : col} AS ${d.quoteIdent(k)}`);
    sortKeys.push(`${t}.${d.quoteIdent(k)}`);
  }
  const page = n.limit != null
    ? `LIMIT ${Math.max(0, Math.trunc(Number(n.limit)))}${n.offset != null ? ` OFFSET ${Math.max(0, Math.trunc(Number(n.offset)))}` : ''}`
    : '';
  const sql = [`SELECT ${inner.join(', ')} ${from}`, where, order, page].filter(Boolean).join(' ');
  const obj = pairs.map(([k]) => `${key(k)}, ${t}.${d.quoteIdent(k)}`);
  if (sortKeys.length) obj.push(`${key(MYSQL_ORD_KEY)}, JSON_ARRAY(${sortKeys.join(', ')})`);
  return `(SELECT COALESCE(JSON_ARRAYAGG(JSON_OBJECT(${obj.join(', ')})), JSON_ARRAY()) FROM (${sql}) ${t})`;
}

// ─── Includes inside the parent's SELECT (Postgres) ──────────────────────────
//
// A relation whose rows JSON can carry without loss is loaded by a correlated
// subquery in the parent's own select list, so a three-level include is one
// round trip instead of four:
//
//   (SELECT coalesce(json_agg(t ORDER BY t."__forge_ord"), '[]'::json) FROM (
//      SELECT j1.<cols>, <its own nested relations>, ROW_NUMBER() OVER (ORDER BY …) AS "__forge_ord"
//      FROM posts j1 WHERE j1.author_id = users.id AND <nested where> ORDER BY … LIMIT n OFFSET m
//   ) t) AS "__forge_rel_posts"
//
// The ROW_NUMBER carries the include's order through json_agg, which would
// otherwise only usually keep it. 64-bit integers and numerics are sent as
// text (a JSON number would round them); timestamps arrive as ISO text and are
// decoded by the executor. A relation holding bytes, geography or vector
// columns, or using distinct / cursor / a distance sort, keeps the query per
// level.

const JSON_SAFE_KINDS = new Set([
  'id', 'objectId', 'string', 'text', 'int', 'float', 'decimal', 'uuid', 'bigint', 'bool',
  'dateTime', 'json', 'enum', 'embed', 'embedMany', 'stringArray', 'intArray',
]);

function relTarget(rel: RelationPlan, schemaOverride?: Record<string, ModelDef<any>>): ModelDef<any> | undefined {
  return schemaOverride?.[rel.target] ?? ((schema as any)[rel.target] as ModelDef<any> | undefined);
}

export function selectedFields(model: ModelDef<any>, plan: ProjectionPlan | undefined): string[] {
  const all = Object.keys(model.fields);
  if (!plan) return all;
  if (plan.exclusive && plan.fields.length) return plan.fields.filter((f) => model.fields[f] != null);
  if (plan.omit?.length) { const drop = new Set(plan.omit); return all.filter((f) => !drop.has(f)); }
  return all;
}

/** Whether `rel` (and everything it includes) can be loaded as JSON in the parent's SELECT. */
export function jsonRelationEligible(
  parent: ModelDef<any>,
  rel: RelationPlan,
  schemaOverride?: Record<string, ModelDef<any>>,
): boolean {
  if ((rel as { json?: boolean }).json === false) return false;
  const target = relTarget(rel, schemaOverride);
  if (!target) return false;
  const n = (rel.nested ?? {}) as Partial<SelectNode>;
  if (n.distinct?.length || n.cursor || n.lock || n.partitionBy) return false;
  if (n.orderBy?.some((e) => e.nearTo || e.agg)) return false;
  if (rel.kind === 'one' && (n.limit != null || n.offset != null)) return false;
  if (hasGeoOp(n.where)) return false;
  const owning = rel.kind === 'one' && parent.fields[rel.on] != null;
  if (owning ? target.fields[rel.refs] == null : target.fields[rel.on] == null) return false;
  for (const f of selectedFields(target, n.projection)) {
    if (!JSON_SAFE_KINDS.has((target.fields[f] as FieldDef).kind)) return false;
  }
  return (n.hydration ?? []).every((h) => jsonRelationEligible(target, h, schemaOverride));
}

// ─── Which includes load as JSON (one statement) and which per level ───────
//
// Measured on the bench database (bench/micro/include-plans.ts, docs/N-PLUS-ONE.md):
// JSON wins whenever the number of related rows it has to build is small, and
// always for a paged include (`take` on the relation), whose per-level form
// needs a window over every candidate row. It loses, by up to 2x, once it
// builds hundreds of rows for an UNPAGED to-many include, and past a few dozen
// parents for a to-one, where one `IN` query is cheaper than a correlated
// lookup per parent. The limits are fixed: a round trip measured from the
// client counts the client's and the server's own load as well as the wire,
// and a plan that followed it flipped to JSON on a busy machine, where it was
// the slower one.

/** The parents a query can return: 1, its `take`, or unknown (Infinity). */
function parentBound(node: { cardinality?: string; limit?: number; partitionBy?: string }): number {
  if (node.cardinality === 'one') return 1;
  // A limit per parent of the level above bounds nothing overall.
  if (node.partitionBy) return Infinity;
  return node.limit != null && Number.isFinite(Number(node.limit)) ? Math.max(0, Number(node.limit)) : Infinity;
}

interface IncludeShape { unpagedManyDepth: number; pagedMany: boolean; oneUnderMany: boolean; one: boolean }

function includeShape(rel: RelationPlan, underMany: boolean, depth: number, acc: IncludeShape): void {
  const n = (rel.nested ?? {}) as Partial<SelectNode>;
  const many = rel.kind === 'many';
  if (many && n.limit == null) acc.unpagedManyDepth = Math.max(acc.unpagedManyDepth, depth + 1);
  if (many && n.limit != null) acc.pagedMany = true;
  if (!many) { acc.one = true; if (underMany) acc.oneUnderMany = true; }
  for (const h of n.hydration ?? []) includeShape(h, underMany || many, many && n.limit == null ? depth + 1 : depth, acc);
}

let forcedPlan: 'json' | 'batched' | undefined;
/** Bench hook: force every include onto one plan; `undefined` restores the rule. */
export function forcePgIncludePlan(plan: 'json' | 'batched' | undefined): void { forcedPlan = plan; }

/** Whether a relation the compiler COULD load as JSON should be. */
export function preferJsonInclude(parents: number, rel: RelationPlan): boolean {
  if (forcedPlan) return forcedPlan === 'json';
  const acc: IncludeShape = { unpagedManyDepth: 0, pagedMany: false, oneUnderMany: false, one: false };
  includeShape(rel, false, 0, acc);
  if (acc.unpagedManyDepth >= 2) return parents <= 5;
  if (acc.unpagedManyDepth === 1) return parents <= 50;
  if (acc.pagedMany) return acc.oneUnderMany ? parents <= 100 : true;
  return parents <= 25;
}

/**
 * Settle, per include of this node, JSON or a query per level, and record it
 * on the node (`json: false` on the relation) so the compiler, the executor
 * and the compile cache all see the same answer. Relations below a JSON one
 * are part of its statement; relations below a per-level one decide again
 * when their own level runs.
 */
export function planPgIncludes<N extends { hydration?: RelationPlan[]; cardinality?: string; limit?: number }>(
  node: N, model: ModelDef<any>,
): N {
  const h = node.hydration;
  if (!h?.length) return node;
  const parents = parentBound(node);
  // A page per parent filters rows after the select list is computed, so a
  // JSON column there would be built for every candidate row.
  const partitioned = !!(node as { partitionBy?: string }).partitionBy;
  let changed: RelationPlan[] | undefined;
  for (let i = 0; i < h.length; i++) {
    const rel = h[i];
    if ((rel as { json?: boolean }).json !== undefined || !jsonRelationEligible(model, rel)) continue;
    changed ??= h.slice();
    changed[i] = { ...rel, json: !partitioned && preferJsonInclude(parents, rel) } as RelationPlan;
  }
  return changed ? { ...node, hydration: changed } : node;
}

function hasGeoOp(w: WhereTree | undefined): boolean {
  if (!w) return false;
  switch (w.kind) {
    case 'leaf': return w.op === 'near' || w.op === 'withinPolygon';
    case 'and': case 'or': return w.children.some(hasGeoOp);
    case 'not': return hasGeoOp(w.child);
    default: return false;
  }
}

function jsonColumnExpr(d: Dialect, table: string, name: string, fd: FieldDef): string {
  const col = `${table}.${d.quoteIdent(name)}`;
  const wide = fd.kind === 'bigint' || fd.kind === 'decimal' || (fd.kind === 'id' && (fd as any).idType === 'bigserial');
  return wide ? `${col}::text AS ${d.quoteIdent(name)}` : col;
}

function compileJsonRelationCols(ctx: CompileCtx, hydration: RelationPlan[] | undefined): string {
  if (!hydration?.length) return '';
  if (ctx.d.name === 'mysql') {
    // MySQL loads a relation as JSON only when the executor chose to.
    const cols: string[] = [];
    for (const rel of hydration) {
      if ((rel as { json?: boolean }).json !== true || !mysqlJsonEligible(ctx.model, rel, ctx.schemaOverride)) continue;
      cols.push(`${compileMysqlJsonRelation(ctx, rel)} AS ${ctx.d.quoteIdent(JSON_REL_ALIAS_PREFIX + rel.name)}`);
    }
    return cols.join(', ');
  }
  if (ctx.d.name !== 'postgres') return '';
  const cols: string[] = [];
  for (const rel of hydration) {
    if (!jsonRelationEligible(ctx.model, rel, ctx.schemaOverride)) continue;
    cols.push(`${compileJsonRelation(ctx, rel)} AS ${ctx.d.quoteIdent(JSON_REL_ALIAS_PREFIX + rel.name)}`);
  }
  return cols.join(', ');
}

function compileJsonRelation(ctx: CompileCtx, rel: RelationPlan): string {
  const d = ctx.d;
  const target = relTarget(rel, ctx.schemaOverride)!;
  const n = (rel.nested ?? {}) as Partial<SelectNode>;
  ctx.aliasCount.n += 1;
  const alias = d.quoteIdent(`j${ctx.aliasCount.n}`);
  const sub: CompileCtx = { ...ctx, model: target, table: alias };

  const parts = selectedFields(target, n.projection).map((f) => jsonColumnExpr(d, alias, f, target.fields[f] as FieldDef));
  const counts = compileRelationCountCols(sub, n.projection?.counts);
  if (counts) parts.push(counts);
  const nestedRels = compileJsonRelationCols(sub, n.hydration);
  if (nestedRels) parts.push(nestedRels);

  const owning = rel.kind === 'one' && ctx.model.fields[rel.on] != null;
  const join = owning
    ? `${alias}.${d.quoteIdent(rel.refs)} = ${ctx.table}.${d.quoteIdent(rel.on)}`
    : `${alias}.${d.quoteIdent(rel.on)} = ${ctx.table}.${d.quoteIdent(rel.refs)}`;
  const w = compileWhere(sub, n.where);
  const where = `WHERE ${join}${w ? ` AND ${w}` : ''}`;
  const order = compileOrder(d, alias, n.orderBy, target);

  if (rel.kind === 'one') {
    const inner = `SELECT ${parts.join(', ')} FROM ${d.quoteIdent(target.collection)} ${alias} ${where} LIMIT 1`;
    return `(SELECT row_to_json(${d.quoteIdent('t')}) FROM (${inner}) ${d.quoteIdent('t')})`;
  }
  const ord = d.quoteIdent(JSON_ORD_ALIAS);
  const t = d.quoteIdent('t');
  // The aggregate sorts by the include's own columns when they are all in
  // the row; a ROW_NUMBER carries the order otherwise.
  const selected = new Set(selectedFields(target, n.projection));
  const byColumns = !!order && (n.orderBy ?? []).every((e) => selected.has(e.field));
  if (order && !byColumns) parts.push(`ROW_NUMBER() OVER (${order}) AS ${ord}`);
  const page = [
    n.limit != null ? `LIMIT ${Number(n.limit)}` : '',
    n.offset != null ? `OFFSET ${Number(n.offset)}` : '',
  ].filter(Boolean).join(' ');
  const inner = [`SELECT ${parts.join(', ')} FROM ${d.quoteIdent(target.collection)} ${alias}`, where, order, page]
    .filter(Boolean).join(' ');
  const agg = !order ? `json_agg(${t})`
    : byColumns ? `json_agg(${t} ${compileOrder(d, t, n.orderBy, target)})`
      : `json_agg(${t} ORDER BY ${t}.${ord})`;
  return `(SELECT coalesce(${agg}, '[]'::json) FROM (${inner}) ${t})`;
}

function notEmpty(s: string): boolean {
  return s.length > 0;
}

// The column list is the same string for every query of one shape, and on a
// point lookup building it was the largest single cost of compiling.
const projectionCache = new WeakMap<object, Map<string, string>>();

function compileProjectionCols(
  d: Dialect,
  table: string,
  model: ModelDef<any>,
  plan: ProjectionPlan | undefined,
): string {
  const key = `${d.name}|${table}|${!plan ? '*' : plan.exclusive && plan.fields.length ? `s:${plan.fields.join(',')}` : plan.omit?.length ? `o:${plan.omit.join(',')}` : '*'}`;
  let byModel = projectionCache.get(model);
  if (!byModel) { byModel = new Map(); projectionCache.set(model, byModel); }
  let cols = byModel.get(key);
  if (cols === undefined) {
    cols = buildProjectionCols(d, table, model, plan);
    if (byModel.size < 512) byModel.set(key, cols);
  }
  return cols;
}

function buildProjectionCols(
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
    // An aggregate order is only meaningful on a groupBy; a plain select has
    // no such column to sort by.
    if (e.agg) return null;
    return d.orderClause(`${table}.${d.quoteIdent(e.field)}`, e.direction, e.nulls);
  }).filter((p): p is string => p !== null);
  if (!parts.length) return '';
  return `ORDER BY ${parts.join(', ')}`;
}

// A cursor is "everything that sorts AFTER this row", so which comparison
// keeps a row depends on the direction the query sorts that column. Emitting
// `>` unconditionally — as this did before 2.18.0 — silently returns the
// wrong page for the single most common feed query there is
// (`orderBy: { createdAt: 'desc' }`): it asks for rows GREATER than the last
// row seen while walking downwards, so page 2 re-serves the rows before it.
function compileCursor(
  d: Dialect,
  table: string,
  params: unknown[],
  cursor: SelectNode['cursor'],
  orderBy: SelectNode['orderBy'],
): string {
  if (!cursor?.fields) return '';
  const keys = Object.keys(cursor.fields);
  if (keys.length === 0) return '';

  // A cursor key absent from orderBy has no declared direction; ascending is
  // the same assumption the ORDER BY builder makes for a bare field.
  const descending = (k: string) =>
    orderBy?.find((e) => e.field === k)?.direction === 'desc';
  const cmp = (k: string) => (descending(k) ? '<' : '>');
  const col = (k: string) => `${table}.${d.quoteIdent(k)}`;
  const val = (k: string) => d.placeholder(params, cursor.fields![k]);

  if (keys.length === 1) return `${col(keys[0])} ${cmp(keys[0])} ${val(keys[0])}`;

  // Uniform direction → row-value comparison, which an index on the same
  // columns can satisfy with one range scan. T-SQL has no such form, so it
  // takes the OR expansion below instead of emitting SQL it cannot parse.
  if (d.rowValueComparison !== false && new Set(keys.map(descending)).size === 1) {
    const cols = keys.map(col).join(', ');
    const vals = keys.map(val).join(', ');
    return `(${cols}) ${cmp(keys[0])} (${vals})`;
  }

  // Mixed directions (`{ score: 'desc' }, { id: 'asc' }`) cannot be a row
  // comparison — `(a, b) > (x, y)` applies ONE operator to the whole tuple.
  // Expand lexicographically instead:
  //   (a < x) OR (a = x AND b > y) OR (a = x AND b = y AND c < z) …
  const terms = keys.map((k, i) => {
    const clauses = keys.slice(0, i).map((prev) => `${col(prev)} = ${val(prev)}`);
    clauses.push(`${col(k)} ${cmp(k)} ${val(k)}`);
    return `(${clauses.join(' AND ')})`;
  });
  return `(${terms.join(' OR ')})`;
}

export function compileSelect(
  node: SelectNode,
  modelOverride?: ModelDef<any>,
  dialect: Dialect = PostgresDialect,
  schemaOverride?: Record<string, ModelDef<any>>,
): SQLArtifact {
  const m = modelDef(node.model, modelOverride);
  // Each dialect that borrows this compiler spells a row lock its own way
  // (MSSQL as a table hint), or refuses it — never emitted as foreign SQL.
  const lockSql = node.lock ? rowLockSql(dialect.name, node.lock) : { hint: '', tail: '' };
  const params: unknown[] = [];
  const table = dialect.quoteIdent(m.collection);
  const ctx: CompileCtx = {
    d: dialect, model: m, table, params, aliasCount: { n: 0 }, schemaOverride,
    preferIn: dialect.name === 'sqlite' && node.limit == null && !node.partitionBy && !pinsOneRow(m, node.where),
  };

  let cols = compileProjectionCols(dialect, table, m, node.projection);
  const counts = compileRelationCountCols(ctx, node.projection?.counts);
  if (counts) cols = `${cols}, ${counts}`;
  const rels = compileJsonRelationCols(ctx, node.hydration);
  if (rels) cols = `${cols}, ${rels}`;
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
      // Quoted: unquoted, Postgres folds it to `_distancemeters` and the
      // ORDER BY "_distanceMeters" below names a column that does not exist.
      cols = `${cols}, ${distExpr} AS ${dialect.quoteIdent('_distanceMeters')}`;
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
  const c = compileCursor(dialect, table, params, node.cursor, node.orderBy);
  if (c) whereParts.push(c);
  const whereClause = whereParts.length ? `WHERE ${whereParts.join(' AND ')}` : '';

  const orderClause = compileOrder(dialect, table, node.orderBy, m);

  if (node.partitionBy && (node.limit != null || node.offset != null)) {
    const sql = compilePartitionedPage(dialect, table, cols, whereClause, orderClause, node);
    return { kind: 'sql', dialect: dialect.name, sql, params };
  }

  // A fallback geo query is paged by the executor after the exact distance
  // pass (refineFallbackGeo); a LIMIT here would keep arbitrary bbox rows.
  const geoPaged = hasFallbackGeo(node, m);
  const limit = node.limit != null && !geoPaged ? `LIMIT ${Number(node.limit)}` : '';
  const offset = node.offset != null && !geoPaged ? `OFFSET ${Number(node.offset)}` : '';

  const sql = [
    `SELECT ${distinctClause}${cols} FROM ${table}${lockSql.hint}`,
    whereClause, orderClause, limit, offset, lockSql.tail,
  ].filter(Boolean).join(' ');

  return { kind: 'sql', dialect: dialect.name, sql, params };
}

// A page per parent in one statement:
//
//   SELECT * FROM (
//     SELECT <cols>, ROW_NUMBER() OVER (PARTITION BY fk ORDER BY <orderBy>) AS __forge_rn
//     FROM child WHERE fk IN (…) AND <nested where>
//   ) p WHERE __forge_rn > offset AND __forge_rn <= offset + limit ORDER BY __forge_rn
//
// The outer ORDER BY keeps each parent's rows in their window order; rows of
// different parents interleave, which the loader's grouping does not mind.
function compilePartitionedPage(
  d: Dialect,
  table: string,
  cols: string,
  whereClause: string,
  orderClause: string,
  node: SelectNode,
): string {
  const rn = d.quoteIdent(PARTITION_ROW_ALIAS);
  // T-SQL refuses ROW_NUMBER() without an ORDER BY; the others number in scan order.
  const over = orderClause || (d.name === 'mssql' ? 'ORDER BY (SELECT NULL)' : '');
  const inner = [
    `SELECT ${cols}, ROW_NUMBER() OVER (PARTITION BY ${table}.${d.quoteIdent(node.partitionBy!)}` +
      `${over ? ' ' + over : ''}) AS ${rn} FROM ${table}`,
    whereClause,
  ].filter(Boolean).join(' ');
  const skip = Math.max(0, Math.trunc(Number(node.offset ?? 0)));
  const bounds: string[] = [];
  if (skip > 0) bounds.push(`${rn} > ${skip}`);
  if (node.limit != null) bounds.push(`${rn} <= ${skip + Math.max(0, Math.trunc(Number(node.limit)))}`);
  const filter = bounds.length ? ` WHERE ${bounds.join(' AND ')}` : '';
  return `SELECT * FROM (${inner}) ${d.quoteIdent('__forge_page')}${filter} ORDER BY ${rn}`;
}

/** `FOR UPDATE [NOWAIT | SKIP LOCKED]` — the last clause of a postgres SELECT. */
export function compileLockClause(lock: RowLockSpec | undefined): string {
  return lock ? rowLockSql('postgres', lock).tail : '';
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
  const ctx: CompileCtx = { d: dialect, model: m, table, params, aliasCount: { n: 0 }, schemaOverride, preferIn: dialect.name === 'sqlite' };
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
  // Postgres and SQLite report the count without RETURNING; DuckDB and SQL
  // Server read it from the returned rows, so they keep the clause.
  const countOnly = node.countOnly && (dialect.name === 'postgres' || dialect.name === 'sqlite'
    || (dialect.name === 'duckdb' && node.driverReportsCount === true));
  const returning = countOnly ? '' : node.returning?.exclusive && node.returning.fields.length
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
    !node.divide &&
    !node.max &&
    !node.min &&
    !node.push &&
    !node.addToSet &&
    !node.pull &&
    !node.unset?.length;
}

// The single-row idiom for UPDATE / DELETE, which Postgres has no `LIMIT` for.
//
// IT USED TO BE `ctid`, AND THAT WAS A CONCURRENCY BUG.
//
//   UPDATE t SET … WHERE ctid = (SELECT ctid FROM t WHERE … LIMIT 1)
//
// `ctid` is a tuple's PHYSICAL address, and an UPDATE does not change a row
// in place — MVCC writes a new version at a new ctid and leaves the old one
// dead. So with two writers on the same row: A reads ctid (0,5); B commits
// its own update, moving the live version to (0,9); A's statement then looks
// for (0,5), matches NOTHING, and forge reports zero rows. The caller sees
// `updateFirst` return null and raises "not found" for a row that is sitting
// right there. It never showed up on Mongo, where `findOneAndUpdate` takes
// the row lock itself, and it is not rare under load — it is whichever write
// arrives second.
//
// The primary key is stable across versions, so it is the right identity.
// `FOR UPDATE` on the subselect is the other half: it locks the row it picked,
// so the second writer waits for the first instead of choosing from a snapshot
// that is already stale. Under READ COMMITTED, Postgres then re-reads the
// locked row and the enclosing statement proceeds against the new version.
//
// Without a primary key there is nothing stable to name, so `ctid` stays —
// the race is still there, but a keyless table cannot be matched any other
// way, and every model forge generates DDL for has an `id`.
//
// ONLY POSTGRES CHANGES SHAPE HERE, and that is deliberate rather than
// cautious. This function is the single place the other SQL adapters get
// their single-row clause from: each one REWRITES the emitted `ctid` text
// into its own spelling (mssql/compile-from-ir.ts, mysql, sqlite, duckdb).
// Checked one at a time, none of them has the bug:
//
//   • mssql  → `[pk] IN (SELECT TOP 1 [pk] …)` — already keyed on the pk.
//   • mysql  → `UPDATE … LIMIT 1`, one statement, nothing to go stale.
//   • sqlite → `rowid`, which SQLite does not move on an update.
//   • duckdb → `rowid`, and it has one writer.
//
// So Postgres was the only dialect where the identity could move under a
// concurrent writer, and leaving the marker untouched for the rest keeps
// their output byte-identical instead of rewriting four adapters to fix one.
function singleRowWhere(d: Dialect, m: ModelDef<any>, table: string, where: string, tree?: WhereTree): string {
  const filter = where ? ` WHERE ${where}` : '';
  // A where that names the primary key or a unique column by value matches
  // one row at most, so the subselect only costs: on DuckDB it halved a
  // single-row UPDATE. MySQL and SQL Server rewrite the marker form into
  // their own spelling and keep it.
  if (where && (d.name === 'postgres' || d.name === 'sqlite' || d.name === 'duckdb') && pinsOneRow(m, tree)) {
    return `WHERE ${where}`;
  }
  const ctidForm = `WHERE ctid = (SELECT ctid FROM ${table}${filter} LIMIT 1)`;
  if (d.name !== 'postgres') return ctidForm;
  const pk = Object.entries(m.fields).find(([, f]) => (f as FieldDef).kind === 'id')?.[0];
  if (!pk) return ctidForm;
  const col = d.quoteIdent(pk);
  return `WHERE ${col} = (SELECT ${col} FROM ${table}${filter} LIMIT 1 FOR UPDATE)`;
}

// Whether `tree` is an AND (or a single leaf) holding an equality on the
// primary key, a unique column, or every column of a composite unique.
function pinsOneRow(m: ModelDef<any>, tree: WhereTree | undefined): boolean {
  if (!tree) return false;
  const leaves = tree.kind === 'leaf' ? [tree] : tree.kind === 'and' ? tree.children : [];
  const eq = new Set<string>();
  for (const c of leaves as any[]) {
    if (c.kind === 'leaf' && c.op === 'eq' && c.rhsField === undefined && c.value != null && !c.jsonPath) eq.add(c.field);
  }
  if (eq.size === 0) return false;
  for (const f of eq) {
    const fd = m.fields[f] as FieldDef | undefined;
    if (fd && (fd.kind === 'id' || fd.unique)) return true;
  }
  return (m.uniques ?? []).some((cols) => cols.length > 0 && cols.every((c) => eq.has(c)));
}

/**
 * True when the field is stored as `jsonb` rather than a real array column.
 *
 * `f.json()` is untyped by design, so a json column holding an array is
 * indistinguishable from one holding an object until you look at the value —
 * which is why the array operators have to be chosen by the COLUMN type and
 * not by the operand.
 */
function isJsonField(ctx: CompileCtx, field: string): boolean {
  const kind = (ctx.model.fields[field] as FieldDef | undefined)?.kind;
  return kind === 'json' || kind === 'embed' || kind === 'embedMany';
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
  const ctx: CompileCtx = { d: dialect, model: m, table, params, aliasCount: { n: 0 }, schemaOverride, preferIn: dialect.name === 'sqlite' && node.many };

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
      /*
       * A DOTTED KEY WRITES INSIDE A JSON COLUMN, and used to write nowhere.
       *
       *   data: { 'customer.id': newId }
       *
       * came out as `SET "customer.id" = $1` — the whole dotted name quoted
       * as ONE identifier, so Postgres looked for a column literally called
       * `customer.id` and answered "column does not exist". The READ side
       * has understood these paths for a while (the `jsonPath` leaf above),
       * so a filter on `customer.id` matched rows that could then not be
       * updated. On Mongo the same write is just `$set: {'customer.id': …}`
       * and has always worked, which is why nothing flagged it.
       *
       * `jsonb_set(col, '{a,b}', value, true)` is the Postgres form, with
       * `create_missing = true` so a key that is not there yet is added
       * rather than silently skipped, and a `coalesce` so the column being
       * NULL does not swallow the whole write (jsonb_set returns NULL for a
       * NULL input).
       *
       * Several dotted writes into the SAME column nest, innermost first, so
       * one statement can set two keys without one overwriting the other.
       */
      const jsonSets = new Map<string, Array<[string[], unknown]>>();
      for (const [k, v] of Object.entries(node.set)) {
        const dot = k.indexOf('.');
        const root = dot === -1 ? k : k.slice(0, dot);
        if (dot !== -1 && isJsonField(ctx, root)) {
          const list = jsonSets.get(root) ?? [];
          list.push([k.slice(dot + 1).split('.'), v]);
          jsonSets.set(root, list);
          continue;
        }
        parts.push(`${dialect.quoteIdent(k)} = ${valExpr(k, v)}`);
      }
      for (const [root, writes] of jsonSets) {
        const colQ = dialect.quoteIdent(root);
        let expr = `coalesce(${colQ}, '{}'::jsonb)`;
        for (const [path, v] of writes) {
          const pathLiteral = dialect.placeholder(params, `{${path.join(',')}}`);
          const valueLiteral = dialect.placeholder(params, JSON.stringify(v ?? null));
          expr = `jsonb_set(${expr}, ${pathLiteral}::text[], ${valueLiteral}::text::jsonb, true)`;
        }
        parts.push(`${colQ} = ${expr}`);
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
    if (node.divide) {
      for (const [k, v] of Object.entries(node.divide)) {
        parts.push(`${dialect.quoteIdent(k)} = ${table}.${dialect.quoteIdent(k)} / ${dialect.placeholder(params, v)}`);
      }
    }
    // GREATEST/LEAST differ on NULL between dialects (PG ignores nulls, MySQL
    // returns NULL), so a CASE is used instead: one expression that behaves
    // the same everywhere, and the same way Mongo's $max/$min do on a field
    // that is missing.
    if (node.max) {
      for (const [k, v] of Object.entries(node.max)) {
        const c = `${table}.${dialect.quoteIdent(k)}`;
        const p1 = dialect.placeholder(params, v);
        const p2 = dialect.placeholder(params, v);
        parts.push(`${dialect.quoteIdent(k)} = CASE WHEN ${c} IS NULL OR ${c} < ${p1} THEN ${p2} ELSE ${c} END`);
      }
    }
    if (node.min) {
      for (const [k, v] of Object.entries(node.min)) {
        const c = `${table}.${dialect.quoteIdent(k)}`;
        const p1 = dialect.placeholder(params, v);
        const p2 = dialect.placeholder(params, v);
        parts.push(`${dialect.quoteIdent(k)} = CASE WHEN ${c} IS NULL OR ${c} > ${p1} THEN ${p2} ELSE ${c} END`);
      }
    }
    for (const op of ['push', 'addToSet', 'pull'] as const) {
      const bucket = node[op];
      if (!bucket) continue;
      for (const [k, v] of Object.entries(bucket)) {
        const c = `${table}.${dialect.quoteIdent(k)}`;
        const expr = dialect.arrayOp(op, c, params, v);
        if (expr === null) {
          throw new Error(
            `[forge:${dialect.name}] '${op}' on '${k}' is not supported on this dialect — ` +
            `its list columns are stored as JSON, which has no value-based ` +
            `contains/remove. Read the array, change it, and write it back with ` +
            `\`{ ${k}: [...] }\` — or move the collection to Postgres/DuckDB, ` +
            'whose array columns support it natively.',
          );
        }
        parts.push(`${dialect.quoteIdent(k)} = ${expr}`);
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
    const ret = manyCountOnly(node, dialect) ? ''
      : node.returning?.exclusive && node.returning.fields.length
        ? ` RETURNING ${node.returning.fields.map((f) => dialect.quoteIdent(f)).join(', ')}`
        : ' RETURNING *';
    const sql = `INSERT INTO ${table} (${colList}) VALUES (${valList}) ${conflictClause}${ret}`;
    return { kind: 'sql', dialect: dialect.name, sql, params };
  }

  const built = buildSet();
  const setParts = built.length ? built : [noopSet()];

  const where = compileWhere(ctx, node.where);
  const whereClause = where ? `WHERE ${where}` : '';
  // For updateOne (many=false) the statement is constrained to one row by
  // primary key — see singleRowWhere, and why it is not `ctid`.
  const finalWhere = node.many ? whereClause : singleRowWhere(dialect, m, table, where, node.where);
  const returning = manyCountOnly(node, dialect) ? ''
    : node.returning?.exclusive && node.returning.fields.length
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
  const ctx: CompileCtx = { d: dialect, model: m, table, params, aliasCount: { n: 0 }, schemaOverride, preferIn: dialect.name === 'sqlite' && node.many };
  const where = compileWhere(ctx, node.where);
  const whereClause = where ? `WHERE ${where}` : '';
  const finalWhere = node.many ? whereClause : singleRowWhere(dialect, m, table, where, node.where);
  const sql = `DELETE FROM ${table} ${finalWhere}${manyCountOnly(node, dialect) ? '' : ' RETURNING *'}`;
  return { kind: 'sql', dialect: dialect.name, sql, params };
}

// updateMany / deleteMany (and a single write called with `select: false`)
// hand back a count and nothing else, and Postgres and
// SQLite report it without RETURNING, so the rows are neither sent nor
// decoded. DuckDB does too, but only through a driver that says so
// (`countOnly`, set by its executor); SQL Server and MySQL rewrite the tail
// themselves.
function manyCountOnly(node: UpdateNode | DeleteNode, d: Dialect): boolean {
  if (!node.many && !node.noReturn) return false;
  if (d.name === 'postgres' || d.name === 'sqlite') return true;
  return d.name === 'duckdb' && node.countOnly === true;
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
  const ctx: CompileCtx = { d: dialect, model: m, table, params, aliasCount: { n: 0 }, schemaOverride, preferIn: dialect.name === 'sqlite' };

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
    const AGG_FN: Record<string, string> = {
      _count: 'COUNT', _avg: 'AVG', _sum: 'SUM', _min: 'MIN', _max: 'MAX',
    };
    return `ORDER BY ${node.orderBy.map((e) => {
      if (e.agg) {
        // The aggregate EXPRESSION, not the SELECT alias, so ordering on a
        // bucket works whether or not that bucket was also selected.
        const fn = AGG_FN[e.agg.bucket];
        const colExpr = e.agg.field === '_all'
          ? '*'
          : `${table}.${dialect.quoteIdent(e.agg.field)}`;
        return dialect.orderClause(`${fn}(${colExpr})`, e.direction, e.nulls);
      }
      return dialect.orderClause(`${table}.${dialect.quoteIdent(e.field)}`, e.direction, e.nulls);
    }).join(', ')}`;
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
