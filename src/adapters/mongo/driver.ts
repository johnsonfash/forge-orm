import type { AdapterKind } from '../types';

// MongoDriver — unlike the SQL dialects, MongoDB has one canonical client
// library (`mongodb`), so "pluggable" here means bringing your OWN pre-built
// MongoClient instead of letting forge construct one from a URL. This covers:
//   • custom client options (TLS, auth, compression, appName, pool tuning)
//   • a client shared across your app / framework
//   • MongoDB-API-compatible backends: Amazon DocumentDB, Azure Cosmos DB
//     (Mongo API), FerretDB — same driver, different endpoint/options
//   • a mock client in tests
//
//   import { MongoClient } from 'mongodb';
//   const client = new MongoClient(uri, { tls: true, appName: 'svc' });
//   const db = await createDb({ schema, driver: mongoDriver(client, 'mydb') });

export interface MongoDriver {
  readonly kind: Extract<AdapterKind, 'mongo'>;
  // A MongoClient (connected or not — forge calls .connect(), which is
  // idempotent). Typed as `any` so consumers aren't forced to import mongodb's
  // types here, and so DocumentDB/Cosmos client shims fit.
  client: any;
  // Optional database name; defaults to the one in the client's connection URI.
  dbName?: string;
}

export function mongoDriver(client: any, dbName?: string): MongoDriver {
  if (!client || typeof client.db !== 'function') {
    throw new Error('[forge] mongoDriver() expects a MongoClient (with a .db() method)');
  }
  return { kind: 'mongo', client, dbName };
}

export function isMongoDriver(v: unknown): v is MongoDriver {
  return !!v && typeof v === 'object' && (v as any).kind === 'mongo' &&
    typeof (v as any).client?.db === 'function';
}
