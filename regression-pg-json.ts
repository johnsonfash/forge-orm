/* eslint-disable no-console */
// JSON values over BOTH Postgres drivers, read back by the server itself.
//
// postgres.js asks the server what type each parameter is and, for json/jsonb,
// runs its own JSON.stringify. forge used to stringify first (node-postgres
// needs that), so over postgres.js every JSON write landed as a jsonb STRING
// holding the text of the object: jsonb_typeof = 'string', not 'object'.
// Every check here asks Postgres for jsonb_typeof, so a double-encoded value
// cannot pass by round-tripping through the same bug on the way out.
//
// Uses the local Postgres; creates and drops one table per driver.

import pg from 'pg';
import postgres from 'postgres';
import { createDb, pgDriver, postgresJsDriver } from './src';
import { f, model } from './src/schema/core';
import { buildSchemaDDL } from './src/adapters/postgres/ddl';

const URL = process.env.SMOKE_PG_URL
  ?? `postgres://${process.env.SMOKE_PG_USER ?? 'postgres'}@127.0.0.1:5432/postgres`;

let pass = 0, fail = 0;
const check = (l: string, c: boolean, d = '') => { console.log(`  ${c ? '✓' : '✗'} ${l}${c ? '' : `  << ${d}`}`); c ? pass++ : fail++; };

async function suite(label: string, driver: any, table: string) {
  console.log(`\n[${label}]`);
  const Doc = model(table, {
    id: f.id({ type: 'string' }),
    meta: f.json(),
    tags: f.json().optional(),
  });
  const schema = { doc: Doc } as const;
  const db = await createDb({ schema: schema as any, driver });
  const q = (text: string, params: unknown[] = []) => (db.adapter as any).driver.query(text, params);
  const typeOf = async (id: string, col = 'meta') =>
    (await q(`SELECT jsonb_typeof("${col}") AS t FROM "${table}" WHERE id = $1`, [id])).rows[0]?.t;

  await q(`DROP TABLE IF EXISTS "${table}"`);
  for (const s of buildSchemaDDL(schema as any)) await q(s.sql);

  // create
  const a = await db.doc.create({ data: { id: 'a', meta: { n: 1, s: 'x;y' }, tags: ['red', 'blue'] } });
  check('create: stored as an object', (await typeOf('a')) === 'object', String(await typeOf('a')));
  check('create: array stored as an array', (await typeOf('a', 'tags')) === 'array', String(await typeOf('a', 'tags')));
  check('create: returns the object', a?.meta?.n === 1 && a?.meta?.s === 'x;y', JSON.stringify(a));

  // createMany
  await db.doc.createMany({ data: [{ id: 'b', meta: { n: 2 } }, { id: 'c', meta: { n: 3 } }] });
  check('createMany: stored as objects', (await typeOf('b')) === 'object' && (await typeOf('c')) === 'object');

  // update (whole value)
  await db.doc.update({ where: { id: 'b' }, data: { meta: { n: 20, nested: { ok: true } } } });
  check('update: stored as an object', (await typeOf('b')) === 'object', String(await typeOf('b')));
  const b = await db.doc.findUnique({ where: { id: 'b' } });
  check('update: reads back as an object', b?.meta?.nested?.ok === true, JSON.stringify(b));

  // upsert, both branches
  await db.doc.upsert({ where: { id: 'd' }, create: { id: 'd', meta: { n: 4 } }, update: { meta: { n: 40 } } });
  check('upsert create: stored as an object', (await typeOf('d')) === 'object', String(await typeOf('d')));
  await db.doc.upsert({ where: { id: 'd' }, create: { id: 'd', meta: { n: 4 } }, update: { meta: { n: 40 } } });
  const d = await db.doc.findUnique({ where: { id: 'd' } });
  check('upsert update: stored as an object', (await typeOf('d')) === 'object' && d?.meta?.n === 40, JSON.stringify(d));

  // a dotted key writes inside the JSON value (jsonb_set path)
  await db.doc.update({ where: { id: 'c' }, data: { 'meta.inner': { deep: 1 } } as any });
  const inner = (await q(`SELECT jsonb_typeof(meta->'inner') AS t, meta->'inner'->>'deep' AS v FROM "${table}" WHERE id = 'c'`)).rows[0];
  check('dotted write: nested value is an object', inner?.t === 'object' && inner?.v === '1', JSON.stringify(inner));

  // jsonb containment filters (has / hasSome / hasEvery on a JSON array)
  const has = await db.doc.findMany({ where: { tags: { has: 'red' } } as any });
  check('filter has on a JSON array', has.map((r: any) => r.id).join() === 'a', JSON.stringify(has.map((r: any) => r.id)));
  const some = await db.doc.findMany({ where: { tags: { hasSome: ['green', 'blue'] } } as any });
  check('filter hasSome on a JSON array', some.map((r: any) => r.id).join() === 'a', JSON.stringify(some.map((r: any) => r.id)));
  const every = await db.doc.findMany({ where: { tags: { hasEvery: ['red', 'blue'] } } as any });
  check('filter hasEvery on a JSON array', every.map((r: any) => r.id).join() === 'a', JSON.stringify(every.map((r: any) => r.id)));

  await q(`DROP TABLE IF EXISTS "${table}"`);
  await db.$disconnect?.();
}

async function main() {
  const pool = new pg.Pool({ connectionString: URL });
  await suite('node-postgres', pgDriver(pool), 'forge_json_pg');
  await suite('postgres.js prepare:true', postgresJsDriver(postgres(URL)), 'forge_json_pgjs');
  await suite('postgres.js prepare:false', postgresJsDriver(postgres(URL, { prepare: false })), 'forge_json_pgjs_np');
  console.log(`\n${fail === 0 ? '✅' : '❌'} [pg-json] ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
