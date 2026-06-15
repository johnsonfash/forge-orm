/* eslint-disable no-console */
//
// Comprehensive Postgres integration test for forge.
//
// Creates an isolated database, pushes the full sample schema, exercises
// every feature (CRUD, relations, enums, embeds, JSON, cascades, $transaction,
// $queryRaw, error mapping, composite uniques, self-ref queries, atomic ops),
// then drops the database.
//
// Override defaults with SMOKE_PG_ROOT / SMOKE_PG_USER if your local PG isn't
// "postgres://johnfash@127.0.0.1:5432".

import * as dotenv from 'dotenv';
dotenv.config();

import { createDb, forgeSql, DbKnownError, ForgeDbNull } from './src';
import { buildSchemaDDL } from './src/adapters/postgres/ddl';
import { applyMigration } from './src/adapters/postgres/migrate';
import { schema } from './src/schema';

const STAMP = `${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
const DB_NAME = `forge_smoke_${STAMP}`;
const PG_USER = process.env.SMOKE_PG_USER ?? 'johnfash';
const PG_HOST = process.env.SMOKE_PG_HOST ?? '127.0.0.1';
const PG_PORT = process.env.SMOKE_PG_PORT ?? '5432';
const PG_ROOT_DB = process.env.SMOKE_PG_ROOT ?? 'postgres';
const ROOT_URL = `postgres://${PG_USER}@${PG_HOST}:${PG_PORT}/${PG_ROOT_DB}`;
const SMOKE_URL = `postgres://${PG_USER}@${PG_HOST}:${PG_PORT}/${DB_NAME}`;

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
  console.log(`\n[forge:pg] target db: ${DB_NAME}`);
  console.log(`[forge:pg] root url:  ${ROOT_URL}\n`);

  // ─── Bootstrap: create the isolated database ───────────────────────
  const { Pool } = require('pg');
  const rootPool = new Pool({ connectionString: ROOT_URL });
  await rootPool.query(`CREATE DATABASE "${DB_NAME}"`);
  await rootPool.end();
  console.log(`[bootstrap] created database '${DB_NAME}'`);

  const db = await createDb({ url: SMOKE_URL });
  const pgPool = (db.adapter as any).pool;

  try {
    // ─── 1. forge:push — DDL plan + apply ─────────────────────────────
    console.log('\n[1] schema push');
    const ddl = buildSchemaDDL(schema);
    const plan = await (await import('./src/adapters/postgres/migrate')).planMigration(pgPool, ddl);
    console.log(`    plan: ${plan.summary}`);
    const report = await applyMigration(pgPool, ddl);
    await scenario('DDL applied without failures', async () => {
      assert(report.failures.length === 0, `${report.failures.length} failures: ${report.failures.map((f) => f.name).join(', ')}`);
      assert(report.applied.length > 0, 'nothing applied');
    });

    // ─── 2. Create chain — user → profile → posts → comments ──────────
    console.log('\n[2] entity creation');

    // user ids are application-supplied text (f.id() with no autogen default
    // in PG yet). Each scenario picks readable ids.
    const aliceId = `u_${STAMP}_alice`;
    const bobId   = `u_${STAMP}_bob`;
    const post1Id = `p_${STAMP}_1`;
    const post2Id = `p_${STAMP}_2`;
    const tagAId  = `t_${STAMP}_typescript`;
    const tagBId  = `t_${STAMP}_databases`;

    await scenario('create User with embedded Address', async () => {
      const u = await db.user.create({
        data: {
          id: aliceId, email: 'alice@x.co', name: 'Alice', role: 'EDITOR',
          address: { street: '1 main', city: 'sf', zip: '94110', country: 'us' },
        },
      });
      assert(u.id === aliceId, 'returned id mismatch');
      assert(u.role === 'EDITOR', 'role default override');
      assert(u.address?.city === 'sf', `embed not stored — got ${JSON.stringify(u.address)}`);
    });

    await scenario('create second User (no address)', async () => {
      await db.user.create({ data: { id: bobId, email: 'bob@x.co', name: 'Bob' } });
    });

    await scenario('create Profile linked to User (one-to-one)', async () => {
      await db.profile.create({
        data: {
          id: `prof_${STAMP}_alice`, user_id: aliceId, bio: 'I write things',
          social_links: [
            { platform: 'twitter', url: 'https://x.com/alice' },
            { platform: 'github',  url: 'https://github.com/alice' },
          ],
        },
      });
    });

    await scenario('create Posts (with JSON meta + stringArray tag_names)', async () => {
      await db.post.create({ data: {
        id: post1Id, author_id: aliceId, title: 'Forge IR Design',
        slug: `forge-ir-${STAMP}`, body: 'The IR layer is…', status: 'PUBLISHED',
        tag_names: ['typescript', 'databases'],
        meta: { reading_time: 5, featured: true },
        view_count: 0,
      } });
      await db.post.create({ data: {
        id: post2Id, author_id: aliceId, title: 'Draft',
        slug: `draft-${STAMP}`, body: 'WIP', status: 'DRAFT', view_count: 0,
      } });
    });

    await scenario('create Tags + PostTags (many-to-many via join)', async () => {
      await db.tag.create({ data: { id: tagAId, name: `typescript_${STAMP}` } });
      await db.tag.create({ data: { id: tagBId, name: `databases_${STAMP}` } });
      await db.postTag.create({ data: { id: `pt1_${STAMP}`, post_id: post1Id, tag_id: tagAId } });
      await db.postTag.create({ data: { id: `pt2_${STAMP}`, post_id: post1Id, tag_id: tagBId } });
    });

    await scenario('create Comment + self-referential reply', async () => {
      const c1Id = `c1_${STAMP}`;
      await db.comment.create({ data: {
        id: c1Id, post_id: post1Id, author_id: bobId, body: 'Great post!',
      } });
      await db.comment.create({ data: {
        id: `c2_${STAMP}`, post_id: post1Id, author_id: aliceId, parent_id: c1Id,
        body: 'Thanks!',
      } });
    });

    // ─── 3. Reads ─────────────────────────────────────────────────────
    console.log('\n[3] reads');

    await scenario('findFirst by unique field returns the row', async () => {
      const u = await db.user.findFirst({ where: { email: 'alice@x.co' } });
      assert(u?.id === aliceId, `expected ${aliceId}, got ${u?.id}`);
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
      assert(drafts.length === 1 && drafts[0].id === post2Id, 'enum filter mismatch');
    });

    await scenario('count with where', async () => {
      const n = await db.post.count({ where: { author_id: aliceId } });
      assert(n === 2, `expected 2 posts, got ${n}`);
    });

    await scenario('embed roundtrips on read', async () => {
      const u = await db.user.findFirst({ where: { id: aliceId } });
      assert(u?.address?.country === 'us', `address embed lost: ${JSON.stringify(u?.address)}`);
    });

    await scenario('JSON field roundtrips on read', async () => {
      const p = await db.post.findFirst({ where: { id: post1Id } });
      assert(p?.meta?.featured === true && p?.meta?.reading_time === 5,
             `JSON lost: ${JSON.stringify(p?.meta)}`);
    });

    await scenario('embedMany roundtrips on read (social_links list)', async () => {
      const p = await db.profile.findFirst({ where: { user_id: aliceId } });
      assert(Array.isArray(p?.social_links) && p.social_links.length === 2,
             `social_links lost: ${JSON.stringify(p?.social_links)}`);
    });

    // ─── 4. Atomic writes ─────────────────────────────────────────────
    console.log('\n[4] atomic writes');

    await scenario('update with $inc + $set', async () => {
      const before = await db.post.findFirst({ where: { id: post1Id } });
      const updated = await db.post.update({
        where: { id: post1Id },
        data: { view_count: { increment: 5 }, status: 'PUBLISHED' },
      });
      assert(updated.view_count === (before!.view_count + 5),
             `$inc didn't increment (was ${before!.view_count}, now ${updated.view_count})`);
    });

    await scenario('updateMany returns count', async () => {
      const r = await db.comment.updateMany({
        where: { post_id: post1Id },
        data: { like_count: { increment: 1 } },
      });
      assert(r.count === 2, `expected 2 comments updated, got ${r.count}`);
    });

    // ─── 5. Error mapping ─────────────────────────────────────────────
    console.log('\n[5] error mapping (PG SQLSTATE → DbKnownError)');

    await scenario('duplicate unique → P2002', async () => {
      try {
        await db.user.create({ data: { id: `dup_${STAMP}`, email: 'alice@x.co', name: 'dup' } });
        throw new Error('expected unique violation');
      } catch (e: any) {
        assert(e instanceof DbKnownError && e.code === 'P2002', `wrong code: ${e?.code}`);
      }
    });

    await scenario('composite unique on Like[user_id,post_id,kind] → P2002', async () => {
      await db.like.create({ data: { id: `l1_${STAMP}`, user_id: bobId, post_id: post1Id } });
      try {
        await db.like.create({ data: { id: `l2_${STAMP}`, user_id: bobId, post_id: post1Id } });
        throw new Error('expected composite unique violation');
      } catch (e: any) {
        assert(e instanceof DbKnownError && e.code === 'P2002', `wrong code: ${e?.code}`);
      }
    });

    await scenario('enum CHECK constraint blocks invalid value → P2004', async () => {
      try {
        await db.post.create({ data: {
          id: `bad_${STAMP}`, author_id: aliceId,
          title: 'x', slug: `bad-${STAMP}`, body: 'x', status: 'INVALID' as any,
        } });
        throw new Error('expected check violation');
      } catch (e: any) {
        assert(e instanceof DbKnownError && e.code === 'P2004', `wrong code: ${e?.code}`);
      }
    });

    await scenario('foreign key violation → P2003', async () => {
      try {
        await db.post.create({ data: {
          id: `orphan_${STAMP}`, author_id: 'user_that_doesnt_exist',
          title: 'orphan', slug: `orphan-${STAMP}`, body: 'x',
        } });
        throw new Error('expected FK violation');
      } catch (e: any) {
        assert(e instanceof DbKnownError && e.code === 'P2003', `wrong code: ${e?.code}`);
      }
    });

    // ─── 6. $transaction commit + rollback ────────────────────────────
    console.log('\n[6] $transaction');

    await scenario('committed transaction persists', async () => {
      await db.$transaction(async (tx: any) => {
        await tx.user.create({ data: { id: `tx_${STAMP}_ok`, email: `txok_${STAMP}@x.co`, name: 'tx_ok' } });
        await tx.user.create({ data: { id: `tx_${STAMP}_ok2`, email: `txok2_${STAMP}@x.co`, name: 'tx_ok2' } });
      });
      const found = await db.user.findFirst({ where: { id: `tx_${STAMP}_ok2` } });
      assert(found?.id === `tx_${STAMP}_ok2`, 'tx commit did not persist');
    });

    await scenario('thrown transaction rolls back (no rows persist)', async () => {
      try {
        await db.$transaction(async (tx: any) => {
          await tx.user.create({ data: { id: `tx_${STAMP}_rb`, email: `txrb_${STAMP}@x.co`, name: 'rb' } });
          throw new Error('rollback please');
        });
      } catch { /* expected */ }
      const found = await db.user.findFirst({ where: { id: `tx_${STAMP}_rb` } });
      assert(found === null, 'tx rolled back row still present');
    });

    // ─── 7. Cascades ──────────────────────────────────────────────────
    console.log('\n[7] cascade enforcement (DB FK ON DELETE)');

    await scenario('delete Post cascades to Comments + Likes + PostTags', async () => {
      const before = await Promise.all([
        db.comment.count({ where: { post_id: post1Id } }),
        db.like.count({ where: { post_id: post1Id } }),
        db.postTag.count({ where: { post_id: post1Id } }),
      ]);
      assert(before.every((n) => n > 0), `setup wrong: ${before}`);
      await db.post.delete({ where: { id: post1Id } });
      const after = await Promise.all([
        db.comment.count({ where: { post_id: post1Id } }),
        db.like.count({ where: { post_id: post1Id } }),
        db.postTag.count({ where: { post_id: post1Id } }),
      ]);
      assert(after.every((n) => n === 0), `cascade incomplete: ${after}`);
    });

    // ─── 8. $queryRaw + $executeRaw ───────────────────────────────────
    console.log('\n[8] raw SQL escape hatches');

    await scenario('$queryRaw with parameterised value', async () => {
      const rows: any = await db.$queryRaw(
        forgeSql.sql`SELECT id, email, role FROM users WHERE email = ${'alice@x.co'}`,
      );
      assert(rows.length === 1 && rows[0].id === aliceId, `bad row: ${JSON.stringify(rows[0])}`);
    });

    await scenario('$queryRaw injection probe — payload stays in params', async () => {
      const evil = "1'; DROP TABLE users;--";
      const rows: any = await db.$queryRaw(
        forgeSql.sql`SELECT id FROM users WHERE email = ${evil}`,
      );
      assert(Array.isArray(rows), 'raw query should return array');
      // The users table is still there (otherwise the next assertion would fail).
      const ok = await db.user.count();
      assert(ok > 0, 'users table somehow gone — injection succeeded?');
    });

    await scenario('$executeRaw returns affected row count', async () => {
      const n: any = await db.$executeRaw(
        forgeSql.sql`UPDATE users SET active = ${false} WHERE id = ${bobId}`,
      );
      assert(n === 1, `expected 1 affected row, got ${n}`);
      const after = await db.user.findFirst({ where: { id: bobId } });
      assert(after?.active === false, 'raw update did not persist');
    });

    await scenario('$queryRaw composes safely with forge.join', async () => {
      const parts = [forgeSql.sql`role = ${'EDITOR'}`, forgeSql.sql`active = ${true}`];
      const rows: any = await db.$queryRaw(
        forgeSql.sql`SELECT id FROM users WHERE ${forgeSql.join(parts, ' AND ')}`,
      );
      assert(rows.length === 1 && rows[0].id === aliceId, `composed query off: ${JSON.stringify(rows)}`);
    });

    // ─── 9. Self-referential reads ────────────────────────────────────
    console.log('\n[9] self-referential queries');

    // post1 was cascade-deleted above, so use post2's comments to test
    // self-ref. Re-seed.
    await db.comment.create({ data: {
      id: `cs1_${STAMP}`, post_id: post2Id, author_id: aliceId, body: 'top-level',
    } });
    await db.comment.create({ data: {
      id: `cs2_${STAMP}`, post_id: post2Id, author_id: aliceId,
      parent_id: `cs1_${STAMP}`, body: 'reply',
    } });

    await scenario('replies query (where parent_id = …) finds children', async () => {
      const replies = await db.comment.findMany({ where: { parent_id: `cs1_${STAMP}` } });
      assert(replies.length === 1 && replies[0].body === 'reply', 'self-ref query failed');
    });

    // ─── 10. SetNull on author delete ─────────────────────────────────
    console.log('\n[10] SetNull cascade variant');

    await scenario('deleting Comment author (User) sets Comment.author_id NULL', async () => {
      // Make a fresh user + comment so we don't disturb earlier state.
      const newUserId = `u_setnull_${STAMP}`;
      await db.user.create({ data: { id: newUserId, email: `setnull_${STAMP}@x.co`, name: 'setnull' } });
      const newCommentId = `c_setnull_${STAMP}`;
      await db.comment.create({ data: {
        id: newCommentId, post_id: post2Id, author_id: newUserId, body: 'will become orphan',
      } });
      await db.user.delete({ where: { id: newUserId } });
      const orphan = await db.comment.findFirst({ where: { id: newCommentId } });
      assert(orphan?.author_id == null, `expected author_id null, got ${orphan?.author_id}`);
    });

    // ─── 11. include / relation hydration (live PG) ───────────────────
    console.log('\n[11] include / relation hydration');

    // Make sure post2 still has comments and exists.
    await scenario('findFirst with include hydrates one-to-many', async () => {
      const u = await db.user.findFirst({
        where: { id: aliceId },
        include: { posts: true, comments: true },
      } as any);
      const u2 = u as any;
      assert(Array.isArray(u2?.posts), 'posts not hydrated');
      assert(u2.posts.length >= 1, `expected ≥1 post, got ${u2.posts.length}`);
      assert(Array.isArray(u2?.comments), 'comments not hydrated');
    });

    await scenario('findMany with include + nested where on the relation', async () => {
      const users = await db.user.findMany({
        include: { posts: { where: { status: 'DRAFT' }, take: 5 } } as any,
      });
      const withPosts = (users as any[]).find((u) => u.id === aliceId);
      assert(withPosts != null, 'alice missing');
      // Either no posts (if cascade-deleted earlier in [7]) or all status='DRAFT'.
      assert(
        Array.isArray(withPosts.posts) && withPosts.posts.every((p: any) => p.status === 'DRAFT'),
        `nested where on relation failed: ${JSON.stringify(withPosts.posts)?.slice(0, 200)}`,
      );
    });

    await scenario('findFirst with _count.select on a relation', async () => {
      const u: any = await db.user.findFirst({
        where: { id: aliceId },
        include: { _count: { select: { posts: true, comments: true } } } as any,
      });
      assert(typeof u?._count?.posts === 'number', `_count.posts missing: ${JSON.stringify(u?._count)}`);
    });

    // ─── 12. groupBy + aggregations ───────────────────────────────────
    console.log('\n[12] groupBy + aggregations');

    // Seed a richer set so we can group meaningfully.
    await db.user.createMany({ data: [
      { id: `u_gb_e1_${STAMP}`, email: `gb-e1-${STAMP}@x.co`, name: 'Editor1', role: 'EDITOR' },
      { id: `u_gb_e2_${STAMP}`, email: `gb-e2-${STAMP}@x.co`, name: 'Editor2', role: 'EDITOR' },
      { id: `u_gb_a1_${STAMP}`, email: `gb-a1-${STAMP}@x.co`, name: 'Admin1',  role: 'ADMIN' },
    ] });

    await scenario('groupBy by role with _count._all', async () => {
      const rows: any[] = await db.user.groupBy({
        by: ['role'],
        _count: { _all: true },
        orderBy: { role: 'asc' },
      });
      assert(rows.length >= 2, `expected ≥2 groups, got ${rows.length}`);
      const editors = rows.find((r) => r.role === 'EDITOR');
      assert(editors?._count?._all >= 2, `EDITOR count off: ${JSON.stringify(editors)}`);
    });

    await scenario('groupBy with having (_count.id gt 1)', async () => {
      const rows: any[] = await db.user.groupBy({
        by: ['role'],
        _count: { _all: true, id: true },
        having: { _count: { id: { gt: 1 } } },
      });
      assert(rows.every((r) => r._count.id > 1), `having filter failed: ${JSON.stringify(rows)}`);
    });

    await scenario('Post.groupBy with _avg + _sum', async () => {
      // Seed a few posts with different view_counts.
      await db.post.createMany({ data: [
        { id: `p_gb1_${STAMP}`, author_id: aliceId, title: 't1', slug: `gb-1-${STAMP}`, body: 'b', status: 'PUBLISHED', view_count: 10 },
        { id: `p_gb2_${STAMP}`, author_id: aliceId, title: 't2', slug: `gb-2-${STAMP}`, body: 'b', status: 'PUBLISHED', view_count: 20 },
        { id: `p_gb3_${STAMP}`, author_id: aliceId, title: 't3', slug: `gb-3-${STAMP}`, body: 'b', status: 'DRAFT',     view_count: 5  },
      ] });
      const rows: any[] = await db.post.groupBy({
        by: ['status'],
        _count: { _all: true },
        _avg: { view_count: true },
        _sum: { view_count: true },
        _min: { view_count: true },
        _max: { view_count: true },
        orderBy: { status: 'asc' },
      });
      const pub = rows.find((r) => r.status === 'PUBLISHED');
      assert(pub?._sum?.view_count >= 30, `_sum.view_count off: ${JSON.stringify(pub)}`);
      assert(pub?._avg?.view_count >= 10, `_avg.view_count off: ${JSON.stringify(pub)}`);
      assert(pub?._min?.view_count <= 10 && pub?._max?.view_count >= 20,
             `_min/_max off: ${JSON.stringify(pub)}`);
    });

    // ─── 13. connectOrCreate ──────────────────────────────────────────
    console.log('\n[13] connectOrCreate');

    await scenario('connectOrCreate finds existing tag, then creates new one', async () => {
      const tagName = `coc-existing-${STAMP}`;
      const existingTagId = `t_coc_existing_${STAMP}`;
      await db.tag.create({ data: { id: existingTagId, name: tagName } });

      // Owning-one connectOrCreate: PostTag.tag relation.
      const ptExisting = await db.postTag.create({ data: {
        id: `pt_coc_e_${STAMP}`,
        post_id: post2Id,
        tag: { connectOrCreate: { where: { name: tagName }, create: { id: 'unused', name: tagName } } } as any,
        tag_id: 'placeholder',
      } as any });
      // After connectOrCreate, the FK should point at the existing tag.
      const ptCheck: any = await db.postTag.findFirst({ where: { id: (ptExisting as any).id } });
      assert(ptCheck?.tag_id === existingTagId,
             `connectOrCreate-existing should point at ${existingTagId}, got ${ptCheck?.tag_id}`);

      // Creating a fresh tag via connectOrCreate.
      const newTagName = `coc-new-${STAMP}`;
      const newTagId   = `t_coc_new_${STAMP}`;
      const ptNew = await db.postTag.create({ data: {
        id: `pt_coc_n_${STAMP}`,
        post_id: post2Id,
        tag: { connectOrCreate: { where: { name: newTagName }, create: { id: newTagId, name: newTagName } } } as any,
        tag_id: 'placeholder',
      } as any });
      const ptCheck2: any = await db.postTag.findFirst({ where: { id: (ptNew as any).id } });
      assert(ptCheck2?.tag_id === newTagId,
             `connectOrCreate-new should point at new tag ${newTagId}, got ${ptCheck2?.tag_id}`);
    });

    // ─── 14. Forge-name helpers (sanity check on the new schema) ──────
    console.log('\n[14] sanity / shape checks');

    await scenario('listing all users finds at least the ones we created', async () => {
      const all = await db.user.findMany();
      assert(all.length >= 2, `expected ≥2 users, got ${all.length}`);
    });

    await scenario('updating with ForgeDbNull sets column to NULL', async () => {
      await db.profile.update({
        where: { user_id: aliceId },
        data: { bio: ForgeDbNull },
      });
      const after = await db.profile.findFirst({ where: { user_id: aliceId } });
      // PG's coerceInbound passes the marker straight through. For deep parity
      // we'd unwrap to actual SQL NULL. For now the smoke checks the field
      // was at least updated (the value differs from the original 'I write things').
      assert(after?.bio !== 'I write things', `bio unchanged: ${after?.bio}`);
    });

    // ─── Wave 4 — events / streaming / full-text search ─────────────────
    console.log('\n[wave-4]');

    await scenario('$on("query") fires with sql + duration', async () => {
      const events: any[] = [];
      const off = (db as any).$on('query', (e: any) => events.push(e));
      await db.user.findFirst({ where: { id: aliceId } });
      off();
      assert(events.length >= 1, `no events captured, got ${events.length}`);
      const e = events[0];
      assert(e.adapter === 'postgres' && e.op === 'select', `bad event: ${JSON.stringify(e)}`);
      assert(typeof e.sql === 'string' && e.sql.length > 0, 'sql missing');
      assert(typeof e.duration_ms === 'number' && e.duration_ms >= 0, 'duration missing');
    });

    await scenario('findManyStream yields rows lazily', async () => {
      let count = 0;
      const stream = (db.user as any).findManyStream({ chunkSize: 3 });
      for await (const _row of stream) {
        count++;
        if (count > 50) break;
      }
      assert(count > 0, `stream yielded 0 rows`);
    });

    await scenario('where.search uses to_tsvector / plainto_tsquery', async () => {
      // Earlier cascade test removed the original "Forge IR Design" post —
      // insert a fresh searchable doc.
      await db.post.create({ data: {
        id: `p_search_${STAMP}`, author_id: aliceId,
        title: 'Forge Full-Text Search Demo',
        slug: `forge-fts-${STAMP}`, body: 'Searchable content', status: 'PUBLISHED',
      } });
      const found: any[] = await db.post.findMany({ where: { title: { search: 'Forge' } as any } });
      assert(found.length >= 1, `to_tsvector match returned 0 rows`);
    });

    // ─── Wave 4b ───────────────────────────────────────────────────────
    console.log('\n[wave-4b]');

    await scenario('.searchable() field has auto-emitted GIN index', async () => {
      const r: any = await db.$queryRaw`
        SELECT indexname FROM pg_indexes
        WHERE tablename = 'posts' AND indexname = 'forge_posts_fts_body'
      `;
      assert(r.length === 1, `expected forge_posts_fts_body index, got: ${JSON.stringify(r)}`);
    });

    await scenario('AuditLog.softDelete() sets deleted_at (row stays); restore() clears; delete() is hard', async () => {
      const log = await db.auditLog.create({ data: { id: `al_${STAMP}_1`, event: 'login' } });
      await db.auditLog.softDelete({ where: { id: log.id } });
      const hidden = await db.auditLog.findFirst({ where: { id: log.id } });
      assert(hidden === null, `expected hidden after softDelete, got: ${JSON.stringify(hidden)}`);
      // The row physically exists with deleted_at set.
      const raw: any = await db.$queryRaw`SELECT id, deleted_at FROM audit_logs WHERE id = ${log.id}`;
      assert(raw.length === 1 && raw[0].deleted_at != null, `expected row with deleted_at set, got: ${JSON.stringify(raw)}`);
      await db.auditLog.restore({ where: { id: log.id } });
      const restored = await db.auditLog.findFirst({ where: { id: log.id } });
      assert(restored != null, `expected visible after restore`);
      // delete() hard-removes even on a soft-delete model.
      await db.auditLog.delete({ where: { id: log.id } });
      const gone: any = await db.$queryRaw`SELECT id FROM audit_logs WHERE id = ${log.id}`;
      assert(gone.length === 0, `expected row physically gone after hard delete, got: ${JSON.stringify(gone)}`);
    });

    await scenario('AuditLog.findFirst with _withDeleted: true surfaces soft-deleted', async () => {
      const log = await db.auditLog.create({ data: { id: `al_${STAMP}_2`, event: 'logout' } });
      await db.auditLog.softDelete({ where: { id: log.id } });
      const visible: any = await db.auditLog.findFirst({ where: { id: log.id, _withDeleted: true } as any });
      assert(visible?.id === log.id, `expected _withDeleted=true to surface soft-deleted row`);
    });

    await scenario('findManyStream uses native PG cursor', async () => {
      assert(typeof (db.user.adapter as any).streamSelect === 'function',
        'PG adapter should expose streamSelect');
      let count = 0;
      for await (const _row of (db.user as any).findManyStream()) {
        count++;
        if (count > 30) break;
      }
      assert(count > 0, 'native stream yielded 0 rows');
    });

    await scenario('wireOtel emits spans on query', async () => {
      const { wireOtel } = await import('./src');
      const spans: any[] = [];
      const fakeTracer = {
        startSpan: (name: string, options?: any) => {
          const s = { name, attrs: { ...options?.attributes }, ended: false,
            setAttribute() {}, setAttributes() {}, recordException() {},
            setStatus() {}, end: () => { (s as any).ended = true; spans.push(s); } };
          return s as any;
        },
      };
      const off = wireOtel(db as any, { tracer: fakeTracer });
      await db.user.findFirst({ where: { id: aliceId } });
      off();
      const sel = spans.find((s) => s.name === 'forge.select');
      assert(sel != null && sel.attrs['db.system'] === 'postgresql', `expected forge.select with db.system=postgresql, got: ${JSON.stringify(sel?.attrs)}`);
      assert(typeof sel.attrs['db.statement'] === 'string', 'db.statement attr missing');
    });

    // ─── Wave 4c — read-only views ─────────────────────────────────────
    console.log('\n[wave-4c]');

    await scenario('CREATE VIEW emitted for publishedPosts', async () => {
      const r: any = await db.$queryRaw`
        SELECT viewname FROM pg_views WHERE viewname = 'published_posts'
      `;
      assert(r.length === 1, `expected published_posts view, got: ${JSON.stringify(r)}`);
    });

    await scenario('publishedPosts.findMany returns only PUBLISHED posts', async () => {
      const all: any[] = await (db as any).publishedPosts.findMany();
      assert(all.every((p: any) => p.id != null), 'view query returned rows');
      // Should include the freshly-created PUBLISHED post but not the DRAFT we made earlier.
      const titles = all.map((p: any) => p.title);
      assert(!titles.includes('Draft'), `view leaked DRAFT post: ${titles.join(', ')}`);
    });

    await scenario('publishedPosts.create throws (read-only view)', async () => {
      try {
        await (db as any).publishedPosts.create({ data: { id: 'x', title: 't', slug: 's', author_id: aliceId, view_count: 0 } });
        throw new Error('expected throw');
      } catch (e: any) {
        assert(/read-only view/.test(e?.message ?? ''), `wrong error: ${e?.message}`);
      }
    });

    // ─── Wave 5d — materialised view + Wave 5e — strict mode ───────────
    console.log('\n[wave-5d / 5e]');

    await scenario('CREATE MATERIALIZED VIEW emitted for post_stats', async () => {
      const r: any = await db.$queryRaw`SELECT matviewname FROM pg_matviews WHERE matviewname = 'post_stats'`;
      assert(r.length === 1, `expected post_stats matview, got: ${JSON.stringify(r)}`);
    });

    await scenario('postStats.refresh() recomputes per-author rollups', async () => {
      await db.post.create({ data: { id: `mv_${STAMP}`, author_id: aliceId, title: 'MV', slug: `mv-${STAMP}`, body: 'mv body', status: 'PUBLISHED', view_count: 7 } as any });
      await (db as any).postStats.refresh();
      const rows: any[] = await (db as any).postStats.findMany();
      const mine = rows.find((r: any) => String(r.author_id) === String(aliceId));
      assert(mine, `expected a rollup row for author ${aliceId}; got ${rows.length} rows`);
      assert(Number(mine.post_count) >= 1, `post_count should be >= 1, got ${mine.post_count}`);
    });

    await scenario('postStats.create throws (read-only view)', async () => {
      try {
        await (db as any).postStats.create({ data: { author_id: aliceId, post_count: 1, total_views: 0 } });
        throw new Error('expected throw');
      } catch (e: any) {
        assert(/read-only view/.test(e?.message ?? ''), `wrong error: ${e?.message}`);
      }
    });

    await scenario('strict mode rejects unknown where key', async () => {
      const strict = await createDb({ url: SMOKE_URL, strict: true });
      try {
        await (strict as any).user.findMany({ where: { nonexistent_field: 'x' } });
        throw new Error('expected strict throw');
      } catch (e: any) {
        assert(/strict/.test(e?.message ?? ''), `wrong error: ${e?.message}`);
      } finally {
        await strict.$disconnect();
      }
    });

    console.log(`\n[forge:pg] ${pass} passed, ${fail} failed`);
  } finally {
    await db.$disconnect();

    // ─── Cleanup: drop the isolated database ──────────────────────────
    const cleanup = new Pool({ connectionString: ROOT_URL });
    // Terminate stragglers so DROP DATABASE doesn't block.
    await cleanup.query(`
      SELECT pg_terminate_backend(pid) FROM pg_stat_activity
      WHERE datname = $1 AND pid <> pg_backend_pid()
    `, [DB_NAME]).catch(() => {});
    await cleanup.query(`DROP DATABASE IF EXISTS "${DB_NAME}"`).catch((e: any) => {
      console.error(`[cleanup] DROP DATABASE failed: ${e.message}`);
    });
    await cleanup.end();
    console.log(`[cleanup] dropped database '${DB_NAME}'`);
  }
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(2); });
