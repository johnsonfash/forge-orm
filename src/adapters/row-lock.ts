import type { RowLockSpec } from '../ir/types';

// How each dialect spells `lock:` on a SELECT, or why it cannot.
//
//   postgres  FOR UPDATE | FOR NO KEY UPDATE | FOR SHARE | FOR KEY SHARE
//             [NOWAIT | SKIP LOCKED]
//   mysql     FOR UPDATE [NOWAIT | SKIP LOCKED]          (NOWAIT / SKIP LOCKED: 8.0+, MariaDB 10.6+)
//             LOCK IN SHARE MODE                         (5.7, 8.x and MariaDB alike)
//             FOR SHARE NOWAIT | SKIP LOCKED             (8.0+ only)
//   mssql     WITH (UPDLOCK, ROWLOCK [, NOWAIT | READPAST])        after the table
//             WITH (REPEATABLEREAD, ROWLOCK [, NOWAIT | READPAST])
//
// noKeyUpdate and keyShare are Postgres's weaker modes, which exist so a
// foreign-key check does not wait on an UPDATE. MySQL and SQL Server have no
// such split; quietly taking the stronger lock instead would change what
// blocks what, so they are refused with the mode to use.

export interface RowLockSql {
  /** Goes right after the table name in FROM (mssql). */
  hint: string;
  /** Goes at the end of the SELECT (postgres, mysql). */
  tail: string;
}

const PG: Record<RowLockSpec['strength'], string> = {
  update: 'FOR UPDATE',
  noKeyUpdate: 'FOR NO KEY UPDATE',
  share: 'FOR SHARE',
  keyShare: 'FOR KEY SHARE',
};

const NAMES: Record<string, string> = {
  mysql: 'MySQL', mssql: 'SQL Server', sqlite: 'SQLite', duckdb: 'DuckDB', mongo: 'MongoDB', indexeddb: 'IndexedDB',
};

/** The reason `lock:` cannot run on `kind` at all, or null when it can. */
export function rowLockUnsupported(kind: string): string | null {
  switch (kind) {
    case 'postgres':
    case 'mysql':
    case 'mssql':
      return null;
    case 'sqlite':
      return `[forge] lock: SQLite has no row locks. A write transaction locks the whole ` +
        `database instead, so run the read and the write in one db.$transaction(); to hold ` +
        `the write lock from the first read, start it with BEGIN IMMEDIATE.`;
    case 'duckdb':
      return `[forge] lock: DuckDB has no row locks (it resolves concurrent writes with ` +
        `optimistic concurrency, and one process owns the file). Run the read and the ` +
        `write in one db.$transaction().`;
    case 'mongo':
      return `[forge] lock: MongoDB has no SELECT … FOR UPDATE. Use an atomic ` +
        `findOneAndUpdate (update with a where that matches only an unclaimed document) ` +
        `to claim a document.`;
    default:
      return `[forge] lock: row locks are not supported on ${NAMES[kind] ?? kind}.`;
  }
}

export function rowLockSql(kind: string, lock: RowLockSpec): RowLockSql {
  const unsupported = rowLockUnsupported(kind);
  if (unsupported) throw new Error(unsupported);
  if (kind === 'postgres') {
    const wait = lock.wait === 'nowait' ? ' NOWAIT' : lock.wait === 'skipLocked' ? ' SKIP LOCKED' : '';
    return { hint: '', tail: `${PG[lock.strength]}${wait}` };
  }
  if (lock.strength === 'noKeyUpdate' || lock.strength === 'keyShare') {
    const use = lock.strength === 'noKeyUpdate' ? 'update' : 'share';
    throw new Error(
      `[forge] lock: '${lock.strength}' is a Postgres lock mode and ${NAMES[kind]} has no ` +
        `equivalent. Use '${use}', which also blocks what '${lock.strength}' lets through.`,
    );
  }
  if (kind === 'mysql') {
    const wait = lock.wait === 'nowait' ? ' NOWAIT' : lock.wait === 'skipLocked' ? ' SKIP LOCKED' : '';
    if (lock.strength === 'update') return { hint: '', tail: `FOR UPDATE${wait}` };
    return { hint: '', tail: wait ? `FOR SHARE${wait}` : 'LOCK IN SHARE MODE' };
  }
  const hints = [lock.strength === 'update' ? 'UPDLOCK' : 'REPEATABLEREAD', 'ROWLOCK'];
  if (lock.wait === 'nowait') hints.push('NOWAIT');
  if (lock.wait === 'skipLocked') hints.push('READPAST');
  return { hint: ` WITH (${hints.join(', ')})`, tail: '' };
}
