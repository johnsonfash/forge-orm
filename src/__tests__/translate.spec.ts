import { ObjectId } from 'mongodb';
import { f, model } from '../schema/core';
import { ModelDef } from '../schema/types';
import { translateUpdateData } from '../adapters/mongo/translate/data';
import { translateOrderBy } from '../adapters/mongo/translate/orderby';
import { translateWhere } from '../adapters/mongo/translate/where';

const M = model('m', {
  id: f.id(),
  name: f.string(),
  count: f.int().default(0),
  active: f.bool().default(true),
  ref_id: f.objectId().optional(),
  created_at: f.dateTime().default('now'),
  updated_at: f.dateTime().default('now').updatedAt(),
}) as unknown as ModelDef<any>;

describe('translateWhere', () => {
  test('bare equality remaps id → _id and coerces ObjectId', () => {
    const oid = new ObjectId();
    const f = translateWhere(M, { id: oid.toString() });
    expect(f._id).toBeInstanceOf(ObjectId);
    expect(f.id).toBeUndefined();
  });

  test('`equals` operator', () => {
    const f = translateWhere(M, { count: { equals: 5 } });
    expect(f.count).toEqual({ $eq: 5 });
  });

  test('`not` operator', () => {
    const f = translateWhere(M, { count: { not: 5 } });
    expect(f.count).toEqual({ $ne: 5 });
  });

  test('`in` / `notIn` arrays', () => {
    const f = translateWhere(M, { count: { in: [1, 2, 3] } });
    expect(f.count).toEqual({ $in: [1, 2, 3] });
    const g = translateWhere(M, { count: { notIn: [1, 2] } });
    expect(g.count).toEqual({ $nin: [1, 2] });
  });

  test('`lt`/`lte`/`gt`/`gte`', () => {
    const f = translateWhere(M, { count: { gte: 5, lt: 10 } });
    expect(f.count).toEqual({ $gte: 5, $lt: 10 });
  });

  test('string `contains` translates to escaped $regex', () => {
    const f = translateWhere(M, { name: { contains: 'a.b*c' } });
    expect(f.name.$regex).toBe('a\\.b\\*c');
    expect(f.name.$options).toBeUndefined();
  });

  test('`mode: insensitive` adds $options i', () => {
    const f = translateWhere(M, { name: { contains: 'foo', mode: 'insensitive' } });
    expect(f.name.$options).toBe('i');
  });

  test('`startsWith`/`endsWith` anchor properly', () => {
    expect(translateWhere(M, { name: { startsWith: 'pre' } }).name.$regex).toBe('^pre');
    expect(translateWhere(M, { name: { endsWith: 'suf' } }).name.$regex).toBe('suf$');
  });

  test('AND / OR / NOT logical ops', () => {
    const f = translateWhere(M, {
      OR: [{ count: 1 }, { count: 2 }],
    });
    expect(f.$or).toHaveLength(2);
    expect(f.$or[0].count).toBe(1);

    const g = translateWhere(M, {
      AND: [{ count: { gte: 1 } }, { active: true }],
    });
    expect(g.$and).toHaveLength(2);
    expect(g.$and[0]).toEqual({ count: { $gte: 1 } });
    expect(g.$and[1]).toEqual({ active: true });

    const h = translateWhere(M, {
      NOT: [{ count: 5 }],
    });
    expect(h.$nor).toHaveLength(1);
  });

  test('coerces ObjectId in $in operator on id field', () => {
    const a = new ObjectId(), b = new ObjectId();
    const f = translateWhere(M, { id: { in: [a.toString(), b.toString()] } });
    expect(f._id.$in[0]).toBeInstanceOf(ObjectId);
    expect(f._id.$in[1]).toBeInstanceOf(ObjectId);
  });
});

describe('translateWhere — embed-list filters (some / every / none)', () => {
  // Mini schema with an embedded list to exercise some/every/none translation
  // — same shape as Notification.recipients in the real schema.
  const RecipientFields = {
    user_profile_id: { kind: 'objectId', optional: false, unique: false, updatedAt: false },
    is_read: { kind: 'bool', optional: false, unique: false, updatedAt: false },
    is_actor: { kind: 'bool', optional: false, unique: false, updatedAt: false },
  };
  const NotificationModel: any = {
    collection: 'notifications',
    fields: {
      id: { kind: 'id', optional: false, unique: true, updatedAt: false },
      business_id: { kind: 'objectId', optional: false, unique: false, updatedAt: false },
      recipients: {
        kind: 'embedMany',
        optional: false,
        unique: false,
        updatedAt: false,
        embedOf: () => ({ embedName: 'Recipient', fields: RecipientFields }),
      },
    },
    relations: () => ({}),
    indexes: [],
    uniques: [],
  };

  test('`some` translates to $elemMatch with ObjectId-coerced fields', () => {
    const sub = new ObjectId().toString();
    const f = translateWhere(NotificationModel, {
      recipients: { some: { user_profile_id: sub, is_read: false, is_actor: false } },
    });
    expect(f.recipients).toBeDefined();
    expect(f.recipients.$elemMatch).toBeDefined();
    expect(f.recipients.$elemMatch.user_profile_id).toBeInstanceOf(ObjectId);
    expect(f.recipients.$elemMatch.is_read).toBe(false);
    expect(f.recipients.$elemMatch.is_actor).toBe(false);
  });

  test('`none` translates to $not + $elemMatch', () => {
    const sub = new ObjectId().toString();
    const f = translateWhere(NotificationModel, {
      recipients: { none: { user_profile_id: sub } },
    });
    expect(f.recipients.$not.$elemMatch.user_profile_id).toBeInstanceOf(ObjectId);
  });

  test('`every` uses double-negation pattern', () => {
    const f = translateWhere(NotificationModel, {
      recipients: { every: { is_read: true } },
    });
    expect(f.recipients.$not.$elemMatch.$nor).toEqual([{ is_read: true }]);
  });
});

describe('translateUpdateData', () => {
  test('plain assignment → $set + auto updated_at', () => {
    const u = translateUpdateData(M, { name: 'x' }) as any;
    expect(u.$set.name).toBe('x');
    expect(u.$set.updated_at).toBeInstanceOf(Date);
  });

  test('increment / decrement → $inc', () => {
    const u = translateUpdateData(M, { count: { increment: 3 } }) as any;
    expect(u.$inc).toEqual({ count: 3 });

    const v = translateUpdateData(M, { count: { decrement: 2 } }) as any;
    expect(v.$inc).toEqual({ count: -2 });
  });

  test('multiply / divide → $mul', () => {
    const u = translateUpdateData(M, { count: { multiply: 4 } }) as any;
    expect(u.$mul.count).toBe(4);

    const v = translateUpdateData(M, { count: { divide: 5 } }) as any;
    expect(v.$mul.count).toBe(1 / 5);
  });

  test('explicit set wrapper → $set', () => {
    const u = translateUpdateData(M, { count: { set: 9 } }) as any;
    expect(u.$set.count).toBe(9);
  });

  test('renames `id` → `_id` in update payload', () => {
    const oid = new ObjectId();
    const u = translateUpdateData(M, { id: oid.toString(), name: 'x' }) as any;
    expect(u.$set._id).toBeInstanceOf(ObjectId);
    expect(u.$set.id).toBeUndefined();
  });
});

describe('translateOrderBy', () => {
  test('asc → 1, desc → -1', () => {
    expect(translateOrderBy({ name: 'asc' })).toEqual([['name', 1]]);
    expect(translateOrderBy({ name: 'desc' })).toEqual([['name', -1]]);
  });

  test('preserves multi-key insertion order', () => {
    const out = translateOrderBy({ a: 'desc', b: 'asc' });
    expect(out).toEqual([['a', -1], ['b', 1]]);
  });

  test('id → _id remap', () => {
    const out = translateOrderBy({ id: 'desc' });
    expect(out).toEqual([['_id', -1]]);
  });

  test('array form merges into a single ordered Map', () => {
    const out = translateOrderBy([{ a: 'asc' }, { b: 'desc' }]);
    expect(out).toEqual([['a', 1], ['b', -1]]);
  });

  test('empty / nil returns undefined', () => {
    expect(translateOrderBy(undefined)).toBeUndefined();
    expect(translateOrderBy({})).toBeUndefined();
  });
});
