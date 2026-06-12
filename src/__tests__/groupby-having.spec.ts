import { f, model } from '../schema/core';
import type { ModelDef } from '../schema/types';
import { buildGroupBy } from '../ir/build';

const Order = model('orders', {
  id: f.id(),
  status: f.string(),
  total: f.int().default(0),
}) as unknown as ModelDef<any>;

const having = (h: any) =>
  buildGroupBy('order', Order, { by: ['status'], _sum: { total: true }, having: h } as any).having;

describe('buildGroupBy — having shape normalization', () => {
  test('field-first (Prisma shape) → bucket-first', () => {
    expect(having({ total: { _sum: { gte: 120 } } })).toEqual({
      _sum: { total: { gte: 120 } },
    });
  });

  test('bucket-first passes through unchanged', () => {
    expect(having({ _sum: { total: { gte: 120 } } })).toEqual({
      _sum: { total: { gte: 120 } },
    });
  });

  test('multiple buckets, field-first', () => {
    expect(having({ total: { _sum: { gte: 120 }, _avg: { lt: 500 } } })).toEqual({
      _sum: { total: { gte: 120 } },
      _avg: { total: { lt: 500 } },
    });
  });

  test('multiple fields under one bucket merge correctly (bucket-first)', () => {
    expect(having({ _sum: { total: { gte: 1 } }, _count: { _all: { gt: 2 } } })).toEqual({
      _sum: { total: { gte: 1 } },
      _count: { _all: { gt: 2 } },
    });
  });

  test('empty / missing having stays empty', () => {
    expect(having(undefined)).toBeUndefined();
    expect(having({})).toEqual({});
  });
});
