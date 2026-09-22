// The session the current call is already inside, if any.
//
// `$transaction(async (tx) => …)` hands the callback a `tx` handle whose
// wrappers carry the driver session. That works when the callback does the
// writes itself, and not at all when it calls into a repository layer:
//
//   await db.$transaction(async () => {          // tx discarded
//     await stockRepo.record(orgId, movement);   // uses the ambient db
//     await itemRepo.incrementStock(orgId, sku); // ditto
//   });
//
// Neither leg carries the session, so neither is in the transaction and
// nothing rolls back — while the code reads as though it does. The only fix
// available was to thread `tx` through every repository signature, which for
// a layered codebase means changing every function between the route and the
// query.
//
// So the session is kept in an AsyncLocalStorage instead, and a wrapper with
// no explicit session of its own picks it up. Async context propagates across
// `await`, so a repository called anywhere beneath the callback joins the
// transaction without knowing it exists.
//
// It is stored WITH its adapter. A session belongs to the connection that
// created it, and handing a Mongo `ClientSession` to a different client is an
// error — so a process with two databases must not have one's transaction
// silently captured by the other's queries.

export interface SessionScope {
  /** The adapter that opened this session. Identity-compared, never cloned. */
  readonly adapter: unknown;
  readonly session: unknown;
}

interface Store<T> {
  getStore(): T | undefined;
  run<R>(value: T, fn: () => R): R;
}

/**
 * `node:async_hooks` is Node-only. The specifier is assembled at runtime so a
 * bundler cannot resolve it statically — a literal `require('node:async_hooks')`
 * fails a browser build outright, and forge runs in the browser on SQLite-wasm
 * and IndexedDB.
 *
 * Without it there is no ambient session, which is the correct answer for a
 * browser: IndexedDB has no interactive transaction to join.
 */
function loadStore(): Store<SessionScope> | null {
  try {
    const spec = 'node:async_' + 'hooks';
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require(spec) as { AsyncLocalStorage?: new () => Store<SessionScope> };
    if (!mod?.AsyncLocalStorage) return null;
    return new mod.AsyncLocalStorage();
  } catch {
    return null;
  }
}

let _store: Store<SessionScope> | null | undefined;

function store(): Store<SessionScope> | null {
  if (_store === undefined) _store = loadStore();
  return _store;
}

/** True when async context is available — Node yes, browser no. */
export function ambientSessionsSupported(): boolean {
  return store() !== null;
}

/**
 * Run `fn` with `session` as the ambient one. Everything awaited beneath it
 * sees the session; siblings outside it do not.
 */
export function runWithSession<T>(adapter: unknown, session: unknown, fn: () => T): T {
  const s = store();
  if (!s) return fn();
  return s.run({ adapter, session }, fn);
}

/**
 * The ambient session for `adapter`, or undefined.
 *
 * The adapter check is the whole reason the scope carries one: a session from
 * another connection is not merely useless, it is rejected by the driver.
 */
export function currentSession(adapter: unknown): unknown {
  const scope = store()?.getStore();
  if (!scope) return undefined;
  return scope.adapter === adapter ? scope.session : undefined;
}

// There is deliberately no `withoutAmbientSession()` helper.
//
// "Write this row so it survives the rollback" cannot be delivered
// consistently: detaching the session only helps on a driver that hands out a
// separate connection per transaction. On SQLite, PGlite and DuckDB the
// transaction IS the one connection the process has, so the statement is
// physically inside it however it is issued, and it rolls back anyway.
// Measured on PGlite: the row was gone.
//
// An API that works on Postgres and silently does not on SQLite is the kind
// of difference this library exists to remove, so the escape hatch is to use
// a second `createDb()` — its own connection, genuinely outside.
