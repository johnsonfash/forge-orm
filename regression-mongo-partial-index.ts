/**
 * Regression: MongoDB partial indexes (partialFilterExpression on IndexDef).
 * Verifies forge push creates the partial index, is idempotent on re-run, and
 * that Mongo enforces uniqueness only over the documents matched by the filter.
 *
 *   SMOKE_MONGO_URL=mongodb://127.0.0.1:27017 ts-node --transpile-only regression-mongo-partial-index.ts
 */
import { MongoClient } from 'mongodb';
import { createDb, mongoDriver } from './src';
import { f, model } from './src/schema/core';
import { pushAllIndexes } from './src/adapters/mongo/scripts/push';

const URL = process.env.SMOKE_MONGO_URL ?? 'mongodb://127.0.0.1:27017';
const DBNAME = `forge_partial_${Math.abs((Date.now() ^ (process.pid << 8)) | 0).toString(36)}`;

let pass = 0, fail = 0;
const A = (c: boolean, m: string) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m); } };

async function main() {
  const client = new MongoClient(URL);
  await client.connect();

  // A unique index on `txn` that only covers documents where txn is a string.
  const Payment = model('payments', {
    id: f.id(),
    txn: f.string().optional(),
    amount: f.int(),
  }, {
    indexes: [{
      keys: { txn: 1 },
      unique: true,
      name: 'idx_pay_txn',
      partialFilterExpression: { txn: { $type: 'string' } },
    }],
  });
  const schema = { payments: Payment } as const;

  const db = await createDb({ schema: schema as any, driver: mongoDriver(client, DBNAME) });
  const coll = client.db(DBNAME).collection('payments');

  // 1. push creates the partial index with the filter expression
  await pushAllIndexes(schema);
  let idx = await coll.listIndexes().toArray();
  let pfe = idx.find((i: any) => i.name === 'idx_pay_txn');
  A(!!pfe, 'partial index idx_pay_txn created');
  A(!!pfe && pfe.unique === true, 'partial index is unique');
  A(!!pfe && JSON.stringify(pfe.partialFilterExpression) === JSON.stringify({ txn: { $type: 'string' } }),
    'partialFilterExpression persisted');

  // 2. idempotent — a second push must not throw and must keep the filter
  await pushAllIndexes(schema);
  idx = await coll.listIndexes().toArray();
  A(idx.filter((i: any) => i.name === 'idx_pay_txn').length === 1, 're-push keeps a single partial index (idempotent)');

  // 3. uniqueness enforced only over matched docs (txn is a string)
  await (db as any).payments.create({ data: { txn: 'abc', amount: 1 } });
  let dupRejected = false;
  try { await (db as any).payments.create({ data: { txn: 'abc', amount: 2 } }); }
  catch { dupRejected = true; }
  A(dupRejected, 'duplicate string txn rejected by the partial unique index');

  // 4. docs NOT matched by the filter (txn absent) are exempt — many allowed
  await (db as any).payments.create({ data: { amount: 3 } });
  await (db as any).payments.create({ data: { amount: 4 } });
  const exempt = await client.db(DBNAME).collection('payments').countDocuments({ txn: { $exists: false } });
  A(exempt === 2, 'rows outside the partial filter are exempt from the unique constraint');

  await client.db(DBNAME).dropDatabase();
  await client.close();

  console.log(`\n[partial-index] ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(2); });
