// The per-call costs every query pays, held down: statements prepared once,
// counts read from the driver instead of returned rows, no module resolution
// on the query path.

import { blogSchema, openDuckdb, openSqlite, type LiveDb } from './_live-dbs';
import { betterSqlite3Driver } from '../adapters/sqlite/driver';
import { setActiveSchema } from '../schema/active';

const sch = blogSchema();

describe('better-sqlite3: statements are prepared once per SQL text', () => {
  const Database = require('better-sqlite3');

  test('a repeated query prepares once and returns fresh results', async () => {
    const h = new Database(':memory:');
    let prepares = 0;
    const orig = h.prepare.bind(h);
    h.prepare = (sql: string) => { prepares++; return orig(sql); };
    const d = betterSqlite3Driver(h);
    await d.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
    for (let i = 0; i < 5; i++) await d.run('INSERT INTO t (id, v) VALUES (?, ?)', [i, `v${i}`]);
    const got: string[] = [];
    for (let i = 0; i < 5; i++) got.push((await d.get('SELECT v FROM t WHERE id = ?', [i])).v);
    expect(got).toEqual(['v0', 'v1', 'v2', 'v3', 'v4']);
    expect(prepares).toBe(2);
  });

  test('a statement still being iterated is not reused for another call', async () => {
    const h = new Database(':memory:');
    const d = betterSqlite3Driver(h);
    await d.exec('CREATE TABLE t (id INTEGER PRIMARY KEY)');
    for (let i = 0; i < 3; i++) await d.run('INSERT INTO t (id) VALUES (?)', [i]);
    await d.all('SELECT id FROM t ORDER BY id', []);
    const seen: number[] = [];
    for (const r of d.iterate!('SELECT id FROM t ORDER BY id', []) as Iterable<any>) {
      seen.push(r.id);
      expect((await d.all('SELECT id FROM t ORDER BY id', [])).length).toBe(3);
    }
    expect(seen).toEqual([0, 1, 2]);
  });

  test('DDL through exec drops the cache, so a rebuilt table is read correctly', async () => {
    const h = new Database(':memory:');
    const d = betterSqlite3Driver(h);
    await d.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, a TEXT)');
    await d.run('INSERT INTO t (id, a) VALUES (?, ?)', [1, 'x']);
    expect(await d.all('SELECT * FROM t', [])).toEqual([{ id: 1, a: 'x' }]);
    await d.exec('DROP TABLE t; CREATE TABLE t (id INTEGER PRIMARY KEY, a TEXT, b TEXT)');
    await d.run('INSERT INTO t (id, a, b) VALUES (?, ?, ?)', [2, 'y', 'z']);
    expect(await d.all('SELECT * FROM t', [])).toEqual([{ id: 2, a: 'y', b: 'z' }]);
  });
});

describe.each([
  ['sqlite', openSqlite],
  ['duckdb', openDuckdb],
] as const)('%s: updateMany / deleteMany / createMany count without returning rows', (_name, open) => {
  let live: LiveDb;
  beforeAll(async () => {
    setActiveSchema(sch as never);
    live = await open(sch);
    await live.db.user.create({ data: { id: 'u1', email: 'a@x', name: 'a' } });
    await live.db.user.create({ data: { id: 'u2', email: 'b@x', name: 'b' } });
  });
  afterAll(async () => { await live?.close(); });

  test('createMany', async () => {
    live.log.length = 0;
    const r = await live.db.post.createMany({ data: [1, 2, 3].map((k) => ({ id: `p${k}`, author_id: 'u1', title: `t${k}` })) });
    expect(r).toEqual({ count: 3 });
    expect(live.log.join('\n')).not.toMatch(/RETURNING/);
  });

  test('updateMany', async () => {
    live.log.length = 0;
    expect(await live.db.post.updateMany({ where: { author_id: 'u1' }, data: { views: 7 } })).toEqual({ count: 3 });
    expect(await live.db.post.updateMany({ where: { author_id: 'nobody' }, data: { views: 7 } })).toEqual({ count: 0 });
    expect(live.log.join('\n')).not.toMatch(/RETURNING/);
    expect((await live.db.post.findMany({ where: { views: 7 } })).length).toBe(3);
  });

  test('a single update and delete still hand the row back', async () => {
    const u = await live.db.post.update({ where: { id: 'p1' }, data: { title: 'renamed' } });
    expect(u).toMatchObject({ id: 'p1', title: 'renamed', views: 7 });
    const d = await live.db.post.delete({ where: { id: 'p1' } });
    expect(d).toMatchObject({ id: 'p1', title: 'renamed' });
  });

  test('deleteMany', async () => {
    live.log.length = 0;
    expect(await live.db.post.deleteMany({ where: { author_id: 'u1' } })).toEqual({ count: 2 });
    expect(await live.db.post.deleteMany({ where: { author_id: 'u1' } })).toEqual({ count: 0 });
    expect(live.log.filter((s) => /^DELETE/.test(s)).join('\n')).not.toMatch(/RETURNING/);
  });
});

describe('mongo: a cascading delete with nothing to cascade is one write', () => {
  const { openMongo } = require('./_live-dbs');
  let live: any;
  beforeAll(async () => {
    live = await openMongo(sch);
    if (!live) return;
    await live.db.user.createMany({ data: [
      { id: 'a1', email: 'a1@x', name: 'lonely' }, { id: 'a2', email: 'a2@x', name: 'lonely' },
      { id: 'b1', email: 'b1@x', name: 'parent' },
    ] });
    await live.db.post.create({ data: { id: 'bp', author_id: 'b1', title: 't' } });
    await live.db.comment.create({ data: { id: 'bc', post_id: 'bp', author_id: 'b1', body: 'x' } });
  });
  afterAll(async () => { await live?.close(); });

  test('no child rows: the probe and the delete, no transaction', async () => {
    if (!live) return;
    live.log.length = 0;
    expect(await live.db.user.deleteMany({ where: { name: 'lonely' } })).toEqual({ count: 2 });
    expect(live.log).toEqual(['aggregate', 'delete']);
  });

  test('a badge (Restrict) that is absent is not counted, and children still cascade', async () => {
    if (!live) return;
    const u = await live.db.user.delete({ where: { id: 'b1' } });
    expect(u.id).toBe('b1');
    expect(await live.db.post.count()).toBe(0);
    expect(await live.db.comment.count()).toBe(0);
  });

  test('a present Restrict child still blocks the delete', async () => {
    if (!live) return;
    await live.db.user.create({ data: { id: 'r1', email: 'r1@x', name: 'kept' } });
    await live.db.badge.create({ data: { id: 'g1', user_id: 'r1' } });
    await expect(live.db.user.delete({ where: { id: 'r1' } })).rejects.toThrow(/Restrict/);
    expect(await live.db.user.count({ where: { id: 'r1' } })).toBe(1);
  });
});

describe('mongo: distinct is one round trip and pages after the dedupe', () => {
  const { openMongo } = require('./_live-dbs');
  let live: any;
  beforeAll(async () => {
    live = await openMongo(sch);
    if (!live) return;
    await live.db.user.createMany({ data: ['u1', 'u2', 'u3'].map((id) => ({ id, email: `${id}@x`, name: id })) });
    const posts = [];
    for (const a of ['u1', 'u2', 'u3']) for (let k = 0; k < 3; k++) posts.push({ id: `${a}_${k}`, author_id: a, title: `${a}${k}`, views: k });
    await live.db.post.createMany({ data: posts });
  });
  afterAll(async () => { await live?.close(); });

  test('values only, in order', async () => {
    if (!live) return;
    live.log.length = 0;
    const r = await live.db.post.findMany({ distinct: ['author_id'], select: { author_id: true }, orderBy: { author_id: 'desc' } });
    expect(r).toEqual([{ author_id: 'u3' }, { author_id: 'u2' }, { author_id: 'u1' }]);
    expect(live.log).toEqual(['distinct']);
  });

  test('take counts distinct rows, and the first row per key follows orderBy', async () => {
    if (!live) return;
    const r = await live.db.post.findMany({ distinct: ['author_id'], orderBy: [{ author_id: 'asc' }, { views: 'desc' }], take: 2 });
    expect(r.map((p: any) => p.id)).toEqual(['u1_2', 'u2_2']);
  });
});

describe('postgres: an include is loaded inside the parent SELECT', () => {
  const { compileSelect } = require('../adapters/postgres/compile-from-ir');
  const { buildSelect } = require('../ir/build');
  test('json_agg per level, ordered by its columns (ROW_NUMBER when they are not selected), paged inside the subquery', () => {
    setActiveSchema(sch as never);
    const node = buildSelect('user', (sch as any).user, {
      include: { posts: { where: { views: { gt: 1 } }, orderBy: { id: 'desc' }, take: 2, include: { comments: true, _count: { select: { post_tags: true } } } } },
    }, 'many', sch);
    const { sql, params } = compileSelect(node, (sch as any).user, undefined, sch);
    expect(sql).toContain('json_agg("t" ORDER BY "t"."id" DESC)');
    const narrow = buildSelect('user', (sch as any).user, { include: { posts: { orderBy: { views: 'desc' }, select: { id: true } } } }, 'many', sch);
    expect(compileSelect(narrow, (sch as any).user, undefined, sch).sql).toContain('json_agg("t" ORDER BY "t"."__forge_ord")');
    expect(sql).toContain('WHERE "j1"."author_id" = "users"."id" AND "j1"."views" > $1 ORDER BY "j1"."id" DESC LIMIT 2');
    expect(sql).toContain('"j3"."post_id" = "j1"."id"');
    expect(sql).toMatch(/AS "__forge_count_post_tags"/);
    expect(params).toEqual([1]);
  });
  test('a relation with a column JSON cannot carry keeps the query per level', () => {
    const { f, model, rel } = require('../schema/core');
    const A = model('as', { id: f.id({ type: 'string' }) }).relate(() => ({ bs: rel.many('b', { on: 'a_id', refs: 'id' }) }));
    const B = model('bs', { id: f.id({ type: 'string' }), a_id: f.string(), blob: f.bytes() });
    const s2 = { a: A, b: B };
    const node = buildSelect('a', A, { include: { bs: true } }, 'many', s2);
    expect(compileSelect(node, A, undefined, s2).sql).not.toContain('json_agg');
  });
});

describe('postgres (live): JSON-loaded includes decode to the same values as a query per level', () => {
  const { f, model, rel } = require('../schema/core');
  const { createDb } = require('../factory');
  const { pgDriver } = require('../adapters/postgres/driver');
  const Owner = model('pj_owners', { id: f.id({ type: 'string' }), name: f.string() })
    .relate(() => ({ items: rel.many('item', { on: 'owner_id', refs: 'id' }) }));
  const Item = model('pj_items', {
    id: f.id({ type: 'string' }), owner_id: f.string(), at: f.dateTime(), big: f.bigint(),
    price: f.decimal(), ratio: f.float(), ok: f.bool(), tags: f.stringArray(), meta: f.json<any>().optional(),
    note: f.string().optional(),
  }).relate(() => ({ owner: rel.one('owner', { on: 'owner_id', refs: 'id' }) }));
  const s = { owner: Owner, item: Item };
  let pool: any; let admin: any; let db: any; const name = `forge_spec_json_${process.pid}`;
  beforeAll(async () => {
    const { Pool } = require('pg');
    admin = new Pool({ connectionString: 'postgres://postgres@127.0.0.1:5432/postgres', connectionTimeoutMillis: 1000 });
    try { await admin.query(`CREATE DATABASE ${name}`); } catch { admin = null; return; }
    pool = new Pool({ connectionString: `postgres://postgres@127.0.0.1:5432/${name}` });
    const { buildSchemaDDL } = require('../adapters/postgres/ddl');
    const { applyMigration } = require('../adapters/postgres/migrate');
    await applyMigration(pool, buildSchemaDDL(s as never));
    db = await createDb({ schema: s, driver: pgDriver(pool) } as never);
    await db.owner.create({ data: { id: 'o1', name: 'one' } });
    await db.owner.create({ data: { id: 'o2', name: 'two' } });
    for (let k = 0; k < 3; k++) {
      await db.item.create({ data: {
        id: `i${k}`, owner_id: 'o1', at: new Date(Date.UTC(2025, 0, 1, 0, 0, k, 123)), big: 9007199254740993n + BigInt(k),
        price: '12.345', ratio: 0.1 + k, ok: k % 2 === 0, tags: ['a', `t${k}`], meta: k ? { n: k } : null, note: k ? null : 'x',
      } });
    }
  });
  afterAll(async () => {
    await pool?.end();
    if (admin) { await admin.query(`DROP DATABASE IF EXISTS ${name}`).catch(() => {}); await admin.end(); }
  });

  test('values, order, paging and to-one match the query-per-level results', async () => {
    if (!db) return;
    const args = { orderBy: { id: 'asc' as const }, include: { items: { orderBy: { at: 'desc' as const }, take: 2, include: { owner: true } } } };
    const json = await db.owner.findMany(args);
    const items = await db.item.findMany({ where: { owner_id: 'o1' }, orderBy: { at: 'desc' }, take: 2 });
    const owner = await db.owner.findUnique({ where: { id: 'o1' } });
    expect(json[0].items).toEqual(items.map((i: any) => ({ ...i, owner })));
    expect(json[0].items[0].at).toBeInstanceOf(Date);
    expect(typeof json[0].items[0].big).toBe('bigint');
    expect(json[0].items[0].big).toBe(9007199254740995n);
    expect(json[1].items).toEqual([]);
    const back = await db.item.findMany({ orderBy: { id: 'asc' }, include: { owner: { select: { name: true } } } });
    expect(back.map((i: any) => i.owner)).toEqual([{ name: 'one' }, { name: 'one' }, { name: 'one' }]);
  });
});

describe('duckdb: a cascading delete with nothing to cascade is one write', () => {
  let live: LiveDb;
  beforeAll(async () => {
    setActiveSchema(sch as never);
    live = await openDuckdb(sch);
    await live.db.user.createMany({ data: [
      { id: 'a1', email: 'a1@x', name: 'lonely' }, { id: 'a2', email: 'a2@x', name: 'lonely' }, { id: 'b1', email: 'b1@x', name: 'parent' },
    ] });
    await live.db.post.create({ data: { id: 'bp', author_id: 'b1', title: 't' } });
  });
  afterAll(async () => { await live?.close(); });

  test('no child rows: the probe and the delete, no transaction', async () => {
    live.log.length = 0;
    expect(await live.db.user.deleteMany({ where: { name: 'lonely' } })).toEqual({ count: 2 });
    expect(live.log.filter((s) => !/^(BEGIN|COMMIT)/.test(s))).toHaveLength(2);
    expect(live.log.some((s) => /^BEGIN/.test(s))).toBe(false);
  });

  test('children still cascade', async () => {
    await live.db.user.delete({ where: { id: 'b1' } });
    expect(await live.db.post.count()).toBe(0);
  });
});


describe('mysql: a filtered DISTINCT asks the planner not to group by an index', () => {
  const { compileSelect } = require('../adapters/mysql/compile-from-ir');
  const { buildSelect } = require('../ir/build');
  test('with a WHERE it carries NO_GROUP_INDEX; without one it does not', () => {
    const P = (sch as any).post;
    const filtered = compileSelect(buildSelect('post', P, { where: { views: { lt: 100 } }, distinct: ['author_id'], select: { author_id: true } }, 'many', sch), P).sql;
    expect(filtered).toMatch(/^SELECT \/\*\+ NO_GROUP_INDEX\(`posts`\) \*\/ DISTINCT `posts`\.`author_id`/);
    const bare = compileSelect(buildSelect('post', P, { distinct: ['author_id'], select: { author_id: true } }, 'many', sch), P).sql;
    expect(bare).toMatch(/^SELECT DISTINCT /);
  });
});

describe('parseIsoDate is new Date(text), faster for the shape SQLite stores', () => {
  const { parseIsoDate } = require('../adapters/shared/row-decoder');
  test('identical results, including the shapes it hands to the general parser', () => {
    const cases = [
      '2025-01-01T00:00:00.000Z', '1999-12-31T23:59:59.999Z', '2024-02-29T12:30:45.123Z', '0050-06-01T00:00:00.000Z',
      '2025-02-30T00:00:00.000Z', '2025-13-01T00:00:00.000Z', '2025-01-01T24:00:00.000Z', '2025-01-01 00:00:00',
      '2025-01-01T00:00:00Z', '2025-01-01T00:00:00.000+01:00', 'garbage', '', '9999-12-31T23:59:59.999Z',
    ];
    for (let k = 0; k < 2000; k++) cases.push(new Date(Date.UTC(1970 + (k % 200), k % 12, 1 + (k % 28), k % 24, k % 60, k % 60, k % 1000)).toISOString());
    for (const c of cases) {
      const a = parseIsoDate(c), b = new Date(c);
      expect([c, Number.isNaN(a.getTime()) ? 'NaN' : a.getTime()]).toEqual([c, Number.isNaN(b.getTime()) ? 'NaN' : b.getTime()]);
    }
    expect(parseIsoDate(null)).toBeNull();
  });
});

describe('sqlite: an owning `is` filter is IN (subquery) on unpaged statements, EXISTS otherwise', () => {
  let live: LiveDb;
  beforeAll(async () => {
    setActiveSchema(sch as never);
    live = await openSqlite(sch);
    await live.db.user.createMany({ data: [{ id: 'u1', email: 'a@x', name: 'Ann' }, { id: 'u2', email: 'b@x', name: 'Bob' }] });
    await live.db.post.create({ data: { id: 'p1', author_id: 'u1', title: 't' } });
    await live.db.comment.createMany({ data: [
      { id: 'c1', post_id: 'p1', author_id: 'u1', body: 'x' }, { id: 'c2', post_id: 'p1', author_id: 'u2', body: 'y' },
      { id: 'c3', post_id: 'p1', author_id: null, body: 'z' },
    ] });
  });
  afterAll(async () => { await live?.close(); });

  test('the SQL by shape', async () => {
    live.log.length = 0;
    await live.db.comment.count({ where: { author: { is: { name: 'Ann' } } } });
    await live.db.comment.findMany({ where: { author: { is: { name: 'Ann' } } }, take: 5 });
    await live.db.comment.updateMany({ where: { author: { is: { name: 'Nobody' } } }, data: { body: 'q' } });
    expect(live.log[0]).toMatch(/"comments"\."author_id" IN \(SELECT/);
    expect(live.log[1]).toMatch(/EXISTS \(SELECT 1 FROM "users"/);
    expect(live.log[2]).toMatch(/IN \(SELECT/);
  });

  test('same answers, NULL keys included, and NOT keeps EXISTS', async () => {
    expect(await live.db.comment.count({ where: { author: { is: { name: 'Ann' } } } })).toBe(1);
    expect(await live.db.comment.count({ where: { OR: [{ author: { is: { name: 'Bob' } } }, { body: 'z' }] } })).toBe(2);
    live.log.length = 0;
    expect(await live.db.comment.count({ where: { NOT: { author: { is: { name: 'Ann' } } } } })).toBe(2);
    expect(live.log[0]).toMatch(/NOT EXISTS \(SELECT 1 FROM "users"/);
    const g = await live.db.comment.groupBy({ by: ['author_id'], where: { author: { is: { name: { in: ['Ann', 'Bob'] } } } }, _count: { _all: true } });
    expect(g.map((r: any) => r.author_id).sort()).toEqual(['u1', 'u2']);
  });
});

describe('mongo: a `none` filter is bounded by the rest of its AND', () => {
  const { openMongo } = require('./_live-dbs');
  let live: any;
  beforeAll(async () => {
    live = await openMongo(sch);
    if (!live) return;
    await live.db.user.createMany({ data: [{ id: 'u1', email: 'a@x', name: 'Ann' }, { id: 'u2', email: 'b@x', name: 'Bob' }] });
    await live.db.post.createMany({ data: ['p1', 'p2', 'p3', 'q1', 'q2'].map((id) => ({ id, author_id: id.startsWith('p') ? 'u1' : 'u2', title: id })) });
    await live.db.comment.createMany({ data: [{ id: 'c1', post_id: 'p1', body: 'x' }, { id: 'c2', post_id: 'q1', body: 'y' }] });
  });
  afterAll(async () => { await live?.close(); });

  test('same rows as before, for none, delete and every', async () => {
    if (!live) return;
    const rows = await live.db.post.findMany({ where: { author: { is: { email: 'a@x' } }, comments: { none: {} } }, orderBy: { id: 'asc' } });
    expect(rows.map((r: any) => r.id)).toEqual(['p2', 'p3']);
    expect(await live.db.post.deleteMany({ where: { author: { is: { email: 'b@x' } }, comments: { none: {} } } })).toEqual({ count: 1 });
    expect((await live.db.post.findMany({ orderBy: { id: 'asc' } })).map((r: any) => r.id)).toEqual(['p1', 'p2', 'p3', 'q1']);
    expect(await live.db.post.count({ where: { NOT: { author_id: 'u2' }, comments: { every: { body: 'x' } } } })).toBe(3);
  });
});

describe('distinct: no second dedupe when SQL DISTINCT already gives one row per key', () => {
  const { distinctIsExact } = require('../ir/hydrate-many');
  const { buildSelect } = require('../ir/build');
  const P = (sch as any).post;
  test('exact only when exactly the distinct columns are selected', () => {
    expect(distinctIsExact(buildSelect('post', P, { distinct: ['author_id'], select: { author_id: true } }, 'many', sch))).toBe(true);
    expect(distinctIsExact(buildSelect('post', P, { distinct: ['author_id'], select: { author_id: true, title: true } }, 'many', sch))).toBe(false);
    expect(distinctIsExact(buildSelect('post', P, { distinct: ['author_id'] }, 'many', sch))).toBe(false);
  });
  test('sqlite: same rows either way', async () => {
    setActiveSchema(sch as never);
    const live = await openSqlite(sch);
    try {
      await live.db.user.create({ data: { id: 'u1', email: 'a@x', name: 'a' } });
      await live.db.user.create({ data: { id: 'u2', email: 'b@x', name: 'b' } });
      await live.db.post.createMany({ data: [['p1', 'u1', 'x'], ['p2', 'u1', 'y'], ['p3', 'u2', 'x']].map(([id, a, t]) => ({ id, author_id: a, title: t })) });
      expect(await live.db.post.findMany({ distinct: ['author_id'], select: { author_id: true }, orderBy: { author_id: 'asc' } })).toEqual([{ author_id: 'u1' }, { author_id: 'u2' }]);
      expect((await live.db.post.findMany({ distinct: ['author_id'], select: { author_id: true, title: true }, orderBy: [{ author_id: 'asc' }, { title: 'asc' }] })).map((r: any) => r.title)).toEqual(['x', 'x']);
    } finally { await live.close(); }
  });
});
