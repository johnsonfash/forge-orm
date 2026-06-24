import type { FieldDef } from '../../schema/types';
import type { Dialect } from '../postgres/dialect';
import { toGeoWKT } from '../shared/wkt';

// SQLite dialect. Mostly Postgres-compatible (double-quoted idents, ON CONFLICT
// upsert, NULLS FIRST/LAST since 3.30), but:
//   • `?` positional placeholders, not `$1, $2, …`.
//   • No native bigserial/uuid (→ TEXT/INTEGER), no bool (→ 0/1 INTEGER),
//     no text[] (→ JSON in TEXT; array ops map to json_each / json_array_length).

export const SqliteDialect: Dialect = {
  name: 'sqlite',

  quoteIdent(name) {
    if (/["\0]/.test(name)) {
      throw new Error(`[forge:sqlite] invalid identifier: ${JSON.stringify(name)}`);
    }
    return `"${name}"`;
  },

  placeholder(params, value) {
    params.push(value);
    return '?';
  },

  columnType(field: FieldDef) {
    switch (field.kind) {
      case 'id':
        // bigserial → INTEGER (rowid-aliased — the ddl builder writes
        // `PRIMARY KEY AUTOINCREMENT` inline on the column rather than as
        // a separate clause, because SQLite only honours autoincrement
        // when the PK is declared on the column itself).
        if (field.idType === 'bigserial') return 'INTEGER';
        return 'TEXT';
      case 'objectId':   return 'TEXT';
      case 'string':     return 'TEXT';
      case 'text':       return 'TEXT';
      case 'int':        return 'INTEGER';
      case 'float':      return 'REAL';
      case 'decimal':    return 'NUMERIC';        // SQLite has dynamic typing; NUMERIC affinity
      case 'uuid':       return 'TEXT';
      case 'bigint':     return 'INTEGER';        // 64-bit; better-sqlite3 returns bigint when safeIntegers
      case 'bool':       return 'INTEGER';       // 0 / 1
      case 'dateTime':   return 'TEXT';           // ISO 8601 string
      case 'json':       return 'TEXT';           // JSON-encoded
      case 'enum':       return 'TEXT';           // + CHECK
      case 'embed':      return 'TEXT';           // JSON
      case 'embedMany':  return 'TEXT';           // JSON array
      case 'stringArray':return 'TEXT';           // JSON array
      case 'intArray':   return 'TEXT';           // JSON array
      case 'geoPoint':
        return field.geo?.fallback ? 'TEXT' : 'BLOB';
      case 'vector':
        // SQLite stores vectors as JSON text in the base table. The
        // sqlite-vec virtual table (created separately) holds the indexed
        // copy. forge-orm doesn't manage the vec0 table here — apps that
        // want ANN search create it via `CREATE VIRTUAL TABLE … USING vec0`.
        return 'TEXT';
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

  searchClause(_quotedColumn, paramExpr, ctx) {
    // Route through the `<base>_fts` FTS5 table (content_rowid=rowid) emitted by
    // .searchable(). If the field wasn't marked .searchable() the table is
    // absent and SQLite's "no such table" is the actionable error.
    const ftsTable = ctx.quoteIdent(`${ctx.baseTable}_fts`);
    const baseTable = ctx.quoteIdent(ctx.baseTable);
    return `${baseTable}.rowid IN (SELECT rowid FROM ${ftsTable} WHERE ${ftsTable} MATCH ${paramExpr})`;
  },

  valueExpr(field, params, value) {
    if (field.kind === 'geoPoint' && !field.geo?.fallback && value && typeof value === 'object') {
      const v = value as { lng: number; lat: number; alt?: number };
      const srid = field.geo?.srid ?? 4326;
      const wkt = field.geo?.dims === 3 && typeof v.alt === 'number'
        ? `POINT Z(${v.lng} ${v.lat} ${v.alt})`
        : `POINT(${v.lng} ${v.lat})`;
      const ph = this.placeholder(params, wkt);
      return `GeomFromText(${ph}, ${srid})`;
    }
    if (field.kind === 'vector' && Array.isArray(value)) {
      // Serialize as JSON; sqlite-vec accepts json arrays via vec_f32().
      return this.placeholder(params, JSON.stringify(value));
    }
    return this.placeholder(params, value);
  },

  geoNearClause(quotedCol, field, point, params) {
    const srid = field.geo?.srid ?? 4326;
    const lngP = this.placeholder(params, point.lng);
    const latP = this.placeholder(params, point.lat);
    // SpatiaLite Distance(...) — the trailing 1 selects ellipsoidal math (meters).
    if (point.withinMeters === undefined) return 'TRUE';
    const wm = this.placeholder(params, point.withinMeters);
    return `Distance(${quotedCol}, MakePoint(${lngP}, ${latP}, ${srid}), 1) < ${wm}`;
  },

  geoDistanceExpr(quotedCol, field, point, params) {
    const srid = field.geo?.srid ?? 4326;
    const lngP = this.placeholder(params, point.lng);
    const latP = this.placeholder(params, point.lat);
    return `Distance(${quotedCol}, MakePoint(${lngP}, ${latP}, ${srid}), 1)`;
  },

  vectorDistanceClause(quotedCol, field, query, params) {
    // sqlite-vec stores the index in a separate vec0 virtual table; the
    // generic SQL path here can't traverse that. Emit a no-op TRUE and let
    // app code use raw SQL when sqlite-vec is in play. Brute-force JSON
    // scan is the only thing portable here.
    void quotedCol; void field; void query; void params;
    return 'TRUE';
  },

  vectorDistanceExpr() {
    // Same reason — return a placeholder constant; the synthetic _distance
    // column won't be useful on SQLite without sqlite-vec wiring.
    return '0';
  },

  jsonPathExpr(quotedCol, path) {
    const pathSpec = '$' + path.map((s) => /^\d+$/.test(s) ? `[${s}]` : `.${s}`).join('');
    return `json_extract(${quotedCol}, '${pathSpec.replace(/'/g, "''")}')`;
  },

  geoWithinPolygonClause(quotedCol, field, multiPolygon, params) {
    const srid = field.geo?.srid ?? 4326;
    const wkt = toGeoWKT(multiPolygon, 'lng-lat');
    const pp = this.placeholder(params, wkt);
    return `Within(${quotedCol}, GeomFromText(${pp}, ${srid}))`;
  },
};
