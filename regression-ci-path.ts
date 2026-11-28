// `mode: 'insensitive'` on `equals` / `not` and inside a json path, on the
// adapters that do not run through the SQL feature suite (2.29.1).
//
// Before: Mongo ignored the mode on `equals` and on every path operator, and
// IndexedDB ignored it on path `equals` / `contains` / `in` — so a search for
// a customer's name inside an embedded object matched only the exact case on
// those two while every SQL dialect already ignored case. The SQL dialects
// are covered by regression-dialect-features.ts (pg + mysql) and here
// (sqlite + duckdb) so all six run the same assertions.
//
//   npx ts-node --transpile-only --project tsconfig.json regression-ci-path.ts
import 'fake-indexeddb/auto';
import { MongoClient } from 'mongodb';
import { DuckDBInstance } from '@duckdb/node-api';
import { f, model, createDb, mongoDriver } from './src';
import { duckdbDriver } from './src/adapters/duckdb/driver';
import { buildSchemaDDL as sqliteDDL } from './src/adapters/sqlite/ddl';
import { applyMigration as sqliteApply } from './src/adapters/sqlite/migrate';
import { buildSchemaDDL as duckDDL } from './src/adapters/duckdb/ddl';

const Contact = model('ci_contacts', {
  id: f.id(),
  email: f.string(),
  meta: f.json<{ name?: string; city?: string }>().optional(),
});
const schema = { contact: Contact };

let pass = 0;
let fail = 0;
const ok = (label: string, got: unknown, want: unknown) => {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  if (g === w) { console.log('  ✓', label); pass++; }
  else { console.log('  ✗', label, 'got', g, 'want', w); fail++; }
};
const ids = (rows: Array<{ id: string }>) => rows.map((r) => r.id).sort();

async function suite(name: string, db: any) {
  console.log(`\n[${name}]`);
  await db.contact.create({ data: { id: 'c1', email: 'Ada@Example.com', meta: { name: 'Ada Obi', city: 'Lagos' } } });
  await db.contact.create({ data: { id: 'c2', email: 'bola@example.com', meta: { name: 'Bola_Ade', city: 'Abuja' } } });

  ok('equals ignores case', ids(await db.contact.findMany({ where: { email: { equals: 'ada@example.COM', mode: 'insensitive' } } })), ['c1']);
  ok('not-equals ignores case', ids(await db.contact.findMany({ where: { email: { not: 'ADA@example.com', mode: 'insensitive' } } })), ['c2']);
  ok('contains ignores case', ids(await db.contact.findMany({ where: { email: { contains: 'BOLA', mode: 'insensitive' } } })), ['c2']);
  ok('path contains ignores case (path: form)', ids(await db.contact.findMany({ where: { meta: { path: ['name'], contains: 'ADE', mode: 'insensitive' } } })), ['c2']);
  ok('path contains ignores case across both rows', ids(await db.contact.findMany({ where: { meta: { path: ['name'], contains: 'A', mode: 'insensitive' } } })), ['c1', 'c2']);
  ok('path contains ignores case (dotted form)', ids(await db.contact.findMany({ where: { 'meta.city': { contains: 'LAG', mode: 'insensitive' } } })), ['c1']);
  ok('path equals ignores case', ids(await db.contact.findMany({ where: { meta: { path: 'city', equals: 'abuja', mode: 'insensitive' } } })), ['c2']);
  ok('path not-equals ignores case', ids(await db.contact.findMany({ where: { meta: { path: 'city', not: 'LAGOS', mode: 'insensitive' } } })), ['c2']);
  ok('path in ignores case', ids(await db.contact.findMany({ where: { meta: { path: 'city', in: ['LAGOS', 'ABUJA'], mode: 'insensitive' } } })), ['c1', 'c2']);
  ok('without mode a path equals stays exact', ids(await db.contact.findMany({ where: { meta: { path: 'city', equals: 'lagos' } } })), []);
  // SQLite's LIKE ignores ASCII case on its own (as MySQL's default
  // collation does), so a case-sensitive path contains is engine-defined.
  if (name !== 'sqlite') ok('without mode a path contains stays exact', ids(await db.contact.findMany({ where: { meta: { path: ['name'], contains: 'ada' } } })), []);
  ok('in ignores case on a plain field', ids(await db.contact.findMany({ where: { email: { in: ['ADA@EXAMPLE.COM'], mode: 'insensitive' } } })), ['c1']);
  ok('% is literal', ids(await db.contact.findMany({ where: { email: { contains: '%', mode: 'insensitive' } } })), []);
  ok('_ and . in the value are literal', ids(await db.contact.findMany({ where: { meta: { path: ['name'], contains: 'a_a', mode: 'insensitive' } } })), ['c2']);
  ok('a regex character is literal', ids(await db.contact.findMany({ where: { email: { equals: 'ada@example.c.m', mode: 'insensitive' } } })), []);
}

async function main() {
  // Mongo — the adapter Dallio runs on.
  const mongo = new MongoClient(process.env.SMOKE_MONGO_URL ?? 'mongodb://127.0.0.1:27017');
  await mongo.connect();
  const DBNAME = `forge_ci_path_${Date.now()}`;
  try {
    await suite('mongo', await createDb({ schema: schema as any, driver: mongoDriver(mongo, DBNAME) }));
  } finally {
    await mongo.db(DBNAME).dropDatabase();
    await mongo.close();
  }

  // IndexedDB — the browser store.
  await suite('indexeddb', await createDb({ url: `idb://ci-path-${Date.now()}`, schema: schema as never }));

  // SQLite.
  const sqlite = await createDb({ url: 'sqlite::memory:', schema: schema as any });
  await sqliteApply((sqlite as any).adapter.db, sqliteDDL(schema as any));
  await suite('sqlite', sqlite);

  // DuckDB.
  const duck = await DuckDBInstance.create(':memory:');
  const conn = await duck.connect();
  for (const s of duckDDL(schema as any)) await conn.run(s.sql);
  await suite('duckdb', await createDb({ schema: schema as any, driver: duckdbDriver(conn) }));

  console.log(`\n[ci-path] ${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
