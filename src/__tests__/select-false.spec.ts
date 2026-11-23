// `select: false` on a single write: the write happens, nothing is read back,
// and a miss still throws (P2025), as without it.

import { blogSchema, openDuckdb, openMongo, openSqlite, type LiveDb } from './_live-dbs';
import { setActiveSchema } from '../schema/active';

const sch = blogSchema();

function suite(name: string, open: () => Promise<LiveDb | null>, returning: boolean) {
  describe(`select: false — ${name}`, () => {
    let live: LiveDb | null;
    let db: any;
    beforeAll(async () => {
      setActiveSchema(sch as never);
      live = await open();
      db = live?.db;
      if (!db) return;
      await db.user.create({ data: { id: 'u1', email: 'u1@x', name: 'One' } });
      await db.post.create({ data: { id: 'p1', author_id: 'u1', title: 't', views: 1 } });
    });
    afterAll(async () => { await live?.close(); });

    it('update writes and resolves to null, without RETURNING', async () => {
      if (!db) return;
      live!.log.length = 0;
      expect(await db.post.update({ where: { id: 'p1' }, data: { views: { increment: 2 } }, select: false })).toBeNull();
      if (returning) expect(live!.log.join('\n')).not.toMatch(/RETURNING/);
      expect((await db.post.findUnique({ where: { id: 'p1' } })).views).toBe(3);
    });

    it('a no-op update still counts as a match', async () => {
      if (!db) return;
      expect(await db.post.update({ where: { id: 'p1' }, data: { views: 3 }, select: false })).toBeNull();
    });

    it('a miss throws', async () => {
      if (!db) return;
      await expect(db.post.update({ where: { id: 'nope' }, data: { views: 1 }, select: false })).rejects.toThrow();
      await expect(db.post.delete({ where: { id: 'nope' }, select: false })).rejects.toThrow();
    });

    it('with nested writes keyed by the filter, the parent is not read either', async () => {
      if (!db) return;
      live!.log.length = 0;
      expect(await db.user.update({ where: { id: 'u1' }, data: { name: 'N', posts: { update: [{ where: { id: 'p1' }, data: { title: 'T' } }], create: [{ id: 'p9', title: 'new' }] } }, select: false })).toBeNull();
      expect((await db.post.findUnique({ where: { id: 'p1' } })).title).toBe('T');
      expect((await db.post.findUnique({ where: { id: 'p9' } })).author_id).toBe('u1');
      if (returning) expect(live!.log.join('\n')).not.toMatch(/RETURNING/);
      await expect(db.user.update({ where: { id: 'nobody' }, data: { posts: { create: [{ id: 'px', title: 'x' }] } }, select: false })).rejects.toThrow();
      expect(await db.post.count({ where: { id: 'px' } })).toBe(0);
      await db.post.delete({ where: { id: 'p9' } });
    });

    it('upsert on both paths, create and delete', async () => {
      if (!db) return;
      expect(await db.user.upsert({ where: { email: 'u1@x' }, create: { id: 'zz', email: 'u1@x', name: 'no' }, update: { name: 'Up' }, select: false })).toBeNull();
      expect(await db.user.upsert({ where: { email: 'u2@x' }, create: { id: 'u2', email: 'u2@x', name: 'New' }, update: { prefs: { theme: 't', score: 1 } }, select: false })).toBeNull();
      expect((await db.user.findMany({ orderBy: { id: 'asc' } })).map((u: any) => u.name)).toEqual(['Up', 'New']);
      expect(await db.post.create({ data: { id: 'p2', author_id: 'u2', title: 'x' }, select: false })).toBeNull();
      expect(await db.post.delete({ where: { id: 'p2' }, select: false })).toBeNull();
      expect(await db.post.count({ where: { id: 'p2' } })).toBe(0);
    });
  });
}

suite('sqlite', () => openSqlite(sch), true);
suite('duckdb', () => openDuckdb(sch), true);
suite('mongo', () => openMongo(sch), false);
