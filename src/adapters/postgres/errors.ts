import { DbKnownError } from '../mongo/errors';

// Postgres SQLSTATE → forge error mapping. Same `DbKnownError` shape as
// Mongo so consumers' `try { ... } catch (e) { if (e.code === 'P2002') ... }`
// blocks work uniformly across adapters.
//
// Reference: https://www.postgresql.org/docs/current/errcodes-appendix.html
//            https://www.prisma.io/docs/orm/reference/error-reference

interface SqlstateMap {
  [sqlstate: string]: {
    code: string;          // forge / Prisma code
    message: (e: PgError) => string;
  };
}

interface PgError {
  code?: string;
  message?: string;
  detail?: string;
  table?: string;
  column?: string;
  constraint?: string;
  schema?: string;
}

const MAP: SqlstateMap = {
  // 23xxx — integrity violations
  '23505': { // unique_violation
    code: 'P2002',
    message: (e) => `Unique constraint failed${e.constraint ? ` on ${e.constraint}` : ''}`,
  },
  '23503': { // foreign_key_violation
    code: 'P2003',
    message: (e) => `Foreign key constraint failed${e.constraint ? ` on ${e.constraint}` : ''}`,
  },
  '23502': { // not_null_violation
    code: 'P2011',
    message: (e) => `Null constraint violation on ${e.column ?? '(unknown column)'}`,
  },
  '23514': { // check_violation
    code: 'P2004',
    message: (e) => `Check constraint failed${e.constraint ? ` on ${e.constraint}` : ''}`,
  },
  // 42xxx — schema / syntax
  '42P01': { code: 'P2021', message: (e) => `Table does not exist: ${e.table ?? '(unknown)'}` },
  '42703': { code: 'P2022', message: (e) => `Column does not exist: ${e.column ?? '(unknown)'}` },
  '42P02': { code: 'P2022', message: (e) => `Parameter does not exist: ${e.message ?? ''}` },
  // 40xxx — transaction
  '40P01': { code: 'P2034', message: () => 'Transaction deadlock — please retry' },
  '40001': { code: 'P2034', message: () => 'Serialization failure — please retry' },
  // 57xxx — operator intervention
  '57014': { code: 'P2024', message: () => 'Query canceled (timeout)' },
  // 08xxx — connection
  '08000': { code: 'P1001', message: (e) => `Connection error: ${e.message ?? ''}` },
  '08006': { code: 'P1001', message: (e) => `Connection failure: ${e.message ?? ''}` },
  // 28xxx — auth
  '28P01': { code: 'P1010', message: () => 'Authentication failed for database user' },
  '28000': { code: 'P1010', message: () => 'Invalid authorization specification' },
};

export function rethrowPgError(err: any): never {
  if (!err || typeof err !== 'object') throw err;
  const sqlstate = (err.code as string) ?? '';
  const mapping = MAP[sqlstate];
  if (!mapping) {
    // Already a DbKnownError (e.g. NotFound surfaced by the wrapper) — pass through.
    if (err instanceof DbKnownError) throw err;
    throw err;
  }
  const meta: Record<string, any> = { sqlstate };
  if (err.table) meta.modelName = err.table;
  if (err.column) meta.field_name = err.column;
  if (err.constraint) meta.target = [err.constraint];
  if (err.detail) meta.detail = err.detail;
  throw new DbKnownError(mapping.code, mapping.message(err as PgError), meta);
}

// Convenience wrapper for executor functions — wraps a Promise-returning op
// in the SQLSTATE re-thrower. Keeps the executor sites tight.
export async function withPgErrors<T>(op: () => Promise<T>): Promise<T> {
  try {
    return await op();
  } catch (err) {
    rethrowPgError(err);
  }
}

export { DbKnownError };
