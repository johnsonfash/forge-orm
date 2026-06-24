// forge-orm/wasm — browser entrypoint.
//
// Re-exports just the browser-safe surface: the wasm driver, the runtime
// migrate helper, the doctor probe. Pair with the worker module at
// 'forge-orm/wasm/worker'.

export { wasmSqliteDriver, isWasmSqliteDriver } from '../adapters/sqlite/wasm-driver';
export type { WasmDriverOptions } from '../adapters/sqlite/wasm-driver';

export { runMigrate } from './migrate';
export type { RuntimeMigrateOptions, RuntimeApplyReport } from './migrate';

// Drift-apply — exposed for callers who want to run the drift pass on its own
// (e.g. after a manual $executeRaw schema patch, or against a pre-migrated DB).
export { applyDrift } from './drift-apply';
export type { DriftApplyReport } from './drift-apply';

export { browserDoctor } from './browser-doctor';
export type { BrowserDoctorReport } from './browser-doctor';

// Re-export the SqliteDriver type — useful for consumers building a thin
// abstraction on top.
export type { SqliteDriver } from '../adapters/sqlite/driver';
