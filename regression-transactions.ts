/* eslint-disable no-console */
// Transaction proof against a real Postgres, in-process via PGlite — no
// server, so CI runs it unconditionally.
//
// PGlite rather than SQLite deliberately: SQLite's $transaction hands back the
// shared connection, so a rollback there passes whether or not the session was
// propagated. On Postgres the session is load-bearing — a query issued without
// it goes to another connection and is not in the transaction at all. Only
// this dialect can tell the two apart.
//
// What it pins:
//   • a callback that discards `tx` and calls a repository layer is STILL
//     atomic (2.19.0 — before, those queries escaped the transaction and
//     nothing rolled back, while the code read as though it did)
//   • the array form is atomic when given thunks
//   • the array form is refused when given already-running promises
//   • a nested $transaction joins the open one instead of opening a second

import { createDb, setActiveSchema } from './src';
import { f, model } from './src/schema/core';
import { buildSchemaDDL } from './src/adapters/postgres/ddl';

const Acct = model('accts', { id: f.id(), bal: f.int() });
const schema = { acct: Acct } as const;

let pass = 0, fail = 0;
const check = (l: string, c: boolean, d = '') => { console.log(`  ${c ? '✓' : '✗'} ${l}${c ? '' : `  << ${d}`}`); c ? pass++ : fail++; };

async function main() {
  setActiveSchema(schema as never);
  const db = await createDb({ url: 'pglite:', schema: schema as never }) as never as Record<string, any>;
  const drv = (db.adapter as { driver: { query(s: string, p: unknown[]): Promise<unknown> } }).driver;
  for (const st of buildSchemaDDL(schema as never)) await drv.query(st.sql, []).catch(() => undefined);

  // Repository functions: they hold the ambient db and know nothing about
  // transactions. This is the shape that silently escaped.
  const debit = (id: string, n: number) => db.acct.update({ where: { id }, data: { bal: { decrement: n } } });
  const credit = (id: string, n: number) => db.acct.update({ where: { id }, data: { bal: { increment: n } } });

  const reset = async () => {
    await db.acct.deleteMany({});
    await db.acct.create({ data: { id: 'a', bal: 100 } });
    await db.acct.create({ data: { id: 'b', bal: 0 } });
  };
  const bals = async () => {
    const a = await db.acct.findFirst({ where: { id: 'a' } });
    const b = await db.acct.findFirst({ where: { id: 'b' } });
    return `${a?.bal}/${b?.bal}`;
  };

  console.log('[1] callback form, repository calls, no tx handle');
  await reset();
  try {
    await db.$transaction(async () => { await debit('a', 40); await credit('b', 40); throw new Error('boom'); });
  } catch { /* expected */ }
  check('a throw rolls both legs back', (await bals()) === '100/0', await bals());
  await db.$transaction(async () => { await debit('a', 40); await credit('b', 40); });
  check('and they commit together', (await bals()) === '60/40', await bals());

  console.log('[2] a failure halfway');
  await reset();
  try { await db.$transaction(async () => { await debit('a', 40); throw new Error('half'); }); } catch { /* expected */ }
  check('neither leg is applied', (await bals()) === '100/0', await bals());

  console.log('[3] nesting');
  await reset();
  try {
    await db.$transaction(async () => {
      await debit('a', 40);
      // A repository opening a transaction defensively, from the ambient db.
      await db.$transaction(async () => { await credit('b', 40); });
      throw new Error('outer');
    });
  } catch { /* expected */ }
  check('the inner one joins, so the outer rollback covers it', (await bals()) === '100/0', await bals());

  console.log('[4] array of thunks');
  await reset();
  try { await db.$transaction([() => debit('a', 40), () => { throw new Error('second'); }]); } catch { /* expected */ }
  check('a throw rolls back', (await bals()) === '100/0', await bals());
  const out = await db.$transaction([() => debit('a', 40), () => credit('b', 40)]);
  check('commits and returns results in order', Array.isArray(out) && out.length === 2 && out[0].bal === 60, JSON.stringify(out));

  console.log('[5] array of already-running promises');
  await reset();
  let refused = '';
  try { await db.$transaction([debit('a', 1), credit('b', 1)]); } catch (e) { refused = (e as Error).message; }
  check('is refused rather than silently un-atomic', /takes functions, not promises/.test(refused), refused.slice(0, 80));

  console.log('[6] work outside a transaction is untouched');
  await reset();
  await db.$transaction(async () => { await debit('a', 10); });
  await credit('b', 5);
  check('the session does not leak past the callback', (await bals()) === '90/5', await bals());

  await db.$disconnect();
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
