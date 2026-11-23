// In-process databases for specs that need a real engine: SQLite
// (better-sqlite3, :memory:), DuckDB (:memory:) and, when a local mongod
// answers, MongoDB on a scratch database. Each opener returns the forge db,
// a statement log, and a close().
//
// Not a spec (no .spec.ts suffix), so jest only loads it through imports.

import { f, model, rel } from '../schema/core';
import { createDb } from '../factory';
import { betterSqlite3Driver } from '../adapters/sqlite/driver';
import { duckdbDriver } from '../adapters/duckdb/driver';
import { mongoDriver } from '../adapters/mongo/driver';

export function blogSchema() {
  const User = model('users', {
    id: f.id({ type: 'string' }),
    email: f.string().unique(),
    name: f.string(),
    prefs: f.json<{ theme: string; score: number }>().optional(),
  }).relate(() => ({
    profiles: rel.many('profile', { on: 'user_id', refs: 'id' }),
    posts: rel.many('post', { on: 'author_id', refs: 'id' }),
    comments: rel.many('comment', { on: 'author_id', refs: 'id' }),
    badges: rel.many('badge', { on: 'user_id', refs: 'id' }),
  }));
  const Profile = model('profiles', {
    id: f.id({ type: 'string' }),
    user_id: f.string().unique(),
    bio: f.text(),
  }).relate(() => ({
    user: rel.one('user', { on: 'user_id', refs: 'id', onDelete: 'Cascade' }),
  }));
  const Post = model('posts', {
    id: f.id({ type: 'string' }),
    author_id: f.string(),
    title: f.string(),
    views: f.int().default(0),
    meta: f.json<{ lang: string; score: number }>().optional(),
  }).relate(() => ({
    author: rel.one('user', { on: 'author_id', refs: 'id', onDelete: 'Cascade' }),
    comments: rel.many('comment', { on: 'post_id', refs: 'id' }),
    post_tags: rel.many('postTag', { on: 'post_id', refs: 'id' }),
  }));
  const Comment = model('comments', {
    id: f.id({ type: 'string' }),
    post_id: f.string(),
    author_id: f.string().optional(),
    body: f.text(),
  }).relate(() => ({
    post: rel.one('post', { on: 'post_id', refs: 'id', onDelete: 'Cascade' }),
    author: rel.one('user', { on: 'author_id', refs: 'id', onDelete: 'SetNull' }),
  }));
  const Tag = model('tags', {
    id: f.id({ type: 'string' }),
    name: f.string().unique(),
  }).relate(() => ({
    post_tags: rel.many('postTag', { on: 'tag_id', refs: 'id' }),
  }));
  const PostTag = model('post_tags', {
    id: f.id({ type: 'string' }),
    post_id: f.string(),
    tag_id: f.string(),
  }).relate(() => ({
    post: rel.one('post', { on: 'post_id', refs: 'id', onDelete: 'Cascade' }),
    tag: rel.one('tag', { on: 'tag_id', refs: 'id', onDelete: 'Cascade' }),
  }));
  // A user with a badge cannot be deleted.
  const Badge = model('badges', {
    id: f.id({ type: 'string' }),
    user_id: f.string(),
  }).relate(() => ({
    user: rel.one('user', { on: 'user_id', refs: 'id', onDelete: 'Restrict' }),
  }));
  return { user: User, profile: Profile, post: Post, comment: Comment, tag: Tag, postTag: PostTag, badge: Badge };
}

export interface LiveDb {
  db: any;
  log: string[];
  close(): Promise<void>;
  /** False where the engine has no transaction to roll back. */
  transactional?: boolean;
}

export async function openSqlite(schema: Record<string, unknown>): Promise<LiveDb> {
  const Database = require('better-sqlite3');
  const h = new Database(':memory:');
  const log: string[] = [];
  const driver = betterSqlite3Driver(h);
  const { buildSchemaDDL } = require('../adapters/sqlite/ddl');
  const { applyMigration } = require('../adapters/sqlite/migrate');
  await applyMigration(driver, buildSchemaDDL(schema as never));
  const db: any = await createDb({ schema, driver } as never);
  const origExec = h.exec.bind(h);
  h.exec = (sql: string) => { log.push(sql); return origExec(sql); };
  const origPrepare = h.prepare.bind(h);
  h.prepare = (sql: string) => {
    const st = origPrepare(sql);
    for (const m of ['run', 'get', 'all', 'iterate']) {
      const o = st[m]?.bind(st);
      if (o) st[m] = (...a: unknown[]) => { log.push(sql); return o(...a); };
    }
    return st;
  };
  return { db, log, close: async () => { h.close(); } };
}

export async function openDuckdb(schema: Record<string, unknown>, opts: { instance?: boolean } = {}): Promise<LiveDb> {
  const { DuckDBInstance } = require('@duckdb/node-api');
  const instance = await DuckDBInstance.create(':memory:');
  const conn = await instance.connect();
  const log: string[] = [];
  const driver = duckdbDriver(conn, opts.instance ? { instance } : {});
  const { buildSchemaDDL } = require('../adapters/duckdb/ddl');
  const { applyMigration } = require('../adapters/duckdb/migrate');
  await applyMigration(driver, buildSchemaDDL(schema as never));
  const db: any = await createDb({ schema, driver } as never);
  for (const m of ['run', 'runAndReadAll', 'stream', 'streamAndReadAll']) {
    const o = conn[m]?.bind(conn);
    if (o) conn[m] = (sql: string, ...a: unknown[]) => { log.push(sql); return o(sql, ...a); };
  }
  return {
    db, log, close: async () => {
      try { conn.closeSync?.(); } catch { /* */ }
      try { instance.closeSync?.(); } catch { /* */ }
    },
  };
}

const MONGO_URL = process.env.FORGE_TEST_MONGO_URL ?? 'mongodb://127.0.0.1:27017';

/** Null when no mongod answers within a second; specs skip themselves then. */
export async function openMongo(schema: Record<string, unknown>): Promise<(LiveDb & { replicaSet: boolean }) | null> {
  const { MongoClient } = require('mongodb');
  const client = new MongoClient(MONGO_URL, { serverSelectionTimeoutMS: 1000, monitorCommands: true });
  try {
    await client.connect();
  } catch {
    await client.close().catch(() => {});
    return null;
  }
  const name = `forge_spec_${process.pid}_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  const log: string[] = [];
  client.on('commandStarted', (e: any) => {
    if (!['hello', 'isMaster', 'ismaster', 'ping', 'endSessions', 'saslStart', 'saslContinue'].includes(e.commandName)) log.push(e.commandName);
  });
  const hello = await client.db('admin').command({ hello: 1 });
  const db: any = await createDb({ schema, driver: mongoDriver(client, name) } as never);
  // Collections must exist before a transaction writes to them on older servers.
  for (const m of Object.values(schema) as any[]) await client.db(name).createCollection(m.collection).catch(() => {});
  return {
    db, log, replicaSet: !!hello.setName, transactional: !!hello.setName,
    close: async () => {
      await client.db(name).dropDatabase().catch(() => {});
      await client.close().catch(() => {});
    },
  };
}

/** IndexedDB through fake-indexeddb, in-process. */
export async function openIndexedDb(schema: Record<string, unknown>): Promise<LiveDb> {
  require('fake-indexeddb/auto');
  const db: any = await createDb({ url: `idb://spec-${process.pid}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`, schema } as never);
  return { db, log: [], transactional: false, close: async () => { await db.$disconnect?.(); } };
}
