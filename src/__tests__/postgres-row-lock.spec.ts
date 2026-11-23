import { f, model } from '../schema/core';
import type { ModelDef } from '../schema/types';
import { buildSelect, normaliseLock } from '../ir/build';
import { compileSelect } from '../adapters/postgres/compile-from-ir';
import { compileSelect as sqliteSelect } from '../adapters/sqlite/compile-from-ir';
import { compileSelect as mysqlSelect } from '../adapters/mysql/compile-from-ir';
import { compileSelect as mssqlSelect } from '../adapters/mssql/compile-from-ir';
import { compileSelect as duckdbSelect } from '../adapters/duckdb/compile-from-ir';
import { rowLockSql, rowLockUnsupported } from '../adapters/row-lock';

const Job: ModelDef<any> = model('jobs', {
  id: f.id(),
  status: f.string(),
  run_at: f.dateTime(),
});

const sel = (args: any, card: 'one' | 'many' = 'many') =>
  compileSelect(buildSelect('job', Job, args, card), Job).sql;

describe('row locks — postgres SELECT', () => {
  it.each([
    ['update', 'FOR UPDATE'],
    ['noKeyUpdate', 'FOR NO KEY UPDATE'],
    ['share', 'FOR SHARE'],
    ['keyShare', 'FOR KEY SHARE'],
  ])('lock: %s → %s, as the last clause', (mode, clause) => {
    const sql = sel({ where: { status: 'queued' }, take: 5, lock: mode });
    expect(sql.endsWith(` LIMIT 5 ${clause}`)).toBe(true);
  });

  it('SKIP LOCKED and NOWAIT', () => {
    expect(sel({ orderBy: { run_at: 'asc' }, take: 10, lock: { mode: 'update', skipLocked: true } }))
      .toMatch(/ORDER BY .* LIMIT 10 FOR UPDATE SKIP LOCKED$/);
    expect(sel({ where: { id: 'a' }, lock: { mode: 'share', nowait: true } }, 'one'))
      .toMatch(/FOR SHARE NOWAIT$/);
  });

  it('no lock, no clause', () => {
    expect(sel({ where: { status: 'queued' } })).not.toMatch(/FOR /);
  });

  it('refuses a mode it does not know, and nowait with skipLocked', () => {
    expect(() => normaliseLock('exclusive' as any)).toThrow(/not a lock mode/);
    expect(() => normaliseLock({ mode: 'update', nowait: true, skipLocked: true })).toThrow(/cannot both/);
  });

  it('sqlite has no row locks and says what to do instead', () => {
    const node = buildSelect('job', Job, { lock: 'update' }, 'many');
    expect(() => sqliteSelect(node, Job)).toThrow(/SQLite has no row locks[\s\S]*BEGIN IMMEDIATE/);
  });
});

describe('row locks — mysql', () => {
  const my = (args: any) => mysqlSelect(buildSelect('job', Job, args, 'many'), Job).sql;

  it('FOR UPDATE, with NOWAIT / SKIP LOCKED, after LIMIT', () => {
    expect(my({ where: { status: 'q' }, take: 1, lock: 'update' })).toMatch(/ LIMIT 1 FOR UPDATE$/);
    expect(my({ take: 1, lock: { mode: 'update', skipLocked: true } })).toMatch(/ LIMIT 1 FOR UPDATE SKIP LOCKED$/);
    expect(my({ lock: { mode: 'update', nowait: true } })).toMatch(/ FOR UPDATE NOWAIT$/);
  });

  it('share is LOCK IN SHARE MODE (5.7, 8 and MariaDB); with a wait option FOR SHARE', () => {
    expect(my({ lock: 'share' })).toMatch(/ LOCK IN SHARE MODE$/);
    expect(my({ lock: { mode: 'share', skipLocked: true } })).toMatch(/ FOR SHARE SKIP LOCKED$/);
  });

  it('refuses the Postgres-only modes and names the one to use', () => {
    expect(() => my({ lock: 'noKeyUpdate' })).toThrow(/'noKeyUpdate' is a Postgres lock mode[\s\S]*Use 'update'/);
    expect(() => my({ lock: 'keyShare' })).toThrow(/Use 'share'/);
  });
});

describe('row locks — mssql', () => {
  const ms = (args: any) => mssqlSelect(buildSelect('job', Job, args, 'many'), Job).sql;

  it('a table hint after the table, paging still at the end', () => {
    const sql = ms({ where: { status: 'q' }, orderBy: { run_at: 'asc' }, take: 1, lock: { mode: 'update', skipLocked: true } });
    expect(sql).toMatch(/ FROM \[jobs\] WITH \(UPDLOCK, ROWLOCK, READPAST\) WHERE /);
    expect(sql).toMatch(/OFFSET 0 ROWS FETCH NEXT 1 ROWS ONLY$/);
    expect(sql).not.toMatch(/FOR UPDATE/);
  });

  it('share → REPEATABLEREAD; nowait → NOWAIT', () => {
    expect(ms({ lock: 'share' })).toMatch(/FROM \[jobs\] WITH \(REPEATABLEREAD, ROWLOCK\)/);
    expect(ms({ lock: { mode: 'update', nowait: true } })).toMatch(/WITH \(UPDLOCK, ROWLOCK, NOWAIT\)/);
  });

  it('refuses noKeyUpdate / keyShare', () => {
    expect(() => ms({ lock: 'noKeyUpdate' })).toThrow(/SQL Server has no equivalent/);
  });
});

describe('row locks — dialects without them', () => {
  it.each(['sqlite', 'duckdb', 'mongo', 'indexeddb'])('%s refuses with a reason', (kind) => {
    expect(rowLockUnsupported(kind)).toMatch(/\[forge\] lock:/);
    expect(() => rowLockSql(kind, { strength: 'update' })).toThrow(/\[forge\] lock:/);
  });

  it('duckdb compile refuses too', () => {
    expect(() => duckdbSelect(buildSelect('job', Job, { lock: 'update' }, 'many'), Job)).toThrow(/DuckDB has no row locks/);
  });
});
