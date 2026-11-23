/* eslint-disable no-console */
// `select: false` on single writes against real MySQL and Postgres servers
// (local; each dialect is skipped when its server does not answer).
//
// What it pins:
//   • update / upsert / delete / create resolve to null and send ONE statement
//     on MySQL (no read-back SELECT) and no RETURNING on Postgres
//   • a match that changes nothing is still a match on MySQL (affectedRows
//     counts changed rows; "Rows matched" is what decides)
//   • a miss still throws
//   • a MySQL upsert writes the update value on a conflict

import { createDb, mysql2Driver, pgDriver, setActiveSchema } from './src';
import { f, model } from './src/schema/core';

const Thing = model('sf_things', { id: f.id({ type: 'string' }), email: f.string().unique(), n: f.int() });
const schema = { thing: Thing } as const;

let pass = 0, fail = 0;
const check = (l: string, c: boolean, d = '') => { console.log(`  ${c ? '✓' : '✗'} ${l}${c ? '' : `  << ${d}`}`); c ? pass++ : fail++; };

async function run(name: string, db: any, sent: string[]) {
  console.log(`\n[${name}]`);
  await db.thing.create({ data: { id: 'a', email: 'a@x', n: 1 } });
  sent.length = 0;
  check('update resolves to null', (await db.thing.update({ where: { id: 'a' }, data: { n: { increment: 1 } }, select: false })) === null);
  check('update is one statement, no RETURNING', sent.length === 1 && !/RETURNING/i.test(sent[0]), sent.join(' | '));
  check('the increment landed', (await db.thing.findUnique({ where: { id: 'a' } })).n === 2);
  check('a no-op update is not a miss', (await db.thing.update({ where: { id: 'a' }, data: { n: 2 }, select: false })) === null);
  let threw = false;
  try { await db.thing.update({ where: { id: 'zz' }, data: { n: 1 }, select: false }); } catch { threw = true; }
  check('a miss throws', threw);
  sent.length = 0;
  await db.thing.upsert({ where: { email: 'a@x' }, create: { id: 'b', email: 'a@x', n: 0 }, update: { n: 11 }, select: false });
  check('upsert is one statement', sent.length === 1, sent.join(' | '));
  check('upsert conflict writes the update value', (await db.thing.findUnique({ where: { id: 'a' } })).n === 11);
  await db.thing.upsert({ where: { email: 'c@x' }, create: { id: 'c', email: 'c@x', n: 5 }, update: { n: 0 }, select: false });
  check('upsert insert path', (await db.thing.findUnique({ where: { id: 'c' } }))?.n === 5);
  sent.length = 0;
  check('delete resolves to null', (await db.thing.delete({ where: { id: 'c' }, select: false })) === null);
  check('delete is one statement', sent.length === 1, sent.join(' | '));
  threw = false;
  try { await db.thing.delete({ where: { id: 'c' }, select: false }); } catch { threw = true; }
  check('deleting it again throws', threw);
  sent.length = 0;
  check('create resolves to null', (await db.thing.create({ data: { id: 'd', email: 'd@x', n: 1 }, select: false })) === null);
  check('create is one statement, no RETURNING', sent.length === 1 && !/RETURNING/i.test(sent[0]), sent.join(' | '));
}

async function main() {
  setActiveSchema(schema as never);
  // MySQL
  try {
    const mysql = require('mysql2/promise');
    const root = await mysql.createConnection({ uri: 'mysql://root@127.0.0.1:3306', connectTimeout: 1000 });
    await root.query('DROP DATABASE IF EXISTS forge_sf'); await root.query('CREATE DATABASE forge_sf'); await root.end();
    const pool = mysql.createPool({ uri: 'mysql://root@127.0.0.1:3306/forge_sf' });
    const sent: string[] = [];
    const { buildSchemaDDL } = require('./src/adapters/mysql/ddl');
    const { applyMigration } = require('./src/adapters/mysql/migrate');
    await applyMigration(pool, buildSchemaDDL(schema as never));
    const drv = mysql2Driver(pool) as any;
    for (const m of ['query', 'execute']) { const o = drv[m].bind(drv); drv[m] = (s: string, p?: unknown[]) => { sent.push(s); return o(s, p); }; }
    const multi = mysql.createPool({ uri: 'mysql://root@127.0.0.1:3306/forge_sf', multipleStatements: true });
    try {
      await run('mysql', await createDb({ schema, driver: drv } as never), sent);
      console.log('\n[mysql, multipleStatements]');
      const mdrv = mysql2Driver(multi) as any;
      const msent: string[] = [];
      for (const m of ['query', 'execute']) { const o = mdrv[m].bind(mdrv); mdrv[m] = (s: string, p?: unknown[]) => { msent.push(s); return o(s, p); }; }
      const mdb: any = await createDb({ schema, driver: mdrv } as never);
      msent.length = 0;
      const row = await mdb.thing.update({ where: { id: 'a' }, data: { n: { increment: 1 } } });
      check('update returns the row', row?.n === 12, JSON.stringify(row));
      check('in one round trip', msent.length === 1 && /;\s*SELECT/.test(msent[0]), msent.join(' | '));
      let missed = false;
      try { await mdb.thing.update({ where: { id: 'zz' }, data: { n: 1 } }); } catch { missed = true; }
      check('a miss still throws', missed);
    }
    finally {
      await multi.end();
      await pool.end();
      const c = await mysql.createConnection({ uri: 'mysql://root@127.0.0.1:3306' }); await c.query('DROP DATABASE forge_sf'); await c.end();
    }
  } catch (e: any) { if (/ECONNREFUSED|connect/i.test(String(e?.message))) console.log('[mysql] skipped: no server'); else throw e; }
  // Postgres
  try {
    const { Pool } = require('pg');
    const admin = new Pool({ connectionString: 'postgres://postgres@127.0.0.1:5432/postgres', connectionTimeoutMillis: 1000 });
    await admin.query('DROP DATABASE IF EXISTS forge_sf'); await admin.query('CREATE DATABASE forge_sf');
    const pool = new Pool({ connectionString: 'postgres://postgres@127.0.0.1:5432/forge_sf' });
    const { buildSchemaDDL } = require('./src/adapters/postgres/ddl');
    const { applyMigration } = require('./src/adapters/postgres/migrate');
    await applyMigration(pool, buildSchemaDDL(schema as never));
    const sent: string[] = [];
    const drv = pgDriver(pool) as any;
    const o = drv.query.bind(drv); drv.query = (s: string, p?: unknown[]) => { sent.push(s); return o(s, p); };
    try { await run('postgres', await createDb({ schema, driver: drv } as never), sent); }
    finally { await pool.end(); await admin.query('DROP DATABASE forge_sf'); await admin.end(); }
  } catch (e: any) { if (/ECONNREFUSED|connect/i.test(String(e?.message))) console.log('[postgres] skipped: no server'); else throw e; }
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
}
main().catch((e) => { console.error(e); process.exit(1); });
