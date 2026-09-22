import { f, model, setActiveSchema } from '../index';
import { createDb } from '../factory';
import { buildSchemaDDL } from '../adapters/sqlite/ddl';
import { applyMigration } from '../adapters/sqlite/migrate';

// `aggregate({ _sum, _count, ... })` — aggregates over every matching row with
// no grouping key. It did not exist before 2.18.0: the only `aggregate` was the
// Mongo pipeline escape hatch, so this shape threw "aggregate() needs a
// pipeline" — while being the form used throughout the documentation.

const Order = model('orders', { id: f.id(), status: f.string(), total: f.int() });
const sch = { order: Order } as never;

let db: any;

beforeAll(async () => {
  setActiveSchema(sch);
  db = await createDb({ url: 'sqlite::memory:', schema: sch });
  await applyMigration((db.adapter as any).db, buildSchemaDDL(sch as never));
  let i = 0;
  for (const total of [10, 20, 30]) {
    await db.order.create({ data: { id: `o${i++}`, status: 'paid', total } });
  }
  await db.order.create({ data: { id: 'draft', status: 'draft', total: 999 } });
});

afterAll(async () => { await db?.$disconnect(); });

describe('aggregate() over a whole table', () => {
  test('every bucket, honouring the where', async () => {
    const r = await db.order.aggregate({
      where: { status: 'paid' },
      _count: { _all: true },
      _sum: { total: true },
      _avg: { total: true },
      _min: { total: true },
      _max: { total: true },
    });
    expect(r._count._all).toBe(3);
    expect(r._sum.total).toBe(60);
    expect(r._avg.total).toBe(20);
    expect(r._min.total).toBe(10);
    expect(r._max.total).toBe(30);
  });

  test('the where really filters — the 999 draft is excluded', async () => {
    const r = await db.order.aggregate({ where: { status: 'paid' }, _max: { total: true } });
    expect(r._max.total).toBe(30);
  });

  test('no where means the whole table', async () => {
    const r = await db.order.aggregate({ _count: { _all: true }, _sum: { total: true } });
    expect(r._count._all).toBe(4);
    expect(r._sum.total).toBe(1059);
  });

  test('an object comes back even when nothing matched, so destructuring is safe', async () => {
    // groupBy returns [] for zero rows. Handing that straight back would make
    // `const { _sum } = await aggregate(...)` throw on the empty case only —
    // the shape of bug that reaches production.
    const r = await db.order.aggregate({
      where: { status: 'no-such-status' },
      _count: { _all: true },
      _sum: { total: true },
    });
    expect(r).not.toBeUndefined();
    expect(r._count._all).toBe(0);
    expect(r._sum.total).toBeNull();
  });

  test('the pipeline form is still recognised and not swallowed', async () => {
    // Both shapes share the method name; a pipeline must keep routing to the
    // Mongo escape hatch rather than being read as an aggregate request.
    await expect(db.order.aggregate([{ $match: {} }])).rejects.toBeDefined();
  });

  test('neither shape means the error still explains what is wanted', async () => {
    await expect(db.order.aggregate({ nonsense: true } as never)).rejects.toThrow(/needs a pipeline/);
  });
});
