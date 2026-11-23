// Fallback-mode geoPoint (JSON {lng, lat} + bbox prefilter + Haversine in
// app), run on a real SQLite.
//
// Two faults: the bbox prefilter was Postgres syntax (`->>'lng')::float8`), so
// SQLite rejected it with "unrecognized token ':'"; and LIMIT went into the
// SQL, which has no distance order, so `take: 20` kept 20 arbitrary rows of
// the box and only then sorted them.

import { f, model } from '../schema/core';
import { openSqlite } from './_live-dbs';
import { haversineMeters } from '../adapters/shared/haversine';
import { buildSelect } from '../ir/build';
import { compileSelect as pgCompileSelect } from '../adapters/postgres/compile-from-ir';
import { compileSelect as mssqlCompileSelect } from '../adapters/mssql/compile-from-ir';

const Place = model('places', {
  id: f.id({ type: 'string' }),
  location: f.geoPoint({ fallback: true }),
});
const C = { lng: -1.5285, lat: 12.367 };

describe('fallback geo on SQLite', () => {
  let live: Awaited<ReturnType<typeof openSqlite>>;
  const pts = Array.from({ length: 200 }, (_, i) => ({
    id: `p${String(i).padStart(3, '0')}`,
    location: { lng: +(C.lng + (((i * 7919) % 2000) - 1000) / 10000).toFixed(6), lat: +(C.lat + (((i * 104729) % 2000) - 1000) / 10000).toFixed(6) },
  }));
  beforeAll(async () => {
    live = await openSqlite({ place: Place });
    await live.db.place.createMany({ data: pts });
  });
  afterAll(() => live.close());

  it('returns the nearest rows within the radius, nearest first, paged after the sort', async () => {
    const expected = pts
      .map((p) => ({ id: p.id, d: haversineMeters(p.location, C) }))
      .filter((p) => p.d <= 5000)
      .sort((a, b) => a.d - b.d);
    const rows = await live.db.place.findMany({
      where: { location: { near: { ...C, withinMeters: 5000 } } },
      orderBy: { location: { nearTo: C } }, take: 20,
    });
    expect(rows.map((r: any) => r.id)).toEqual(expected.slice(0, 20).map((p) => p.id));
    const page2 = await live.db.place.findMany({
      where: { location: { near: { ...C, withinMeters: 5000 } } },
      orderBy: { location: { nearTo: C } }, take: 5, skip: 20,
    });
    expect(page2.map((r: any) => r.id)).toEqual(expected.slice(20, 25).map((p) => p.id));
  });

  it('emits dialect-native JSON number reads and no LIMIT', () => {
    const node = buildSelect('place', Place as never, {
      where: { location: { near: { ...C, withinMeters: 100 } } }, take: 3,
    }, 'many');
    expect(live.db.place.compile.findMany({ where: { location: { near: { ...C, withinMeters: 100 } } }, take: 3 }).sql)
      .toMatch(/CAST\(json_extract\("places"\."location", '\$\.lng'\) AS REAL\)/);
    expect(pgCompileSelect(node, Place as never).sql).toMatch(/\("places"\."location"->>'lng'\)::float8/);
    expect(pgCompileSelect(node, Place as never).sql).not.toMatch(/LIMIT/);
    expect(mssqlCompileSelect(node, Place as never).sql).toMatch(/CAST\(JSON_VALUE\(\[places\]\.\[location\], '\$\.lng'\) AS FLOAT\)/);
  });
});
