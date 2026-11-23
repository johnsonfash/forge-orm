// Nested writes inside update(): `update`, `updateMany` and `upsert` were
// accepted by the types and silently ignored; `delete` and `deleteMany` were
// not scoped to the parent, so `posts: { deleteMany: {} }` emptied the table.

import { blogSchema, openDuckdb, openMongo, openSqlite, type LiveDb } from './_live-dbs';
import { setActiveSchema } from '../schema/active';

const sch = blogSchema();

function suite(name: string, open: () => Promise<LiveDb | null>) {
  describe(`nested update — ${name}`, () => {
    let live: LiveDb | null;
    let db: any;
    beforeEach(async () => {
      setActiveSchema(sch as never);
      live = await open();
      db = live?.db;
      if (!db) return;
      await db.user.createMany({ data: [{ id: 'u1', email: 'u1@x', name: 'One' }, { id: 'u2', email: 'u2@x', name: 'Two' }] });
      await db.post.createMany({ data: [
        { id: 'p1', author_id: 'u1', title: 'a', views: 1 },
        { id: 'p2', author_id: 'u1', title: 'b', views: 2 },
        { id: 'p3', author_id: 'u1', title: 'c', views: 3 },
        { id: 'q1', author_id: 'u2', title: 'other', views: 9 },
      ] });
    });
    afterEach(async () => { await live?.close(); });

    it('update, upsert (both paths) and deleteMany in one call, scoped to the parent', async () => {
      if (!db) return;
      const u = await db.user.update({
        where: { id: 'u1' },
        data: {
          name: 'Renamed',
          posts: {
            update: [{ where: { id: 'p1' }, data: { title: 'A' } }],
            upsert: [
              { where: { id: 'p2' }, create: { id: 'p2', title: 'never' }, update: { views: 20 } },
              { where: { id: 'p9' }, create: { id: 'p9', title: 'new' }, update: { views: 0 } },
            ],
            deleteMany: { views: { gte: 3 } },
          },
        },
        include: { posts: { orderBy: { id: 'asc' } } },
      });
      expect(u.name).toBe('Renamed');
      // Updates run before deletes (Prisma's order), so p2 at 20 views goes too.
      expect(u.posts.map((p: any) => [p.id, p.title, p.views])).toEqual([['p1', 'A', 1], ['p9', 'new', 0]]);
      expect((await db.post.findUnique({ where: { id: 'q1' } })).views).toBe(9);
    });

    it('deleteMany: {} removes this parent\'s children only', async () => {
      if (!db) return;
      await db.user.update({ where: { id: 'u1' }, data: { posts: { deleteMany: {} } } });
      expect(await db.post.count({ where: { author_id: 'u1' } })).toBe(0);
      expect(await db.post.count({ where: { author_id: 'u2' } })).toBe(1);
    });

    it('delete of another parent\'s child is not found, and nothing is removed', async () => {
      if (!db) return;
      await expect(db.user.update({ where: { id: 'u1' }, data: { posts: { delete: { id: 'q1' } } } })).rejects.toThrow();
      expect(await db.post.count({ where: { id: 'q1' } })).toBe(1);
    });

    it('create, update and delete hand back the relations they include', async () => {
      if (!db) return;
      const c = await db.user.create({ data: { id: 'u3', email: 'u3@x', name: 'Three', posts: { create: [{ id: 'r1', title: 'r' }] } }, include: { posts: true } });
      expect(c.posts.map((p: any) => p.id)).toEqual(['r1']);
      const u = await db.post.update({ where: { id: 'p1' }, data: { title: 'z' }, select: { title: true, author: { select: { name: true } } } });
      expect(u).toEqual({ title: 'z', author: { name: 'One' } });
      const n = await db.user.update({ where: { id: 'u1' }, data: { name: 'N' }, include: { _count: { select: { posts: true } } } });
      expect(n._count).toEqual({ posts: 3 });
      const d = await db.post.delete({ where: { id: 'r1' }, include: { author: true } });
      expect(d.author.id).toBe('u3');
    });

    it('updateMany and deleteMany filter through a relation', async () => {
      if (!db) return;
      await db.comment.create({ data: { id: 'c1', post_id: 'p1', body: 'x' } });
      expect(await db.post.updateMany({ where: { author: { is: { email: 'u1@x' } } }, data: { views: 5 } })).toEqual({ count: 3 });
      expect((await db.post.findUnique({ where: { id: 'q1' } })).views).toBe(9);
      // The walk removes p1's comment first; the posts it matched still go.
      expect(await db.post.deleteMany({ where: { comments: { some: { body: 'x' } } } })).toEqual({ count: 1 });
      expect(await db.post.count({ where: { id: 'p1' } })).toBe(0);
      expect(await db.post.deleteMany({ where: { author: { is: { name: 'One' } }, comments: { none: {} } } })).toEqual({ count: 2 });
      expect(await db.post.count()).toBe(1);
    });

    it('groupBy filters through a relation', async () => {
      if (!db) return;
      const g = await db.post.groupBy({ by: ['author_id'], where: { author: { is: { name: 'Two' } } }, _count: { _all: true }, _sum: { views: true } });
      expect(g.map((r: any) => [r.author_id, Number(r._count._all), Number(r._sum.views)])).toEqual([['u2', 1, 9]]);
    });

    it('updateMany and the owning to-one update', async () => {
      if (!db) return;
      await db.user.update({ where: { id: 'u1' }, data: { posts: { updateMany: { where: { views: { lt: 3 } }, data: { views: 0 } } } } });
      expect((await db.post.findMany({ where: { author_id: 'u1' }, orderBy: { id: 'asc' } })).map((p: any) => p.views)).toEqual([0, 0, 3]);
      await db.post.update({ where: { id: 'p1' }, data: { author: { update: { name: 'Via post' } } } });
      expect((await db.user.findUnique({ where: { id: 'u1' } })).name).toBe('Via post');
      expect((await db.user.findUnique({ where: { id: 'u2' } })).name).toBe('Two');
    });
  });
}

suite('sqlite', () => openSqlite(sch));
suite('duckdb', () => openDuckdb(sch));
suite('mongo', () => openMongo(sch));
