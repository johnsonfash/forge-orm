import type { ClientSession, Db, MongoClient } from 'mongodb';
import { mongo } from './bson';

export class DatabaseClient {
  // Lazily created at first `connect()`. Reading `process.env.DATABASE_URL`
  // and instantiating MongoClient is deferred to runtime — Nest's
  // ConfigModule loads `.env` *after* module-import side-effects, so an
  // eager constructor would throw "DATABASE_URL is not set" before the
  // env var has been populated.
  private _client?: MongoClient;
  private _db?: Db;
  private _connecting?: Promise<void>;
  // Did WE open this connection, or was it handed to us by the caller?
  private _adopted = false;

  // Throws a clear error if anything tries to use the client/db before
  // connect() resolves (instead of an opaque "Cannot read properties of
  // undefined").
  get client(): MongoClient {
    if (!this._client) {
      throw new Error('[Database] client accessed before connect() resolved');
    }
    return this._client;
  }

  get db(): Db {
    if (!this._db) {
      throw new Error('[Database] db accessed before connect() resolved');
    }
    return this._db;
  }

  // Adopt a caller-supplied MongoClient (createDb({ driver: mongoDriver(...) }))
  // instead of building one from DATABASE_URL. connect() is idempotent on the
  // mongodb driver, so it's safe whether or not the client is already connected.
  async adopt(client: any, dbName?: string): Promise<void> {
    if (this._db) return;
    this._client = client;
    this._adopted = true;
    this._connecting = (async () => {
      await client.connect();
      this._db = dbName ? client.db(dbName) : client.db();
      // eslint-disable-next-line no-console
      console.log(`[Database] connected to ${this._db!.databaseName} (injected client)`);
    })();
    return this._connecting;
  }

  /**
   * `url` is passed by the adapter that owns this client. It falls back to
   * `process.env.DATABASE_URL` for the CLI scripts, which connect without an
   * adapter.
   *
   * Taking it as an argument is part of the per-instance fix: reading the env
   * var meant two `createDb()` calls with different URLs both resolved to
   * whichever one had been written to the environment first.
   */
  async connect(url?: string): Promise<void> {
    if (this._db) return;
    if (this._connecting) return this._connecting;

    const uri = url ?? process.env.DATABASE_URL;
    if (!uri) {
      throw new Error(
        '[Database] DATABASE_URL is not set — make sure ConfigModule has loaded .env before connect()',
      );
    }

    this._client = new (mongo().MongoClient)(uri, {
      maxPoolSize: 50,
      minPoolSize: 5,
      connectTimeoutMS: 10_000,
      serverSelectionTimeoutMS: 10_000,
      retryWrites: true,
      retryReads: true,
    });

    this._connecting = (async () => {
      await this._client!.connect();
      this._db = this._client!.db();
      if (this._db.databaseName === 'test' && !uri.includes('/test')) {
        // eslint-disable-next-line no-console
        console.warn('[Database] connected to default "test" db — check DATABASE_URL');
      }
      // eslint-disable-next-line no-console
      console.log(`[Database] connected to ${this._db.databaseName}`);
    })();
    return this._connecting;
  }

  async transaction<T>(fn: (session: ClientSession) => Promise<T>): Promise<T> {
    const session = this.client.startSession();
    try {
      let result!: T;
      await session.withTransaction(async () => {
        result = await fn(session);
      });
      return result;
    } finally {
      await session.endSession();
    }
  }

  /**
   * Release this handle. A connection we OPENED is closed; one that was
   * handed to us is only let go of.
   *
   * Closing an adopted client is the caller's to do, and doing it here breaks
   * the database-per-tenant shape outright: an LRU of `createDb({ driver:
   * mongoDriver(sharedClient) })` handles with `dispose: (db) =>
   * db.$disconnect()` would close the shared MongoClient the first time any
   * tenant fell out of the cache, taking every other tenant down with it.
   */
  async close(): Promise<void> {
    if (!this._client) return;
    if (!this._adopted) await this._client.close();
    this._client = undefined;
    this._db = undefined;
    this._connecting = undefined;
    this._adopted = false;
  }
}

/*
 * One client PER `createDb()`, not one per process.
 *
 * `dbClient` used to be the only client there was — a module-level singleton
 * every Mongo code path reached for directly. `connect()` early-returns when
 * `_db` is already set, so a second `createDb({ url: B })` silently kept
 * writing to A, and `$disconnect()` on either one closed the connection under
 * both. In a process that talks to two databases — a migration tool, a test
 * harness, anything multi-tenant with a database per tenant — that is a data
 * crossover with no error and no log line.
 *
 * Each `MongoAdapter` now owns its own `DatabaseClient`. This module-level
 * `dbClient` is kept because it is part of the public API (consumers use it
 * for raw collection access), and it FORWARDS to the first client created, so
 * a single-database app is unaffected. A second one gets its own and does not
 * disturb this default.
 */
let _default: DatabaseClient | undefined;

/** Adopt `c` as the process default, if there isn't one yet. */
export function setDefaultClient(c: DatabaseClient): void {
  _default ??= c;
}

export function hasDefaultClient(): boolean {
  return _default !== undefined;
}

/**
 * The default client, created on demand. The on-demand part matters for the
 * CLI scripts, which use `dbClient` without going through `createDb()`.
 */
export function getDefaultClient(): DatabaseClient {
  return (_default ??= new DatabaseClient());
}

/** Forget the default. Used by `close()` so a later connect starts clean. */
export function clearDefaultClient(c: DatabaseClient): void {
  if (_default === c) _default = undefined;
}

export const dbClient: DatabaseClient = new Proxy({} as DatabaseClient, {
  get(_t, prop) {
    const target = getDefaultClient() as unknown as Record<string | symbol, unknown>;
    const v = target[prop];
    // `db` and `client` are getters, so they have already thrown-or-resolved
    // by here; methods need binding back to the real instance.
    return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
  },
  set(_t, prop, value) {
    (getDefaultClient() as unknown as Record<string | symbol, unknown>)[prop] = value;
    return true;
  },
  has(_t, prop) {
    return prop in (getDefaultClient() as unknown as object);
  },
});
