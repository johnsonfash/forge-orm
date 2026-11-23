/* eslint-disable no-console */
// Write-path and read-path fixes from 2.25.0, against real servers:
// Postgres, MySQL (and MariaDB when FORGE_MARIADB_URL is set) and MongoDB.
// SQLite, DuckDB and IndexedDB are covered in-process by the jest specs.
//
//   PG_URL=postgres://postgres@127.0.0.1:5432/postgres \
//   MYSQL_URL=mysql://root@127.0.0.1:3306 \
//   MONGO_URL=mongodb://127.0.0.1:27017 \
//   npx ts-node --transpile-only regression-correctness-writes.ts
//
// Each server gets a scratch database that is dropped at the end. A server
// whose URL is unset or unreachable is skipped and reported.
//
// What it pins:
//   • a nested create commits whole or not at all (no BEGIN existed before)
//   • batched connectOrCreate reuses existing rows and creates a missing one once
//   • MySQL create returns exactly the row a SELECT returns, without the SELECT
//   • MariaDB 10.5+ uses INSERT/DELETE … RETURNING
//   • a stream inside $transaction sees the transaction's own writes (pg, mysql)
//   • Postgres stream fetches 1 000 rows per round trip
//   • Postgres native geo nearTo works (quoted _distanceMeters), when PostGIS exists
//   • Mongo: updateMany counts matched docs; deletes cascade through two levels
//     and the join table; Restrict blocks; all inside the replica-set transaction

import { createDb, mongoDriver, mysql2Driver, pgDriver } from './src';
import { f, model, rel } from './src/schema/core';

let pass = 0, fail = 0;
const check = (l: string, c: boolean, d: unknown = '') => {
  console.log(`  ${c ? '✓' : '✗'} ${l}${c ? '' : `  << ${typeof d === 'string' ? d : JSON.stringify(d)}`}`);
  c ? pass++ : fail++;
};

function schema(geo: boolean) {
  const User = model('rw_users', {
    id: f.id({ type: 'string' }), email: f.string().unique(), name: f.string(),
    active: f.bool(), joined: f.dateTime(), prefs: f.json<{ a: number }>(), bio: f.text().optional(),
  }).relate(() => ({ posts: rel.many('post', { on: 'author_id', refs: 'id' }) }));
  const Post = model('rw_posts', { id: f.id({ type: 'string' }), author_id: f.string(), title: f.string() })
    .relate(() => ({
      author: rel.one('user', { on: 'author_id', refs: 'id', onDelete: 'Cascade' }),
      post_tags: rel.many('postTag', { on: 'post_id', refs: 'id' }),
      comments: rel.many('comment', { on: 'post_id', refs: 'id' }),
    }));
  const Comment = model('rw_comments', { id: f.id({ type: 'string' }), post_id: f.string(), body: f.text() })
    .relate(() => ({ post: rel.one('post', { on: 'post_id', refs: 'id', onDelete: 'Cascade' }) }));
  const Tag = model('rw_tags', { id: f.id({ type: 'string' }), name: f.string().unique() });
  const PostTag = model('rw_post_tags', { id: f.id({ type: 'string' }), post_id: f.string(), tag_id: f.string() })
    .relate(() => ({
      post: rel.one('post', { on: 'post_id', refs: 'id', onDelete: 'Cascade' }),
      tag: rel.one('tag', { on: 'tag_id', refs: 'id', onDelete: 'Cascade' }),
    }));
  const Lock = model('rw_locks', { id: f.id({ type: 'string' }), user_id: f.string() })
    .relate(() => ({ user: rel.one('user', { on: 'user_id', refs: 'id', onDelete: 'Restrict' }) }));
  const base: Record<string, unknown> = { user: User, post: Post, comment: Comment, tag: Tag, postTag: PostTag, lock: Lock };
  if (geo) base.place = model('rw_places', { id: f.id({ type: 'string' }), loc: f.geoPoint() });
  return base;
}

const user = (id: string) => ({ id, email: `${id}@x`, name: id, active: true, joined: new Date(Date.UTC(2025, 0, 2, 3, 4, 5, 678)), prefs: { a: 1 } });
const nested = (id: string, badPostId?: string) => ({
  ...user(id),
  posts: { create: [0, 1, 2].map((k) => ({
    id: k === 2 && badPostId ? badPostId : `${id}_p${k}`, title: `t${k}`,
    ...(k === 0 ? { post_tags: { create: ['old', 'new', 'old'].map((name, j) => ({
      id: `${id}_pt${j}`, tag: { connectOrCreate: { where: { name }, create: { id: `tag_${id}_${name}`, name } } },
    })) } } : {}),
  })) },
});

async function commonSql(db: any, label: string) {
  console.log(`[${label}] nested create`);
  await db.tag.create({ data: { id: 'old_tag', name: 'old' } });
  await db.user.create({ data: nested('n1') });
  const back = await db.user.findUnique({ where: { id: 'n1' }, include: { posts: { orderBy: { id: 'asc' }, include: { post_tags: { orderBy: { id: 'asc' }, include: { tag: true } } } } } });
  check('whole tree written', back?.posts?.length === 3 && back.posts[0].post_tags.map((p: any) => p.tag.name).join() === 'old,new,old', back);
  check('existing tag reused, missing one created once', (await db.tag.count()) === 2);
  await db.user.create({ data: user('blocker') });
  await db.post.create({ data: { id: 'dup', author_id: 'blocker', title: 'x' } });
  let threw = false;
  try { await db.user.create({ data: nested('n2', 'dup') }); } catch { threw = true; }
  check('a failing child rolls the parent back', threw && (await db.user.count({ where: { id: 'n2' } })) === 0);
  check('and the tags it created', (await db.tag.count()) === 2);

  console.log(`[${label}] stream inside a transaction`);
  await db.$transaction(async (tx: any) => {
    await tx.post.create({ data: { id: 'tx_only', author_id: 'blocker', title: 'x' } });
    const seen: string[] = [];
    for await (const r of tx.post.findManyStream({ where: { id: 'tx_only' } })) seen.push(r.id);
    check('the stream sees the uncommitted row', seen.join() === 'tx_only', seen);
    throw new Error('rollback');
  }).catch(() => {});
  check('and it rolled back', (await db.post.count({ where: { id: 'tx_only' } })) === 0);
}

async function postgres(url: string) {
  const pg = require('pg');
  const admin = new pg.Pool({ connectionString: url });
  const name = `forge_rw_${Date.now()}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const pool = new pg.Pool({ connectionString: url.replace(/\/[^/]*$/, `/${name}`) });
  try {
    let geo = true;
    try { await pool.query('CREATE EXTENSION IF NOT EXISTS postgis'); } catch { geo = false; }
    const s = schema(geo);
    const { buildSchemaDDL } = require('./src/adapters/postgres/ddl');
    for (const st of buildSchemaDDL(s)) await pool.query(st.sql).catch((e: any) => { if (!/exists/.test(e.message)) throw e; });
    const db: any = await createDb({ schema: s, driver: pgDriver(pool) } as never);
    await commonSql(db, 'postgres');
    console.log('[postgres] stream fetch size');
    await db.user.createMany({ data: Array.from({ length: 2500 }, (_, i) => user(`s${String(i).padStart(5, '0')}`)) });
    const fetches: string[] = [];
    const orig = pg.Client.prototype.query;
    pg.Client.prototype.query = function (this: any, ...a: any[]) { if (typeof a[0] === 'string' && a[0].startsWith('FETCH')) fetches.push(a[0]); return orig.apply(this, a); };
    let n = 0;
    for await (const _r of db.user.findManyStream({ where: { id: { startsWith: 's' } }, orderBy: { id: 'asc' } })) n++;
    pg.Client.prototype.query = orig;
    check('2500 rows in 3 FETCH 1000', n === 2500 && fetches.length === 3 && fetches.every((x) => x.startsWith('FETCH 1000')), fetches);
    if (geo) {
      console.log('[postgres] geo nearTo');
      await db.place.createMany({ data: [{ id: 'a', loc: { lng: 0, lat: 0 } }, { id: 'b', loc: { lng: 0.01, lat: 0 } }, { id: 'c', loc: { lng: 1, lat: 1 } }] });
      const rows = await db.place.findMany({ where: { loc: { near: { lng: 0.009, lat: 0, withinMeters: 5000 } } }, orderBy: { loc: { nearTo: { lng: 0.009, lat: 0 } } } });
      check('nearest first, within the radius', rows.map((r: any) => r.id).join() === 'b,a', rows);
    } else console.log('  (PostGIS not installed: geo skipped)');
  } finally {
    await pool.end();
    await admin.query(`DROP DATABASE IF EXISTS ${name}`);
    await admin.end();
  }
}

async function mysql(url: string, label: string) {
  const m = require('mysql2/promise');
  const admin = await m.createConnection(url);
  const name = `forge_rw_${Date.now()}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const pool = m.createPool({ uri: `${url.replace(/\/$/, '')}/${name}`, connectionLimit: 5 });
  try {
    const s = schema(false);
    const { buildSchemaDDL } = require('./src/adapters/mysql/ddl');
    for (const st of buildSchemaDDL(s)) await pool.query(st.sql).catch((e: any) => { if (!/exists|Duplicate/.test(e.message)) throw e; });
    const sent: string[] = [];
    for (const m2 of ['query', 'execute'] as const) {
      const o = pool[m2].bind(pool);
      pool[m2] = (q: any, ...a: any[]) => { sent.push(typeof q === 'string' ? q : q.sql); return o(q, ...a); };
    }
    const db: any = await createDb({ schema: s, driver: mysql2Driver(pool) } as never);
    const [[v]] = await pool.query('SELECT VERSION() AS v');
    console.log(`[${label}] server ${v.v}`);
    sent.length = 0;
    const made = await db.user.create({ data: user('m1') });
    const statements = [...sent];
    const read = await db.user.findUnique({ where: { id: 'm1' } });
    check('create returns exactly what a SELECT returns', JSON.stringify(made) === JSON.stringify(read), { made, read });
    check('create is one statement', statements.length === 1, statements);
    await commonSql(db, label);
  } finally {
    await pool.end();
    await admin.query(`DROP DATABASE IF EXISTS ${name}`);
    await admin.end();
  }
}

async function mongodb(url: string) {
  const { MongoClient } = require('mongodb');
  const client = new MongoClient(url, { serverSelectionTimeoutMS: 2000 });
  await client.connect();
  const name = `forge_rw_${Date.now()}`;
  try {
    const hello = await client.db('admin').command({ hello: 1 });
    const s = schema(false);
    const db: any = await createDb({ schema: s, driver: mongoDriver(client, name) } as never);
    for (const md of Object.values(s) as any[]) await client.db(name).createCollection(md.collection).catch(() => {});
    console.log(`[mongo] ${hello.setName ? `replica set ${hello.setName}` : 'standalone'}`);
    await db.user.create({ data: user('u1') });
    for (const p of ['p1', 'p2']) {
      await db.post.create({ data: { id: p, author_id: 'u1', title: p } });
      await db.comment.createMany({ data: [{ id: `${p}c1`, post_id: p, body: 'x' }, { id: `${p}c2`, post_id: p, body: 'y' }] });
      await db.tag.create({ data: { id: `t_${p}`, name: p } });
      await db.postTag.create({ data: { id: `${p}_t`, post_id: p, tag_id: `t_${p}` } });
    }
    check('updateMany counts matched documents', (await db.post.updateMany({ where: { author_id: 'u1' }, data: { title: 'same' } })).count === 2);
    check('and again when nothing changes', (await db.post.updateMany({ where: { author_id: 'u1' }, data: { title: 'same' } })).count === 2);
    await db.lock.create({ data: { id: 'l1', user_id: 'u1' } });
    let code = '';
    try { await db.user.delete({ where: { id: 'u1' } }); } catch (e: any) { code = e.code; }
    check('Restrict blocks the delete', code === 'P2003' && (await db.post.count()) === 2, code);
    await db.lock.deleteMany({});
    await db.user.delete({ where: { id: 'u1' } });
    check('cascade: posts, comments and join rows gone',
      (await db.post.count()) === 0 && (await db.comment.count()) === 0 && (await db.postTag.count()) === 0);
    check('tags themselves stay', (await db.tag.count()) === 2);
  } finally {
    await client.db(name).dropDatabase().catch(() => {});
    await client.close();
  }
}

async function main() {
  const runs: Array<[string, string | undefined, (u: string) => Promise<void>]> = [
    ['postgres', process.env.PG_URL ?? 'postgres://postgres@127.0.0.1:5432/postgres', postgres],
    ['mysql', process.env.MYSQL_URL ?? 'mysql://root@127.0.0.1:3306', (u) => mysql(u, 'mysql')],
    ['mariadb', process.env.FORGE_MARIADB_URL, (u) => mysql(u, 'mariadb')],
    ['mongo', process.env.MONGO_URL ?? 'mongodb://127.0.0.1:27017', mongodb],
  ];
  for (const [label, url, fn] of runs) {
    if (!url) { console.log(`[${label}] skipped (no URL)`); continue; }
    try { await fn(url); } catch (e: any) { check(`${label} ran`, false, e?.message ?? e); }
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main();
