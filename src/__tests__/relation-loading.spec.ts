import { f, model, rel, setActiveSchema } from '../index';
import { createDb } from '../factory';
import type { ModelDef } from '../schema/types';
import type { RelationPlan, SelectNode } from '../ir/types';
import { buildSelect } from '../ir/build';
import { hydrateManyRelation, withJoinKeys } from '../ir/hydrate-many';
import { buildSchemaDDL } from '../adapters/sqlite/ddl';
import { applyMigration } from '../adapters/sqlite/migrate';
import { compileSelect as pgSelect } from '../adapters/postgres/compile-from-ir';
import { compileSelect as mysqlSelect } from '../adapters/mysql/compile-from-ir';
import { compileSelect as sqliteSelect } from '../adapters/sqlite/compile-from-ir';
import { compileSelect as duckdbSelect } from '../adapters/duckdb/compile-from-ir';
import { compileSelect as mssqlSelect } from '../adapters/mssql/compile-from-ir';

// How includes load. Every level is one query however many parents it has:
//
//   include_3-shaped: users → posts(where, orderBy, take 5) → comments(take 3) → author
//
// used to cost one posts query per user and one comments query per post (75
// round trips for ten users), because a per-parent `take` fell back to a query
// per parent. It is one windowed query per level now, and `_count` rides along
// in the parent's own SELECT instead of a grouped query per relation.

const User = model('users', {
  id: f.id({ type: 'string' }),
  email: f.string(),
  active: f.bool(),
}).relate(() => ({
  posts: rel.many('post', { on: 'author_id', refs: 'id' }),
  comments: rel.many('comment', { on: 'author_id', refs: 'id' }),
}));

const Post = model('posts', {
  id: f.id({ type: 'string' }),
  author_id: f.string(),
  title: f.string(),
  status: f.string(),
  rank: f.int(),
  deleted_at: f.dateTime().optional().softDeleteAt(),
}).relate(() => ({
  author: rel.one('user', { on: 'author_id', refs: 'id' }),
  comments: rel.many('comment', { on: 'post_id', refs: 'id' }),
}));

const Comment = model('comments', {
  id: f.id({ type: 'string' }),
  post_id: f.string(),
  author_id: f.string().optional(),
  body: f.string(),
}).relate(() => ({
  post: rel.one('post', { on: 'post_id', refs: 'id' }),
  author: rel.one('user', { on: 'author_id', refs: 'id' }),
}));

const sch = { user: User, post: Post, comment: Comment } as never;
const SC = sch as unknown as Record<string, ModelDef<any>>;

const userNode = (args: any): SelectNode => buildSelect('user', SC.user, args, 'many', SC as any);
const postsPlan = (node: SelectNode): RelationPlan => node.hydration!.find((h) => h.name === 'posts')!;

/** The node the loader hands an adapter for one level, with the parents' keys. */
function pagedPostsNode(): SelectNode {
  const node = userNode({ include: { posts: { where: { status: 'PUBLISHED' }, orderBy: [{ rank: 'desc' }, { id: 'asc' }], take: 5, skip: 1 } } });
  const plan = postsPlan(node);
  return {
    ...(plan.nested as any),
    kind: 'select', model: 'post', cardinality: 'many',
    where: { kind: 'and', children: [plan.nested!.where!, { kind: 'leaf', field: 'author_id', op: 'in', value: ['u1', 'u2'] }] },
    partitionBy: 'author_id',
  };
}

beforeAll(() => setActiveSchema(sch));

describe('a per-parent page compiles to one windowed query on every SQL dialect', () => {
  const cases: Array<[string, (n: SelectNode, m?: ModelDef<any>) => { sql: string }]> = [
    ['postgres', pgSelect], ['mysql', mysqlSelect], ['sqlite', sqliteSelect], ['duckdb', duckdbSelect], ['mssql', mssqlSelect],
  ];

  test.each(cases)('%s', (_name, compile) => {
    const { sql } = compile(pagedPostsNode(), SC.post);
    expect(sql).toMatch(/ROW_NUMBER\(\) OVER \(PARTITION BY .posts.\..author_id. ORDER BY .posts.\..rank. DESC, .posts.\..id. ASC\) AS .__forge_rn./);
    // skip 1, take 5 → rows 2..6 of each parent
    expect(sql).toMatch(/.__forge_rn. > 1 AND .__forge_rn. <= 6 ORDER BY .__forge_rn.$/);
    // The page bounds are on the window, never a LIMIT on the whole batch.
    expect(sql).not.toMatch(/\bLIMIT\b|FETCH NEXT/);
    expect(sql).toMatch(/IN \(/);
  });

  test('T-SQL gets an ORDER BY in the window even when the include has none', () => {
    const node = { ...pagedPostsNode(), orderBy: undefined };
    expect(mssqlSelect(node, SC.post).sql).toMatch(/PARTITION BY \[posts\]\.\[author_id\] ORDER BY \(SELECT NULL\)\)/);
    expect(pgSelect(node, SC.post).sql).toMatch(/PARTITION BY "posts"\."author_id"\) AS "__forge_rn"/);
  });

  test('without partitionBy the same node is an ordinary LIMIT/OFFSET select', () => {
    const { partitionBy: _p, ...node } = pagedPostsNode();
    const { sql } = pgSelect(node as SelectNode, SC.post);
    expect(sql).not.toMatch(/ROW_NUMBER/);
    expect(sql).toMatch(/LIMIT 5 OFFSET 1$/);
  });
});

describe('_count is a correlated subquery in the parent SELECT', () => {
  const node = () => userNode({ include: { _count: { select: { posts: true, comments: true } } } });

  test.each([
    ['postgres', pgSelect], ['mysql', mysqlSelect], ['sqlite', sqliteSelect], ['duckdb', duckdbSelect], ['mssql', mssqlSelect],
  ] as const)('%s', (_name, compile) => {
    const { sql } = compile(node(), SC.user);
    expect(sql).toMatch(/\(SELECT COUNT\(\*\) FROM .posts. .c1. WHERE .c1.\..author_id. = .users.\..id. AND .c1.\..deleted_at. IS NULL\) AS .__forge_count_posts./);
    expect(sql).toMatch(/\(SELECT COUNT\(\*\) FROM .comments. .c2. WHERE .c2.\..author_id. = .users.\..id.\) AS .__forge_count_comments./);
  });

  test('no parameter is bound for it, so DuckDB never sees an untyped array', () => {
    // The grouped form sent `= ANY($1)` with a JS array, which DuckDB refused:
    // "Cannot create values of type ANY".
    expect(duckdbSelect(node(), SC.user).params).toEqual([]);
  });
});

describe('the loader', () => {
  const POSTS = [
    { id: 'p1', author_id: 'u1', rank: 1 }, { id: 'p2', author_id: 'u1', rank: 2 },
    { id: 'p3', author_id: 'u1', rank: 3 }, { id: 'p4', author_id: 'u2', rank: 1 },
  ];
  const planFor = (nested: any): RelationPlan => ({ name: 'posts', kind: 'many', target: 'post', on: 'author_id', refs: 'id', nested });

  test('a windowed adapter pages every parent in ONE query', async () => {
    const seen: SelectNode[] = [];
    const rows: any[] = [{ id: 'u1' }, { id: 'u2' }, { id: 'u3' }];
    await hydrateManyRelation({
      rows, rel: planFor({ limit: 2 }), keyOf: String, windowed: { enabled: true },
      runSelect: async (n) => {
        seen.push(n);
        // what the database answers: two per author, in window order
        return [{ ...POSTS[0], __forge_rn: 1 }, { ...POSTS[3], __forge_rn: 1 }, { ...POSTS[1], __forge_rn: 2 }];
      },
    });
    expect(seen).toHaveLength(1);
    expect(seen[0].partitionBy).toBe('author_id');
    expect(seen[0].limit).toBe(2);
    expect(rows[0].posts.map((p: any) => p.id)).toEqual(['p1', 'p2']);
    expect(rows[1].posts.map((p: any) => p.id)).toEqual(['p4']);
    expect(rows[2].posts).toEqual([]);
    expect(rows[0].posts[0]).not.toHaveProperty('__forge_rn');
  });

  test('a server without window functions falls back to a query per parent, once', async () => {
    const windowed = { enabled: true, unsupported: (e: any) => e?.errno === 1064 };
    let calls = 0;
    const runSelect = async (n: SelectNode) => {
      calls++;
      if (n.partitionBy) throw Object.assign(new Error('syntax near OVER'), { errno: 1064 });
      const leaf: any = (n.where as any).children?.[0] ?? n.where;
      return POSTS.filter((p) => p.author_id === leaf.value).slice(0, n.limit);
    };
    const rows: any[] = [{ id: 'u1' }, { id: 'u2' }];
    await hydrateManyRelation({ rows, rel: planFor({ limit: 2 }), keyOf: String, windowed, runSelect });
    expect(windowed.enabled).toBe(false);
    expect(calls).toBe(3);
    expect(rows[0].posts.map((p: any) => p.id)).toEqual(['p1', 'p2']);
    calls = 0;
    await hydrateManyRelation({ rows, rel: planFor({ limit: 2 }), keyOf: String, windowed, runSelect });
    expect(calls).toBe(2);
  });

  test('any other error still surfaces', async () => {
    await expect(hydrateManyRelation({
      rows: [{ id: 'u1' }], rel: planFor({ limit: 2 }), keyOf: String,
      windowed: { enabled: true, unsupported: () => false },
      runSelect: async () => { throw new Error('connection reset'); },
    })).rejects.toThrow('connection reset');
  });

  test('DISTINCT and distance sorts keep the query per parent', async () => {
    let calls = 0;
    await hydrateManyRelation({
      rows: [{ id: 'u1' }, { id: 'u2' }], rel: planFor({ limit: 2, distinct: ['rank'] }), keyOf: String,
      windowed: { enabled: true }, runSelect: async (n) => { calls++; expect(n.partitionBy).toBeUndefined(); return []; },
    });
    expect(calls).toBe(2);
  });

  test('keyFirst sorts a batched load by the join key ahead of the caller’s order', async () => {
    let order: any;
    await hydrateManyRelation({
      rows: [{ id: 'u1' }], rel: planFor({ orderBy: [{ field: 'rank', direction: 'desc' }] }), keyOf: String, keyFirst: true,
      runSelect: async (n) => { order = n.orderBy; return []; },
    });
    expect(order).toEqual([{ field: 'author_id', direction: 'asc' }, { field: 'rank', direction: 'desc' }]);
  });

  test('withJoinKeys adds the keys an exclusive select left out, and only those', () => {
    const node = userNode({ select: { email: true, posts: { select: { title: true } } } });
    const keyed = withJoinKeys(node);
    expect(keyed.added).toEqual(['id']);
    expect(keyed.node.projection!.fields).toEqual(['email', 'id']);
    expect(withJoinKeys(userNode({ select: { id: true, posts: true } })).added).toEqual([]);
    expect(withJoinKeys(userNode({ include: { posts: true } })).added).toEqual([]);
  });
});

describe('against a real SQLite database, counting statements', () => {
  let db: any;
  let statements: string[] = [];

  beforeAll(async () => {
    setActiveSchema(sch);
    db = await createDb({ url: 'sqlite::memory:', schema: sch });
    await applyMigration((db.adapter as any).db, buildSchemaDDL(sch as never));
    for (let u = 1; u <= 4; u++) await db.user.create({ data: { id: `u${u}`, email: `u${u}@x`, active: u !== 4 } });
    for (let u = 1; u <= 4; u++) {
      for (let p = 1; p <= 6; p++) {
        const id = `p${u}${p}`;
        await db.post.create({ data: { id, author_id: `u${u}`, title: `t${u}${p}`, status: p % 3 === 0 ? 'DRAFT' : 'PUBLISHED', rank: (p * 7) % 5 } });
        for (let c = 1; c <= 4; c++) {
          await db.comment.create({ data: { id: `c${u}${p}${c}`, post_id: id, author_id: `u${((u + c) % 4) + 1}`, body: 'b' } });
        }
      }
    }
    await db.post.update({ where: { id: 'p11' }, data: { deleted_at: new Date() } });
    const driver = (db.adapter as any).db;
    const all = driver.all.bind(driver);
    driver.all = (sql: string, params: unknown[]) => { statements.push(sql); return all(sql, params); };
  });
  afterAll(async () => { await db?.$disconnect(); });
  beforeEach(() => { statements = []; });

  const deepArgs = {
    where: { active: true }, orderBy: { id: 'asc' as const },
    include: { posts: {
      where: { status: 'PUBLISHED' }, orderBy: [{ rank: 'desc' as const }, { id: 'asc' as const }], take: 2, skip: 1,
      include: { comments: { orderBy: { id: 'asc' as const }, take: 2, include: { author: { select: { id: true, email: true } } } } },
    } },
  };

  test('one statement per level, and the same rows a query per parent returns', async () => {
    const got = await db.user.findMany(deepArgs);
    expect(statements).toHaveLength(4);

    // Reference: the same tree, assembled one parent at a time.
    const users = await db.user.findMany({ where: { active: true }, orderBy: { id: 'asc' } });
    for (const u of users) {
      const posts = await db.post.findMany({ where: { author_id: u.id, status: 'PUBLISHED' }, orderBy: [{ rank: 'desc' }, { id: 'asc' }], take: 2, skip: 1 });
      for (const p of posts) {
        p.comments = await db.comment.findMany({ where: { post_id: p.id }, orderBy: { id: 'asc' }, take: 2 });
        for (const c of p.comments) c.author = c.author_id ? await db.user.findUnique({ where: { id: c.author_id }, select: { id: true, email: true } }) : null;
      }
      u.posts = posts;
    }
    expect(got).toEqual(users);
    expect(got[0].posts.length).toBe(2);
    expect(got[0].posts.every((p: any) => p.id !== 'p11')).toBe(true);
  });

  test('the statement count does not grow with the number of parents', async () => {
    await db.user.findMany({ ...deepArgs, where: {}, take: 1 });
    const one = statements.length;
    statements = [];
    await db.user.findMany({ ...deepArgs, where: {} });
    expect(statements.length).toBe(one);
  });

  test('_count is answered by the parent query alone, soft deletes excluded', async () => {
    const got = await db.user.findMany({ orderBy: { id: 'asc' }, include: { _count: { select: { posts: true, comments: true } } } });
    expect(statements).toHaveLength(1);
    expect(got[0]._count).toEqual({ posts: 5, comments: 24 });
    expect(got[1]._count).toEqual({ posts: 6, comments: 24 });
    expect(got[0]).not.toHaveProperty('__forge_count_posts');
  });

  test('a nested select that leaves out the foreign key still lands under its parent', async () => {
    const got = await db.user.findFirst({ where: { id: 'u2' }, include: { posts: { select: { id: true }, orderBy: { id: 'asc' }, take: 2 } } });
    expect(got.posts).toEqual([{ id: 'p21' }, { id: 'p22' }]);
    const all = await db.user.findFirst({ where: { id: 'u2' }, include: { posts: { select: { id: true } } } });
    expect(all.posts).toHaveLength(6);
  });

  test('a parent select that leaves out the foreign key still loads the relation', async () => {
    const got = await db.post.findFirst({ where: { id: 'p21' }, select: { title: true, author: { select: { email: true } } } });
    expect(got).toEqual({ title: 't21', author: { email: 'u2@x' } });
  });
});
