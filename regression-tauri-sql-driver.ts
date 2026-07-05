/* eslint-disable no-console */
// Proof that the `tauriSqlDriver` port works end-to-end. We can't spin up a
// Tauri runtime in Node, so this test fakes `@tauri-apps/plugin-sql`'s
// `Database` — same shape (`execute(sql, params)` returns
// `{rowsAffected, lastInsertId}`, `select(sql, params)` returns rows) — backed
// by better-sqlite3 in-memory. If the port compiles the IR into the right
// wire calls, the same code will work over the real plugin at runtime.

import BetterSqlite3 from 'better-sqlite3';
import { createDb, col, tauriSqlDriver } from './src';
import { f, model } from './src/schema/core';
import { buildSchemaDDL } from './src/adapters/sqlite/ddl';
import { applyMigration } from './src/adapters/sqlite/migrate';

// Fake @tauri-apps/plugin-sql Database. Exposes the exact two-method surface
// (execute + select) the plugin exports, backed by better-sqlite3 so we don't
// need a Tauri runtime.
function fakeTauriDatabase(filename: string): any {
  const db = new BetterSqlite3(filename);
  db.exec('PRAGMA foreign_keys = ON');
  return {
    async execute(sql: string, params: unknown[] = []) {
      const r = db.prepare(sql).run(...(params as any[]));
      return { rowsAffected: r.changes, lastInsertId: Number(r.lastInsertRowid) };
    },
    async select<T>(sql: string, params: unknown[] = []): Promise<T> {
      return db.prepare(sql).all(...(params as any[])) as any;
    },
    async close() { db.close(); return true; },
  };
}

const Order = model('orders', {
  id: f.id(),
  status: f.string(),
  total: f.int().default(0),
  cap: f.int().default(0),
});
const schema = { order: Order } as const;

let pass = 0, fail = 0;
const check = (l: string, c: boolean, d = '') => { console.log(`  ${c ? '✓' : '✗'} ${l}${c ? '' : `  << ${d}`}`); c ? pass++ : fail++; };

async function main() {
  const tauri = fakeTauriDatabase(':memory:');
  const db = await createDb({ schema: schema as any, driver: tauriSqlDriver(tauri) });

  const rep = await applyMigration((db.adapter as any).db, buildSchemaDDL(schema as any));
  check('tauri-sql driver: DDL applied', rep.failures.length === 0, JSON.stringify(rep.failures));

  // create (RETURNING * over the async driver)
  const a = await db.order.create({ data: { id: 'a', status: 'paid', total: 100, cap: 5 } });
  check('create returns the row', a?.id === 'a' && a.total === 100, JSON.stringify(a));
  await db.order.create({ data: { id: 'b', status: 'paid', total: 300, cap: 5 } });
  await db.order.create({ data: { id: 'c', status: 'pending', total: 50, cap: 1 } });

  // read
  const paid = await db.order.findMany({ where: { status: 'paid' }, orderBy: { total: 'asc' } });
  check('findMany filters + orders', paid.map((r: any) => r.id).join(',') === 'a,b', JSON.stringify(paid.map((r: any) => r.id)));

  // update
  const upd = await db.order.update({ where: { id: 'a' }, data: { total: 150 } });
  check('update returns updated row', upd?.total === 150, JSON.stringify(upd));

  // col() atomic guard over the async driver — 100+1<5 false, so P2025
  const guarded = await db.order.update({ where: { id: 'b', total: { lt: col('cap') } as any }, data: { total: { increment: 1 } } })
    .then(() => 'ok').catch((e: any) => e?.code === 'P2025' ? 'rejected' : 'error:' + e?.message);
  check('col() guard rejects when over cap (P2025)', guarded === 'rejected', guarded);

  // groupBy + count(distinct)
  const g = await db.order.groupBy({ by: ['status'], _count: { _all: true }, _sum: { total: true } });
  const byStatus: any = {}; for (const r of g) byStatus[r.status] = r;
  check('groupBy paid count=2 sum=450', byStatus.paid?._count?._all === 2 && Number(byStatus.paid?._sum?.total) === 450, JSON.stringify(g));

  // delete
  await db.order.delete({ where: { id: 'b' } });
  check('delete + count', (await db.order.count({})) === 2, String(await db.order.count({})));

  // transaction over the async driver
  await db.$transaction(async (tx: any) => {
    await tx.order.create({ data: { id: 'tx1', status: 'x', total: 1, cap: 9 } });
  });
  check('transaction commit', !!(await db.order.findUnique({ where: { id: 'tx1' } })), 'tx row missing');

  // exec batch — the port splits multi-statement DDL because tauri's
  // execute takes one statement at a time. Prove the split fires without
  // choking on trailing semicolons.
  await (db.adapter as any).db.exec(
    "CREATE TABLE bulk (id TEXT PRIMARY KEY, n INT);\nCREATE INDEX bulk_n ON bulk (n);\n"
  );
  await tauri.execute("INSERT INTO bulk (id, n) VALUES ('x', 1)", []);
  const bulkRows: any[] = await tauri.select("SELECT * FROM bulk WHERE id = ?", ['x']);
  check('multi-statement exec batch applied', bulkRows.length === 1 && bulkRows[0].n === 1, JSON.stringify(bulkRows));

  await db.$disconnect();
  console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} passed, ${fail} failed (tauri-sql driver)`);
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
