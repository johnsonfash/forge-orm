import type { Adapter } from '../adapters/types';
import { ambientSessionsSupported, runWithSession } from '../session-context';

/**
 * Run a multi-statement write (nested create, cascading delete) in a
 * transaction when the caller is not already in one and the connection can
 * open one. `fn` gets the session to thread through every statement; it is
 * `undefined` when the work runs without a transaction (a standalone Mongo,
 * IndexedDB), which is best-effort by necessity.
 */
export async function runAtomic<T>(
  adapter: Adapter,
  session: unknown,
  fn: (session: unknown) => Promise<T>,
): Promise<T> {
  if (session !== undefined) return fn(session);
  if (adapter.supportsTransactions && !(await adapter.supportsTransactions())) return fn(undefined);
  // A single-connection database already inside a transaction that this call
  // cannot see (no async context in a browser): it is physically in it anyway,
  // and waiting for it to finish would deadlock.
  if ((adapter as { inTransaction?: boolean }).inTransaction && !ambientSessionsSupported()) {
    return fn(undefined);
  }
  return adapter.$transaction((s) => runWithSession(adapter, s, () => fn(s)));
}
