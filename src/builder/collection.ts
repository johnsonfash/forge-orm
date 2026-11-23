import type { ClientSession, Collection, Document } from 'mongodb';
import { objectIdHex } from '../object-id';
// Use the WebCrypto global — present in browsers, Node 16+, Deno, Bun, Workers.
// Falls back to a Math.random v4 layout only if WebCrypto is missing entirely
// (which is exotic — older Node without --experimental-global-webcrypto). The
// fallback is NOT cryptographically secure; in those environments install a
// polyfill or upgrade to Node 16+.
const randomUUID = (): string => {
  const c: { randomUUID?: () => string; getRandomValues?: (a: Uint8Array) => Uint8Array } | undefined =
    (globalThis as { crypto?: typeof globalThis.crypto }).crypto;
  if (c?.randomUUID) return c.randomUUID();
  if (c?.getRandomValues) {
    const b = c.getRandomValues(new Uint8Array(16));
    b[6] = (b[6]! & 0x0f) | 0x40;
    b[8] = (b[8]! & 0x3f) | 0x80;
    const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  }
  let s = '';
  for (let i = 0; i < 36; i++) {
    if (i === 8 || i === 13 || i === 18 || i === 23) s += '-';
    else if (i === 14) s += '4';
    else if (i === 19) s += ((Math.random() * 4) | 0 | 8).toString(16);
    else s += ((Math.random() * 16) | 0).toString(16);
  }
  return s;
};
import { getDefaultClient } from '../adapters/mongo/client';
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
import { buildPostgresCompileApi } from '../adapters/postgres/compile';
import { buildMysqlCompileApi } from '../adapters/mysql/compile';
import { buildSqliteCompileApi } from '../adapters/sqlite/compile';
import { buildDuckdbCompileApi } from '../adapters/duckdb/compile';
import { buildMssqlCompileApi } from '../adapters/mssql/compile';
import type { CompileApi, MongoCompileApi, SQLCompileApi } from '../compile';
import { buildCount, buildDelete, buildGroupBy, buildInsert, buildProjection, buildSelect, buildUpdate, buildUpdateData, type RowLockOption } from '../ir/build';
import type { RowLockSpec, UpdateNode } from '../ir/types';
import { rowLockSql } from '../adapters/row-lock';
import { stripKeys, withJoinKeys } from '../ir/hydrate-many';
import type { Adapter } from '../adapters/types';
import { getDefaultMongoAdapter } from '../adapters/mongo/adapter';
import { currentSession } from '../session-context';
import { getActiveSchema } from '../schema/active';
import { applyCascades, cascadeKeyFields, cascadeProbes, hasCascadeWork } from './cascade';
import { runAtomic } from './atomic';

type ResolvedRow<F extends Record<string, Field<any, any>>> = {
  [K in keyof F]: F[K] extends Field<infer T, any> ? T : never;
};

// CollectionWrapper — Prisma-shape API over a Mongo collection.
interface NestedSpec {
  rel: RelationDef;
  op:
    | 'create' | 'createMany' | 'connect' | 'connectOrCreate'
    | 'disconnect' | 'set' | 'delete' | 'deleteMany'
    | 'update' | 'updateMany' | 'upsert';
  data: any;
}

// Threading the schema-map type `SM` lets include/select resolve relation
// TARGETS against whichever schema this wrapper belongs to, so a custom consumer
// schema gets full nested typing.
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
  private _compileApi?: CompileApi;
  // Defaults to the lazily-built Mongo singleton so the default Mongo path works
  // without surgery. createDb() injects the active adapter explicitly for
  // Postgres / MySQL / SQLite.
  constructor(
    public model: ModelDef<any>,
    private _session?: unknown,
    private _adapter?: Adapter,
    private _strict: boolean = false,
    /*
     * The shape to mint for an auto id when the FIELD does not say.
     *
     * Set once on `createDb({ defaultIdType: 'objectId' })` so a schema
     * with hundreds of models does not have to repeat it on every
     * `f.id()` — and, more to the point, so a model added later cannot
     * quietly get the other shape. A field's own `idType` still wins.
     */
    private _defaultIdType?: 'auto' | 'objectId',
  ) {}

  protected get adapter(): Adapter {
    return this._adapter ?? getDefaultMongoAdapter();
  }

  // Strict mode rejects any `where` key that isn't a real field, a known
  // synthetic composite-unique key, a relation name, or a recognised
  // logical/structural operator — closing the `[key: string]: any` escape hatch
  // on WhereInput so typos surface instead of silently matching nothing.
  private static readonly _whereOps = new Set([
    'AND', 'OR', 'NOT', '_withDeleted',
  ]);
  // Synthetic composite-unique keys mirror Prisma: ['a','b'] → 'a_b'.
  // Cached per ModelDef (static WeakMap) so relation-target lookups share it.
  private _allowedWhereKeys(): Set<string> {
    return CollectionWrapper._allowedKeysFor(this.model);
  }
  private _assertStrictWhere(where: any): void {
    if (!this._strict || !where || typeof where !== 'object') return;
    this._assertStrictWhereOn(this.model, where, this._allowedWhereKeys());
  }

  // Recursive strict check. The old version only looked at the top level, so
  // `{ AND: [{ bogusField: 1 }] }` sailed through and silently matched
  // nothing — the same typo one level down that strict mode exists to catch.
  private _assertStrictWhereOn(model: ModelDef<any>, where: any, allowed: Set<string>): void {
    const relations = model.relations();
    for (const key of Object.keys(where)) {
      const value = where[key];
      if (key === 'AND' || key === 'OR' || key === 'NOT') {
        const arr = Array.isArray(value) ? value : [value];
        for (const w of arr) {
          if (w && typeof w === 'object') this._assertStrictWhereOn(model, w, allowed);
        }
        continue;
      }
      if (allowed.has(key)) {
        // Relation filter — recurse into its modes against the TARGET model,
        // so `{ author: { is: { bogus: 1 } } }` is caught too.
        const rel = relations[key];
        if (rel && value && typeof value === 'object') {
          const target: any = (schema as any)?.[rel.target];
          if (target?.fields) {
            const targetAllowed = CollectionWrapper._allowedKeysFor(target);
            for (const mode of ['is', 'isNot', 'some', 'every', 'none'] as const) {
              const nested = (value as any)[mode];
              if (nested && typeof nested === 'object') {
                this._assertStrictWhereOn(target, nested, targetAllowed);
              }
            }
          }
        }
        continue;
      }
      // Dotted path into a container column — `address.city`, `meta.stats.views`.
      // Runtime supports these (compiled as a jsonPath leaf), so strict mode
      // must not reject them. For embeds the first segment is validated
      // against the embed's declared fields; json columns accept any path.
      if (key.includes('.')) {
        const head = key.slice(0, key.indexOf('.'));
        const fdef: any = model.fields?.[head];
        const kind = fdef?.kind;
        if (kind === 'json' || kind === 'stringArray' || kind === 'intArray') continue;
        if (kind === 'embed' || kind === 'embedMany') {
          const sub = key.slice(key.indexOf('.') + 1).split('.')[0].replace(/\[\d+\]/g, '');
          const embedFields = fdef.embedOf?.()?.fields;
          if (embedFields && !(sub in embedFields)) {
            throw new Error(
              `[forge:strict] unknown embed field '${sub}' in where key '${key}' on ` +
              `'${model.collection}'. Fields of '${head}': ${Object.keys(embedFields).join(', ')}.`,
            );
          }
          continue;
        }
      }
      throw new Error(
        `[forge:strict] unknown where key '${key}' on '${model.collection}'.\n` +
        `  Known fields: ${Object.keys(model.fields).join(', ')}.\n` +
        `  (strict mode is on — disable with createDb({ strict: false }) to allow loose keys.)`,
      );
    }
  }

  private static readonly _allowedKeysCache = new WeakMap<object, Set<string>>();
  private static _allowedKeysFor(model: ModelDef<any>): Set<string> {
    const hit = CollectionWrapper._allowedKeysCache.get(model as object);
    if (hit) return hit;
    const keys = new Set<string>(CollectionWrapper._whereOps);
    for (const fieldName of Object.keys(model.fields)) keys.add(fieldName);
    for (const rel of Object.keys(model.relations())) keys.add(rel);
    for (const cols of model.uniques ?? []) keys.add(cols.join('_'));
    CollectionWrapper._allowedKeysCache.set(model as object, keys);
    return keys;
  }

  // Returns a session-bound wrapper for use inside $transaction(callback). The
  // adapter's session type (Mongo: ClientSession, PG: PoolClient) flows through
  // opaquely via _session.
  withSession(session: unknown): CollectionWrapper<F, R, SM> {
    return new CollectionWrapper<F, R, SM>(this.model, session, this._adapter, this._strict, this._defaultIdType);
  }

  private _bound(session: unknown): CollectionWrapper<F, R, SM> {
    return session === undefined || session === this._session ? this : this.withSession(session);
  }

  // A wrapper for a related model on the same connection, session and id
  // policy as this one.
  private _wrapperFor(target: ModelDef<any>): CollectionWrapper<any> {
    return new CollectionWrapper(target, this._session, this._adapter, this._strict, this._defaultIdType);
  }

  // Compile namespace — same arg shape as the execute methods, but returns a
  // typed artifact instead of executing (for forwarding to a manually managed
  // driver, generating migration/seed scripts, debugging, replay/audit). Per-
  // adapter dispatch: Mongo returns MongoArtifact, SQL dialects return
  // SQLArtifact with the matching `dialect` field. Each adapter's IR-stage
  // emitter handles its own placeholder syntax + quoting.
  get compile(): CompileApi {
    if (!this._compileApi) {
      const kind = this._adapter?.kind;
      switch (kind) {
        case 'postgres': this._compileApi = buildPostgresCompileApi(this.model); break;
        case 'mysql':    this._compileApi = buildMysqlCompileApi(this.model);    break;
        case 'sqlite':   this._compileApi = buildSqliteCompileApi(this.model);   break;
        case 'duckdb':   this._compileApi = buildDuckdbCompileApi(this.model);   break;
        case 'mssql':    this._compileApi = buildMssqlCompileApi(this.model);    break;
        case 'indexeddb':
          throw new Error(
            '[forge] .compile is not implemented for the IndexedDB adapter yet ' +
            '(no SQL or aggregation pipeline shape — IDB is native). Use the ' +
            'model methods (findMany, create, …) directly.',
          );
        case 'mongo':
        default:         this._compileApi = buildMongoCompileApi(this.model);    break;
      }
    }
    return this._compileApi;
  }
  /**
   * Narrowed compile API for Mongo callers — same getter as `compile`, just
   * statically typed. Throws at access if the resolved adapter isn't Mongo
   * so the mismatched dialect surfaces loudly instead of silently returning
   * the wrong artifact shape. When no adapter has been injected the
   * resolved kind is Mongo (the default singleton), so the getter returns
   * the Mongo compile API.
   */
  get compileMongo(): MongoCompileApi {
    const kind = this.adapter.kind;
    if (kind !== 'mongo') {
      throw new Error(
        `[forge] .compileMongo is only available on a Mongo adapter ` +
        `(current adapter: ${kind}). Use .compile or .compileSql instead.`,
      );
    }
    return this.compile as MongoCompileApi;
  }
  /**
   * Narrowed compile API for SQL callers — returns SQLArtifact with the
   * correct dialect. Throws at access if the resolved adapter is Mongo
   * (including the default singleton when no adapter was injected).
   */
  get compileSql(): SQLCompileApi {
    const kind = this.adapter.kind;
    if (kind === 'mongo') {
      throw new Error(
        `[forge] .compileSql is not available on a Mongo adapter. Use .compile ` +
        `or .compileMongo instead.`,
      );
    }
    return this.compile as SQLCompileApi;
  }

  private get collection(): Collection<Document> {
    if (!this._collection) {
      // From the adapter that owns the connection, so a wrapper built by a
      // second createDb() does not reach into the first one's database. The
      // fallback keeps an adapter that predates the `db` accessor working.
      const own = (this.adapter as { db?: unknown }).db as import('mongodb').Db | undefined;
      this._collection = (own ?? getDefaultClient().db).collection(this.model.collection);
    }
    return this._collection;
  }

  /**
   * The session this call runs under: the one handed to this wrapper by
   * `$transaction`, or the ambient one if we are inside a transaction
   * callback that did not pass its `tx` down.
   *
   * Without the fallback, a repository called from inside a
   * `$transaction(...)` callback ran OUTSIDE the transaction — the code read
   * as atomic and was not, and nothing rolled back. See session-context.ts.
   */
  private get session(): unknown {
    return this._session ?? currentSession(this._adapter);
  }

  private get sessOpt() {
    const s = this.session;
    return s ? { session: s } : {};
  }

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
    /** Row lock (postgres, inside a transaction): 'update' | 'share' | …, or
     *  `{ mode, nowait }` / `{ mode, skipLocked }`. */
    lock?: RowLockOption;
  }>(args: A & NoBothSelectInclude<A> = {} as any): Promise<Find1<F, R, A, SM> | null> {
    const result = await this._find(args, 1);
    return (result[0] as Find1<F, R, A, SM>) ?? null;
  }

  async findUnique<A extends {
    where: WhereInput<F>;
    select?: ISelect<F, R, SM>;
    include?: IInclude<R, SM>;
    omit?: { [K in keyof F]?: boolean };
    lock?: RowLockOption;
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
    /** Row lock (postgres, inside a transaction): 'update' | 'share' | …, or
     *  `{ mode, nowait }` / `{ mode, skipLocked }`. */
    lock?: RowLockOption;
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
    lock?: RowLockOption;
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
    /** Row lock (postgres, inside a transaction): 'update' | 'share' | …, or
     *  `{ mode, nowait }` / `{ mode, skipLocked }`. */
    lock?: RowLockOption;
  }>(args: A & NoBothSelectInclude<A> = {} as any): Promise<Find1<F, R, A, SM>[]> {
    return this._find(args, undefined) as Promise<Find1<F, R, A, SM>[]>;
  }

  // Streaming reads. Yields rows one-by-one (or in driver-sized batches) without
  // buffering the full result set — for large exports/batch jobs.
  //
  // WARNING: only leaf rows are streamed; relation hydration is NOT batched
  // across the stream. If you need include, materialise the chunk first
  // (findMany on each chunk).
  async *findManyStream<A extends {
    where?: WhereInput<F>;
    orderBy?: OrderByInput<F> | OrderByInput<F>[];
    chunkSize?: number;
  }>(args: A = {} as A): AsyncIterable<ResolvedRow<F>> {
    const a = args as A & { take?: number; limit?: number; skip?: number; offset?: number };
    const chunkSize = args.chunkSize ?? 1000;
    // Adapter-native streaming first, a batch at a time where it can.
    const adapter = this.adapter as Adapter;
    if (adapter.streamSelectBatches || adapter.streamSelect) {
      const mk = this._modelKey();
      const filtered = this._withSoftDeleteFilter({ ...args, chunkSize: undefined });
      const node = buildSelect(mk, this.model, filtered ?? {}, 'many', schema as any);
      if (adapter.streamSelectBatches) {
        for await (const batch of adapter.streamSelectBatches(node, this.model, { session: this.session, batchSize: args.chunkSize })) {
          for (const row of batch) yield row as ResolvedRow<F>;
        }
        return;
      }
      for await (const row of adapter.streamSelect!(node, this.model, { session: this.session })) yield row as ResolvedRow<F>;
      return;
    }
    // Otherwise page through it. By key where the order allows (each page
    // starts after the last row's sort key, so page k costs what page 1
    // does); by OFFSET where it does not.
    let remaining = a.take ?? a.limit ?? Infinity;
    let skip = a.skip ?? a.offset;
    const keys = this._keysetOrder(args.orderBy);
    if (keys) {
      const orderBy = keys.map((k) => ({ [k.field]: k.dir }));
      let after: any;
      for (;;) {
        const page = Math.min(chunkSize, remaining);
        if (page <= 0) return;
        const where = after ? (args.where ? { AND: [args.where, after] } : after) : args.where;
        const batch = await this._find({ where, orderBy, take: page, skip }, undefined);
        skip = undefined;
        for (const row of batch) yield row as ResolvedRow<F>;
        if (batch.length < page) return;
        remaining -= batch.length;
        after = keysetAfter(keys, batch[batch.length - 1]);
      }
    }
    let offset = skip ?? 0;
    while (true) {
      const page = Math.min(chunkSize, remaining);
      if (page <= 0) return;
      const batch = await this._find({ where: args.where, orderBy: args.orderBy, take: page, skip: offset }, undefined);
      if (!Array.isArray(batch) || batch.length === 0) return;
      for (const row of batch) yield row as ResolvedRow<F>;
      if (batch.length < page) return;
      remaining -= batch.length;
      offset += batch.length;
    }
  }

  // The sort a keyset page can resume from: plain ascending/descending
  // columns that are never null, with the primary key appended so the order
  // is total. Null when the order has anything else in it.
  private _keysetOrder(orderBy: any): Array<{ field: string; dir: 'asc' | 'desc' }> | null {
    const entries = orderBy == null ? [] : Array.isArray(orderBy) ? orderBy : [orderBy];
    const out: Array<{ field: string; dir: 'asc' | 'desc' }> = [];
    for (const e of entries) {
      if (!e || typeof e !== 'object') return null;
      for (const [field, dir] of Object.entries(e)) {
        const fd: any = this.model.fields[field];
        if (!fd || fd.optional || (dir !== 'asc' && dir !== 'desc')) return null;
        if (['json', 'embed', 'embedMany', 'geoPoint', 'vector', 'bytes', 'stringArray', 'intArray'].includes(fd.kind)) return null;
        out.push({ field, dir });
      }
    }
    const pk = Object.entries(this.model.fields).find(([, fd]) => (fd as any).kind === 'id')?.[0];
    if (!pk) return null;
    if (!out.some((k) => k.field === pk)) out.push({ field: pk, dir: 'asc' });
    return out;
  }

  async count(args: { where?: WhereInput<F>; distinct?: Array<keyof F & string> } = {}): Promise<number> {
    this._assertStrictWhere(args?.where);
    const mk = this._modelKey();
    args = this._withSoftDeleteFilter(args);
    const node = buildCount(mk, this.model, args, schema as any);
    return this.adapter.executeCount(node, this.model, { session: this.session });
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
    // `_find`, `findManyStream` and `count` all do these two; groupBy did
    // neither. So a soft-deleted row was counted and summed — and because
    // `aggregate({ _sum: … })` routes through here, a revenue total silently
    // included deleted orders. A typo'd `where` key was not caught either,
    // which under strict mode means the filter matched nothing and the
    // aggregate came back as if the rows did not exist.
    this._assertStrictWhere((args as { where?: unknown }).where);
    const scoped = this._withSoftDeleteFilter(args);
    const mk = this._modelKey();
    const node = buildGroupBy(mk, this.model, scoped as any, schema as any);
    return this.adapter.executeGroupBy(node, this.model, { session: this.session });
  }

  // Lazily resolve the schema-side key for this model — IR builders and the
  // executor want a portable string key, not a collection name.
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

  // Block writes on read-only view models.
  private _assertWritable(op: string): void {
    if ((this.model as any).view) {
      throw new Error(
        `[forge] ${op} is not allowed on '${this.model.collection}' — it's a read-only view.\n` +
        `  Use the underlying source model for writes, or drop .asView() from the schema.`,
      );
    }
  }

  /*
   * Auto-generate the primary key when the caller didn't supply one.
   * Mongo mints an ObjectId in coerceInbound; SQL dialects have no
   * server default for forge's string id, so it is generated here.
   * Only fills when the id field has an autoId default and no value was
   * provided.
   *
   * WHICH SHAPE depends on the field's `idType`:
   *
   *   'auto'     — a UUID v4. The native thing on SQL, and the default.
   *   'objectId' — the same 24-hex ObjectId layout Mongo would mint, on
   *                every dialect. For a schema that has to move between
   *                engines without every id changing underneath it, and
   *                for anything relying on ids sorting by time — see
   *                the header of `src/object-id.ts`.
   */
  private _autoIdName?: string | null;
  private _autoIdKind?: 'uuid' | 'objectId';
  private _fillAutoId(data: any): any {
    if (this.adapter.kind === 'mongo' || !data || typeof data !== 'object') return data;
    if (this._autoIdName === undefined) {
      this._autoIdName = null;
      for (const [name, fd] of Object.entries(this.model.fields)) {
        if ((fd as any).kind === 'id' && (fd as any).default?.kind === 'autoId') {
          this._autoIdName = name;
          const declared = (fd as any).idType;
          // A field that asks for a shape gets it; otherwise the
          // connection's default; otherwise the native SQL shape.
          this._autoIdKind =
            declared === 'objectId' || (declared === 'auto' && this._defaultIdType === 'objectId')
              ? 'objectId'
              : 'uuid';
          break;
        }
      }
    }
    if (this._autoIdName && data[this._autoIdName] == null) {
      const id = this._autoIdKind === 'objectId' ? objectIdHex() : randomUUID();
      return { ...data, [this._autoIdName]: id };
    }
    return data;
  }

  // Auto-bump `.updatedAt()` fields on every update, on all databases. Sets the
  // field to the current time when the caller didn't set it explicitly. (Mongo
  // also handles this in coerce; setting it here makes it uniform across SQL too.)
  private _updatedAtFields?: string[];

  /**
   * Run the adapter's inbound coercion over an update's plain assignments.
   *
   * `create`, `createMany` and `upsert`'s create block all did this; `update`
   * and `updateMany` never did. On the SQL adapters that meant an update
   * skipped every value conversion AND every value CHECK, so a `f.bytes()`
   * column would accept a base64 string and store it as text — the exact
   * corruption that field kind exists to prevent — and `maxBytes` was not
   * enforced on the one path most likely to grow a row.
   *
   * Mongo is excluded because its coerceInbound is `coerceCreatePayload`,
   * which also stamps create-time DEFAULTS; running it on an update would
   * write default values over columns the caller never mentioned. Mongo's
   * update path coerces inside its own compiler instead (`remapAndCoerce`).
   *
   * Only `set` is coerced. `increment`/`multiply`/`divide`/`max`/`min` are
   * numbers, not column values, and `push`/`addToSet`/`pull` carry array
   * ELEMENTS, which are not the column's own type.
   */
  private _coerceUpdateSet(node: UpdateNode): UpdateNode {
    if (this.adapter.kind === 'mongo') return node;
    if (!node.set || Object.keys(node.set).length === 0) return node;
    node.set = this.adapter.coerceInbound(this.model, node.set);
    return node;
  }
  private _applyUpdatedAt(data: any): any {
    if (!data || typeof data !== 'object') return data;
    if (this._updatedAtFields === undefined) {
      this._updatedAtFields = Object.entries(this.model.fields)
        .filter(([, fd]) => (fd as any).updatedAt)
        .map(([name]) => name);
    }
    if (this._updatedAtFields.length === 0) return data;
    const out = { ...data };
    for (const name of this._updatedAtFields) {
      if (out[name] === undefined) out[name] = new Date();
    }
    return out;
  }

  async create<A extends {
    data: ICreate<F, R>;
    select?: ISelect<F, R, SM>;
    include?: IInclude<R, SM>;
    omit?: { [K in keyof F]?: boolean };
  }>(args: A & NoBothSelectInclude<A>): Promise<Find1<F, R, A, SM>> {
    this._assertWritable('create');
    const split = this._splitNestedWrites(args.data, /*forCreate*/ true);
    if (split.nested.length === 0) {
      const [doc] = await this._insertRows([split], this.session);
      return this._returnOne(doc, args);
    }
    // A create with nested writes is several statements; it commits or rolls
    // back as one wherever the database has transactions.
    return runAtomic(this.adapter, this.session, async (s) => {
      const w = this._bound(s);
      const [doc] = await w._insertRows([split], s ?? w.session);
      return w._returnOne(doc, args);
    });
  }

  /**
   * Insert rows that may carry nested writes, in as few statements as the
   * shape allows: owning-side connectOrCreate / create are resolved for all
   * rows together, the rows go in as one INSERT, then each row's inverse-side
   * nested writes run against its own inserted document.
   */
  private async _insertRows(
    splits: Array<{ scalar: any; nested: NestedSpec[] }>,
    session: unknown,
    needDocs = true,
  ): Promise<any[]> {
    const mk = this._modelKey();
    await this._resolveOwning(splits);
    const rows = splits.map((sp) => this.adapter.coerceInbound(this.model, this._fillAutoId(sp.scalar)));
    const node = buildInsert(mk, this.model, { rows }, schema as any);
    if (!needDocs && splits.every((sp) => sp.nested.length === 0)) node.countOnly = true;
    const { docs } = await this.adapter.executeInsert(node, this.model, { session });
    const ordered = this._alignDocs(rows, docs);
    for (let i = 0; i < splits.length; i++) {
      if (splits[i].nested.length > 0) await this._applyNestedWrites(ordered[i], splits[i].nested);
    }
    return ordered;
  }

  // executeInsert's docs are not guaranteed to follow the input order (MySQL
  // reads them back by id). Match on the primary key when every row has one.
  private _alignDocs(rows: any[], docs: any[]): any[] {
    if (docs.length !== rows.length || rows.length < 2) return docs;
    const pk = Object.entries(this.model.fields).find(([, fd]) => (fd as any).kind === 'id')?.[0];
    if (!pk) return docs;
    const keyOf = (d: any) => {
      const v = d?.[pk] ?? d?._id;
      return v == null ? undefined : String(v);
    };
    const byKey = new Map<string, any>();
    for (const d of docs) {
      const k = keyOf(d);
      if (k === undefined) return docs;
      byKey.set(k, d);
    }
    const out = rows.map((r) => byKey.get(keyOf(r) ?? '\u0000'));
    return out.every((d) => d !== undefined) ? out : docs;
  }

  // Owning-side relations resolved before the INSERT, because the FK lives on
  // the row being inserted: `connectOrCreate` finds or makes the target, and
  // `create` makes it. Done per relation across every row at once, so ten
  // rows that each connectOrCreate a tag cost one lookup and one insert, not
  // twenty statements. Processed specs are removed from each row's `nested`.
  private async _resolveOwning(splits: Array<{ scalar: any; nested: NestedSpec[] }>): Promise<void> {
    // Keyed by target + FK column: relations() builds fresh objects per call,
    // so two rows' specs for the same relation are not the same object.
    const groups = new Map<string, Array<{ split: { scalar: any; nested: NestedSpec[] }; spec: NestedSpec }>>();
    for (const split of splits) {
      for (let i = split.nested.length - 1; i >= 0; i--) {
        const spec = split.nested[i];
        if (spec.rel.inverse || spec.rel.kind !== 'one') continue;
        if (spec.op !== 'connectOrCreate' && spec.op !== 'create') continue;
        const key = `${spec.rel.target}\u0000${spec.rel.on}`;
        const list = groups.get(key) ?? [];
        list.unshift({ split, spec });
        groups.set(key, list);
        split.nested.splice(i, 1);
      }
    }
    for (const entries of groups.values()) {
      const rel = entries[0].spec.rel;
      const target = (schema as any)[rel.target] as ModelDef<any> | undefined;
      if (!target) continue;
      const w = this._wrapperFor(target);
      const refOf = (row: any) => row?.[rel.refs] ?? row?.id ?? row?._id;

      const creates = entries.filter((e) => e.spec.op === 'create');
      if (creates.length) {
        const made = await w._insertRows(
          creates.map((e) => w._splitNestedWrites(Array.isArray(e.spec.data) ? e.spec.data[0] : e.spec.data, true)),
          w.session,
        );
        creates.forEach((e, i) => { e.split.scalar[rel.on] = refOf(w.adapter.decodeOutbound(target, made[i])); });
      }

      const cocs = entries
        .filter((e) => e.spec.op === 'connectOrCreate')
        .map((e) => ({ e, it: Array.isArray(e.spec.data) ? e.spec.data[0] : e.spec.data }))
        .filter((x) => x.it?.where);
      if (cocs.length === 0) continue;

      const plain = cocs.every((x) => isPlainEqWhere(target, x.it.where));
      if (!plain || cocs.length === 1) {
        for (const { e, it } of cocs) {
          let existing: any = await w.findFirst({ where: it.where });
          if (!existing) existing = await w.create({ data: it.create ?? {} });
          e.split.scalar[rel.on] = refOf(existing);
        }
        continue;
      }
      const found = await w.findMany({ where: lookupWhere(dedupeWheres(cocs.map((x) => x.it.where))) } as any);
      const missing: typeof cocs = [];
      const seen = new Set<string>();
      for (const x of cocs) {
        const hit = (found as any[]).find((r) => matchesPlainWhere(r, x.it.where));
        if (hit) { x.e.split.scalar[rel.on] = refOf(hit); continue; }
        const k = whereKey(x.it.where);
        if (!seen.has(k)) { seen.add(k); missing.push(x); }
      }
      if (missing.length) {
        const made = (await w._insertRows(missing.map((x) => w._splitNestedWrites(x.it.create ?? {}, true)), w.session))
          .map((d) => w.adapter.decodeOutbound(target, d));
        const byWhere = new Map<string, any>();
        missing.forEach((x, i) => byWhere.set(whereKey(x.it.where), made.find((r) => matchesPlainWhere(r, x.it.where)) ?? made[i]));
        for (const x of cocs) {
          if (x.e.split.scalar[rel.on] !== undefined) continue;
          x.e.split.scalar[rel.on] = refOf(byWhere.get(whereKey(x.it.where)));
        }
      }
    }
  }

  async createMany(args: {
    data: ICreate<F, R>[];
    skipDuplicates?: boolean;
  }): Promise<{ count: number }> {
    this._assertWritable('createMany');
    if (!Array.isArray(args.data) || args.data.length === 0) return { count: 0 };
    const mk = this._modelKey();
    const rows = args.data.map((d) => this.adapter.coerceInbound(this.model, this._fillAutoId(d)));
    const node = buildInsert(
      mk, this.model,
      { rows, skipDuplicates: args.skipDuplicates },
      schema as any,
    );
    node.countOnly = true;
    const { count } = await this.adapter.executeInsert(node, this.model, { session: this.session });
    return { count };
  }

  async update<A extends {
    where: WhereInput<F>;
    data: IUpdate<F, R>;
    select?: ISelect<F, R, SM>;
    include?: IInclude<R, SM>;
    omit?: { [K in keyof F]?: boolean };
  }>(
    args: A & NoBothSelectInclude<A>,
    // Internal hint set by softDelete()/restore() so the executor can tag
    // the emitted QueryEvent with `semanticOp`. Not part of the public API
    // (the `_` prefix is the convention); users should call softDelete()
    // / restore() directly rather than passing this themselves.
    _internal?: { semanticOp?: 'softDelete' | 'restore'; tolerateMissing?: boolean },
  ): Promise<Find1<F, R, A, SM>> {
    this._assertWritable('update');
    this._assertStrictWhere(args.where);
    const mk = this._modelKey();
    const { scalar, nested } = this._splitNestedWrites(args.data, /*forCreate*/ false);
    const node = this._coerceUpdateSet(buildUpdate(
      mk, this.model,
      {
        where: args.where,
        data: this._applyUpdatedAt(scalar),
        many: false,
        // Mirror the wrapper-level hint onto the IR so consumers can detect
        // soft-deletes from the compiled artifact alone.
        semantic: _internal?.semanticOp,
      },
      schema as any,
    ));
    const run = async (w: CollectionWrapper<F, R, SM>) => {
      const { doc } = await w.adapter.executeUpdate(node, w.model, {
        session: w.session,
        semanticOp: _internal?.semanticOp,
      });
      if (!doc) {
        if (_internal?.tolerateMissing) return null as never;
        throw notFoundError(w.model.collection, args.where);
      }
      if (nested.length > 0) await w._applyNestedWrites(doc, nested);
      return w._returnOne(doc, args);
    };
    if (nested.length === 0) return run(this);
    return runAtomic(this.adapter, this.session, (s) => run(this._bound(s)));
  }

  /**
   * Update ONE row by a filter that need not be unique, and hand back the
   * row — or `null` when nothing matched.
   *
   * The difference from `update()` is only the miss: `update()` throws. That
   * one difference is why a whole class of repository code was written as
   *
   *     await db.thing.updateMany({ where: { id }, data });
   *     const fresh = await db.thing.findFirst({ where: { id } });
   *     return fresh;
   *
   * which is TWO round trips, on essentially every write path, because a
   * repository wants "update it and give it back, or tell me it is not there"
   * and `update()` would 500 on the last part. This is that, in one.
   *
   * Like `update()` and unlike a read, it does NOT add the soft-delete
   * filter — so it can update an already-soft-deleted row, and it returns the
   * row even when the patch is what soft-deleted it. That last part matters:
   * the re-read pattern above returns null in exactly that case (the read IS
   * filtered), so callers had to take a third round trip to read the row
   * BEFORE the write and reconstruct the result by hand.
   */
  async updateFirst<A extends {
    where: WhereInput<F>;
    data: IUpdate<F, R>;
    select?: ISelect<F, R, SM>;
    include?: IInclude<R, SM>;
    omit?: { [K in keyof F]?: boolean };
  }>(args: A & NoBothSelectInclude<A>): Promise<Find1<F, R, A, SM> | null> {
    // A flag rather than a try/catch around update(): update() runs nested
    // writes after the row itself, and one of those can raise the same
    // not-found code. Catching it here would return null for a row that HAD
    // been updated.
    return this.update(args, { tolerateMissing: true }) as Promise<Find1<F, R, A, SM> | null>;
  }

  /**
   * Delete ONE row by a filter that need not be unique, and hand back the
   * deleted row — or `null` when nothing matched, where `delete()` throws.
   *
   * The idempotent shape: deleting something already gone is not an error.
   */
  async deleteFirst<A extends {
    where: WhereInput<F>;
    select?: ISelect<F, R, SM>;
    include?: IInclude<R, SM>;
    omit?: { [K in keyof F]?: boolean };
  }>(args: A & NoBothSelectInclude<A>): Promise<Find1<F, R, A, SM> | null> {
    return this.delete(args, { tolerateMissing: true }) as Promise<Find1<F, R, A, SM> | null>;
  }

  async updateMany(
    args: {
      where?: WhereInput<F>;
      data: IUpdate<F, R>;
    },
    _internal?: { semanticOp?: 'softDeleteMany' | 'restoreMany' },
  ): Promise<{ count: number }> {
    this._assertWritable('updateMany');
    this._assertStrictWhere(args.where);
    const mk = this._modelKey();
    const node = this._coerceUpdateSet(buildUpdate(
      mk, this.model,
      {
        where: args.where,
        data: this._applyUpdatedAt(args.data),
        many: true,
        semantic: _internal?.semanticOp,
      },
      schema as any,
    ));
    const r = await this.adapter.executeUpdate(node, this.model, {
      session: this.session,
      semanticOp: _internal?.semanticOp,
    });
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

    // A field that `create` seeds AND `update` hits with an atomic op
    // (increment / multiply / push / unset) cannot be expressed in one Mongo
    // upsert: the op path conflicts with $setOnInsert, and dropping the
    // create value (the old behaviour) meant a counter upserted with
    // `create: { seq: 100 }, update: { seq: { increment: 1 } }` came back 1,
    // not 100 — the seed silently vanished. For that case fall back to
    // update-then-create with a duplicate-key retry, which gives Prisma
    // semantics exactly: insert applies create only, update applies update
    // only. Plain `$set` overlap keeps the single atomic op — writing the
    // same field either way is well-defined and documented.
    const frag = buildUpdateData(this.model, args.update ?? {});
    const atomicPaths = [
      ...Object.keys(frag.increment ?? {}),
      ...Object.keys(frag.multiply ?? {}),
      ...Object.keys(frag.divide ?? {}),
      ...Object.keys(frag.max ?? {}),
      ...Object.keys(frag.min ?? {}),
      ...Object.keys(frag.push ?? {}),
      ...Object.keys(frag.addToSet ?? {}),
      ...Object.keys(frag.pull ?? {}),
      ...(frag.unset ?? []),
    ];
    const createKeys = new Set(Object.keys((args.create as object) ?? {}));
    // Mongo-only: SQL upserts (INSERT … ON CONFLICT) and IndexedDB
    // (select-then-insert) already apply create on insert and update on
    // conflict, so the overlap is well-defined there.
    const destructiveOverlap =
      this.adapter.kind === 'mongo' && atomicPaths.some((k) => createKeys.has(k));

    if (destructiveOverlap) {
      const node = this._coerceUpdateSet(buildUpdate(
        mk, this.model,
        { where: args.where, data: this._applyUpdatedAt(args.update), many: false },
        schema as any,
      ));
      let { doc } = await this.adapter.executeUpdate(node, this.model, { session: this.session });
      if (!doc) {
        try {
          return await this.create({
            data: args.create,
            select: (args as any).select,
            include: (args as any).include,
            omit: (args as any).omit,
          } as any) as any;
        } catch (err: any) {
          // Raced with a concurrent insert — the row exists now, so the
          // update leg must succeed. Anything else is a real error.
          if (!(err instanceof DbKnownError) || err.code !== 'P2002') throw err;
          ({ doc } = await this.adapter.executeUpdate(node, this.model, { session: this.session }));
          if (!doc) throw err;
        }
      }
      return this._returnOne(doc, args);
    }

    // Build a coerced create payload for $setOnInsert. The compile-from-ir
    // layer applies defaults; we only need to pre-coerce here so user-supplied
    // ids/dates become BSON types before going through Mongo's BSON.
    const createCoerced = this.adapter.coerceInbound(this.model, this._fillAutoId(args.create));
    const node = this._coerceUpdateSet(buildUpdate(
      mk, this.model,
      { where: args.where, data: this._applyUpdatedAt(args.update), many: false, upsertCreate: createCoerced },
      schema as any,
    ));
    const { doc } = await this.adapter.executeUpdate(node, this.model, { session: this.session });
    return this._returnOne(doc, args);
  }

  async delete<A extends {
    where: WhereInput<F>;
    select?: ISelect<F, R, SM>;
    include?: IInclude<R, SM>;
    omit?: { [K in keyof F]?: boolean };
  }>(
    args: A & NoBothSelectInclude<A>,
    _internal?: { tolerateMissing?: boolean },
  ): Promise<Find1<F, R, A, SM>> {
    this._assertWritable('delete');
    this._assertStrictWhere(args.where);
    const mk = this._modelKey();
    // Relations of a deleted row are read before it goes (Prisma does the
    // same): afterwards the row, and with a cascade its children, are gone.
    const before = this._readsRelationsBack(args)
      ? await this.findFirst({ where: args.where, select: args.select, include: args.include, omit: args.omit } as any)
      : undefined;
    // v2: delete() is ALWAYS a hard delete (Prisma parity) — no schema magic.
    // For the recoverable path on models that declare a `.softDeleteAt()`
    // field, use softDelete() / softDeleteMany() and restore() / restoreMany().
    const { doc } = this._walksCascades(mk)
      ? await this._deleteWithCascades(mk, args.where, false)
      : await this.adapter.executeDelete(
        buildDelete(mk, this.model, { where: args.where, many: false }, schema as any),
        this.model, { session: this.session },
      );
    if (!doc) {
      if (_internal?.tolerateMissing) return null as never;
      throw notFoundError(this.model.collection, args.where);
    }
    if (before !== undefined) return (before ? this._pruneToSelect(before, args) : this.adapter.decodeOutbound(this.model, doc)) as any;
    return this._returnOne(doc, args);
  }

  async deleteMany(args: { where?: WhereInput<F> } = {}): Promise<{ count: number }> {
    this._assertWritable('deleteMany');
    this._assertStrictWhere(args?.where);
    const mk = this._modelKey();
    // v2: hard delete always. See softDeleteMany() for the recoverable path.
    if (this._walksCascades(mk)) return { count: (await this._deleteWithCascades(mk, args.where, true)).count };
    const node = buildDelete(
      mk, this.model,
      { where: args.where, many: true },
      schema as any,
    );
    const r = await this.adapter.executeDelete(node, this.model, { session: this.session });
    return { count: r.count };
  }

  // onDelete in the wrapper, for a database that cannot do it itself (Mongo,
  // DuckDB, IndexedDB). SQL dialects with real foreign keys never get here.
  private _walksCascades(mk: string): boolean {
    if (this.adapter.capabilities?.nativeCascades !== false) return false;
    return hasCascadeWork(getActiveSchema() as any, mk);
  }

  private async _deleteWithCascades(mk: string, where: any, many: boolean): Promise<{ doc?: any; count: number }> {
    const models = getActiveSchema() as any;
    const probed = await this._probeCascade(mk, models, where, many);
    if (probed) return probed;
    return runAtomic(this.adapter, this.session, async (s) => {
      const opts = { session: s ?? this.session };
      const fields = cascadeKeyFields(models, mk, this.model);
      const select = Object.fromEntries(fields.map((f) => [f, true]));
      const targets = await this.adapter.executeSelect(
        buildSelect(mk, this.model, { where, select, ...(many ? {} : { take: 1 }) }, many ? 'many' : 'one', schema as any),
        this.model, opts,
      );
      if (targets.length === 0) return { count: 0 };
      await applyCascades(this.adapter, opts.session, models, mk, this.model, targets);
      const delWhere = this._cascadeDeleteWhere(where, many, fields[0], targets);
      return this.adapter.executeDelete(buildDelete(mk, this.model, { where: delWhere, many }, schema as any), this.model, opts);
    });
  }

  // A single delete removes exactly the row whose children were walked. A
  // many-delete keeps its own filter, unless that filter reads a relation:
  // the walk has just deleted or re-pointed those children, so the filter no
  // longer matches the rows it matched a moment ago. Those go by key.
  private _cascadeDeleteWhere(where: any, many: boolean, pk: string, targets: any[]): any {
    if (!many) return { AND: [where ?? {}, { [pk]: targets[0][pk] }] };
    return whereReadsRelation(this.model, where) ? { [pk]: { in: targets.map((t) => t[pk]) } } : where;
  }

  // Outside a transaction, on an adapter that can say in the same round trip
  // which child relations hold rows: when none does, the delete is a single
  // statement and needs no transaction. Otherwise the walk runs in one as
  // usual, skipping the relations that were empty. Returns undefined to fall
  // through to the full walk.
  private async _probeCascade(mk: string, models: any, where: any, many: boolean): Promise<{ doc?: any; count: number } | undefined> {
    const adapter = this.adapter;
    if (!adapter.selectWithChildPresence || this.session !== undefined) return undefined;
    const fields = cascadeKeyFields(models, mk, this.model);
    const select = Object.fromEntries(fields.map((f) => [f, true]));
    const { rows: targets, present } = await adapter.selectWithChildPresence(
      buildSelect(mk, this.model, { where, select, ...(many ? {} : { take: 1 }) }, many ? 'many' : 'one', schema as any),
      this.model, cascadeProbes(models, mk), {},
    );
    if (targets.length === 0) return { count: 0 };
    const delWhere = this._cascadeDeleteWhere(where, many, fields[0], targets);
    const del = (opts: { session?: unknown }) =>
      adapter.executeDelete(buildDelete(mk, this.model, { where: delWhere, many }, schema as any), this.model, opts);
    if (!present.some(Boolean)) return del({});
    return runAtomic(adapter, undefined, async (s) => {
      await applyCascades(adapter, s, models, mk, this.model, targets, present);
      return del({ session: s });
    });
  }

  /**
   * Soft delete — set the model's `.softDeleteAt()` field to now() so the row
   * is hidden from reads (find/count auto-filter it) yet recoverable via
   * restore(). Returns the updated row, honouring the same select/include/omit
   * options as delete(). Throws if the model has no `.softDeleteAt()` field —
   * use delete() for a hard delete.
   */
  async softDelete<A extends {
    where: WhereInput<F>;
    select?: ISelect<F, R, SM>;
    include?: IInclude<R, SM>;
    omit?: { [K in keyof F]?: boolean };
  }>(args: A & NoBothSelectInclude<A>): Promise<Find1<F, R, A, SM>> {
    this._assertWritable('softDelete');
    const sd = this._requireSoftDeleteField('softDelete');
    return this.update(
      { ...args, data: { [sd]: new Date() } as any } as any,
      { semanticOp: 'softDelete' },
    ) as any;
  }

  /** Bulk soft delete — sets `.softDeleteAt()` on every matching row. */
  async softDeleteMany(args: { where?: WhereInput<F> } = {}): Promise<{ count: number }> {
    this._assertWritable('softDeleteMany');
    const sd = this._requireSoftDeleteField('softDeleteMany');
    return this.updateMany(
      { where: args.where, data: { [sd]: new Date() } as any },
      { semanticOp: 'softDeleteMany' },
    );
  }

  /**
   * Restore a soft-deleted row — clears the `.softDeleteAt()` field so the row
   * is active (visible to reads) again. Reaches soft-deleted rows directly:
   * update() does not apply the soft-delete read filter. Throws if the model
   * has no `.softDeleteAt()` field.
   */
  async restore<A extends {
    where: WhereInput<F>;
    select?: ISelect<F, R, SM>;
    include?: IInclude<R, SM>;
    omit?: { [K in keyof F]?: boolean };
  }>(args: A & NoBothSelectInclude<A>): Promise<Find1<F, R, A, SM>> {
    this._assertWritable('restore');
    const sd = this._requireSoftDeleteField('restore');
    return this.update(
      { ...args, data: { [sd]: null } as any } as any,
      { semanticOp: 'restore' },
    ) as any;
  }

  /** Bulk restore — clears `.softDeleteAt()` on every matching row. */
  async restoreMany(args: { where?: WhereInput<F> } = {}): Promise<{ count: number }> {
    this._assertWritable('restoreMany');
    const sd = this._requireSoftDeleteField('restoreMany');
    return this.updateMany(
      { where: args.where, data: { [sd]: null } as any },
      { semanticOp: 'restoreMany' },
    );
  }

  /**
   * Whole-table aggregates — `{ _count, _sum, _avg, _min, _max }` over every
   * row the `where` matches, with no grouping key.
   *
   *   const { _sum, _count } = await db.order.aggregate({
   *     where: { status: 'paid' },
   *     _sum: { total: true },
   *     _count: { _all: true },
   *   });
   *
   * It is `groupBy` with an empty `by`, unwrapped from the one-element array
   * that returns. Before 2.18.0 only the Mongo-pipeline form below existed,
   * so this shape threw "aggregate() needs a pipeline" — while being the form
   * the documentation used throughout.
   *
   * An all-zero-row table still returns an object: the counts are 0 and every
   * sum/avg/min/max is null, rather than `undefined` from an empty array.
   */
  async aggregate<A extends {
    where?: WhereInput<F>;
    _count?: { _all?: boolean } & { [K in keyof F]?: boolean };
    _avg?:   { [K in keyof F]?: boolean };
    _sum?:   { [K in keyof F]?: boolean };
    _min?:   { [K in keyof F]?: boolean };
    _max?:   { [K in keyof F]?: boolean };
  }>(args: A): Promise<Record<string, any>>;
  // Replaces Prisma's aggregateRaw — same signature, returns plain documents
  // with stringified ObjectIds for ergonomic parity.
  async aggregate(args: { pipeline: any[]; options?: any } | any[]): Promise<any[]>;
  async aggregate(args: any): Promise<any> {
    const AGGS = ['_count', '_avg', '_sum', '_min', '_max'] as const;
    if (
      args && !Array.isArray(args) && !Array.isArray(args.pipeline) &&
      AGGS.some((k) => args[k] !== undefined)
    ) {
      const rows = await this.groupBy({ ...args, by: [] } as any);
      if (rows.length > 0) return rows[0];
      // Zero rows grouped means zero rows matched. Hand back the shape the
      // caller asked for with empty values, so destructuring cannot explode.
      const empty: Record<string, any> = {};
      for (const bucket of AGGS) {
        const req = args[bucket];
        if (!req) continue;
        const out: Record<string, any> = {};
        for (const field of Object.keys(req)) {
          if (!req[field]) continue;
          out[field] = bucket === '_count' ? 0 : null;
        }
        empty[bucket] = out;
      }
      return empty;
    }
    return this._aggregatePipeline(args);
  }

  private async _aggregatePipeline(args: { pipeline: any[]; options?: any } | any[]): Promise<any[]> {
    // Accept both `aggregate({ pipeline })` and the bare-array form
    // `aggregate([...])`. The bare form used to fall through to an EMPTY
    // pipeline — a silent full-collection scan — because `args.pipeline` was
    // undefined. Anything that isn't a pipeline in either shape now throws.
    const raw = Array.isArray(args)
      ? args
      : Array.isArray(args?.pipeline)
        ? args.pipeline
        : undefined;
    if (!raw) {
      throw new Error(
        `[forge] aggregate() needs a pipeline: aggregate({ pipeline: [...] }) ` +
        `or aggregate([...]). Got ${args === null ? 'null' : typeof args}.`,
      );
    }
    // Coerce MongoDB extended-JSON markers in the pipeline ({$oid, $date})
    // to native ObjectId/Date — Prisma's aggregateRaw did this transparently.
    const pipeline = coerceExtendedJSON(raw);
    const options = Array.isArray(args) ? undefined : args.options;
    const docs = await this.collection
      .aggregate(pipeline, { ...options, ...this.sessOpt })
      .toArray();
    return docs.map(stringifyObjectIds);
  }

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
    await (this.adapter as any).refreshView(this.model, { ...opts, session: this.session });
  }

  // Auto-refresh on an interval. Returns a stop() that clears the timer — the
  // caller owns the lifecycle (no hidden leaked timers). Uses the model's
  // declared `.asView({ refreshEvery })` value, or pass one explicitly.
  scheduleRefresh(every?: string): () => void {
    const spec = every ?? (this.model as any).view?.refreshEvery;
    const ms = parseDuration(spec);
    if (!ms) throw new Error(`[forge] scheduleRefresh needs a duration like '30s' / '5m' / '1h' (got ${JSON.stringify(spec)})`);
    const timer = setInterval(() => { void this.refresh().catch(() => { /* swallow — surfaced via $on('error') */ }); }, ms);
    if (typeof (timer as any).unref === 'function') (timer as any).unref();  // don't keep the process alive
    return () => clearInterval(timer);
  }

  // Return the soft-delete field name if the model has one.
  private _softDeleteField(): string | undefined {
    for (const [name, f] of Object.entries(this.model.fields)) {
      if ((f as any).softDeleteAt) return name;
    }
    return undefined;
  }

  // Resolve the soft-delete field or throw a clear error. Used by
  // softDelete/softDeleteMany/restore/restoreMany — operations that are
  // meaningless without a `.softDeleteAt()` field.
  private _requireSoftDeleteField(op: string): string {
    const sd = this._softDeleteField();
    if (!sd) {
      throw new Error(
        `[forge] ${op}() requires a field declared with .softDeleteAt() on ` +
        `'${this.model.collection}'. Either add one, or use delete() for a hard delete.`,
      );
    }
    return sd;
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
    // Build an IR SelectNode and hand it to the executor — the
    // adapter-agnostic boundary; SQL adapters consume the same node shape.
    this._assertStrictWhere(args?.where);
    const mk = this._modelKey();
    args = this._withSoftDeleteFilter(args);
    const cardinality: 'one' | 'many' = hardLimit === 1 ? 'one' : 'many';
    const node = buildSelect(mk, this.model, args ?? {}, cardinality, schema as any);
    if (node.lock) this._assertCanLock(node.lock);
    // If a hardLimit was specified (findFirst path), honour it even when the
    // user passed no take/limit.
    if (hardLimit != null && (node.limit == null || node.limit > hardLimit)) {
      node.limit = hardLimit;
    }
    const keyed = withJoinKeys(node);
    const rows = await this.adapter.executeSelect(keyed.node, this.model, { session: this.session });
    stripKeys(rows, keyed.added);
    return rows;
  }

  // A row lock lives until the transaction ends. Outside one, Postgres runs
  // the SELECT in its own implicit transaction and drops the lock the moment
  // the rows come back — the call would read as "locked" and lock nothing.
  private _assertCanLock(lock: RowLockSpec): void {
    // Throws for a dialect with no row locks, or a mode it cannot take.
    rowLockSql(this.adapter.kind, lock);
    if (!this.session) {
      throw new Error(
        `[forge] lock: on '${this.model.collection}' outside a transaction locks nothing — ` +
        `the lock is released as soon as the SELECT returns. Call it on the tx inside ` +
        `db.$transaction(async (tx) => …).`,
      );
    }
  }

  private async _returnOne(
    rawDoc: any,
    args: { select?: any; include?: any; omit?: any },
  ): Promise<any> {
    if (!rawDoc) return rawDoc;
    const decoded = this.adapter.decodeOutbound(this.model, rawDoc);
    if (this._readsRelationsBack(args)) {
      // The SQL adapters hydrate inside their select executor and nowhere
      // else, so a write with `include` came back without its relations
      // (and Mongo's ignored a nested `select`). Read the written row once
      // more through that executor.
      const pk = this._pkField();
      const [row] = await this._find(
        { where: { [pk]: decoded[pk], ...(this._softDeleteField() ? { _withDeleted: true } : {}) },
          select: args.select, include: args.include, omit: args.omit }, 1);
      return row ? this._pruneToSelect(row, args) : decoded;
    }
    const rows = [decoded];
    // Reuse the IR's projection plan + the executor's hydration helper so writes
    // get the exact same select/include/omit semantics as reads.
    const { projection, hydration } = buildProjection(this.model, args, schema as any);
    await this.adapter.applyProjectionAndHydration(
      rows, this.model, { projection, hydration }, { session: this.session },
    );
    // When `select` is exclusive, prune the row to just the requested scalar
    // keys (plus already-hydrated relations). The executor's projection only
    // controls what Mongo returns; for writes we already hold a full doc.
    if (projection?.exclusive && projection.fields.length) {
      const kept = new Set(projection.fields);
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

  // A read may carry keys an exclusive `select` did not ask for (Mongo's
  // `_id`); a write hands back exactly the selection.
  private _pruneToSelect(row: any, args: { select?: any; include?: any; omit?: any }): any {
    const { projection, hydration } = buildProjection(this.model, args, schema as any);
    if (!projection?.exclusive || !projection.fields.length) return row;
    const kept = new Set([...projection.fields, ...(hydration ?? []).map((h) => h.name), ...(projection.counts.length ? ['_count'] : [])]);
    const pruned: any = {};
    for (const k of Object.keys(row)) if (kept.has(k)) pruned[k] = row[k];
    return pruned;
  }

  private _readsRelationsBack(args: { select?: any; include?: any }): boolean {
    // IndexedDB hydrates the written row itself; every other adapter only
    // does it right inside its select (Mongo applied no nested `select`).
    if (this.adapter.kind === 'indexeddb') return false;
    const wants = (o: any) => !!o && typeof o === 'object' && Object.keys(o).some((key) => {
      if (!o[key]) return false;
      return key === '_count' || this.model.relations()[key] != null;
    });
    return wants(args.include) || wants(args.select);
  }

  private _pkField(): string {
    return Object.entries(this.model.fields).find(([, fd]) => (fd as any).kind === 'id')?.[0] ?? 'id';
  }

  // Prisma lets you write `parent.create({ data: { ..., rel: { create: {...} } } })`.
  // We split this into a scalar payload (passed to insertOne/updateOne) and a
  // list of nested operations to apply post-write. Inverse-side many relations
  // get FK-injected child writes; owning one-side `connect` rewrites the FK on
  // the parent's scalar payload.
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
          // then connect by id.
          nested.push({ rel, op: 'create', data: value.create });
        } else if (!forCreate && 'update' in value && value.update) {
          nested.push({ rel, op: 'update', data: value.update });
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
      // Updates before deletes, as Prisma runs them: a `deleteMany` filter
      // sees the rows as the `update` / `upsert` in the same call left them.
      if (!forCreate) {
        if (value.update) nested.push({ rel, op: 'update', data: value.update });
        if (value.updateMany) nested.push({ rel, op: 'updateMany', data: value.updateMany });
        if (value.upsert) nested.push({ rel, op: 'upsert', data: value.upsert });
      }
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
      // CRITICAL: pass _adapter and _strict so nested writes against the
      // target hit the same dialect. Dropping them silently falls through
      // to the default Mongo singleton, which would write to Mongo (or
      // fail to connect) when the outer wrapper is Postgres / MySQL /
      // SQLite.
      const targetWrapper = this._wrapperFor(target);

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

      if (op === 'create' && !rel.inverse && rel.kind === 'one') {
        // Owning side on an update: the target is made first, then this row
        // points at it.
        const d = Array.isArray(spec.data) ? spec.data[0] : spec.data;
        const made = await targetWrapper.create({ data: d });
        const tId = (made as any)?.[rel.refs] ?? (made as any)?.id;
        await this.update({ where: { id: parentDoc._id ?? parentDoc.id } as any, data: { [rel.on]: tId } as any });
        parentDoc[rel.on] = tId;
        continue;
      }
      if (op === 'create') {
        const items = (Array.isArray(spec.data) ? spec.data : [spec.data])
          .map((d: any) => targetWrapper._splitNestedWrites({ ...d, [childFkField]: fkValue }, true));
        await targetWrapper._insertRows(items, targetWrapper.session, false);
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
      // A nested write reaches this parent's children only. Without the FK
      // in the filter, `posts: { deleteMany: {} }` emptied the whole table
      // and `posts: { delete: { id } }` removed another user's post.
      const own = (where: any) => {
        const fk = { [childFkField]: fkValue };
        return where && Object.keys(where).length ? { AND: [where, fk] } : fk;
      };
      if (op === 'update' && !rel.inverse && rel.kind === 'one') {
        // Owning to-one: the row this parent points at.
        const d = wrapsData(target, spec.data) ? spec.data.data : spec.data;
        const ref = parentDoc[rel.on];
        if (ref == null) throw notFoundError(target.collection, { [rel.refs]: ref });
        await targetWrapper.update({ where: { [rel.refs]: ref } as any, data: d });
        continue;
      }
      if (op === 'update') {
        // To-many: `{ where, data }` (or a list of them). To-one: the data
        // itself, or `{ data }`.
        const items: any[] = rel.kind === 'many'
          ? (Array.isArray(spec.data) ? spec.data : [spec.data])
          : [wrapsData(target, spec.data) ? { where: spec.data.where, data: spec.data.data } : { data: spec.data }];
        for (const it of items) await targetWrapper.update({ where: own(it.where), data: it.data });
        continue;
      }
      if (op === 'updateMany') {
        const items: any[] = Array.isArray(spec.data) ? spec.data : [spec.data];
        for (const it of items) await targetWrapper.updateMany({ where: own(it.where), data: it.data });
        continue;
      }
      if (op === 'upsert') {
        const items: any[] = Array.isArray(spec.data) ? spec.data : [spec.data];
        for (const it of items) {
          await targetWrapper.upsert({
            where: rel.kind === 'many' ? it.where : (it.where ?? { [childFkField]: fkValue }),
            create: { ...(it.create ?? {}), [childFkField]: fkValue },
            update: it.update ?? {},
          } as any);
        }
        continue;
      }
      if (op === 'delete') {
        const targets = rel.kind === 'one' && spec.data === true ? [{}] : (Array.isArray(spec.data) ? spec.data : [spec.data]);
        for (const t of targets) {
          await targetWrapper.delete({ where: own(t) });
        }
        continue;
      }
      if (op === 'deleteMany') {
        const items: any[] = Array.isArray(spec.data) ? spec.data : [spec.data];
        for (const w of items) await targetWrapper.deleteMany({ where: own(w) });
        continue;
      }
      if (op === 'connectOrCreate') {
        // Prisma shape: { where: WhereUniqueInput, create: CreateInput }
        // either array (inverse-many) or single (owning-one).
        const items: any[] = Array.isArray(spec.data) ? spec.data : [spec.data];
        for (const it of items) {
          if (!it?.where) continue;
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
        // Persist the FK mutated for owning-one connectOrCreate. Use the
        // wrapper's own update so it flows through the adapter.
        if (!rel.inverse && parentDoc._id && parentDoc[rel.on] != null) {
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

function whereReadsRelation(model: ModelDef<any>, where: any): boolean {
  if (!where || typeof where !== 'object') return false;
  const rels = model.relations();
  for (const k of Object.keys(where)) {
    const v = where[k];
    if (k === 'AND' || k === 'OR' || k === 'NOT') {
      if ((Array.isArray(v) ? v : [v]).some((w) => whereReadsRelation(model, w))) return true;
    } else if (rels[k]) return true;
  }
  return false;
}

// A to-one nested `update` is either the data itself or `{ where?, data }`
// (Prisma accepts both). A model with a real `data` column is the first.
function wrapsData(target: ModelDef<any>, v: any): boolean {
  return !!v && typeof v === 'object' && 'data' in v && !('data' in target.fields)
    && Object.keys(v).every((k) => k === 'data' || k === 'where');
}

// A connectOrCreate `where` the wrapper can match in memory: scalar fields of
// the target compared by plain equality. Anything else (an operator object, a
// composite-unique key, a relation) is looked up row by row instead.
function isPlainEqWhere(target: ModelDef<any>, where: any): boolean {
  if (!where || typeof where !== 'object') return false;
  const keys = Object.keys(where);
  if (keys.length === 0) return false;
  for (const k of keys) {
    if (!(k in target.fields)) return false;
    const v = where[k];
    const t = typeof v;
    if (t !== 'string' && t !== 'number' && t !== 'boolean' && t !== 'bigint') return false;
  }
  return true;
}

function matchesPlainWhere(row: any, where: any): boolean {
  if (!row) return false;
  for (const k of Object.keys(where)) {
    const rv = row[k] ?? (k === 'id' ? row._id : undefined);
    if (rv == null || String(rv) !== String(where[k])) return false;
  }
  return true;
}

function whereKey(where: any): string {
  return JSON.stringify(Object.keys(where).sort().map((k) => [k, String(where[k])]));
}

// One key shared by every where (the usual unique `name` / `slug`) is an IN.
function lookupWhere(wheres: any[]): any {
  const keys = Object.keys(wheres[0]);
  if (keys.length === 1 && wheres.every((w) => Object.keys(w).length === 1 && keys[0] in w)) {
    return { [keys[0]]: { in: wheres.map((w) => w[keys[0]]) } };
  }
  return { OR: wheres };
}

function dedupeWheres(wheres: any[]): any[] {
  const seen = new Set<string>();
  return wheres.filter((w) => {
    const k = whereKey(w);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

// Rows strictly after `last` in the order `keys`:
//   (k1 > v1) OR (k1 = v1 AND k2 > v2) OR ...
function keysetAfter(keys: Array<{ field: string; dir: 'asc' | 'desc' }>, last: any): any {
  const ors: any[] = [];
  for (let i = 0; i < keys.length; i++) {
    const and: any[] = [];
    for (let j = 0; j < i; j++) and.push({ [keys[j].field]: last[keys[j].field] });
    and.push({ [keys[i].field]: { [keys[i].dir === 'asc' ? 'gt' : 'lt']: last[keys[i].field] } });
    ors.push(and.length === 1 ? and[0] : { AND: and });
  }
  return ors.length === 1 ? ors[0] : { OR: ors };
}

// Parse a simple duration string ('30s', '5m', '1h', '2d') to ms. Returns
// undefined for unparseable input so callers can give a clear error.
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
// Dates and other BSON scalar types (Decimal128, Binary, …) pass through
// untouched — recursing into them would flatten them to `{}` since they
// have no enumerable keys.
function stringifyObjectIds(doc: any): any {
  if (doc == null || typeof doc !== 'object') return doc;
  if (doc instanceof Date) return doc;
  if (doc._bsontype === 'ObjectId') return doc.toString();
  if (doc._bsontype) return doc;
  const out: any = Array.isArray(doc) ? [] : {};
  for (const k of Object.keys(doc)) {
    const v = (doc as any)[k];
    const key = k === '_id' ? 'id' : k;
    if (v && typeof v === 'object' && v._bsontype === 'ObjectId') {
      out[key] = v.toString();
    } else if (v instanceof Date) {
      out[key] = v;
    } else if (v && typeof v === 'object' && v._bsontype) {
      out[key] = v;
    } else if (v && typeof v === 'object') {
      out[key] = stringifyObjectIds(v);
    } else {
      out[key] = v;
    }
  }
  return out;
}

export { DbKnownError };

// Exported for unit tests only — not part of the public API.
export { stringifyObjectIds as __stringifyObjectIds };
