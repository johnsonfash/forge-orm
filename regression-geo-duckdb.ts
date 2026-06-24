/* eslint-disable no-console */
//
// Live geo regression on DuckDB — the only dialect whose spatial extension is
// bundled (auto-loaded at connect). Covers schema push, geoPoint insert,
// near filter, nearTo orderBy with _distanceMeters, and confirms the
// roundtrip distance matches Haversine within 1%.

import * as dotenv from 'dotenv';
dotenv.config();

import { f, model, createDb } from './src';
import { duckdbDriver } from './src/adapters/duckdb/driver';
import { haversineMeters } from './src/adapters/shared/haversine';
import { DuckDBInstance } from '@duckdb/node-api';

const Place = model('places', {
  id: f.id(),
  name: f.string(),
  location: f.geoPoint(),
}, {
  indexes: [{ keys: { location: 1 }, method: 'spatial', name: 'idx_places_geo' }],
});

const CENTER = { lng: 3.4505, lat: 6.4416 }; // Lekki Phase 1, Lagos
const NEARBY = { lng: 3.4520, lat: 6.4400 }; // ~0.25 km
const FAR    = { lng: 7.3986, lat: 9.0765 }; // Abuja, ~530 km

let pass = 0, fail = 0;
const ok = (label: string, cond: boolean, detail?: any) => {
  if (cond) { console.log('  ✓', label); pass++; }
  else { console.log('  ✗', label, detail ?? ''); fail++; }
};

async function main() {
  const instance = await DuckDBInstance.create(':memory:');
  const connection = await instance.connect();
  const db = await createDb({
    schema: { place: Place } as any,
    driver: duckdbDriver(connection),
  });

  // Confirm spatial is loaded (the adapter auto-loads at connect).
  const ext = await connection.run("SELECT extension_name FROM duckdb_extensions() WHERE extension_name = 'spatial' AND loaded");
  const extRows = await ext.getRowObjects();
  ok('spatial extension auto-loaded at connect', extRows.length === 1);

  // Push the schema.
  const { buildSchemaDDL } = await import('./src/adapters/duckdb/ddl');
  const ddl = buildSchemaDDL({ place: Place } as any);
  for (const s of ddl) {
    try { await connection.run(s.sql); }
    catch (err: any) {
      console.warn('   ⚠ ddl statement failed:', s.sql.slice(0, 80), '—', err?.message);
    }
  }

  // Insert three rows with known coordinates.
  await (db as any).place.create({ data: { id: 'a', name: 'Center', location: CENTER } });
  await (db as any).place.create({ data: { id: 'b', name: 'Nearby', location: NEARBY } });
  await (db as any).place.create({ data: { id: 'c', name: 'Far',    location: FAR    } });
  ok('inserts three geoPoint rows', true);

  // near filter — within 1 km should include a + b but not c.
  const within1k = await (db as any).place.findMany({
    where: { location: { near: { ...CENTER, withinMeters: 1000 } } },
  });
  const within1kIds = within1k.map((r: any) => r.id).sort();
  ok('near within 1 km returns Center + Nearby', within1kIds.join(',') === 'a,b', within1kIds);

  // near within 1000 km should include all three.
  const within1mk = await (db as any).place.findMany({
    where: { location: { near: { ...CENTER, withinMeters: 1_000_000 } } },
  });
  ok('near within 1000 km returns all three', within1mk.length === 3);

  // orderBy nearTo — closest first, with _distanceMeters annotated.
  const sorted = await (db as any).place.findMany({
    orderBy: { location: { nearTo: CENTER } },
  });
  ok('nearTo sorts closest-first',
    sorted[0].id === 'a' && sorted[1].id === 'b' && sorted[2].id === 'c',
    sorted.map((r: any) => r.id),
  );

  // _distanceMeters should match Haversine within 1%.
  const expected = haversineMeters(CENTER, NEARBY);
  const actual = Number(sorted[1]._distanceMeters);
  const diff = Math.abs(actual - expected) / expected;
  ok(`_distanceMeters matches Haversine for Nearby (${actual.toFixed(0)}m vs ${expected.toFixed(0)}m)`,
    diff < 0.01,
    { actual, expected, diff });

  // Combined near + nearTo + limit.
  const combined = await (db as any).place.findMany({
    where: { location: { near: { ...CENTER, withinMeters: 10_000 } } },
    orderBy: { location: { nearTo: CENTER } },
    take: 5,
  });
  ok('combined near + nearTo + take works', combined.length === 2 && combined[0].id === 'a');

  // Polygon containment — a triangle around the Lagos area should contain
  // a + b (both close to CENTER) but not c (Abuja).
  const TRIANGLE = [
    { lng: 3.20, lat: 6.35 },
    { lng: 3.60, lat: 6.35 },
    { lng: 3.40, lat: 6.55 },
  ];
  const inside = await (db as any).place.findMany({
    where: { location: { withinPolygon: TRIANGLE } },
  });
  const insideIds = inside.map((r: any) => r.id).sort();
  ok('withinPolygon includes the two Lagos points, excludes Abuja',
    insideIds.join(',') === 'a,b', insideIds);

  await connection.close?.();
  console.log(`\n[geo-duckdb] ${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main().catch((err) => { console.error(err); process.exit(1); });
