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
