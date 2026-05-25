/* eslint-disable no-console */
//
// Comprehensive MySQL integration test for forge.
//
// Creates an isolated database, pushes the full sample schema, runs the
// same scenarios as the PG/SQLite smokes, then drops the database.
//
// Defaults assume DBngin's MySQL (root, no password, 127.0.0.1:3306).

import * as dotenv from 'dotenv';
dotenv.config();

import { createDb, forgeSql, DbKnownError } from './src';
import { buildSchemaDDL } from './src/adapters/mysql/ddl';
import { applyMigration } from './src/adapters/mysql/migrate';
import { schema } from './src/schema';

const STAMP = `${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
const DB_NAME = `forge_smoke_${STAMP}`;
const MYSQL_USER = process.env.SMOKE_MYSQL_USER ?? 'root';
const MYSQL_PASS = process.env.SMOKE_MYSQL_PASS ?? '';
const MYSQL_HOST = process.env.SMOKE_MYSQL_HOST ?? '127.0.0.1';
const MYSQL_PORT = process.env.SMOKE_MYSQL_PORT ?? '3306';
const ROOT_URL = `mysql://${MYSQL_USER}${MYSQL_PASS ? `:${MYSQL_PASS}` : ''}@${MYSQL_HOST}:${MYSQL_PORT}`;
const SMOKE_URL = `${ROOT_URL}/${DB_NAME}`;

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
  console.log(`\n[forge:mysql] target db: ${DB_NAME}\n`);

  // Bootstrap the isolated db
  const mysql = require('mysql2/promise');
  const rootConn = await mysql.createConnection({ uri: ROOT_URL });
  await rootConn.query(`CREATE DATABASE \`${DB_NAME}\``);
  await rootConn.end();
  console.log(`[bootstrap] created database '${DB_NAME}'`);

  const db = await createDb({ url: SMOKE_URL });
  const mysqlPool = (db.adapter as any).pool;

  try {
    // ─── 1. Schema push ───────────────────────────────────────────────
    console.log('\n[1] schema push');
    const ddl = buildSchemaDDL(schema);
    const report = await applyMigration(mysqlPool, ddl);
    await scenario('DDL applied without failures', async () => {
      if (report.failures.length) {
        report.failures.forEach((f) => console.log(`      - ${f.name}: ${f.error}`));
      }
      assert(report.failures.length === 0, `${report.failures.length} failures`);
      assert(report.applied.length > 0, 'nothing applied');
    });

    // ─── 2. CRUD ──────────────────────────────────────────────────────
    console.log('\n[2] entity creation');

    const aliceId = `u_${STAMP}_alice`;
    const bobId   = `u_${STAMP}_bob`;
    const post1Id = `p_${STAMP}_1`;
    const post2Id = `p_${STAMP}_2`;

    await scenario('create User with embedded Address', async () => {
      const u = await db.user.create({
        data: {
          id: aliceId, email: 'alice@x.co', name: 'Alice', role: 'EDITOR',
          address: { street: '1 main', city: 'sf', zip: '94110', country: 'us' },
        },
      });
      assert(u.id === aliceId, 'returned id mismatch');
      assert(u.role === 'EDITOR', 'role override');
      // MySQL stores JSON as parsed object on the way out (mysql2 handles JSON columns natively)
      assert(u.address?.city === 'sf', `embed lost: ${JSON.stringify(u.address)}`);
    });

    await scenario('create second User', async () => {
      await db.user.create({ data: { id: bobId, email: 'bob@x.co', name: 'Bob' } });
    });

    await scenario('create Profile with social_links embedMany', async () => {
      await db.profile.create({
        data: {
          id: `prof_${STAMP}`, user_id: aliceId, bio: 'writes things',
          social_links: [
            { platform: 'twitter', url: 'https://x.com/alice' },
            { platform: 'github',  url: 'https://github.com/alice' },
          ],
        },
      });
    });

    await scenario('create Posts (JSON meta + stringArray tag_names)', async () => {
      await db.post.create({ data: {
        id: post1Id, author_id: aliceId, title: 'Forge IR Design',
        slug: `forge-ir-${STAMP}`, body: 'The IR layer is…', status: 'PUBLISHED',
        tag_names: ['typescript', 'databases'],
        meta: { reading_time: 5, featured: true },
      } });
      await db.post.create({ data: {
        id: post2Id, author_id: aliceId, title: 'Draft',
        slug: `draft-${STAMP}`, body: 'WIP', status: 'DRAFT',
      } });
    });

    // ─── 3. Reads ─────────────────────────────────────────────────────
    console.log('\n[3] reads');

    await scenario('findFirst by unique field', async () => {
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
      assert(n === 2, `expected 2, got ${n}`);
    });

    await scenario('embed roundtrips', async () => {
      const u = await db.user.findFirst({ where: { id: aliceId } });
      assert(u?.address?.country === 'us', `address lost: ${JSON.stringify(u?.address)}`);
    });

    await scenario('JSON field roundtrips', async () => {
      const p = await db.post.findFirst({ where: { id: post1Id } });
      assert(p?.meta?.featured === true && p?.meta?.reading_time === 5,
             `JSON lost: ${JSON.stringify(p?.meta)}`);
    });

    await scenario('embedMany roundtrips', async () => {
      const p = await db.profile.findFirst({ where: { user_id: aliceId } });
      assert(Array.isArray(p?.social_links) && p.social_links.length === 2,
             `social_links lost: ${JSON.stringify(p?.social_links)}`);
    });

    await scenario('findFirst with include hydrates posts', async () => {
      const u: any = await db.user.findFirst({
        where: { id: aliceId },
        include: { posts: true },
      });
      assert(Array.isArray(u?.posts) && u.posts.length === 2, `hydration failed`);
    });

    // ─── 4. Atomic ────────────────────────────────────────────────────
    console.log('\n[4] atomic writes');

    await scenario('update with $inc + $set', async () => {
      const before = await db.post.findFirst({ where: { id: post1Id } });
      const updated = await db.post.update({
        where: { id: post1Id },
        data: { view_count: { increment: 5 }, status: 'PUBLISHED' },
      });
      assert(updated.view_count === (before!.view_count + 5), `$inc broken`);
    });

    await scenario('updateMany returns count', async () => {
      await db.comment.create({ data: {
        id: `c1_${STAMP}`, post_id: post1Id, author_id: bobId, body: 'great',
      } });
      await db.comment.create({ data: {
        id: `c2_${STAMP}`, post_id: post1Id, author_id: aliceId, body: 'thanks',
      } });
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
        await db.user.create({ data: { id: `dup_${STAMP}`, email: 'alice@x.co', name: 'dup' } });
        throw new Error('expected unique violation');
      } catch (e: any) {
        assert(e instanceof DbKnownError && e.code === 'P2002', `wrong code: ${e?.code}`);
      }
    });

    await scenario('enum CHECK → P2004', async () => {
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

    await scenario('FK violation → P2003', async () => {
      try {
        await db.post.create({ data: {
          id: `orphan_${STAMP}`, author_id: 'user_doesnt_exist',
          title: 'orphan', slug: `orphan-${STAMP}`, body: 'x',
        } });
        throw new Error('expected FK violation');
      } catch (e: any) {
        assert(e instanceof DbKnownError && e.code === 'P2003', `wrong code: ${e?.code}`);
      }
    });

    // ─── 6. $transaction ──────────────────────────────────────────────
    console.log('\n[6] $transaction');

    await scenario('committed transaction persists', async () => {
      await db.$transaction(async (tx: any) => {
        await tx.user.create({ data: { id: `tx_ok_${STAMP}`, email: `txok_${STAMP}@x.co`, name: 'tx_ok' } });
      });
      const found = await db.user.findFirst({ where: { id: `tx_ok_${STAMP}` } });
      assert(found?.id === `tx_ok_${STAMP}`, 'tx commit did not persist');
    });

    await scenario('thrown transaction rolls back', async () => {
      try {
        await db.$transaction(async (tx: any) => {
          await tx.user.create({ data: { id: `tx_rb_${STAMP}`, email: `txrb_${STAMP}@x.co`, name: 'rb' } });
          throw new Error('rollback please');
        });
      } catch { /* expected */ }
      const found = await db.user.findFirst({ where: { id: `tx_rb_${STAMP}` } });
      assert(found === null, 'tx rolled back row still present');
    });

    // ─── 7. Cascades ──────────────────────────────────────────────────
    console.log('\n[7] FK cascade (DB-enforced)');

    await scenario('delete Post cascades to Comments', async () => {
      const before = await db.comment.count({ where: { post_id: post1Id } });
      assert(before > 0, `setup wrong: ${before}`);
      await db.post.delete({ where: { id: post1Id } });
      const after = await db.comment.count({ where: { post_id: post1Id } });
      assert(after === 0, `cascade incomplete: ${after}`);
    });

    // ─── 8. Raw SQL ───────────────────────────────────────────────────
    console.log('\n[8] raw SQL');

    await scenario('$queryRaw parameterised', async () => {
      const rows: any = await db.$queryRaw`SELECT id, email FROM users WHERE email = ${'alice@x.co'}`;
      assert(rows.length === 1 && rows[0].id === aliceId, `bad row: ${JSON.stringify(rows[0])}`);
    });

    await scenario('$executeRaw returns affected count', async () => {
      const n: any = await db.$executeRaw`UPDATE users SET active = ${0} WHERE id = ${bobId}`;
      assert(n === 1, `expected 1 affected, got ${n}`);
    });

    // ─── 9. groupBy ───────────────────────────────────────────────────
    console.log('\n[9] groupBy');

    await scenario('groupBy by role with _count._all', async () => {
      await db.user.createMany({ data: [
        { id: `u_e1_${STAMP}`, email: `e1-${STAMP}@x.co`, name: 'E1', role: 'EDITOR' },
        { id: `u_a1_${STAMP}`, email: `a1-${STAMP}@x.co`, name: 'A1', role: 'ADMIN' },
      ] });
      const rows: any[] = await db.user.groupBy({
        by: ['role'],
        _count: { _all: true },
        orderBy: { role: 'asc' },
      });
      const editors = rows.find((r) => r.role === 'EDITOR');
      assert(Number(editors?._count?._all) >= 2, `EDITOR count off: ${JSON.stringify(editors)}`);
    });

    // ─── Wave 4 — events / streaming / full-text search ─────────────────
    console.log('\n[wave-4]');

    await scenario('$on("query") fires with sql + duration', async () => {
      const events: any[] = [];
      const off = (db as any).$on('query', (e: any) => events.push(e));
      await db.user.findFirst({ where: { id: aliceId } });
      off();
      assert(events.length >= 1, `no events captured`);
      const e = events[0];
      assert(e.adapter === 'mysql' && e.op === 'select', `bad event: ${JSON.stringify(e)}`);
      assert(e.sql.startsWith('SELECT'), `expected SELECT sql, got: ${e.sql}`);
    });

    await scenario('findManyStream yields rows lazily', async () => {
      let count = 0;
      for await (const _row of (db.user as any).findManyStream({ chunkSize: 3 })) {
        count++;
        if (count > 50) break;
      }
      assert(count > 0, `stream yielded 0 rows`);
    });

    await scenario('where.search on .searchable() field — uses auto-FULLTEXT', async () => {
      // body is .searchable() — forge:push has already emitted FULLTEXT(body).
      await db.post.create({ data: {
        id: `p_search_${STAMP}`, author_id: aliceId,
        title: 'Plain title', slug: `forge-fts-${STAMP}`,
        body: 'Forge MySQL Full-Text Search content', status: 'PUBLISHED',
      } });
      const found: any[] = await db.post.findMany({ where: { body: { search: 'Forge' } as any } });
      assert(found.length >= 1, `MATCH AGAINST found 0 rows (auto-emitted FULLTEXT(body))`);
    });

    // ─── Wave 4b ───────────────────────────────────────────────────────
    console.log('\n[wave-4b]');

    await scenario('.searchable() field has auto-emitted FULLTEXT index', async () => {
      const [rows]: any = await mysqlPool.query(
        `SELECT INDEX_NAME FROM INFORMATION_SCHEMA.STATISTICS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'posts' AND INDEX_NAME = 'forge_posts_fts_body'`,
      );
      assert(rows.length >= 1, `expected forge_posts_fts_body index, got: ${JSON.stringify(rows)}`);
    });

    await scenario('AuditLog.delete() soft-deletes', async () => {
      const log = await db.auditLog.create({ data: { id: `al_${STAMP}_1`, event: 'login' } });
      await db.auditLog.delete({ where: { id: log.id } });
      const visible = await db.auditLog.findFirst({ where: { id: log.id } });
      assert(visible === null, `expected hidden after soft-delete`);
      const [raw]: any = await mysqlPool.query(`SELECT deleted_at FROM audit_logs WHERE id = ?`, [log.id]);
      assert(raw.length === 1 && raw[0].deleted_at != null, `expected deleted_at set`);
    });

    await scenario('findManyStream uses native MySQL stream', async () => {
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
      assert(sel?.attrs['db.system'] === 'mysql', `expected db.system=mysql, got ${sel?.attrs?.['db.system']}`);
    });

    // ─── Wave 4c — read-only views ─────────────────────────────────────
    console.log('\n[wave-4c]');

    await scenario('CREATE VIEW emitted for publishedPosts', async () => {
      const [rows]: any = await mysqlPool.query(
        `SELECT TABLE_NAME FROM INFORMATION_SCHEMA.VIEWS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'published_posts'`,
      );
      assert(rows.length === 1, `expected published_posts view`);
    });

    await scenario('publishedPosts.findMany reads from the view', async () => {
      const all: any[] = await (db as any).publishedPosts.findMany();
      const titles = all.map((p: any) => p.title);
      assert(!titles.includes('Draft'), `view leaked DRAFT post`);
    });

    await scenario('publishedPosts.update throws (read-only view)', async () => {
      try {
        await (db as any).publishedPosts.update({ where: { id: 'x' }, data: { view_count: 1 } });
        throw new Error('expected throw');
      } catch (e: any) {
        assert(/read-only view/.test(e?.message ?? ''), `wrong error: ${e?.message}`);
      }
    });

    console.log(`\n[forge:mysql] ${pass} passed, ${fail} failed`);
  } finally {
    await db.$disconnect();
    const cleanup = await mysql.createConnection({ uri: ROOT_URL });
    await cleanup.query(`DROP DATABASE IF EXISTS \`${DB_NAME}\``).catch(() => {});
    await cleanup.end();
    console.log(`[cleanup] dropped database '${DB_NAME}'`);
  }
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(2); });
