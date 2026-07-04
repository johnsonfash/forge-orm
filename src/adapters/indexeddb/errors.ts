// IDB DOMException.name → Prisma-style P-code, wrapped as DbKnownError
// so `catch (e) { if (e.code === 'P2002') }` works the same as every
// other adapter.
//
// Reference: https://w3c.github.io/IndexedDB/#exceptions

import { DbKnownError } from '../mongo/errors';

const CODE_MAP: Record<string, string> = {
  ConstraintError: 'P2002',        // unique-index conflict
  DataError:       'P2011',        // key-path type mismatch, out-of-range
  NotFoundError:   'P2025',        // store or record not found
  QuotaExceededError: 'P2028',     // over storage quota
  VersionError:    'P2035',        // open() version < current
  AbortError:      'P2034',        // txn aborted (deadlock analog)
  TransactionInactiveError: 'P2036', // async gap outside txn
  ReadOnlyError:   'P2037',        // write on readonly txn
  InvalidStateError: 'P2038',      // db closed
};

export function wrapIdbError(err: unknown): DbKnownError {
  if (err instanceof DbKnownError) return err;
  if (err instanceof Error) {
    const code = CODE_MAP[err.name] ?? 'P2010';
    return new DbKnownError(code, err.message, { originalName: err.name });
  }
  return new DbKnownError('P2010', String(err));
}

export async function withIdbErrors<T>(op: () => Promise<T>): Promise<T> {
  try { return await op(); } catch (e) { throw wrapIdbError(e); }
}

export function notFound(collection: string, where: unknown): DbKnownError {
  return new DbKnownError('P2025', `No ${collection} found matching the given criteria`, { modelName: collection, cause: where });
}
