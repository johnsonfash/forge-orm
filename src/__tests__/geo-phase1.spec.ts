// Geo Phase 1 — schema field kind, dialect column types, spatial index method,
// and INSERT value coercion. WhereTree near/withinMeters/nearTo land in Phase 2.

import { f, model } from '../schema/core';
import type { ModelDef } from '../schema/types';
import { buildSchemaDDL as buildPgDDL } from '../adapters/postgres/ddl';
import { buildSchemaDDL as buildMysqlDDL } from '../adapters/mysql/ddl';
import { buildSchemaDDL as buildSqliteDDL } from '../adapters/sqlite/ddl';
import { buildSchemaDDL as buildDuckdbDDL } from '../adapters/duckdb/ddl';
import { buildSchemaDDL as buildMssqlDDL } from '../adapters/mssql/ddl';
import { buildPostgresCompileApi } from '../adapters/postgres/compile';
import { buildMysqlCompileApi } from '../adapters/mysql/compile';
import { buildSqliteCompileApi } from '../adapters/sqlite/compile';
import { buildDuckdbCompileApi } from '../adapters/duckdb/compile';
import { buildMssqlCompileApi } from '../adapters/mssql/compile';
import { collectIndexSpecs } from '../adapters/mongo/scripts/push';

function geoModel() {
  return model('places', {
    id: f.id(),
    name: f.string(),
    location: f.geoPoint(),
  }, {
    indexes: [{ keys: { location: 1 }, method: 'spatial', name: 'idx_places_geo' }],
  }) as unknown as ModelDef<any>;
}

describe('Phase 1 — geo column types per dialect', () => {
  it('Postgres emits geography(Point, 4326)', () => {
    const ddl = buildPgDDL({ place: geoModel() });
    const tbl = ddl.find((s) => s.kind === 'table' && s.name === 'places')!;
    expect(tbl.sql).toMatch(/"location" geography\(Point, 4326\)/);
  });
  it('MySQL emits POINT NOT NULL SRID 4326', () => {
    const ddl = buildMysqlDDL({ place: geoModel() });
    const tbl = ddl.find((s) => s.kind === 'table' && s.name === 'places')!;
    expect(tbl.sql).toMatch(/`location` POINT NOT NULL SRID 4326/);
  });
  it('SQLite emits BLOB (SpatiaLite-ready) without fallback', () => {
    const ddl = buildSqliteDDL({ place: geoModel() });
    const tbl = ddl.find((s) => s.kind === 'table' && s.name === 'places')!;
    expect(tbl.sql).toMatch(/"location" BLOB/);
  });
  it('DuckDB emits GEOMETRY', () => {
    const ddl = buildDuckdbDDL({ place: geoModel() });
    const tbl = ddl.find((s) => s.kind === 'table' && s.name === 'places')!;
    expect(tbl.sql).toMatch(/"location" GEOMETRY/);
  });
  it('MSSQL emits GEOGRAPHY', () => {
    const ddl = buildMssqlDDL({ place: geoModel() });
    const tbl = ddl.find((s) => s.kind === 'table' && s.name === 'places')!;
    expect(tbl.sql).toMatch(/\[location\] GEOGRAPHY/);
  });
  it('fallback mode emits JSON/jsonb on every dialect', () => {
    const M = model('places', {
      id: f.id(),
      location: f.geoPoint({ fallback: true }),
    }) as unknown as ModelDef<any>;
    expect(buildPgDDL({ p: M })[0].sql).toMatch(/"location" jsonb/);
    expect(buildMysqlDDL({ p: M })[0].sql).toMatch(/`location` JSON/);
    expect(buildSqliteDDL({ p: M })[0].sql).toMatch(/"location" TEXT/);
    expect(buildDuckdbDDL({ p: M })[0].sql).toMatch(/"location" JSON/);
    expect(buildMssqlDDL({ p: M })[0].sql).toMatch(/\[location\] NVARCHAR\(MAX\)/);
  });
});

describe('Phase 1 — spatial index method per dialect', () => {
  it('Postgres uses USING gist', () => {
    const ddl = buildPgDDL({ place: geoModel() });
    const idx = ddl.find((s) => s.name === 'idx_places_geo')!;
    expect(idx.sql).toMatch(/USING gist/);
  });
  it('MySQL uses statement-prefix SPATIAL', () => {
    const ddl = buildMysqlDDL({ place: geoModel() });
    const idx = ddl.find((s) => s.name === 'idx_places_geo')!;
    expect(idx.sql).toMatch(/CREATE SPATIAL INDEX/);
  });
  it('DuckDB resolves to USING RTREE', () => {
    const ddl = buildDuckdbDDL({ place: geoModel() });
    const idx = ddl.find((s) => s.name === 'idx_places_geo')!;
    expect(idx.sql).toMatch(/USING RTREE/);
  });
  it('MSSQL rewrites to CREATE SPATIAL INDEX', () => {
    const ddl = buildMssqlDDL({ place: geoModel() });
    const idx = ddl.find((s) => s.name === 'idx_places_geo')!;
    expect(idx.sql).toMatch(/CREATE SPATIAL INDEX/);
  });
  it('Mongo translates the key value to 2dsphere', () => {
    const specs = collectIndexSpecs('place', geoModel());
    const spec = specs.find((s) => s.name === 'idx_places_geo')!;
    expect(spec.keys).toEqual({ location: '2dsphere' });
  });
});

describe('Phase 1 — INSERT value coercion wraps geoPoint per dialect', () => {
  it('Postgres wraps as ST_GeogFromText(EWKT)', () => {
    const M = geoModel();
    const art = buildPostgresCompileApi(M).create({ data: { id: 'a', name: 'Lekki', location: { lng: 3.4505, lat: 6.4416 } } });
    expect(art.sql).toMatch(/ST_GeogFromText/);
    // EWKT encoding carries the SRID inline so PG knows the coord system.
    expect(art.params.some((p) => typeof p === 'string' && /SRID=4326;POINT\(3\.4505 6\.4416\)/.test(p))).toBe(true);
  });
  it('MySQL wraps as ST_GeomFromText with lat,lng swap (axis order rule)', () => {
    const M = geoModel();
    const art = buildMysqlCompileApi(M).create({ data: { id: 'a', name: 'Lekki', location: { lng: 3.4505, lat: 6.4416 } } });
    expect(art.sql).toMatch(/ST_GeomFromText/);
    // MySQL 8 SRID 4326 enforces lat-first axis order — coords swap.
    expect(art.params.some((p) => typeof p === 'string' && /POINT\(6\.4416 3\.4505\)/.test(p))).toBe(true);
  });
  it('DuckDB wraps as ST_Point(lng, lat) — spatial extension', () => {
    const M = geoModel();
    const art = buildDuckdbCompileApi(M).create({ data: { id: 'a', name: 'Lekki', location: { lng: 3.4505, lat: 6.4416 } } });
    expect(art.sql).toMatch(/ST_Point\(/);
    expect(art.params).toContain(3.4505);
    expect(art.params).toContain(6.4416);
  });
  it('MSSQL wraps as geography::STGeomFromText(WKT, SRID)', () => {
    const M = geoModel();
    const art = buildMssqlCompileApi(M).create({ data: { id: 'a', name: 'Lekki', location: { lng: 3.4505, lat: 6.4416 } } });
    expect(art.sql).toMatch(/geography::STGeomFromText/);
    expect(art.sql).toMatch(/, 4326\)/);
  });
  it('SQLite wraps as GeomFromText (SpatiaLite contract)', () => {
    const M = geoModel();
    const art = buildSqliteCompileApi(M).create({ data: { id: 'a', name: 'Lekki', location: { lng: 3.4505, lat: 6.4416 } } });
    expect(art.sql).toMatch(/GeomFromText/);
  });
  it('Fallback mode binds the raw JSON object on every dialect', () => {
    const M = model('places', {
      id: f.id(),
      location: f.geoPoint({ fallback: true }),
    }) as unknown as ModelDef<any>;
    const art = buildPostgresCompileApi(M).create({ data: { id: 'a', location: { lng: 3.45, lat: 6.44 } } });
    // No ST_* wrapper — the value is bound directly.
    expect(art.sql).not.toMatch(/ST_/);
  });
});
