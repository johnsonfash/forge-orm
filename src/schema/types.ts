// Schema-level types. Kept in their own file so both runtime (DSL helpers)
// and inference helpers can import without circular pain.

export type FieldKind =
  | 'id' // primary key — string in app, ObjectId in db, mapped from `_id`
  | 'objectId' // foreign-key style: string in app, ObjectId in db
  | 'string'
  | 'text' // unbounded string — TEXT on MySQL (vs `string`'s VARCHAR(255))
  | 'int'
  | 'float'
  | 'decimal' // Wave 5e — exact numeric; PG numeric(p,s) / MySQL DECIMAL(p,s) / SQLite NUMERIC / Mongo Decimal128. JS type: string (no float loss).
  | 'uuid' // Wave 5e — PG uuid / MySQL CHAR(36) / SQLite TEXT / Mongo UUID. JS type: string.
  | 'bigint' // Wave 5e — PG bigint / MySQL BIGINT / SQLite INTEGER / Mongo Long. JS type: bigint.
  | 'bool'
  | 'dateTime'
  | 'json'
  | 'enum'
  | 'embed'
  | 'embedMany'
  | 'stringArray'
  | 'intArray';

export type DefaultValue =
  | { kind: 'now' }
  | { kind: 'autoId' } // generates ObjectId server-side at create
  | { kind: 'literal'; value: any };

export interface FieldDef {
  kind: FieldKind;
  optional: boolean;
  unique: boolean;
  default?: DefaultValue;
  updatedAt: boolean;
  // For enum fields: the runtime enum literal-tuple (carried for validation).
  enumValues?: readonly string[];
  // For embed/embedMany: the embedded model definition (resolved lazily).
  embedOf?: () => EmbedDef<any>;
  // Wave 4b — when true, `forge:push` auto-emits a full-text index:
  //   PG     → CREATE INDEX … USING gin(to_tsvector('simple', col))
  //   MySQL  → ALTER TABLE … ADD FULLTEXT(col)
  //   Mongo  → createIndex({ col: 'text' })
  //   SQLite → unsupported (would need FTS5 virtual table); emits a warning.
  searchable?: boolean;
  // Wave 4b — when true on a dateTime field, this is the soft-delete column.
  // Reads automatically add `WHERE <col> IS NULL`; deletes become updates that
  // set this column to now(). Only one soft-delete field per model.
  softDeleteAt?: boolean;
  // Wave 5e — exact-numeric precision/scale for `decimal` fields.
  //   PG numeric(p,s), MySQL DECIMAL(p,s). SQLite NUMERIC ignores them.
  precision?: number;
  scale?: number;
  // Wave 5e — when true on a `uuid` field, emit a DB-side default:
  //   PG `DEFAULT gen_random_uuid()`, MySQL `DEFAULT (UUID())`. SQLite/Mongo ignore.
  uuidDefault?: boolean;
  // Wave 5e — generated/computed column. Holds the SQL expression.
  //   PG/MySQL → `GENERATED ALWAYS AS (<expr>) STORED`, SQLite → `AS (<expr>) STORED`.
  //   Mongo → ignored (warned at push). A dbGenerated column is never written by
  //   the client; the wrapper drops it from inbound create/update data.
  dbGenerated?: string;
  // v1.4.0 — primary-key strategy on `id` fields. Only meaningful when
  // `kind === 'id'`; ignored on every other field. Drives the DDL emission
  // (string column vs auto-incrementing integer) and whether the client
  // generates an app-side id at create time.
  //
  //   'auto'      — default. App-generated ObjectId on Mongo / UUID on SQL.
  //                 Stable across all four dialects. JS type: string.
  //   'uuid'      — DB-side UUID default (PG gen_random_uuid(), MySQL
  //                 UUID()). On SQLite + Mongo, equivalent to 'auto'.
  //                 JS type: string.
  //   'bigserial' — DB-side auto-incrementing integer. PG BIGSERIAL, MySQL
  //                 BIGINT AUTO_INCREMENT, SQLite INTEGER PRIMARY KEY
  //                 AUTOINCREMENT. Throws on Mongo at push time. JS type:
  //                 number — `where: { id: 47 }` autocompletes accordingly.
  idType?: 'auto' | 'uuid' | 'bigserial';
}

export type IndexKey = 1 | -1 | 'text';

export interface IndexDef {
  keys: Record<string, IndexKey>;
  unique?: boolean;
  sparse?: boolean;
  name?: string;
  expireAfterSeconds?: number;
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
  uniques: string[][]; // composite uniques (@@unique([a, b]))
  // Compound indexes already include @@index entries; uniques merged into indexes
  // at registry-load time.

  // Wave 4c — when set, this model is a read-only view. The wrapper blocks
  // create/update/delete/upsert; DDL emits CREATE VIEW (or createCollection
  // with viewOn/pipeline on Mongo) instead of CREATE TABLE. `sql` holds the
  // dialect-agnostic SELECT body (without the `CREATE VIEW name AS` prefix);
  // `pipeline` is the Mongo aggregation pipeline. Adapter-specific behaviour
  // picks one or the other.
  view?: {
    sql?: string;
    pipeline?: unknown[];
    // Source collection (Mongo's createCollection requires it).
    sourceCollection?: string;
    // Wave 5d — materialised view. When true, DDL emits a physical, refreshable
    // object instead of a plain view:
    //   PG     → CREATE MATERIALIZED VIEW; .refresh() runs REFRESH MATERIALIZED VIEW.
    //   MySQL  → a base TABLE populated from `sql`; .refresh() truncates + re-INSERTs.
    //   SQLite → same table-backed strategy as MySQL.
    //   Mongo  → `pipeline` ends in $merge/$out into a target collection; .refresh() re-runs it.
    materialised?: boolean;
    // Wave 5d — optional auto-refresh interval (e.g. '30s', '5m', '1h'). The
    // adapter wires a setInterval that calls refresh(); it's cleared on close().
    refreshEvery?: string;
  };
}

export interface EmbedDef<F extends Record<string, FieldDef>> {
  embedName: string;
  fields: F;
}
