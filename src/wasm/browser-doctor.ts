import type { SqliteDriver } from '../adapters/sqlite/driver';

// browserDoctor — runtime capability probe for the wasm adapter.
//
// Mirrors the structure of `forge doctor`'s per-dialect probe but adapts it to
// the browser: feature-detects environment APIs synchronously, then probes
// SQLite extensions by trying small queries through the driver. The report is
// structured (not stdout) so apps can render it however they like.
//
//   import { wasmSqliteDriver, browserDoctor } from 'forge-orm/wasm';
//   const driver = wasmSqliteDriver({ worker });
//   const report = await browserDoctor(driver);
//   console.table(report.capabilities);

export interface BrowserDoctorReport {
  // Environment — synchronous, no DB calls.
  environment: {
    runtime: 'browser' | 'worker' | 'node' | 'unknown';
    opfs: boolean;
    opfsSyncHandles: boolean;
    sharedArrayBuffer: boolean;
    persistent: 'granted' | 'requestable' | 'unavailable';
    estimatedQuotaMB?: number;
    estimatedUsageMB?: number;
    userAgent?: string;
  };
  // SQLite engine — needs an open driver.
  sqlite: {
    version?: string;
    json1: boolean;
    fts5: boolean;
    rtree: boolean;
    sqliteVec: boolean;
    foreignKeys: boolean;
  };
  capabilities: Record<string, 'native' | 'fallback' | 'unavailable'>;
  notes: string[];
}

async function detectEnvironment(): Promise<BrowserDoctorReport['environment']> {
  const runtime: BrowserDoctorReport['environment']['runtime'] =
    typeof (globalThis as { Window?: unknown }).Window !== 'undefined' && typeof document !== 'undefined' ? 'browser' :
    typeof (globalThis as { WorkerGlobalScope?: unknown }).WorkerGlobalScope !== 'undefined' ? 'worker' :
    typeof (globalThis as { process?: { versions?: { node?: string } } }).process?.versions?.node === 'string' ? 'node' :
    'unknown';

  const nav = (globalThis as { navigator?: Navigator }).navigator;
  const storage = nav?.storage as
    | (StorageManager & { getDirectory?: () => Promise<FileSystemDirectoryHandle>; persisted?: () => Promise<boolean> })
    | undefined;
  const opfs = !!storage?.getDirectory;
  // Sync handles are only available inside a Worker. Probe via WorkerGlobalScope.
  const opfsSyncHandles = opfs && runtime === 'worker';
  const sharedArrayBuffer = typeof (globalThis as { SharedArrayBuffer?: unknown }).SharedArrayBuffer !== 'undefined';

  let persistent: BrowserDoctorReport['environment']['persistent'] = 'unavailable';
  if (storage?.persisted) {
    try {
      const isPersisted = await storage.persisted();
      persistent = isPersisted ? 'granted' : 'requestable';
    } catch { /* keep unavailable */ }
  }

  let estimatedQuotaMB: number | undefined;
  let estimatedUsageMB: number | undefined;
  if (storage?.estimate) {
    try {
      const est = await storage.estimate();
      if (est.quota) estimatedQuotaMB = Math.round(est.quota / 1_048_576);
      if (est.usage) estimatedUsageMB = Math.round(est.usage / 1_048_576);
    } catch { /* ignore */ }
  }

  return {
    runtime,
    opfs,
    opfsSyncHandles,
    sharedArrayBuffer,
    persistent,
    ...(estimatedQuotaMB != null ? { estimatedQuotaMB } : {}),
    ...(estimatedUsageMB != null ? { estimatedUsageMB } : {}),
    ...(nav?.userAgent ? { userAgent: nav.userAgent } : {}),
  };
}

async function probe<T>(fn: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: string }> {
  try {
    const value = await fn();
    return { ok: true, value };
  } catch (err) {
    return { ok: false, error: (err as Error)?.message ?? String(err) };
  }
}

export async function browserDoctor(driver: SqliteDriver): Promise<BrowserDoctorReport> {
  const environment = await detectEnvironment();
  const notes: string[] = [];

  const version = await probe(() => driver.get('SELECT sqlite_version() AS v', []));
  const versionString = version.ok ? (version.value as { v?: string } | undefined)?.v : undefined;

  const json1 = await probe(() => driver.get("SELECT json('{}') AS j", []));
  const fts5 = await probe(async () => {
    await driver.exec('CREATE VIRTUAL TABLE IF NOT EXISTS __forge_doctor_fts USING fts5(x)');
    await driver.exec('DROP TABLE IF EXISTS __forge_doctor_fts');
  });
  const rtree = await probe(async () => {
    await driver.exec('CREATE VIRTUAL TABLE IF NOT EXISTS __forge_doctor_rt USING rtree(id, minX, maxX, minY, maxY)');
    await driver.exec('DROP TABLE IF EXISTS __forge_doctor_rt');
  });
  const sqliteVec = await probe(() => driver.get('SELECT vec_version() AS v', []));
  const foreignKeys = await probe(async () => {
    const r = await driver.get('PRAGMA foreign_keys', []) as { foreign_keys?: number } | undefined;
    return r?.foreign_keys === 1;
  });

  const sqlite: BrowserDoctorReport['sqlite'] = {
    ...(versionString ? { version: versionString } : {}),
    json1: json1.ok,
    fts5: fts5.ok,
    rtree: rtree.ok,
    sqliteVec: sqliteVec.ok,
    foreignKeys: foreignKeys.ok && foreignKeys.value === true,
  };

  // Feature → forge capability mapping.
  const capabilities: BrowserDoctorReport['capabilities'] = {
    softDelete: 'native',
    unique: 'native',
    partialFilterIndex: 'native',
    relationsAndJoins: 'native',
    aggregations: 'native',
    transactions: 'native',
    'json(path)': sqlite.json1 ? 'native' : 'unavailable',
    'text.searchable() / FTS5': sqlite.fts5 ? 'native' : 'fallback',
    'geoPoint near / withinPolygon': sqlite.rtree ? 'native' : 'fallback',
    'vector near / nearTo': sqlite.sqliteVec ? 'native' : 'fallback',
    'persistent OPFS storage': environment.opfs ? 'native' : 'unavailable',
    'multi-tab safe': 'native', // wasm driver runs through SAH pool by default
  };

  if (!environment.opfs) {
    notes.push(
      'OPFS unavailable — falling back to :memory: storage. ' +
      'Data is lost on tab close. Upgrade to a modern browser (Chrome 109+, ' +
      'Edge 109+, Safari 16.4+, Firefox 111+).',
    );
  }
  if (environment.persistent === 'requestable') {
    notes.push(
      'Storage is evictable. Call await navigator.storage.persist() at app boot ' +
      'to flip into persistent mode (especially important on iOS Safari to avoid ' +
      'the 7-day Intelligent-Tracking-Prevention eviction).',
    );
  }
  if (!sqlite.fts5) {
    notes.push(
      'FTS5 not compiled into this sqlite-wasm build. f.text().searchable() ' +
      'falls back to a LIKE-based prefilter — slower on large tables.',
    );
  }
  if (!sqlite.rtree) {
    notes.push(
      'R-Tree extension not compiled in. f.geoPoint() falls back to bbox + ' +
      'Haversine post-filter in JS. Acceptable to ~50k rows; rebuild with ' +
      'the rtree extension for native spatial index. See forge-orm/wasm-pro.',
    );
  }
  if (!sqlite.sqliteVec) {
    notes.push(
      'sqlite-vec not loaded. f.vector() falls back to brute-force cosine ' +
      'distance in JS. Build forge-orm/wasm-pro to bundle sqlite-vec for ' +
      'HNSW-grade vector search.',
    );
  }

  return { environment, sqlite, capabilities, notes };
}
