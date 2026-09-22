import { f, model } from '../schema/core';
import type { ModelDef } from '../schema/types';
import { buildGroupBy, buildOrderBy, buildSelect } from '../ir/build';
import { compileGroupBy, compileSelect } from '../adapters/postgres/compile-from-ir';
import { compileGroupBy as mongoGroupBy } from '../adapters/mongo/compile-from-ir';

// `orderBy: { _sum: { total: 'desc' } }` had no branch in buildOrderBy, so the
// entry was dropped. A secondary column sort survived, which is what made it
// hard to see: "top 10 customers by lifetime value" returned an arbitrary ten
// rows in a stable-looking order.

const Order: ModelDef<never> = model('orders', {
  id: f.id(),
  customer_id: f.string(),
  total: f.int(),
}) as never as ModelDef<never>;

const group = (args: unknown) => buildGroupBy('order', Order, args as never);

describe('buildOrderBy on an aggregate bucket', () => {
  test('the entry survives, marked as an aggregate', () => {
    expect(buildOrderBy({ _sum: { total: 'desc' } })).toEqual([
      { field: 'total', direction: 'desc', agg: { bucket: '_sum', field: 'total' } },
    ]);
  });

  test('every bucket is recognised', () => {
    for (const b of ['_count', '_avg', '_sum', '_min', '_max']) {
      const out = buildOrderBy({ [b]: { total: 'asc' } });
      expect(out).toHaveLength(1);
      expect(out![0].agg!.bucket).toBe(b);
    }
  });

  test('it mixes with a plain column sort, in the order written', () => {
    const out = buildOrderBy([{ _sum: { total: 'desc' } }, { customer_id: 'asc' }]);
    expect(out).toHaveLength(2);
    expect(out![0].agg).toBeDefined();
    expect(out![1].agg).toBeUndefined();
  });

  test('_count on _all is carried through', () => {
    expect(buildOrderBy({ _count: { _all: 'desc' } })![0].agg)
      .toEqual({ bucket: '_count', field: '_all' });
  });

  test('a plain column sort is unchanged', () => {
    expect(buildOrderBy({ customer_id: 'asc' })).toEqual([
      { field: 'customer_id', direction: 'asc' },
    ]);
  });
});

describe('SQL groupBy', () => {
  test('orders by the aggregate expression', () => {
    const sql = (compileGroupBy(group({
      by: ['customer_id'], _sum: { total: true },
      orderBy: [{ _sum: { total: 'desc' } }], take: 10,
    }), Order) as { sql: string }).sql;
    expect(sql).toContain('ORDER BY SUM("orders"."total") DESC');
  });

  test('the expression, not the SELECT alias — so ordering works on a bucket that was not selected', () => {
    const sql = (compileGroupBy(group({
      by: ['customer_id'], _count: { _all: true },
      orderBy: [{ _sum: { total: 'desc' } }],
    }), Order) as { sql: string }).sql;
    expect(sql).toContain('ORDER BY SUM("orders"."total") DESC');
    expect(sql).not.toContain('ORDER BY "__agg_sum_total"');
  });

  test('COUNT(*) for _all', () => {
    expect((compileGroupBy(group({
      by: ['customer_id'], _count: { _all: true }, orderBy: [{ _count: { _all: 'desc' } }],
    }), Order) as { sql: string }).sql).toContain('ORDER BY COUNT(*) DESC');
  });

  test('a mixed sort keeps both keys in order', () => {
    expect((compileGroupBy(group({
      by: ['customer_id'], _sum: { total: true },
      orderBy: [{ _sum: { total: 'desc' } }, { customer_id: 'asc' }],
    }), Order) as { sql: string }).sql)
      .toContain('ORDER BY SUM("orders"."total") DESC, "orders"."customer_id" ASC');
  });
});

describe('Mongo groupBy', () => {
  test('sorts on the $group output alias', () => {
    const art = mongoGroupBy(group({
      by: ['customer_id'], _sum: { total: true }, orderBy: [{ _sum: { total: 'desc' } }],
    }), Order) as { args: { pipeline: Record<string, unknown>[] } };
    const sort = art.args.pipeline.find((st) => '$sort' in st) as { $sort: Record<string, number> };
    expect(sort.$sort).toEqual({ __agg_sum_total: -1 });
  });

  test('a grouped column still sorts under _id', () => {
    const art = mongoGroupBy(group({
      by: ['customer_id'], _sum: { total: true }, orderBy: [{ customer_id: 'asc' }],
    }), Order) as { args: { pipeline: Record<string, unknown>[] } };
    const sort = art.args.pipeline.find((st) => '$sort' in st) as { $sort: Record<string, number> };
    expect(sort.$sort).toEqual({ '_id.customer_id': 1 });
  });
});

describe('a plain select has no aggregates to sort by', () => {
  test('an aggregate entry is dropped rather than emitted as a column', () => {
    // `"orders"."_sum"` is not a column; emitting it would be a SQL error.
    const sql = (compileSelect(
      buildSelect('order', Order, { orderBy: [{ _sum: { total: 'desc' } }] } as never, 'many'),
      Order,
    ) as { sql: string }).sql;
    expect(sql).not.toContain('_sum');
    expect(sql).not.toContain('ORDER BY');
  });

  test('a plain column sort alongside it still applies', () => {
    const sql = (compileSelect(
      buildSelect('order', Order, {
        orderBy: [{ _sum: { total: 'desc' } }, { customer_id: 'asc' }],
      } as never, 'many'),
      Order,
    ) as { sql: string }).sql;
    expect(sql).toContain('ORDER BY "orders"."customer_id" ASC');
  });
});

describe('a bucket takes a field map, not a boolean', () => {
  test('_count: true is refused, naming the right shape', () => {
    // It contributed no SELECT column: silently dropped alongside another
    // bucket, and `SELECT  FROM "orders"` — a syntax error — on its own.
    expect(() => group({ by: [], _count: true })).toThrow(/_count takes a map of fields/);
    expect(() => group({ by: [], _count: true })).toThrow(/_count: \{ _all: true \}/);
  });

  test('every bucket is guarded', () => {
    for (const b of ['_avg', '_sum', '_min', '_max']) {
      expect(() => group({ by: [], [b]: true })).toThrow(new RegExp(`${b} takes a map of fields`));
    }
  });

  test('the correct shapes still pass', () => {
    expect(() => group({ by: ['customer_id'], _count: { _all: true } })).not.toThrow();
    expect(() => group({ by: ['customer_id'], _sum: { total: true } })).not.toThrow();
    expect(() => group({ by: ['customer_id'] })).not.toThrow();
  });
});
