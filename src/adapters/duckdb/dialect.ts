// DuckDB dialect — Postgres-flavoured SQL with a few notable deltas.
//
//   * Placeholders: DuckDB accepts BOTH `$1`-style and `?`-style; we use
//     `$1` to maximise compile-from-ir reuse from the Postgres adapter.
//   * No `jsonb` — JSON values live in the native JSON type.
//   * Native UUID generation: `uuid()` (no extension needed).
//   * `bigserial` doesn't exist by name; we emit `bigint` with a sequence
//     and a DEFAULT — see ddl.ts for the sequence emission detail.
//   * Full-text search is not native — `.searchable()` warns and skips.

import type { FieldDef } from '../../schema/types';
import type { Dialect } from '../postgres/dialect';
import { toGeoWKT } from '../shared/wkt';

export const DuckdbDialect: Dialect = {
  name: 'duckdb',

  quoteIdent(name) {
    if (/["\0]/.test(name)) {
      throw new Error(`[forge:duckdb] invalid identifier: ${JSON.stringify(name)}`);
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
        if (field.idType === 'bigserial') return 'BIGINT';
        if (field.idType === 'uuid')      return 'UUID';
        return 'VARCHAR';
      case 'objectId':   return 'VARCHAR';
      case 'string':     return 'VARCHAR';
      case 'text':       return 'VARCHAR';
      case 'int':        return 'INTEGER';
      case 'float':      return 'DOUBLE';
      case 'decimal':    return field.precision != null
                           ? `DECIMAL(${field.precision}${field.scale != null ? `,${field.scale}` : ''})`
                           : 'DECIMAL';
      case 'uuid':       return 'UUID';
      case 'bigint':     return 'BIGINT';
      case 'bool':       return 'BOOLEAN';
      // TIMESTAMP WITH TIME ZONE in DuckDB. Stored UTC; surface as JS Date.
      case 'dateTime':   return 'TIMESTAMPTZ';
      // Native JSON type. DuckDB's JSON extension is autoloaded since v0.9.
      case 'json':       return 'JSON';
      case 'enum':       return 'VARCHAR'; // + CHECK constraint applied at DDL time
      case 'embed':      return 'JSON';
      case 'embedMany':  return 'JSON';
      // DuckDB supports native arrays: VARCHAR[], INTEGER[], etc.
      case 'stringArray':return 'VARCHAR[]';
      case 'intArray':   return 'INTEGER[]';
      case 'geoPoint':
        return field.geo?.fallback ? 'JSON' : 'GEOMETRY';
      case 'vector': {
        // DuckDB vss extension uses fixed-size FLOAT arrays.
        const dims = field.vector?.dims;
        if (!dims) throw new Error(`[forge:duckdb] vector field requires { dims }`);
        return `FLOAT[${dims}]`;
      }
    }
  },

  orderClause(column, direction, nulls) {
    const dir = direction === 'desc' ? 'DESC' : 'ASC';
    const nullsClause = nulls ? ` NULLS ${nulls.toUpperCase()}` : '';
    return `${column} ${dir}${nullsClause}`;
  },

  upsertConflictClause(conflictCols, setAssignments) {
    // ON CONFLICT works the same way as PG since v0.8.
    const cols = conflictCols.join(', ');
    return `ON CONFLICT (${cols}) DO UPDATE SET ${setAssignments}`;
  },

  searchClause(quotedColumn, paramExpr, _ctx) {
    // DuckDB has no built-in full-text. The fts extension exists
    // (`INSTALL fts; LOAD fts;`) but it requires opting in per-table via
    // PRAGMA create_fts_index, which doesn't map cleanly to .searchable().
    // Until that's wired, fall back to LIKE — a portable approximation
    // that won't use an index but won't error either.
    return `${quotedColumn} ILIKE '%' || ${paramExpr} || '%'`;
  },

  valueExpr(field, params, value) {
    if (field.kind === 'geoPoint' && !field.geo?.fallback && value && typeof value === 'object') {
      const v = value as { lng: number; lat: number; alt?: number };
      const lngP = this.placeholder(params, v.lng);
      const latP = this.placeholder(params, v.lat);
      if (field.geo?.dims === 3 && typeof v.alt === 'number') {
        const altP = this.placeholder(params, v.alt);
        return `ST_Point3D(${lngP}, ${latP}, ${altP})`;
      }
      return `ST_Point(${lngP}, ${latP})`;
    }
    if (field.kind === 'vector' && Array.isArray(value)) {
      // Inline as a typed array literal — DuckDB infers FLOAT[dims] cleanly.
      const dims = field.vector?.dims;
      return `[${(value as number[]).join(',')}]::FLOAT[${dims}]`;
    }
    return this.placeholder(params, value);
  },

  geoNearClause(quotedCol, _field, point, params) {
    const lngP = this.placeholder(params, point.lng);
    const latP = this.placeholder(params, point.lat);
    if (point.withinMeters === undefined) return 'TRUE';
    const wm = this.placeholder(params, point.withinMeters);
    // DuckDB spatial ext: ST_Distance_Sphere returns meters.
    return `ST_Distance_Sphere(${quotedCol}, ST_Point(${lngP}, ${latP})) < ${wm}`;
  },

  geoDistanceExpr(quotedCol, _field, point, params) {
    const lngP = this.placeholder(params, point.lng);
    const latP = this.placeholder(params, point.lat);
    return `ST_Distance_Sphere(${quotedCol}, ST_Point(${lngP}, ${latP}))`;
  },

  vectorDistanceClause(quotedCol, field, query, params) {
    const metric = field.vector?.metric ?? 'cosine';
    const fn = metric === 'cosine' ? 'array_cosine_distance'
             : metric === 'l2'     ? 'array_distance'
             : /* dot */              'array_inner_product';
    const dims = field.vector?.dims;
    const literal = `[${query.vector.join(',')}]::FLOAT[${dims}]`;
    if (query.withinDistance === undefined) return 'TRUE';
    const wd = this.placeholder(params, query.withinDistance);
    return `${fn}(${quotedCol}, ${literal}) < ${wd}`;
  },

  vectorDistanceExpr(quotedCol, field, vector, _params) {
    const metric = field.vector?.metric ?? 'cosine';
    const fn = metric === 'cosine' ? 'array_cosine_distance'
             : metric === 'l2'     ? 'array_distance'
             : /* dot */              'array_inner_product';
    const dims = field.vector?.dims;
    return `${fn}(${quotedCol}, [${vector.join(',')}]::FLOAT[${dims}])`;
  },

  jsonPathExpr(quotedCol, path) {
    const pathSpec = '$' + path.map((s) => /^\d+$/.test(s) ? `[${s}]` : `.${s}`).join('');
    return `json_extract(${quotedCol}, '${pathSpec.replace(/'/g, "''")}')`;
  },

  geoWithinPolygonClause(quotedCol, _field, multiPolygon, params) {
    const wkt = toGeoWKT(multiPolygon, 'lng-lat');
    const pp = this.placeholder(params, wkt);
    // Cast the WKT param to VARCHAR explicitly — DuckDB's prepared-statement
    // type inference defaults to ANY here, which ST_GeomFromText rejects.
    return `ST_Within(${quotedCol}, ST_GeomFromText(${pp}::VARCHAR))`;
  },
};
