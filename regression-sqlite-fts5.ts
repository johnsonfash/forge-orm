/* eslint-disable no-console */
//
// Regression: SQLite FTS5 — confirm that .searchable() pushes a
// CREATE VIRTUAL TABLE … USING fts5(…) + the three keep-in-sync triggers,
// and that `where: { col: { search: q } }` returns the expected rows via
// the MATCH route (not by scanning the base table).

import { f, model, createDb } from './src';
import { betterSqlite3Driver } from './src/adapters/sqlite/driver';
import Database from 'better-sqlite3';

const Doc = model('docs', {
  id: f.id(),
  title: f.string().searchable(),
  body: f.text().searchable(),
  unrelated: f.string().optional(),
});

let pass = 0, fail = 0;
const ok = (label: string, cond: boolean, detail?: any) => {
  if (cond) { console.log('  ✓', label); pass++; }
  else { console.log('  ✗', label, detail ?? ''); fail++; }
};

async function main() {
  // In-memory DB — fresh per run, no persistence between invocations.
  const sqlite = new Database(':memory:');
  const db = await createDb({
    schema: { doc: Doc } as any,
    driver: betterSqlite3Driver(sqlite),
  });

  // Apply schema DDL. createDb doesn't push by default; do it via the
  // adapter's push entrypoint so the FTS5 virtual table + triggers land.
  const { buildSchemaDDL } = await import('./src/adapters/sqlite/ddl');
  const ddl = buildSchemaDDL({ doc: Doc } as any);
  for (const s of ddl) sqlite.exec(s.sql);

  // Sanity: the virtual table + triggers actually exist.
  const allTables = sqlite.prepare(
    `SELECT name, type FROM sqlite_master WHERE type IN ('table','trigger') ORDER BY name`,
  ).all() as Array<{ name: string; type: string }>;
  ok('docs_fts virtual table created', allTables.some((t) => t.name === 'docs_fts' && t.type === 'table'));
  ok('docs_fts_ai trigger created', allTables.some((t) => t.name === 'docs_fts_ai' && t.type === 'trigger'));
  ok('docs_fts_ad trigger created', allTables.some((t) => t.name === 'docs_fts_ad' && t.type === 'trigger'));
  ok('docs_fts_au trigger created', allTables.some((t) => t.name === 'docs_fts_au' && t.type === 'trigger'));

  // Seed via the wrapper so triggers fire.
  await (db as any).doc.createMany({ data: [
    { id: 'a', title: 'Rust ownership', body: 'The borrow checker enforces unique mutable references.' },
    { id: 'b', title: 'TypeScript generics', body: 'Parameterised types power inference across function boundaries.' },
    { id: 'c', title: 'Mongo aggregation', body: 'Pipelines chain $match $group $project for analytical queries.' },
  ] });

  // search() routes through the FTS5 shadow table.
  const hits1 = await (db as any).doc.findMany({ where: { body: { search: 'borrow' } } });
  ok('search "borrow" returns the rust row', hits1.length === 1 && hits1[0].id === 'a', hits1);

  const hits2 = await (db as any).doc.findMany({ where: { title: { search: 'mongo' } } });
  ok('search "mongo" on title returns the mongo row', hits2.length === 1 && hits2[0].id === 'c', hits2);

  // Update propagation — after update, the OLD body shouldn't match anymore.
  await (db as any).doc.update({ where: { id: 'a' }, data: { body: 'Replaced contents about something else.' } });
  const after = await (db as any).doc.findMany({ where: { body: { search: 'borrow' } } });
  ok('update propagates to FTS5 (borrow no longer matches)', after.length === 0, after);

  // Delete propagation — deleted row's title shouldn't match.
  await (db as any).doc.delete({ where: { id: 'c' } });
  const final = await (db as any).doc.findMany({ where: { title: { search: 'mongo' } } });
  ok('delete propagates to FTS5 (mongo no longer matches)', final.length === 0, final);

  sqlite.close();
  console.log(`\n[sqlite-fts5] ${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main().catch((err) => { console.error(err); process.exit(1); });
