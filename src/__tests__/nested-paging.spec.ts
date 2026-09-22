import { f, model, rel } from '../schema/core';
import type { ModelDef } from '../schema/types';
import type { RelationPlan, SelectNode } from '../ir/types';
import { hydrateManyRelation, nestedPaging } from '../ir/hydrate-many';
import { buildSelect } from '../ir/build';
import { compileSelect as compileMongoSelect } from '../adapters/mongo/compile-from-ir';

// `include: { posts: { take: 3 } }` means three posts PER USER. The batched
// loader sent one `WHERE author_id IN (…) LIMIT 3`, which is three posts in
// total — the first user got three and everyone else got an empty array.

const Post: ModelDef<any> = model('posts', {
  id: f.id(),
  author_id: f.objectId(),
  title: f.string(),
}) as unknown as ModelDef<any>;

const relPlan = (nested?: Record<string, unknown>): RelationPlan => ({
  name: 'posts', kind: 'many', target: 'post', on: 'author_id', refs: 'id',
  nested: nested as RelationPlan['nested'],
});

/** A fake store: every post, filtered and paged the way a real DB would. */
function fakeDb(posts: Record<string, any>[]) {
  const queries: SelectNode[] = [];
  const runSelect = async (node: SelectNode) => {
    queries.push(node);
    const leaf = findFkLeaf(node.where);
    let rows = posts.filter((p) =>
      leaf!.op === 'in'
        ? (leaf!.value as unknown[]).includes(p.author_id)
        : p.author_id === leaf!.value,
    );
    if (node.offset) rows = rows.slice(node.offset);
    if (node.limit != null) rows = rows.slice(0, node.limit);
    return rows;
  };
  return { runSelect, queries };
}

function findFkLeaf(w: any): { op: string; value: unknown } | null {
  if (!w) return null;
  if (w.kind === 'leaf' && w.field === 'author_id') return w;
  if (w.kind === 'and') { for (const c of w.children) { const h = findFkLeaf(c); if (h) return h; } }
  return null;
}

const POSTS = [
  { id: 'p1', author_id: 'u1', title: 'a' },
  { id: 'p2', author_id: 'u1', title: 'b' },
  { id: 'p3', author_id: 'u1', title: 'c' },
  { id: 'p4', author_id: 'u1', title: 'd' },
  { id: 'p5', author_id: 'u2', title: 'e' },
  { id: 'p6', author_id: 'u2', title: 'f' },
  { id: 'p7', author_id: 'u3', title: 'g' },
];

describe('nestedPaging()', () => {
  test('is null when the caller did not page the inner list', () => {
    expect(nestedPaging(relPlan())).toBeNull();
    expect(nestedPaging(relPlan({ where: { kind: 'and', children: [] } }))).toBeNull();
  });

  test('is set for take, for skip, and for both', () => {
    expect(nestedPaging(relPlan({ limit: 3 }))).toEqual({ limit: 3, offset: undefined });
    expect(nestedPaging(relPlan({ offset: 2 }))).toEqual({ limit: undefined, offset: 2 });
    expect(nestedPaging(relPlan({ limit: 3, offset: 1 }))).toEqual({ limit: 3, offset: 1 });
  });
});

describe('nested take is per parent, not per batch', () => {
  test('every parent gets its own page', async () => {
    const rows: Record<string, any>[] = [{ id: 'u1' }, { id: 'u2' }, { id: 'u3' }];
    const { runSelect } = fakeDb(POSTS);
    await hydrateManyRelation({ rows, rel: relPlan({ limit: 2 }), runSelect, keyOf: String });
    // The bug: u1 got 2 and u2/u3 got []. All three must be served.
    expect(rows[0].posts.map((p: any) => p.id)).toEqual(['p1', 'p2']);
    expect(rows[1].posts.map((p: any) => p.id)).toEqual(['p5', 'p6']);
    expect(rows[2].posts.map((p: any) => p.id)).toEqual(['p7']);
  });

  test('nested skip is per parent too', async () => {
    const rows: Record<string, any>[] = [{ id: 'u1' }, { id: 'u2' }];
    const { runSelect } = fakeDb(POSTS);
    await hydrateManyRelation({ rows, rel: relPlan({ limit: 2, offset: 1 }), runSelect, keyOf: String });
    expect(rows[0].posts.map((p: any) => p.id)).toEqual(['p2', 'p3']);
    expect(rows[1].posts.map((p: any) => p.id)).toEqual(['p6']);
  });

  test('a parent with no children gets [] , not another parent’s rows', async () => {
    const rows: Record<string, any>[] = [{ id: 'u1' }, { id: 'u9' }];
    const { runSelect } = fakeDb(POSTS);
    await hydrateManyRelation({ rows, rel: relPlan({ limit: 2 }), runSelect, keyOf: String });
    expect(rows[1].posts).toEqual([]);
  });
});

describe('the batched fast path is kept when nothing is paged', () => {
  test('one query for every parent, not one per parent', async () => {
    const rows: Record<string, any>[] = [{ id: 'u1' }, { id: 'u2' }, { id: 'u3' }];
    const { runSelect, queries } = fakeDb(POSTS);
    await hydrateManyRelation({ rows, rel: relPlan(), runSelect, keyOf: String });
    expect(queries).toHaveLength(1);
    expect(findFkLeaf(queries[0].where)!.op).toBe('in');
    expect(rows[0].posts).toHaveLength(4);
    expect(rows[1].posts).toHaveLength(2);
  });

  test('paging costs one query per parent — the price of being correct', async () => {
    const rows: Record<string, any>[] = [{ id: 'u1' }, { id: 'u2' }, { id: 'u3' }];
    const { runSelect, queries } = fakeDb(POSTS);
    await hydrateManyRelation({ rows, rel: relPlan({ limit: 2 }), runSelect, keyOf: String });
    expect(queries).toHaveLength(3);
    expect(queries.every((q) => findFkLeaf(q.where)!.op === 'eq')).toBe(true);
  });

  test('no parents means no query at all', async () => {
    const rows: Record<string, any>[] = [{ id: null }];
    const { runSelect, queries } = fakeDb(POSTS);
    await hydrateManyRelation({ rows, rel: relPlan({ limit: 2 }), runSelect, keyOf: String });
    expect(queries).toHaveLength(0);
    expect(rows[0].posts).toEqual([]);
  });

  test('the caller’s nested where survives alongside the FK filter', async () => {
    const rows: Record<string, any>[] = [{ id: 'u1' }];
    const { runSelect, queries } = fakeDb(POSTS);
    const nestedWhere = { kind: 'leaf', field: 'title', op: 'eq', value: 'b' };
    await hydrateManyRelation({
      rows, rel: relPlan({ limit: 2, where: nestedWhere }), runSelect, keyOf: String,
    });
    expect(queries[0].where).toEqual({
      kind: 'and',
      children: [nestedWhere, { kind: 'leaf', field: 'author_id', op: 'eq', value: 'u1' }],
    });
  });
});

describe('Mongo relation filters fail loudly instead of matching everything', () => {
  const Author: ModelDef<any> = model('authors', {
    id: f.id(),
    email: f.string(),
  }).relate(() => ({
    posts: rel.many('post', { on: 'author_id', refs: 'id' }),
  })) as unknown as ModelDef<any>;

  test('a relation filter throws, naming the relation and the way out', () => {
    const node = buildSelect('author', Author, {
      where: { posts: { some: { title: 'x' } } },
    }, 'many', { author: Author, post: Post } as any);
    expect(() => compileMongoSelect(node, Author)).toThrow(/relation filter on 'posts'/);
    expect(() => compileMongoSelect(node, Author)).toThrow(/two steps/);
  });

  test('the dangerous case: it used to compile to an empty filter', () => {
    // compileWhere is shared by reads AND writes, so `{}` meant
    // `deleteMany({ where: { posts: { some: … } } })` became
    // `deleteMany({})` — the whole collection.
    const node = buildSelect('author', Author, {
      where: { posts: { some: { title: 'x' } } },
    }, 'many', { author: Author, post: Post } as any);
    let filter: unknown = 'threw';
    try { filter = (compileMongoSelect(node, Author) as any).args.filter; } catch { /* expected */ }
    expect(filter).toBe('threw');
  });
});
