// Geo bridge tests — withinPolygon op across dialects, Mongo nearTo auto-
// routing to $geoNear aggregate, and the polygon refinement in fallback mode.

import { f, model } from '../schema/core';
import type { ModelDef } from '../schema/types';
import { buildPostgresCompileApi } from '../adapters/postgres/compile';
import { buildMysqlCompileApi } from '../adapters/mysql/compile';
import { buildSqliteCompileApi } from '../adapters/sqlite/compile';
import { buildDuckdbCompileApi } from '../adapters/duckdb/compile';
import { buildMssqlCompileApi } from '../adapters/mssql/compile';
import { pointInPolygon } from '../adapters/shared/haversine';

function geoModel() {
  return model('places', {
    id: f.id(),
    name: f.string(),
    location: f.geoPoint(),
  }) as unknown as ModelDef<any>;
}

// A small triangle around Lagos.
const TRIANGLE = [
  { lng: 3.30, lat: 6.40 },
  { lng: 3.55, lat: 6.40 },
  { lng: 3.42, lat: 6.55 },
];

describe("Phase 3 — withinPolygon per dialect", () => {
  it('Postgres compiles to ST_Within with geometry cast', () => {
    const art = buildPostgresCompileApi(geoModel()).findMany({
      where: { location: { withinPolygon: TRIANGLE } },
    });
    expect(art.sql).toMatch(/ST_Within\(/);
    expect(art.params.some((p) => typeof p === 'string' && /POLYGON\(\(3\.3 6\.4/.test(p))).toBe(true);
  });

  it('MySQL compiles to ST_Within with lat-first axis order', () => {
    const art = buildMysqlCompileApi(geoModel()).findMany({
      where: { location: { withinPolygon: TRIANGLE } },
    });
    expect(art.sql).toMatch(/ST_Within\(/);
    // MySQL SRID 4326 wants lat-first.
    expect(art.params.some((p) => typeof p === 'string' && /POLYGON\(\(6\.4 3\.3/.test(p))).toBe(true);
  });

  it('SQLite (SpatiaLite) compiles to Within(...) + GeomFromText', () => {
    const art = buildSqliteCompileApi(geoModel()).findMany({
      where: { location: { withinPolygon: TRIANGLE } },
    });
    expect(art.sql).toMatch(/Within\(.+GeomFromText/);
  });

  it('DuckDB compiles to ST_Within(..., ST_GeomFromText(...))', () => {
    const art = buildDuckdbCompileApi(geoModel()).findMany({
      where: { location: { withinPolygon: TRIANGLE } },
    });
    expect(art.sql).toMatch(/ST_Within\(/);
    expect(art.sql).toMatch(/ST_GeomFromText\(/);
  });

  it('MSSQL compiles to polygon.STContains(loc) = 1', () => {
    const art = buildMssqlCompileApi(geoModel()).findMany({
      where: { location: { withinPolygon: TRIANGLE } },
    });
    expect(art.sql).toMatch(/geography::STGeomFromText/);
    expect(art.sql).toMatch(/\.STContains\(/);
    expect(art.sql).toMatch(/= 1/);
  });

  it('auto-closes the ring at IR build time (no manual repetition needed)', () => {
    const art = buildPostgresCompileApi(geoModel()).findMany({
      where: { location: { withinPolygon: TRIANGLE } }, // 3 vertices, not closed
    });
    // The WKT should include 4 lng/lat pairs (3 + the auto-closing vertex).
    const wkt = art.params.find((p) => typeof p === 'string' && p.includes('POLYGON'));
    expect(wkt).toBeDefined();
    const pairs = (wkt as string).match(/\d+\.\d+ \d+\.\d+/g);
    expect(pairs?.length).toBe(4);
  });

  it('rejects polygons with fewer than 3 vertices', () => {
    expect(() => buildPostgresCompileApi(geoModel()).findMany({
      where: { location: { withinPolygon: [{ lng: 0, lat: 0 }, { lng: 1, lat: 1 }] } },
    })).toThrow(/at least 3 vertices/);
  });

  it('rejects non-numeric vertices', () => {
    expect(() => buildPostgresCompileApi(geoModel()).findMany({
      where: { location: { withinPolygon: [{ lng: 0, lat: 0 }, { lng: 1, lat: 1 }, { lng: 'x' as any, lat: 1 }] } },
    })).toThrow(/numeric/);
  });
});

describe('Phase 3 — fallback mode polygon refinement', () => {
  it('emits axis-aligned bbox prefilter from polygon envelope', () => {
    const M = model('places', {
      id: f.id(),
      location: f.geoPoint({ fallback: true }),
    }) as unknown as ModelDef<any>;
    const art = buildPostgresCompileApi(M).findMany({
      where: { location: { withinPolygon: TRIANGLE } },
    });
    expect(art.sql).not.toMatch(/ST_Within/);
    expect(art.sql).toMatch(/->>'lng'.*BETWEEN/s);
    expect(art.sql).toMatch(/->>'lat'.*BETWEEN/s);
    // Envelope: lng ∈ [3.30, 3.55], lat ∈ [6.40, 6.55].
    expect(art.params).toContain(3.30);
    expect(art.params).toContain(3.55);
    expect(art.params).toContain(6.40);
    expect(art.params).toContain(6.55);
  });
});

describe('pointInPolygon ray-casting', () => {
  // Closed square (0,0)–(2,2).
  const SQUARE = [
    { lng: 0, lat: 0 }, { lng: 2, lat: 0 }, { lng: 2, lat: 2 },
    { lng: 0, lat: 2 }, { lng: 0, lat: 0 },
  ];

  it('detects points inside', () => {
    expect(pointInPolygon({ lng: 1, lat: 1 }, SQUARE)).toBe(true);
    expect(pointInPolygon({ lng: 0.5, lat: 1.9 }, SQUARE)).toBe(true);
  });
  it('detects points outside', () => {
    expect(pointInPolygon({ lng: 3, lat: 1 }, SQUARE)).toBe(false);
    expect(pointInPolygon({ lng: -1, lat: 1 }, SQUARE)).toBe(false);
    expect(pointInPolygon({ lng: 1, lat: -1 }, SQUARE)).toBe(false);
  });

  it('handles concave polygons via ray-casting (no convex assumption)', () => {
    // L-shape: bottom row [0,3]x[0,1] + left column [0,1]x[0,3].
    const L = [
      { lng: 0, lat: 0 }, { lng: 3, lat: 0 }, { lng: 3, lat: 1 },
      { lng: 1, lat: 1 }, { lng: 1, lat: 3 }, { lng: 0, lat: 3 },
      { lng: 0, lat: 0 },
    ];
    expect(pointInPolygon({ lng: 0.5, lat: 2.5 }, L)).toBe(true);  // left arm
    expect(pointInPolygon({ lng: 2.5, lat: 0.5 }, L)).toBe(true);  // bottom arm
    expect(pointInPolygon({ lng: 2.5, lat: 2.5 }, L)).toBe(false); // notch
  });
});
