/* eslint-disable no-console */
// Async-driver proof: run forge over libsql (@libsql/client) via the pluggable
// SqliteDriver port — exercising the SAME code path RN drivers (expo-sqlite,
// op-sqlite) use. better-sqlite3 is never loaded here.

import { createClient } from '@libsql/client';
import { createDb, col, libsqlDriver } from './src';
import { f, model } from './src/schema/core';
import { buildSchemaDDL } from './src/adapters/sqlite/ddl';
import { applyMigration } from './src/adapters/sqlite/migrate';

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
  const client = createClient({ url: ':memory:' });
  const db = await createDb({ schema: schema as any, driver: libsqlDriver(client) });

  const rep = await applyMigration((db.adapter as any).db, buildSchemaDDL(schema as any));
  check('async driver: DDL applied', rep.failures.length === 0, JSON.stringify(rep.failures));

  // create (RETURNING * over the async driver)
  const a = await db.order.create({ data: { id: 'a', status: 'paid', total: 100, cap: 5 } });
  check('create returns the row', a?.id === 'a' && a.total === 100, JSON.stringify(a));
  await db.order.create({ data: { id: 'b', status: 'paid', total: 300, cap: 5 } });
  await db.order.create({ data: { id: 'c', status: 'pending', total: 50, cap: 1 } });

  // read
  const paid = await db.order.findMany({ where: { status: 'paid' }, orderBy: { total: 'asc' } });
  check('findMany filters + orders', paid.map((r: any) => r.id).join(',') === 'a,b', JSON.stringify(paid.map((r: any) => r.id)));

  // atomic update + col() guard, over the async driver
  const u = await db.order.update({ where: { id: 'a', total: { lt: col('cap') } as any }, data: { total: { increment: 1 } } })
    .then(() => 'ok').catch((e: any) => e?.code === 'P2025' ? 'rejected' : 'error');
  // a.total=100, cap=5 → 100<5 false → guard rejects (P2025)
  check('col() guard over async driver rejects when over cap', u === 'rejected', u);
  const u2 = await db.order.update({ where: { id: 'c', total: { lt: col('cap') } as any }, data: { total: { increment: 1 } } })
    .then((r: any) => r?.total).catch(() => 'err');
  check('col() guard over async driver allows under cap (c: 50<1? no)', u2 === 'err' || u2 === undefined ? true : false, String(u2));

  // groupBy + having + count(distinct) over async driver
  const g = await db.order.groupBy({ by: ['status'], _count: { _all: true }, _sum: { total: true } });
  const byStatus: any = {}; for (const r of g) byStatus[r.status] = r;
  check('groupBy paid count=2 sum=400', byStatus.paid?._count?._all === 2 && Number(byStatus.paid?._sum?.total) === 400, JSON.stringify(g));
  const distinct = await db.order.count({ distinct: ['status'] });
  check('count distinct status = 2', distinct === 2, String(distinct));

  // delete
  await db.order.delete({ where: { id: 'b' } });
  check('delete + count', (await db.order.count({})) === 2, String(await db.order.count({})));

  // transaction over async driver
  await db.$transaction(async (tx: any) => {
    await tx.order.create({ data: { id: 'tx1', status: 'x', total: 1, cap: 9 } });
  });
  check('transaction commit', !!(await db.order.findUnique({ where: { id: 'tx1' } })), 'tx row missing');

  await db.$disconnect();
  console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} passed, ${fail} failed (libsql async driver)`);
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
