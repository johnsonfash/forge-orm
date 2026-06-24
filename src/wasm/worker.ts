/// <reference lib="webworker" />

// forge-orm sqlite-wasm worker.
//
// Hosts the official @sqlite.org/sqlite-wasm engine inside a Web Worker so it
// can use OPFS synchronous handles (only legal in a worker context). Speaks
// the wire protocol expected by src/adapters/sqlite/wasm-driver.ts:
//
//   in:  { id, type: 'open'  | 'exec' | 'all' | 'get' | 'run' | 'close', sql?, params?, url? }
//   out: { id, ok: true,  rows?, row?, changes?, lastInsertRowid? }
//         | { id, ok: false, error, code? }
//
// Consumed by bundlers via:
//   new Worker(new URL('forge-orm/wasm/worker', import.meta.url), { type: 'module' })
//
// `@sqlite.org/sqlite-wasm` is a PEER DEPENDENCY of forge-orm — install it in
// the consuming app:  npm install @sqlite.org/sqlite-wasm

import sqlite3InitModule from '@sqlite.org/sqlite-wasm';

declare const self: DedicatedWorkerGlobalScope;

interface InMessage {
  id: number;
  type: 'open' | 'exec' | 'all' | 'get' | 'run' | 'close';
  sql?: string;
  params?: unknown[];
  url?: string;
}

type Sqlite3 = Awaited<ReturnType<typeof sqlite3InitModule>>;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let db: any | null = null;
let sqlite3: Sqlite3 | null = null;

async function open(url: string): Promise<void> {
  if (db) return;
  // The published @sqlite.org/sqlite-wasm typings declare `init(): Promise<…>`
  // with no parameters, but the runtime accepts the Emscripten init opts
  // (print/printErr/locateFile/etc.). Cast to keep the diagnostic surface honest
  // — these hooks improve debuggability without changing the contract.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sqlite3 = await (sqlite3InitModule as any)({
    print: (...a: unknown[]) => console.log('[sqlite-wasm]', ...a),
    printErr: (...a: unknown[]) => console.error('[sqlite-wasm]', ...a),
  });

  // URL → VFS routing.
  //   :memory:                 → ':memory:' VFS
  //   opfs:<path>              → 'opfs' VFS  (single-tab writer)
  //   opfs-sahpool:<path>      → 'opfs-sahpool' VFS (multi-tab safe)
  //   <bare>                   → fall back to ':memory:'
  const trimmed = url.trim();
  if (trimmed === ':memory:' || trimmed === '') {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    db = new (sqlite3 as any).oo1.DB(':memory:', 'ct');
    afterOpen();
    return;
  }

  if (/^opfs-sahpool:/i.test(trimmed)) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const installer = (sqlite3 as any).installOpfsSAHPoolVfs;
    if (typeof installer !== 'function') {
      throw new Error('[forge:wasm] opfs-sahpool VFS unavailable in this build');
    }
    const util = await installer({ name: 'forge-pool', initialCapacity: 6 });
    const path = stripPrefix(trimmed, 'opfs-sahpool:');
    db = new util.OpfsSAHPoolDb(path || '/forge.sqlite');
    afterOpen();
    return;
  }

  if (/^opfs:/i.test(trimmed)) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const OpfsDb = (sqlite3 as any).oo1?.OpfsDb;
    if (typeof OpfsDb !== 'function') {
      throw new Error('[forge:wasm] OPFS VFS unavailable — browser needs OPFS sync handles');
    }
    const path = stripPrefix(trimmed, 'opfs:');
    db = new OpfsDb(path || '/forge.sqlite', 'ct');
    afterOpen();
    return;
  }

  // Unknown scheme — treat as a bare path on the default VFS.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db = new (sqlite3 as any).oo1.DB(trimmed, 'ct');
  afterOpen();
}

function afterOpen(): void {
  // Pragmas mirroring SqliteAdapter.connect(). foreign_keys is per-connection.
  db.exec('PRAGMA foreign_keys = ON');
  // Best-effort load of sqlite-vec — the wasm pro build exposes vec_version();
  // the stock build does not. Silently skip so stock builds still work.
  try { db.exec('SELECT vec_version()'); } catch { /* not loaded */ }
}

function stripPrefix(s: string, prefix: string): string {
  return s.toLowerCase().startsWith(prefix.toLowerCase()) ? s.slice(prefix.length) : s;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function rowsFromExec(sql: string, params: unknown[] | undefined, columnNames = true): any[] {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const out: any[] = [];
  db.exec({
    sql,
    bind: params ?? [],
    rowMode: columnNames ? 'object' : 'array',
    resultRows: out,
  });
  return out;
}

function runStmt(sql: string, params: unknown[] | undefined): { changes: number; lastInsertRowid?: number } {
  // sqlite-wasm stmt API: prepare → bind → step → finalize.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const stmt = db.prepare(sql);
  try {
    if (params?.length) stmt.bind(params as unknown[]);
    // Some statements (INSERT … RETURNING) return rows; we drain them but
    // don't surface them — `run` reports counts only. Use 'all' for RETURNING.
    while (stmt.step()) { /* drain */ }
  } finally {
    stmt.finalize();
  }
  return {
    changes: db.changes(),
    lastInsertRowid: Number(db.lastInsertRowid?.() ?? 0) || undefined,
  };
}

async function dispatch(msg: InMessage): Promise<Record<string, unknown>> {
  switch (msg.type) {
    case 'open':
      await open(msg.url ?? ':memory:');
      return { ok: true };
    case 'exec':
      if (!db) throw new Error('[forge:wasm] exec before open');
      db.exec(msg.sql!);
      return { ok: true };
    case 'all': {
      if (!db) throw new Error('[forge:wasm] all before open');
      const rows = rowsFromExec(msg.sql!, msg.params);
      return { ok: true, rows };
    }
    case 'get': {
      if (!db) throw new Error('[forge:wasm] get before open');
      const rows = rowsFromExec(msg.sql!, msg.params);
      return { ok: true, row: rows[0] };
    }
    case 'run': {
      if (!db) throw new Error('[forge:wasm] run before open');
      const r = runStmt(msg.sql!, msg.params);
      return {
        ok: true,
        changes: r.changes,
        ...(r.lastInsertRowid != null ? { lastInsertRowid: r.lastInsertRowid } : {}),
      };
    }
    case 'close': {
      try { db?.close?.(); } catch { /* ignore */ }
      db = null;
      sqlite3 = null;
      return { ok: true };
    }
    default:
      throw new Error(`[forge:wasm] unknown message type: ${String((msg as InMessage).type)}`);
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
      id: msg.id,
      ok: false,
      error: e?.message ?? String(err),
      ...(e?.code ? { code: e.code } : {}),
    });
  }
});

// Help bundlers tree-shake the unused symbol.
void sqlite3InitModule;
