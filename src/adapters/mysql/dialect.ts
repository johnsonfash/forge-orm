import type { FieldDef } from '../../schema/types';
import type { Dialect } from '../postgres/dialect';

// MySQL dialect. Diverges from PG/SQLite:
//   • Backtick identifier quoting; `?` positional placeholders.
//   • Upsert is `ON DUPLICATE KEY UPDATE`, not `ON CONFLICT (col) DO UPDATE`.
//   • No `text[]` (use JSON); no `NULLS FIRST/LAST` (follows collation).
//   • Bools stored as TINYINT(1).

export const MysqlDialect: Dialect = {
  name: 'mysql',

  quoteIdent(name) {
    if (/[`\0]/.test(name)) {
      throw new Error(`[forge:mysql] invalid identifier: ${JSON.stringify(name)}`);
    }
    return '`' + name + '`';
  },

  placeholder(params, value) {
    params.push(value);
    return '?';
  },

  columnType(field: FieldDef) {
    switch (field.kind) {
      case 'id':
        // bigserial → BIGINT AUTO_INCREMENT (NOT NULL appended by renderColumn).
        // uuid → CHAR(36) (with `DEFAULT (UUID())` via renderDefault).
        // auto → string column, app-side gen handles the value.
        if (field.idType === 'bigserial') return 'BIGINT';
        if (field.idType === 'uuid')      return 'CHAR(36)';
        return 'VARCHAR(64)';
      case 'objectId':   return 'VARCHAR(64)';
      case 'string':     return 'VARCHAR(255)';   // can be UNIQUE / indexed without a key-length prefix
      case 'text':       return 'TEXT';            // unbounded; can't be UNIQUE without a (n) prefix
      case 'int':        return 'INT';
      case 'float':      return 'DOUBLE PRECISION';
      case 'decimal':    return field.precision != null
                           ? `DECIMAL(${field.precision}${field.scale != null ? `,${field.scale}` : ''})`
                           : 'DECIMAL(10,0)';
      case 'uuid':       return 'CHAR(36)';
      case 'bigint':     return 'BIGINT';
      case 'bool':       return 'TINYINT(1)';
      case 'dateTime':   return 'DATETIME(3)';   // millisecond precision
      case 'json':       return 'JSON';
      case 'enum':       return 'VARCHAR(64)';   // + CHECK
      case 'embed':      return 'JSON';
      case 'embedMany':  return 'JSON';
      case 'stringArray':return 'JSON';
      case 'intArray':   return 'JSON';
      case 'geoPoint': {
        if (field.geo?.fallback) return 'JSON';
        const srid = field.geo?.srid ?? 4326;
        return `POINT NOT NULL SRID ${srid}`;
      }
      case 'vector': {
        // MySQL 9.0+ native VECTOR type. Community edition supports brute-
        // force search; HeatWave Vector Store adds HNSW/IVF.
        const dims = field.vector?.dims;
        if (!dims) throw new Error(`[forge:mysql] vector field requires { dims }`);
        return `VECTOR(${dims})`;
      }
    }
  },

  orderClause(column, direction, _nulls) {
    // MySQL doesn't support NULLS FIRST/LAST — silently ignored.
    return `${column} ${direction === 'desc' ? 'DESC' : 'ASC'}`;
  },

  upsertConflictClause(_conflictCols, setAssignments) {
    // MySQL ignores conflictCols — the upsert fires on ANY unique-key
    // conflict. The compiler still passes them for parity / future MariaDB.
    return `ON DUPLICATE KEY UPDATE ${setAssignments}`;
  },

  searchClause(quotedColumn, paramExpr, _ctx) {
    // Requires a FULLTEXT index on the column — emitted automatically when
    // the field is declared `.searchable()`. Without it, MySQL throws.
    return `MATCH(${quotedColumn}) AGAINST (${paramExpr} IN NATURAL LANGUAGE MODE)`;
  },

  valueExpr(field, params, value) {
    if (field.kind === 'geoPoint' && !field.geo?.fallback && value && typeof value === 'object') {
      const v = value as { lng: number; lat: number };
      const srid = field.geo?.srid ?? 4326;
      const ph = this.placeholder(params, `POINT(${v.lat} ${v.lng})`);
      return `ST_GeomFromText(${ph}, ${srid})`;
    }
    if (field.kind === 'vector' && Array.isArray(value)) {
      // MySQL's STRING_TO_VECTOR parses a JSON array string into VECTOR.
      const ph = this.placeholder(params, `[${(value as number[]).join(',')}]`);
      return `STRING_TO_VECTOR(${ph})`;
    }
    return this.placeholder(params, value);
  },

  geoNearClause(quotedCol, field, point, params) {
    const srid = field.geo?.srid ?? 4326;
    // Axis-order quirk: lat-first for SRID 4326.
    const wkt = `POINT(${point.lat} ${point.lng})`;
    const pp = this.placeholder(params, wkt);
    const ref = `ST_GeomFromText(${pp}, ${srid})`;
    if (point.withinMeters === undefined) return 'TRUE';
    const wm = this.placeholder(params, point.withinMeters);
    return `ST_Distance_Sphere(${quotedCol}, ${ref}) < ${wm}`;
  },

  geoDistanceExpr(quotedCol, field, point, params) {
    const srid = field.geo?.srid ?? 4326;
    const wkt = `POINT(${point.lat} ${point.lng})`;
    const pp = this.placeholder(params, wkt);
    return `ST_Distance_Sphere(${quotedCol}, ST_GeomFromText(${pp}, ${srid}))`;
  },

  vectorDistanceClause(quotedCol, field, query, params) {
    const metric = (field.vector?.metric ?? 'cosine').toUpperCase();
    const ph = this.placeholder(params, `[${query.vector.join(',')}]`);
    if (query.withinDistance === undefined) return 'TRUE';
    const wd = this.placeholder(params, query.withinDistance);
    return `DISTANCE(${quotedCol}, STRING_TO_VECTOR(${ph}), '${metric}') < ${wd}`;
  },

  vectorDistanceExpr(quotedCol, field, vector, params) {
    const metric = (field.vector?.metric ?? 'cosine').toUpperCase();
    const ph = this.placeholder(params, `[${vector.join(',')}]`);
    return `DISTANCE(${quotedCol}, STRING_TO_VECTOR(${ph}), '${metric}')`;
  },

  jsonPathExpr(quotedCol, path) {
    // MySQL JSON_EXTRACT returns JSON-encoded values; for strings that means
    // a wrapping `"…"`. Wrap with JSON_UNQUOTE so equality against a plain
    // string param works.
    const pathSpec = '$' + path.map((s) => /^\d+$/.test(s) ? `[${s}]` : `.${s.replace(/[`'"\\]/g, '\\$&')}`).join('');
    return `JSON_UNQUOTE(JSON_EXTRACT(${quotedCol}, '${pathSpec.replace(/'/g, "''")}'))`;
  },

  geoWithinPolygonClause(quotedCol, field, polygon, params) {
    const srid = field.geo?.srid ?? 4326;
    // Axis-order quirk: lat first.
    const ring = polygon.map((v) => `${v.lat} ${v.lng}`).join(', ');
    const wkt = `POLYGON((${ring}))`;
    const pp = this.placeholder(params, wkt);
    return `ST_Within(${quotedCol}, ST_GeomFromText(${pp}, ${srid}))`;
  },
};
