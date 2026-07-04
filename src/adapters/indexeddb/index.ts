// Public barrel for the IndexedDB adapter.
//
// The wasm/browser bundle path re-exports the pieces consumers actually
// touch: the Adapter class + factory, the driver interface + wrapper, the
// runtime migrator + drift-apply hook. Everything else stays internal to
// this folder to keep the surface small.

export { IndexeddbAdapter, createIndexeddbAdapter, getDefaultIndexeddbAdapter } from './adapter';
export { indexedDbDriver, isIdbDriver } from './driver';
export type { IdbDriver, IdbDriverOptions } from './driver';
export { runMigrate, applyDrift } from './migrate';
export type { RuntimeMigrateOptions, RuntimeApplyReport } from './migrate';
export { openDb, deleteDb } from './open';
export { introspect } from './introspect';
export { planSelect, primaryKeyField } from './planner';
export type { QueryPlan } from './planner';
export { tokenize } from './fts';
export { haversineMeters, pointInMultiPolygon } from './geo';
export { vectorDistance } from './vector';
export type { VectorMetric } from './vector';
