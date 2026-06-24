// SQL Server error → forge error mapping. The `mssql` package surfaces
// MSSQL's numeric error codes via err.number; the common DB-engine errors
// have stable numbers we can map to Prisma-style P codes.

import { DbKnownError } from '../mongo/errors';

interface MssqlError {
  number?: number;
  code?: string;
  message?: string;
  precedingErrors?: any[];
}

// Reference: docs.microsoft.com/en-us/sql/relational-databases/errors-events/
const NUMBER_MAP: Record<number, { code: string; build: (e: MssqlError) => string }> = {
  // Unique key / primary key violations
  2627: { code: 'P2002', build: (e) => `Unique constraint failed: ${e.message ?? ''}` },
  2601: { code: 'P2002', build: (e) => `Unique constraint failed: ${e.message ?? ''}` },
  // Foreign key violations
  547:  { code: 'P2003', build: (e) => `Foreign key constraint failed: ${e.message ?? ''}` },
  // NOT NULL violation
  515:  { code: 'P2011', build: (e) => `Null constraint violation: ${e.message ?? ''}` },
  // CHECK violation surfaces as 547 historically; nothing else clean.
  // Invalid object name (table not found)
  208:  { code: 'P2021', build: (e) => `Table does not exist: ${e.message ?? ''}` },
  // Invalid column name
  207:  { code: 'P2022', build: (e) => `Column does not exist: ${e.message ?? ''}` },
  // Deadlock
  1205: { code: 'P2034', build: () => `Transaction deadlock — please retry` },
  // Login failed
  18456: { code: 'P1010', build: () => `Authentication failed for database user` },
};

export function rethrowMssqlError(err: any): never {
  if (!err || typeof err !== 'object') throw err;
  if (err instanceof DbKnownError) throw err;
  const e = err as MssqlError;
  const num = typeof e.number === 'number' ? e.number : undefined;
  if (num != null && NUMBER_MAP[num]) {
    const m = NUMBER_MAP[num];
    throw new DbKnownError(m.code, m.build(e), { number: num, detail: e.message });
  }
  throw err;
}

export async function withMssqlErrors<T>(op: () => Promise<T>): Promise<T> {
  try {
    return await op();
  } catch (err) {
    rethrowMssqlError(err);
  }
}

export { DbKnownError };
