/// <reference lib="webworker" />

// forge-orm sqlite-wasm-pro worker.
//
// Identical to ./worker.ts EXCEPT it loads a custom-built sqlite-wasm artifact
// (compiled by scripts/wasm-pro/build.sh) that includes the rtree extension
// AND sqlite-vec. Use this when f.geoPoint() and f.vector() need native
// index-driven query paths rather than fallback mode.
//
// Setup:
//   1. Build:   bash node_modules/forge-orm/scripts/wasm-pro/build.sh
//   2. Copy:    cp dist/wasm-pro/sqlite3.{mjs,wasm} <your-app>/public/wasm-pro/
//   3. Bundle:  reference this worker file from your bundler entry:
//                 new Worker(new URL('forge-orm/wasm/worker-pro', import.meta.url))
//      then set FORGE_WASM_PRO_URL on the worker before posting messages — or
//      just edit `WASM_PRO_URL` below if you keep a vendored copy in your repo.

// Worker globals are picked up from /// <reference lib="webworker" /> above.
const WASM_PRO_URL = (self as unknown as { FORGE_WASM_PRO_URL?: string }).FORGE_WASM_PRO_URL
  ?? '/wasm-pro/sqlite3.mjs';

interface InMessage {
  id: number;
  type: 'open' | 'exec' | 'all' | 'get' | 'run' | 'close';
  sql?: string;
  params?: unknown[];
  url?: string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let db: any | null = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let sqlite3: any | null = null;

async function loadCustomWasm(): Promise<void> {
  if (sqlite3) return;
  const mod = await import(/* webpackIgnore: true */ WASM_PRO_URL);
  const init = mod.default ?? mod.sqlite3InitModule;
  if (typeof init !== 'function') {
    throw new Error(`[forge:wasm-pro] no sqlite3InitModule at ${WASM_PRO_URL}`);
  }
  sqlite3 = await init({
    print: (...a: unknown[]) => console.log('[sqlite-wasm-pro]', ...a),
    printErr: (...a: unknown[]) => console.error('[sqlite-wasm-pro]', ...a),
  });
}

async function open(url: string): Promise<void> {
  if (db) return;
  await loadCustomWasm();
  const trimmed = url.trim();
  if (trimmed === ':memory:' || trimmed === '') {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    db = new (sqlite3 as any).oo1.DB(':memory:', 'ct');
  } else if (/^opfs-sahpool:/i.test(trimmed)) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const installer = (sqlite3 as any).installOpfsSAHPoolVfs;
    if (typeof installer !== 'function') {
      throw new Error('[forge:wasm-pro] opfs-sahpool VFS unavailable in this build');
    }
    const util = await installer({ name: 'forge-pool', initialCapacity: 6 });
    const path = trimmed.replace(/^opfs-sahpool:/i, '');
    db = new util.OpfsSAHPoolDb(path || '/forge.sqlite');
  } else if (/^opfs:/i.test(trimmed)) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const OpfsDb = (sqlite3 as any).oo1?.OpfsDb;
    if (typeof OpfsDb !== 'function') {
      throw new Error('[forge:wasm-pro] OPFS VFS unavailable');
    }
    const path = trimmed.replace(/^opfs:/i, '');
    db = new OpfsDb(path || '/forge.sqlite', 'ct');
  } else {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    db = new (sqlite3 as any).oo1.DB(trimmed, 'ct');
  }
  db.exec('PRAGMA foreign_keys = ON');
  // sqlite-vec auto-registers when compiled in. Confirm by calling the version.
  try { db.exec('SELECT vec_version()'); } catch { /* should not happen in pro build */ }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function rowsFromExec(sql: string, params: unknown[] | undefined): any[] {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const out: any[] = [];
  db.exec({ sql, bind: params ?? [], rowMode: 'object', resultRows: out });
  return out;
}

function runStmt(sql: string, params: unknown[] | undefined): { changes: number; lastInsertRowid?: number } {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const stmt = db.prepare(sql);
  try {
    if (params?.length) stmt.bind(params as unknown[]);
    while (stmt.step()) { /* drain */ }
  } finally { stmt.finalize(); }
  return {
    changes: db.changes(),
    lastInsertRowid: Number(db.lastInsertRowid?.() ?? 0) || undefined,
  };
}

async function dispatch(msg: InMessage): Promise<Record<string, unknown>> {
  switch (msg.type) {
    case 'open':  await open(msg.url ?? ':memory:'); return { ok: true };
    case 'exec':  db.exec(msg.sql!); return { ok: true };
    case 'all':   return { ok: true, rows: rowsFromExec(msg.sql!, msg.params) };
    case 'get':   return { ok: true, row: rowsFromExec(msg.sql!, msg.params)[0] };
    case 'run': {
      const r = runStmt(msg.sql!, msg.params);
      return {
        ok: true,
        changes: r.changes,
        ...(r.lastInsertRowid != null ? { lastInsertRowid: r.lastInsertRowid } : {}),
      };
    }
    case 'close': try { db?.close?.(); } catch { /* ignore */ } db = null; sqlite3 = null; return { ok: true };
    default: throw new Error(`[forge:wasm-pro] unknown message type: ${String((msg as InMessage).type)}`);
  }
}

self.addEventListener('message', async (ev: MessageEvent<InMessage>) => {
  const msg = ev.data;
  if (!msg || typeof msg.id !== 'number') return;
  try {
    const reply = await dispatch(msg);
    self.postMessage({ id: msg.id, ...reply });
  } catch (err) {
    const e = err as Error & { code?: string };
    self.postMessage({
      id: msg.id, ok: false,
      error: e?.message ?? String(err),
      ...(e?.code ? { code: e.code } : {}),
    });
  }
});
