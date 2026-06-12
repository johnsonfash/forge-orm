/* eslint-disable no-console */
// Execution probe: groupBy + distinct on real SQLite AND real Mongo.
// Asserts exact aggregate values so a wrong reshape / null-bucket / dialect
// quirk shows up immediately.

import { createDb } from './src';
import { f, model } from './src/schema/core';
import { setActiveSchema } from './src/schema/active';
import { buildSchemaDDL } from './src/adapters/sqlite/ddl';
import { applyMigration } from './src/adapters/sqlite/migrate';

const Order = model('probe_orders', {
  id: f.id(),
  status: f.string(),
  channel: f.string(),
  total: f.int().default(0),
});
const schema = { order: Order } as const;

// status, channel, total
const ROWS: Array<[string, string, number]> = [
  ['paid', 'web', 100],
  ['paid', 'web', 300],
  ['paid', 'app', 200],
  ['pending', 'web', 50],
  ['pending', 'app', 70],
  ['cancelled', 'app', 0],
];

let pass = 0, fail = 0;
const check = (l: string, c: boolean, d = '') => { console.log(`  ${c ? '✓' : '✗'} ${l}${c ? '' : `  << ${d}`}`); c ? pass++ : fail++; };
const j = (x: any) => JSON.stringify(x);

async function scenarios(label: string, db: any) {
  console.log(`\n=== ${label} ===`);
  for (const [status, channel, total] of ROWS) {
    await db.order.create({ data: { id: `${status}_${channel}_${total}`, status, channel, total } });
  }

  // ── groupBy status: count + sum + avg + min + max ──
  const g = await db.order.groupBy({
    by: ['status'],
    _count: { _all: true },
    _sum: { total: true },
    _avg: { total: true },
    _min: { total: true },
    _max: { total: true },
    orderBy: { status: 'asc' },
  });
  const byStatus: Record<string, any> = {};
  for (const r of g) byStatus[r.status] = r;

  check('groupBy returns 3 status groups', g.length === 3, j(g.map((r: any) => r.status)));
  check('paid count = 3', byStatus.paid?._count?._all === 3, j(byStatus.paid));
  check('paid sum total = 600', Number(byStatus.paid?._sum?.total) === 600, j(byStatus.paid?._sum));
  check('paid avg total = 200', Number(byStatus.paid?._avg?.total) === 200, j(byStatus.paid?._avg));
  check('paid min total = 100', Number(byStatus.paid?._min?.total) === 100, j(byStatus.paid?._min));
  check('paid max total = 300', Number(byStatus.paid?._max?.total) === 300, j(byStatus.paid?._max));
  check('pending count = 2 / sum = 120', byStatus.pending?._count?._all === 2 && Number(byStatus.pending?._sum?.total) === 120, j(byStatus.pending));
  check('cancelled count = 1 / sum = 0', byStatus.cancelled?._count?._all === 1 && Number(byStatus.cancelled?._sum?.total) === 0, j(byStatus.cancelled));
  check('orderBy status asc → cancelled,paid,pending', g.map((r: any) => r.status).join(',') === 'cancelled,paid,pending', j(g.map((r: any) => r.status)));

  // ── groupBy two columns ──
  const g2 = await db.order.groupBy({ by: ['status', 'channel'], _count: { _all: true }, _sum: { total: true } });
  const pw = g2.find((r: any) => r.status === 'paid' && r.channel === 'web');
  const pa = g2.find((r: any) => r.status === 'paid' && r.channel === 'app');
  check('groupBy [status,channel]: paid/web count=2 sum=400', pw?._count?._all === 2 && Number(pw?._sum?.total) === 400, j(pw));
  check('groupBy [status,channel]: paid/app count=1 sum=200', pa?._count?._all === 1 && Number(pa?._sum?.total) === 200, j(pa));

  // ── having (field-first, Prisma shape): sum(total) >= 120 ──
  const gh = await db.order.groupBy({ by: ['status'], _sum: { total: true }, having: { total: { _sum: { gte: 120 } } } });
  check('having (field-first) sum>=120 → paid,pending', gh.map((r: any) => r.status).sort().join(',') === 'paid,pending', j(gh.map((r: any) => r.status)));

  // ── having (bucket-first shape): same result ──
  const gh2 = await db.order.groupBy({ by: ['status'], _sum: { total: true }, having: { _sum: { total: { gte: 120 } } } });
  check('having (bucket-first) sum>=120 → paid,pending', gh2.map((r: any) => r.status).sort().join(',') === 'paid,pending', j(gh2.map((r: any) => r.status)));

  // ── where before grouping ──
  const gw = await db.order.groupBy({ by: ['status'], where: { channel: 'web' }, _count: { _all: true } });
  const webByStatus: Record<string, number> = {};
  for (const r of gw) webByStatus[r.status] = r._count._all;
  check('where channel=web: paid=2 pending=1, no cancelled', webByStatus.paid === 2 && webByStatus.pending === 1 && webByStatus.cancelled === undefined, j(webByStatus));

  // ── distinct findMany on a single column ──
  const ds = await db.order.findMany({ distinct: ['status'], orderBy: { status: 'asc' } });
  check('distinct status → 3 rows', ds.length === 3, j(ds.map((r: any) => r.status)));

  // ── count distinct ──
  const cd = await db.order.count({ distinct: ['channel'] });
  check('count distinct channel = 2', cd === 2, j(cd));
}

async function main() {
  setActiveSchema(schema as any);

  const sq = await createDb({ url: 'sqlite::memory:', schema: schema as any });
  const rep = await applyMigration((sq.adapter as any).db, buildSchemaDDL(schema as any));
  if (rep.failures.length) throw new Error('sqlite DDL: ' + j(rep.failures));
  await scenarios('SQLite', sq);
  await sq.$disconnect?.();

  const url = process.env.SMOKE_MONGO_URL ?? 'mongodb://127.0.0.1:27017/forge_probe_gb';
  const mo = await createDb({ url, schema: schema as any });
  await mo.order.deleteMany({});
  await scenarios('MongoDB', mo);
  await mo.order.deleteMany({});
  await mo.$disconnect?.();

  console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
