// Schema-level types. Kept in their own file so both runtime (DSL helpers)
// and inference helpers can import without circular pain.

export type FieldKind =
  | 'id' // primary key — string in app, ObjectId in db, mapped from `_id`
  | 'objectId' // foreign-key style: string in app, ObjectId in db
  | 'string'
  | 'text' // unbounded string — TEXT on MySQL (vs `string`'s VARCHAR(255))
  | 'int'
  | 'float'
  | 'decimal' // exact numeric; PG numeric(p,s) / MySQL DECIMAL(p,s) / SQLite NUMERIC / Mongo Decimal128. JS: string (no float loss).
  | 'uuid' // PG uuid / MySQL CHAR(36) / SQLite TEXT / Mongo UUID. JS: string.
  | 'bigint' // PG bigint / MySQL BIGINT / SQLite INTEGER / Mongo Long. JS: bigint.
  | 'bool'
  | 'dateTime'
  | 'json'
  | 'enum'
  | 'embed'
  | 'embedMany'
  | 'stringArray'
  | 'intArray'
  // 2D geographic point (WGS84 / SRID 4326). User interacts via { lng, lat };
  // per-dialect storage:
  //   PG:     geography(Point, 4326) — needs PostGIS, or JSON if fallback: true
  //   MySQL:  POINT NOT NULL SRID 4326 (8.0+)
  //   SQLite: SpatiaLite geometry, or JSON if SpatiaLite unavailable
  //   DuckDB: GEOMETRY (spatial extension — auto-loaded)
  //   MSSQL:  GEOGRAPHY (built-in)
  //   Mongo:  GeoJSON Point ({ type, coordinates: [lng, lat] }) as JSON
  | 'geoPoint'
  // Dense numeric vector — embedding storage for semantic / similarity
  // search. The JS-side shape is `number[]` (or Float32Array on read). Per-
  // dialect storage:
  //   PG     → `vector(N)` (pgvector extension)
  //   MySQL  → `VECTOR(N)` (MySQL 9.0+; community = brute-force only)
  //   SQLite → JSON-stored array; sqlite-vec virtual table created out-of-band
  //   DuckDB → `FLOAT[N]` (vss extension's HNSW index works on these)
  //   MSSQL  → `VECTOR(N)` (SQL Server 2025 / Azure SQL)
  //   Mongo  → plain array; Atlas Vector Search index out-of-band
  | 'vector';

export type DefaultValue =
  | { kind: 'now' }
  | { kind: 'autoId' } // generates ObjectId server-side at create
  | { kind: 'literal'; value: any };

export interface FieldDef {
  kind: FieldKind;
  optional: boolean;
  unique: boolean;
  /**
   * Geo-field options (only meaningful when `kind === 'geoPoint'`):
   *   srid:     Spatial Reference System ID. Default 4326 (WGS84 / GPS).
   *             Non-WGS84 SRIDs (e.g. 3857 Web Mercator, 27700 OSGB) are
   *             stored as declared; the JS-side shape stays { lng, lat[, alt] }
   *             but the user provides coordinates in the TARGET SRID's units.
   *             No auto-reprojection is done at the IR layer — apps that
   *             need 4326 ↔ target should run `proj4` at the call site.
   *             Mongo only supports 4326 (2dsphere); non-WGS84 SRIDs warn at
   *             push and run through fallback mode if `fallback: true`.
   *   fallback: When true, the column is stored as JSON ({lng, lat[, alt]})
   *             when the dialect's spatial extension is not installed.
   *             Distance queries fall back to a B-tree-prefiltered Haversine.
   *             Slow for large tables; works without the extension.
   *   dims:     2 (default) or 3. dims=3 opts into XYZ storage — point shape
   *             becomes { lng, lat, alt }. Distance ops still 2D-on-sphere;
   *             altitude is preserved round-trip but not part of `near`.
   */
  geo?: { srid?: number; fallback?: boolean; dims?: 2 | 3 };
  /**
   * Vector-field options (only meaningful when `kind === 'vector'`):
   *   dims:    Vector dimensionality (must match the embedding model output).
   *   metric:  Distance metric — 'cosine' (default) | 'l2' | 'dot'.
   *            Drives both the index-builder and the query-time operator.
   */
  vector?: { dims: number; metric?: 'cosine' | 'l2' | 'dot' };
  default?: DefaultValue;
  updatedAt: boolean;
  // For enum fields: the runtime enum literal-tuple (carried for validation).
  enumValues?: readonly string[];
  // For embed/embedMany: the embedded model definition (resolved lazily).
  embedOf?: () => EmbedDef<any>;
  // When true, `forge:push` auto-emits a full-text index:
  //   PG     → CREATE INDEX … USING gin(to_tsvector('simple', col))
  //   MySQL  → ALTER TABLE … ADD FULLTEXT(col)
  //   Mongo  → createIndex({ col: 'text' })
  //   SQLite → CREATE VIRTUAL TABLE <table>_fts USING fts5(...) +
  //            insert/update/delete triggers to keep it sync'd. Queries
  //            via `where: { col: { search: q } }` are JOINed through the
  //            shadow rowid automatically.
  searchable?: boolean;
  // When true on a dateTime field, this is the soft-delete column. Reads add
  // `WHERE <col> IS NULL`; deletes become updates setting it to now(). One per model.
  softDeleteAt?: boolean;
  // Exact-numeric precision/scale for `decimal` fields. PG numeric(p,s), MySQL
  // DECIMAL(p,s). SQLite NUMERIC ignores them.
  precision?: number;
  scale?: number;
  // When true on a `uuid` field, emit a DB-side default: PG `gen_random_uuid()`,
  // MySQL `(UUID())`. SQLite/Mongo ignore.
  uuidDefault?: boolean;
  // Generated/computed column — holds the SQL expression. PG/MySQL → `GENERATED
  // ALWAYS AS (<expr>) STORED`, SQLite → `AS (<expr>) STORED`, Mongo → ignored
  // (warned). Never written by the client; dropped from inbound create/update data.
  dbGenerated?: string;
  // Primary-key strategy; only meaningful when `kind === 'id'`. Drives DDL
  // emission (string column vs auto-incrementing integer) and whether the client
  // generates an app-side id at create time.
  //   'auto'      — default. App-generated ObjectId on Mongo / UUID on SQL. JS: string.
  //   'uuid'      — DB-side UUID default (PG gen_random_uuid(), MySQL UUID());
  //                 SQLite + Mongo behave like 'auto'. JS: string.
  //   'bigserial' — DB-side auto-incrementing integer (PG BIGSERIAL, MySQL BIGINT
  //                 AUTO_INCREMENT, SQLite INTEGER PRIMARY KEY AUTOINCREMENT).
  //                 Throws on Mongo at push. JS: number.
  idType?: 'auto' | 'uuid' | 'bigserial' | 'string';
}

/**
 * Per-key direction or index type.
 *
 *   1 / -1     — ascending / descending (BTREE on SQL, normal on Mongo).
 *   'text'     — text (full-text) index. PG: text_pattern_ops opclass.
 *                MySQL/SQLite: ignored as a direction (kept as column).
 *                Mongo: real text index.
 *   '2dsphere' — Mongo geospatial (spherical Earth model). Use on a field that
 *                stores GeoJSON. SQL dialects ignore (warn at push).
 *   '2d'       — Mongo legacy flat geospatial. SQL dialects ignore.
 *   'hashed'   — Mongo hashed index. Required for hashed-shard keys.
 *                SQL dialects ignore.
 */
export type IndexKey = 1 | -1 | 'text' | '2dsphere' | '2d' | 'hashed';

/**
 * Universally-supported index method. Affects the access method on SQL
 * dialects via `USING <method>`. Mongo and SQLite ignore.
 *
 *   'btree'    — default. PG default; explicit on MySQL means a plain BTREE.
 *   'gin'      — PG only. Inverted index for jsonb / arrays / pg_trgm.
 *   'gist'     — PG only. Generic / PostGIS geometry / range types.
 *   'brin'     — PG only. Block-range; ideal for huge append-only tables.
 *   'hash'     — PG only. Equality-only, smaller than BTREE for huge unique IDs.
 *   'spatial'  — MySQL only. SPATIAL INDEX over GEOMETRY columns.
 *   'fulltext' — MySQL only. FULLTEXT INDEX (declarative alternative to the
 *                auto-emitted indexes from .searchable()).
 *
 * On a dialect that doesn't support a given method, the push emits the SQL
 * verbatim — the DB itself will reject an unsupported method with a useful
 * error. Mongo/SQLite ignore method entirely.
 */
export type IndexMethod =
  | 'btree'
  | 'gin'
  | 'gist'
  | 'brin'
  | 'hash'
  | 'spatial'
  | 'fulltext'
  | 'vector';
// Note on 'spatial' portability: it resolves per-dialect to whichever
// spatial index family is native — `USING GIST` on Postgres (PostGIS),
// `SPATIAL INDEX` on MySQL, `USING RTREE` on DuckDB, `SPATIAL INDEX` on
// MSSQL, a virtual `idx_<tbl>_<col>` table on SQLite/SpatiaLite, and
// `2dsphere` on Mongo. Use it with `f.geoPoint()` fields for portable
// "find places near me" workloads.

export interface IndexDef {
  /**
   * Column → direction map. For Mongo geospatial / hashed indexes use the
   * specialised IndexKey values ('2dsphere', '2d', 'hashed'). For wildcard
   * indexes use `{ '$**': 1 }` and pair with `wildcardProjection`.
   *
   * Ignored when `expression` is set (expression indexes are keyed off the
   * expression, not column names).
   */
  keys: Record<string, IndexKey>;
  unique?: boolean;
  sparse?: boolean;
  name?: string;
  expireAfterSeconds?: number;
  /**
   * MongoDB only — kept as an alias of `where` for backward compatibility
   * with 2.1.0 callsites. Prefer `where` going forward; it carries the same
   * Mongo semantics and ALSO works on SQL when given a raw SQL string.
   */
  partialFilterExpression?: Record<string, unknown>;
  /**
   * Partial index filter.
   *
   *   Mongo: same as `partialFilterExpression`. Object form only.
   *   SQL (PG / MySQL 8+ functional / SQLite): compiles to
   *     `CREATE INDEX … WHERE <sql>`. Pass a raw SQL expression string
   *     (e.g. `"deleted_at IS NULL"`); objects are not auto-translated on
   *     SQL (use raw SQL since dialect semantics differ).
   *
   * Either set both `where: '...'` (SQL string) and `partialFilterExpression:
   * { ... }` (Mongo object) for cross-dialect schemas, or pass an object that
   * Mongo understands and skip the SQL form.
   */
  where?: Record<string, unknown> | string;
  /**
   * Postgres-only — extra columns appended to the index payload for
   * index-only scans. Compiles to `… INCLUDE (col, …)`. Other dialects
   * ignore (warn).
   */
  include?: string[];
  /**
   * Expression index. Used INSTEAD OF `keys` to index the result of an
   * arbitrary SQL expression — `(lower(email))`, `((data->>'sku'))`, etc.
   *   PG / MySQL 8+ / SQLite: emits `CREATE INDEX name ON tbl ((<expr>))`.
   *   Mongo: ignored (warn). For Mongo, model the computed value as a
   *   stored field via `.dbGenerated(...)` (SQL only) — or persist the
   *   shadow field application-side and index it directly.
   */
  expression?: string;
  /**
   * Index method / access method.
   *
   *   PG: 'btree' (default) | 'gin' | 'gist' | 'brin' | 'hash'
   *   MySQL: undefined (BTREE) | 'spatial' | 'fulltext'
   *   SQLite / Mongo: ignored.
   *
   * Mismatched method on a given dialect doesn't error at compile time —
   * the DB itself raises a clear "access method does not exist" / "unknown
   * index type" if the method isn't supported.
   */
  method?: IndexMethod;
  /**
   * MongoDB only — collation specification for the index. Use to build
   * case- or accent-insensitive indexes:
   *   `{ locale: 'en', strength: 2 }` → case-insensitive.
   * Ignored on SQL dialects (use `expression: 'lower(col)'` instead).
   */
  collation?: {
    locale: string;
    caseLevel?: boolean;
    caseFirst?: 'upper' | 'lower' | 'off';
    strength?: 1 | 2 | 3 | 4 | 5;
    numericOrdering?: boolean;
    alternate?: 'non-ignorable' | 'shifted';
    maxVariable?: 'punct' | 'space';
    backwards?: boolean;
    normalization?: boolean;
  };
  /**
   * MongoDB only — wildcard projection paired with `keys: { '$**': 1 }`
   * to index every field at any depth except the projection. e.g.
   * `{ 'meta.$**': 1 }` to index only paths under `meta`. Ignored on SQL.
   */
  wildcardProjection?: Record<string, unknown>;
  /**
   * MySQL 8.0+ only — when `false`, emits `INVISIBLE` so the optimizer
   * ignores the index. Useful for canary-testing whether an index is
   * load-bearing before dropping it: flip to invisible, observe, then
   * drop if nothing broke. Default `undefined` (visible). Other dialects
   * ignore.
   */
  visible?: boolean;
  /**
   * MySQL only — FULLTEXT parser plugin name. `'ngram'` covers CJK +
   * substring matching; `'mecab'` is the Japanese morphological parser.
   * Only honoured when `method === 'fulltext'` (or `.searchable()` emits
   * a FULLTEXT index). Other dialects ignore.
   */
  parser?: 'ngram' | 'mecab' | string;
}

export type RelationKind = 'one' | 'many';
export type OnDeleteAction = 'Cascade' | 'SetNull' | 'NoAction' | 'Restrict';

export interface RelationDef {
  kind: RelationKind;
  // String key into the schema map (e.g. 'userProfile', 'business'). Resolved
  // at use time via schema[target] — replaces the old `() => Model` thunks
  // to break TypeScript inference cycles between mutually-referencing models.
  target: string;
  // Field name on this model that holds the FK (e.g. `business_id` or `user_email`).
  on: string;
  // Field name on the target referenced (typically `id`, sometimes `email` etc.).
  refs: string;
  // Mirrors Prisma's onDelete. Default NoAction.
  onDelete?: OnDeleteAction;
  // Inverse-side virtual relations (the "list" side of a one-to-many) are
  // not stored in the DB — they're hydrated. Set to true for those so the
  // cascade walker only follows owning sides.
  inverse?: boolean;
}

export interface ModelDef<F extends Record<string, FieldDef>> {
  collection: string;
  fields: F;
  // Lazy thunk so models can be constructed before all their relations are
  // declared. Returns the relation map at call time.
  relations: () => Record<string, RelationDef>;
  indexes: IndexDef[];
  uniques: string[][]; // composite uniques (@@unique([a, b])), merged into indexes at registry-load time

 /** The field every read of this model is filtered by — see ModelOptions.
  *  Declarative only; `doctor` warns when nothing indexes it. */
  scopeBy?: string;

  // When set, this model is a read-only view. The wrapper blocks
  // create/update/delete/upsert; DDL emits CREATE VIEW (or createCollection with
  // viewOn/pipeline on Mongo) instead of CREATE TABLE. `sql` holds the
  // dialect-agnostic SELECT body (no `CREATE VIEW name AS` prefix); `pipeline` is
  // the Mongo aggregation pipeline. The adapter picks one.
  view?: {
    sql?: string;
    pipeline?: unknown[];
    // Source collection (Mongo's createCollection requires it).
    sourceCollection?: string;
    // Materialised view — DDL emits a physical, refreshable object instead of a
    // plain view:
    //   PG     → CREATE MATERIALIZED VIEW; .refresh() runs REFRESH MATERIALIZED VIEW.
    //   MySQL  → base TABLE populated from `sql`; .refresh() truncates + re-INSERTs.
    //   SQLite → same table-backed strategy as MySQL.
    //   Mongo  → `pipeline` ends in $merge/$out; .refresh() re-runs it.
    materialised?: boolean;
    // Optional auto-refresh interval (e.g. '30s', '5m', '1h'). The adapter wires a
    // setInterval calling refresh(), cleared on close().
    refreshEvery?: string;
  };
}

export interface EmbedDef<F extends Record<string, FieldDef>> {
  embedName: string;
  fields: F;
}
