export { createDb } from './factory';
export type { ForgeDb, CreateDbOptions, CreateDbOptionsUrl, CreateDbOptionsStructured, CreateDbOptionsDriver } from './factory';

// Pluggable SQLite drivers — wrap your raw driver and pass it as createDb({ driver }).
//   createDb({ schema, driver: libsqlDriver(client) })          // Turso / edge
//   createDb({ schema, driver: expoSqliteDriver(SQLite.openDatabaseSync('app.db')) })  // Expo/RN
//   createDb({ schema, driver: wasmSqliteDriver({ worker }) })  // browser (sqlite-wasm + OPFS)
export {
  betterSqlite3Driver, expoSqliteDriver, opSqliteDriver, libsqlDriver, isSqliteDriver,
} from './adapters/sqlite/driver';
export type { SqliteDriver } from './adapters/sqlite/driver';
export { wasmSqliteDriver, isWasmSqliteDriver } from './adapters/sqlite/wasm-driver';
export type { WasmDriverOptions } from './adapters/sqlite/wasm-driver';
// Pluggable Postgres drivers — pg (default) or postgres.js.
//   createDb({ schema, driver: postgresJsDriver(postgres(url)) })
export { pgDriver, postgresJsDriver, isPostgresDriver } from './adapters/postgres/driver';
export type { PostgresDriver, PgQueryable } from './adapters/postgres/driver';
// Pluggable MySQL drivers — mysql2 (default), mariadb, or PlanetScale.
export { mysql2Driver, mariadbDriver, planetscaleDriver, isMysqlDriver } from './adapters/mysql/driver';
export type { MysqlDriver, MysqlQueryable } from './adapters/mysql/driver';
// Pluggable Mongo — bring your own MongoClient (DocumentDB/Cosmos/FerretDB/custom).
//   createDb({ schema, driver: mongoDriver(new MongoClient(uri, opts), 'mydb') })
export { mongoDriver, isMongoDriver } from './adapters/mongo/driver';
export type { MongoDriver } from './adapters/mongo/driver';
// DuckDB — embedded analytics DB. Default driver wraps @duckdb/node-api.
//   createDb({ schema, driver: duckdbDriver(connection) })
export { duckdbDriver, isDuckdbDriver } from './adapters/duckdb/driver';
export type { DuckdbDriver, DuckdbQueryable } from './adapters/duckdb/driver';
// SQL Server — T-SQL. Default driver wraps the `mssql` package (Tedious).
//   createDb({ schema, driver: mssqlDriver(pool) })
export { mssqlDriver, isMssqlDriver } from './adapters/mssql/driver';
export type { MssqlDriver, MssqlQueryable } from './adapters/mssql/driver';
export type { Adapter, AdapterKind, AdapterCapabilities, DoctorReport } from './adapters/types';
export { ForgeMissingDriverError } from './adapters/missing-driver';
export { detectAdapterKind } from './adapters/detect';
export type {
  CompiledArtifact,
  MongoArtifact, MongoOp, MongoCompileApi,
  SQLArtifact, SQLDialect, SQLCompileApi,
  CompileApi,
} from './compile';

// ─── Query IR (adapter-agnostic intermediate representation) ────────────────
export type {
  IRNode,
  SelectNode, InsertNode, UpdateNode, DeleteNode, CountNode, AggregateNode,
  WhereTree, WhereLeaf, WhereAnd, WhereOr, WhereNot, WhereRelation, WhereOp,
  ProjectionPlan, RelationPlan, OrderByEntry, CursorSpec,
} from './ir/types';
export {
  buildSelect, buildCount, buildInsert, buildUpdate, buildDelete, buildGroupBy,
  buildWhereTree, buildOrderBy, buildProjection, buildUpdateData, buildCursor,
} from './ir/build';

// ─── Column references — field-to-field comparison in `where` ───────────────
export { col, isColRef, FORGE_COL } from './col';
export type { ColRef } from './col';

// ─── JSON-null markers ──────────────────────────────────────────────────────
export {
  ForgeDbNull, ForgeJsonNull, ForgeAnyNull, isForgeNullMarker,
} from './null-markers';

// ─── Validator helper ───────────────────────────────────────────────────────
export { forgeValidator } from './validator';

// ─── Schema DSL — define YOUR OWN models, then `createDb({ schema })` ───────
export { f, model, rel, enums, embed } from './schema/core';
export type { Field, TypedModel, RelationInfo, EnumDef, ModelOptions } from './schema/core';
export type { FieldDef, FieldKind, ModelDef, IndexDef, IndexKey, IndexMethod, RelationDef, OnDeleteAction, EmbedDef } from './schema/types';
// Bundled sample schema (blog/CMS) — the default when you don't pass your own.
// `SchemaShape` is the structural type any schema map satisfies.
export { sampleSchema } from './schema';
export { setActiveSchema, getActiveSchema } from './schema/active';
export type { SchemaShape } from './schema/active';

// ─── Per-model ergonomic type bundle (Prisma-shape DX, no codegen) ──────────
// ForgeOf<'user'>['WhereInput']        — generic accessor (any schema key)
// ForgeModels['User']['CreateInput']   — capitalised dotted lookup
export type { ForgeOf, ForgeModels, PerModelTypes } from './forge-types';

// ─── Direct-from-model inference (no SchemaMap registration required) ──────
//   InferCreate / InferUpdate / InferWhere<typeof User>, Infer<typeof User>
//   (.Row/.Where/.Create/.Update/…), InferSchema<typeof mySchema>
export type {
  Infer,
  InferRow,
  InferWhere,
  InferWhereUnique,
  InferCreate,
  InferUpdate,
  InferUpsert,
  InferOrderBy,
  InferSelect,
  InferInclude,
  InferOmit,
  InferSchema,
} from './infer';

// ─── Adapter compile APIs (escape hatch: build SQL/Mongo, run yourself) ─────
export { buildPostgresCompileApi } from './adapters/postgres/compile';

// ─── Raw SQL escape hatch ───────────────────────────────────────────────────
// Tagged template + composition helpers — safe by default (values become
// placeholders, never interpolated).
export { forgeSql, isSqlFragment, compileSqlFragment } from './raw-sql';
export type { SqlFragment, CompiledRawSql } from './raw-sql';

// Observability event types. Subscribe via db.$on('query'|'error', cb).
export type { QueryEvent, ErrorEvent, EventListener } from './events';
export { ForgeEmitter } from './events';
// OpenTelemetry helper (structural — @opentelemetry/api stays optional).
export { wireOtel } from './observability/otel';
export type { OtelTracer, OtelSpan, WireOtelOptions } from './observability/otel';

// Mongo connection singleton (used internally by the Mongo adapter's default path).
export { dbClient } from './client';

// ─── Schema (sample blog/CMS) ───────────────────────────────────────────────
// The shipped schema is a sample. To use forge elsewhere, replace
// src/schema/index.ts with that project's models and re-export Row types here
// the same way (or consume ForgeOf<'modelKey'> / ForgeModels['Name']).
export {
  schema,
  User, Profile, Post, Comment, Tag, PostTag, Like, AuditLog,
  Role, PostStatus, LikeKind,
  AddressEmbed, SocialLinkEmbed, RevisionEmbed,
} from './schema';
export type { SchemaMap, Role as RoleT, PostStatus as PostStatusT, LikeKind as LikeKindT } from './schema';

import {
  User as _User, Profile as _Profile, Post as _Post, Comment as _Comment,
  Tag as _Tag, PostTag as _PostTag, Like as _Like, AuditLog as _AuditLog,
} from './schema';
import { Row } from './schema/core';

// ─── Named row types (Prisma-style imports work) ────────────────────────────
// Sample-schema row shapes; real projects rename these to match their models.
export type UserRow      = Row<typeof _User>;
export type ProfileRow   = Row<typeof _Profile>;
export type PostRow      = Row<typeof _Post>;
export type CommentRow   = Row<typeof _Comment>;
export type TagRow       = Row<typeof _Tag>;
export type PostTagRow   = Row<typeof _PostTag>;
export type LikeRow      = Row<typeof _Like>;
export type AuditLogRow  = Row<typeof _AuditLog>;

// Export `Row` for advanced inference (e.g. `Row<typeof MyModel>`).
export type { Row } from './schema/core';

// ─── Errors ─────────────────────────────────────────────────────────────────
export { DbKnownError } from './adapters/mongo/errors';

// ─── Drift detection (programmatic API behind `forge diff`) ─────────────────
export {
  diffIntrospection,
  expectedFromSchema,
  formatDriftReport,
  parseIgnoreList,
} from './scripts/diff-core';
export type {
  DriftItem,
  DriftReport,
  IgnoreSpec,
} from './scripts/diff-core';

// ─── Runtime DDL apply (browser/wasm replacement for `forge push`) ──────────
// Also available as `db.$migrate()` on any sqlite-adapter ForgeDb. Since 2.5.1
// also applies non-destructive drift (ADD COLUMN for missing columns) and
// reports destructive items under `pending`.
export { runMigrate } from './wasm/migrate';
export type { RuntimeMigrateOptions, RuntimeApplyReport } from './wasm/migrate';
export { applyDrift } from './wasm/drift-apply';
export type { DriftApplyReport } from './wasm/drift-apply';
// Browser feature-detection probe — mirror of the CLI doctor for the wasm path.
export { browserDoctor } from './wasm/browser-doctor';
export type { BrowserDoctorReport } from './wasm/browser-doctor';
// Schema → DDL emitter (sqlite dialect). Useful for tools that want to inspect
// or persist the migration SQL — the runtime $migrate path uses this internally.
export { buildSchemaDDL as buildSqliteSchemaDDL } from './adapters/sqlite/ddl';
export { applyMigration as applySqliteMigration } from './adapters/sqlite/migrate';
export type { ApplyReport } from './adapters/sqlite/migrate';

// Convenience alias for ForgeModels.
export type { ForgeModels as Forge } from './forge-types';
