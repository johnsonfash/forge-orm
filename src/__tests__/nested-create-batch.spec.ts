// A nested create is several statements. They now (a) run in one transaction
// wherever the database has one, so a failure part-way leaves nothing behind,
// and (b) batch: child rows go in as one INSERT and every connectOrCreate of a
// relation is resolved with one lookup and one insert for the missing rows.
//
// Before: SQLite ran it with no BEGIN/COMMIT at all, and the benchmark's
// user + profile + 3 posts + 3 tagged links took 12 statements on Postgres
// and SQLite where hand-written SQL takes 8.

import { blogSchema, openDuckdb, openMongo, openSqlite, type LiveDb } from './_live-dbs';

const tree = (u: string) => ({
  id: u, email: `${u}@x`, name: u,
  profiles: { create: { id: `${u}_pr`, bio: 'hi' } },
  posts: { create: [0, 1, 2].map((k) => ({
    id: `${u}_p${k}`, title: `t${k}`,
    ...(k === 0 ? { post_tags: { create: ['old-a', 'old-b', 'new-c', 'old-a'].map((name, j) => ({
      id: `${u}_pt${j}`,
      tag: { connectOrCreate: { where: { name }, create: { id: `tag_${u}_${name}`, name } } },
    })) } } : {}),
  })) },
});

function suite(name: string, open: () => Promise<LiveDb | null>) {
  describe(`nested create — ${name}`, () => {
    let live: LiveDb | null;
    let db: any;
    beforeEach(async () => {
      live = await open();
      db = live?.db;
      if (db) await db.tag.createMany({ data: [{ id: 'ta', name: 'old-a' }, { id: 'tb', name: 'old-b' }] });
    });
    afterEach(async () => { await live?.close(); });

    it('creates the whole tree, reusing existing tags and creating a missing one once', async () => {
      if (!db) return;
      const u = await db.user.create({ data: tree('u1') });
      expect(u.id).toBe('u1');
      const back = await db.user.findUnique({ where: { id: 'u1' }, include: {
        profiles: true, posts: { orderBy: { id: 'asc' }, include: { post_tags: { orderBy: { id: 'asc' }, include: { tag: true } } } },
      } });
      expect(back.profiles.map((p: any) => p.bio)).toEqual(['hi']);
      expect(back.posts.map((p: any) => p.id)).toEqual(['u1_p0', 'u1_p1', 'u1_p2']);
      expect(back.posts[0].post_tags.map((pt: any) => pt.tag.name)).toEqual(['old-a', 'old-b', 'new-c', 'old-a']);
      expect(back.posts[0].post_tags[0].tag_id).toBe('ta');
      expect(await db.tag.count()).toBe(3);
    });

    it('rolls the whole tree back when a later statement fails', async () => {
      if (!db) return;
      if (live?.transactional === false) return;
      await db.user.create({ data: { id: 'taken', email: 'taken@x', name: 'x' } });
      // The third post reuses an id that already exists in posts.
      await db.post.create({ data: { id: 'dup_p', author_id: 'taken', title: 'x' } });
      const bad = tree('u2');
      (bad.posts.create as any[])[2].id = 'dup_p';
      await expect(db.user.create({ data: bad })).rejects.toBeTruthy();
      expect(await db.user.count({ where: { id: 'u2' } })).toBe(0);
      expect(await db.profile.count({ where: { user_id: 'u2' } })).toBe(0);
      expect(await db.post.count({ where: { author_id: 'u2' } })).toBe(0);
      expect(await db.tag.count()).toBe(2);
    });

    it('creates an owning-side relation first and points the row at it', async () => {
      if (!db) return;
      await db.user.create({ data: { id: 'a1', email: 'a1@x', name: 'a' } });
      await db.post.create({ data: { id: 'pp', author_id: 'a1', title: 'x' } });
      const pt = await db.postTag.create({ data: { id: 'link', post: { connect: { id: 'pp' } }, tag: { create: { id: 'fresh', name: 'fresh' } } } });
      expect(pt.tag_id).toBe('fresh');
      expect(await db.tag.count({ where: { id: 'fresh' } })).toBe(1);
    });
  });
}

suite('sqlite', () => openSqlite(blogSchema()));
suite('duckdb', () => openDuckdb(blogSchema()));
suite('mongo', () => openMongo(blogSchema()));

describe('nested create statement count — sqlite', () => {
  it('is one statement per table plus the transaction', async () => {
    const live = await openSqlite(blogSchema());
    await live.db.tag.createMany({ data: [{ id: 'ta', name: 'old-a' }, { id: 'tb', name: 'old-b' }] });
    live.log.length = 0;
    await live.db.user.create({ data: tree('u1') });
    const sql = live.log.map((s) => s.trim().split(/\s+/).slice(0, 3).join(' '));
    expect(sql[0]).toBe('BEGIN');
    expect(sql[sql.length - 1]).toBe('COMMIT');
    // user, profile, posts, tag lookup, missing tag, post_tags.
    expect(live.log.length).toBe(8);
    await live.close();
  });

  it('two concurrent nested creates on one connection both commit', async () => {
    const live = await openSqlite(blogSchema());
    await live.db.tag.createMany({ data: [{ id: 'ta', name: 'old-a' }, { id: 'tb', name: 'old-b' }] });
    const a = tree('c1');
    const b = tree('c2');
    for (const t of [a, b]) for (const pt of (t.posts.create as any[])[0].post_tags.create) pt.tag.connectOrCreate.where.name = pt.tag.connectOrCreate.create.name = `${pt.tag.connectOrCreate.where.name}-${t.id}`;
    await Promise.all([live.db.user.create({ data: a }), live.db.user.create({ data: b })]);
    expect(await live.db.user.count()).toBe(2);
    expect(await live.db.post.count()).toBe(6);
    await live.close();
  });
});
