import { ObjectId } from 'mongodb';
import { f, model } from '../schema/core';
import type { ModelDef } from '../schema/types';
import { buildUpdate } from '../ir/build';
import { compileUpdate } from '../adapters/mongo/compile-from-ir';

// Wave 5e — ported from the retired legacy `translateUpdateData` tests.
// The IR path (buildUpdate → compileUpdate) is the successor; this asserts the
// Mongo update artifact ($set / $inc / $mul + id→_id remap) it produces.

const M = model('m', {
  id: f.id(),
  name: f.string(),
  count: f.int().default(0),
}) as unknown as ModelDef<any>;

function update(data: any): any {
  const node = buildUpdate('m', M, { where: { id: 'x' }, data, many: false });
  return (compileUpdate(node, M) as any).args.update;
}

describe('mongo compileUpdate (IR successor to translateUpdateData)', () => {
  test('plain assignment → $set', () => {
    expect(update({ name: 'x' }).$set.name).toBe('x');
  });

  test('increment / decrement → $inc', () => {
    expect(update({ count: { increment: 3 } }).$inc).toEqual({ count: 3 });
    expect(update({ count: { decrement: 2 } }).$inc).toEqual({ count: -2 });
  });

  test('multiply / divide → $mul', () => {
    expect(update({ count: { multiply: 4 } }).$mul.count).toBe(4);
    expect(update({ count: { divide: 5 } }).$mul.count).toBe(1 / 5);
  });

  test('explicit set wrapper → $set', () => {
    expect(update({ count: { set: 9 } }).$set.count).toBe(9);
  });

  test('renames `id` → `_id` key in the $set payload (value coercion is coerceInbound\'s job)', () => {
    const oid = new ObjectId();
    const u = update({ id: oid.toString(), name: 'x' });
    expect(u.$set.id).toBeUndefined();
    expect(u.$set._id).toBe(oid.toString());   // key remapped at compile; ObjectId coercion happens in coerceInbound
  });
});
