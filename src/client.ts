// Re-export of the Mongo adapter's client surface. Existing call sites do
// `import { dbClient } from '../client'`; this keeps that path stable.
//
// `dbClient` forwards to the FIRST client created, which is what a
// single-database app has. Each createDb() owns its own — see the note in
// adapters/mongo/client.ts for why that changed.
export { dbClient, DatabaseClient, getDefaultClient } from './adapters/mongo/client';
