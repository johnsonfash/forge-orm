/* eslint-disable no-console */
// Pluggable-MySQL proof: run forge over the mariadb connector via mariadbDriver()
// — mysql2 is never loaded. Creates + drops a throwaway database.

import * as mariadb from 'mariadb';
import { createDb, col, mariadbDriver } from './src';
import { f, model } from './src/schema/core';
import { buildSchemaDDL } from './src/adapters/mysql/ddl';

const HOST = process.env.SMOKE_MYSQL_HOST ?? '127.0.0.1';
const PORT = Number(process.env.SMOKE_MYSQL_PORT ?? '3306');
const USER = process.env.SMOKE_MYSQL_USER ?? 'root';
const PASS = process.env.SMOKE_MYSQL_PASS ?? '';
const DB = 'forge_mariadb_test';

const Order = model('orders', {
  id: f.id(), status: f.string(), total: f.int().default(0), cap: f.int().default(0),
});
const schema = { order: Order } as const;

let pass = 0, fail = 0;
const check = (l: string, c: boolean, d = '') => { console.log(`  ${c ? '✓' : '✗'} ${l}${c ? '' : `  << ${d}`}`); c ? pass++ : fail++; };

async function main() {
  // bootstrap the database with a root pool (no db selected)
  const root = mariadb.createPool({ host: HOST, port: PORT, user: USER, password: PASS, allowPublicKeyRetrieval: true, connectionLimit: 2 });
  await root.query(`DROP DATABASE IF EXISTS \`${DB}\``);
  await root.query(`CREATE DATABASE \`${DB}\``);
  await root.end();

  const pool = mariadb.createPool({ host: HOST, port: PORT, user: USER, password: PASS, database: DB, allowPublicKeyRetrieval: true, bigIntAsNumber: true, insertIdAsNumber: true, decimalAsNumber: true, connectionLimit: 5 });
  const db = await createDb({ schema: schema as any, driver: mariadbDriver(pool) });
  const driver = (db.adapter as any).driver;

  for (const stmt of buildSchemaDDL(schema as any)) await driver.query(stmt.sql, []);
  check('DDL applied via mariadb driver', true);

  await db.order.create({ data: { id: 'a', status: 'paid', total: 100, cap: 5 } });
  await db.order.create({ data: { id: 'b', status: 'paid', total: 300, cap: 5 } });
  await db.order.create({ data: { id: 'c', status: 'pending', total: 50, cap: 1 } });
  const a = await db.order.findUnique({ where: { id: 'a' } });
  check('create + findUnique (no RETURNING → follow-up SELECT)', a?.total === 100, JSON.stringify(a));

  const paid = await db.order.findMany({ where: { status: 'paid' }, orderBy: { total: 'asc' } });
  check('findMany filter+order', paid.map((r: any) => r.id).join(',') === 'a,b', JSON.stringify(paid.map((r: any) => r.id)));

  const guard = await db.order.update({ where: { id: 'a', total: { lt: col('cap') } as any }, data: { total: { increment: 1 } } })
    .then((r: any) => r ? 'ok' : 'rejected').catch((e: any) => e?.code === 'P2025' ? 'rejected' : 'error');
  check('col() guard rejects (100>=cap 5)', guard === 'rejected', guard);

  const g = await db.order.groupBy({ by: ['status'], _count: { _all: true }, _sum: { total: true } });
  const byS: any = {}; for (const r of g) byS[r.status] = r;
  check('groupBy paid count=2 sum=400', byS.paid?._count?._all === 2 && Number(byS.paid?._sum?.total) === 400, JSON.stringify(g));
  check('count distinct status = 2', (await db.order.count({ distinct: ['status'] })) === 2);

  await db.$transaction(async (tx: any) => { await tx.order.create({ data: { id: 'tx1', status: 'x', total: 1, cap: 9 } }); });
  check('transaction commit', !!(await db.order.findUnique({ where: { id: 'tx1' } })));

  await db.order.delete({ where: { id: 'b' } });
  check('delete + count', (await db.order.count({})) === 3, String(await db.order.count({})));

  await db.$disconnect();
  const cleanup = mariadb.createPool({ host: HOST, port: PORT, user: USER, password: PASS, allowPublicKeyRetrieval: true, connectionLimit: 1 });
  await cleanup.query(`DROP DATABASE IF EXISTS \`${DB}\``); await cleanup.end();

  console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} passed, ${fail} failed (mariadb driver)`);
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
