// Adapter interface — every per-database adapter implements this.
//
// Wave 0 keeps the surface intentionally narrow: lifecycle, transactions, and
// a `kind` tag. Wave 1 will add IR-execution methods (`executeSelect`,
// `executeInsert`, `executeUpdate`, `executeDelete`, `executeAggregate`) once
// the query IR is introduced. Wave 2+ adds DDL/migration methods.
//
// Drivers (`mongodb`, `pg`, `mysql2`, `better-sqlite3`) are loaded lazily by
// each adapter inside `connect()` — never imported at module top level — so
// that `npm install forge` doesn't force a peer that the consumer hasn't
// chosen.

export type AdapterKind = 'mongo' | 'postgres' | 'mysql' | 'sqlite';

export interface AdapterCapabilities {
  // Whether the dialect can enforce ON DELETE / FK constraints natively.
  // Mongo emulates these in the JS cascade walker; SQL adapters delegate to
  // the DB engine.
  nativeCascades: boolean;
  // Whether the dialect has native upsert (ON CONFLICT / ON DUPLICATE KEY).
  // Mongo: yes, via findOneAndUpdate({upsert:true}). All four return true.
  nativeUpsert: boolean;
  // Whether the dialect supports `nulls: 'first' | 'last'` in ORDER BY.
  nullsOrdering: boolean;
  // Whether the dialect supports native JSON path operators.
  jsonPath: boolean;
  // Whether the dialect requires a replica set for transactions (Mongo).
  transactionsRequireReplicaSet: boolean;
}

export interface DoctorReport {
  kind: AdapterKind;
  driverPackage: string;
  driverInstalled: boolean;
  driverVersion?: string;
  connectionString?: string;
  capabilities: AdapterCapabilities;
  notes: string[];
}

// ─── Wave 5b — live-schema introspection ─────────────────────────────────────
// A normalized, dialect-agnostic snapshot of what's actually in the database,
// used by `forge:diff` to compare against the declared forge schema.

export interface IntrospectedColumn {
  name: string;
  // Dialect-native type token, lower-cased and trimmed (e.g. 'text', 'integer',
  // 'numeric(10,2)', 'varchar(255)'). Compared loosely by the diff comparator.
  type: string;
  nullable: boolean;
  // Default expression as the DB reports it (or undefined when none).
  default?: string;
}

export interface IntrospectedIndex {
  name: string;
  columns: string[];
  unique: boolean;
}

export interface IntrospectedForeignKey {
  name: string;
  column: string;
  refTable: string;
  refColumn: string;
}

export interface IntrospectedTable {
  name: string;
  columns: IntrospectedColumn[];
  indexes: IntrospectedIndex[];
  foreignKeys: IntrospectedForeignKey[];
}

export interface IntrospectedView {
  name: string;
  // True for materialised views / table-backed views.
  materialised?: boolean;
}

export interface DbIntrospection {
  kind: AdapterKind;
  tables: IntrospectedTable[];
  views: IntrospectedView[];
}

// Per-adapter execute opts. Each adapter narrows this with its own session
// type (Mongo's ClientSession, PG's PoolClient, …). Wave 2b carries this as
// a free-form `unknown` so wrappers can pass through whatever the adapter
// expects without the IR layer learning driver types.
export interface ExecOpts {
  session?: unknown;
  // Wave 4 — executor will emit query/error events when present.
  emitter?: import('../events').ForgeEmitter;
}

export interface Adapter {
  readonly kind: AdapterKind;
  readonly capabilities: AdapterCapabilities;
  // Wave 4 — every adapter owns an emitter. Executors call emitter.track(...)
  // around each query so listeners can observe SQL/duration/rowcount/errors.
  readonly emitter: import('../events').ForgeEmitter;

  // Lifecycle. `connect()` lazily requires the underlying driver and opens a
  // connection pool. Throws an actionable error if the driver isn't installed.
  connect(url: string): Promise<void>;
  close(): Promise<void>;

  // Returns a snapshot of what this adapter knows about its environment.
  // Used by the `forge doctor` script.
  doctor(): Promise<DoctorReport>;

  // Executor surface — IR in, results out. Imports of executor free functions
  // (adapters/<kind>/execute.ts) flow through here so CollectionWrapper stays
  // adapter-agnostic at runtime.
  executeSelect(node: any, model: any, opts?: ExecOpts): Promise<any[]>;
  executeCount(node: any, model: any, opts?: ExecOpts): Promise<number>;
  executeGroupBy(node: any, model: any, opts?: ExecOpts): Promise<any[]>;
  executeInsert(node: any, model: any, opts?: ExecOpts): Promise<{ docs: any[]; count: number }>;
  executeUpdate(node: any, model: any, opts?: ExecOpts): Promise<{ doc?: any; count: number }>;
  executeDelete(node: any, model: any, opts?: ExecOpts): Promise<{ doc?: any; count: number }>;

  // Post-fetch shaping — _count populates + relation hydration. Both adapters
  // implement the same shape; the wrapper calls this for write-then-project
  // (create / update / delete with select/include/omit).
  applyProjectionAndHydration(
    rows: any[], model: any,
    node: { projection?: any; hydration?: any },
    opts?: ExecOpts,
  ): Promise<void>;

  // Open a transaction and run `fn` inside it. The callback receives an
  // opaque session handle (Mongo's ClientSession, PG's PoolClient) that the
  // caller threads through ExecOpts.session to keep every executor call on
  // the same connection / txn. Adapters auto-commit on resolve and roll back
  // on throw.
  $transaction<T>(fn: (session: unknown) => Promise<T>): Promise<T>;

  // Inbound coercion — app-shape data → wire-shape. Mongo remaps `id` to
  // `_id`, converts string ids to ObjectId, ISO dates to Date, applies create
  // defaults. PG is mostly identity (lets pg's type coercion do the work), but
  // stringifies jsonb columns when the caller passed an object.
  coerceInbound(model: any, data: any, opts?: { forCreate?: boolean }): any;

  // Outbound decoding — wire-shape row → app-shape. Mongo remaps `_id` back
  // to `id`, stringifies ObjectIds, converts BSON. PG is identity (pg's type
  // parsers already give us proper JS types).
  decodeOutbound(model: any, row: any): any;

  // Cascade enforcement on delete. Mongo emulates Prisma's onDelete via a
  // walker (since BSON has no native FK constraints). PG is a no-op — the
  // DB engine enforces ON DELETE CASCADE / SET NULL from DDL.
  applyCascadesForDelete(model: any, docs: any[], opts?: ExecOpts): Promise<void>;

  // Raw escape hatches. Postgres / MySQL / SQLite take a SqlFragment built
  // by forge.sql`…` (tagged template — values become placeholders, never
  // interpolated). Mongo throws — use $runCommandRaw or aggregate() for raw
  // Mongo. $queryRaw returns rows; $executeRaw returns affected row count.
  $queryRaw(fragment: import('../raw-sql').SqlFragment, opts?: ExecOpts): Promise<any[]>;
  $executeRaw(fragment: import('../raw-sql').SqlFragment, opts?: ExecOpts): Promise<number>;

  // Wave 4b — optional native cursor streaming. When implemented, replaces
  // the OFFSET/LIMIT chunking fallback in CollectionWrapper.findManyStream.
  //   PG     → pg-cursor
  //   MySQL  → mysql2 stream
  //   SQLite → better-sqlite3 stmt.iterate()
  //   Mongo  → cursor.stream()
  // Adapters that haven't implemented this return undefined → wrapper falls
  // back to OFFSET/LIMIT chunking.
  streamSelect?(node: any, model: any, opts?: ExecOpts): AsyncIterable<any>;

  // Wave 5b — introspect the live database schema for drift detection.
  introspect?(): Promise<DbIntrospection>;

  // Wave 5d — recompute a materialised view from its source definition.
  refreshView?(model: any, opts?: ExecOpts & { concurrently?: boolean }): Promise<void>;
}
