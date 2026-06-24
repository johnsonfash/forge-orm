// DuckDB error → forge error mapping. DuckDB doesn't expose SQLSTATE the
// way Postgres does — its Error objects carry a textual `errorType`
// (Constraint, Catalog, Conversion, Parser, Binder, etc.) and a `message`.
// We do best-effort matching against well-known message patterns since
// downstream callers want the same Prisma-style P-codes the PG adapter
// produces.

import { DbKnownError } from '../mongo/errors';

interface DuckdbError {
  code?: string;
  errorType?: string;
  message?: string;
}

export function rethrowDuckdbError(err: any): never {
  if (!err || typeof err !== 'object') throw err;
  const e = err as DuckdbError;
  const msg = String(e.message ?? '');
  const errType = String(e.errorType ?? '');

  // Pass through already-typed forge errors.
  if (err instanceof DbKnownError) throw err;

  // Constraint violations — DuckDB error messages include the constraint
  // type explicitly.
  if (errType === 'Constraint' || /Constraint Error/i.test(msg)) {
    if (/duplicate key|UNIQUE constraint|Primary key conflict/i.test(msg)) {
      throw new DbKnownError('P2002', `Unique constraint failed: ${msg}`, { detail: msg });
    }
    if (/NOT NULL/i.test(msg)) {
      throw new DbKnownError('P2011', `Null constraint violation: ${msg}`, { detail: msg });
    }
    if (/CHECK constraint/i.test(msg)) {
      throw new DbKnownError('P2004', `Check constraint failed: ${msg}`, { detail: msg });
    }
    if (/foreign key/i.test(msg)) {
      throw new DbKnownError('P2003', `Foreign key constraint failed: ${msg}`, { detail: msg });
    }
  }

  // Catalog Error — table / column not found.
  if (errType === 'Catalog' || /Catalog Error/i.test(msg)) {
    if (/Table .* does not exist|table named/i.test(msg)) {
      throw new DbKnownError('P2021', `Table does not exist: ${msg}`, { detail: msg });
    }
    if (/column .* does not exist|column named/i.test(msg)) {
      throw new DbKnownError('P2022', `Column does not exist: ${msg}`, { detail: msg });
    }
  }

  // Conversion Error — type mismatch / cast failure.
  if (errType === 'Conversion' || /Conversion Error/i.test(msg)) {
    throw new DbKnownError('P2007', `Data conversion failed: ${msg}`, { detail: msg });
  }

  throw err;
}

export async function withDuckdbErrors<T>(op: () => Promise<T>): Promise<T> {
  try {
    return await op();
  } catch (err) {
    rethrowDuckdbError(err);
  }
}

export { DbKnownError };
