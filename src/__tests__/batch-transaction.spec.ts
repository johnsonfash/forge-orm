import { f, model, setActiveSchema } from '../index';
import { createDb } from '../factory';
import { pgDriver } from '../adapters/postgres/driver';

// `$transaction([...])` was `Promise.all(arg)`, which gives no atomicity and
// cannot: by the time the array arrives, `db.a.create(...)` has already been
// evaluated and the write has already gone to the database, on its own. A
// money transfer written that way lost atomicity silently.
//
// A fake pool is used so the BEGIN/COMMIT/ROLLBACK the driver issues can be
// asserted directly — the point is which statements are sent and on which
// connection, not what a database does with them.

const Acct = model('accts', { id: f.id(), bal: f.int() });
const sch = { acct: Acct } as never;

/** Records every statement, and which connection it went to. */
function fakePool() {
  const log: string[] = [];
  const mkClient = (label: string) => ({
    query: async (sql: string) => { log.push(`${label}: ${sql.split(' ').slice(0, 2).join(' ')}`); return { rows: [{ id: 'x', bal: 1 }], rowCount: 1 }; },
    release: () => log.push(`${label}: release`),
  });
  let n = 0;
  return {
    log,
    query: async (sql: string) => { log.push(`pool: ${sql.split(' ').slice(0, 2).join(' ')}`); return { rows: [{ id: 'x', bal: 1 }], rowCount: 1 }; },
    connect: async () => mkClient(`tx${++n}`),
    end: async () => undefined,
  };
}

async function makeDb() {
  setActiveSchema(sch);
  const pool = fakePool();
  const db = await createDb({ driver: pgDriver(pool), schema: sch }) as never as {
    $transaction(a: unknown): Promise<unknown>;
    acct: { update(a: unknown): Promise<unknown> };
    $disconnect(): Promise<void>;
  };
  return { db, pool };
}

const bump = (db: { acct: { update(a: unknown): Promise<unknown> } }, n: number) =>
  db.acct.update({ where: { id: 'x' }, data: { bal: { increment: n } } });

describe('an array of thunks', () => {
  test('runs inside one transaction, on one connection', async () => {
    const { db, pool } = await makeDb();
    await db.$transaction([() => bump(db, 1), () => bump(db, 2)]);
    expect(pool.log.filter((l) => l.includes('BEGIN'))).toHaveLength(1);
    expect(pool.log.filter((l) => l.includes('COMMIT'))).toHaveLength(1);
    // Both updates went to the transaction's connection, not the pool.
    expect(pool.log.filter((l) => l.startsWith('tx1: UPDATE'))).toHaveLength(2);
    expect(pool.log.filter((l) => l.startsWith('pool: UPDATE'))).toHaveLength(0);
    await db.$disconnect();
  });

  test('a throw rolls back and never commits', async () => {
    const { db, pool } = await makeDb();
    await expect(db.$transaction([
      () => bump(db, 1),
      () => { throw new Error('second'); },
    ])).rejects.toThrow('second');
    expect(pool.log.some((l) => l.includes('ROLLBACK'))).toBe(true);
    expect(pool.log.some((l) => l.includes('COMMIT'))).toBe(false);
    await db.$disconnect();
  });

  test('they run in order, not concurrently', async () => {
    // One session cannot serve overlapping operations — Mongo rejects it
    // outright and a PG connection serialises anyway.
    const { db, pool } = await makeDb();
    const order: number[] = [];
    await db.$transaction([
      async () => { await bump(db, 1); order.push(1); },
      async () => { await bump(db, 2); order.push(2); },
    ]);
    expect(order).toEqual([1, 2]);
    await db.$disconnect();
  });

  test('results come back in order', async () => {
    const { db } = await makeDb();
    const out = await db.$transaction([() => Promise.resolve('a'), () => Promise.resolve('b')]) as string[];
    expect(out).toEqual(['a', 'b']);
    await db.$disconnect();
  });

  test('an empty array opens no transaction at all', async () => {
    const { db, pool } = await makeDb();
    const before = pool.log.length;   // createDb itself probes the connection
    await expect(db.$transaction([])).resolves.toEqual([]);
    expect(pool.log.slice(before)).toEqual([]);
    await db.$disconnect();
  });

  test('a thunk gets the tx handle as its argument', async () => {
    const { db, pool } = await makeDb();
    await db.$transaction([
      (tx: never) => (tx as { acct: { update(a: unknown): Promise<unknown> } })
        .acct.update({ where: { id: 'x' }, data: { bal: 1 } }),
    ]);
    expect(pool.log.filter((l) => l.startsWith('tx1: UPDATE'))).toHaveLength(1);
    await db.$disconnect();
  });
});

describe('an array of already-started promises', () => {
  test('is refused rather than silently un-atomic', async () => {
    const { db } = await makeDb();
    await expect(db.$transaction([bump(db, 1), bump(db, 2)]))
      .rejects.toThrow(/takes functions, not promises/);
    await db.$disconnect();
  });

  test('no transaction is opened for a call that cannot be honoured', async () => {
    const { db, pool } = await makeDb();
    await db.$transaction([bump(db, 1)]).catch(() => undefined);
    expect(pool.log.some((l) => l.includes('BEGIN'))).toBe(false);
    await db.$disconnect();
  });

  test('the error counts them and shows both working forms', async () => {
    const { db } = await makeDb();
    let msg = '';
    try { await db.$transaction([bump(db, 1)]); } catch (e) { msg = (e as Error).message; }
    expect(msg).toContain('1 of 1 item was already running');
    expect(msg).toContain('() => db.a.create');
    expect(msg).toContain('callback form');
    await db.$disconnect();
  });

  test('a mix of thunks and promises is refused too', async () => {
    const { db } = await makeDb();
    await expect(db.$transaction([() => bump(db, 1), bump(db, 2)]))
      .rejects.toThrow(/1 of 2 items was already running/);
    await db.$disconnect();
  });
});

describe('the callback form', () => {
  test('a nested $transaction joins the open one instead of opening a second', async () => {
    // Postgres refuses a nested BEGIN, so a repository calling $transaction
    // defensively must not break its caller's.
    const { db, pool } = await makeDb();
    await db.$transaction(async () => {
      await bump(db, 1);
      await (db as { $transaction(a: unknown): Promise<unknown> }).$transaction(async () => { await bump(db, 2); });
    });
    expect(pool.log.filter((l) => l.includes('BEGIN'))).toHaveLength(1);
    expect(pool.log.filter((l) => l.includes('COMMIT'))).toHaveLength(1);
    await db.$disconnect();
  });

  test('a nested array form joins it too', async () => {
    const { db, pool } = await makeDb();
    await db.$transaction(async (tx: never) =>
      (tx as { $transaction(a: unknown): Promise<unknown> }).$transaction([() => bump(db, 1)]));
    expect(pool.log.filter((l) => l.includes('BEGIN'))).toHaveLength(1);
    await db.$disconnect();
  });
});
