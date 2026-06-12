import {
  betterSqlite3Driver, expoSqliteDriver, opSqliteDriver, libsqlDriver, isSqliteDriver,
} from '../adapters/sqlite/driver';

describe('SqliteDriver wrappers normalize each concrete driver to the port', () => {
  test('betterSqlite3Driver maps prepare().all/get/run/exec/iterate', async () => {
    const calls: any[] = [];
    const stmt = (sql: string) => ({
      all: (...p: any[]) => { calls.push(['all', sql, p]); return [{ id: 1 }]; },
      get: (...p: any[]) => { calls.push(['get', sql, p]); return { id: 1 }; },
      run: (...p: any[]) => { calls.push(['run', sql, p]); return { changes: 2, lastInsertRowid: 7 }; },
      iterate: (...p: any[]) => { calls.push(['iterate', sql, p]); return [{ id: 1 }][Symbol.iterator](); },
    });
    const fake = { prepare: stmt, exec: (sql: string) => calls.push(['exec', sql]), close: () => calls.push(['close']) };
    const d = betterSqlite3Driver(fake);

    expect(await d.all('SELECT ?', [9])).toEqual([{ id: 1 }]);
    expect(calls.at(-1)).toEqual(['all', 'SELECT ?', [9]]);   // spread into prepare().all(9)
    expect(await d.get('G', [1])).toEqual({ id: 1 });
    expect(await d.run('U', [1, 2])).toEqual({ changes: 2, lastInsertRowid: 7 });
    await d.exec('BEGIN'); expect(calls.at(-1)).toEqual(['exec', 'BEGIN']);
    await d.close(); expect(calls.at(-1)).toEqual(['close']);
    expect(d.kind).toBe('sqlite');
  });

  test('expoSqliteDriver maps the async getAllAsync/runAsync surface', async () => {
    const fake = {
      getAllAsync: async (sql: string, p: any[]) => [{ sql, p }],
      getFirstAsync: async (sql: string, p: any[]) => ({ sql, p }),
      runAsync: async () => ({ changes: 3, lastInsertRowId: 11 }),   // expo uses lastInsertRowId
      execAsync: async () => undefined,
      closeAsync: async () => undefined,
    };
    const d = expoSqliteDriver(fake);
    expect(await d.all('S', [1])).toEqual([{ sql: 'S', p: [1] }]);
    expect(await d.run('U', [])).toEqual({ changes: 3, lastInsertRowid: 11 });  // normalized key
  });

  test('opSqliteDriver unwraps rows._array and maps rowsAffected/insertId', async () => {
    const fake = {
      execute: async (sql: string, _p: any[]) => ({ rows: { _array: [{ sql }] }, rowsAffected: 4, insertId: 12 }),
      close: () => undefined,
    };
    const d = opSqliteDriver(fake);
    expect(await d.all('S', [1])).toEqual([{ sql: 'S' }]);
    expect(await d.get('S', [1])).toEqual({ sql: 'S' });
    expect(await d.run('U', [1])).toEqual({ changes: 4, lastInsertRowid: 12 });
  });

  test('libsqlDriver rebuilds rows from columns and maps rowsAffected', async () => {
    const fake = {
      execute: async (arg: any) => ({
        rows: [['x', 5]],                 // array-indexed row
        columns: ['name', 'age'],
        rowsAffected: 1,
        lastInsertRowid: 99,
        _arg: arg,
      }),
      close: () => undefined,
    };
    const d = libsqlDriver(fake);
    expect(await d.all('S', [1])).toEqual([{ name: 'x', age: 5 }]);   // column-keyed plain object
    expect(await d.get('S', [])).toEqual({ name: 'x', age: 5 });
    expect(await d.run('U', [1])).toEqual({ changes: 1, lastInsertRowid: 99 });
  });

  test('isSqliteDriver recognises wrapped drivers only', () => {
    expect(isSqliteDriver(betterSqlite3Driver({ prepare: () => ({}), exec: () => {}, close: () => {} }))).toBe(true);
    expect(isSqliteDriver({})).toBe(false);
    expect(isSqliteDriver(null)).toBe(false);
    expect(isSqliteDriver({ kind: 'sqlite' })).toBe(false);   // missing all/run
  });
});
