/* eslint-disable no-console */
// Live vector regression — DuckDB's vss extension. Verifies push, vector
// insert, top-K similarity, and `_distance` annotation end-to-end through
// the typed forge-orm API.

import * as dotenv from 'dotenv';
dotenv.config();

import { f, model, createDb } from './src';
import { duckdbDriver } from './src/adapters/duckdb/driver';
import { DuckDBInstance } from '@duckdb/node-api';

const Doc = model('docs', {
  id: f.id(),
  body: f.string(),
  embedding: f.vector(4, { metric: 'cosine' }),
}, {
  indexes: [{ keys: { embedding: 1 }, method: 'vector', name: 'idx_docs_emb' }],
});

let pass = 0, fail = 0;
const ok = (label: string, cond: boolean, detail?: any) => {
  if (cond) { console.log('  ✓', label); pass++; }
  else { console.log('  ✗', label, detail ?? ''); fail++; }
};

async function main() {
  const instance = await DuckDBInstance.create(':memory:');
  const connection = await instance.connect();

  await connection.run('INSTALL vss');
  await connection.run('LOAD vss');
  ok('vss extension loaded', true);

  const db = await createDb({
    schema: { doc: Doc } as any,
    driver: duckdbDriver(connection),
  });

  const { buildSchemaDDL } = await import('./src/adapters/duckdb/ddl');
  const ddl = buildSchemaDDL({ doc: Doc } as any);
  for (const s of ddl) {
    try { await connection.run(s.sql); }
    catch (err: any) {
      console.warn('   ⚠ ddl failed:', s.sql.slice(0, 80), '—', err?.message);
    }
  }

  await (db as any).doc.create({ data: { id: 'a', body: 'cat',  embedding: [1, 0, 0, 0] } });
  await (db as any).doc.create({ data: { id: 'b', body: 'kitten', embedding: [0.9, 0.1, 0, 0] } });
  await (db as any).doc.create({ data: { id: 'c', body: 'car',  embedding: [0, 0, 0, 1] } });
  ok('inserts three vector rows', true);

  const queryCat = [1, 0, 0, 0];
  const sorted = await (db as any).doc.findMany({
    orderBy: { embedding: { nearTo: queryCat } },
  });
  ok('nearTo sorts by cosine distance closest first',
    sorted[0].id === 'a' && sorted[1].id === 'b' && sorted[2].id === 'c',
    sorted.map((r: any) => r.id));

  ok('_distance is annotated on each row',
    sorted[0]._distance != null && sorted[1]._distance != null && sorted[2]._distance != null);
  ok('_distance ordering matches nearTo ordering',
    Number(sorted[0]._distance) <= Number(sorted[1]._distance)
    && Number(sorted[1]._distance) <= Number(sorted[2]._distance),
    sorted.map((r: any) => Number(r._distance).toFixed(4)));

  const close = await (db as any).doc.findMany({
    where: { embedding: { near: { vector: queryCat, withinDistance: 0.5 } } },
  });
  const closeIds = close.map((r: any) => r.id).sort();
  ok('near withinDistance=0.5 keeps cat + kitten, drops car',
    closeIds.join(',') === 'a,b', closeIds);

  const top1 = await (db as any).doc.findMany({
    where:   { embedding: { near: { vector: queryCat, withinDistance: 0.9 } } },
    orderBy: { embedding: { nearTo: queryCat } },
    take: 1,
  });
  ok('combined near + nearTo + take=1 returns the closest',
    top1.length === 1 && top1[0].id === 'a', top1.map((r: any) => r.id));

  await connection.close?.();
  console.log(`\n[vector-duckdb] ${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main().catch((err) => { console.error(err); process.exit(1); });
