// Compile artifacts — typed shapes returned by `db.<model>.compile.<op>(args)`.
// The escape hatch: build a query through forge's typed API, get back an object
// (Mongo) or SQL + params (SQL dialects) to hand directly to the driver you
// installed yourself. The discriminated union on `kind` lets TS narrow per adapter.

export type CompiledArtifact =
  | MongoArtifact
  | SQLArtifact;

// ─── Mongo ──────────────────────────────────────────────────────────────────

export type MongoOp =
  | 'find'
  | 'findOne'
  | 'countDocuments'
  | 'insertOne'
  | 'insertMany'
  | 'updateOne'
  | 'updateMany'
  | 'findOneAndUpdate'
  | 'findOneAndDelete'
  | 'deleteOne'
  | 'deleteMany'
  | 'aggregate';

export interface MongoArtifact {
  kind: 'mongo';
  collection: string;
  op: MongoOp;
  // Per-op argument bundle. Each op's `args` is the exact positional payload
  // for the corresponding mongodb driver method:
  //
  //   find:               { filter, options }              — collection.find(filter, options)
  //   findOne:            { filter, options }              — collection.findOne(filter, options)
  //   countDocuments:     { filter, options }              — collection.countDocuments(filter, options)
  //   insertOne:          { document, options? }           — collection.insertOne(document)
  //   insertMany:         { documents, options? }          — collection.insertMany(documents, options)
  //   updateOne:          { filter, update, options? }     — collection.updateOne(filter, update)
  //   updateMany:         { filter, update, options? }     — collection.updateMany(filter, update)
  //   findOneAndUpdate:   { filter, update, options? }     — collection.findOneAndUpdate(filter, update, options)
  //   findOneAndDelete:   { filter, options? }             — collection.findOneAndDelete(filter, options)
  //   deleteOne:          { filter, options? }             — collection.deleteOne(filter, options)
  //   deleteMany:         { filter, options? }             — collection.deleteMany(filter, options)
  //   aggregate:          { pipeline, options? }           — collection.aggregate(pipeline, options)
  args: Record<string, any>;
  // Post-fetch hydration plan when the caller passed `include` or relation
  // `select` — IDs to hydrate aren't known until the primary query runs,
  // so this is an informational note for downstream tooling.
  hydration?: Array<{ relation: string; via: 'one' | 'many'; target: string; on: string; refs: string }>;
}

// ─── SQL (Postgres / MySQL / SQLite) ────────────────────────────────────────
//
// Single shape across SQL dialects; the `dialect` field narrows for callers
// that care about quoting conventions or driver placeholder syntax.

export type SQLDialect = 'postgres' | 'mysql' | 'sqlite';

export interface SQLArtifact {
  kind: 'sql';
  dialect: SQLDialect;
  // Parameterised SQL — never interpolate values into the string directly,
  // always use `params`. Postgres uses `$1, $2, ...`, MySQL/SQLite use `?`.
  sql: string;
  params: unknown[];
  // Optional: per-step plan for queries that produce multiple statements
  // (e.g. a write inside a transaction that needs `RETURNING`-then-hydrate).
  steps?: SQLArtifact[];
}

// ─── Compile namespace type per-adapter ─────────────────────────────────────
//
// A model's compile namespace exposes one method per op, mirroring the args
// of the corresponding execute method but returning a typed Compiled artifact
// instead of a Promise<Row>. Mongo surface is `MongoCompileApi`, SQL surface
// is `SQLCompileApi` — CollectionWrapper picks based on the active adapter.

export interface MongoCompileApi<F = any, R = any> {
  findFirst(args?: any): MongoArtifact;
  findUnique(args: any): MongoArtifact;
  findMany(args?: any): MongoArtifact;
  count(args?: any): MongoArtifact;
  create(args: any): MongoArtifact;
  createMany(args: any): MongoArtifact;
  update(args: any): MongoArtifact;
  updateMany(args: any): MongoArtifact;
  upsert(args: any): MongoArtifact;
  delete(args: any): MongoArtifact;
  deleteMany(args?: any): MongoArtifact;
  /**
   * Soft delete — set the model's `.softDeleteAt()` field to `now()`. Throws at
   * call time if the model has no soft-delete field.
   */
  softDelete(args: any): MongoArtifact;
  softDeleteMany(args?: any): MongoArtifact;
  /** Restore a soft-deleted row — clear the `.softDeleteAt()` field. */
  restore(args: any): MongoArtifact;
  restoreMany(args?: any): MongoArtifact;
  aggregate(args: { pipeline: any[]; options?: any }): MongoArtifact;
}

export interface SQLCompileApi<F = any, R = any> {
  findFirst(args?: any): SQLArtifact;
  findUnique(args: any): SQLArtifact;
  findMany(args?: any): SQLArtifact;
  count(args?: any): SQLArtifact;
  create(args: any): SQLArtifact;
  createMany(args: any): SQLArtifact;
  update(args: any): SQLArtifact;
  updateMany(args: any): SQLArtifact;
  upsert(args: any): SQLArtifact;
  delete(args: any): SQLArtifact;
  deleteMany(args?: any): SQLArtifact;
  /**
   * Soft delete — set the model's `.softDeleteAt()` field to `now()`. Throws at
   * call time if the model has no soft-delete field.
   */
  softDelete(args: any): SQLArtifact;
  softDeleteMany(args?: any): SQLArtifact;
  /** Restore a soft-deleted row — clear the `.softDeleteAt()` field. */
  restore(args: any): SQLArtifact;
  restoreMany(args?: any): SQLArtifact;
}

export type CompileApi<F = any, R = any> = MongoCompileApi<F, R> | SQLCompileApi<F, R>;
