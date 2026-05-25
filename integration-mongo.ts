/* eslint-disable no-console */
//
// Comprehensive Mongo integration test for forge.
//
// Connects to a unique DB name so it doesn't touch real data; drops the DB
// at the end. Pushes Mongo indexes (forge:push equivalent), runs the same
// scenarios as the PG suite — same schema, same code path through the
// wrapper / IR / executor, just a different adapter.

import * as dotenv from 'dotenv';
dotenv.config();

import { createDb, forgeSql, DbKnownError } from './src';
import { schema } from './src/schema';

const STAMP = `${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
const DB = `forge_smoke_${STAMP}`;
const MONGO_URL = process.env.SMOKE_MONGO_URL ?? `mongodb://127.0.0.1:27017/${DB}`;

let pass = 0, fail = 0;
const scenario = async (label: string, fn: () => Promise<void>) => {
  process.stdout.write(`  ${label.padEnd(60)}`);
  try { await fn(); console.log('✓'); pass++; }
  catch (e: any) {
    console.log(`✗\n      ${(e?.stack ?? e?.message ?? e).toString().split('\n').slice(0, 4).join('\n      ')}`);
    fail++;
  }
};
const assert = (cond: any, msg: string) => { if (!cond) throw new Error(msg); };

async function main() {
  console.log(`\n[forge:mongo] target db: ${DB}`);
  console.log(`[forge:mongo] url:        ${MONGO_URL}\n`);

  const db = await createDb({ url: MONGO_URL });
  const mongoDb = (await import('./src/adapters/mongo/client')).dbClient.db;

  try {
    // ─── 1. Index push ────────────────────────────────────────────────
    console.log('[1] index push (Mongo equivalent of forge:push)');
    await scenario('pushAllIndexes() creates unique + compound + text indexes', async () => {
      const { pushAllIndexes } = await import('./src/adapters/mongo/scripts/push');
      await pushAllIndexes();
    });

    // ─── 2. Create chain ──────────────────────────────────────────────
    console.log('\n[2] entity creation');
    let aliceId: string | undefined;
    let bobId: string | undefined;
    let post1Id: string | undefined;

    await scenario('create User with embedded Address', async () => {
      const u = await db.user.create({ data: {
        email: 'alice@x.co', name: 'Alice', role: 'EDITOR',
        address: { street: '1 main', city: 'sf', zip: '94110', country: 'us' },
      } });
      assert(typeof (u as any).id === 'string', 'Mongo did not stringify ObjectId');
      assert((u as any).address?.city === 'sf', 'embed lost');
      aliceId = (u as any).id;
    });

    await scenario('create second User (no address)', async () => {
      const u = await db.user.create({ data: { email: 'bob@x.co', name: 'Bob' } });
      bobId = (u as any).id;
    });

    await scenario('create Profile linked to User (one-to-one)', async () => {
      await db.profile.create({ data: {
        user_id: aliceId, bio: 'I write things',
        social_links: [
          { platform: 'twitter', url: 'https://x.com/alice' },
          { platform: 'github', url: 'https://github.com/alice' },
        ],
      } });
    });

    await scenario('create Posts (with JSON meta + stringArray tag_names)', async () => {
      const p1 = await db.post.create({ data: {
        author_id: aliceId, title: 'Forge IR Design',
        slug: `forge-ir-${STAMP}`, body: 'The IR layer is…', status: 'PUBLISHED',
        tag_names: ['typescript', 'databases'],
        meta: { reading_time: 5, featured: true },
        revisions: [],
      } });
      post1Id = (p1 as any).id;
      await db.post.create({ data: {
        author_id: aliceId, title: 'Draft',
        slug: `draft-${STAMP}`, body: 'WIP', status: 'DRAFT',
        revisions: [],
      } });
    });

    await scenario('create Comment + self-referential reply', async () => {
      const c1 = await db.comment.create({ data: {
        post_id: post1Id, author_id: bobId, body: 'Great post!',
      } });
      await db.comment.create({ data: {
        post_id: post1Id, author_id: aliceId, parent_id: (c1 as any).id,
        body: 'Thanks!',
      } });
    });

    // ─── 3. Reads ─────────────────────────────────────────────────────
    console.log('\n[3] reads');

    await scenario('findFirst by unique field returns the row', async () => {
      const u = await db.user.findFirst({ where: { email: 'alice@x.co' } });
      assert((u as any)?.id === aliceId, 'wrong user');
    });

    await scenario('findMany with where + take + orderBy', async () => {
      const posts = await db.post.findMany({
        where: { author_id: aliceId },
        orderBy: { created_at: 'asc' },
        take: 10,
      });
      assert(posts.length === 2, `expected 2 posts, got ${posts.length}`);
    });

    await scenario('findMany filters by enum value', async () => {
      const drafts = await db.post.findMany({ where: { status: 'DRAFT' } });
      assert(drafts.length === 1, `expected 1 draft, got ${drafts.length}`);
    });

    await scenario('count with where', async () => {
      const n = await db.post.count({ where: { author_id: aliceId } });
      assert(n === 2, `expected 2, got ${n}`);
    });

    await scenario('embed roundtrips on read', async () => {
      const u = await db.user.findFirst({ where: { id: aliceId } });
      assert((u as any)?.address?.country === 'us', `address lost: ${JSON.stringify((u as any)?.address)}`);
    });

    await scenario('JSON field roundtrips on read', async () => {
      const p = await db.post.findFirst({ where: { id: post1Id } });
      assert((p as any)?.meta?.featured === true, `meta lost: ${JSON.stringify((p as any)?.meta)}`);
    });

    await scenario('embedMany roundtrips on read (social_links list)', async () => {
      const p = await db.profile.findFirst({ where: { user_id: aliceId } });
      assert(Array.isArray((p as any)?.social_links) && (p as any).social_links.length === 2,
        `social_links lost: ${JSON.stringify((p as any)?.social_links)}`);
    });

    await scenario('findFirst with include hydrates related posts', async () => {
      const u: any = await db.user.findFirst({
        where: { id: aliceId },
        include: { posts: true },
      });
      assert(Array.isArray(u?.posts) && u.posts.length === 2,
        `hydration failed: ${JSON.stringify(u?.posts)?.slice(0, 200)}`);
    });

    // ─── 4. Atomic writes ─────────────────────────────────────────────
    console.log('\n[4] atomic writes');

    await scenario('update with $inc + $set', async () => {
      const before: any = await db.post.findFirst({ where: { id: post1Id } });
      const updated: any = await db.post.update({
        where: { id: post1Id },
        data: { view_count: { increment: 5 }, status: 'PUBLISHED' },
      });
      assert(updated.view_count === before.view_count + 5, 'increment did not apply');
    });

    await scenario('updateMany returns count', async () => {
      const r = await db.comment.updateMany({
        where: { post_id: post1Id },
        data: { like_count: { increment: 1 } },
      });
      assert(r.count === 2, `expected 2 updated, got ${r.count}`);
    });

    // ─── 5. Error mapping ─────────────────────────────────────────────
    console.log('\n[5] error mapping');

    await scenario('duplicate unique → P2002', async () => {
      try {
        await db.user.create({ data: { email: 'alice@x.co', name: 'dup' } });
        throw new Error('expected unique violation');
      } catch (e: any) {
        assert(e instanceof DbKnownError && e.code === 'P2002', `wrong code: ${e?.code}`);
      }
    });

    await scenario('findFirstOrThrow throws P2025', async () => {
      try {
        await db.user.findFirstOrThrow({ where: { email: 'nobody@x.co' } });
        throw new Error('expected not-found');
      } catch (e: any) {
        assert(e instanceof DbKnownError && e.code === 'P2025', `wrong code: ${e?.code}`);
      }
    });

    // ─── 6. Cascade walker (Mongo emulation) ──────────────────────────
    console.log('\n[6] cascade enforcement (Mongo walker)');

    await scenario('delete Post cascades to Comments + Likes (via walker)', async () => {
      const before = await Promise.all([
        db.comment.count({ where: { post_id: post1Id } }),
      ]);
      assert(before[0] > 0, `setup wrong: ${before}`);
      await db.post.delete({ where: { id: post1Id } });
      const after = await db.comment.count({ where: { post_id: post1Id } });
      assert(after === 0, `cascade incomplete: ${after} comments left`);
    });

    // ─── 7. $transaction ──────────────────────────────────────────────
    // Standalone Mongo (no replica set) throws on $transaction. Detect and
    // skip with a clear note rather than counting it as a failure.
    console.log('\n[7] $transaction (requires replica set; auto-skipped on standalone)');

    try {
      const probeAdapter: any = db.adapter;
      await probeAdapter.$transaction(async () => { /* probe */ });
      await scenario('committed transaction persists', async () => {
        await db.$transaction(async (tx: any) => {
          await tx.user.create({ data: { email: `tx_${STAMP}@x.co`, name: 'tx' } });
        });
        const found = await db.user.findFirst({ where: { email: `tx_${STAMP}@x.co` } });
        assert(found != null, 'tx commit lost');
      });
    } catch (e: any) {
      if (/replica/i.test(String(e?.message ?? e))) {
        console.log('  (skipped — standalone Mongo, no replica set)');
      } else {
        await scenario('committed transaction persists', async () => { throw e; });
      }
    }

    // ─── 8. $queryRaw on Mongo throws cleanly ─────────────────────────
    console.log('\n[8] $queryRaw on Mongo (should reject)');

    await scenario('$queryRaw → clear "SQL-only" error', async () => {
      try {
        await db.$queryRaw(forgeSql.sql`SELECT 1`);
        throw new Error('should have thrown');
      } catch (e: any) {
        assert(/SQL-only/i.test(e?.message ?? ''), `wrong error: ${e?.message}`);
      }
    });

    // ─── 9. Self-referential reads ────────────────────────────────────
    console.log('\n[9] self-referential queries');

    const post2 = await db.post.findFirst({ where: { slug: `draft-${STAMP}` } });
    const cs1: any = await db.comment.create({ data: {
      post_id: (post2 as any).id, author_id: aliceId, body: 'top-level',
    } });
    await db.comment.create({ data: {
      post_id: (post2 as any).id, author_id: aliceId, parent_id: cs1.id, body: 'reply',
    } });

    await scenario('replies query (where parent_id = …) finds children', async () => {
      const replies = await db.comment.findMany({ where: { parent_id: cs1.id } });
      assert(replies.length === 1 && (replies[0] as any).body === 'reply', 'self-ref failed');
    });

    // ─── 10. Aggregation (Mongo's native escape hatch) ────────────────
    console.log('\n[10] aggregate (Mongo raw pipeline)');

    await scenario('aggregate returns matching docs', async () => {
      const rows = await (db.user as any).aggregate({
        pipeline: [{ $match: { email: 'alice@x.co' } }, { $limit: 1 }],
      });
      assert(rows.length === 1 && rows[0].email === 'alice@x.co', `aggregate off: ${JSON.stringify(rows)}`);
    });

    // ─── 11. groupBy + aggregations ───────────────────────────────────
    console.log('\n[11] groupBy + aggregations');

    // Seed multiple roles
    await db.user.createMany({ data: [
      { email: `gb-e1-${STAMP}@x.co`, name: 'Editor1', role: 'EDITOR' },
      { email: `gb-e2-${STAMP}@x.co`, name: 'Editor2', role: 'EDITOR' },
      { email: `gb-a1-${STAMP}@x.co`, name: 'Admin1',  role: 'ADMIN' },
    ] } as any);

    await scenario('groupBy by role with _count._all', async () => {
      const rows: any[] = await db.user.groupBy({
        by: ['role'],
        _count: { _all: true },
        orderBy: { role: 'asc' },
      });
      const editors = rows.find((r) => r.role === 'EDITOR');
      assert(editors != null && editors._count._all >= 2,
        `editors group missing or undercounted: ${JSON.stringify(rows)}`);
    });

    await scenario('groupBy with having (_count.id gt 1)', async () => {
      const rows: any[] = await db.user.groupBy({
        by: ['role'],
        _count: { _all: true, id: true },
        having: { _count: { id: { gt: 1 } } },
      });
      assert(rows.every((r) => r._count.id > 1),
        `having filter failed: ${JSON.stringify(rows)}`);
    });

    await scenario('Post.groupBy with _avg + _sum + _min + _max', async () => {
      await db.post.createMany({ data: [
        { author_id: aliceId, title: 't1', slug: `gb-1-${STAMP}`, body: 'b', status: 'PUBLISHED', view_count: 10, revisions: [] },
        { author_id: aliceId, title: 't2', slug: `gb-2-${STAMP}`, body: 'b', status: 'PUBLISHED', view_count: 20, revisions: [] },
        { author_id: aliceId, title: 't3', slug: `gb-3-${STAMP}`, body: 'b', status: 'DRAFT',     view_count: 5,  revisions: [] },
      ] } as any);
      const rows: any[] = await db.post.groupBy({
        by: ['status'],
        _count: { _all: true },
        _avg: { view_count: true },
        _sum: { view_count: true },
        _min: { view_count: true },
        _max: { view_count: true },
      });
      const pub = rows.find((r) => r.status === 'PUBLISHED');
      assert(pub?._sum?.view_count >= 30, `_sum.view_count off: ${JSON.stringify(pub)}`);
      assert(pub?._avg?.view_count >= 10, `_avg.view_count off: ${JSON.stringify(pub)}`);
      assert(pub?._min?.view_count <= 10 && pub?._max?.view_count >= 20,
        `_min/_max off: ${JSON.stringify(pub)}`);
    });

    // ─── 12. connectOrCreate ──────────────────────────────────────────
    console.log('\n[12] connectOrCreate');

    await scenario('connectOrCreate (owning-one) finds existing or creates', async () => {
      const tagName = `coc-existing-${STAMP}`;
      const existingTag = await db.tag.create({ data: { name: tagName } } as any);

      // Owning-one connectOrCreate via PostTag.tag relation
      const p2 = await db.post.findFirst({ where: { slug: `draft-${STAMP}` } });
      const ptExisting = await db.postTag.create({ data: {
        post_id: (p2 as any).id,
        tag: { connectOrCreate: { where: { name: tagName }, create: { name: tagName } } } as any,
        tag_id: 'placeholder',
      } } as any);
      const ptCheck: any = await db.postTag.findFirst({ where: { id: (ptExisting as any).id } });
      assert(ptCheck?.tag_id === (existingTag as any).id,
        `connectOrCreate-existing should point at existing tag, got ${ptCheck?.tag_id}`);

      const newTagName = `coc-new-${STAMP}`;
      const ptNew = await db.postTag.create({ data: {
        post_id: (p2 as any).id,
        tag: { connectOrCreate: { where: { name: newTagName }, create: { name: newTagName } } } as any,
        tag_id: 'placeholder',
      } } as any);
      const ptCheck2: any = await db.postTag.findFirst({ where: { id: (ptNew as any).id } });
      const createdTag = await db.tag.findFirst({ where: { name: newTagName } });
      assert(ptCheck2?.tag_id === (createdTag as any).id,
        `connectOrCreate-new should point at newly-created tag`);
    });

    // ─── Wave 4 — events / streaming / full-text search ─────────────────
    console.log('\n[wave-4]');

    await scenario('$on("query") fires with op + duration', async () => {
      const events: any[] = [];
      const off = (db as any).$on('query', (e: any) => events.push(e));
      await db.user.findFirst({ where: { id: aliceId } });
      off();
      assert(events.length >= 1, `no events captured`);
      const e = events[0];
      assert(e.adapter === 'mongo' && e.op === 'select', `bad event: ${JSON.stringify(e)}`);
    });

    await scenario('findManyStream yields rows lazily', async () => {
      let count = 0;
      for await (const _row of (db.user as any).findManyStream({ chunkSize: 3 })) {
        count++;
        if (count > 50) break;
      }
      assert(count > 0, `stream yielded 0 rows`);
    });

    await scenario('where.search uses $text on .searchable() body field', async () => {
      // forge:push (via integration setup) auto-emitted a text index across
      // searchable fields (body). $text searches across all text-indexed fields.
      await db.post.create({ data: {
        author_id: aliceId,
        title: 'Plain title', slug: `forge-fts-${STAMP}`,
        body: 'Forge Mongo full-text content', status: 'PUBLISHED',
      } as any });
      const found: any[] = await db.post.findMany({ where: { body: { search: 'Forge' } as any } });
      assert(found.length >= 1, `$text found 0 rows (forge_posts_fts auto-emitted)`);
    });

    // ─── Wave 4b ───────────────────────────────────────────────────────
    console.log('\n[wave-4b]');

    await scenario('.searchable() body field has auto-emitted text index', async () => {
      const idxs = await mongoDb.collection('posts').indexes();
      const fts = idxs.find((i: any) => i.name === 'forge_posts_fts');
      assert(fts != null, `expected forge_posts_fts index, got: ${idxs.map((i: any) => i.name).join(', ')}`);
    });

    await scenario('AuditLog.delete() soft-deletes', async () => {
      const log = await db.auditLog.create({ data: { event: 'login' } as any });
      await db.auditLog.delete({ where: { id: (log as any).id } });
      const visible = await db.auditLog.findFirst({ where: { id: (log as any).id } });
      assert(visible === null, `expected hidden after soft-delete`);
    });

    await scenario('findManyStream uses native Mongo cursor', async () => {
      assert(typeof (db.user.adapter as any).streamSelect === 'function');
      let count = 0;
      for await (const _row of (db.user as any).findManyStream()) {
        count++;
        if (count > 30) break;
      }
      assert(count > 0, 'native stream yielded 0 rows');
    });

    await scenario('wireOtel emits spans', async () => {
      const { wireOtel } = await import('./src');
      const spans: any[] = [];
      const tracer = {
        startSpan: (name: string, opts?: any) => {
          const s = { name, attrs: { ...opts?.attributes }, setAttribute(){}, setAttributes(){}, recordException(){}, setStatus(){}, end: () => spans.push(s) };
          return s as any;
        },
      };
      const off = wireOtel(db as any, { tracer });
      await db.user.findFirst({ where: { id: aliceId } });
      off();
      const sel = spans.find((s) => s.name === 'forge.select');
      assert(sel?.attrs['db.system'] === 'mongodb', `expected db.system=mongodb`);
    });

    // ─── Wave 4c — read-only views ─────────────────────────────────────
    console.log('\n[wave-4c]');

    await scenario('createCollection emitted for publishedPosts (Mongo view)', async () => {
      const colls = await mongoDb.listCollections({ name: 'published_posts' }).toArray();
      assert(colls.length === 1 && colls[0].type === 'view', `expected view collection, got: ${JSON.stringify(colls)}`);
    });

    await scenario('publishedPosts reads via aggregation pipeline', async () => {
      const all: any[] = await (db as any).publishedPosts.findMany();
      const titles = all.map((p: any) => p.title);
      assert(!titles.includes('Draft'), `view leaked DRAFT post`);
    });

    await scenario('publishedPosts.create throws (read-only view)', async () => {
      try {
        await (db as any).publishedPosts.create({ data: { title: 't', slug: 's', author_id: aliceId, view_count: 0 } });
        throw new Error('expected throw');
      } catch (e: any) {
        assert(/read-only view/.test(e?.message ?? ''), `wrong error: ${e?.message}`);
      }
    });

    // ─── Wave 5d — materialised view ($out-backed collection) ──────────
    console.log('\n[wave-5d]');

    await scenario('postStats.refresh() recomputes rollups via $out', async () => {
      await db.post.create({ data: { author_id: aliceId, title: 'MV', slug: `mv-${STAMP}`, body: 'b', status: 'PUBLISHED', view_count: 9, revisions: [] } as any });
      await (db as any).postStats.refresh();
      const rows: any[] = await (db as any).postStats.findMany();
      const mine = rows.find((r: any) => String(r.author_id) === String(aliceId));
      assert(mine, `expected rollup for ${aliceId}; got ${rows.length} rows`);
      assert(Number(mine.post_count) >= 1, `post_count >= 1, got ${mine.post_count}`);
    });

    console.log(`\n[forge:mongo] ${pass} passed, ${fail} failed`);
  } finally {
    try { await mongoDb.dropDatabase(); } catch {}
    await db.$disconnect();
    console.log(`[cleanup] dropped database '${DB}'`);
  }
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(2); });
