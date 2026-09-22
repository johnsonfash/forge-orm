import { f, model, rel } from '../schema/core';
import type { ModelDef } from '../schema/types';
import type { RelationPlan, SelectNode, WhereTree } from '../ir/types';
import { buildGroupBy } from '../ir/build';
import { compileGroupBy } from '../adapters/postgres/compile-from-ir';
import { hydrateOneRelation } from '../ir/hydrate-many';
import { softDeleteField } from '../ir/build/soft-delete';
import { buildSelect } from '../ir/build';
import { compileSelect } from '../adapters/postgres/compile-from-ir';

// Scoping relation sub-selects was only half of it. Three places disagreed
// with the rows `include` returns once it was fixed, and one of them —
// `groupBy` — feeds `aggregate({ _sum })`, so a revenue total counted deleted
// orders.

const Post: ModelDef<never> = model('posts', {
  id: f.id(),
  author_id: f.objectId(),
  title: f.string(),
  deleted_at: f.dateTime().optional().softDeleteAt(),
}) as never as ModelDef<never>;

const Order: ModelDef<never> = model('orders', {
  id: f.id(),
  status: f.string(),
  total: f.int(),
  deleted_at: f.dateTime().optional().softDeleteAt(),
}) as never as ModelDef<never>;

const Plain: ModelDef<never> = model('plains', {
  id: f.id(),
  n: f.int(),
}) as never as ModelDef<never>;

describe('groupBy is soft-delete scoped', () => {
  test('a deleted row is excluded from the aggregate', () => {
    // `_find`, `findManyStream` and `count` all scoped; groupBy scoped
    // neither, so a revenue total silently included deleted orders.
    const node = buildGroupBy('order', Order, {
      by: ['status'], _sum: { total: true },
      where: { deleted_at: null },
    } as never);
    const sql = (compileGroupBy(node, Order) as { sql: string }).sql;
    expect(sql).toContain('"deleted_at" IS NULL');
  });

  test('a model with no soft-delete column gets no predicate', () => {
    const node = buildGroupBy('plain', Plain, { by: [], _sum: { n: true } } as never);
    expect((compileGroupBy(node, Plain) as { sql: string }).sql).not.toContain('IS NULL');
  });
});

describe('the soft-delete field lookup', () => {
  test('finds the declared column whatever it is called', () => {
    expect(softDeleteField(Post)).toBe('deleted_at');
    expect(softDeleteField(Order)).toBe('deleted_at');
  });

  test('is undefined for a model without one', () => {
    expect(softDeleteField(Plain)).toBeUndefined();
  });
});

describe('to-one hydration keeps BOTH filters', () => {
  const relPlan = (nested?: Record<string, unknown>): RelationPlan => ({
    name: 'author', kind: 'one', target: 'user', on: 'author_id', refs: 'id',
    nested: nested as RelationPlan['nested'],
  });

  const capture = () => {
    const nodes: SelectNode[] = [];
    return {
      nodes,
      runSelect: async (n: SelectNode) => { nodes.push(n); return []; },
    };
  };

  test('the FK filter survives alongside a nested where', async () => {
    // Every adapter spread `nested` LAST, so `nested.where` REPLACED the FK
    // filter and the sub-select scanned the whole target table. Results still
    // came out right — rows are mapped by key afterwards — so the only
    // symptom was reading every row to return one per parent.
    const { nodes, runSelect } = capture();
    const nestedWhere: WhereTree = { kind: 'leaf', field: 'deleted_at', op: 'eq', value: null };
    await hydrateOneRelation({
      rows: [{ author_id: 'u1' }],
      rel: relPlan({ where: nestedWhere }),
      parentField: 'author_id', targetField: 'id',
      keyOf: String, runSelect,
    });
    expect(nodes[0].where).toEqual({
      kind: 'and',
      children: [nestedWhere, { kind: 'leaf', field: 'id', op: 'in', value: ['u1'] }],
    });
  });

  test('the FK filter alone when there is no nested where', async () => {
    const { nodes, runSelect } = capture();
    await hydrateOneRelation({
      rows: [{ author_id: 'u1' }], rel: relPlan(),
      parentField: 'author_id', targetField: 'id', keyOf: String, runSelect,
    });
    expect(nodes[0].where).toEqual({ kind: 'leaf', field: 'id', op: 'in', value: ['u1'] });
  });

  test('the inverse direction matches on the other pair of fields', async () => {
    const { nodes, runSelect } = capture();
    await hydrateOneRelation({
      rows: [{ id: 'u1' }], rel: relPlan(),
      parentField: 'id', targetField: 'author_id', keyOf: String, runSelect,
    });
    expect(nodes[0].where).toEqual({ kind: 'leaf', field: 'author_id', op: 'in', value: ['u1'] });
  });

  test('no parents means no query, and every relation set to null', async () => {
    const { nodes, runSelect } = capture();
    const rows: Record<string, unknown>[] = [{ author_id: null }];
    await hydrateOneRelation({
      rows, rel: relPlan(), parentField: 'author_id', targetField: 'id', keyOf: String, runSelect,
    });
    expect(nodes).toHaveLength(0);
    expect(rows[0].author).toBeNull();
  });

  test('a parent with no match gets null, not another parent’s row', async () => {
    const rows: Record<string, unknown>[] = [{ author_id: 'u1' }, { author_id: 'u9' }];
    await hydrateOneRelation({
      rows, rel: relPlan(), parentField: 'author_id', targetField: 'id', keyOf: String,
      runSelect: async () => [{ id: 'u1', name: 'A' }],
    });
    expect((rows[0].author as { name: string }).name).toBe('A');
    expect(rows[1].author).toBeNull();
  });

  test('mapRef is applied to the keys in the filter', async () => {
    // Mongo coerces an id string to an ObjectId here; a filter holding the
    // raw string matches nothing.
    const { nodes, runSelect } = capture();
    await hydrateOneRelation({
      rows: [{ author_id: 'u1' }], rel: relPlan(),
      parentField: 'author_id', targetField: 'id', keyOf: String,
      mapRef: (v) => `OID(${String(v)})`, runSelect,
    });
    expect((nodes[0].where as { value: unknown[] }).value).toEqual(['OID(u1)']);
  });

  test('the nested projection and ordering are carried through', async () => {
    const { nodes, runSelect } = capture();
    await hydrateOneRelation({
      rows: [{ author_id: 'u1' }],
      rel: relPlan({ orderBy: [{ field: 'name', direction: 'asc' }], limit: 1 }),
      parentField: 'author_id', targetField: 'id', keyOf: String, runSelect,
    });
    expect(nodes[0].orderBy).toEqual([{ field: 'name', direction: 'asc' }]);
    expect(nodes[0].limit).toBe(1);
  });
});

describe('relation filters only see live children', () => {
  const Author: ModelDef<never> = model('authors', {
    id: f.id(),
    email: f.string(),
  }).relate(() => ({
    posts: rel.many('post', { on: 'author_id', refs: 'id' }),
  })) as never as ModelDef<never>;

  const sch = { author: Author, post: Post } as never;
  // The schema override matters: without it the compiler resolves the
  // relation target against the global sample schema, whose Post has no
  // soft-delete column.
  const sql = (where: unknown) =>
    (compileSelect(
      buildSelect('author', Author, { where } as never, 'many', sch),
      Author,
      undefined,
      sch as never,
    ) as { sql: string }).sql;

  test('`some` cannot match on a deleted child', () => {
    // Otherwise a parent comes back from a filter saying it "has some post",
    // with an empty `posts` array — because `include` now excludes that row.
    const out = sql({ posts: { some: { title: 'x' } } });
    expect(out).toContain('EXISTS');
    expect(out).toMatch(/"t1"\."deleted_at" IS NULL/);
  });

  test('the scope sits on the join condition, not inside the inner condition', () => {
    // `every` negates only the inner condition, so a scope folded in there
    // would make it mean "every child is live AND matches".
    const out = sql({ posts: { every: { title: 'x' } } });
    expect(out).toContain('NOT EXISTS');
    const sub = out.slice(out.indexOf('NOT EXISTS'));
    expect(sub.indexOf('IS NULL')).toBeLessThan(sub.indexOf('NOT ('));
  });

  test('`none` is scoped too, so a deleted child no longer blocks it', () => {
    expect(sql({ posts: { none: { title: 'x' } } })).toMatch(/"deleted_at" IS NULL/);
  });

  test('_withDeleted opts the relation filter out', () => {
    const out = sql({ posts: { some: { title: 'x', _withDeleted: true } } });
    expect(out).not.toContain('deleted_at');
    expect(out).toContain('EXISTS');
  });

  test('_withDeleted never reaches the where-builder as a column', () => {
    const node = buildSelect('author', Author, {
      where: { posts: { some: { _withDeleted: true } } },
    } as never, 'many', sch);
    expect(JSON.stringify(node.where)).not.toContain('_withDeleted');
    expect(sql({ posts: { some: { _withDeleted: true } } })).not.toContain('_withDeleted');
  });

  test('the caller\u2019s own filter survives alongside the scope', () => {
    const out = sql({ posts: { some: { title: 'x' } } });
    expect(out).toContain('"title" = $');
    expect(out).toMatch(/"deleted_at" IS NULL/);
  });
});

describe('a relation filter with no recognised mode is refused', () => {
  const Author2: ModelDef<never> = model('authors2', {
    id: f.id(),
    email: f.string(),
  }).relate(() => ({
    posts: rel.many('post', { on: 'author_id', refs: 'id' }),
  })) as never as ModelDef<never>;
  const sch2 = { author2: Author2, post: Post } as never;
  const build = (where: unknown) =>
    buildSelect('author2', Author2, { where } as never, 'many', sch2);

  test('`_count` on a relation matched EVERY row — now it throws', () => {
    // It was documented as working. The builder recognises only
    // is/isNot/some/every/none, and anything else pushed no predicate at all,
    // so the relation filter evaporated and every parent came back.
    expect(() => build({ posts: { _count: { gt: 0 } } }))
      .toThrow(/would have\s+matched every row/);
  });

  test('the error names the supported modes', () => {
    let msg = '';
    try { build({ posts: { nonsense: 1 } }); } catch (e) { msg = (e as Error).message; }
    expect(msg).toContain('is, isNot, some, every, none');
    expect(msg).toContain('{ posts: { some: { … } } }');
  });

  test('_count gets the specific advice, since that is what the docs suggested', () => {
    let msg = '';
    try { build({ posts: { _count: { gt: 0 } } }); } catch (e) { msg = (e as Error).message; }
    expect(msg).toContain('some: {}');
    expect(msg).toContain('none: {}');
    expect(msg).toContain('having');
  });

  test('every supported mode still builds', () => {
    for (const mode of ['is', 'isNot', 'some', 'every', 'none']) {
      expect(() => build({ posts: { [mode]: { title: 'x' } } })).not.toThrow();
    }
  });

  test('a mode alongside an unknown key is still accepted', () => {
    // The guard only fires when NOTHING is recognised; it must not reject a
    // filter that does carry a mode.
    expect(() => build({ posts: { some: { title: 'x' }, extra: 1 } })).not.toThrow();
  });

  test('a plain scalar filter is untouched by the guard', () => {
    expect(() => build({ email: { contains: 'x' } })).not.toThrow();
  });
});
