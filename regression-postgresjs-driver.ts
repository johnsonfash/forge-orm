/* eslint-disable no-console */
// Real-Postgres proof: run forge over postgres.js (porsager) via the pluggable
// PostgresDriver port. node-postgres (pg) is never loaded here. Uses the local
// DBngin Postgres; creates + drops a uniquely-named table, touches nothing else.

import postgres from 'postgres';
import { createDb, col, postgresJsDriver } from './src';
import { f, model } from './src/schema/core';
import { buildSchemaDDL } from './src/adapters/postgres/ddl';

const URL = process.env.SMOKE_PG_URL
  ?? `postgres://${process.env.SMOKE_PG_USER ?? 'postgres'}@127.0.0.1:5432/postgres`;
const TABLE = 'forge_pgjs_orders';

const Order = model(TABLE, {
  id: f.id(),
  status: f.string(),
  total: f.int().default(0),
  cap: f.int().default(0),
});
const schema = { order: Order } as const;

let pass = 0, fail = 0;
const check = (l: string, c: boolean, d = '') => { console.log(`  ${c ? '✓' : '✗'} ${l}${c ? '' : `  << ${d}`}`); c ? pass++ : fail++; };

async function main() {
  const sql = postgres(URL);
  const db = await createDb({ schema: schema as any, driver: postgresJsDriver(sql) });
  const driver = (db.adapter as any).driver;

  // Fresh table via the postgres.js driver (DDL through driver.query).
  await driver.query(`DROP TABLE IF EXISTS "${TABLE}"`, []);
  for (const stmt of buildSchemaDDL(schema as any)) await driver.query(stmt.sql, []);
  check('DDL applied via postgres.js driver', true);

  // create (RETURNING * over postgres.js)
  const a = await db.order.create({ data: { id: 'a', status: 'paid', total: 100, cap: 5 } });
  check('create returns row', a?.id === 'a' && a.total === 100, JSON.stringify(a));
  await db.order.create({ data: { id: 'b', status: 'paid', total: 300, cap: 5 } });
  await db.order.create({ data: { id: 'c', status: 'pending', total: 50, cap: 1 } });

  // read + order
  const paid = await db.order.findMany({ where: { status: 'paid' }, orderBy: { total: 'asc' } });
  check('findMany filter+order', paid.map((r: any) => r.id).join(',') === 'a,b', JSON.stringify(paid.map((r: any) => r.id)));

  // col() guard (field-vs-field) over postgres.js
  const guard = await db.order.update({ where: { id: 'a', total: { lt: col('cap') } as any }, data: { total: { increment: 1 } } })
    .then(() => 'ok').catch((e: any) => e?.code === 'P2025' ? 'rejected' : 'error');
  check('col() guard rejects when total>=cap (100>=5)', guard === 'rejected', guard);

  // groupBy + having + count distinct
  const g = await db.order.groupBy({ by: ['status'], _count: { _all: true }, _sum: { total: true } });
  const byS: any = {}; for (const r of g) byS[r.status] = r;
  check('groupBy paid count=2 sum=400', byS.paid?._count?._all === 2 && Number(byS.paid?._sum?.total) === 400, JSON.stringify(g));
  const distinct = await db.order.count({ distinct: ['status'] });
  check('count distinct status = 2', distinct === 2, String(distinct));

  // transaction over postgres.js (sql.begin under the hood)
  await db.$transaction(async (tx: any) => {
    await tx.order.create({ data: { id: 'tx1', status: 'x', total: 1, cap: 9 } });
  });
  check('transaction commit', !!(await db.order.findUnique({ where: { id: 'tx1' } })), 'tx row missing');

  // rollback
  let rolled = false;
  try {
    await db.$transaction(async (tx: any) => {
      await tx.order.create({ data: { id: 'tx2', status: 'x', total: 1, cap: 9 } });
      throw new Error('boom');
    });
  } catch { rolled = true; }
  check('transaction rollback', rolled && !(await db.order.findUnique({ where: { id: 'tx2' } })), 'rollback failed');

  // delete
  await db.order.delete({ where: { id: 'b' } });
  check('delete + count', (await db.order.count({})) === 3, String(await db.order.count({})));

  // cleanup
  await driver.query(`DROP TABLE IF EXISTS "${TABLE}"`, []);
  await db.$disconnect();
  console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} passed, ${fail} failed (postgres.js driver)`);
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
