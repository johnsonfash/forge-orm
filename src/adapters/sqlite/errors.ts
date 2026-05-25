import { DbKnownError } from '../mongo/errors';

// SQLite error codes — mapped to forge / Prisma-style P-codes.
// Reference: https://www.sqlite.org/rescode.html
//
// better-sqlite3 surfaces these as `err.code` on SqliteError. The numeric
// extended code is also available as `err.code` on some errors. We match on
// the string code primarily.

interface SqliteError {
  code?: string;
  message?: string;
}

const STRING_MAP: Record<string, { code: string; mk: (e: SqliteError) => string }> = {
  // 23xxx-equivalent constraint failures — surfaced by SQLite as SQLITE_CONSTRAINT_*
  SQLITE_CONSTRAINT_UNIQUE:    { code: 'P2002', mk: (e) => `Unique constraint failed: ${e.message ?? ''}` },
  SQLITE_CONSTRAINT_PRIMARYKEY:{ code: 'P2002', mk: (e) => `Primary key constraint failed: ${e.message ?? ''}` },
  SQLITE_CONSTRAINT_FOREIGNKEY:{ code: 'P2003', mk: (e) => `Foreign key constraint failed: ${e.message ?? ''}` },
  SQLITE_CONSTRAINT_NOTNULL:   { code: 'P2011', mk: (e) => `Null constraint violation: ${e.message ?? ''}` },
  SQLITE_CONSTRAINT_CHECK:     { code: 'P2004', mk: (e) => `Check constraint failed: ${e.message ?? ''}` },
  SQLITE_CONSTRAINT_TRIGGER:   { code: 'P2004', mk: (e) => `Trigger constraint failed: ${e.message ?? ''}` },

  // schema / no such table or column
  SQLITE_ERROR:                { code: 'P2010', mk: (e) => e.message ?? 'SQL error' },

  // database busy / locked → treat as deadlock-equivalent (caller should retry)
  SQLITE_BUSY:                 { code: 'P2034', mk: () => 'Database busy — please retry' },
  SQLITE_LOCKED:               { code: 'P2034', mk: () => 'Database locked — please retry' },

  // i/o / connection
  SQLITE_IOERR:                { code: 'P1001', mk: (e) => `IO error: ${e.message ?? ''}` },
  SQLITE_CANTOPEN:             { code: 'P1001', mk: (e) => `Cannot open database file: ${e.message ?? ''}` },
};

export function rethrowSqliteError(err: any): never {
  if (!err || typeof err !== 'object') throw err;
  if (err instanceof DbKnownError) throw err;
  const code = err.code as string | undefined;
  if (!code) throw err;

  // Match the most specific entry first; fall back to base code.
  for (const k of Object.keys(STRING_MAP)) {
    if (code === k || code.startsWith(k + '_')) {
      const m = STRING_MAP[k];
      throw new DbKnownError(m.code, m.mk(err), { sqliteCode: code, detail: err.message });
    }
  }
  throw err;
}

export async function withSqliteErrors<T>(op: () => Promise<T> | T): Promise<T> {
  try {
    return await op();
  } catch (err) {
    rethrowSqliteError(err);
  }
}

export { DbKnownError };
