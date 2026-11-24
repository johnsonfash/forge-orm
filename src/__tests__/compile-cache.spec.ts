// The per-shape SQL cache must hand back exactly what the compiler would have:
// same SQL text, same parameters, for every value it is given. Each case runs
// a sequence of value sets through the cached compile (so shapes are seen,
// learned, then reused) and compares every call with the raw compiler.

import { f, model, rel } from '../schema/core';
import { setActiveSchema } from '../schema/active';
import { buildCount, buildDelete, buildInsert, buildSelect, buildUpdate, buildGroupBy } from '../ir/build';
import { compileCacheStats, configureCompileCache, resetCompileCache, shapeCached } from '../ir/compile-cache';
import * as pg from '../adapters/postgres/compile-from-ir';
import * as my from '../adapters/mysql/compile-from-ir';
import * as lite from '../adapters/sqlite/compile-from-ir';
import * as duck from '../adapters/duckdb/compile-from-ir';
import * as ms from '../adapters/mssql/compile-from-ir';
import { ForgeDbNull, ForgeJsonNull } from '../null-markers';
import { createDb } from '../factory';
import { betterSqlite3Driver } from '../adapters/sqlite/driver';

const User = model('users', {
  id: f.id({ type: 'string' }),
  email: f.string().unique(),
  name: f.string(),
  nick: f.string().optional(),
  n: f.int(),
  score: f.float(),
  big: f.bigint().optional(),
  active: f.bool(),
  role: f.enumOf(['USER', 'ADMIN'] as const),
  at: f.dateTime(),
  meta: f.json<any>().optional(),
  tags: f.stringArray().optional(),
  deleted_at: f.dateTime().optional().softDeleteAt(),
}).relate(() => ({
  posts: rel.many('post', { on: 'author_id', refs: 'id' }),
}));
const Post = model('posts', {
  id: f.id({ type: 'string' }),
  author_id: f.string(),
  title: f.string(),
  views: f.int(),
}).relate(() => ({
  author: rel.one('user', { on: 'author_id', refs: 'id', onDelete: 'Cascade' }),
}));
const sch = { user: User, post: Post } as any;

const D1 = new Date('2025-01-02T03:04:05.678Z');
const D2 = new Date('2019-12-31T23:59:59.000Z');

// Every case: a node builder and the value sets it is called with, in order.
// Shapes repeat across the sets, and some sets change the shape on purpose.
type Case = { name: string; build: (v: any) => any; values: any[] };

const sel = (args: any, card: 'one' | 'many' = 'many') => buildSelect('user', User, args, card, sch);

const CASES: Case[] = [
  { name: 'pk', build: (v) => sel({ where: { id: v } }, 'one'), values: ['u1', 'u2', '', 'u3', "o'brien", 'u1'] },
  { name: 'eq or null', build: (v) => sel({ where: { nick: v } }), values: ['a', null, 'b', null, 'c', undefined, 'd'] },
  { name: 'in lists', build: (v) => sel({ where: { id: { in: v } } }), values: [['a'], ['a', 'b'], [], ['c'], ['x', 'y'], ['a', null], ['b', null], ['z']] },
  { name: 'notIn', build: (v) => sel({ where: { n: { notIn: v } } }), values: [[1, 2], [3, 4], [5], [6], [0, 7], [8, 9]] },
  { name: 'numbers', build: (v) => sel({ where: { n: { gte: v.a }, score: { lt: v.b } }, take: v.t }), values: [
    { a: 1, b: 1.5, t: 10 }, { a: 2, b: 2.5, t: 10 }, { a: 0, b: 0.5, t: 10 }, { a: -3, b: -1.5, t: 10 },
    { a: 7, b: 3, t: 10 }, { a: 8, b: 4.25, t: 20 }, { a: 9, b: NaN, t: 20 }, { a: 2 ** 60, b: Infinity, t: 20 }, { a: 4, b: 9.75, t: 20 }] },
  { name: 'bigint', build: (v) => sel({ where: { big: v } }), values: [1n, 2n, 0n, -5n, 3n, 4n] },
  { name: 'bool + enum', build: (v) => sel({ where: { active: v.a, role: v.r } }), values: [
    { a: true, r: 'USER' }, { a: false, r: 'USER' }, { a: true, r: 'ADMIN' }, { a: true, r: 'USER' }, { a: false, r: 'ADMIN' }, { a: false, r: 'USER' }] },
  { name: 'dates', build: (v) => sel({ where: { at: { gte: v[0], lt: v[1] } } }), values: [[D1, D2], [D2, D1], [D1, D1], [D2, D2], [new Date(0), D1]] },
  { name: 'strings ops', build: (v) => sel({ where: { OR: [{ name: { contains: v, mode: 'insensitive' } }, { email: { startsWith: v } }, { name: { endsWith: v } }], NOT: { role: 'ADMIN' } } }),
    values: ['al', 'b%c', 'x_y', 'a\\b', 'Mixed', 'al'] },
  { name: 'json path', build: (v) => sel({ where: { meta: { path: 'theme', eq: v } } }), values: ['dark', 'light', 'dark', 'x"y'] },
  { name: 'json equals', build: (v) => sel({ where: { meta: { equals: v } } }), values: [{ a: 1 }, { a: 2 }, { a: 'x', b: [1, 2] }, { a: 3 }, { b: [3, 4], a: 'z' }, ForgeDbNull, ForgeJsonNull] },
  { name: 'array has', build: (v) => sel({ where: { tags: { hasSome: v } } }), values: [['a', 'b'], ['c', 'd'], ['e'], ['f'], ['g', 'h']] },
  { name: 'relation some', build: (v) => sel({ where: { posts: { some: { views: { gte: v } } } } }), values: [1, 2, 3, 0, 4] },
  { name: 'relation none + every', build: (v) => sel({ where: { posts: { none: { title: v } }, AND: [{ posts: { every: { views: { gt: v.length } } } }] } }),
    values: ['a', 'bb', 'ccc', 'a', 'dd'] },
  { name: 'soft delete', build: (v) => sel({ where: { deleted_at: v, name: 'x' } }), values: [null, D1, null, D2, null] },
  { name: 'cursor + order', build: (v) => sel({ cursor: { id: v }, orderBy: { id: 'asc' }, take: 5, skip: 1 }), values: ['a', 'b', 'c', 'd'] },
  { name: 'include + count', build: (v) => sel({ where: { name: v }, include: { posts: { where: { views: { gt: 3 } }, orderBy: { id: 'asc' }, take: 2 }, _count: { select: { posts: true } } } }),
    values: ['a', 'b', 'c', 'd'] },
  { name: 'count', build: (v) => buildCount('user', User, { where: { n: { gt: v } } }, sch), values: [1, 2, 3, 0, 4] },
  { name: 'insert', build: (v) => buildInsert('user', User, { rows: [{ id: v.id, email: `${v.id}@x`, name: v.name, n: v.n, score: 1.5, active: v.a, role: 'USER', at: D1, meta: v.meta, nick: v.nick }] }, sch),
    values: [
      { id: 'a', name: 'A', n: 1, a: true, meta: '{"k":1}', nick: null },
      { id: 'b', name: 'B', n: 2, a: true, meta: '{"k":2}', nick: null },
      { id: 'c', name: 'C', n: 3, a: false, meta: '{"k":3}', nick: 'cc' },
      { id: 'd', name: '', n: 0, a: true, meta: null, nick: 'dd' },
      { id: 'e', name: 'E', n: 5, a: true, meta: '{"k":5}', nick: null },
    ] },
  { name: 'insert many', build: (v) => buildInsert('user', User, { rows: v.map((id: string) => ({ id, email: id, name: id, n: 1, score: 1, active: true, role: 'USER', at: D2 })) }, sch),
    values: [['a', 'b'], ['c', 'd'], ['e'], ['f', 'g'], ['h']] },
  { name: 'update', build: (v) => buildUpdate('user', User, { where: { id: v.id }, data: { name: v.name, n: { increment: v.inc } }, returning: { select: { id: true, name: true } } }, sch),
    values: [{ id: 'a', name: 'x', inc: 1 }, { id: 'b', name: 'y', inc: 2 }, { id: 'c', name: 'z', inc: -1 }, { id: 'd', name: 'w', inc: 3 }] },
  { name: 'update many', build: (v) => buildUpdate('user', User, { where: { posts: { some: { title: v } } }, data: { active: false, nick: null }, many: true }, sch),
    values: ['a', 'b', 'c', 'd'] },
  { name: 'upsert', build: (v) => buildUpdate('user', User, { where: { email: v.e }, data: { name: v.u }, upsertCreate: { id: v.id, email: v.e, name: v.c, n: 1, score: 2, active: true, role: 'USER', at: D1 } }, sch),
    values: [{ e: 'a@x', u: 'U', c: 'C', id: 'a' }, { e: 'b@x', u: 'V', c: 'D', id: 'b' }, { e: 'c@x', u: 'W', c: 'E', id: 'c' }, { e: 'd@x', u: 'X', c: 'F', id: 'd' }] },
  { name: 'delete', build: (v) => buildDelete('user', User, { where: { id: v } }, sch), values: ['a', 'b', 'c', 'd'] },
  { name: 'groupBy', build: (v) => buildGroupBy('post', Post, { by: ['author_id'], where: { views: { gte: v } }, _count: { _all: true }, having: { _count: { _all: { gte: 2 } } } } as any, sch),
    values: [1, 2, 3, 4] },
];

type Kind = 'select' | 'count' | 'insert' | 'update' | 'delete' | 'groupBy';
const DIALECTS: Record<string, Record<Kind, (n: any, m?: any) => any>> = {
  postgres: { select: pg.compileSelect, count: pg.compileCount, insert: pg.compileInsert, update: pg.compileUpdate, delete: pg.compileDelete, groupBy: pg.compileGroupBy },
  mysql: { select: my.compileSelect, count: my.compileCount, insert: my.compileInsert, update: my.compileUpdate, delete: my.compileDelete, groupBy: my.compileGroupBy },
  sqlite: { select: lite.compileSelect, count: lite.compileCount, insert: lite.compileInsert, update: lite.compileUpdate, delete: lite.compileDelete, groupBy: lite.compileGroupBy },
  duckdb: { select: duck.compileSelect, count: duck.compileCount, insert: duck.compileInsert, update: duck.compileUpdate, delete: duck.compileDelete, groupBy: duck.compileGroupBy },
  mssql: { select: ms.compileSelect, count: ms.compileCount, insert: ms.compileInsert, update: ms.compileUpdate, delete: ms.compileDelete, groupBy: ms.compileGroupBy },
};

const norm = (a: any) => ({
  sql: a.sql,
  params: a.params.map((p: any) => (p instanceof Date ? `D:${p.toISOString()}` : typeof p === 'bigint' ? `B:${p}` : Number.isNaN(p) ? 'NaN' : p)),
  rest: Object.fromEntries(Object.entries(a).filter(([k]) => k !== 'sql' && k !== 'params')),
});

function attempt(fn: () => any): any {
  try { return { ok: norm(fn()) }; } catch (e: any) { return { err: String(e?.message ?? e) }; }
}

beforeAll(() => setActiveSchema(sch));
afterAll(() => configureCompileCache({ enabled: true }));

describe('compile cache: same SQL and parameters as the compiler, every call', () => {
  for (const [dialect, fns] of Object.entries(DIALECTS)) {
    test(dialect, () => {
      resetCompileCache();
      configureCompileCache({ enabled: true, maxShapes: 1000 });
      let checked = 0;
      for (const c of CASES) {
        for (let round = 0; round < 3; round++) {
          for (const v of c.values) {
            let node: any;
            try { node = c.build(v); } catch { continue; }
            const kind = node.kind as Kind;
            const raw = fns[kind];
            const cached = (fns as any)[`__cached_${kind}`] ??= shapeCached(`spec:${dialect}:${kind}`, raw);
            const want = attempt(() => raw(node, kind === 'groupBy' ? Post : kind === 'count' || kind === 'select' || kind === 'insert' || kind === 'update' || kind === 'delete' ? User : undefined));
            const got = attempt(() => cached(node, kind === 'groupBy' ? Post : User));
            expect({ case: c.name, v, got }).toEqual({ case: c.name, v, got: want });
            checked++;
          }
        }
      }
      const s = compileCacheStats();
      expect(checked).toBeGreaterThan(300);
      // The cache actually served most of them, and refused the ones it must.
      expect(s.ready).toBeGreaterThan(20);
      expect(s.never).toBeGreaterThan(0);
    });
  }

  test('a full cache drops the least recently used shape', () => {
    resetCompileCache();
    configureCompileCache({ enabled: true, maxShapes: 3 });
    const c = shapeCached('spec:lru', pg.compileSelect as any);
    for (const field of ['name', 'email', 'nick', 'role', 'name']) {
      for (let i = 0; i < 3; i++) {
        const node = sel({ where: { [field]: field === 'role' ? 'USER' : `v${i}` } });
        expect(norm(c(node, User))).toEqual(norm(pg.compileSelect(node, User)));
      }
    }
    expect(compileCacheStats().shapes).toBeLessThanOrEqual(3);
    configureCompileCache({ maxShapes: 1000 });
  });

  test('values that are not plain data bypass the cache', () => {
    resetCompileCache();
    const c = shapeCached('spec:bypass', pg.compileInsert as any);
    for (let i = 0; i < 3; i++) {
      const node = buildInsert('user', User, { rows: [{ id: `b${i}`, meta: Buffer.from([i]) }] } as any, sch);
      expect(norm(c(node, User))).toEqual(norm(pg.compileInsert(node, User)));
    }
    expect(compileCacheStats().shapes).toBe(0);
  });
});

describe('compile cache: results with the cache on and off', () => {
  const Database = require('better-sqlite3');
  const { applyMigration } = require('../adapters/sqlite/migrate');
  const { buildSchemaDDL } = require('../adapters/sqlite/ddl');

  async function run(enabled: boolean): Promise<any[]> {
    configureCompileCache({ enabled });
    resetCompileCache();
    const h = new Database(':memory:');
    const driver = betterSqlite3Driver(h);
    await applyMigration(driver, buildSchemaDDL(sch));
    const db: any = await createDb({ schema: sch, driver } as any);
    const out: any[] = [];
    for (let i = 0; i < 6; i++) {
      await db.user.create({ data: { id: `u${i}`, email: `u${i}@x`, name: i % 2 ? `Al${i}` : `Bo${i}`, nick: i % 3 ? null : `n${i}`, n: i, score: i + 0.5, active: i % 2 === 0, role: i === 5 ? 'ADMIN' : 'USER', at: new Date(Date.UTC(2025, 0, i + 1)), meta: { k: i, theme: i % 2 ? 'dark' : 'light' }, tags: [`t${i}`, 'all'] } });
      for (let k = 0; k < 3; k++) await db.post.create({ data: { id: `p${i}_${k}`, author_id: `u${i}`, title: `T${k}`, views: i * 10 + k } });
    }
    // Every query twice or more with different values, so the cached path runs.
    for (let r = 0; r < 3; r++) {
      out.push(await db.user.findUnique({ where: { id: `u${r}` } }));
      out.push(await db.user.findMany({ where: { nick: r === 1 ? null : `n${r * 3}` }, orderBy: { id: 'asc' } }));
      out.push(await db.user.findMany({ where: { id: { in: ['u0', 'u1', 'u2'].slice(0, r + 1) } }, orderBy: { id: 'asc' } }));
      out.push(await db.user.findMany({ where: { n: { gte: r }, score: { lt: 4.5 + r } }, orderBy: { id: 'desc' }, take: 3 }));
      out.push(await db.user.findMany({ where: { OR: [{ name: { contains: r ? 'al' : 'BO', mode: 'insensitive' } }], NOT: { role: 'ADMIN' } }, orderBy: { id: 'asc' } }));
      out.push(await db.user.findMany({ where: { meta: { path: 'theme', eq: r % 2 ? 'dark' : 'light' } }, select: { id: true }, orderBy: { id: 'asc' } }));
      out.push(await db.user.findMany({ where: { active: r % 2 === 0 }, include: { posts: { where: { views: { gt: r } }, orderBy: { id: 'asc' }, take: 2 }, _count: { select: { posts: true } } }, orderBy: { id: 'asc' } }));
      out.push(await db.post.count({ where: { views: { gte: r * 10 } } }));
      out.push(await db.user.update({ where: { id: `u${r}` }, data: { name: `R${r}`, n: { increment: r + 1 } }, select: { id: true, name: true, n: true } }));
      out.push(await db.user.upsert({ where: { email: `up${r % 2}@x` }, create: { id: `up${r}`, email: `up${r % 2}@x`, name: 'C', n: 1, score: 1, active: true, role: 'USER', at: new Date(0) }, update: { name: `U${r}` } }));
      out.push(await db.post.updateMany({ where: { author: { is: { name: { startsWith: 'B' } } }, views: { lt: 30 + r } }, data: { views: 99 } }));
      out.push(await db.user.softDelete?.({ where: { id: `u${5 - r}` } }).catch(() => null));
      out.push(await db.user.findMany({ orderBy: { id: 'asc' }, select: { id: true, deleted_at: true } }));
      out.push(await db.post.deleteMany({ where: { views: { gte: 50 + r } } }));
      out.push(await db.user.delete({ where: { id: `up${r}` } }).catch((e: any) => e.code ?? 'err'));
    }
    out.push(await db.user.findMany({ orderBy: { id: 'asc' }, include: { posts: { orderBy: { id: 'asc' } } } }));
    h.close();
    return out;
  }

  test('sqlite: identical results', async () => {
    // A soft delete stamps the current time; compare whether it is set.
    const stamp = (rows: any[]) => JSON.parse(JSON.stringify(rows, (k, v) => (k === 'deleted_at' ? v != null : v)));
    const on = stamp(await run(true));
    const off = stamp(await run(false));
    configureCompileCache({ enabled: true });
    expect(on).toEqual(off);
  });
});
