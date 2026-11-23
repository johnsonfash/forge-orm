// onDelete on databases that cannot run it: Mongo (no foreign keys) and DuckDB
// (refuses ON DELETE CASCADE / SET NULL). forge walks the relations itself.
//
// The Mongo walker used to build its relation map at module load, from the
// bundled sample schema, so a consumer's own models never cascaded at all:
// deleting a user left its posts, their comments and their post_tags behind.
// DuckDB had no walker, despite the docs promising one.

import { blogSchema, openDuckdb, openIndexedDb, openMongo, type LiveDb } from './_live-dbs';

async function seed(db: any) {
  await db.user.createMany({ data: [
    { id: 'u1', email: 'u1@x', name: 'One' },
    { id: 'u2', email: 'u2@x', name: 'Two' },
  ] });
  await db.profile.create({ data: { id: 'pr1', user_id: 'u1', bio: 'b' } });
  await db.tag.createMany({ data: [{ id: 't1', name: 'a' }, { id: 't2', name: 'b' }] });
  for (const p of ['p1', 'p2']) {
    await db.post.create({ data: { id: p, author_id: 'u1', title: p } });
    await db.comment.createMany({ data: [
      { id: `${p}_c1`, post_id: p, author_id: 'u2', body: 'x' },
      { id: `${p}_c2`, post_id: p, author_id: 'u2', body: 'y' },
    ] });
    await db.postTag.create({ data: { id: `${p}_t`, post_id: p, tag_id: 't1' } });
  }
  await db.post.create({ data: { id: 'p3', author_id: 'u2', title: 'p3' } });
  await db.comment.create({ data: { id: 'p3_c1', post_id: 'p3', author_id: 'u1', body: 'by u1' } });
}

function suite(name: string, open: () => Promise<LiveDb | null>) {
  describe(`cascade walker — ${name}`, () => {
    let live: LiveDb | null;
    let db: any;
    beforeEach(async () => {
      live = await open();
      db = live?.db;
      if (db) await seed(db);
    });
    afterEach(async () => { await live?.close(); });

    it('delete cascades through two levels and the join table, and nulls SetNull children', async () => {
      if (!db) return;
      await db.user.delete({ where: { id: 'u1' } });
      expect(await db.user.count({ where: { id: 'u1' } })).toBe(0);
      expect(await db.profile.count({ where: { user_id: 'u1' } })).toBe(0);
      expect(await db.post.count({ where: { author_id: 'u1' } })).toBe(0);
      expect(await db.comment.count({ where: { post_id: { in: ['p1', 'p2'] } } })).toBe(0);
      expect(await db.postTag.count({ where: { post_id: { in: ['p1', 'p2'] } } })).toBe(0);
      // u2's post survives; u1's comment on it loses its author.
      const c = await db.comment.findUnique({ where: { id: 'p3_c1' } });
      expect(c).not.toBeNull();
      expect(c.author_id ?? null).toBeNull();
      expect(await db.tag.count()).toBe(2);
    });

    it('deleteMany cascades for every matched row', async () => {
      if (!db) return;
      const r = await db.post.deleteMany({ where: { author_id: 'u1' } });
      expect(r.count).toBe(2);
      expect(await db.comment.count()).toBe(1);
      expect(await db.postTag.count()).toBe(0);
    });

    it('deleting a tag removes its join rows only', async () => {
      if (!db) return;
      await db.tag.delete({ where: { id: 't1' } });
      expect(await db.postTag.count()).toBe(0);
      expect(await db.post.count()).toBe(3);
    });

    it('a nested delete cascades too', async () => {
      if (!db) return;
      await db.user.update({ where: { id: 'u1' }, data: { posts: { delete: { id: 'p1' } } } });
      expect(await db.post.count({ where: { id: 'p1' } })).toBe(0);
      expect(await db.comment.count({ where: { post_id: 'p1' } })).toBe(0);
      expect(await db.postTag.count({ where: { post_id: 'p1' } })).toBe(0);
      expect(await db.comment.count({ where: { post_id: 'p2' } })).toBe(2);
    });

    it('Restrict blocks the delete and leaves the tree untouched', async () => {
      if (!db) return;
      await db.badge.create({ data: { id: 'b1', user_id: 'u1' } });
      await expect(db.user.delete({ where: { id: 'u1' } })).rejects.toMatchObject({ code: 'P2003' });
      expect(await db.user.count({ where: { id: 'u1' } })).toBe(1);
      expect(await db.post.count({ where: { author_id: 'u1' } })).toBe(2);
      expect(await db.comment.count()).toBe(5);
    });

    it('a delete with no match is still a not-found', async () => {
      if (!db) return;
      await expect(db.user.delete({ where: { id: 'nope' } })).rejects.toMatchObject({ code: 'P2025' });
      expect(await db.user.deleteMany({ where: { id: 'nope' } })).toEqual({ count: 0 });
    });

    it('returns the deleted row', async () => {
      if (!db) return;
      const u = await db.user.delete({ where: { id: 'u2' } });
      expect(u.id).toBe('u2');
      expect(u.email).toBe('u2@x');
      expect(await db.post.count({ where: { id: 'p3' } })).toBe(0);
    });

    it('runs inside the caller\'s transaction and rolls back with it', async () => {
      if (!db) return;
      if (live?.transactional === false) return;
      await expect(db.$transaction(async (tx: any) => {
        await tx.user.delete({ where: { id: 'u1' } });
        throw new Error('undo');
      })).rejects.toThrow('undo');
      expect(await db.user.count({ where: { id: 'u1' } })).toBe(1);
      expect(await db.comment.count()).toBe(5);
    });
  });
}

suite('duckdb', () => openDuckdb(blogSchema()));
suite('mongo', () => openMongo(blogSchema()));
suite('indexeddb', () => openIndexedDb(blogSchema()));
