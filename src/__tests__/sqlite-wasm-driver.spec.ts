import { wasmSqliteDriver, isWasmSqliteDriver } from '../adapters/sqlite/wasm-driver';
import { isSqliteDriver } from '../adapters/sqlite/driver';

// FakeWorker — postMessage-shape mock that lets the driver complete its
// round-trip. Each incoming message gets a reply matching the driver's wire
// protocol (id, ok, rows | row | changes | lastInsertRowid).
class FakeWorker {
  private listeners: { [k: string]: ((ev: any) => void)[] } = { message: [], error: [] };
  public sent: any[] = [];
  public replyFor: (msg: any) => any = (msg) => {
    switch (msg.type) {
      case 'open':  return { ok: true };
      case 'exec':  return { ok: true };
      case 'all':   return { ok: true, rows: [{ a: 1 }] };
      case 'get':   return { ok: true, row: { a: 1 } };
      case 'run':   return { ok: true, changes: 1, lastInsertRowid: 42 };
      case 'close': return { ok: true };
      default:      return { ok: false, error: `unknown: ${msg.type}` };
    }
  };
  addEventListener(event: string, fn: (ev: any) => void) { this.listeners[event]?.push(fn); }
  removeEventListener(event: string, fn: (ev: any) => void) {
    this.listeners[event] = (this.listeners[event] ?? []).filter((f) => f !== fn);
  }
  postMessage(msg: any) {
    this.sent.push(msg);
    // Schedule the reply asynchronously to mimic real workers.
    queueMicrotask(() => {
      const reply = this.replyFor(msg);
      for (const fn of this.listeners.message ?? []) fn({ data: { id: msg.id, ...reply } });
    });
  }
  terminate() { /* no-op */ }
}

describe('wasmSqliteDriver', () => {
  test('opens on first call and reuses the connection', async () => {
    const worker = new FakeWorker();
    const driver = wasmSqliteDriver({ worker: worker as unknown as Worker, url: 'opfs-sahpool:///x.db' });
    await driver.exec('CREATE TABLE t(x)');
    expect(driver.kind).toBe('sqlite');
    // First two sent messages: open then exec.
    expect(worker.sent[0]).toMatchObject({ type: 'open', url: 'opfs-sahpool:///x.db' });
    expect(worker.sent[1]).toMatchObject({ type: 'exec', sql: 'CREATE TABLE t(x)' });
    // Second call doesn't re-open.
    await driver.exec('CREATE INDEX i ON t(x)');
    expect(worker.sent[2]).toMatchObject({ type: 'exec', sql: 'CREATE INDEX i ON t(x)' });
  });

  test('all/get/run map worker replies to SqliteDriver shape', async () => {
    const worker = new FakeWorker();
    const driver = wasmSqliteDriver({ worker: worker as unknown as Worker, url: ':memory:' });
    expect(await driver.all('SELECT * FROM t', [])).toEqual([{ a: 1 }]);
    expect(await driver.get('SELECT * FROM t LIMIT 1', [])).toEqual({ a: 1 });
    const r = await driver.run('INSERT INTO t VALUES (?)', [9]);
    expect(r.changes).toBe(1);
    expect(r.lastInsertRowid).toBe(42);
  });

  test('worker error becomes a rejected promise with the message intact', async () => {
    const worker = new FakeWorker();
    worker.replyFor = (msg) => msg.type === 'all'
      ? { ok: false, error: 'no such table: missing' }
      : { ok: true };
    const driver = wasmSqliteDriver({ worker: worker as unknown as Worker });
    await expect(driver.all('SELECT * FROM missing', [])).rejects.toThrow(/no such table: missing/);
  });

  test('queues calls serially even when issued concurrently', async () => {
    const worker = new FakeWorker();
    // Track resolution order — the driver must serialise these.
    const seen: string[] = [];
    const original = worker.replyFor;
    worker.replyFor = (msg) => {
      if (msg.type === 'all' && msg.sql === 'A') seen.push('A');
      if (msg.type === 'all' && msg.sql === 'B') seen.push('B');
      return original(msg);
    };
    const driver = wasmSqliteDriver({ worker: worker as unknown as Worker });
    await Promise.all([driver.all('A', []), driver.all('B', [])]);
    expect(seen).toEqual(['A', 'B']);
  });

  test('close() drains pending requests and terminates the worker', async () => {
    const worker = new FakeWorker();
    let terminated = false;
    worker.terminate = () => { terminated = true; };
    const driver = wasmSqliteDriver({ worker: worker as unknown as Worker });
    await driver.exec('CREATE TABLE t(x)');
    await driver.close();
    expect(terminated).toBe(true);
    await expect(driver.exec('CREATE TABLE u(x)')).rejects.toThrow(/closed/);
  });

  test('isSqliteDriver / isWasmSqliteDriver recognise the wasm driver', () => {
    const driver = wasmSqliteDriver({ worker: new FakeWorker() as unknown as Worker });
    expect(isSqliteDriver(driver)).toBe(true);
    expect(isWasmSqliteDriver(driver)).toBe(true);
    expect(isWasmSqliteDriver({})).toBe(false);
    expect(isWasmSqliteDriver(null)).toBe(false);
  });
});
