import { ObjectId } from 'mongodb';
import {
  applyCreateDefaults,
  applyUpdateTimestamps,
  coerceCreatePayload,
  coerceExtendedJSON,
  coerceFieldValue,
  decodeRow,
} from '../adapters/mongo/coerce';
import { f, model, rel } from '../schema/core';
import { ModelDef } from '../schema/types';

const TestModel = model('test_coll', {
  id: f.id(),
  email: f.string().unique(),
  count: f.int().default(0),
  active: f.bool().default(true),
  created_at: f.dateTime().default('now'),
  updated_at: f.dateTime().default('now').updatedAt(),
  parent_id: f.objectId().optional(),
}).relate(() => ({
  parent: rel.one('test_coll', { on: 'parent_id', refs: 'id' }),
})) as unknown as ModelDef<any>;

describe('coerceFieldValue', () => {
  test('coerces string id → ObjectId', () => {
    const id = new ObjectId();
    const out = coerceFieldValue(TestModel.fields.id, id.toString());
    expect(out).toBeInstanceOf(ObjectId);
    expect(out.toString()).toBe(id.toString());
  });

  test('passes through invalid ObjectId strings unchanged', () => {
    const out = coerceFieldValue(TestModel.fields.id, 'not-an-objectid');
    expect(out).toBe('not-an-objectid');
  });

  test('coerces ISO date string → Date', () => {
    const iso = '2026-05-01T10:00:00Z';
    const out = coerceFieldValue(TestModel.fields.created_at, iso);
    expect(out).toBeInstanceOf(Date);
    expect((out as Date).toISOString()).toBe(new Date(iso).toISOString());
  });

  test('walks operator objects ($in, $gte) without losing field context', () => {
    const a = new ObjectId(), b = new ObjectId();
    const out = coerceFieldValue(TestModel.fields.id, {
      $in: [a.toString(), b.toString()],
    });
    expect(out.$in).toHaveLength(2);
    expect(out.$in[0]).toBeInstanceOf(ObjectId);
    expect(out.$in[1]).toBeInstanceOf(ObjectId);
  });

  test('passes through non-coercible primitives', () => {
    expect(coerceFieldValue(TestModel.fields.count, 42)).toBe(42);
    expect(coerceFieldValue(TestModel.fields.active, true)).toBe(true);
    expect(coerceFieldValue(TestModel.fields.email, 'foo@bar')).toBe('foo@bar');
  });

  test('null/undefined pass through', () => {
    expect(coerceFieldValue(TestModel.fields.id, null)).toBe(null);
    expect(coerceFieldValue(TestModel.fields.email, undefined)).toBeUndefined();
  });
});

describe('applyCreateDefaults', () => {
  test('fills `now` defaults with a fresh Date', () => {
    const out = applyCreateDefaults(TestModel, { email: 'x@y' });
    expect(out.created_at).toBeInstanceOf(Date);
    expect(out.updated_at).toBeInstanceOf(Date);
  });

  test('fills `autoId` default with a fresh ObjectId', () => {
    const out = applyCreateDefaults(TestModel, { email: 'x@y' });
    expect(out.id).toBeInstanceOf(ObjectId);
  });

  test('fills literal default values', () => {
    const out = applyCreateDefaults(TestModel, { email: 'x@y' });
    expect(out.count).toBe(0);
    expect(out.active).toBe(true);
  });

  test('respects user-supplied values over defaults', () => {
    const out = applyCreateDefaults(TestModel, { email: 'x@y', count: 99, active: false });
    expect(out.count).toBe(99);
    expect(out.active).toBe(false);
  });

  test('leaves optional fields unset (no null/undefined inserted)', () => {
    const out = applyCreateDefaults(TestModel, { email: 'x@y' });
    expect('parent_id' in out).toBe(false);
  });
});

describe('applyUpdateTimestamps', () => {
  test('sets @updatedAt fields when not user-supplied', () => {
    const out = applyUpdateTimestamps(TestModel, { count: 5 });
    expect(out.updated_at).toBeInstanceOf(Date);
  });

  test('preserves user-supplied updated_at', () => {
    const t = new Date('2020-01-01');
    const out = applyUpdateTimestamps(TestModel, { count: 5, updated_at: t });
    expect(out.updated_at).toBe(t);
  });
});

describe('coerceCreatePayload', () => {
  test('renames `id` → `_id`', () => {
    const out = coerceCreatePayload(TestModel, { id: new ObjectId().toString(), email: 'x@y' });
    expect(out._id).toBeInstanceOf(ObjectId);
    expect(out.id).toBeUndefined();
  });

  test('coerces nested ObjectId strings + applies defaults', () => {
    const parentId = new ObjectId();
    const out = coerceCreatePayload(TestModel, {
      email: 'x@y',
      parent_id: parentId.toString(),
    });
    expect(out._id).toBeInstanceOf(ObjectId);
    expect(out.parent_id).toBeInstanceOf(ObjectId);
    expect(out.parent_id.toString()).toBe(parentId.toString());
    expect(out.created_at).toBeInstanceOf(Date);
    expect(out.count).toBe(0);
  });
});

describe('coerceExtendedJSON (aggregation pipelines)', () => {
  test('{ $oid: <hex> } → ObjectId', () => {
    const id = new ObjectId();
    const out = coerceExtendedJSON({ $oid: id.toString() });
    expect(out).toBeInstanceOf(ObjectId);
    expect(out.toString()).toBe(id.toString());
  });

  test('{ $date: <iso> } → Date', () => {
    const out: any = coerceExtendedJSON({ $date: '2026-05-01T10:00:00Z' });
    expect(out).toBeInstanceOf(Date);
    expect((out as Date).toISOString()).toBe('2026-05-01T10:00:00.000Z');
  });

  test('walks nested aggregation pipeline', () => {
    const id = new ObjectId();
    const pipeline = [
      { $match: { business_id: { $oid: id.toString() } } },
      { $project: { created_at: 1 } },
    ];
    const out = coerceExtendedJSON(pipeline);
    expect((out[0].$match as any).business_id).toBeInstanceOf(ObjectId);
    expect(out[1].$project).toEqual({ created_at: 1 });
  });

  test('preserves Mongo aggregation operators ($eq, $expr, $or)', () => {
    const id = new ObjectId();
    const pipeline = [
      {
        $match: {
          $or: [
            { creator_profile_id: { $oid: id.toString() } },
            { business_id: null },
          ],
        },
      },
      { $expr: { $eq: ['$user_id', { $oid: id.toString() }] } },
    ];
    const out = coerceExtendedJSON(pipeline) as any[];
    expect(out[0].$match.$or[0].creator_profile_id).toBeInstanceOf(ObjectId);
    expect(out[0].$match.$or[1].business_id).toBeNull();
    expect(out[1].$expr.$eq[0]).toBe('$user_id');
    expect(out[1].$expr.$eq[1]).toBeInstanceOf(ObjectId);
  });

  test('passes through ObjectId / Date / primitives unchanged', () => {
    const id = new ObjectId();
    const d = new Date();
    expect(coerceExtendedJSON(id)).toBe(id);
    expect(coerceExtendedJSON(d)).toBe(d);
    expect(coerceExtendedJSON('foo')).toBe('foo');
    expect(coerceExtendedJSON(42)).toBe(42);
    expect(coerceExtendedJSON(null)).toBe(null);
  });

  test('invalid $oid string passes through as-is (does not throw)', () => {
    const out = coerceExtendedJSON({ $oid: 'not-valid' });
    expect(out).toEqual({ $oid: 'not-valid' });
  });
});

describe('decodeRow', () => {
  test('renames `_id` → `id` and stringifies ObjectIds', () => {
    const _id = new ObjectId();
    const parent_id = new ObjectId();
    const out = decodeRow(TestModel, { _id, email: 'x@y', parent_id, count: 3, active: true });
    expect(out.id).toBe(_id.toString());
    expect(out._id).toBeUndefined();
    expect(out.parent_id).toBe(parent_id.toString());
    expect(typeof out.parent_id).toBe('string');
    expect(out.email).toBe('x@y');
    expect(out.count).toBe(3);
  });

  test('null doc returns null', () => {
    expect(decodeRow(TestModel, null)).toBeNull();
  });

  test('preserves Date fields as Date', () => {
    const d = new Date();
    const out = decodeRow(TestModel, { _id: new ObjectId(), created_at: d });
    expect(out.created_at).toBe(d);
  });
});
