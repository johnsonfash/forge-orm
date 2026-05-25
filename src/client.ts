// Wave 0 dispatcher — re-exports the Mongo adapter's dbClient so that existing
// `import { dbClient } from '../client'` call sites keep working unmodified.
// In Wave 1 this becomes a proper adapter-agnostic facade backed by the
// Adapter interface and the IR-execution layer.

export { dbClient } from './adapters/mongo/client';
