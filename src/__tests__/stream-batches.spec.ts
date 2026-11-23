// findManyStream.
//
// Postgres fetched its cursor 200 rows a round trip (55 round trips for 10k
// rows where 1000-row fetches take 15) and opened its own connection even
// inside a transaction. DuckDB had no native stream and paged with OFFSET,
// which gets slower page by page; its node API's own stream is unusable here
// because any other query on the connection silently ends it, so it pages by
// key instead. Every native stream now hands the wrapper a batch at a time.

import { f, model } from '../schema/core';
import { openDuckdb, openSqlite } from './_live-dbs';
import { pgDriver } from '../adapters/postgres/driver';
import { createDb } from '../factory';

const Item = model('items', {
  id: f.id({ type: 'string' }),
  n: f.int(),
  tag: f.string().optional(),
});
const schema = { item: Item };
const rows = Array.from({ length: 2500 }, (_, i) => ({ id: `i${String(i).padStart(5, '0')}`, n: i % 7, tag: i % 3 ? 'a' : null }));

async function collect(it: AsyncIterable<any>) {
  const out: any[] = [];
  for await (const r of it) out.push(r);
  return out;
}

describe('stream — duckdb pages by key', () => {
  let live: Awaited<ReturnType<typeof openDuckdb>>;
  beforeAll(async () => {
    live = await openDuckdb(schema);
    await live.db.item.createMany({ data: rows });
  });
  afterAll(() => live.close());

  it('yields every row once, in order, with no OFFSET', async () => {
    live.log.length = 0;
    const got = await collect(live.db.item.findManyStream({ orderBy: { id: 'asc' } }));
    expect(got.map((r) => r.id)).toEqual(rows.map((r) => r.id));
    const selects = live.log.filter((s) => /^SELECT/.test(s));
    expect(selects).toHaveLength(3);
    expect(selects.some((s) => /OFFSET/.test(s))).toBe(false);
  });

  it('resumes a compound and descending order correctly, and honours take', async () => {
    const expected = [...rows].sort((a, b) => b.n - a.n || a.id.localeCompare(b.id)).map((r) => r.id);
    const got = await collect(live.db.item.findManyStream({ orderBy: [{ n: 'desc' }, { id: 'asc' }], chunkSize: 300 } as any));
    expect(got.map((r) => r.id)).toEqual(expected);
    const first = await collect(live.db.item.findManyStream({ orderBy: [{ n: 'desc' }], chunkSize: 300, take: 650 } as any));
    expect(first.map((r) => r.id)).toEqual(expected.slice(0, 650));
  });

  it('survives other queries on the connection mid-stream', async () => {
    let seen = 0;
    for await (const _r of live.db.item.findManyStream({ orderBy: { id: 'asc' }, chunkSize: 500 })) {
      if (++seen % 400 === 0) await live.db.item.count();
    }
    expect(seen).toBe(rows.length);
  });

  it('falls back to OFFSET for an order on a nullable column', async () => {
    const got = await collect(live.db.item.findManyStream({ where: { n: 1 }, orderBy: { tag: 'asc' } }));
    expect(got).toHaveLength(rows.filter((r) => r.n === 1).length);
  });
});

describe('stream — duckdb with the instance: a native stream on its own connection', () => {
  let live: Awaited<ReturnType<typeof openDuckdb>>;
  beforeAll(async () => {
    live = await openDuckdb(schema, { instance: true });
    await live.db.item.createMany({ data: rows });
  });
  afterAll(() => live.close());

  it('one statement, every row, in order, nothing on the main connection', async () => {
    live.log.length = 0;
    const got = await collect(live.db.item.findManyStream({ orderBy: { id: 'asc' } }));
    expect(got.map((r) => r.id)).toEqual(rows.map((r) => r.id));
    expect(live.log.filter((s) => /^SELECT/.test(s))).toHaveLength(0);
  });

  it('honours a compound order and take', async () => {
    const expected = [...rows].sort((a, b) => b.n - a.n || a.id.localeCompare(b.id)).map((r) => r.id);
    const first = await collect(live.db.item.findManyStream({ orderBy: [{ n: 'desc' }, { id: 'asc' }], take: 650 } as any));
    expect(first.map((r) => r.id)).toEqual(expected.slice(0, 650));
  });

  it('survives queries and writes on the main connection mid-stream', async () => {
    let seen = 0;
    for await (const _r of live.db.item.findManyStream({ orderBy: { id: 'asc' } })) {
      if (++seen % 400 === 0) { await live.db.item.count(); await live.db.item.updateMany({ where: { n: 1 }, data: { tag: 'b' } }); }
    }
    expect(seen).toBe(rows.length);
  });

  it('inside a transaction it pages on the transaction, and sees its writes', async () => {
    await live.db.$transaction(async (tx: any) => {
      await tx.item.create({ data: { id: 'zz', n: 99 } });
      const inTx = await collect(tx.item.findManyStream({ where: { n: 99 } }));
      expect(inTx.map((r) => r.id)).toEqual(['zz']);
      throw Object.assign(new Error('rollback'), { rollback: true });
    }).catch((e: any) => { if (!e.rollback) throw e; });
  });
});

describe('stream — sqlite batches', () => {
  it('streams all rows, honours where and take, and sees its transaction', async () => {
    const live = await openSqlite(schema);
    await live.db.item.createMany({ data: rows });
    expect((await collect(live.db.item.findManyStream({ orderBy: { id: 'asc' } }))).length).toBe(2500);
    expect((await collect(live.db.item.findManyStream({ where: { n: 3 }, take: 10, orderBy: { id: 'asc' } } as any))).map((r) => r.id))
      .toEqual(rows.filter((r) => r.n === 3).slice(0, 10).map((r) => r.id));
    await live.db.$transaction(async (tx: any) => {
      await tx.item.create({ data: { id: 'zz', n: 99 } });
      const inTx = await collect(tx.item.findManyStream({ where: { n: 99 } }));
      expect(inTx.map((r) => r.id)).toEqual(['zz']);
    });
    await live.close();
  });
});

describe('stream — postgres cursor', () => {
  function fakePool(total: number) {
    const log: string[] = [];
    let served = 0;
    const query = async (sql: string) => {
      log.push(sql);
      const m = /^FETCH (\d+)/.exec(sql);
      if (m) {
        const n = Math.min(Number(m[1]), total - served);
        const out = Array.from({ length: n }, (_, k) => ({ id: `r${served + k}`, n: 1 }));
        served += n;
        return { rows: out, rowCount: n };
      }
      return { rows: [], rowCount: 0 };
    };
    return { log, pool: { query, connect: async () => ({ query, release() {} }), on() {} } };
  }

  it('fetches 1000 rows a round trip', async () => {
    const { log, pool } = fakePool(2500);
    const db: any = await createDb({ schema, driver: pgDriver(pool) } as never);
    log.length = 0;
    const got = await collect(db.item.findManyStream({ orderBy: { id: 'asc' } }));
    expect(got).toHaveLength(2500);
    expect(log.filter((s) => /^FETCH 1000/.test(s))).toHaveLength(3);
    expect(log[0]).toBe('BEGIN');
  });

  it('runs on the transaction\'s own connection inside $transaction', async () => {
    const { log, pool } = fakePool(10);
    const db: any = await createDb({ schema, driver: pgDriver(pool) } as never);
    await db.$transaction(async (tx: any) => {
      log.length = 0;
      await collect(tx.item.findManyStream({ chunkSize: 4 }));
    });
    expect(log.filter((s) => s === 'BEGIN')).toHaveLength(0);
    expect(log.filter((s) => /^FETCH 4/.test(s))).toHaveLength(3);
  });
});
