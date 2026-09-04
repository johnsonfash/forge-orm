// Ambient shims for the two optional drivers this repo does not install.
//
// `@duckdb/node-api` is a native addon and `mssql` a heavy client; neither is
// worth a devDependency here, and the adapters never import them — they go
// through the runtime `loadDriver`. The per-dialect entry points DO import
// them statically, because a static import is the whole point of an entry
// point, so tsc needs the names to exist.
//
// The shapes are deliberately loose. Nothing re-exports these: each entry
// hands the client straight to a driver factory that types it properly.

declare module '@duckdb/node-api' {
  export const DuckDBInstance: {
    create(path?: string): Promise<{ connect(): Promise<any> }>;
  };
}

declare module 'mssql' {
  const sql: {
    connect(config: string | Record<string, unknown>): Promise<any>;
  };
  export default sql;
}

declare module '@electric-sql/pglite' {
  export const PGlite: {
    new (dir?: string, opts?: Record<string, unknown>): any;
    create(dir?: string, opts?: Record<string, unknown>): Promise<any>;
  };
}

declare module '@electric-sql/pglite/vector' {
  export const vector: unknown;
}
