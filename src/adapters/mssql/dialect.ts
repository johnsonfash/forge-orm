// SQL Server (T-SQL) dialect — bracket identifiers, named @ placeholders,
// SQL Server type names, BIT for booleans, no native arrays.

import type { FieldDef } from '../../schema/types';
import type { Dialect } from '../postgres/dialect';
import { toGeoWKT } from '../shared/wkt';
import { jsonPathSpec } from '../json-path-spec';

export const MssqlDialect: Dialect = {
  name: 'mssql',
  // T-SQL has no `(a, b) > (x, y)`; the cursor compiler expands instead.
  rowValueComparison: false,

  quoteIdent(name) {
    if (/[\]\0]/.test(name)) {
      throw new Error(`[forge:mssql] invalid identifier: ${JSON.stringify(name)}`);
    }
    return `[${name}]`;
  },

  placeholder(params, value) {
    // T-SQL uses @-prefixed named parameters. We bind by position via the
    // mssql driver (request.input("p${n}", value)) — see driver.ts.
    params.push(value);
    return `@p${params.length}`;
  },

  // T-SQL has no boolean literal and no boolean expression outside a predicate.
  trueLiteral: '1=1',
  falseLiteral: '1=0',

  caseInsensitiveLike(quotedColumn, patternExpr) {
    return `LOWER(${quotedColumn}) LIKE LOWER(${patternExpr})`;
  },

  // Arrays are JSON in NVARCHAR(MAX); OPENJSON is T-SQL's json_each.
  arrayFilter(op, quotedColumn, values, params) {
    const ph = (v: unknown) => this.placeholder(params, v);
    const each = `SELECT 1 FROM OPENJSON(${quotedColumn}) WHERE value`;
    switch (op) {
      case 'has':      return `EXISTS (${each} = ${ph(values[0])})`;
      case 'hasSome':  return `EXISTS (${each} IN (${values.map(ph).join(', ')}))`;
      case 'hasEvery':
        return `(SELECT COUNT(DISTINCT value) FROM OPENJSON(${quotedColumn}) ` +
               `WHERE value IN (${values.map(ph).join(', ')})) = ${values.length}`;
      case 'isEmpty':  return `(SELECT COUNT(*) FROM OPENJSON(${quotedColumn})) = 0`;
    }
  },

  // Arrays are JSON in NVARCHAR(MAX). JSON_MODIFY's 'append' lax path adds an
  // element; there is no value-based contains or remove.
  arrayOp(op, quotedColumn, params, value) {
    const p = () => this.placeholder(params, value);
    switch (op) {
      case 'push':     return `JSON_MODIFY(${quotedColumn}, 'append $', ${p()})`;
      case 'addToSet': return null;
      case 'pull':     return null;
    }
  },
  columnType(field) {
    switch (field.kind) {
      case 'id':
        if (field.idType === 'bigserial') return 'BIGINT IDENTITY(1,1)';
        if (field.idType === 'uuid')      return 'UNIQUEIDENTIFIER';
        return 'NVARCHAR(255)';
      case 'objectId':   return 'NVARCHAR(255)';
      case 'string':     return 'NVARCHAR(255)';
      // T-SQL TEXT is deprecated; NVARCHAR(MAX) is the modern equivalent.
      case 'text':       return 'NVARCHAR(MAX)';
      case 'int':        return 'INT';
      case 'float':      return 'FLOAT';
      case 'decimal':    return field.precision != null
                           ? `DECIMAL(${field.precision}${field.scale != null ? `,${field.scale}` : ''})`
                           : 'DECIMAL';
      case 'uuid':       return 'UNIQUEIDENTIFIER';
      case 'bigint':     return 'BIGINT';
      // T-SQL booleans are BIT; the driver coerces JS true/false to 1/0.
      case 'bool':       return 'BIT';
      // DATETIMEOFFSET preserves tz; DATETIME2 doesn't.
      case 'dateTime':   return 'DATETIMEOFFSET';
      // JSON lives in NVARCHAR(MAX); SQL Server 2025 adds a real JSON type,
      // but NVARCHAR(MAX) is the portable choice for now.
      case 'json':       return 'NVARCHAR(MAX)';
      // VARBINARY(MAX) is stored off-row and cannot be indexed; an inline
      // VARBINARY(n) can. 8000 is the in-row ceiling for the type.
      case 'bytes':
        return field.maxBytes != null && field.maxBytes <= 8000
          ? `VARBINARY(${field.maxBytes})`
          : 'VARBINARY(MAX)';
      case 'enum':       return 'NVARCHAR(255)'; // + CHECK constraint applied at DDL time
      case 'embed':      return 'NVARCHAR(MAX)';
      case 'embedMany':  return 'NVARCHAR(MAX)';
      // T-SQL has no native array. Serialize as JSON; consumers use
      // JSON_VALUE / OPENJSON to read.
      case 'stringArray':return 'NVARCHAR(MAX)';
      case 'intArray':   return 'NVARCHAR(MAX)';
      case 'geoPoint':
        return field.geo?.fallback ? 'NVARCHAR(MAX)' : 'GEOGRAPHY';
      case 'vector': {
        // SQL Server 2025 / Azure SQL native VECTOR type.
        const dims = field.vector?.dims;
        if (!dims) throw new Error(`[forge:mssql] vector field requires { dims }`);
        return `VECTOR(${dims})`;
      }
    }
  },

  orderClause(column, direction, nulls) {
    const dir = direction === 'desc' ? 'DESC' : 'ASC';
    // T-SQL doesn't support NULLS FIRST / NULLS LAST. Emit a leading
    // CASE WHEN col IS NULL THEN 0/1 END expression to control the position.
    if (!nulls) return `${column} ${dir}`;
    const nullsFirst = nulls === 'first';
    return `CASE WHEN ${column} IS NULL THEN ${nullsFirst ? 0 : 1} ELSE ${nullsFirst ? 1 : 0} END ASC, ${column} ${dir}`;
  },

  upsertConflictClause(_conflictCols, _setAssignments) {
    // T-SQL has no ON CONFLICT. Upsert is expressed as MERGE, which the
    // post-processor in compile-from-ir rewrites the INSERT statement into.
    // Returning this sentinel signals "rewrite needed" to the post-pass.
    return `/* __MSSQL_UPSERT__ */`;
  },

  searchClause(quotedColumn, paramExpr, _ctx) {
    // SQL Server full-text search needs a configured catalog. Fall back to
    // a LIKE wildcard match so .searchable() works portably; for production
    // performance, install FTS and rewrite to CONTAINS(...).
    return `${quotedColumn} LIKE '%' + ${paramExpr} + '%'`;
  },

  valueExpr(field, params, value) {
    if (field.kind === 'geoPoint' && !field.geo?.fallback && value && typeof value === 'object') {
      const v = value as { lng: number; lat: number; alt?: number };
      const srid = field.geo?.srid ?? 4326;
      const wkt = field.geo?.dims === 3 && typeof v.alt === 'number'
        ? `POINT(${v.lng} ${v.lat} ${v.alt})`
        : `POINT(${v.lng} ${v.lat})`;
      const ph = this.placeholder(params, wkt);
      return `geography::STGeomFromText(${ph}, ${srid})`;
    }
    if (field.kind === 'vector' && Array.isArray(value)) {
      const dims = field.vector?.dims;
      const ph = this.placeholder(params, `[${(value as number[]).join(',')}]`);
      return `CAST(${ph} AS VECTOR(${dims}))`;
    }
    return this.placeholder(params, value);
  },

  geoNearClause(quotedCol, field, point, params) {
    const srid = field.geo?.srid ?? 4326;
    const wkt = `POINT(${point.lng} ${point.lat})`;
    const pp = this.placeholder(params, wkt);
    const ref = `geography::STGeomFromText(${pp}, ${srid})`;
    if (point.withinMeters === undefined) return this.trueLiteral;
    const wm = this.placeholder(params, point.withinMeters);
    return `${quotedCol}.STDistance(${ref}) < ${wm}`;
  },

  geoDistanceExpr(quotedCol, field, point, params) {
    const srid = field.geo?.srid ?? 4326;
    const wkt = `POINT(${point.lng} ${point.lat})`;
    const pp = this.placeholder(params, wkt);
    return `${quotedCol}.STDistance(geography::STGeomFromText(${pp}, ${srid}))`;
  },

  vectorDistanceClause(quotedCol, field, query, params) {
    const metric = field.vector?.metric ?? 'cosine';
    const dims = field.vector?.dims;
    const ph = this.placeholder(params, `[${query.vector.join(',')}]`);
    const ref = `CAST(${ph} AS VECTOR(${dims}))`;
    if (query.withinDistance === undefined) return this.trueLiteral;
    const wd = this.placeholder(params, query.withinDistance);
    return `VECTOR_DISTANCE('${metric}', ${quotedCol}, ${ref}) < ${wd}`;
  },

  vectorDistanceExpr(quotedCol, field, vector, params) {
    const metric = field.vector?.metric ?? 'cosine';
    const dims = field.vector?.dims;
    const ph = this.placeholder(params, `[${vector.join(',')}]`);
    return `VECTOR_DISTANCE('${metric}', ${quotedCol}, CAST(${ph} AS VECTOR(${dims})))`;
  },

  jsonPathExpr(quotedCol, path, _operand, params) {
    // T-SQL accepts a variable for the path, and a bound parameter is one.
    return `JSON_VALUE(${quotedCol}, ${this.placeholder(params, jsonPathSpec(path))})`;
  },

  geoWithinPolygonClause(quotedCol, field, multiPolygon, params) {
    const srid = field.geo?.srid ?? 4326;
    const wkt = toGeoWKT(multiPolygon, 'lng-lat');
    const pp = this.placeholder(params, wkt);
    // SQL Server: invert STContains for "point within polygon".
    return `geography::STGeomFromText(${pp}, ${srid}).STContains(${quotedCol}) = 1`;
  },
};
