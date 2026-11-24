// Includes on Postgres and MySQL load either as JSON inside the parent's one
// statement or as one statement per level. Which one is chosen per query
// (planPgIncludes / planMysqlIncludes); either way the rows must be the same.
// The live parts need a local server and are skipped without one.

import { f, model, rel } from '../schema/core';
import { buildSelect } from '../ir/build';
import { setActiveSchema } from '../schema/active';
import { forcePgIncludePlan, planPgIncludes, preferJsonInclude } from '../adapters/postgres/compile-from-ir';
import { forceMysqlIncludePlan, planMysqlIncludes, preferMysqlJson } from '../adapters/mysql/execute';
import { mysqlJsonIncludes } from '../adapters/mysql/adapter';
import { configureCompileCache } from '../ir/compile-cache';

const Owner = model('ip_owners', { id: f.id({ type: 'string' }), name: f.string(), active: f.bool() })
  .relate(() => ({
    items: rel.many('ipItem', { on: 'owner_id', refs: 'id' }),
    links: rel.many('ipLink', { on: 'owner_id', refs: 'id' }),
  }));
const Item = model('ip_items', {
  id: f.id({ type: 'string' }), owner_id: f.string(), title: f.string(), at: f.dateTime(), n: f.int(),
  ratio: f.float(), ok: f.bool(), meta: f.json<any>().optional(), note: f.string().optional(), tags: f.stringArray().optional(),
}).relate(() => ({
  owner: rel.one('ipOwner', { on: 'owner_id', refs: 'id' }),
  notes: rel.many('ipNote', { on: 'item_id', refs: 'id' }),
}));
const Note = model('ip_notes', { id: f.id({ type: 'string' }), item_id: f.string(), body: f.string(), by_id: f.string().optional() })
  .relate(() => ({
    item: rel.one('ipItem', { on: 'item_id', refs: 'id' }),
    by: rel.one('ipOwner', { on: 'by_id', refs: 'id' }),
  }));
const Tag = model('ip_tags', { id: f.id({ type: 'string' }), name: f.string() });
const Link = model('ip_links', { id: f.id({ type: 'string' }), owner_id: f.string(), tag_id: f.string() })
  .relate(() => ({
    owner: rel.one('ipOwner', { on: 'owner_id', refs: 'id' }),
    tag: rel.one('ipTag', { on: 'tag_id', refs: 'id' }),
  }));
const sch = { ipOwner: Owner, ipItem: Item, ipNote: Note, ipTag: Tag, ipLink: Link } as any;

// Shapes that cover what JSON has to get right: order (by text, number, date,
// both directions, with ties), paging per parent, to-one, nested levels,
// counts, filters, and a relation with no rows.
const QUERIES: Array<[string, (db: any, n: number) => Promise<any>]> = [
  ['to-one', (db, n) => db.ipItem.findMany({ orderBy: { id: 'asc' }, take: n, include: { owner: true } })],
  ['to-many unpaged', (db, n) => db.ipOwner.findMany({ orderBy: { id: 'asc' }, take: n, include: { items: { orderBy: { id: 'asc' } } } })],
  ['paged, ordered by text desc', (db, n) => db.ipOwner.findMany({ orderBy: { id: 'asc' }, take: n, include: { items: { orderBy: [{ title: 'desc' }, { id: 'asc' }], take: 3 } } })],
  ['paged, by number then date', (db, n) => db.ipOwner.findMany({ orderBy: { id: 'asc' }, take: n, include: { items: { orderBy: [{ n: 'asc' }, { at: 'desc' }, { id: 'asc' }], skip: 1, take: 2 } } })],
  ['nested, counts, filter', (db, n) => db.ipOwner.findMany({ where: { active: true }, orderBy: { id: 'asc' }, take: n, include: {
    _count: { select: { items: true } },
    items: { where: { ok: true }, orderBy: [{ at: 'asc' }, { id: 'asc' }], take: 2, select: { id: true, at: true, ok: true, meta: true, tags: true,
      _count: { select: { notes: true } }, notes: { orderBy: { id: 'desc' }, take: 2, select: { id: true, body: true, by: { select: { id: true, name: true } } } } } },
  } })],
  ['link table', (db, n) => db.ipOwner.findMany({ orderBy: { id: 'asc' }, take: n, select: { id: true, links: { select: { id: true, tag: { select: { id: true, name: true } } } } } })],
  ['findUnique with include', (db) => db.ipOwner.findUnique({ where: { id: 'o1' }, include: { items: { orderBy: { id: 'asc' }, include: { notes: { orderBy: { id: 'asc' } } } } } })],
];

async function seed(db: any) {
  for (let o = 1; o <= 6; o++) await db.ipOwner.create({ data: { id: `o${o}`, name: `Owner ${o}`, active: o % 3 !== 0 } });
  for (let t = 1; t <= 4; t++) await db.ipTag.create({ data: { id: `t${t}`, name: `tag ${t}` } });
  let k = 0;
  for (let o = 1; o <= 5; o++) {
    for (let i = 0; i < 5; i++, k++) {
      await db.ipItem.create({ data: {
        id: `i${String(k).padStart(3, '0')}`, owner_id: `o${o}`, title: ['b', 'B', 'a', 'é', 'c'][i], at: new Date(Date.UTC(2025, 0, 1 + (k % 4), 0, 0, 0, 123)),
        n: k % 3, ratio: 0.5 + k, ok: k % 2 === 0, meta: k % 3 ? { k, deep: { x: [1, 'y'] } } : null, note: k % 2 ? null : `n${k}`, tags: k % 4 ? [`a${k}`, 'z'] : [],
      } });
      for (let m = 0; m < k % 3; m++) await db.ipNote.create({ data: { id: `n${k}_${m}`, item_id: `i${String(k).padStart(3, '0')}`, body: `note ${m}`, by_id: m ? `o${(k % 6) + 1}` : null } });
    }
    for (let t = 1; t <= (o % 4); t++) await db.ipLink.create({ data: { id: `l${o}_${t}`, owner_id: `o${o}`, tag_id: `t${t}` } });
  }
}

// Text sort keys compare under the column's collation; within a tie the
// order is up to the server, so compare tied runs as sets.
const canon = (v: any): any => JSON.parse(JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? `${x}n` : x)));

async function sameRows(db: any, force: (p: 'json' | 'batched' | undefined) => void, jsonMark: RegExp) {
  configureCompileCache({ enabled: false });
  const sql: string[] = [];
  const off = db.$on('query', (e: any) => { sql.push(e.sql); });
  try {
    for (const [name, q] of QUERIES) {
      for (const n of [1, 3, 6]) {
        force('json');
        const a = canon(await q(db, n));
        force('batched');
        const b = canon(await q(db, n));
        force(undefined);
        const c = canon(await q(db, n));
        expect({ name, n, json: a }).toEqual({ name, n, json: b });
        expect({ name, n, auto: c }).toEqual({ name, n, auto: b });
      }
    }
    // The JSON plan really ran, and the per-level one really did not.
    expect(sql.some((q) => jsonMark.test(q))).toBe(true);
    expect(sql.some((q) => !jsonMark.test(q) && /ip_items/.test(q))).toBe(true);
  } finally {
    off?.();
    force(undefined);
    configureCompileCache({ enabled: true });
  }
}

describe('include plan rules', () => {
  beforeAll(() => setActiveSchema(sch));
  const node = (args: any, card: 'one' | 'many' = 'many') => buildSelect('ipOwner', Owner, args, card, sch);
  const rel0 = (args: any, card: 'one' | 'many' = 'many') => node(args, card).hydration![0];

  test('postgres: JSON for small and paged includes, per level for big unpaged ones', () => {
    expect(preferJsonInclude(10, rel0({ include: { items: true } }))).toBe(true);
    expect(preferJsonInclude(200, rel0({ include: { items: true } }))).toBe(false);
    expect(preferJsonInclude(1000, rel0({ include: { items: { take: 5 } } }))).toBe(true);
    expect(preferJsonInclude(10, rel0({ include: { items: { include: { notes: true } } } }))).toBe(false);
    expect(preferJsonInclude(1, rel0({ include: { items: { include: { notes: true } } } }))).toBe(true);
    const item = (args: any) => buildSelect('ipItem', Item, args, 'many', sch).hydration![0];
    expect(preferJsonInclude(20, item({ include: { owner: true } }))).toBe(true);
    expect(preferJsonInclude(50, item({ include: { owner: true } }))).toBe(false);
  });

  test('mysql: link tables and small pages as JSON; never an unpaged to-many past one parent', () => {
    expect(preferMysqlJson(50, rel0({ select: { links: { select: { id: true, tag: true } } } }))).toBe(true);
    expect(preferMysqlJson(1, rel0({ include: { items: true } }))).toBe(true);
    expect(preferMysqlJson(2, rel0({ include: { items: true } }))).toBe(false);
    expect(preferMysqlJson(10, rel0({ include: { items: { take: 3 } } }))).toBe(true);
    expect(preferMysqlJson(50, rel0({ include: { items: { take: 3 } } }))).toBe(false);
    expect(preferMysqlJson(1, rel0({ include: { items: { take: 3, include: { notes: { take: 2 } } } } }))).toBe(true);
    expect(preferMysqlJson(10, rel0({ include: { items: { take: 3, include: { notes: { take: 2 } } } } }))).toBe(false);
  });

  test('the decision is recorded on the node, unpaged parents count as many', () => {
    const planned = planPgIncludes(node({ include: { items: true } }), Owner);
    expect((planned.hydration![0] as any).json).toBe(false);
    const one = planPgIncludes(node({ where: { id: 'o1' }, include: { items: true } }, 'one'), Owner);
    expect((one.hydration![0] as any).json).toBe(true);
    const my = planMysqlIncludes(node({ take: 5, include: { items: { take: 2 } } }), Owner);  // paged, 5 parents
    expect((my.hydration![0] as any).json).toBe(true);
    // A page per parent of the level above bounds nothing: per level.
    const part = planPgIncludes({ ...node({ take: 5, include: { items: { take: 2 } } }), partitionBy: 'owner_id' } as any, Owner);
    expect((part.hydration![0] as any).json).toBe(false);
  });

  test('mysql JSON needs MySQL 8.0.14 and not MariaDB', () => {
    expect(mysqlJsonIncludes('8.0.13')).toBe(false);
    expect(mysqlJsonIncludes('8.0.14')).toBe(true);
    expect(mysqlJsonIncludes('9.7.1')).toBe(true);
    expect(mysqlJsonIncludes('10.11.6-MariaDB')).toBe(false);
  });
});

describe('postgres (live): both include plans return the same rows', () => {
  const { createDb } = require('../factory');
  const { pgDriver } = require('../adapters/postgres/driver');
  let pool: any; let admin: any; let db: any; const name = `forge_spec_plans_${process.pid}`;
  beforeAll(async () => {
    const { Pool } = require('pg');
    admin = new Pool({ connectionString: 'postgres://postgres@127.0.0.1:5432/postgres', connectionTimeoutMillis: 1000 });
    try { await admin.query(`CREATE DATABASE ${name}`); } catch { await admin.end().catch(() => {}); admin = null; return; }
    pool = new Pool({ connectionString: `postgres://postgres@127.0.0.1:5432/${name}` });
    const { buildSchemaDDL } = require('../adapters/postgres/ddl');
    const { applyMigration } = require('../adapters/postgres/migrate');
    await applyMigration(pool, buildSchemaDDL(sch));
    db = await createDb({ schema: sch, driver: pgDriver(pool) });
    await seed(db);
  }, 30_000);
  afterAll(async () => {
    await pool?.end();
    if (admin) { await admin.query(`DROP DATABASE IF EXISTS ${name}`).catch(() => {}); await admin.end(); }
  });
  test('json, per level and the chosen plan agree', async () => {
    if (!db) { console.warn('no local server: live include-plan check skipped'); return; }
    await sameRows(db, forcePgIncludePlan, /json_agg|row_to_json/);
  }, 30_000);
});

describe('mysql (live): both include plans return the same rows', () => {
  const { createDb } = require('../factory');
  const { mysql2Driver } = require('../adapters/mysql/driver');
  let pool: any; let db: any; let root: any; const name = `forge_spec_plans_${process.pid}`;
  beforeAll(async () => {
    const mysql = require('mysql2/promise');
    try { root = await mysql.createConnection({ uri: 'mysql://root@127.0.0.1:3306', connectTimeout: 1000 }); } catch { root = null; return; }
    await root.query(`CREATE DATABASE \`${name}\``);
    pool = mysql.createPool({ uri: `mysql://root@127.0.0.1:3306/${name}`, connectionLimit: 4 });
    const { buildSchemaDDL } = require('../adapters/mysql/ddl');
    const { applyMigration } = require('../adapters/mysql/migrate');
    await applyMigration(pool, buildSchemaDDL(sch));
    db = await createDb({ schema: sch, driver: mysql2Driver(pool) });
    await seed(db);
  }, 30_000);
  afterAll(async () => {
    await pool?.end();
    if (root) { await root.query(`DROP DATABASE IF EXISTS \`${name}\``).catch(() => {}); await root.end(); }
  });
  test('json, per level and the chosen plan agree', async () => {
    if (!db) { console.warn('no local server: live include-plan check skipped'); return; }
    await sameRows(db, forceMysqlIncludePlan, /JSON_ARRAYAGG|JSON_OBJECT/);
  }, 30_000);
});
