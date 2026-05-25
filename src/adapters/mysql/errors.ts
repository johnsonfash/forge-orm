import { DbKnownError } from '../mongo/errors';

// MySQL → forge error code mapping.
// Reference: https://dev.mysql.com/doc/mysql-errors/8.0/en/server-error-reference.html
//
// mysql2 surfaces these as `err.code` (string like 'ER_DUP_ENTRY') or
// `err.errno` (numeric). We match by `errno` since the strings change
// between MySQL versions.

interface MysqlError {
  errno?: number;
  code?: string;
  message?: string;
  sqlMessage?: string;
}

const MAP: Record<number, { code: string; mk: (e: MysqlError) => string }> = {
  1062: { code: 'P2002', mk: (e) => `Unique constraint failed: ${e.sqlMessage ?? e.message ?? ''}` },          // ER_DUP_ENTRY
  1452: { code: 'P2003', mk: (e) => `Foreign key constraint failed: ${e.sqlMessage ?? e.message ?? ''}` },    // ER_NO_REFERENCED_ROW_2
  1451: { code: 'P2003', mk: (e) => `Foreign key constraint failed (delete blocked): ${e.sqlMessage ?? ''}` },// ER_ROW_IS_REFERENCED_2
  1048: { code: 'P2011', mk: (e) => `Null constraint violation: ${e.sqlMessage ?? ''}` },                     // ER_BAD_NULL_ERROR
  3819: { code: 'P2004', mk: (e) => `Check constraint failed: ${e.sqlMessage ?? ''}` },                       // ER_CHECK_CONSTRAINT_VIOLATED
  1146: { code: 'P2021', mk: (e) => `Table does not exist: ${e.sqlMessage ?? ''}` },                          // ER_NO_SUCH_TABLE
  1054: { code: 'P2022', mk: (e) => `Column does not exist: ${e.sqlMessage ?? ''}` },                         // ER_BAD_FIELD_ERROR
  1213: { code: 'P2034', mk: () => 'Transaction deadlock — please retry' },                                  // ER_LOCK_DEADLOCK
  1205: { code: 'P2034', mk: () => 'Lock wait timeout — please retry' },                                     // ER_LOCK_WAIT_TIMEOUT
  1317: { code: 'P2024', mk: () => 'Query interrupted (timeout)' },                                          // ER_QUERY_INTERRUPTED
  2002: { code: 'P1001', mk: () => 'Connection refused' },                                                   // CR_CONNECTION_ERROR
  2003: { code: 'P1001', mk: () => "Can't connect to MySQL server" },                                        // CR_CONN_HOST_ERROR
  2006: { code: 'P1001', mk: () => 'MySQL server has gone away' },                                           // CR_SERVER_GONE_ERROR
  1045: { code: 'P1010', mk: () => 'Access denied — authentication failed' },                                // ER_ACCESS_DENIED_ERROR
};

export function rethrowMysqlError(err: any): never {
  if (!err || typeof err !== 'object') throw err;
  if (err instanceof DbKnownError) throw err;
  const errno = (err.errno ?? 0) as number;
  const mapping = MAP[errno];
  if (!mapping) throw err;
  throw new DbKnownError(mapping.code, mapping.mk(err as MysqlError), {
    errno, sqlState: err.sqlState, detail: err.sqlMessage ?? err.message,
  });
}

export async function withMysqlErrors<T>(op: () => Promise<T>): Promise<T> {
  try {
    return await op();
  } catch (err) {
    rethrowMysqlError(err);
  }
}

export { DbKnownError };
