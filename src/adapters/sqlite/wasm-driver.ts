import type { SqliteDriver } from './driver';

// wasmSqliteDriver — runs sqlite-wasm (the official @sqlite.org/sqlite-wasm
// build) inside a Web Worker and exposes the SqliteDriver port. All I/O is
// async over postMessage; the worker owns the OPFS handle. Compatible with
// every adapter call path (executor, migrator, $transaction, $queryRaw) — the
// SQLite IR compiler and DDL emitter are reused unchanged.
//
// Lifecycle:
//   1. Caller passes a Worker (or a thenable that resolves to one) plus the
//      OPFS URL the worker should open.
//   2. First call sends `{ type: 'open', url }`; subsequent calls send
//      `{ type: 'exec' | 'all' | 'get' | 'run', sql, params }` and await the
//      matching `{ id }` reply.
//   3. close() sends `{ type: 'close' }` and terminates the worker.
//
// The worker side (src/wasm/worker.ts) ships in this package; bundlers
// resolve it via `new Worker(new URL('forge-orm/wasm/worker', import.meta.url))`.
//
// Concurrency model: one in-flight request at a time. SQLite is single-writer
// at the file level and OPFS sync handles are exclusive per origin, so the
// driver serialises requests through a tiny promise queue. Multi-tab safety
// is delegated to the worker's VFS choice (opfs-sahpool is the default).

export interface WasmDriverOptions {
  // The Worker to drive. Either a constructed Worker, or a thenable resolving
  // to one (lets bundlers code-split the worker chunk).
  worker: Worker | Promise<Worker>;
  // The DB URL the worker should open. Defaults to 'opfs-sahpool:///forge.sqlite'.
  //   opfs:<path>          OPFS VFS (single-tab writer, simple)
  //   opfs-sahpool:<path>  OPFS SAH-pool VFS (multi-tab safe, recommended)
  //   :memory:             Ephemeral in-memory DB
  url?: string;
  // Open timeout (ms). Defaults to 30_000.
  openTimeoutMs?: number;
  // Per-request timeout (ms). Defaults to 60_000. Use 0 to disable.
  requestTimeoutMs?: number;
}

type Pending = {
  id: number;
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
};

interface WorkerOkMessage {
  id: number;
  ok: true;
  rows?: unknown[];
  row?: unknown;
  changes?: number;
  lastInsertRowid?: number;
}
interface WorkerErrMessage {
  id: number;
  ok: false;
  error: string;
  code?: string;
}
type WorkerMessage = WorkerOkMessage | WorkerErrMessage;

const DEFAULT_URL = 'opfs-sahpool:///forge.sqlite';

export function wasmSqliteDriver(opts: WasmDriverOptions): SqliteDriver {
  const url = opts.url ?? DEFAULT_URL;
  const openTimeoutMs = opts.openTimeoutMs ?? 30_000;
  const requestTimeoutMs = opts.requestTimeoutMs ?? 60_000;

  let workerPromise: Promise<Worker> | null = Promise.resolve(opts.worker);
  let nextId = 1;
  let opened: Promise<void> | null = null;
  const pending = new Map<number, Pending>();

  // Serialise calls — sqlite is single-writer and the worker handles one
  // request at a time, so queueing avoids head-of-line corruption.
  let chain: Promise<unknown> = Promise.resolve();

  async function getWorker(): Promise<Worker> {
    if (!workerPromise) throw new Error('[forge:wasm] driver closed');
    return workerPromise;
  }

  function attach(worker: Worker): void {
    worker.addEventListener('message', (ev: MessageEvent<WorkerMessage>) => {
      const msg = ev.data;
      if (!msg || typeof (msg as WorkerMessage).id !== 'number') return;
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      if (p.timer) clearTimeout(p.timer);
      if (msg.ok) p.resolve(msg);
      else p.reject(buildError(msg));
    });
    worker.addEventListener('error', (ev) => {
      const err = new Error(
        `[forge:wasm] worker error: ${(ev as ErrorEvent).message ?? 'unknown'}`,
      );
      for (const p of pending.values()) {
        if (p.timer) clearTimeout(p.timer);
        p.reject(err);
      }
      pending.clear();
    });
  }

  function buildError(msg: WorkerErrMessage): Error {
    const e = new Error(msg.error || '[forge:wasm] worker reported error');
    if (msg.code) (e as Error & { code?: string }).code = msg.code;
    return e;
  }

  async function send<T = WorkerOkMessage>(
    body: Record<string, unknown>,
    timeoutMs = requestTimeoutMs,
  ): Promise<T> {
    const worker = await getWorker();
    const id = nextId++;
    return new Promise<T>((resolve, reject) => {
      const p: Pending = {
        id,
        resolve: (v) => resolve(v as T),
        reject,
      };
      if (timeoutMs > 0) {
        p.timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`[forge:wasm] request timed out after ${timeoutMs}ms (${String(body.type)})`));
        }, timeoutMs);
      }
      pending.set(id, p);
      worker.postMessage({ id, ...body });
    });
  }

  async function ensureOpen(): Promise<void> {
    if (opened) return opened;
    opened = (async () => {
      const worker = await getWorker();
      attach(worker);
      await send({ type: 'open', url }, openTimeoutMs);
    })();
    return opened;
  }

  // Queue the call. Always returns a promise resolving with the worker reply
  // (or rejecting with the worker error). Guarantees serial execution.
  function enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = chain.then(() => fn(), () => fn());
    chain = run.catch(() => undefined);
    return run as Promise<T>;
  }

  return {
    kind: 'sqlite',

    all: (sql, params) => enqueue(async () => {
      await ensureOpen();
      const reply = await send<WorkerOkMessage>({ type: 'all', sql, params });
      return (reply.rows ?? []) as unknown[];
    }),

    get: (sql, params) => enqueue(async () => {
      await ensureOpen();
      const reply = await send<WorkerOkMessage>({ type: 'get', sql, params });
      return reply.row;
    }),

    run: (sql, params) => enqueue(async () => {
      await ensureOpen();
      const reply = await send<WorkerOkMessage>({ type: 'run', sql, params });
      return {
        changes: reply.changes ?? 0,
        ...(reply.lastInsertRowid != null ? { lastInsertRowid: reply.lastInsertRowid } : {}),
      };
    }),

    exec: (sql) => enqueue(async () => {
      await ensureOpen();
      await send({ type: 'exec', sql });
    }),

    close: async () => {
      try { await send({ type: 'close' }, 5_000); } catch { /* ignore */ }
      const w = workerPromise ? await workerPromise.catch(() => null) : null;
      workerPromise = null;
      opened = null;
      if (w) w.terminate();
      for (const p of pending.values()) {
        if (p.timer) clearTimeout(p.timer);
        p.reject(new Error('[forge:wasm] driver closed'));
      }
      pending.clear();
    },
  };
}

// Type-guard for the wasm driver kind. Identical to isSqliteDriver — the wasm
// driver IS a SqliteDriver and shares the same `kind: 'sqlite'` tag.
export function isWasmSqliteDriver(v: unknown): v is SqliteDriver {
  return !!v && typeof v === 'object' && (v as { kind?: string }).kind === 'sqlite';
}
