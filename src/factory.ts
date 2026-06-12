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
import { detectAdapterKind } from './adapters/detect';
import { ForgeMissingDriverError } from './adapters/missing-driver';
import { MongoAdapter } from './adapters/mongo/adapter';
import { PostgresAdapter } from './adapters/postgres/adapter';
import { MysqlAdapter } from './adapters/mysql/adapter';
import { SqliteAdapter } from './adapters/sqlite/adapter';

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
  // the bundled sample schema. One active schema per process.
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
// op-sqlite, libsql, …) instead of a URL. The driver's `kind` selects the
// adapter; `url` is optional and only used as a label.
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
};

const PROXY_PASSTHROUGH = new Set<PropertyKey>([
  'then', 'toJSON', 'toString', 'valueOf', 'inspect', 'constructor',
  'asymmetricMatch', '$$typeof', 'nodeType',
]);

export async function createDb<S extends SchemaShape = SchemaMap>(
  opts: CreateDbOptions & { schema?: S },
): Promise<ForgeDb<S>> {
  // Bring-your-own-schema: activate the consumer's model map (if given) before
  // anything reads the schema. Defaults to the bundled sample otherwise.
  if (opts.schema) setActiveSchema(opts.schema);
  const { adapter, url } = await pickAndConnect(opts);
  return makeDb(adapter, url, { strict: opts.strict === true }) as unknown as ForgeDb<S>;
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

function makeDb(adapter: Adapter, _url: string, runtime: { strict: boolean } = { strict: false }): ForgeDb<any> {
  const cache: Partial<Record<keyof SchemaMap, CollectionWrapper<any>>> = {};

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
      if (key === '$on') return (event: any, cb: any) => adapter.emitter.on(event, cb);
      if (key === '$off') return (event: any, cb: any) => adapter.emitter.off(event, cb);
      const model = (schema as any)[key] as ModelDef<any> | undefined;
      if (!model) return undefined;
      if (!cache[key as keyof SchemaMap]) {
        // Wrapper takes the active adapter so every execute / coerce / decode /
        // cascade call dispatches through the right dialect — otherwise every
        // wrapper would silently fall back to the Mongo singleton.
        cache[key as keyof SchemaMap] = new CollectionWrapper(model, undefined, adapter, runtime.strict);
      }
      return cache[key as keyof SchemaMap];
    },
  });

  // Dispatches through the adapter — works for both Mongo (replica-set
  // ClientSession) and Postgres (pg PoolClient).
  function $transaction(arg: any): any {
    if (Array.isArray(arg)) return Promise.all(arg);
    return adapter.$transaction(async (session) => arg(makeTx(session)));
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
        const model = (schema as any)[key] as ModelDef<any> | undefined;
        if (!model) return undefined;
        if (!txCache[key]) {
          // Tx wrapper: same adapter, plus the opaque session from
          // adapter.$transaction (ClientSession / PoolClient / ...).
          txCache[key] = new CollectionWrapper(model, session, adapter, runtime.strict);
        }
        return txCache[key];
      },
    });
  }

  return root as ForgeDb<any>;
}
