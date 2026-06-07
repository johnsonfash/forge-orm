// Re-export of the Mongo adapter's dbClient. Existing call sites do
// `import { dbClient } from '../client'`; this keeps that path stable.
export { dbClient } from './adapters/mongo/client';
