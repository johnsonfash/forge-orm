import { ClientSession, Collection, Document } from 'mongodb';
import { dbClient } from '../adapters/mongo/client';
import {
  CreateInput,
  CursorInput,
  Field,
  IncludeInputFor,
  NoBothSelectInclude,
  OrderByInput,
  RelationInfo,
  Resolve,
  SelectInputFor,
  TypedModel,
  UpdateInput,
  WhereInput,
} from '../schema/core';
import { schema, SchemaMap } from '../schema';
import { ModelDef, RelationDef } from '../schema/types';
import { coerceExtendedJSON } from '../adapters/mongo/coerce';
import { DbKnownError, notFoundError } from '../adapters/mongo/errors';
import { buildMongoCompileApi } from '../adapters/mongo/compile';
import type { MongoCompileApi } from '../compile';
import { buildCount, buildDelete, buildGroupBy, buildInsert, buildProjection, buildSelect, buildUpdate } from '../ir/build';
import type { Adapter } from '../adapters/types';
import { getDefaultMongoAdapter } from '../adapters/mongo/adapter';

type ResolvedRow<F extends Record<string, Field<any, any>>> = {
  [K in keyof F]: F[K] extends Field<infer T, any> ? T : never;
};

// ============================================================================
// CollectionWrapper — Prisma-shape API over a Mongo collection.
//
// Methods mirrored:
//   findFirst, findUnique, findFirstOrThrow, findUniqueOrThrow, findMany,
//   create, createMany, update, updateMany, upsert, delete, deleteMany,
//   count, aggregate.
//
// Cross-cutting features:
//   • _id ↔ id remap, ObjectId/Date coercion driven by the schema (no
//     hardcoded field-name lists).
//   • Default values: f.id() → ObjectId; .default('now') → Date; literals
//     applied at create time. .updatedAt() applied automatically on update.
//   • Relation hydration via post-fetch batched queries (see relations.ts).
//   • Nested writes: { rel: { create, createMany, connect } } on inverse-
//     side many relations, and { rel: { connect } } on owning one-side.
//   • Cascade deletes mirroring the schema's onDelete: Cascade / SetNull.
//   • Session binding for $transaction — every operation accepts the tx
//     session via withSession(session).
// ============================================================================

interface NestedSpec {
  rel: RelationDef;
  op:
    | 'create' | 'createMany' | 'connect' | 'connectOrCreate'
    | 'disconnect' | 'set' | 'delete' | 'deleteMany';
  data: any;
}

// Schema-bound aliases — resolved against the schema-map type `SM` (the
// consumer's schema, or the bundled sample by default). Threading SM lets
// include/select resolve relation TARGETS against whichever schema this wrapper
// belongs to, so a custom consumer schema gets full nested typing.
type Find1<
  F extends Record<string, Field<any, any>>,
  R extends Record<string, RelationInfo>,
  Args,
  SM extends Record<string, TypedModel<any, any>>,
> = Resolve<F, R, Args, SM>;
type ICreate<F extends Record<string, Field<any, any>>, R extends Record<string, RelationInfo>> = CreateInput<F, R>;
type IUpdate<F extends Record<string, Field<any, any>>, R extends Record<string, RelationInfo>> = UpdateInput<F, R>;
type ISelect<
  F extends Record<string, Field<any, any>>,
  R extends Record<string, RelationInfo>,
  SM extends Record<string, TypedModel<any, any>>,
> = SelectInputFor<F, R, SM>;
type IInclude<
  R extends Record<string, RelationInfo>,
  SM extends Record<string, TypedModel<any, any>>,
> = IncludeInputFor<R, SM>;

export class CollectionWrapper<
  F extends Record<string, Field<any, any>> = any,
  R extends Record<string, RelationInfo> = Record<string, RelationInfo>,
  SM extends Record<string, TypedModel<any, any>> = SchemaMap,
> {
  private _collection?: Collection<Document>;
  private _compileApi?: MongoCompileApi;
  // Adapter that drives execute / coerce / decode / cascade. Defaults to the
  // lazily-built Mongo singleton so DatabaseService (Nest) and other Mongo
  // consumers work without surgery. createDb() in factory.ts injects the
  // active adapter explicitly when the user picked Postgres / MySQL / SQLite.
  constructor(
    public model: ModelDef<any>,
    private _session?: unknown,
    private _adapter?: Adapter,
    private _strict: boolean = false,
  ) {}

  protected get adapter(): Adapter {
    return this._adapter ?? getDefaultMongoAdapter();
  }

  // Wave 5e — strict mode. When createDb({ strict: true }) is set, reject any
  // `where` key that isn't a real field, a known synthetic composite-unique
  // key, a relation name, or a recognised logical/structural operator. This
  // closes the `[key: string]: any` escape hatch on WhereInput so typos surface
  // instead of silently matching nothing.
  private static readonly _whereOps = new Set([
    'AND', 'OR', 'NOT', '_withDeleted',
  ]);
  private _strictKeysCache?: Set<string>;
  private _allowedWhereKeys(): Set<string> {
    if (this._strictKeysCache) return this._strictKeysCache;
    const keys = new Set<string>(CollectionWrapper._whereOps);
    for (const fieldName of Object.keys(this.model.fields)) keys.add(fieldName);
    for (const rel of Object.keys(this.model.relations())) keys.add(rel);
    // Synthetic composite-unique keys mirror Prisma: ['a','b'] → 'a_b'.
    for (const cols of this.model.uniques ?? []) keys.add(cols.join('_'));
    this._strictKeysCache = keys;
    return keys;
  }
  private _assertStrictWhere(where: any): void {
    if (!this._strict || !where || typeof where !== 'object') return;
    const allowed = this._allowedWhereKeys();
    for (const key of Object.keys(where)) {
      if (allowed.has(key)) continue;
      throw new Error(
        `[forge:strict] unknown where key '${key}' on '${this.model.collection}'.\n` +
        `  Known fields: ${Object.keys(this.model.fields).join(', ')}.\n` +
        `  (strict mode is on — disable with createDb({ strict: false }) to allow loose keys.)`,
      );
    }
  }

  // Returns a session-bound wrapper for use inside $transaction(callback).
  // The wrapper shares the same model definition + adapter; only the session
  // differs. The adapter's session type (Mongo: ClientSession, PG: PoolClient)
  // flows through opaquely via _session.
  withSession(session: unknown): CollectionWrapper<F, R, SM> {
    return new CollectionWrapper<F, R, SM>(this.model, session, this._adapter, this._strict);
  }

  // Compile namespace — same arg shape as the execute methods, but returns a
  // typed artifact instead of executing. Useful for: forwarding to a manually
  // managed driver, generating migration/seed scripts, debugging, replay/audit.
  //   const c = db.user.compile.findMany({ where: { active: true }, take: 20 });
  //   await client.db().collection(c.collection)[c.op](c.args.filter, c.args.options).toArray();
  get compile(): MongoCompileApi {
    if (!this._compileApi) this._compileApi = buildMongoCompileApi(this.model);
    return this._compileApi;
  }

  private get collection(): Collection<Document> {
    if (!this._collection) {
      this._collection = dbClient.db.collection(this.model.collection);
    }
    return this._collection;
  }

  private get sessOpt() {
    return this._session ? { session: this._session } : {};
  }

  // ─── Reads ────────────────────────────────────────────────────────────

  async findFirst<A extends {
    where?: WhereInput<F>;
    select?: ISelect<F, R, SM>;
    include?: IInclude<R, SM>;
    omit?: { [K in keyof F]?: boolean };
    orderBy?: OrderByInput<F> | OrderByInput<F>[];
    take?: number;
    limit?: number;
    skip?: number;
    offset?: number;
    cursor?: CursorInput;
    distinct?: Array<keyof F & string>;
  }>(args: A & NoBothSelectInclude<A> = {} as any): Promise<Find1<F, R, A, SM> | null> {
    const result = await this._find(args, 1);
    return (result[0] as Find1<F, R, A, SM>) ?? null;
  }

  async findUnique<A extends {
    where: WhereInput<F>;
    select?: ISelect<F, R, SM>;
    include?: IInclude<R, SM>;
    omit?: { [K in keyof F]?: boolean };
  }>(args: A & NoBothSelectInclude<A>): Promise<Find1<F, R, A, SM> | null> {
    return this.findFirst(args as any) as any;
  }

  async findFirstOrThrow<A extends {
    where?: WhereInput<F>;
    select?: ISelect<F, R, SM>;
    include?: IInclude<R, SM>;
    omit?: { [K in keyof F]?: boolean };
    orderBy?: OrderByInput<F> | OrderByInput<F>[];
    take?: number;
    limit?: number;
    skip?: number;
    offset?: number;
    cursor?: CursorInput;
    distinct?: Array<keyof F & string>;
  }>(args: A & NoBothSelectInclude<A> = {} as any): Promise<Find1<F, R, A, SM>> {
    const r = await this.findFirst(args);
    if (!r) throw notFoundError(this.model.collection, args.where);
    return r;
  }

  async findUniqueOrThrow<A extends {
    where: WhereInput<F>;
    select?: ISelect<F, R, SM>;
    include?: IInclude<R, SM>;
    omit?: { [K in keyof F]?: boolean };
  }>(args: A & NoBothSelectInclude<A>): Promise<Find1<F, R, A, SM>> {
    const r = await this.findUnique(args);
    if (!r) throw notFoundError(this.model.collection, args.where);
    return r;
  }

  async findMany<A extends {
    where?: WhereInput<F>;
    select?: ISelect<F, R, SM>;
    include?: IInclude<R, SM>;
    omit?: { [K in keyof F]?: boolean };
    orderBy?: OrderByInput<F> | OrderByInput<F>[];
    take?: number;
    limit?: number;
    skip?: number;
    offset?: number;
    cursor?: CursorInput;
    distinct?: Array<keyof F & string>;
  }>(args: A & NoBothSelectInclude<A> = {} as any): Promise<Find1<F, R, A, SM>[]> {
    return this._find(args, undefined) as Promise<Find1<F, R, A, SM>[]>;
  }

  // Wave 4 — streaming reads.
  //
  // Returns an AsyncIterable that yields rows one-by-one (or in driver-sized
  // batches) without buffering the full result set. Use for large exports,
  // batch jobs, anything where the result set could exceed available memory.
  //
  // Per-adapter strategy:
  //   • Postgres: pg's pool query with rowMode=array isn't easy to stream from
  //     a pool without `pg-cursor`. Fallback: chunked OFFSET/LIMIT loop with
  //     `chunkSize` (default 1000). Cursor-based streaming will be the Wave 5
  //     polish.
  //   • MySQL: mysql2 supports `connection.query(sql).stream()` natively.
  //   • SQLite: better-sqlite3's `stmt.iterate()` is the canonical stream API.
  //   • Mongo: native cursor — `collection.find().stream()`.
  //
  // Hydration / include / select inside streams: only the leaf rows are
  // streamed; relation hydration is not batched across the stream. If you
  // need include, materialise the chunk first (findMany on each chunk).
  async *findManyStream<A extends {
    where?: WhereInput<F>;
    orderBy?: OrderByInput<F> | OrderByInput<F>[];
    chunkSize?: number;
  }>(args: A = {} as A): AsyncIterable<ResolvedRow<F>> {
    // Wave 4b — prefer adapter-native streaming (PG cursor, MySQL stream,
    // SQLite iterate, Mongo cursor) when implemented. Falls back to
    // OFFSET/LIMIT chunking otherwise.
    if (typeof (this.adapter as any).streamSelect === 'function') {
      const mk = this._modelKey();
      const filtered = this._withSoftDeleteFilter(args);
      const node = buildSelect(mk, this.model, filtered ?? {}, 'many', schema as any);
      const iter = (this.adapter as any).streamSelect(node, this.model, { session: this._session });
      for await (const row of iter) yield row as ResolvedRow<F>;
      return;
    }
    // Fallback (kept for any future adapter without streamSelect).
    const chunkSize = args.chunkSize ?? 1000;
    let offset = 0;
    while (true) {
      const batch = await this._find({ ...args, take: chunkSize, skip: offset, chunkSize: undefined }, undefined);
      if (!Array.isArray(batch) || batch.length === 0) return;
      for (const row of batch) yield row as ResolvedRow<F>;
      if (batch.length < chunkSize) return;
      offset += batch.length;
    }
  }

  async count(args: { where?: WhereInput<F>; distinct?: Array<keyof F & string> } = {}): Promise<number> {
    this._assertStrictWhere(args?.where);
    const mk = this._modelKey();
    args = this._withSoftDeleteFilter(args);
    const node = buildCount(mk, this.model, args, schema as any);
    return this.adapter.executeCount(node, this.model, { session: this._session });
  }

  // groupBy — typed aggregation. Each row of the result is shaped as
  //   `{ <by-col>: value, _count?: {...}, _avg?: {...}, _sum?: {...}, _min?: {...}, _max?: {...} }`
  // `_count._all` is the synthetic COUNT(*) bucket; per-column counts go in
  // `_count.<colName>`. `having` mirrors Prisma's post-aggregate filter shape.
  async groupBy<A extends {
    by: Array<keyof F & string>;
    where?: WhereInput<F>;
    having?: Record<string, any>;
    _count?: { _all?: boolean } & { [K in keyof F]?: boolean };
    _avg?:   { [K in keyof F]?: boolean };
    _sum?:   { [K in keyof F]?: boolean };
    _min?:   { [K in keyof F]?: boolean };
    _max?:   { [K in keyof F]?: boolean };
    orderBy?: OrderByInput<F> | OrderByInput<F>[];
    take?: number; limit?: number;
    skip?: number; offset?: number;
  }>(args: A): Promise<any[]> {
    const mk = this._modelKey();
    const node = buildGroupBy(mk, this.model, args as any, schema as any);
    return this.adapter.executeGroupBy(node, this.model, { session: this._session });
  }

  // Lazily resolve the schema-side key for this model — needed by IR builders
  // (which want a portable string key, not a collection name) and the
  // executor (for schema-aware hydration recursion).
  private _modelKey(): string {
    if (this._cachedKey) return this._cachedKey;
    for (const key of Object.keys(schema as any)) {
      if ((schema as any)[key] === this.model) {
        this._cachedKey = key;
        return key;
      }
    }
    // Fall back to collection name for ad-hoc models (used by IR tests).
    this._cachedKey = this.model.collection;
    return this._cachedKey;
  }
  private _cachedKey?: string;

  // ─── Writes ───────────────────────────────────────────────────────────

  // Wave 4c — block writes on read-only view models.
  private _assertWritable(op: string): void {
    if ((this.model as any).view) {
      throw new Error(
        `[forge] ${op} is not allowed on '${this.model.collection}' — it's a read-only view.\n` +
        `  Use the underlying source model for writes, or drop .asView() from the schema.`,
      );
    }
  }

  async create<A extends {
    data: ICreate<F, R>;
    select?: ISelect<F, R, SM>;
    include?: IInclude<R, SM>;
    omit?: { [K in keyof F]?: boolean };
  }>(args: A & NoBothSelectInclude<A>): Promise<Find1<F, R, A, SM>> {
    this._assertWritable('create');
    const mk = this._modelKey();
    const { scalar, nested } = this._splitNestedWrites(args.data, /*forCreate*/ true);
    // Resolve owning-side connectOrCreate first — sets the FK on `scalar` so
    // the parent insert satisfies the FK constraint.
    const resolvedScalar = await this._resolveOwningConnectOrCreate(scalar, nested);
    const row = this.adapter.coerceInbound(this.model, resolvedScalar);
    const node = buildInsert(mk, this.model, { rows: [row] }, schema as any);
    const { docs } = await this.adapter.executeInsert(node, this.model, { session: this._session });
    const doc = docs[0];
    if (nested.length > 0) await this._applyNestedWrites(doc, nested);
    return this._returnOne(doc, args);
  }

  // Resolve owning-side `connectOrCreate` specs eagerly — sets the FK column
  // on `scalar` before insert. Mutates `nested` to remove processed specs so
  // _applyNestedWrites doesn't double-process them.
  private async _resolveOwningConnectOrCreate(scalar: any, nested: NestedSpec[]): Promise<any> {
    if (!nested.length) return scalar;
    const out = { ...scalar };
    for (let i = nested.length - 1; i >= 0; i--) {
      const spec = nested[i];
      if (spec.op !== 'connectOrCreate' || spec.rel.inverse) continue;
      const target = (schema as any)[spec.rel.target] as ModelDef<any> | undefined;
      if (!target) continue;
      const w = new CollectionWrapper(target, this._session, this._adapter);
      const items: any[] = Array.isArray(spec.data) ? spec.data : [spec.data];
      // Owning-one expects a single item — first wins.
      const it = items[0];
      if (!it?.where) continue;
      let existing: any = await w.findFirst({ where: it.where });
      if (!existing) existing = await w.create({ data: it.create ?? {} });
      const tId = existing[spec.rel.refs] ?? existing.id ?? existing._id;
      out[spec.rel.on] = tId;
      nested.splice(i, 1);
    }
    return out;
  }

  async createMany(args: {
    data: ICreate<F, R>[];
    skipDuplicates?: boolean;
  }): Promise<{ count: number }> {
    this._assertWritable('createMany');
    if (!Array.isArray(args.data) || args.data.length === 0) return { count: 0 };
    const mk = this._modelKey();
    const rows = args.data.map((d) => this.adapter.coerceInbound(this.model, d));
    const node = buildInsert(
      mk, this.model,
      { rows, skipDuplicates: args.skipDuplicates },
      schema as any,
    );
    const { count } = await this.adapter.executeInsert(node, this.model, { session: this._session });
    return { count };
  }

  async update<A extends {
    where: WhereInput<F>;
    data: IUpdate<F, R>;
    select?: ISelect<F, R, SM>;
    include?: IInclude<R, SM>;
    omit?: { [K in keyof F]?: boolean };
  }>(args: A & NoBothSelectInclude<A>): Promise<Find1<F, R, A, SM>> {
    this._assertWritable('update');
    this._assertStrictWhere(args.where);
    const mk = this._modelKey();
    const { scalar, nested } = this._splitNestedWrites(args.data, /*forCreate*/ false);
    const node = buildUpdate(
      mk, this.model,
      { where: args.where, data: scalar, many: false },
      schema as any,
    );
    const { doc } = await this.adapter.executeUpdate(node, this.model, { session: this._session });
    if (!doc) throw notFoundError(this.model.collection, args.where);
    if (nested.length > 0) await this._applyNestedWrites(doc, nested);
    return this._returnOne(doc, args);
  }

  async updateMany(args: {
    where?: WhereInput<F>;
    data: IUpdate<F, R>;
  }): Promise<{ count: number }> {
    this._assertWritable('updateMany');
    this._assertStrictWhere(args.where);
    const mk = this._modelKey();
    const node = buildUpdate(
      mk, this.model,
      { where: args.where, data: args.data, many: true },
      schema as any,
    );
    const r = await this.adapter.executeUpdate(node, this.model, { session: this._session });
    return { count: r.count };
  }

  async upsert<A extends {
    where: WhereInput<F>;
    create: ICreate<F, R>;
    update: IUpdate<F, R>;
    select?: ISelect<F, R, SM>;
    include?: IInclude<R, SM>;
    omit?: { [K in keyof F]?: boolean };
  }>(args: A & NoBothSelectInclude<A>): Promise<Find1<F, R, A, SM>> {
    this._assertWritable('upsert');
    this._assertStrictWhere(args.where);
    const mk = this._modelKey();
    // Build a coerced create payload for $setOnInsert. The compile-from-ir
    // layer applies defaults; we only need to pre-coerce here so user-supplied
    // ids/dates become BSON types before going through Mongo's BSON.
    const createCoerced = this.adapter.coerceInbound(this.model, args.create);
    const node = buildUpdate(
      mk, this.model,
      { where: args.where, data: args.update, many: false, upsertCreate: createCoerced },
      schema as any,
    );
    const { doc } = await this.adapter.executeUpdate(node, this.model, { session: this._session });
    return this._returnOne(doc, args);
  }

  async delete<A extends {
    where: WhereInput<F>;
    select?: ISelect<F, R, SM>;
    include?: IInclude<R, SM>;
    omit?: { [K in keyof F]?: boolean };
  }>(args: A & NoBothSelectInclude<A>): Promise<Find1<F, R, A, SM>> {
    this._assertWritable('delete');
    this._assertStrictWhere(args.where);
    const mk = this._modelKey();
    // Wave 4b — soft delete: if the model declares a `.softDeleteAt()` field,
    // rewrite DELETE to UPDATE that sets that column to now().
    const sd = this._softDeleteField();
    if (sd) {
      return this.update({ ...args, data: { [sd]: new Date() } as any } as any) as any;
    }
    const node = buildDelete(
      mk, this.model,
      { where: args.where, many: false },
      schema as any,
    );
    const { doc } = await this.adapter.executeDelete(node, this.model, { session: this._session });
    if (!doc) throw notFoundError(this.model.collection, args.where);
    return this._returnOne(doc, args);
  }

  async deleteMany(args: { where?: WhereInput<F> } = {}): Promise<{ count: number }> {
    this._assertWritable('deleteMany');
    this._assertStrictWhere(args?.where);
    const mk = this._modelKey();
    // Soft delete: rewrite to updateMany.
    const sd = this._softDeleteField();
    if (sd) {
      return this.updateMany({ where: args.where, data: { [sd]: new Date() } as any }) as any;
    }
    const node = buildDelete(
      mk, this.model,
      { where: args.where, many: true },
      schema as any,
    );
    const r = await this.adapter.executeDelete(node, this.model, { session: this._session });
    return { count: r.count };
  }

  // ─── Aggregation ─────────────────────────────────────────────────────
  // Replaces Prisma's aggregateRaw — same signature, returns plain documents
  // with stringified ObjectIds for ergonomic parity.

  async aggregate(args: { pipeline: any[]; options?: any }): Promise<any[]> {
    // Coerce MongoDB extended-JSON markers in the pipeline ({$oid, $date})
    // to native ObjectId/Date — Prisma's aggregateRaw did this transparently.
    const raw = Array.isArray(args.pipeline) ? args.pipeline : [];
    const pipeline = coerceExtendedJSON(raw);
    const docs = await this.collection
      .aggregate(pipeline, { ...args.options, ...this.sessOpt })
      .toArray();
    return docs.map(stringifyObjectIds);
  }

  // ─── Wave 5d — materialised views ────────────────────────────────────

  // Recompute a materialised view's contents from its source definition.
  //   PG     → REFRESH MATERIALIZED VIEW [CONCURRENTLY]
  //   MySQL  → TRUNCATE + INSERT … SELECT from the view's `sql`
  //   SQLite → DELETE + INSERT … SELECT from the view's `sql`
  //   Mongo  → re-run the $merge/$out pipeline
  // No-ops (with a thrown error) on non-materialised models.
  async refresh(opts: { concurrently?: boolean } = {}): Promise<void> {
    const view = (this.model as any).view;
    if (!view?.materialised) {
      throw new Error(
        `[forge] refresh() is only valid on a materialised view. ` +
        `'${this.model.collection}' is ${view ? 'a plain view' : 'a table'}. ` +
        `Declare it with .asView({ materialised: true, ... }).`,
      );
    }
    if (typeof (this.adapter as any).refreshView !== 'function') {
      throw new Error(`[forge] adapter '${this.adapter.kind}' does not implement materialised-view refresh.`);
    }
    await (this.adapter as any).refreshView(this.model, { ...opts, session: this._session });
  }

  // Wave 5d — auto-refresh on an interval. Returns a stop() that clears the
  // timer (the caller owns the lifecycle — no hidden leaked timers). Use the
  // model's declared `.asView({ refreshEvery })` value, or pass one explicitly.
  scheduleRefresh(every?: string): () => void {
    const spec = every ?? (this.model as any).view?.refreshEvery;
    const ms = parseDuration(spec);
    if (!ms) throw new Error(`[forge] scheduleRefresh needs a duration like '30s' / '5m' / '1h' (got ${JSON.stringify(spec)})`);
    const timer = setInterval(() => { void this.refresh().catch(() => { /* swallow — surfaced via $on('error') */ }); }, ms);
    if (typeof (timer as any).unref === 'function') (timer as any).unref();  // don't keep the process alive
    return () => clearInterval(timer);
  }

  // ─── Internal: read pipeline ─────────────────────────────────────────

  // Wave 4b — return the soft-delete field name if the model has one.
  private _softDeleteField(): string | undefined {
    for (const [name, f] of Object.entries(this.model.fields)) {
      if ((f as any).softDeleteAt) return name;
    }
    return undefined;
  }

  // Augment a `where` object to exclude soft-deleted rows. Opt out by passing
  // `where: { ..., _withDeleted: true }` (deleted via the strip step before
  // building IR).
  private _withSoftDeleteFilter(args: any): any {
    const sd = this._softDeleteField();
    if (!sd || !args) return args;
    const where = args.where ?? {};
    if (where._withDeleted) {
      const { _withDeleted: _, ...rest } = where;
      return { ...args, where: rest };
    }
    if (Object.prototype.hasOwnProperty.call(where, sd)) return args;  // user filtered explicitly
    return { ...args, where: { ...where, [sd]: null } };
  }

  private async _find(args: any, hardLimit: number | undefined): Promise<any[]> {
    // Build an IR SelectNode and hand it to the Mongo executor. This is the
    // adapter-agnostic boundary: SQL adapters consume the same node shape
    // in Wave 2+.
    this._assertStrictWhere(args?.where);
    const mk = this._modelKey();
    args = this._withSoftDeleteFilter(args);
    const cardinality: 'one' | 'many' = hardLimit === 1 ? 'one' : 'many';
    const node = buildSelect(mk, this.model, args ?? {}, cardinality, schema as any);
    // If a hardLimit was specified (findFirst path), honour it even when the
    // user passed no take/limit.
    if (hardLimit != null && (node.limit == null || node.limit > hardLimit)) {
      node.limit = hardLimit;
    }
    const rows = await this.adapter.executeSelect(node, this.model, { session: this._session });
    // The IR-driven pipeline already applies projection / distinct /
    // hydration. The legacy `select`-side row pruning happens too via
    // ProjectionPlan.exclusive in compile-from-ir. Nothing else to do.
    return rows;
  }

  private async _returnOne(
    rawDoc: any,
    args: { select?: any; include?: any; omit?: any },
  ): Promise<any> {
    if (!rawDoc) return rawDoc;
    const decoded = this.adapter.decodeOutbound(this.model, rawDoc);
    const rows = [decoded];
    // Use the IR's projection plan + the executor's shared hydration helper
    // so writes get the exact same select/include/omit semantics as reads.
    const { projection, hydration } = buildProjection(this.model, args, schema as any);
    await this.adapter.applyProjectionAndHydration(
      rows, this.model, { projection, hydration }, { session: this._session },
    );
    // When `select` is exclusive, prune the row to just the requested scalar
    // keys (plus already-hydrated relations). The executor's projection only
    // controls what Mongo returns; for writes we already hold a full doc.
    if (projection?.exclusive && projection.fields.length) {
      const kept = new Set(projection.fields);
      // Keep hydrated relation keys + _count too.
      if (hydration) for (const h of hydration) kept.add(h.name);
      if (projection.counts.length) kept.add('_count');
      const pruned: any = {};
      for (const k of Object.keys(rows[0])) if (kept.has(k)) pruned[k] = rows[0][k];
      return pruned;
    }
    // When `omit` is in play, drop the listed scalars from the doc.
    if (projection?.omit?.length) {
      const drop = new Set(projection.omit);
      const out: any = {};
      for (const k of Object.keys(rows[0])) if (!drop.has(k)) out[k] = rows[0][k];
      return out;
    }
    return rows[0];
  }

  // ─── Internal: nested-write split + apply ────────────────────────────
  //
  // Prisma lets you write `parent.create({ data: { ..., rel: { create: {...} } } })`.
  // We split this into a scalar payload (passed to insertOne/updateOne) and a
  // list of nested operations to apply post-write. Inverse-side many
  // relations get FK-injected child writes; owning one-side `connect` rewrites
  // the FK on the parent's scalar payload.

  private _splitNestedWrites(data: any, forCreate: boolean): {
    scalar: any;
    nested: NestedSpec[];
  } {
    const scalar: any = {};
    const nested: NestedSpec[] = [];
    if (!data || typeof data !== 'object') return { scalar: data ?? {}, nested };

    const rels = this.model.relations();

    for (const key of Object.keys(data)) {
      const rel = rels[key];
      const value = data[key];

      if (!rel) {
        scalar[key] = value;
        continue;
      }

      // Pure null/undefined on a relation key — ignore (matches Prisma).
      if (value == null) continue;

      // Owning one-side relation (parent holds FK).
      if (rel.kind === 'one' && !rel.inverse) {
        if (typeof value !== 'object') continue;
        if ('connect' in value && value.connect) {
          const target = value.connect;
          const fk = target[rel.refs] ?? target.id ?? target._id;
          if (fk !== undefined) scalar[rel.on] = fk;
        } else if ('connectOrCreate' in value && value.connectOrCreate) {
          // Find-or-create on the owning side. Resolves to a FK assignment.
          nested.push({ rel, op: 'connectOrCreate', data: value.connectOrCreate });
        } else if ('disconnect' in value && value.disconnect === true) {
          scalar[rel.on] = null;
        } else if ('create' in value && value.create) {
          // Nested create on owning side: create the parent target first,
          // then connect by id. Implemented as a NestedSpec.create with a
          // synthetic targetCollection direction.
          nested.push({ rel, op: 'create', data: value.create });
        }
        continue;
      }

      // Inverse-side relations — collect for post-write.
      if (typeof value !== 'object') continue;
      if (value.create) nested.push({ rel, op: 'create', data: value.create });
      if (value.createMany?.data)
        nested.push({ rel, op: 'createMany', data: value.createMany.data });
      if (value.connect)
        nested.push({ rel, op: 'connect', data: value.connect });
      if (value.connectOrCreate)
        nested.push({ rel, op: 'connectOrCreate', data: value.connectOrCreate });
      if (value.disconnect)
        nested.push({ rel, op: 'disconnect', data: value.disconnect });
      if (value.set) nested.push({ rel, op: 'set', data: value.set });
      if (value.delete) nested.push({ rel, op: 'delete', data: value.delete });
      if (value.deleteMany)
        nested.push({ rel, op: 'deleteMany', data: value.deleteMany });
    }

    return { scalar, nested };
  }

  private async _applyNestedWrites(parentDoc: any, nested: NestedSpec[]) {
    for (const spec of nested) {
      const { rel, op } = spec;
      const target = (schema as any)[rel.target] as ModelDef<any>;
      if (!target) {
        throw new Error(
          `[Database] nested write target '${rel.target}' is not in the schema map`,
        );
      }
      const targetWrapper = new CollectionWrapper(target, this._session);

      // Parent ref value — used as the child's FK target.
      const parentRef =
        rel.refs === 'id'
          ? parentDoc._id ?? parentDoc.id
          : parentDoc[rel.refs];
      const fkValue =
        parentRef && typeof parentRef === 'object' && 'toString' in parentRef
          ? parentRef.toString()
          : parentRef;

      const childFkField = rel.on;

      if (op === 'create') {
        const item = Array.isArray(spec.data) ? spec.data : [spec.data];
        for (const d of item) {
          await targetWrapper.create({ data: { ...d, [childFkField]: fkValue } });
        }
        continue;
      }
      if (op === 'createMany') {
        const items = (spec.data as any[]).map((d) => ({
          ...d,
          [childFkField]: fkValue,
        }));
        await targetWrapper.createMany({ data: items });
        continue;
      }
      if (op === 'connect') {
        // Set the FK on each connected child to point at this parent.
        const targets = Array.isArray(spec.data) ? spec.data : [spec.data];
        for (const t of targets) {
          const tId = t[rel.refs] ?? t.id ?? t._id;
          if (tId == null) continue;
          await targetWrapper.update({
            where: { id: tId },
            data: { [childFkField]: fkValue },
          });
        }
        continue;
      }
      if (op === 'disconnect') {
        const targets = Array.isArray(spec.data) ? spec.data : [spec.data];
        for (const t of targets) {
          const tId = t[rel.refs] ?? t.id ?? t._id;
          if (tId == null) continue;
          await targetWrapper.update({
            where: { id: tId } as any,
            data: { [childFkField]: null } as any,
          });
        }
        continue;
      }
      if (op === 'delete') {
        const targets = Array.isArray(spec.data) ? spec.data : [spec.data];
        for (const t of targets) {
          await targetWrapper.delete({ where: t });
        }
        continue;
      }
      if (op === 'deleteMany') {
        await targetWrapper.deleteMany({ where: spec.data });
        continue;
      }
      if (op === 'connectOrCreate') {
        // Prisma shape: { where: WhereUniqueInput, create: CreateInput }
        // either array (inverse-many) or single (owning-one).
        const items: any[] = Array.isArray(spec.data) ? spec.data : [spec.data];
        for (const it of items) {
          if (!it?.where) continue;
          // Try to find by where; if missing, create.
          let existing: any = await targetWrapper.findFirst({ where: it.where });
          if (!existing) {
            // For inverse-many side, attach FK pointing back at parent.
            const createData = rel.inverse
              ? { ...(it.create ?? {}), [childFkField]: fkValue }
              : (it.create ?? {});
            existing = await targetWrapper.create({ data: createData });
          } else if (rel.inverse) {
            // Already exists — make sure FK points at this parent.
            const tId = existing[rel.refs] ?? existing.id ?? existing._id;
            if (existing[childFkField] !== fkValue) {
              await targetWrapper.update({
                where: { id: tId } as any,
                data: { [childFkField]: fkValue } as any,
              });
            }
          } else {
            // Owning-one side: set parent's FK to the resolved target's refs.
            const tId = existing[rel.refs] ?? existing.id ?? existing._id;
            parentDoc[rel.on] = tId;
          }
        }
        // If we mutated parentDoc[rel.on] for owning-one connectOrCreate,
        // persist the change.
        if (!rel.inverse && parentDoc._id && parentDoc[rel.on] != null) {
          // Issue a follow-up update so the new FK lands on the parent row.
          // We use the wrapper's own update to flow through the adapter.
          await this.update({
            where: { id: parentDoc._id ?? parentDoc.id } as any,
            data: { [rel.on]: parentDoc[rel.on] } as any,
          });
        }
        continue;
      }
      // 'set' is a Prisma-only "replace the connected set" — uncommon and we
      // skip it for now (no current call sites). Easy to add later.
    }
  }
}

// Wave 5d — parse a simple duration string ('30s', '5m', '1h', '2d') to ms.
// Returns undefined for unparseable input so callers can give a clear error.
export function parseDuration(spec: string | undefined): number | undefined {
  if (!spec || typeof spec !== 'string') return undefined;
  const m = /^(\d+)\s*(ms|s|m|h|d)$/.exec(spec.trim());
  if (!m) return undefined;
  const n = Number(m[1]);
  const unit = m[2];
  const mult = unit === 'ms' ? 1 : unit === 's' ? 1000 : unit === 'm' ? 60_000 : unit === 'h' ? 3_600_000 : 86_400_000;
  return n * mult;
}

// Internal: stringify ObjectId leaks in aggregation output.
function stringifyObjectIds(doc: any): any {
  if (doc == null || typeof doc !== 'object') return doc;
  const out: any = Array.isArray(doc) ? [] : {};
  for (const k of Object.keys(doc)) {
    const v = (doc as any)[k];
    if (v && typeof v === 'object' && v._bsontype === 'ObjectId') {
      out[k === '_id' ? 'id' : k] = v.toString();
    } else if (v && typeof v === 'object') {
      out[k === '_id' ? 'id' : k] = stringifyObjectIds(v);
    } else {
      out[k === '_id' ? 'id' : k] = v;
    }
  }
  return out;
}

export { DbKnownError };
