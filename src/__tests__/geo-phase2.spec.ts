// Geo Phase 2 — typed `where: { col: { near: { lng, lat, withinMeters } } }`
// and `orderBy: { col: { nearTo: { lng, lat } } }` compile per dialect.

import { f, model } from '../schema/core';
import type { ModelDef } from '../schema/types';
import { buildPostgresCompileApi } from '../adapters/postgres/compile';
import { buildMysqlCompileApi } from '../adapters/mysql/compile';
import { buildSqliteCompileApi } from '../adapters/sqlite/compile';
import { buildDuckdbCompileApi } from '../adapters/duckdb/compile';
import { buildMssqlCompileApi } from '../adapters/mssql/compile';

function geoModel() {
  return model('places', {
    id: f.id(),
    name: f.string(),
    location: f.geoPoint(),
  }) as unknown as ModelDef<any>;
}

const POINT = { lng: 3.4505, lat: 6.4416 };

describe("Phase 2 — where { near } per dialect", () => {
  it('Postgres compiles to ST_DWithin', () => {
    const art = buildPostgresCompileApi(geoModel()).findMany({
      where: { location: { near: { ...POINT, withinMeters: 5000 } } },
    });
    expect(art.sql).toMatch(/ST_DWithin\(/);
    expect(art.params.some((p) => typeof p === 'string' && /POINT\(3\.4505 6\.4416\)/.test(p))).toBe(true);
    expect(art.params).toContain(5000);
  });

  it('MySQL compiles to ST_Distance_Sphere with lat-first swap', () => {
    const art = buildMysqlCompileApi(geoModel()).findMany({
      where: { location: { near: { ...POINT, withinMeters: 5000 } } },
    });
    expect(art.sql).toMatch(/ST_Distance_Sphere\(/);
    // SRID 4326 axis order: lat-first.
    expect(art.params.some((p) => typeof p === 'string' && /POINT\(6\.4416 3\.4505\)/.test(p))).toBe(true);
  });

  it('SQLite (SpatiaLite) compiles to Distance(..., MakePoint(lng,lat,4326), 1)', () => {
    const art = buildSqliteCompileApi(geoModel()).findMany({
      where: { location: { near: { ...POINT, withinMeters: 5000 } } },
    });
    expect(art.sql).toMatch(/Distance\(/);
    expect(art.sql).toMatch(/MakePoint/);
    expect(art.params).toContain(3.4505);
    expect(art.params).toContain(6.4416);
  });

  it('DuckDB compiles to ST_Distance_Sphere(..., ST_Point(lng,lat))', () => {
    const art = buildDuckdbCompileApi(geoModel()).findMany({
      where: { location: { near: { ...POINT, withinMeters: 5000 } } },
    });
    expect(art.sql).toMatch(/ST_Distance_Sphere\(/);
    expect(art.sql).toMatch(/ST_Point\(/);
  });

  it('MSSQL compiles to col.STDistance(geography::STGeomFromText(...))', () => {
    const art = buildMssqlCompileApi(geoModel()).findMany({
      where: { location: { near: { ...POINT, withinMeters: 5000 } } },
    });
    expect(art.sql).toMatch(/\.STDistance\(/);
    expect(art.sql).toMatch(/geography::STGeomFromText/);
  });

  it('rejects non-geoPoint fields with near operator', () => {
    const M = model('places', { id: f.id(), name: f.string() }) as unknown as ModelDef<any>;
    expect(() => buildPostgresCompileApi(M).findMany({
      where: { name: { near: { lng: 1, lat: 2, withinMeters: 100 } } },
    })).toThrow(/requires a geoPoint or vector field/);
  });

  it('rejects non-numeric lng/lat at IR build', () => {
    expect(() => buildPostgresCompileApi(geoModel()).findMany({
      where: { location: { near: { lng: 'x' as any, lat: 2, withinMeters: 100 } } },
    })).toThrow(/requires numeric/);
  });
});

describe("Phase 2 — orderBy { nearTo } with _distanceMeters synthetic field", () => {
  it('Postgres adds ST_Distance AS _distanceMeters + ORDER BY _distanceMeters', () => {
    const art = buildPostgresCompileApi(geoModel()).findMany({
      orderBy: { location: { nearTo: POINT } },
    });
    expect(art.sql).toMatch(/ST_Distance\(/);
    expect(art.sql).toMatch(/AS _distanceMeters/);
    expect(art.sql).toMatch(/ORDER BY "_distanceMeters" ASC/);
  });

  it('MySQL emits ST_Distance_Sphere AS _distanceMeters', () => {
    const art = buildMysqlCompileApi(geoModel()).findMany({
      orderBy: { location: { nearTo: POINT } },
    });
    expect(art.sql).toMatch(/ST_Distance_Sphere\(/);
    expect(art.sql).toMatch(/AS _distanceMeters/);
  });

  it('DuckDB emits ST_Distance_Sphere AS _distanceMeters', () => {
    const art = buildDuckdbCompileApi(geoModel()).findMany({
      orderBy: { location: { nearTo: POINT } },
    });
    expect(art.sql).toMatch(/ST_Distance_Sphere\(/);
    expect(art.sql).toMatch(/AS _distanceMeters/);
  });

  it('SQLite emits Distance AS _distanceMeters', () => {
    const art = buildSqliteCompileApi(geoModel()).findMany({
      orderBy: { location: { nearTo: POINT } },
    });
    expect(art.sql).toMatch(/Distance\(.+\) AS _distanceMeters/);
  });

  it('MSSQL emits .STDistance AS _distanceMeters', () => {
    const art = buildMssqlCompileApi(geoModel()).findMany({
      orderBy: { location: { nearTo: POINT } },
    });
    expect(art.sql).toMatch(/\.STDistance\(/);
    expect(art.sql).toMatch(/AS _distanceMeters/);
  });

  it('combines near filter + nearTo ordering naturally', () => {
    const art = buildPostgresCompileApi(geoModel()).findMany({
      where: { location: { near: { ...POINT, withinMeters: 5000 } } },
      orderBy: { location: { nearTo: POINT } },
      take: 20,
    });
    // The synthetic column lands AT $1/$2 (rendered before WHERE for natural
    // param ordering); WHERE clause params follow.
    expect(art.sql).toMatch(/SELECT.*ST_Distance.*AS _distanceMeters.*FROM.*WHERE.*ST_DWithin/s);
    expect(art.sql).toMatch(/ORDER BY "_distanceMeters" ASC/);
    expect(art.sql).toMatch(/LIMIT 20/);
  });

  it('descending nearTo (farthest first)', () => {
    const art = buildPostgresCompileApi(geoModel()).findMany({
      orderBy: { location: { nearTo: POINT, direction: 'desc' } as any },
    });
    expect(art.sql).toMatch(/ORDER BY "_distanceMeters" DESC/);
  });
});

describe('Phase 2 — fallback mode uses bbox prefilter (Haversine post-runs in app)', () => {
  it("Postgres emits jsonb path lng/lat extraction with BETWEEN", () => {
    const M = model('places', {
      id: f.id(),
      location: f.geoPoint({ fallback: true }),
    }) as unknown as ModelDef<any>;
    const art = buildPostgresCompileApi(M).findMany({
      where: { location: { near: { ...POINT, withinMeters: 5000 } } },
    });
    // No ST_DWithin in fallback — bbox prefilter via jsonb path.
    expect(art.sql).not.toMatch(/ST_DWithin/);
    expect(art.sql).toMatch(/->>'lng'.*BETWEEN/s);
    expect(art.sql).toMatch(/->>'lat'.*BETWEEN/s);
  });
});
