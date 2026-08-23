/* eslint-disable no-console */
// Where/update operator safety — live proof of the v2.7.0 fixes:
//   1. Unknown where operators throw instead of matching every row.
//   2. Strict mode recurses into AND/OR/NOT and relation filters.
//   3. Dotted container paths work (and validate) in both modes.
//   4. Upsert seeds the create value when update increments the same field.
//   5. aggregate() accepts both arg shapes; garbage throws.
//   6. Update-data operator objects are validated on scalar columns.
//   7. not: { filter } negates instead of comparing against the object.

import { createDb } from './src';

const DB = `forge_opsafety_${Date.now()}`;
const URL = process.env.SMOKE_MONGO_URL ?? `mongodb://127.0.0.1:27017/${DB}`;

let pass = 0, fail = 0;
const check = (l: string, c: boolean, d = '') => { console.log(`  ${c ? '✓' : '✗'} ${l}${c ? '' : `  << ${d}`}`); c ? pass++ : fail++; };
const throws = async (l: string, fn: () => Promise<any>, re: RegExp) => {
  try { await fn(); check(l, false, 'did not throw'); }
  catch (e: any) { check(l, re.test(String(e.message)), e.message.split('\n')[0]); }
};

async function main() {
  const db: any = await createDb({ url: URL });
  const sdb: any = await createDb({ url: URL, strict: true });
  const mongo = (await import('./src/adapters/mongo/client')).dbClient;

  const alice = await db.user.create({ data: { email: 'op@x.co', name: 'Op',
    address: { street: '1 main', city: 'sf', zip: '94110', country: 'us' } } });
  for (let i = 1; i <= 4; i++) {
    await db.post.create({ data: { author_id: alice.id, title: `post ${i}`, slug: `op${i}`,
      body: 'text', view_count: i * 10, revisions: [] } });
  }

  console.log('[1] unknown where operators');
  check('bare gte filters', (await db.post.count({ where: { view_count: { gte: 30 } } })) === 2);
  await throws('$gte throws with correction', () => db.post.count({ where: { view_count: { $gte: 30 } } }), /Did you mean 'gte'/);
  await throws('typo suggests closest', () => db.post.count({ where: { title: { contians: 'x' } } }), /Did you mean 'contains'/);

  console.log('[2] strict recursion');
  await throws('AND-nested unknown key', () => sdb.post.count({ where: { AND: [{ bogus: 1 }] } }), /unknown where key 'bogus'/);
  await throws('relation-nested unknown key', () => sdb.post.count({ where: { author: { is: { bogus: 1 } } } }), /unknown where key 'bogus' on 'users'/);

  console.log('[3] dotted container paths');
  check('loose dotted embed', (await db.user.count({ where: { 'address.city': 'sf' } })) === 1);
  check('strict dotted embed', (await sdb.user.count({ where: { 'address.city': 'sf' } })) === 1);
  await throws('strict rejects unknown embed field', () => sdb.user.count({ where: { 'address.bogus': 'x' } }), /unknown embed field 'bogus'/);
  check('dotted json + op', (await db.post.count({ where: { 'meta.level': { gte: 1 } } })) === 0);

  console.log('[4] upsert create/update overlap');
  const seed = { author_id: alice.id, title: 'ctr', slug: 'opctr', body: '', view_count: 100, revisions: [] };
  const u1 = await db.post.upsert({ where: { slug: 'opctr' }, create: seed, update: { view_count: { increment: 1 } } });
  const u2 = await db.post.upsert({ where: { slug: 'opctr' }, create: seed, update: { view_count: { increment: 1 } } });
  check('insert applies create (100, not 1)', u1.view_count === 100, String(u1.view_count));
  check('update applies increment (101)', u2.view_count === 101, String(u2.view_count));

  console.log('[5] aggregate arg shapes');
  const a1 = await db.post.aggregate({ pipeline: [{ $group: { _id: null, n: { $sum: 1 } } }] });
  const a2 = await db.post.aggregate([{ $group: { _id: null, n: { $sum: 1 } } }]);
  check('object form groups', a1.length === 1 && a1[0].n === 5, JSON.stringify(a1));
  check('bare-array form groups (was a silent full scan)', a2.length === 1 && a2[0].n === 5, JSON.stringify(a2));
  await throws('pipeline-less call throws', () => db.post.aggregate({}), /needs a pipeline/);

  console.log('[6] update-data validation');
  const p = await db.post.findFirst({ where: { slug: 'op1' } });
  await throws('typoed op no longer corrupts the column', () => db.post.update({ where: { id: p.id }, data: { view_count: { incrment: 5 } } }), /not a valid operator form/);
  await throws('increment on a string column', () => db.post.update({ where: { id: p.id }, data: { title: { increment: 1 } } }), /only valid on numeric/);
  const inc = await db.post.update({ where: { id: p.id }, data: { view_count: { increment: 5 } } });
  check('real increment untouched', inc.view_count === 15, String(inc.view_count));

  console.log('[7] nested not-filter');
  const notC = await db.post.count({ where: { title: { not: { contains: 'post 1' } } } });
  check('not:{contains} excludes matches', notC === (await db.post.count({})) - 1, String(notC));
  check('not: null idiom intact', (await db.post.count({ where: { published_at: { not: null } } })) === 0);

  await mongo.db.dropDatabase();
  await db.$disconnect();
  console.log(`\n[forge:op-safety] ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
