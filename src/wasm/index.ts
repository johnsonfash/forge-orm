// forge-orm/wasm — browser entrypoint.
//
// Re-exports just the browser-safe surface: the wasm driver, the runtime
// migrate helper, the doctor probe. Pair with the worker module at
// 'forge-orm/wasm/worker'.

export { wasmSqliteDriver, isWasmSqliteDriver } from '../adapters/sqlite/wasm-driver';
export type { WasmDriverOptions } from '../adapters/sqlite/wasm-driver';

export { runMigrate } from './migrate';
export type { RuntimeMigrateOptions } from './migrate';

export { browserDoctor } from './browser-doctor';
export type { BrowserDoctorReport } from './browser-doctor';

// Re-export the SqliteDriver type — useful for consumers building a thin
// abstraction on top.
export type { SqliteDriver } from '../adapters/sqlite/driver';
