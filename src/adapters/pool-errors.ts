// A database pool is an EventEmitter, and an EventEmitter with no 'error'
// listener turns an emitted error into an uncaught exception: an idle
// connection dying (a server restart, a dropped socket) exits the process.
// Every pool here already drops the broken connection and opens a new one on
// the next query, so the error only needs reporting.

type Emitter = {
  on?: (event: string, fn: (...a: any[]) => void) => unknown;
  listenerCount?: (event: string) => number;
};

function warn(what: string, err: unknown): void {
  const msg = `forge-orm: idle ${what} connection lost (${(err as Error)?.message ?? String(err)}); the pool will reconnect`;
  const proc = (globalThis as { process?: { emitWarning?: (m: string) => void } }).process;
  if (proc?.emitWarning) proc.emitWarning(msg);
  else console.warn(msg);
}

/**
 * Attach a warning listener for 'error' unless the owner already has one.
 * A pool the application built and listens to is left alone: its handler
 * is the one that should decide.
 */
export function guardPoolErrors(emitter: unknown, what: string): void {
  const e = emitter as Emitter | null | undefined;
  if (!e || typeof e.on !== 'function') return;
  const count = typeof e.listenerCount === 'function' ? e.listenerCount('error') : 0;
  if (count > 0) return;
  e.on('error', (err: unknown) => warn(what, err));
}

/**
 * mysql2: the pool itself never emits 'error'; each connection does. A
 * pooled connection handles its FIRST error with a `once` listener that
 * removes it from the pool, and a second one on the same socket has nothing
 * listening. So every connection the pool opens gets a lasting listener,
 * unless the application listens for errors on the pool already.
 */
export function guardMysql2Pool(pool: unknown): void {
  const p = pool as { pool?: unknown } | null | undefined;
  const core = (p && typeof p === 'object' && p.pool && typeof (p.pool as Emitter).on === 'function' ? p.pool : p) as Emitter | null;
  if (!core || typeof core.on !== 'function') return;
  if (typeof core.listenerCount === 'function' && core.listenerCount('error') > 0) return;
  core.on('connection', (conn: Emitter) => {
    if (conn && typeof conn.on === 'function') conn.on('error', (err: unknown) => warn('MySQL', err));
  });
}
