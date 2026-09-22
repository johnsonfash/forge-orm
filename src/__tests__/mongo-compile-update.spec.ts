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

  test('multiply → $mul', () => {
    expect(update({ count: { multiply: 4 } }).$mul.count).toBe(4);
  });

  test('divide → an aggregation-pipeline $divide, not $mul by a reciprocal', () => {
    // Mongo has no `$div` update operator. Rewriting `divide: 5` as
    // `$mul: 0.2` is exact here but not for `divide: 3`, and it also turns an
    // int column into a double. A pipeline update has a real $divide.
    const u = update({ count: { divide: 3 } });
    expect(Array.isArray(u)).toBe(true);
    expect(u[0].$set.count).toEqual({ $divide: [{ $ifNull: ['$count', 0] }, 3] });
    expect(JSON.stringify(u)).not.toContain('$mul');
  });

  test('a pipeline update carries the other ops across unchanged', () => {
    const u = update({ name: 'x', count: { divide: 2 } });
    // A literal must be wrapped: inside a pipeline a bare '$...' string is a
    // field reference, so an unwrapped value would read a column instead.
    expect(u[0].$set.name).toEqual({ $literal: 'x' });
    expect(u[0].$set.count).toEqual({ $divide: [{ $ifNull: ['$count', 0] }, 2] });
  });

  test('a "$"-prefixed string survives a pipeline update', () => {
    // The concrete failure $literal prevents: storing the value of a field
    // named "5 off" instead of the text "$5 off".
    const u = update({ name: '$5 off', count: { divide: 2 } });
    expect(u[0].$set.name).toEqual({ $literal: '$5 off' });
  });

  test('divide + upsert is refused rather than silently half-applied', () => {
    const node = buildUpdate('m', M, {
      where: { id: 'x' },
      data: { count: { divide: 2 } },
      many: false,
      upsertCreate: { count: 100 },
    } as any);
    expect(() => compileUpdate(node, M)).toThrow(/no \$setOnInsert/);
  });

  test('explicit set wrapper → $set', () => {
    expect(update({ count: { set: 9 } }).$set.count).toBe(9);
  });

  test('renames `id` → `_id` AND coerces the value to an ObjectId', () => {
    // This test used to assert the value stayed a string, on the belief that
    // `coerceInbound` would handle it later. It never ran for update — only
    // for create, createMany and upsert.create — so an id or a date written
    // through `update` was stored with the wrong BSON type, and `where`
    // (which DOES coerce) then failed to match those rows for good.
    const oid = new ObjectId();
    const u = update({ id: oid.toString(), name: 'x' });
    expect(u.$set.id).toBeUndefined();
    expect(u.$set._id).toBeInstanceOf(ObjectId);
    expect(u.$set._id.toString()).toBe(oid.toString());
  });

  test('an update writes the same BSON types a create would', () => {
    const oid = new ObjectId();
    const N = model('n', {
      id: f.id(),
      owner_id: f.objectId(),
      due_at: f.dateTime(),
    }) as unknown as ModelDef<any>;
    const node = buildUpdate('n', N, {
      where: { id: 'x' },
      data: { owner_id: oid.toString(), due_at: '2026-03-04T05:06:07.000Z' },
      many: false,
    } as any);
    const u = (compileUpdate(node, N) as any).args.update;
    expect(u.$set.owner_id).toBeInstanceOf(ObjectId);
    expect(u.$set.due_at).toBeInstanceOf(Date);
    expect((u.$set.due_at as Date).toISOString()).toBe('2026-03-04T05:06:07.000Z');
  });

  test('atomic numeric ops are left alone — they are numbers, not field values', () => {
    const u = update({ count: { increment: 3 } });
    expect(u.$inc).toEqual({ count: 3 });
  });
});

// Regression: upsert must not emit the same path in $setOnInsert AND an update
// operator — Mongo rejects that ("would create a conflict at 'x'"). Fields the
// update writes are dropped from $setOnInsert; on insert the operator sets them.
describe('mongo compileUpdate — upsert $setOnInsert / update-operator dedup', () => {
  function upsert(create: any, data: any): any {
    const node = buildUpdate('m', M, { where: { id: 'x' }, data, many: false, upsertCreate: create });
    return (compileUpdate(node, M) as any).args.update;
  }

  test('field incremented in update is dropped from $setOnInsert (counter pattern)', () => {
    const u = upsert({ count: 1, name: 'seed' }, { count: { increment: 1 } });
    expect(u.$inc).toEqual({ count: 1 });
    expect(u.$setOnInsert.count).toBeUndefined();   // would conflict with $inc
    expect(u.$setOnInsert.name).toBe('seed');       // insert-only, kept
  });

  test('field $set in update is dropped from $setOnInsert', () => {
    const u = upsert({ name: 'a', count: 5 }, { name: 'b' });
    expect(u.$set.name).toBe('b');
    expect(u.$setOnInsert.name).toBeUndefined();
    expect(u.$setOnInsert.count).toBe(5);
  });

  test('$setOnInsert omitted entirely when every create field overlaps the update', () => {
    const u = upsert({ name: 'a' }, { name: 'b' });
    expect(u.$setOnInsert).toBeUndefined();
  });

  test('multiply overlap dropped from $setOnInsert', () => {
    const u = upsert({ count: 5, name: 'x' }, { count: { multiply: 2 } });
    expect(u.$mul).toEqual({ count: 2 });
    expect(u.$setOnInsert.count).toBeUndefined();
    expect(u.$setOnInsert.name).toBe('x');
  });

  test('$unset overlap dropped from $setOnInsert', () => {
    const u = upsert({ name: 'x', count: 1 }, { name: { unset: true } } as any);
    expect(u.$unset).toEqual({ name: '' });
    expect(u.$setOnInsert.name).toBeUndefined();
    expect(u.$setOnInsert.count).toBe(1);
  });

  test('partial overlap keeps only the non-overlapping create fields', () => {
    const u = upsert({ name: 'a', count: 9 }, { name: 'b' });
    expect(u.$set.name).toBe('b');
    expect(u.$setOnInsert).toEqual({ count: 9 });
  });

  test('no overlap leaves create ($setOnInsert) and update intact', () => {
    const u = upsert({ name: 'seed' }, { count: { increment: 1 } });
    expect(u.$inc).toEqual({ count: 1 });
    expect(u.$setOnInsert).toEqual({ name: 'seed' });
  });

  test('prefix conflict (`meta` vs `meta.x`) drops the parent from $setOnInsert', () => {
    // Hand-built node: a dotted $set path whose parent is a $setOnInsert key.
    const node: any = { model: 'm', where: { id: 'x' }, set: { 'meta.x': 1 }, upsertCreate: { meta: { a: 1 } }, many: false };
    const u = (compileUpdate(node, M) as any).args.update;
    expect(u.$set['meta.x']).toBe(1);
    expect(u.$setOnInsert).toBeUndefined(); // `meta` removed as a prefix conflict
  });
});
