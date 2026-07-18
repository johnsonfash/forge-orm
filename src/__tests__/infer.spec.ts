// Type-level tests for the Infer* family.
//
// These are *compile-time* assertions: the file passes if `tsc` accepts it.
// Every `expectType<X, Y>` call resolves to `true` when X and Y are
// structurally equivalent; mismatches surface as `false` and a downstream
// `acceptOnly<true>(...)` rejects them. Jest runs the file at runtime so
// the suite as a whole reports green/red, but the real assertion is the
// type-checker — `npm run forge:test` and `npm run forge:typesafety`
// both have to pass for the build to ship.

import { f, model, rel } from '../schema/core';
import type {
  Infer,
  InferCreate,
  InferInclude,
  InferOrderBy,
  InferRow,
  InferSchema,
  InferSelect,
  InferUpdate,
  InferWhere,
  InferWhereUnique,
} from '../infer';

// --- Local schema (no SchemaMap registration required) ----------------------
const User = model('users', {
  id: f.id(),
  email: f.string().unique(),
  name: f.string().optional(),
  age: f.int().optional(),
  createdAt: f.dateTime().default('now'),
}).relate(() => ({
  posts: rel.many('post', { on: 'authorId', refs: 'id' }),
}));

const Post = model('posts', {
  id: f.id(),
  title: f.string(),
  body: f.text(),
  published: f.bool().default(false),
  authorId: f.objectId(),
  views: f.int().default(0),
  publishedAt: f.dateTime().optional(),
}).relate(() => ({
  author: rel.one('user', { on: 'authorId', refs: 'id' }),
}));

// Typed-JSON column coverage (2.6.4). `prefs` carries a concrete shape;
// `meta` uses the bare `f.json()` which now defaults to `unknown`.
type AccountPrefs = { theme: 'light' | 'dark'; density: number };
const Account = model('accounts', {
  id: f.id(),
  prefs: f.json<AccountPrefs>(),
  meta: f.json(),
});

const schema = { user: User, post: Post } as const;

// --- Type-level equality helpers -------------------------------------------
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Extends<A, B> = A extends B ? true : false;
function acceptOnly<_T extends true>(): void { /* compile-time only */ }

describe('Infer<typeof Model> — single-model inference', () => {
  test('InferRow resolves scalar fields with optional flags + dates', () => {
    type R = InferRow<typeof User>;
    type Has = Equal<R['id'], string> & Equal<R['email'], string> &
               Equal<R['name'], string | null> & Equal<R['age'], number | null> &
               Equal<R['createdAt'], Date>;
    acceptOnly<Has>();
    expect(true).toBe(true);
  });

  test('InferWhere accepts field filters + AND/OR/NOT', () => {
    type W = InferWhere<typeof User>;
    const w: W = {
      email: 'a@b.co',
      age: { gt: 18 },
      AND: [{ name: { contains: 'sm' } }],
      OR: [{ id: 'x' }, { id: 'y' }],
      NOT: { email: 'banned@b.co' },
    };
    expect(w.email).toBe('a@b.co');
  });

  test('InferWhereUnique narrows to partial keys', () => {
    type U = InferWhereUnique<typeof User>;
    const k: U = { id: 'abc' };
    const k2: U = { email: 'a@b.co' };
    expect(k.id).toBe('abc');
    expect(k2.email).toBe('a@b.co');
  });

  test('InferCreate makes fields optional + accepts relation directives', () => {
    type C = InferCreate<typeof User>;
    const c: C = {
      email: 'new@b.co',
      // optional id/createdAt — runtime fills defaults
      // relations:
      posts: {
        create: [{ title: 'hello', body: 'world', authorId: 'u1' }],
      },
    };
    expect(c.email).toBe('new@b.co');
  });

  test('InferUpdate accepts plain values + numeric atomic ops', () => {
    type U = InferUpdate<typeof Post>;
    const inc: U = { views: { increment: 1 } };
    const set: U = { views: 100 };
    const ops: U = { views: { multiply: 2 } };
    const rel: U = { author: { connect: { id: 'u1' } } };
    expect(inc.views).toEqual({ increment: 1 });
    expect(set.views).toBe(100);
    expect(ops.views).toEqual({ multiply: 2 });
    expect(rel.author).toEqual({ connect: { id: 'u1' } });
  });

  test('InferOrderBy exposes scalar fields with asc | desc', () => {
    type O = InferOrderBy<typeof User>;
    const o1: O = { createdAt: 'desc' };
    const o2: O = { email: 'asc' };
    expect(o1.createdAt).toBe('desc');
    expect(o2.email).toBe('asc');
  });

  test('InferSelect autocompletes scalar booleans (relations need schema arg)', () => {
    type S = InferSelect<typeof User>;
    const s: S = { id: true, email: true, name: false };
    expect(s.id).toBe(true);
  });

  test('Infer bundles every key in one shape', () => {
    type T = Infer<typeof User>;
    const create: T['Create'] = { email: 'a@b.co' };
    const update: T['Update'] = { name: 'New' };
    const where: T['Where'] = { id: 'u1' };
    expect(create.email).toBe('a@b.co');
    expect(update.name).toBe('New');
    expect(where.id).toBe('u1');
  });
});

describe('f.json<T>() — typed JSON columns', () => {
  test('InferRow carries the parameterised JSON type; bare json is unknown', () => {
    type R = InferRow<typeof Account>;
    type Has = Equal<R['prefs'], AccountPrefs> & Equal<R['meta'], unknown>;
    acceptOnly<Has>();
    expect(true).toBe(true);
  });

  test('InferCreate type-checks the JSON shape', () => {
    type C = InferCreate<typeof Account>;
    const ok: C = { prefs: { theme: 'dark', density: 2 }, meta: { anything: true } };
    expect(ok.prefs?.theme).toBe('dark');
    // @ts-expect-error — 'neon' is not assignable to the typed theme union
    const bad: C = { prefs: { theme: 'neon', density: 2 }, meta: null };
    void bad;
  });
});

describe('InferSchema<typeof schema> — mapped inference with relations', () => {
  test('Select walks relations when the schema is provided', () => {
    type T = InferSchema<typeof schema>;
    type S = T['user']['Select'];
    // Scalar booleans
    const s1: S = { id: true, email: true };
    // Relation: boolean
    const s2: S = { posts: true };
    // Relation: nested args (autocomplete works inside the schema map)
    const s3: S = { posts: { select: { id: true, title: true } } };
    expect(s1.id).toBe(true);
    expect(s2.posts).toBe(true);
    expect(s3.posts).toEqual({ select: { id: true, title: true } });
  });

  test('Include walks relations when the schema is provided', () => {
    type T = InferSchema<typeof schema>;
    type I = T['user']['Include'];
    const i1: I = { posts: true };
    const i2: I = { posts: { where: { published: true } } };
    expect(i1.posts).toBe(true);
    expect(i2.posts).toEqual({ where: { published: true } });
  });

  test('Per-model bundle exposes every Infer alias', () => {
    type T = InferSchema<typeof schema>;
    type Bundle = T['post'];
    const r: Bundle['Row'] = {
      id: 'p1', title: 't', body: 'b', published: false,
      authorId: 'u1', views: 0, publishedAt: null,
    };
    const c: Bundle['Create'] = { title: 't', body: 'b', authorId: 'u1' };
    const u: Bundle['Update'] = { views: { increment: 1 } };
    const w: Bundle['Where'] = { published: true };
    const o: Bundle['OrderBy'] = { views: 'desc' };
    expect(r.id).toBe('p1');
    expect(c.title).toBe('t');
    expect(u.views).toEqual({ increment: 1 });
    expect(w.published).toBe(true);
    expect(o.views).toBe('desc');
  });
});

describe('Structural sanity', () => {
  test('InferRow keys match the source field record', () => {
    type R = InferRow<typeof User>;
    type Keys = keyof R;
    type Expected = 'id' | 'email' | 'name' | 'age' | 'createdAt';
    acceptOnly<Equal<Keys, Expected>>();
    expect(true).toBe(true);
  });

  test('InferUpdate widens scalars to include the matching update wrapper', () => {
    type U = InferUpdate<typeof Post>;
    // string and number scalars both allow plain assignment.
    acceptOnly<Extends<{ title: string }, U>>();
    acceptOnly<Extends<{ views: number }, U>>();
    // Numeric atomic ops are accepted too.
    acceptOnly<Extends<{ views: { increment: number } }, U>>();
    expect(true).toBe(true);
  });
});
