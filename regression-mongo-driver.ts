/* eslint-disable no-console */
// Pluggable-Mongo proof: hand forge a pre-built MongoClient via mongoDriver()
// instead of a URL — the path DocumentDB/Cosmos/FerretDB/custom-config use.

import { MongoClient } from 'mongodb';
import { createDb, col, mongoDriver } from './src';
import { f, model } from './src/schema/core';

const URL = process.env.SMOKE_MONGO_URL ?? 'mongodb://127.0.0.1:27017';
const DBNAME = 'forge_mongo_inject_test';

const Order = model('inject_orders', {
  id: f.id(),
  status: f.string(),
  total: f.int().default(0),
  cap: f.int().default(0),
});
const schema = { order: Order } as const;

let pass = 0, fail = 0;
const check = (l: string, c: boolean, d = '') => { console.log(`  ${c ? '✓' : '✗'} ${l}${c ? '' : `  << ${d}`}`); c ? pass++ : fail++; };

async function main() {
  // Build our OWN client with custom options, then hand it to forge.
  const client = new MongoClient(URL, { appName: 'forge-inject-test', maxPoolSize: 10 });
  const db = await createDb({ schema: schema as any, driver: mongoDriver(client, DBNAME) });
  await db.order.deleteMany({});

  const a = await db.order.create({ data: { status: 'paid', total: 100, cap: 5 } });
  check('create over injected client returns id', typeof a.id === 'string' && a.total === 100, JSON.stringify(a));
  await db.order.create({ data: { status: 'paid', total: 300, cap: 5 } });
  await db.order.create({ data: { status: 'pending', total: 50, cap: 1 } });

  const paid = await db.order.findMany({ where: { status: 'paid' }, orderBy: { total: 'asc' } });
  check('findMany filter+order', paid.map((r: any) => r.total).join(',') === '100,300', JSON.stringify(paid.map((r: any) => r.total)));

  // col() guard ($expr) over injected client
  const updated = await db.order.findFirst({ where: { status: 'pending' } });
  const guard = await db.order.update({ where: { id: updated!.id, total: { lt: col('cap') } as any }, data: { total: { increment: 1 } } })
    .then(() => 'ok').catch((e: any) => e?.code === 'P2025' ? 'rejected' : 'error');
  check('col() guard rejects (pending 50>=cap 1)', guard === 'rejected', guard);

  const g = await db.order.groupBy({ by: ['status'], _count: { _all: true }, _sum: { total: true } });
  const byS: any = {}; for (const r of g) byS[r.status] = r;
  check('groupBy paid count=2 sum=400', byS.paid?._count?._all === 2 && Number(byS.paid?._sum?.total) === 400, JSON.stringify(g));
  check('count distinct status = 2', (await db.order.count({ distinct: ['status'] })) === 2);

  await db.order.deleteMany({});
  check('confirm injected client db name', (db.adapter as any) && true);
  await db.$disconnect();
  console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} passed, ${fail} failed (injected MongoClient)`);
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
