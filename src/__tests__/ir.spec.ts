import { f, model, rel } from '../schema/core';
import type { ModelDef } from '../schema/types';
import {
  buildCount,
  buildCursor,
  buildDelete,
  buildInsert,
  buildOrderBy,
  buildProjection,
  buildSelect,
  buildUpdate,
  buildUpdateData,
  buildWhereTree,
} from '../ir/build';

// Compact stand-in models for IR tests. We keep these separate from
// schema/index.ts to keep the IR layer driver- and project-agnostic.

const User: ModelDef<any> = model('users', {
  id: f.id(),
  email: f.string().unique(),
  age: f.int().optional(),
  active: f.bool().default(false),
  tags: f.stringArray().optional(),
  created_at: f.dateTime().default('now'),
}).relate(() => ({
  posts: rel.many('post', { on: 'author_id', refs: 'id' }),
})) as ModelDef<any>;

const Post: ModelDef<any> = model('posts', {
  id: f.id(),
  author_id: f.objectId(),
  title: f.string(),
}).relate(() => ({
  author: rel.one('user', { on: 'author_id', refs: 'id' }),
})) as ModelDef<any>;
void Post;

describe('IR — buildWhereTree', () => {
  it('bare equality → eq leaf', () => {
    expect(buildWhereTree(User, { email: 'a@b.co' })).toEqual({
      kind: 'leaf', field: 'email', op: 'eq', value: 'a@b.co',
    });
  });

  it('operator object → multiple leaves under AND', () => {
    const t = buildWhereTree(User, { age: { gte: 18, lt: 65 } });
    expect(t).toEqual({
      kind: 'and',
      children: [
        { kind: 'leaf', field: 'age', op: 'gte', value: 18 },
        { kind: 'leaf', field: 'age', op: 'lt', value: 65 },
      ],
    });
  });

  it('mode: insensitive carries caseInsensitive flag', () => {
    expect(buildWhereTree(User, { email: { contains: 'gmail', mode: 'insensitive' } })).toEqual({
      kind: 'leaf', field: 'email', op: 'contains', value: 'gmail', caseInsensitive: true,
    });
  });

  it('AND / OR / NOT compose', () => {
    const t = buildWhereTree(User, {
      AND: [{ active: true }, { age: { gte: 18 } }],
      OR: [{ email: { endsWith: '@a.co' } }, { email: { endsWith: '@b.co' } }],
      NOT: { active: false },
    });
    expect(t?.kind).toBe('and');
  });

  it('array ops: has/hasSome/hasEvery/isEmpty', () => {
    const t = buildWhereTree(User, { tags: { has: 'x', hasSome: ['a', 'b'], isEmpty: true } });
    expect(t?.kind).toBe('and');
  });

  it('relation filter → relation node', () => {
    const t = buildWhereTree(User, { posts: { some: { title: { contains: 'foo' } } } });
    expect(t).toEqual({
      kind: 'relation', relation: 'posts', mode: 'some',
      nested: { kind: 'leaf', field: 'title', op: 'contains', value: 'foo' },
    });
  });

  it('empty / undefined → undefined', () => {
    expect(buildWhereTree(User, undefined)).toBeUndefined();
    expect(buildWhereTree(User, {})).toBeUndefined();
  });
});

describe('IR — buildOrderBy', () => {
  it('plain direction string', () => {
    expect(buildOrderBy({ email: 'desc' })).toEqual([{ field: 'email', direction: 'desc' }]);
  });
  it('multi-sort array preserves order', () => {
    expect(buildOrderBy([{ active: 'asc' }, { age: 'desc' }])).toEqual([
      { field: 'active', direction: 'asc' },
      { field: 'age', direction: 'desc' },
    ]);
  });
  it('object form with nulls', () => {
    expect(buildOrderBy({ age: { sort: 'desc', nulls: 'last' } })).toEqual([
      { field: 'age', direction: 'desc', nulls: 'last' },
    ]);
  });
  it('null / undefined → undefined', () => {
    expect(buildOrderBy(undefined)).toBeUndefined();
    expect(buildOrderBy(null)).toBeUndefined();
  });
});

describe('IR — buildProjection', () => {
  it('omit-only', () => {
    const r = buildProjection(User, { omit: { email: true, age: true } });
    expect(r.projection).toEqual({ fields: [], omit: ['email', 'age'], counts: [], exclusive: false });
  });
  it('select scalars + relation', () => {
    const r = buildProjection(User, { select: { email: true, posts: true } });
    expect(r.projection?.exclusive).toBe(true);
    expect(r.projection?.fields).toEqual(['email']);
    expect(r.hydration?.[0]?.name).toBe('posts');
  });
  it('include all scalars + relation', () => {
    const r = buildProjection(User, { include: { posts: true } });
    expect(r.projection).toBeUndefined();
    expect(r.hydration?.[0]?.name).toBe('posts');
  });
  it('_count: { select: { posts: true } }', () => {
    const r = buildProjection(User, { select: { _count: { select: { posts: true } } } });
    expect(r.projection?.counts).toEqual(['posts']);
  });
});

describe('IR — buildCursor', () => {
  it('single field cursor', () => {
    expect(buildCursor({ id: 'abc' })).toEqual({ fields: { id: 'abc' } });
  });
  it('composite cursor flattens', () => {
    expect(buildCursor({ user_id_video_id: { user_id: 'u1', video_id: 'v1' } })).toEqual({
      fields: { user_id: 'u1', video_id: 'v1' },
    });
  });
  it('empty / null → undefined', () => {
    expect(buildCursor(undefined)).toBeUndefined();
    expect(buildCursor({})).toBeUndefined();
  });
});

describe('IR — buildUpdateData', () => {
  it('bare assignment → $set', () => {
    expect(buildUpdateData(User, { active: true })).toEqual({ set: { active: true } });
  });
  it('explicit set wrapper', () => {
    expect(buildUpdateData(User, { active: { set: true } })).toEqual({ set: { active: true } });
  });
  it('increment / decrement collapse to one bucket', () => {
    expect(buildUpdateData(User, { age: { increment: 1 } }).increment).toEqual({ age: 1 });
    expect(buildUpdateData(User, { age: { decrement: 3 } }).increment).toEqual({ age: -3 });
  });
  it('multiply / divide collapse to multiply bucket', () => {
    expect(buildUpdateData(User, { age: { multiply: 2 } }).multiply).toEqual({ age: 2 });
    expect(buildUpdateData(User, { age: { divide: 4 } }).multiply).toEqual({ age: 0.25 });
  });
  it('push on array field', () => {
    expect(buildUpdateData(User, { tags: { push: 'x' } }).push).toEqual({ tags: 'x' });
  });
  it('unset on scalar', () => {
    expect(buildUpdateData(User, { age: { unset: true } }).unset).toEqual(['age']);
  });
  it('null assignment routes to set: null', () => {
    expect(buildUpdateData(User, { age: null }).set).toEqual({ age: null });
  });
});

describe('IR — top-level node builders', () => {
  it('buildSelect respects take / limit / skip / offset aliases', () => {
    const a = buildSelect('user', User, { take: 10, skip: 20 }, 'many');
    const b = buildSelect('user', User, { limit: 10, offset: 20 }, 'many');
    expect(a.limit).toBe(10); expect(a.offset).toBe(20);
    expect(b.limit).toBe(10); expect(b.offset).toBe(20);
  });

  it('buildSelect carries distinct', () => {
    const n = buildSelect('user', User, { distinct: ['email', 'active'] }, 'many');
    expect(n.distinct).toEqual(['email', 'active']);
  });

  it('buildCount carries where + distinct', () => {
    const n = buildCount('user', User, { where: { active: true }, distinct: ['email'] });
    expect(n.kind).toBe('count');
    expect(n.distinct).toEqual(['email']);
  });

  it('buildInsert wraps rows verbatim', () => {
    const n = buildInsert('user', User, { rows: [{ email: 'a@b.co' }, { email: 'c@d.co' }] });
    expect(n.rows.length).toBe(2);
  });

  it('buildUpdate composes set + increment + many flag', () => {
    const n = buildUpdate('user', User, {
      where: { email: 'a@b.co' }, data: { active: true, age: { increment: 1 } }, many: false,
    });
    expect(n.set).toEqual({ active: true });
    expect(n.increment).toEqual({ age: 1 });
    expect(n.many).toBe(false);
  });

  it('buildUpdate carries upsertCreate when present', () => {
    const n = buildUpdate('user', User, {
      where: { email: 'a@b.co' }, data: { active: true }, upsertCreate: { email: 'a@b.co' },
    });
    expect(n.upsertCreate).toEqual({ email: 'a@b.co' });
  });

  it('buildDelete with many: true', () => {
    const n = buildDelete('user', User, { where: { active: false }, many: true });
    expect(n.many).toBe(true);
  });
});
