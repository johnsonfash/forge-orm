import { f, model, rel } from '../schema/core';
import type { ModelDef } from '../schema/types';
import type { SelectNode } from '../ir/types';
import { buildSelect } from '../ir/build';
import { hydrateManyRelation } from '../ir/hydrate-many';
import { compileSelect } from '../adapters/postgres/compile-from-ir';
import { compileSelect as compileMongoSelect } from '../adapters/mongo/compile-from-ir';

// Soft-delete scoping used to stop at the top level. `where deleted_at IS NULL`
// was added by the wrapper to the outer query only, so
//
//   db.user.findMany({ include: { posts: true } })
//
// handed back every post the caller had already soft-deleted — the rows are
// hidden from `findMany` on posts and visible through any parent that includes
// them. The documented opt-out was broken the other way: `_withDeleted: true`
// compiled to a filter on a column of that literal name.

const Comment: ModelDef<any> = model('comments', {
  id: f.id(),
  post_id: f.objectId(),
  body: f.string(),
  // Deliberately not `deleted_at` — proves each level uses its OWN column.
  removed_at: f.dateTime().softDeleteAt(),
}) as unknown as ModelDef<any>;

const Tag: ModelDef<any> = model('tags', {
  id: f.id(),
  post_id: f.objectId(),
  label: f.string(),
}) as unknown as ModelDef<any>;

const Post: ModelDef<any> = model('posts', {
  id: f.id(),
  author_id: f.objectId(),
  title: f.string(),
  deleted_at: f.dateTime().softDeleteAt(),
}).relate(() => ({
  comments: rel.many('comment', { on: 'post_id', refs: 'id' }),
  tags: rel.many('tag', { on: 'post_id', refs: 'id' }),
  author: rel.one('user', { on: 'author_id', refs: 'id' }),
})) as unknown as ModelDef<any>;

const User: ModelDef<any> = model('users', {
  id: f.id(),
  email: f.string(),
  team_id: f.objectId(),
  archived_at: f.dateTime().softDeleteAt(),
}).relate(() => ({
  posts: rel.many('post', { on: 'author_id', refs: 'id' }),
})) as unknown as ModelDef<any>;

const Team: ModelDef<any> = model('teams', {
  id: f.id(),
  owner_id: f.objectId(),
  name: f.string(),
}).relate(() => ({
  members: rel.many('user', { on: 'team_id', refs: 'id' }),
})) as unknown as ModelDef<any>;

const sc = { user: User, post: Post, comment: Comment, tag: Tag, team: Team } as any;

const userNode = (args: any): SelectNode => buildSelect('user', User, args, 'many', sc);

/** The nested SelectNode an adapter would execute for relation `name`. */
const nestedOf = (node: SelectNode, name: string): any =>
  node.hydration!.find((h) => h.name === name)!.nested;

/**
 * The SQL a relation sub-select actually runs, through the shared many-side
 * loader every adapter uses — so this is the FK filter and the nested where
 * together, not just the IR fragment.
 */
async function relationSql(node: SelectNode, name: string): Promise<string> {
  const relPlan = node.hydration!.find((h) => h.name === name)!;
  const target = sc[relPlan.target] as ModelDef<any>;
  let sql = '';
  await hydrateManyRelation({
    rows: [{ id: 'u1' }],
    rel: relPlan,
    keyOf: String,
    runSelect: async (sub) => { sql = (compileSelect(sub, target) as any).sql; return []; },
  });
  return sql;
}

/** Just the WHERE clause — the projection lists the column either way. */
const whereOf = (sql: string): string => sql.split(' WHERE ')[1] ?? '';

describe('a nested include excludes the target’s soft-deleted rows', () => {
  test('include: { posts: true } scopes the sub-select', async () => {
    const sql = await relationSql(userNode({ include: { posts: true } }), 'posts');
    expect(sql).toContain('"deleted_at" IS NULL');
    expect(sql).toContain('"author_id"');
  });

  test('select: { posts: true } scopes it too — not just include', async () => {
    const node = buildSelect('user', User, { select: { id: true, posts: true } }, 'many', sc);
    expect(await relationSql(node, 'posts')).toContain('"deleted_at" IS NULL');
  });

  test('the caller’s own nested filter survives alongside it', async () => {
    const sql = await relationSql(
      userNode({ include: { posts: { where: { title: 'x' } } } }), 'posts',
    );
    expect(sql).toContain('"title" =');
    expect(sql).toContain('"deleted_at" IS NULL');
  });

  test('the TARGET’s column is used, not the parent’s', async () => {
    // Both models are soft-deletable with different column names. Scoping
    // `posts` by the parent's `archived_at` would be a filter on a column the
    // posts table hasn't got.
    const sql = await relationSql(userNode({ include: { posts: true } }), 'posts');
    expect(sql).toContain('"deleted_at" IS NULL');
    expect(whereOf(sql)).not.toContain('archived_at');
  });

  test('a to-one include is scoped by the target model', () => {
    // Asserted on the IR: the adapters' to-one hydration builds its own node.
    const node = buildSelect('post', Post, { include: { author: true } }, 'many', sc);
    expect(nestedOf(node, 'author').where)
      .toEqual({ kind: 'leaf', field: 'archived_at', op: 'eq', value: null });
  });
});

describe('every level of nesting is scoped', () => {
  test('an include inside an include gets its own column', () => {
    const node = userNode({ include: { posts: { include: { comments: true } } } });
    const posts = nestedOf(node, 'posts');
    expect(posts.where).toEqual({ kind: 'leaf', field: 'deleted_at', op: 'eq', value: null });
    const comments = posts.hydration.find((h: any) => h.name === 'comments').nested;
    expect(comments.where).toEqual({ kind: 'leaf', field: 'removed_at', op: 'eq', value: null });
  });

  test('three levels deep, with no args written at any level', () => {
    const node = buildSelect('team', Team, {
      include: { members: { include: { posts: { include: { comments: true } } } } },
    }, 'many', sc);
    const members = nestedOf(node, 'members');
    expect(members.where.field).toBe('archived_at');
    const posts = members.hydration.find((h: any) => h.name === 'posts').nested;
    expect(posts.where.field).toBe('deleted_at');
    expect(posts.hydration.find((h: any) => h.name === 'comments').nested.where.field)
      .toBe('removed_at');
  });
});

describe('_withDeleted opts a nested include out', () => {
  test('the scoping predicate is gone', async () => {
    const sql = await relationSql(
      userNode({ include: { posts: { where: { _withDeleted: true } } } }), 'posts',
    );
    expect(whereOf(sql)).not.toContain('deleted_at');
  });

  test('_withDeleted never reaches the where-builder as a column', async () => {
    // It used to: `{ _withDeleted: true }` became `WHERE "_withDeleted" = $1`,
    // which is an undefined-column error on every SQL dialect.
    const sql = await relationSql(
      userNode({ include: { posts: { where: { _withDeleted: true } } } }), 'posts',
    );
    expect(whereOf(sql)).not.toContain('_withDeleted');
    expect(nestedOf(userNode({ include: { posts: { where: { _withDeleted: true } } } }), 'posts')
      .where).toBeUndefined();
  });

  test('it is stripped even where it opts nothing out', () => {
    // `_withDeleted: false`, and models with no soft-delete column at all,
    // still must not leave the flag behind as a filter.
    const kept = nestedOf(userNode({ include: { posts: { where: { _withDeleted: false } } } }), 'posts');
    expect(JSON.stringify(kept.where)).not.toContain('_withDeleted');
    const noColumn = buildSelect('post', Post, {
      include: { tags: { where: { _withDeleted: true } } },
    }, 'many', sc);
    expect(nestedOf(noColumn, 'tags').where).toBeUndefined();
  });

  test('the caller’s other nested filters are untouched by the strip', async () => {
    const sql = await relationSql(
      userNode({ include: { posts: { where: { _withDeleted: true, title: 'x' } } } }), 'posts',
    );
    expect(sql).toContain('"title" =');
    expect(whereOf(sql)).not.toContain('deleted_at');
  });
});

describe('an explicit filter on the soft-delete column wins', () => {
  test('"only the deleted ones" is not overridden with IS NULL', async () => {
    const sql = await relationSql(
      userNode({ include: { posts: { where: { deleted_at: { not: null } } } } }), 'posts',
    );
    expect(sql).toContain('"deleted_at" IS NOT NULL');
    expect(sql).not.toContain('"deleted_at" IS NULL');
  });

  test('a range filter on the column is left exactly as written', () => {
    const since = new Date('2026-01-01T00:00:00Z');
    const nested = nestedOf(
      userNode({ include: { posts: { where: { deleted_at: { gte: since } } } } }), 'posts',
    );
    expect(nested.where).toEqual({ kind: 'leaf', field: 'deleted_at', op: 'gte', value: since });
  });
});

describe('a model with no soft-delete column is untouched', () => {
  test('no predicate is added, and no node is invented for it', async () => {
    const node = buildSelect('post', Post, { include: { tags: true } }, 'many', sc);
    // Nothing to filter, so the plan stays the bare one that lets adapters take
    // their batched path without merging an empty nested node.
    expect(nestedOf(node, 'tags')).toBeUndefined();
    const sql = await relationSql(node, 'tags');
    expect(sql).not.toContain('IS NULL');
    expect(sql).toContain('"post_id"');
  });

  test('its own nested args still compile on their own', async () => {
    const node = buildSelect('post', Post, {
      include: { tags: { where: { label: 'ops' } } },
    }, 'many', sc);
    const sql = await relationSql(node, 'tags');
    expect(sql).toContain('"label" =');
    expect(sql).not.toContain('IS NULL');
  });
});

describe('Mongo gets the same scoping', () => {
  const mongoFilter = (node: SelectNode, name: string, target: ModelDef<any>) => {
    const nested = nestedOf(node, name);
    const sub: SelectNode = {
      ...nested, kind: 'select', model: 'post', cardinality: 'many',
    };
    return (compileMongoSelect(sub, target) as any).args.filter;
  };

  test('a nested include filters on the target’s column', () => {
    const fil = mongoFilter(userNode({ include: { posts: true } }), 'posts', Post);
    expect(fil).toEqual({ deleted_at: null });
  });

  test('_withDeleted opts out without leaving a stray key', () => {
    const node = userNode({ include: { posts: { where: { _withDeleted: true, title: 'x' } } } });
    const fil = mongoFilter(node, 'posts', Post);
    expect(fil).toEqual({ title: 'x' });
  });

  test('a nested include one level down uses that model’s column', () => {
    const node = userNode({ include: { posts: { include: { comments: true } } } });
    const posts = nestedOf(node, 'posts');
    const sub: SelectNode = {
      ...posts.hydration.find((h: any) => h.name === 'comments').nested,
      kind: 'select', model: 'comment', cardinality: 'many',
    };
    expect((compileMongoSelect(sub, Comment) as any).args.filter).toEqual({ removed_at: null });
  });
});
