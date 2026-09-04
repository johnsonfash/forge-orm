import type { ClientSession, Document } from 'mongodb';
import { CollectionWrapper } from './builder/collection';
import { coerceExtendedJSON } from './adapters/mongo/coerce';
import { dbClient } from './client';
import { schema, SchemaMap } from './schema';
import { setActiveSchema, type SchemaShape } from './schema/active';
import { ModelFields, ModelRelations, TypedModel } from './schema/core';
import type { ModelDef } from './schema/types';
import type { Adapter, AdapterKind } from './adapters/types';
import type { SqlFragment } from './raw-sql';
import type { CompiledArtifact } from './compile';
import {
  explainPrefix,
  formatExplain,
  fragmentFromSql,
  inlineParams,
  type ExplainReport,
  type ExplainedQuery,
} from './explain';
import { detectAdapterKind } from './adapters/detect';
import { ForgeMissingDriverError } from './adapters/missing-driver';
import { MongoAdapter } from './adapters/mongo/adapter';
import { PostgresAdapter } from './adapters/postgres/adapter';
import { MysqlAdapter } from './adapters/mysql/adapter';
import { SqliteAdapter } from './adapters/sqlite/adapter';
import { DuckdbAdapter } from './adapters/duckdb/adapter';
import { MssqlAdapter } from './adapters/mssql/adapter';

// createDb() — adapter-agnostic factory. Three call shapes, all returning the
// same Db handle: URL only (adapter inferred), explicit type + URL, or
// structured config (type required, no url). On detection failure or
// driver-not-installed, throws an actionable error with the install command.

export interface CreateDbOptionsUrl {
  url: string;
  type?: AdapterKind;
  // Reject unknown `where` keys at runtime. Off by default (the WhereInput type
  // has a loose `[key: string]: any` escape hatch for composite-unique synthetic
  // keys); strict closes it, catching typos.
  strict?: boolean;
  // Bring-your-own schema — your `model(...)` map. When omitted, forge uses
  // the bundled sample schema. The map is bound to this connection, so several
  // dbs with different schemas can be open at once.
  schema?: SchemaShape;
}

export interface CreateDbOptionsStructured {
  type: AdapterKind;
  host: string;
  port?: number;
  database: string;
  user?: string;
  password?: string;
  ssl?: boolean;
  pool?: { min?: number; max?: number };
  // See CreateDbOptionsUrl.strict.
  strict?: boolean;
  // See CreateDbOptionsUrl.schema.
  schema?: SchemaShape;
}

// Bring-your-own-driver: hand forge a pre-wrapped driver port (expo-sqlite,
// op-sqlite, libsql, wasm-sqlite, …) instead of a URL. The driver's `kind`
// selects the adapter; `url` is optional and only used as a label.
export type ForgeDriver =
  | import('./adapters/sqlite/driver').SqliteDriver
  | import('./adapters/postgres/driver').PostgresDriver
  | import('./adapters/mysql/driver').MysqlDriver
  | import('./adapters/mongo/driver').MongoDriver;

export interface CreateDbOptionsDriver {
  driver: ForgeDriver;
  url?: string;
  strict?: boolean;
  schema?: SchemaShape;
}

export type CreateDbOptions = CreateDbOptionsUrl | CreateDbOptionsStructured | CreateDbOptionsDriver;

// CollectionFor resolves a model to its wrapper, threading the whole schema
// map S so nested include/select on this model's relations resolve against the
// SAME schema (the consumer's, or the sample by default).
type CollectionFor<M, S extends SchemaShape> = M extends TypedModel<any, any>
  ? CollectionWrapper<ModelFields<M>, ModelRelations<M>, S>
  : never;

type Collections<S extends SchemaShape> = { [K in keyof S]: CollectionFor<S[K], S> };

// ForgeDb is generic over the schema map S. `createDb({ schema })` infers S from
// the passed map, so `db.<yourModel>` is fully typed; with no schema it defaults
// to the bundled sample's SchemaMap.
export type ForgeDb<S extends SchemaShape = SchemaMap> = Collections<S> & {
  readonly adapter: Adapter;
  $transaction: {
    <T>(fn: (tx: ForgeDb<S>) => Promise<T>): Promise<T>;
    <T extends readonly unknown[] | []>(
      promises: T,
    ): Promise<{ -readonly [P in keyof T]: Awaited<T[P]> }>;
  };
  $runCommandRaw(command: Document): Promise<any>;
  // Accepts BOTH call styles:
  //   db.$queryRaw`SELECT * FROM users WHERE id = ${id}`   — tagged template
  //   db.$queryRaw(forgeSql.sql`SELECT ...`)               — pre-built fragment
  $queryRaw: {
    <T = any>(strings: TemplateStringsArray, ...values: unknown[]): Promise<T[]>;
    <T = any>(fragment: SqlFragment): Promise<T[]>;
  };
  $executeRaw: {
    (strings: TemplateStringsArray, ...values: unknown[]): Promise<number>;
    (fragment: SqlFragment): Promise<number>;
  };
  $disconnect(): Promise<void>;
  // Runtime DDL apply — the browser/wasm replacement for `forge push`. Reads
  // the active schema, emits dialect DDL, applies what's missing inside a
  // transaction. Idempotent — already-existing tables/indexes are skipped.
  // sqlite, indexeddb and postgres (2.15+, which covers PGlite — an
  // in-process database has no server for the CLI to reach). Since 2.5.1 also runs
  // a drift-apply pass: missing columns that can be safely added (nullable, or
  // have a constant default) get `ALTER TABLE … ADD COLUMN` emitted; destructive
  // drift (column drops, type changes, extra tables) is surfaced under `pending`.
  // Returns: { applied, skipped, failures, alteredColumns, pending }.
  $migrate(opts?: { logger?: (line: string) => void; alter?: boolean }): Promise<import('./wasm/migrate').RuntimeApplyReport>;
  // Runtime capability probe — the browser/wasm replacement for `forge doctor`.
  // On sqlite adapters (including the wasm one) returns the rich
  // BrowserDoctorReport (environment + sqlite + capabilities + notes); on
  // other adapters returns the plain adapter DoctorReport. Useful in-app for
  // rendering "what works on this device" panels.
  $doctor(): Promise<import('./adapters/types').DoctorReport | import('./wasm/browser-doctor').BrowserDoctorReport>;
  // Drift detection — the browser/wasm replacement for `forge diff`. Reads
  // the current DB shape via adapter.introspect(), diffs against the active
  // schema, returns a structured DriftReport. Works on every adapter.
  $diff(opts?: { ignore?: import('./scripts/diff-core').IgnoreSpec }): Promise<import('./scripts/diff-core').DriftReport>;
  // Query lifecycle pub/sub. Subscribe before queries run; the returned
  // function unsubscribes. Listener errors never break queries.
  $on: {
    (event: 'query', cb: (e: import('./events').QueryEvent) => void | Promise<void>): () => void;
    (event: 'error', cb: (e: import('./events').ErrorEvent) => void | Promise<void>): () => void;
  };
  $off: {
    (event: 'query', cb: (e: import('./events').QueryEvent) => void): void;
    (event: 'error', cb: (e: import('./events').ErrorEvent) => void): void;
  };
  // See a query WITHOUT running it — SQL + parameters, and with
  // `{ analyze: true }` the database's own plan.
  //
  //   await db.$explain((q) => q.user.findMany({ where: { age: { gt: 30 } } }))
  //
  // The callback may take the capturing db (preferred — it cannot execute
  // anything, so an async callback is safe), or take nothing and close
  // over the real db, which works only while the query is issued
  // synchronously. Never emits EXPLAIN ANALYZE: that runs the statement.
  $explain(
    fn: (q: ForgeDb<S>) => unknown,
    opts?: { analyze?: boolean },
  ): Promise<import('./explain').ExplainReport>;
  // Names of every model this db exposes, sorted. Reading an unregistered
  // model THROWS (see unknownModel), which is deliberate — a typo should be
  // loud. But that left no way to ask whether a model exists, so callers
  // wrapping optional models had to use try/catch. Prefer `'X' in db`, or
  // this when you need the whole list.
  readonly $models: string[];
};

const PROXY_PASSTHROUGH = new Set<PropertyKey>([
  'then', 'toJSON', 'toString', 'valueOf', 'inspect', 'constructor',
  'asymmetricMatch', '$$typeof', 'nodeType',
]);

// Everything the db proxy answers besides the registered models. `has` must
// report these too, or `'$transaction' in db` would be false on a db that
// plainly has one. The tx proxy serves a strict subset — $migrate/$doctor/
// $diff are not available mid-transaction — so it gets its own set rather
// than claiming keys whose access would throw.
const DB_HELPER_KEYS = new Set<string>([
  'adapter', '$models', '$transaction', '$runCommandRaw', '$queryRaw',
  '$executeRaw', '$disconnect', '$migrate', '$doctor', '$diff', '$explain',
  '$on', '$off',
]);
const TX_HELPER_KEYS = new Set<string>([
  'adapter', '$models', '$transaction', '$runCommandRaw', '$queryRaw',
  '$executeRaw', '$disconnect', '$on', '$off',
]);

// `models` may be the live global schema proxy, so neither the lookup nor the
// key listing is guaranteed side-effect free. Both are defensive: a probe for
// "does this exist" must never be the thing that throws.
function modelExists(models: Record<string, unknown>, key: string): boolean {
  try {
    return models[key] != null;
  } catch {
    return false;
  }
}

function modelNames(models: Record<string, unknown>): string[] {
  try {
    return Object.keys(models).sort();
  } catch {
    return [];
  }
}

// A missing model used to resolve to `undefined`, so the first symptom was
// `Cannot read properties of undefined (reading 'findMany')` several frames away
// from the cause. Naming the key and listing what IS active points straight at
// the real problem — usually a typo or a schema that never reached createDb.
function unknownModel(key: string, models: Record<string, unknown>): Error {
  let available = '<none>';
  try {
    available = Object.keys(models).sort().join(', ') || '<none>';
  } catch {
    available = '<no active schema>';
  }
  return new Error(
    `[forge] unknown model "${key}". Active schema exposes: ${available}. ` +
    'Pass your model map as createDb({ schema }) and check the key spelling.',
  );
}

export async function createDb<S extends SchemaShape = SchemaMap>(
  opts: CreateDbOptions & { schema?: S },
): Promise<ForgeDb<S>> {
  // Bring-your-own-schema: activate the consumer's model map (if given) before
  // anything reads the schema. Defaults to the bundled sample otherwise.
  if (opts.schema) setActiveSchema(opts.schema);
  const { adapter, url } = await pickAndConnect(opts);
  return makeDb(adapter, url, { strict: opts.strict === true, models: opts.schema }) as unknown as ForgeDb<S>;
}

async function pickAndConnect(opts: CreateDbOptions): Promise<{ adapter: Adapter; url: string }> {
  // Injected driver path — kind comes from the driver, no URL detection.
  if ('driver' in opts && opts.driver) {
    const kind = opts.driver.kind;
    const label = opts.url ?? `${kind}:injected`;
    const adapter = instantiateAdapter(kind, opts.driver);
    await adapter.connect(label);
    return { adapter, url: label };
  }
  const url = 'url' in opts && opts.url ? opts.url : buildUrlFromStructured(opts as CreateDbOptionsStructured);
  const kind = ('type' in opts && opts.type) || detectAdapterKind(url);
  if (!kind) {
    throw new Error(
      `[forge] Could not infer adapter from URL '${redactForLog(url)}'.\n` +
      `  Pass an explicit type: createDb({ type: 'mongo' | 'postgres' | 'mysql' | 'sqlite', url })`,
    );
  }
  if ('type' in opts && opts.type && 'url' in opts && opts.url) {
    const detected = detectAdapterKind(opts.url);
    if (detected && detected !== opts.type) {
      throw new Error(
        `[forge] type='${opts.type}' but URL prefix indicates '${detected}'. ` +
        `Fix one of them before continuing.`,
      );
    }
  }
  // `pglite:` resolves to the postgres adapter, but there is no server to
  // dial — the database is a WASM module in this process. Build its driver
  // here so the URL works on its own, the way every other scheme does.
  if (/^pglite:/i.test(url)) {
    const { pgliteDriverFromUrl } = await import('./adapters/postgres/pglite-driver');
    const driver = await pgliteDriverFromUrl(url);
    const adapter = instantiateAdapter('postgres', driver);
    await adapter.connect(url);
    return { adapter, url };
  }
  const adapter = instantiateAdapter(kind);
  await adapter.connect(url);
  return { adapter, url };
}

function instantiateAdapter(kind: AdapterKind, driver?: ForgeDriver): Adapter {
  switch (kind) {
    case 'mongo':
      return new MongoAdapter(driver as import('./adapters/mongo/driver').MongoDriver | undefined);
    case 'postgres':
      return new PostgresAdapter(driver as import('./adapters/postgres/driver').PostgresDriver | undefined);
    case 'mysql':
      return new MysqlAdapter(driver as import('./adapters/mysql/driver').MysqlDriver | undefined);
    case 'sqlite':
      return new SqliteAdapter(driver as import('./adapters/sqlite/driver').SqliteDriver | undefined);
    case 'duckdb':
      return new DuckdbAdapter(driver as import('./adapters/duckdb/driver').DuckdbDriver | undefined);
    case 'mssql':
      return new MssqlAdapter(driver as import('./adapters/mssql/driver').MssqlDriver | undefined);
    case 'indexeddb': {
      // Lazy-import so server bundles that never touch IDB don't pay for the
      // adapter's browser-only globals at eval time.
      const { IndexeddbAdapter } = require('./adapters/indexeddb/adapter') as typeof import('./adapters/indexeddb/adapter');
      return new IndexeddbAdapter(driver as import('./adapters/indexeddb/driver').IdbDriver | undefined);
    }
  }
}

function buildUrlFromStructured(o: CreateDbOptionsStructured): string {
  const scheme =
    o.type === 'postgres' ? 'postgres' :
    o.type === 'mysql'    ? 'mysql'    :
    o.type === 'sqlite'   ? 'sqlite'   :
    'mongodb';
  if (o.type === 'sqlite') return `sqlite:${o.database}`;
  const auth = o.user ? `${encodeURIComponent(o.user)}${o.password ? `:${encodeURIComponent(o.password)}` : ''}@` : '';
  const port = o.port ? `:${o.port}` : '';
  const ssl = o.ssl ? '?sslmode=require' : '';
  return `${scheme}://${auth}${o.host}${port}/${o.database}${ssl}`;
}

function redactForLog(url: string): string {
  return url.replace(/(:\/\/[^:@/]+):([^@/]+)@/, '$1:****@');
}

// ─── Db handle construction ─────────────────────────────────────────────────

// Wraps an adapter method so it accepts BOTH tagged-template syntax and a
// pre-built SqlFragment.
function makeRawCaller<R>(run: (frag: SqlFragment) => Promise<R>) {
  return function (first: any, ...values: unknown[]): Promise<R> {
    // Tagged-template signature: first arg is a TemplateStringsArray, which
    // exposes a `.raw` array of strings. SqlFragments don't.
    if (Array.isArray(first) && (first as any).raw && Array.isArray((first as any).raw)) {
      const frag: SqlFragment = { __forgeSql: true, strings: first as readonly string[], values } as const;
      return run(frag);
    }
    return run(first as SqlFragment);
  };
}

// The subset of a pg Pool the runtime migrator needs. `connect` is absent
// on injected single-session drivers (PGlite, Neon over HTTP).
interface PgPoolLike {
  query(sql: string, params?: unknown[]): Promise<{ rows: any[]; rowCount: number }>;
  connect?(): Promise<unknown>;
}

function makeDb(
  adapter: Adapter,
  _url: string,
  runtime: { strict: boolean; models?: SchemaShape } = { strict: false },
): ForgeDb<any> {
  const cache: Partial<Record<keyof SchemaMap, CollectionWrapper<any>>> = {};

  // Bound to THIS db rather than read from the global registry, so a process can
  // hold several connections with different schemas at once — opening a second
  // db used to move the global pointer and strand every model on the first.
  // Falls back to the live global proxy when no schema was passed to createDb.
  const models: any = runtime.models ?? schema;

  const root: any = new Proxy({}, {
    get: (_t, prop) => {
      if (typeof prop === 'symbol' || PROXY_PASSTHROUGH.has(prop)) return undefined;
      const key = String(prop);
      if (key === 'adapter') return adapter;
      if (key === '$transaction') return $transaction;
      if (key === '$runCommandRaw') return $runCommandRaw;
      if (key === '$queryRaw') return makeRawCaller((frag) => adapter.$queryRaw(frag));
      if (key === '$executeRaw') return makeRawCaller((frag) => adapter.$executeRaw(frag));
      if (key === '$disconnect') return () => adapter.close();
      if (key === '$migrate') return $migrate;
      if (key === '$doctor') return $doctor;
      if (key === '$diff') return $diff;
      if (key === '$explain') return $explain;
      if (key === '$on') return (event: any, cb: any) => adapter.emitter.on(event, cb);
      if (key === '$off') return (event: any, cb: any) => adapter.emitter.off(event, cb);
      if (key === '$models') return modelNames(models);
      const model = models[key] as ModelDef<any> | undefined;
      if (!model) throw unknownModel(key, models);
      if (!cache[key as keyof SchemaMap]) {
        // Wrapper takes the active adapter so every execute / coerce / decode /
        // cascade call dispatches through the right dialect — otherwise every
        // wrapper would silently fall back to the Mongo singleton.
        cache[key as keyof SchemaMap] = new CollectionWrapper(model, undefined, adapter, runtime.strict);
      }
      // Inside a synchronous $explain() window, hand back the capturing
      // shim instead of the live wrapper, so `db.user.findMany(...)` in
      // the callback compiles rather than executes.
      if (capture) return captureWrapper(key, cache[key as keyof SchemaMap]!, capture);
      return cache[key as keyof SchemaMap];
    },
    // Without this, `'User' in db` was FALSE for a registered model — the
    // trap was never defined, so `in` fell through to the empty target. That
    // is worse than unhelpful: reading an unknown model throws, so `in` was
    // the natural way to check first, and it lied. Now it answers honestly
    // and gives callers a probe that cannot throw.
    has: (_t, prop) => {
      if (typeof prop === 'symbol' || PROXY_PASSTHROUGH.has(prop)) return false;
      const key = String(prop);
      return DB_HELPER_KEYS.has(key) || modelExists(models, key);
    },
  });

  // ── $explain ────────────────────────────────────────────────────────
  //
  // Set only for the synchronous window of a zero-arg $explain callback.
  // Single-threaded JS means nothing else can run in that window, so this
  // cannot leak into a concurrent query — but it also means the window
  // closes at the first `await`, which is why the callback that takes `q`
  // is the one to reach for.
  let capture: ExplainedQuery[] | null = null;

  // Wrapper ops whose SQL is identical to another op's. `…OrThrow` differs
  // only in what it does with an empty result, which is after the query.
  const OP_ALIAS: Record<string, string> = {
    findFirstOrThrow: 'findFirst',
    findUniqueOrThrow: 'findUnique',
  };
  // Ops with no compile equivalent. Naming them individually beats a
  // generic "not supported" — the caller learns which of the two it is.
  const NO_COMPILE: Record<string, string> = {
    groupBy: 'groupBy builds its shape across several statements',
    aggregate: 'aggregate is executed by the adapter, not compiled',
    findManyStream: 'findManyStream is a cursor, not a single statement',
    refresh: 'refresh is DDL, not a query',
    scheduleRefresh: 'scheduleRefresh is a timer, not a query',
  };

  function captureWrapper(
    modelKey: string,
    wrapper: CollectionWrapper<any>,
    sink: ExplainedQuery[],
  ): any {
    return new Proxy({}, {
      get: (_t, prop) => {
        if (typeof prop === 'symbol') return undefined;
        const op = String(prop);
        if (NO_COMPILE[op]) {
          return () => {
            throw new Error(
              `[forge] $explain() cannot compile ${modelKey}.${op}() — ` +
              `${NO_COMPILE[op]}.\n` +
              `  → explain the read it is built on, or run it and read the ` +
              `SQL from db.$on('query', …).`,
            );
          };
        }
        const compileOp = OP_ALIAS[op] ?? op;
        const api = wrapper.compile as unknown as Record<string, (a: any) => CompiledArtifact>;
        if (typeof api[compileOp] !== 'function') {
          return () => {
            throw new Error(
              `[forge] $explain(): '${op}' is not a query on ${modelKey}. ` +
              `Explainable ops: ${Object.keys(api).sort().join(', ')}.`,
            );
          };
        }
        return (args?: any) => {
          const artifact = api[compileOp]!(args ?? {});
          sink.push({
            model: modelKey,
            table: (wrapper as any).model?.collection ?? modelKey,
            op,
            artifact,
            readable:
              artifact.kind === 'sql'
                ? inlineParams(artifact.sql, artifact.params, artifact.dialect)
                : undefined,
          });
          // A resolved empty result, never a rejection: the callback's
          // return value is discarded, and a rejected promise nobody
          // awaits is an unhandled-rejection warning for doing nothing
          // wrong.
          return Promise.resolve([]);
        };
      },
      has: () => true,
    });
  }

  // A db whose models can only compile. Handed to callbacks that take an
  // argument — it holds no session and reaches no driver, so there is no
  // window during which anything could execute.
  function makeCaptureDb(sink: ExplainedQuery[]): any {
    return new Proxy({}, {
      get: (_t, prop) => {
        if (typeof prop === 'symbol' || PROXY_PASSTHROUGH.has(prop)) return undefined;
        const key = String(prop);
        if (key === 'adapter') return adapter;
        if (key === '$models') return modelNames(models);
        if (key.startsWith('$')) {
          throw new Error(
            `[forge] ${key}() is not available inside $explain() — the ` +
            `capturing db compiles queries and never reaches the driver.`,
          );
        }
        const model = models[key] as ModelDef<any> | undefined;
        if (!model) throw unknownModel(key, models);
        if (!cache[key as keyof SchemaMap]) {
          cache[key as keyof SchemaMap] = new CollectionWrapper(model, undefined, adapter, runtime.strict);
        }
        return captureWrapper(key, cache[key as keyof SchemaMap]!, sink);
      },
      has: (_t, prop) => {
        if (typeof prop === 'symbol' || PROXY_PASSTHROUGH.has(prop)) return false;
        return modelExists(models, String(prop));
      },
    });
  }

  async function $explain(
    fn: (q: any) => unknown,
    opts?: { analyze?: boolean },
  ): Promise<ExplainReport> {
    if (typeof fn !== 'function') {
      throw new Error(
        `[forge] $explain() takes a callback: db.$explain((q) => q.user.findMany({ … })).`,
      );
    }
    const sink: ExplainedQuery[] = [];

    if (fn.length >= 1) {
      // The callback asked for the capturing db. Nothing it holds can
      // execute, so awaiting it is safe.
      await fn(makeCaptureDb(sink));
    } else {
      if (capture) {
        throw new Error('[forge] $explain() cannot be nested.');
      }
      capture = sink;
      let returned: unknown;
      try {
        // Zero-arity by definition here — the branch is chosen on fn.length.
        returned = (fn as () => unknown)();
      } finally {
        // Synchronously, before any microtask — so the window cannot
        // stay open across an await in the caller's code.
        capture = null;
      }
      if (sink.length === 0) {
        const awaited = !!returned && typeof (returned as any).then === 'function';
        throw new Error(
          `[forge] $explain() captured no query.\n` +
          (awaited
            ? `  The callback returned a promise and issued nothing synchronously. ` +
              `A zero-argument callback is only intercepted for as long as it runs ` +
              `synchronously, so any query after an 'await' RAN FOR REAL.\n`
            : `  The callback issued no query at all.\n`) +
          `  → take the capturing db instead — it cannot execute anything:\n` +
          `      db.$explain((q) => q.user.findMany({ … }))`,
        );
      }
    }

    const dialect: any = adapter.kind === 'mongo' ? 'mongo' : adapter.kind;
    const report: ExplainReport = {
      dialect,
      queries: sink,
      analyzed: false,
      toString() { return formatExplain(this); },
    };
    if (!opts?.analyze) return report;

    for (const q of sink) {
      q.plan = await fetchPlan(q);
    }
    report.analyzed = true;
    return report;
  }

  // The database's own plan. EXPLAIN only — never EXPLAIN ANALYZE, which
  // would execute the statement, and on a deleteMany that means deleting
  // the rows.
  async function fetchPlan(q: ExplainedQuery): Promise<unknown> {
    if (q.artifact.kind === 'sql') {
      const { sql, params, dialect } = q.artifact;
      const frag = fragmentFromSql(sql, params, dialect, explainPrefix(dialect));
      const rows = await adapter.$queryRaw(frag);
      // Postgres and MySQL each return one row wrapping the whole plan;
      // SQLite returns a row per step. Unwrap the first shape, keep the
      // second — a caller reading `plan` should not have to know which.
      if (rows.length === 1) {
        const only = rows[0] as Record<string, unknown>;
        const keys = Object.keys(only ?? {});
        if (keys.length === 1) {
          const v = only[keys[0]!];
          if (typeof v === 'string') {
            try { return JSON.parse(v); } catch { return v; }
          }
          return v;
        }
      }
      return rows;
    }
    // Mongo: the explain command wraps the operation it would have run.
    const a = q.artifact;
    const coll = q.table;
    let cmd: Record<string, unknown>;
    if (a.op === 'find' || a.op === 'findOne') {
      const o = (a.args.options ?? {}) as Record<string, unknown>;
      cmd = { find: coll, filter: a.args.filter ?? {} };
      for (const k of ['sort', 'limit', 'skip', 'projection'] as const) {
        if (o[k] !== undefined) cmd[k] = o[k];
      }
      if (a.op === 'findOne') cmd.limit = 1;
    } else if (a.op === 'countDocuments') {
      cmd = { count: coll, query: a.args.filter ?? {} };
    } else if (a.op === 'aggregate') {
      cmd = { aggregate: coll, pipeline: a.args.pipeline ?? [], cursor: {} };
    } else {
      throw new Error(
        `[forge] $explain({ analyze: true }) covers reads on Mongo — ` +
        `find, findOne, count and aggregate. '${a.op}' is a write, and ` +
        `explaining one means asking the server to plan a change to your ` +
        `data.\n` +
        `  → drop 'analyze' to see the command itself, which is what you ` +
        `would hand to mongosh.`,
      );
    }
    return $runCommandRaw({ explain: cmd, verbosity: 'queryPlanner' } as any);
  }

  // Dispatches through the adapter — works for both Mongo (replica-set
  // ClientSession) and Postgres (pg PoolClient).
  function $transaction(arg: any): any {
    if (Array.isArray(arg)) return Promise.all(arg);
    return adapter.$transaction(async (session) => arg(makeTx(session)));
  }

  // Runtime DDL apply for the wasm path. Lazy-imports the migrator so the
  // mongo/pg/mysql bundles never pull in the sqlite DDL emitter.
  async function $migrate(opts?: { logger?: (line: string) => void }) {
    if (adapter.kind === 'sqlite') {
      const { runMigrate } = await import('./wasm/migrate');
      // adapter.db is the SqliteDriver after connect; the sqlite adapter exposes
      // it as a getter so an injected wasm driver works the same as a default
      // better-sqlite3 driver.
      const driver = (adapter as unknown as { db: import('./adapters/sqlite/driver').SqliteDriver }).db;
      return runMigrate(driver, opts);
    }
    if (adapter.kind === 'indexeddb') {
      // IDB opens are idempotent when the fingerprint matches (same version
      // → no upgrade cycle at all). So the second-open pattern used here
      // is essentially a metadata check + report — cheap.
      const { runMigrate } = await import('./adapters/indexeddb/migrate');
      const url = _url ?? 'forge';
      const name = url.startsWith('idb:') ? (url.slice(4) || 'forge')
                 : url.startsWith('indexeddb:') ? (url.slice(10) || 'forge')
                 : (url || 'forge');
      return runMigrate({ name, schema: models, logger: opts?.logger }) as unknown as import('./wasm/migrate').RuntimeApplyReport;
    }
    if (adapter.kind === 'postgres') {
      // Postgres reached here only to be told to use the CLI — which is no
      // help at all when the database is PGlite: an in-process WASM
      // Postgres with no server to point `forge push` at, running in
      // StackBlitz or a browser or a serverless function where there is no
      // shell either. That is the same situation sqlite-wasm is in, and it
      // has had a runtime path since 2.4.
      //
      // No new migration logic: this is the plan/apply the CLI already
      // uses, driven from in-process instead of from a pool.
      const { buildSchemaDDL } = await import('./adapters/postgres/ddl');
      const { applyMigration } = await import('./adapters/postgres/migrate');
      const pool = (adapter as unknown as { pool: PgPoolLike }).pool;
      // A pg.Pool hands out a client per connect(). An injected driver —
      // PGlite, Neon over HTTP, anything single-session — has no connect()
      // and IS the session, so the client is the pool itself.
      const handle =
        typeof pool.connect === 'function'
          ? pool
          : {
              query: (sql: string, params?: unknown[]) => pool.query(sql, params),
              connect: async () => ({
                query: (sql: string, params?: unknown[]) => pool.query(sql, params),
              }),
            };
      const report = await applyMigration(
        handle as never,
        buildSchemaDDL(models as SchemaMap),
        opts?.logger ? { logger: opts.logger } : {},
      );
      return { ...report, alteredColumns: [], pending: [] };
    }
    throw new Error(
      `[forge] $migrate() is only supported on sqlite, postgres and indexeddb ` +
      `adapters today. For ${adapter.kind} use the CLI: 'npx forge push'.`,
    );
  }

  // Runtime capability probe. sqlite adapter routes through the rich
  // browserDoctor (environment + extension presence + remediation notes);
  // every other adapter falls back to its own adapter.doctor() report.
  async function $doctor() {
    if (adapter.kind === 'sqlite') {
      const { browserDoctor } = await import('./wasm/browser-doctor');
      const driver = (adapter as unknown as { db: import('./adapters/sqlite/driver').SqliteDriver }).db;
      return browserDoctor(driver);
    }
    return adapter.doctor();
  }

  // Runtime drift detection — reads live DB shape, diffs against the active
  // schema. Mirrors the `forge diff` CLI; works on every adapter.
  async function $diff(opts?: { ignore?: import('./scripts/diff-core').IgnoreSpec }) {
    const { diffIntrospection } = await import('./scripts/diff-core');
    if (typeof adapter.introspect !== 'function') {
      throw new Error(
        `[forge] $diff(): adapter '${adapter.kind}' does not support introspection.`,
      );
    }
    const introspection = await adapter.introspect();
    return diffIntrospection(models as Record<string, any>, introspection, opts?.ignore ?? []);
  }

  // Mongo-only — it's the BSON command channel. SQL consumers reach for
  // $queryRaw / $executeRaw instead.
  function $runCommandRaw(command: Document) {
    if (adapter.kind !== 'mongo') {
      throw new Error('[forge] $runCommandRaw is Mongo-only. Use $queryRaw on SQL adapters.');
    }
    return dbClient.db.command(coerceExtendedJSON(command));
  }

  function makeTx(session: unknown): ForgeDb<any> {
    const txCache: Record<string, CollectionWrapper<any>> = {};
    return new Proxy({} as any, {
      get: (_t, prop) => {
        if (typeof prop === 'symbol' || PROXY_PASSTHROUGH.has(prop)) return undefined;
        const key = String(prop);
        if (key === 'adapter') return adapter;
        if (key === '$transaction') return (a: any) => Array.isArray(a) ? Promise.all(a) : a(makeTx(session));
        if (key === '$queryRaw')   return makeRawCaller((frag) => adapter.$queryRaw(frag, { session }));
        if (key === '$executeRaw') return makeRawCaller((frag) => adapter.$executeRaw(frag, { session }));
        if (key === '$runCommandRaw') {
          if (adapter.kind !== 'mongo') {
            return () => Promise.reject(new Error('[forge] $runCommandRaw is Mongo-only.'));
          }
          return (c: any) => dbClient.db.command(c, { session: session as ClientSession });
        }
        if (key === '$disconnect') return () => adapter.close();
        if (key === '$on') return (event: any, cb: any) => adapter.emitter.on(event, cb);
        if (key === '$off') return (event: any, cb: any) => adapter.emitter.off(event, cb);
        if (key === '$models') return modelNames(models);
        const model = models[key] as ModelDef<any> | undefined;
        if (!model) throw unknownModel(key, models);
        if (!txCache[key]) {
          // Tx wrapper: same adapter, plus the opaque session from
          // adapter.$transaction (ClientSession / PoolClient / ...).
          txCache[key] = new CollectionWrapper(model, session, adapter, runtime.strict);
        }
        return txCache[key];
      },
      has: (_t, prop) => {
        if (typeof prop === 'symbol' || PROXY_PASSTHROUGH.has(prop)) return false;
        const key = String(prop);
        return TX_HELPER_KEYS.has(key) || modelExists(models, key);
      },
    });
  }

  return root as ForgeDb<any>;
}
