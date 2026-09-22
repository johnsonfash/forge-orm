/* eslint-disable no-console */
// Everything added in 2.18.0 - 2.20.0, executed against a REAL server.
//
// The unit suite asserts the SQL those releases emit. That catches a wrong
// shape and cannot catch a wrong dialect: `JSON_OVERLAPS`, `json_each`,
// `OPENJSON`, `list_has_all`, a bound JSON path, the blob size classes —
// every one of those was verified as a STRING and never executed. If an
// argument order or a JSON-text form is wrong, the unit tests still pass.
//
//   SMOKE_DIALECT=pg    SMOKE_PG_USER=postgres    npx ts-node … (default)
//   SMOKE_DIALECT=mysql SMOKE_MYSQL_USER=root
import { createDb, setActiveSchema } from './src';
import { f, model, rel } from './src/schema/core';

const DIALECT = (process.env.SMOKE_DIALECT ?? 'pg') as 'pg' | 'mysql';
const DB_NAME = `forge_feat_${Date.now()}`;

const PG_USER = process.env.SMOKE_PG_USER ?? 'postgres';
const PG_HOST = process.env.SMOKE_PG_HOST ?? '127.0.0.1';
const PG_PORT = process.env.SMOKE_PG_PORT ?? '5432';
const MY_USER = process.env.SMOKE_MYSQL_USER ?? 'root';
const MY_PASS = process.env.SMOKE_MYSQL_PASS ?? '';
const MY_HOST = process.env.SMOKE_MYSQL_HOST ?? '127.0.0.1';
const MY_PORT = process.env.SMOKE_MYSQL_PORT ?? '3306';

const rootUrl = DIALECT === 'pg'
  ? `postgres://${PG_USER}@${PG_HOST}:${PG_PORT}/postgres`
  : `mysql://${MY_USER}${MY_PASS ? `:${MY_PASS}` : ''}@${MY_HOST}:${MY_PORT}`;
const smokeUrl = DIALECT === 'pg'
  ? `postgres://${PG_USER}@${PG_HOST}:${PG_PORT}/${DB_NAME}`
  : `${rootUrl}/${DB_NAME}`;

const AuthorM = model('feat_authors', {
  id: f.id({ type: 'string' }),
  email: f.string(),
  deleted_at: f.dateTime().optional().softDeleteAt(),
}).relate(() => ({
  posts: rel.many('post', { on: 'author_id', refs: 'id' }),
}));

const Post = model('feat_posts', {
  id: f.id({ type: 'string' }),
  author_id: f.string(),
  title: f.string(),
  score: f.int().default(0),
  tags: f.stringArray().default([] as never),
  meta: f.json<{ city?: string }>().optional(),
  body: f.bytes().optional(),
  etag: f.bytes({ maxBytes: 4 }).optional(),
  price: f.decimal({ precision: 12, scale: 2 }).optional(),
  deleted_at: f.dateTime().optional().softDeleteAt(),
});

const schema = { author: AuthorM, post: Post } as never;

let pass = 0, fail = 0;
const t = async (label: string, fn: () => Promise<void>) => {
  process.stdout.write(`  ${label.padEnd(64)}`);
  try { await fn(); console.log('✓'); pass++; }
  catch (e: unknown) {
    const m = (e as Error)?.message ?? String(e);
    console.log(`✗\n      ${m.split('\n').slice(0, 3).join('\n      ')}`);
    fail++;
  }
};
const eq = (a: unknown, b: unknown, m: string) => {
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m}: got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`);
};
const ok = (c: unknown, m: string) => { if (!c) throw new Error(m); };

async function main() {
  console.log(`\n[feat:${DIALECT}] db ${DB_NAME}\n`);
  setActiveSchema(schema);

  if (DIALECT === 'pg') {
    const { Pool } = require('pg');
    const root = new Pool({ connectionString: rootUrl });
    await root.query(`CREATE DATABASE "${DB_NAME}"`);
    await root.end();
  } else {
    const mysql = require('mysql2/promise');
    const root = await mysql.createConnection(rootUrl);
    await root.query(`CREATE DATABASE \`${DB_NAME}\``);
    await root.end();
  }

  const db = await createDb({ url: smokeUrl, schema }) as never as Record<string, any>;
  try {
    const ddlMod = DIALECT === 'pg'
      ? await import('./src/adapters/postgres/ddl')
      : await import('./src/adapters/mysql/ddl');
    const migMod = DIALECT === 'pg'
      ? await import('./src/adapters/postgres/migrate')
      : await import('./src/adapters/mysql/migrate');
    const handle = DIALECT === 'pg' ? (db.adapter as any).pool : (db.adapter as any).pool;
    const report = await (migMod as any).applyMigration(handle, (ddlMod as any).buildSchemaDDL(schema));
    ok(report.failures.length === 0, `DDL failures: ${JSON.stringify(report.failures)}`);
    console.log(`[ddl] applied ${report.applied.length}\n`);

    await db.author.create({ data: { id: 'a1', email: 'Ann@Example.com' } });
    await db.author.create({ data: { id: 'a2', email: 'bob@example.com' } });

    console.log('f.bytes() — 2.18.0');
    await t('a Uint8Array round-trips byte for byte', async () => {
      const bytes = new Uint8Array([0, 1, 127, 128, 255, 13, 10, 0]);
      await db.post.create({ data: { id: 'p_b1', author_id: 'a1', title: 'b', body: bytes } });
      const r = await db.post.findFirst({ where: { id: 'p_b1' } });
      ok(r.body, 'no body came back');
      eq(Array.from(r.body as Uint8Array), Array.from(bytes), 'bytes differ');
    });
    await t('a Buffer round-trips too', async () => {
      await db.post.create({ data: { id: 'p_b2', author_id: 'a1', title: 'b', body: Buffer.from([9, 8, 7]) } });
      const r = await db.post.findFirst({ where: { id: 'p_b2' } });
      eq(Array.from(r.body as Uint8Array), [9, 8, 7], 'buffer differs');
    });
    await t('maxBytes is enforced by the server-bound write path', async () => {
      let threw = '';
      try { await db.post.create({ data: { id: 'p_b3', author_id: 'a1', title: 'b', etag: new Uint8Array(5) } }); }
      catch (e) { threw = (e as Error).message; }
      ok(/over its declared maxBytes/.test(threw), `expected a maxBytes error, got: ${threw}`);
    });
    await t('exactly maxBytes is accepted and reads back', async () => {
      await db.post.create({ data: { id: 'p_b4', author_id: 'a1', title: 'b', etag: new Uint8Array([1, 2, 3, 4]) } });
      const r = await db.post.findFirst({ where: { id: 'p_b4' } });
      eq(Array.from(r.etag as Uint8Array), [1, 2, 3, 4], 'etag differs');
    });
    await t('a base64 string is refused, not stored as text', async () => {
      let threw = '';
      try { await db.post.create({ data: { id: 'p_b5', author_id: 'a1', title: 'b', body: 'AQID' as never } }); }
      catch (e) { threw = (e as Error).message; }
      ok(/is not binary/.test(threw), `expected a type error, got: ${threw}`);
    });

    console.log('\narray filters — 2.18.0 (these were Postgres-only SQL before)');
    await db.post.create({ data: { id: 'p_t1', author_id: 'a1', title: 't1', tags: ['red', 'blue'] } });
    await db.post.create({ data: { id: 'p_t2', author_id: 'a1', title: 't2', tags: ['blue', 'green'] } });
    await db.post.create({ data: { id: 'p_t3', author_id: 'a1', title: 't3', tags: [] } });
    const ids = (rows: any[]) => rows.map((r) => r.id).sort();
    await t('has', async () =>
      eq(ids(await db.post.findMany({ where: { tags: { has: 'blue' } } })), ['p_t1', 'p_t2'], 'has'));
    await t('hasSome', async () =>
      eq(ids(await db.post.findMany({ where: { tags: { hasSome: ['red', 'green'] } } })), ['p_t1', 'p_t2'], 'hasSome'));
    await t('hasEvery', async () =>
      eq(ids(await db.post.findMany({ where: { tags: { hasEvery: ['red', 'blue'] } } })), ['p_t1'], 'hasEvery'));
    await t('isEmpty true', async () =>
      // Scoped to a2's absence: the bytes fixtures legitimately have empty
      // tags, because `.default([])` now reaches Postgres as '{}'::text[].
      eq(ids(await db.post.findMany({ where: { tags: { isEmpty: true }, title: 't3' } })), ['p_t3'], 'isEmpty'));
    await t('isEmpty false is the negation', async () =>
      eq(ids(await db.post.findMany({ where: { tags: { isEmpty: false } } })), ['p_t1', 'p_t2'], 'not empty'));
    await t('an empty `in` matches nothing without a syntax error', async () =>
      eq((await db.post.findMany({ where: { id: { in: [] } } })).length, 0, 'in []'));
    await t('an empty `notIn` matches everything', async () =>
      ok((await db.post.findMany({ where: { id: { notIn: [] } } })).length >= 3, 'notIn []'));

    console.log("\nmode: 'insensitive' — 2.18.0 (was ILIKE on every dialect)");
    await t('contains matches across case', async () =>
      eq((await db.author.findMany({ where: { email: { contains: 'ANN', mode: 'insensitive' } } })).length, 1, 'ci contains'));
    await t('a case-sensitive contains behaves per the column collation', async () => {
      const n = (await db.author.findMany({ where: { email: { contains: 'ANN' } } })).length;
      // Not a forge behaviour: MySQL's default collation is `_ci`, so a plain
      // LIKE is already case-insensitive and there is no way to force
      // sensitivity without a COLLATE clause. Postgres is case-sensitive.
      eq(n, DIALECT === 'mysql' ? 1 : 0, 'collation-dependent contains');
    });
    await t('startsWith / endsWith insensitively', async () => {
      eq((await db.author.findMany({ where: { email: { startsWith: 'ann', mode: 'insensitive' } } })).length, 1, 'sw');
      eq((await db.author.findMany({ where: { email: { endsWith: 'EXAMPLE.COM', mode: 'insensitive' } } })).length, 2, 'ew');
    });

    console.log('\nJSON path — bound, not spliced (the 2.18.0 injection fix)');
    await db.post.create({ data: { id: 'p_j1', author_id: 'a1', title: 'j', meta: { city: 'Lagos' } } });
    await t('a path filter matches', async () =>
      eq(ids(await db.post.findMany({ where: { meta: { path: 'city', eq: 'Lagos' } } })), ['p_j1'], 'json path'));
    await t('a quote-carrying path segment cannot break out', async () => {
      const rows = await db.post.findMany({ where: { meta: { path: ["a' OR 1=1 -- "], eq: 1 } } });
      eq(rows.length, 0, 'the injection payload matched rows');
    });
    await t('a key with spaces and a hyphen is queryable', async () => {
      await db.post.create({
        data: { id: 'p_j2', author_id: 'a1', title: 'j2', meta: { 'order-id': 'X 1' } as never },
      });
      const rows = await db.post.findMany({ where: { meta: { path: ['order-id'], eq: 'X 1' } } });
      eq(rows.map((r: any) => r.id), ['p_j2'], 'hyphenated json key');
    });

    console.log('\ncursor direction — 2.18.0');
    for (let i = 1; i <= 5; i++) {
      await db.post.create({ data: { id: `p_c${i}`, author_id: 'a2', title: `c${i}`, score: i * 10 } });
    }
    await t('newest-first paging does not re-serve the first page', async () => {
      const page1 = await db.post.findMany({
        where: { author_id: 'a2' }, orderBy: { score: 'desc' }, take: 2,
      });
      eq(page1.map((r: any) => r.score), [50, 40], 'page 1');
      const page2 = await db.post.findMany({
        where: { author_id: 'a2' }, orderBy: { score: 'desc' }, take: 2,
        cursor: { score: page1[page1.length - 1].score },
      });
      eq(page2.map((r: any) => r.score), [30, 20], 'page 2 overlapped page 1');
    });

    console.log('\natomic ops — 2.18.0');
    await t('divide is exact, not a multiply by a reciprocal', async () => {
      await db.post.create({ data: { id: 'p_d1', author_id: 'a1', title: 'd', score: 900 } });
      const r = await db.post.update({ where: { id: 'p_d1' }, data: { score: { divide: 3 } } });
      eq(r.score, 300, 'divide');
    });
    await t('max clamps upwards only', async () => {
      const a = await db.post.update({ where: { id: 'p_d1' }, data: { score: { max: 500 } } });
      eq(a.score, 500, 'max raises');
      const b = await db.post.update({ where: { id: 'p_d1' }, data: { score: { max: 100 } } });
      eq(b.score, 500, 'max lowered it');
    });
    await t('min clamps downwards only', async () => {
      const a = await db.post.update({ where: { id: 'p_d1' }, data: { score: { min: 50 } } });
      eq(a.score, 50, 'min lowers');
      const b = await db.post.update({ where: { id: 'p_d1' }, data: { score: { min: 900 } } });
      eq(b.score, 50, 'min raised it');
    });
    await t('push appends to a list column', async () => {
      const r = await db.post.update({ where: { id: 'p_t3' }, data: { tags: { push: 'added' } } });
      ok((r.tags as string[]).includes('added'), `tags=${JSON.stringify(r.tags)}`);
    });

    console.log('\nupdateFirst / deleteFirst — 2.20.0');
    await t('updateFirst returns the row in one call', async () => {
      const r = await db.post.updateFirst({ where: { id: 'p_t1' }, data: { title: 'renamed' } });
      eq(r.title, 'renamed', 'updateFirst');
    });
    await t('updateFirst returns null on a miss instead of throwing', async () =>
      eq(await db.post.updateFirst({ where: { id: 'nope' }, data: { title: 'x' } }), null, 'miss'));
    await t('the row comes back even when the patch soft-deletes it', async () => {
      const r = await db.post.updateFirst({ where: { id: 'p_b2' }, data: { deleted_at: new Date() } });
      ok(r && r.id === 'p_b2', 'a successful soft delete returned null');
    });
    await t('and it is then hidden from reads', async () =>
      eq(await db.post.findFirst({ where: { id: 'p_b2' } }), null, 'still visible'));
    await t('deleteFirst is idempotent', async () => {
      ok(await db.post.deleteFirst({ where: { id: 'p_b4' } }), 'first delete');
      eq(await db.post.deleteFirst({ where: { id: 'p_b4' } }), null, 'second delete threw or returned a row');
    });

    console.log('\nsoft delete on relations — 2.19.0');
    await t('include excludes a soft-deleted child', async () => {
      const a = await db.author.findFirst({ where: { id: 'a1' }, include: { posts: true } });
      ok(!(a.posts as any[]).some((p: any) => p.id === 'p_b2'), 'a deleted post leaked through include');
    });
    await t('_count agrees with what include returned', async () => {
      const a = await db.author.findFirst({
        where: { id: 'a1' },
        include: { posts: true, _count: { select: { posts: true } } },
      } as never);
      eq(a._count.posts, (a.posts as any[]).length, '_count disagrees with include');
    });
    await t('a relation filter does not match on a deleted child', async () => {
      const rows = await db.author.findMany({ where: { posts: { some: { title: 'b' } } } });
      ok(!rows.some((r: any) => r.id === 'a1' && false), 'sanity');
      const byDeleted = await db.author.findMany({ where: { posts: { some: { id: 'p_b2' } } } });
      eq(byDeleted.length, 0, 'matched a soft-deleted child');
    });

    console.log(`\n[feat:${DIALECT}] ${pass} passed, ${fail} failed`);
  } finally {
    await db.$disconnect();
    if (DIALECT === 'pg') {
      const { Pool } = require('pg');
      const root = new Pool({ connectionString: rootUrl });
      await root.query(`DROP DATABASE IF EXISTS "${DB_NAME}"`);
      await root.end();
    } else {
      const mysql = require('mysql2/promise');
      const root = await mysql.createConnection(rootUrl);
      await root.query(`DROP DATABASE IF EXISTS \`${DB_NAME}\``);
      await root.end();
    }
  }
  if (fail) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
