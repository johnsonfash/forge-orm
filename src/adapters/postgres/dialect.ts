// Postgres dialect details — quoting, placeholders, type names. Kept in one
// file so the compiler stays dialect-neutral and MySQL / SQLite can fork by
// swapping just this.

import type { FieldDef } from '../../schema/types';
import { toGeoWKT } from '../shared/wkt';

export interface Dialect {
  readonly name: 'postgres' | 'mysql' | 'sqlite' | 'duckdb' | 'mssql';
  // Quote an identifier (table / column / index name). PG uses double-quotes,
  // case-sensitive when quoted. We always quote.
  quoteIdent(name: string): string;
  // Make a placeholder for a parameterised query. Returns the placeholder
  // string and pushes the value onto `params`. Postgres: $1, $2, $3, ...
  placeholder(params: unknown[], value: unknown): string;
  // Map a FieldDef to the column's SQL type for DDL generation.
  columnType(field: FieldDef): string;
  // ORDER BY direction with optional NULLS FIRST/LAST.
  orderClause(column: string, direction: 'asc' | 'desc', nulls?: 'first' | 'last'): string;
  // ON CONFLICT helper for upsert. PG: ON CONFLICT (cols) DO UPDATE SET ...
  // MySQL: ON DUPLICATE KEY UPDATE ...
  upsertConflictClause(conflictCols: string[], setAssignments: string): string;
  // Full-text search clause. Per-dialect:
  //   PG:     to_tsvector('simple', col) @@ plainto_tsquery('simple', ?)
  //   MySQL:  MATCH(col) AGAINST (? IN NATURAL LANGUAGE MODE)
  //   SQLite: id IN (SELECT rowid FROM <table>_fts WHERE <table>_fts MATCH ?)
  //          — requires the FTS5 virtual table emitted by .searchable().
  // The third arg gives the dialect the unquoted column name + base table
  // name so SQLite can synthesize its FTS5 lookup. PG/MySQL ignore them.
  searchClause(
    quotedColumn: string,
    paramExpr: string,
    ctx: { rawColumn: string; baseTable: string; quoteIdent: (s: string) => string },
  ): string;
  /**
   * Per-field value expression for INSERT VALUES / UPDATE SET. Default
   * behaviour is to bind the value as a positional parameter (`placeholder`),
   * but special field kinds (geoPoint) need to wrap the parameter in a
   * dialect-specific function. The default implementation in each dialect
   * delegates to `placeholder` for non-special kinds.
   */
  valueExpr?(field: FieldDef, params: unknown[], value: unknown): string;
  /**
   * Compile a "near + within radius" filter against a geoPoint column.
   * Returns a SQL boolean expression that's TRUE when the row is within
   * `withinMeters` of the search point. Each dialect implements via its
   * native distance function:
   *   PG     → ST_DWithin(loc, ST_GeogFromText(...), N)
   *   MySQL  → ST_Distance_Sphere(loc, ST_GeomFromText('POINT(lat lng)', 4326)) < N
   *   SQLite → Distance(loc, MakePoint(lng, lat, 4326), 1) < N  (SpatiaLite)
   *   DuckDB → ST_Distance(loc, ST_Point(lng, lat)) < N         (spatial ext)
   *   MSSQL  → loc.STDistance(geography::STGeomFromText(...)) < N
   * When `withinMeters` is undefined the clause becomes `TRUE` and the
   * adapter relies on ordering alone (used by `orderBy: { nearTo: … }`).
   */
  geoNearClause?(
    quotedCol: string,
    field: FieldDef,
    point: { lng: number; lat: number; withinMeters?: number },
    params: unknown[],
  ): string;
  /**
   * Compile a "distance to point" expression. Used as the `_distanceMeters`
   * synthetic column when `orderBy: { col: { nearTo: { … } } }` is set.
   */
  geoDistanceExpr?(
    quotedCol: string,
    field: FieldDef,
    point: { lng: number; lat: number },
    params: unknown[],
  ): string;
  /**
   * Compile a "point inside polygon" filter. Per dialect:
   *   PG     → ST_Within(loc, ST_GeogFromText('SRID=4326;POLYGON((…))'))
   *   MySQL  → ST_Within(loc, ST_GeomFromText('POLYGON((lat lng,…))', 4326))
   *   SQLite → Within(loc, GeomFromText('POLYGON((…))', 4326))
   *   DuckDB → ST_Within(loc, ST_GeomFromText('POLYGON((…))'))
   *   MSSQL  → geography::STGeomFromText('POLYGON((…))', 4326).STContains(loc) = 1
   */
  geoWithinPolygonClause?(
    quotedCol: string,
    field: FieldDef,
    // MultiPolygon shape — Array of polygons, each polygon = Array of rings
    // (outer + 0..N holes), each ring = closed Array<{lng,lat}>. A simple
    // single-ring input arrives as [[[{lng,lat}, …]]].
    multiPolygon: Array<Array<Array<{ lng: number; lat: number }>>>,
    params: unknown[],
  ): string;
  /**
   * Compile a JSON path read into a comparable SQL expression. Per dialect:
   *   PG     → (col->'a'->'b'->>'c')::numeric  (cast by operand type)
   *   MySQL  → JSON_EXTRACT(col, '$.a.b.c')
   *   SQLite → json_extract(col, '$.a.b.c')
   *   DuckDB → json_extract(col, '$.a.b.c')
   *   MSSQL  → JSON_VALUE(col, '$.a.b.c')
   * `operand` is provided so the dialect can choose the right cast on
   * dialects that need typed comparisons (PG mostly).
   */
  jsonPathExpr?(quotedCol: string, path: string[], operand: unknown): string;
  /**
   * Compile a "vector near + optional withinDistance" filter. Per dialect:
   *   PG     → ($col <=> $vec) < $d   (cosine via pgvector — also <-> for L2, <#> for dot)
   *   MySQL  → DISTANCE($col, $vec, 'COSINE') < $d
   *   SQLite → $col MATCH vec_f32($vec) — via sqlite-vec virtual table
   *   DuckDB → array_cosine_distance($col, $vec) < $d
   *   MSSQL  → VECTOR_DISTANCE('cosine', $col, $vec) < $d
   *   Mongo  → routed to $vectorSearch aggregate stage (not via where)
   * When withinDistance is undefined the clause becomes TRUE; the
   * orderBy: { col: { nearTo: vec } } drives the ranking.
   */
  vectorDistanceClause?(
    quotedCol: string,
    field: FieldDef,
    query: { vector: number[]; withinDistance?: number },
    params: unknown[],
  ): string;
  /**
   * Compile a "distance to vector" expression. Used as the `_distance`
   * synthetic column for vector orderBy `nearTo`.
   */
  vectorDistanceExpr?(
    quotedCol: string,
    field: FieldDef,
    vector: number[],
    params: unknown[],
  ): string;
}

export const PostgresDialect: Dialect = {
  name: 'postgres',

  quoteIdent(name) {
    // Reject identifiers containing double-quotes or null bytes to prevent
    // injection through schema names; this should never happen with our
    // schema DSL but defence-in-depth costs nothing.
    if (/["\0]/.test(name)) {
      throw new Error(`[forge:postgres] invalid identifier: ${JSON.stringify(name)}`);
    }
    return `"${name}"`;
  },

  placeholder(params, value) {
    params.push(value);
    return `$${params.length}`;
  },

  columnType(field) {
    switch (field.kind) {
      case 'id':
        // idType drives the underlying PG type. `bigserial` carries its own
        // sequence + default + NOT NULL — the column-builder must NOT add a
        // separate default/null clause when it sees this.
        if (field.idType === 'bigserial') return 'bigserial';
        if (field.idType === 'uuid')      return 'uuid';
        return 'text';
      case 'objectId':   return 'text'; // FK to a Mongo-style id is text; pure-PG schemas would use uuid
      case 'string':     return 'text';
      case 'text':       return 'text';
      case 'int':        return 'integer';
      case 'float':      return 'double precision';
      case 'decimal':    return field.precision != null
                           ? `numeric(${field.precision}${field.scale != null ? `,${field.scale}` : ''})`
                           : 'numeric';
      case 'uuid':       return 'uuid';
      case 'bigint':     return 'bigint';
      case 'bool':       return 'boolean';
      case 'dateTime':   return 'timestamptz';
      case 'json':       return 'jsonb';
      case 'enum':       return 'text'; // + CHECK constraint applied at DDL time
      case 'embed':      return 'jsonb';
      case 'embedMany':  return 'jsonb';
      case 'stringArray':return 'text[]';
      case 'intArray':   return 'integer[]';
      case 'geoPoint': {
        if (field.geo?.fallback) return 'jsonb';
        const srid = field.geo?.srid ?? 4326;
        const pointType = field.geo?.dims === 3 ? 'PointZ' : 'Point';
        // Non-WGS84 SRIDs can't ride on the geography type (which is
        // 4326-only) — fall back to geometry(Point, srid) so user-declared
        // SRIDs like 3857 (Web Mercator) or 27700 (OSGB) work end-to-end.
        if (srid !== 4326) return `geometry(${pointType}, ${srid})`;
        return `geography(${pointType}, ${srid})`;
      }
      case 'vector': {
        // pgvector. The dims must match the embedding model's output (1536
        // for OpenAI text-embedding-3-small, 1024 for Cohere embed-english,
        // etc.). The extension is installed via `CREATE EXTENSION vector;`.
        const dims = field.vector?.dims;
        if (!dims) throw new Error(`[forge:pg] vector field requires { dims }`);
        return `vector(${dims})`;
      }
    }
  },

  orderClause(column, direction, nulls) {
    const dir = direction === 'desc' ? 'DESC' : 'ASC';
    const nullsClause = nulls ? ` NULLS ${nulls.toUpperCase()}` : '';
    return `${column} ${dir}${nullsClause}`;
  },

  upsertConflictClause(conflictCols, setAssignments) {
    const cols = conflictCols.join(', ');
    return `ON CONFLICT (${cols}) DO UPDATE SET ${setAssignments}`;
  },

  searchClause(quotedColumn, paramExpr, _ctx) {
    return `to_tsvector('simple', ${quotedColumn}) @@ plainto_tsquery('simple', ${paramExpr})`;
  },

  valueExpr(field, params, value) {
    if (field.kind === 'geoPoint' && !field.geo?.fallback && value && typeof value === 'object') {
      const v = value as { lng: number; lat: number; alt?: number };
      const srid = field.geo?.srid ?? 4326;
      // dims=3 → emit POINT Z(lng lat alt). PG `geography(PointZ, 4326)` is
      // the natural backing type; PostGIS auto-promotes from the WKT.
      const wkt = field.geo?.dims === 3 && typeof v.alt === 'number'
        ? `SRID=${srid};POINT Z(${v.lng} ${v.lat} ${v.alt})`
        : `SRID=${srid};POINT(${v.lng} ${v.lat})`;
      const ph = this.placeholder(params, wkt);
      return `ST_GeogFromText(${ph})`;
    }
    if (field.kind === 'vector' && Array.isArray(value)) {
      // pgvector accepts the bracketed text form `[0.1, 0.2, …]`.
      const ph = this.placeholder(params, `[${(value as number[]).join(',')}]`);
      return `${ph}::vector`;
    }
    return this.placeholder(params, value);
  },

  geoNearClause(quotedCol, field, point, params) {
    const srid = field.geo?.srid ?? 4326;
    const ewkt = `SRID=${srid};POINT(${point.lng} ${point.lat})`;
    const pp = this.placeholder(params, ewkt);
    if (point.withinMeters === undefined) return 'TRUE';
    const wm = this.placeholder(params, point.withinMeters);
    return `ST_DWithin(${quotedCol}, ST_GeogFromText(${pp}), ${wm})`;
  },

  geoDistanceExpr(quotedCol, field, point, params) {
    const srid = field.geo?.srid ?? 4326;
    const ewkt = `SRID=${srid};POINT(${point.lng} ${point.lat})`;
    const pp = this.placeholder(params, ewkt);
    return `ST_Distance(${quotedCol}, ST_GeogFromText(${pp}))`;
  },

  vectorDistanceClause(quotedCol, field, query, params) {
    const metric = field.vector?.metric ?? 'cosine';
    const op = metric === 'cosine' ? '<=>' : metric === 'l2' ? '<->' : '<#>';
    const ph = this.placeholder(params, `[${query.vector.join(',')}]`);
    if (query.withinDistance === undefined) return 'TRUE';
    const wd = this.placeholder(params, query.withinDistance);
    return `(${quotedCol} ${op} ${ph}::vector) < ${wd}`;
  },

  vectorDistanceExpr(quotedCol, field, vector, params) {
    const metric = field.vector?.metric ?? 'cosine';
    const op = metric === 'cosine' ? '<=>' : metric === 'l2' ? '<->' : '<#>';
    const ph = this.placeholder(params, `[${vector.join(',')}]`);
    return `(${quotedCol} ${op} ${ph}::vector)`;
  },

  geoWithinPolygonClause(quotedCol, field, multiPolygon, params) {
    const srid = field.geo?.srid ?? 4326;
    const wkt = toGeoWKT(multiPolygon, 'lng-lat');
    const ewkt = `SRID=${srid};${wkt}`;
    const pp = this.placeholder(params, ewkt);
    // ST_Within works on the geography type for cast-friendly comparison.
    return `ST_Within(${quotedCol}::geometry, ST_GeogFromText(${pp})::geometry)`;
  },
};
