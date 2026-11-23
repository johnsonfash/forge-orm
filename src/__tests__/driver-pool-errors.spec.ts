import { EventEmitter } from 'node:events';
import { pgDriver, postgresJsDriver } from '../adapters/postgres/driver';
import { mysql2Driver, mariadbDriver } from '../adapters/mysql/driver';
import { mssqlDriver } from '../adapters/mssql/driver';

// A pool is an EventEmitter. An 'error' with no listener is an uncaught
// exception, so an idle connection dying used to exit the process for any
// pool forge did not build itself.

const quiet = () => jest.spyOn(process, 'emitWarning').mockImplementation(() => {});

describe('pool error guards', () => {
  afterEach(() => jest.restoreAllMocks());

  it.each([
    ['pgDriver', (p: EventEmitter) => pgDriver(p)],
    ['mariadbDriver', (p: EventEmitter) => mariadbDriver(p)],
    ['mssqlDriver', (p: EventEmitter) => mssqlDriver(p)],
  ])('%s: an injected pool with no error listener survives an emitted error', (_n, wrap) => {
    const warn = quiet();
    const pool = new EventEmitter();
    wrap(pool);
    expect(pool.listenerCount('error')).toBe(1);
    expect(() => pool.emit('error', new Error('terminating connection'))).not.toThrow();
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/idle .* connection lost \(terminating connection\)/));
  });

  it.each([
    ['pgDriver', (p: EventEmitter) => pgDriver(p)],
    ['mariadbDriver', (p: EventEmitter) => mariadbDriver(p)],
    ['mssqlDriver', (p: EventEmitter) => mssqlDriver(p)],
  ])('%s: a pool the application already listens to is left alone', (_n, wrap) => {
    const pool = new EventEmitter();
    const mine = jest.fn();
    pool.on('error', mine);
    wrap(pool);
    expect(pool.listenerCount('error')).toBe(1);
    pool.emit('error', new Error('x'));
    expect(mine).toHaveBeenCalled();
  });

  it('wrapping the same pool twice adds one listener', () => {
    const pool = new EventEmitter();
    pgDriver(pool);
    pgDriver(pool);
    expect(pool.listenerCount('error')).toBe(1);
  });

  it('mysql2: every connection the pool opens gets a lasting error listener', () => {
    const warn = quiet();
    const core = new EventEmitter();
    const promisePool = Object.assign(new EventEmitter(), { pool: core });
    mysql2Driver(promisePool);
    const conn = new EventEmitter();
    // What mysql2's PoolConnection does: one `once` listener that drops it.
    conn.once('error', () => {});
    core.emit('connection', conn);
    conn.emit('error', new Error('first'));
    expect(() => conn.emit('error', new Error('second, after the once listener is gone'))).not.toThrow();
    expect(warn).toHaveBeenCalled();
  });

  it('a plain object with no .on (a custom pool) is accepted as it is', () => {
    expect(() => pgDriver({ query: async () => ({ rows: [] }) })).not.toThrow();
  });
});

describe('postgresJsDriver prepares unless the client says not to', () => {
  const fakeSql = (prepare?: boolean) => {
    const calls: any[] = [];
    const sql: any = {
      options: prepare === undefined ? {} : { prepare },
      unsafe: (text: string, params: unknown[], opts?: unknown) => {
        calls.push({ text, params, opts });
        const r: any = Promise.resolve(Object.assign([], { count: 0 }));
        r.simple = () => { calls.push({ text, simple: true }); return Promise.resolve([]); };
        return r;
      },
      begin: (fn: any) => fn(sql),
      reserve: async () => ({ ...sql, release: () => {} }),
      end: async () => {},
    };
    return { sql, calls };
  };

  it.each([[undefined, true], [true, true], [false, false]])(
    'client prepare=%s → unsafe(…, { prepare: %s }) on the pool, in a transaction and on a reserved connection',
    async (setting, expected) => {
      const { sql, calls } = fakeSql(setting as boolean | undefined);
      const d = postgresJsDriver(sql);
      await d.query('SELECT $1', [1]);
      await d.transaction((tx) => tx.query('SELECT 2', []));
      const r = await d.reserve!();
      await r.query('SELECT 3', []);
      expect(calls.map((c) => c.opts)).toEqual([{ prepare: expected }, { prepare: expected }, { prepare: expected }]);
    },
  );

  it('exec (a multi-statement script) is sent unprepared over the simple protocol', async () => {
    const { sql, calls } = fakeSql(true);
    await postgresJsDriver(sql).transaction((tx) => tx.exec!('SELECT 1; SELECT 2'));
    expect(calls).toContainEqual({ text: 'SELECT 1; SELECT 2', simple: true });
    expect(calls.find((c) => c.text === 'SELECT 1; SELECT 2' && !c.simple)?.opts).toBeUndefined();
  });
});
