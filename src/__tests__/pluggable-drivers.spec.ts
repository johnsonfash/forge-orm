import { mysql2Driver, mariadbDriver, planetscaleDriver, isMysqlDriver } from '../adapters/mysql/driver';
import { mongoDriver, isMongoDriver } from '../adapters/mongo/driver';

describe('MysqlDriver wrappers normalize each client to mysql2 tuple shape', () => {
  test('mysql2Driver passes query/execute through and runs a transaction', async () => {
    const calls: any[] = [];
    const conn = {
      query: async (sql: string, p?: any[]) => { calls.push(['conn.query', sql, p]); return [[{ id: 1 }], []]; },
      execute: async (sql: string, p?: any[]) => { calls.push(['conn.execute', sql, p]); return [{ affectedRows: 1 }, []]; },
      release: () => calls.push(['release']),
    };
    const pool = {
      query: async (sql: string, p?: any[]) => [[{ id: 9 }], []],
      execute: async (sql: string, p?: any[]) => [{ affectedRows: 2 }, []],
      getConnection: async () => conn,
      end: async () => calls.push(['end']),
    };
    const d = mysql2Driver(pool);
    expect(await d.query('SELECT 1', [])).toEqual([[{ id: 9 }], []]);
    expect((await d.execute('UPDATE x', []))[0]).toEqual({ affectedRows: 2 });
    const r = await d.transaction(async (s) => { await s.query('Q', []); return 'done'; });
    expect(r).toBe('done');
    expect(calls).toEqual(expect.arrayContaining([['conn.query', 'START TRANSACTION', undefined], ['conn.query', 'Q', []], ['conn.query', 'COMMIT', undefined], ['release']]));
  });

  test('mariadbDriver normalizes rows + write results to tuples', async () => {
    const rows = Object.assign([{ id: 1 }], { meta: ['m'] });
    const pool = {
      query: async (sql: string) => /INSERT|UPDATE|DELETE/.test(sql) ? { affectedRows: 3, insertId: 42n } : rows,
      getConnection: async () => ({ query: async () => rows, beginTransaction: async () => {}, commit: async () => {}, rollback: async () => {}, release: () => {} }),
      end: async () => {},
    };
    const d = mariadbDriver(pool);
    const [qrows] = await d.query('SELECT 1', []);
    expect(qrows.length).toBe(1);                             // rows array (meta prop rides along harmlessly)
    expect(qrows[0]).toEqual({ id: 1 });
    const [res] = await d.execute('UPDATE x', []);
    expect(res).toEqual({ affectedRows: 3, insertId: 42 });   // BigInt insertId → number
  });

  test('planetscaleDriver maps execute() result to tuples', async () => {
    const conn = {
      execute: async (sql: string) => ({ rows: [{ id: 7 }], fields: ['f'], rowsAffected: 5, insertId: '88' }),
      transaction: async (fn: any) => fn({ execute: async () => ({ rows: [], rowsAffected: 1, insertId: '2' }) }),
    };
    const d = planetscaleDriver(conn);
    expect(await d.query('S', [])).toEqual([[{ id: 7 }], ['f']]);
    expect((await d.execute('U', []))[0]).toEqual({ affectedRows: 5, insertId: 88 });
    await expect(d.transaction(async (s) => (await s.execute('U', []))[0])).resolves.toEqual({ affectedRows: 1, insertId: 2 });
  });

  test('isMysqlDriver recognises wrapped drivers only', () => {
    expect(isMysqlDriver(mysql2Driver({ query: async () => [[], []], execute: async () => [{}, []], getConnection: async () => ({}), end: async () => {} }))).toBe(true);
    expect(isMysqlDriver({ kind: 'mysql' })).toBe(false);
    expect(isMysqlDriver(null)).toBe(false);
  });
});

describe('MongoDriver — bring-your-own MongoClient', () => {
  test('mongoDriver tags a client (with a .db method) and carries dbName', () => {
    const client = { db: () => ({}), connect: async () => {} };
    const d = mongoDriver(client, 'mydb');
    expect(d.kind).toBe('mongo');
    expect(d.client).toBe(client);
    expect(d.dbName).toBe('mydb');
    expect(isMongoDriver(d)).toBe(true);
  });

  test('mongoDriver rejects a non-client', () => {
    expect(() => mongoDriver({} as any)).toThrow(/expects a MongoClient/);
    expect(() => mongoDriver(null as any)).toThrow(/expects a MongoClient/);
    expect(isMongoDriver({ kind: 'mongo' })).toBe(false);
  });
});
