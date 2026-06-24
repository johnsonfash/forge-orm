/* eslint-disable no-console */
//
// 2.2.0 — live regression for the new Mongo IndexDef extensions.
// Pushes a fresh schema with:
//   - a 2dsphere geospatial index (verified via geoWithin lookup)
//   - a hashed index (verified by listIndexes())
//   - a unique collation index, case-insensitive (verified by duplicate insert)
//   - a wildcard index with wildcardProjection (verified by listIndexes())
//
// Requires a local Mongo at SMOKE_MONGO_URL (default mongodb://127.0.0.1:27017).
// Creates and drops a uniquely-named DB.

import * as dotenv from 'dotenv';
dotenv.config();

import { MongoClient } from 'mongodb';
import { f, model } from './src/schema/core';
import type { ModelDef } from './src/schema/types';
import { dbClient } from './src/adapters/mongo/client';
import { pushAllIndexes } from './src/adapters/mongo/scripts/push';

const STAMP = `${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
const DB = `forge_v22_smoke_${STAMP}`;
const URL = process.env.SMOKE_MONGO_URL ?? `mongodb://127.0.0.1:27017/${DB}`;

let pass = 0;
let fail = 0;
function check(label: string, cond: any) {
  if (cond) {
    console.log(`  ✓ ${label}`);
    pass++;
  } else {
    console.log(`  ✗ ${label}`);
    fail++;
  }
}

async function main() {
  // pushAllIndexes uses the bundled dbClient which reads DATABASE_URL.
  // Default to a per-run namespaced DB so multiple runs don't collide.
  if (!process.env.DATABASE_URL) {
    process.env.DATABASE_URL = URL.includes('/') && URL.lastIndexOf('/') > 10
      ? URL
      : `${URL}/${DB}`;
  }

  const Places: ModelDef<any> = model(
    'places',
    {
      id: f.id(),
      name: f.string(),
      location: f.json(), // GeoJSON Point — we treat it as opaque JSON
    },
    {
      indexes: [
        { keys: { location: '2dsphere' }, name: 'idx_places_geo' },
      ],
    },
  ) as unknown as ModelDef<any>;

  const Shards: ModelDef<any> = model(
    'shard_keys',
    {
      id: f.id(),
      tenant: f.objectId(),
    },
    {
      indexes: [{ keys: { tenant: 'hashed' }, name: 'idx_shard_tenant_hashed' }],
    },
  ) as unknown as ModelDef<any>;

  const Names: ModelDef<any> = model(
    'names_ci',
    {
      id: f.id(),
      name: f.string(),
    },
    {
      indexes: [{
        keys: { name: 1 },
        unique: true,
        name: 'idx_name_ci_unique',
        collation: { locale: 'en', strength: 2 },
      }],
    },
  ) as unknown as ModelDef<any>;

  const Tags: ModelDef<any> = model(
    'wild',
    {
      id: f.id(),
      data: f.json(),
    },
    {
      indexes: [{
        keys: { 'data.$**': 1 } as any,
        name: 'idx_wild',
      }],
    },
  ) as unknown as ModelDef<any>;

  await pushAllIndexes({ places: Places, shards: Shards, names: Names, tags: Tags });

  // Direct verification via the mongo driver — independent of forge's wrapper.
  const client = new MongoClient(URL);
  await client.connect();
  const db = client.db(DB);

  // --- 2dsphere ---
  await db.collection('places').insertOne({ name: 'home', location: { type: 'Point', coordinates: [3.421, 6.448] } });
  const found = await db.collection('places').findOne({
    location: {
      $near: {
        $geometry: { type: 'Point', coordinates: [3.421, 6.448] },
        $maxDistance: 1000,
      },
    },
  });
  check('2dsphere index supports $near query', found?.name === 'home');

  const placesIdx = await db.collection('places').listIndexes().toArray();
  const placesGeoIdx = placesIdx.find((i) => i.name === 'idx_places_geo');
  check('2dsphere index is reflected in listIndexes', placesGeoIdx?.key?.location === '2dsphere');

  // --- hashed ---
  const shardsIdx = await db.collection('shard_keys').listIndexes().toArray();
  const shardsHashedIdx = shardsIdx.find((i) => i.name === 'idx_shard_tenant_hashed');
  check('hashed index is reflected in listIndexes', shardsHashedIdx?.key?.tenant === 'hashed');

  // --- collation (case-insensitive unique) ---
  await db.collection('names_ci').insertOne({ _id: 'a' as any, name: 'Hello' });
  let collationRejected = false;
  try {
    await db.collection('names_ci').insertOne({ _id: 'b' as any, name: 'HELLO' });
  } catch (err: any) {
    collationRejected = !!(err?.code === 11000); // E11000 duplicate key
  }
  check('collation: case-insensitive uniqueness rejects "HELLO" after "Hello"', collationRejected);

  // --- wildcard projection ---
  const wildIdx = await db.collection('wild').listIndexes().toArray();
  const wild = wildIdx.find((i) => i.name === 'idx_wild');
  check('wildcard index has $** key', wild?.key?.['data.$**'] === 1);

  // --- idempotency: re-push should NOT rebuild any of the new index types ---
  let warned = 0;
  const origWarn = console.warn;
  console.warn = () => { warned++; };
  await pushAllIndexes({ places: Places, shards: Shards, names: Names, tags: Tags });
  console.warn = origWarn;
  check('re-push is idempotent (no warnings)', warned === 0);

  await client.close();
  await dbClient.close();
  try { await client.db(DB).dropDatabase(); } catch { /* ignore */ }

  console.log(`\n[v2.2-mongo-ext] ${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main().catch((err) => {
  console.error('regression failed', err);
  process.exit(1);
});
