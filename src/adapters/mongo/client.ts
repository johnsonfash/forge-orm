import type { ClientSession, Db, MongoClient } from 'mongodb';
import { mongo } from './bson';

class DatabaseClient {
  // Lazily created at first `connect()`. Reading `process.env.DATABASE_URL`
  // and instantiating MongoClient is deferred to runtime — Nest's
  // ConfigModule loads `.env` *after* module-import side-effects, so an
  // eager constructor would throw "DATABASE_URL is not set" before the
  // env var has been populated.
  private _client?: MongoClient;
  private _db?: Db;
  private _connecting?: Promise<void>;

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
    this._connecting = (async () => {
      await client.connect();
      this._db = dbName ? client.db(dbName) : client.db();
      // eslint-disable-next-line no-console
      console.log(`[Database] connected to ${this._db!.databaseName} (injected client)`);
    })();
    return this._connecting;
  }

  async connect(): Promise<void> {
    if (this._db) return;
    if (this._connecting) return this._connecting;

    const uri = process.env.DATABASE_URL;
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

  async close(): Promise<void> {
    if (!this._client) return;
    await this._client.close();
    this._client = undefined;
    this._db = undefined;
    this._connecting = undefined;
  }
}

export const dbClient = new DatabaseClient();
