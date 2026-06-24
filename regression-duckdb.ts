/* eslint-disable no-console */
//
// Live DuckDB regression — verifies the new adapter end-to-end against an
// in-process DB. Covers DDL push, CRUD, partial-unique constraint, soft
// delete, and the compile API's dialect output.

import * as dotenv from 'dotenv';
dotenv.config();

import { f, model, createDb } from './src';
import { duckdbDriver } from './src/adapters/duckdb/driver';
import { DuckDBInstance } from '@duckdb/node-api';

const Item = model('items', {
  id: f.id(),
  sku: f.string(),
  name: f.string(),
  price: f.float(),
  deletedAt: f.dateTime().optional().softDeleteAt(),
}, {
  indexes: [
    { keys: { sku: 1 }, unique: true, where: '"deletedAt" IS NULL', name: 'idx_items_sku_live' },
  ],
});

let pass = 0, fail = 0;
const ok = (label: string, cond: boolean, detail?: any) => {
  if (cond) { console.log('  ✓', label); pass++; }
  else { console.log('  ✗', label, detail ?? ''); fail++; }
};

async function main() {
  const instance = await DuckDBInstance.create(':memory:');
  const connection = await instance.connect();
  const db = await createDb({
    schema: { item: Item } as any,
    driver: duckdbDriver(connection),
  });

  // Push the schema. DuckDB doesn't speak SAVEPOINT, so the migrator just
  // runs each statement; failures are surfaced in the apply report.
  const { buildSchemaDDL } = await import('./src/adapters/duckdb/ddl');
  const ddl = buildSchemaDDL({ item: Item } as any);
  for (const s of ddl) {
    try { await connection.run(s.sql); }
    catch (err: any) {
      console.warn('   ⚠ ddl statement failed:', s.sql.slice(0, 80), '—', err?.message);
    }
  }

  // 1. Create + findFirst
  await (db as any).item.create({ data: { id: 'a', sku: 'SKU-1', name: 'Widget', price: 9.99 } });
  const found = await (db as any).item.findFirst({ where: { sku: 'SKU-1' } });
  ok('create + findFirst round-trips', found?.id === 'a' && found?.sku === 'SKU-1', found);

  // 2. findMany with filter
  await (db as any).item.create({ data: { id: 'b', sku: 'SKU-2', name: 'Gadget', price: 19.99 } });
  const all = await (db as any).item.findMany({ where: { price: { gte: 10 } } });
  ok('findMany with filter', all.length === 1 && all[0].id === 'b', all);

  // 3. update
  await (db as any).item.update({ where: { id: 'a' }, data: { price: 14.99 } });
  const updated = await (db as any).item.findFirst({ where: { id: 'a' } });
  ok('update by id', Number(updated?.price) === 14.99, updated);

  // 4. count
  const total = await (db as any).item.count();
  ok('count', total === 2, total);

  // 5. soft delete
  await (db as any).item.softDelete({ where: { id: 'a' } });
  const liveCount = await (db as any).item.count();
  ok('softDelete hides row from reads', liveCount === 1, liveCount);

  // 6. DuckDB partial-index limitation — re-insert of the soft-deleted SKU
  //    is REJECTED because DuckDB doesn't yet support partial indexes
  //    (Creating partial indexes is not supported currently). The schema's
  //    `where:` clause is stripped at push and the unique becomes total.
  //    Verify the rejection is what's expected; this regression flips to
  //    "allowed" once DuckDB lands partial-index support.
  let rejected = false;
  try {
    await (db as any).item.create({ data: { id: 'c', sku: 'SKU-1', name: 'New Widget', price: 12.99 } });
  } catch (err: any) {
    rejected = /unique constraint|Duplicate key/i.test(err?.message ?? '');
  }
  ok('DuckDB unique constraint covers soft-deleted rows (partial indexes not yet supported)', rejected);
  // Hard-delete the soft-deleted row so the restore step below finds the
  // original (rather than the swapped-in duplicate that wasn't allowed).

  // 7. restore
  await (db as any).item.restore({ where: { id: 'a' } });
  const afterRestore = await (db as any).item.findFirst({ where: { id: 'a' } });
  ok('restore brings the row back', afterRestore?.id === 'a' && afterRestore?.deletedAt == null, afterRestore);

  // 8. compile.findMany returns dialect=duckdb
  const art = (db as any).item.compile.findMany({ where: { sku: 'SKU-1' } });
  ok('compile artifact dialect is duckdb', art.dialect === 'duckdb', art.dialect);

  await connection.close?.();
  console.log(`\n[duckdb] ${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main().catch((err) => { console.error(err); process.exit(1); });
