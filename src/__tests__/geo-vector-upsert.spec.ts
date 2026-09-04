// Three bugs, all found by running the examples rather than reading them.
//
// Each had the same shape: a code path that handled geoPoint and vector
// correctly in one place and forgot them in another, so the feature worked
// until you used it the second way.

import { f, model } from '../schema/core';
import { compileSelect, compileUpdate } from '../adapters/postgres/compile-from-ir';

const Place = model('places', {
  id: f.id({ type: 'uuid' }),
  name: f.string().unique(),
  // fallback: true — stored as jsonb, no PostGIS.
  loc: f.geoPoint({ srid: 4326, fallback: true }),
});

const Native = model('places', {
  id: f.id({ type: 'uuid' }),
  name: f.string().unique(),
  loc: f.geoPoint({ srid: 4326 }),          // real geography column
});

const Doc = model('docs', {
  id: f.id({ type: 'uuid' }),
  text: f.string().unique(),
  embed: f.vector(3, { metric: 'cosine' }),
});

const here = { lng: 3.3515, lat: 6.6018 };

const selectNode = (model: string, field: string) =>
  ({
    model,
    kind: 'select',
    orderBy: [{ field, nearTo: here, direction: 'asc' }],
  }) as never;

const upsertNode = (create: Record<string, unknown>) =>
  ({
    model: 'x',
    kind: 'update',
    where: { kind: 'leaf', field: 'name', op: 'eq', value: 'n' },
    upsertCreate: create,
    many: false,
  }) as never;

describe('orderBy nearTo on a FALLBACK geoPoint', () => {
  // where.near already knew the column was jsonb and emitted a bbox
  // prefilter. orderBy did not, and asked Postgres for ST_GeogFromText
  // against jsonb: `function st_geogfromtext(unknown) does not exist`.
  const sql = () => compileSelect(selectNode('place', 'loc'), Place as never).sql;

  it('emits no PostGIS function', () => {
    expect(sql()).not.toMatch(/ST_GeogFromText/i);
    expect(sql()).not.toMatch(/ST_Distance/i);
  });

  it('selects no _distanceMeters column — the executor computes it', () => {
    expect(sql()).not.toMatch(/_distanceMeters/);
  });

  it('does not ORDER BY a column it never selected', () => {
    // Referencing the alias without emitting it is the other half of the
    // same bug, and fails just as hard.
    expect(sql()).not.toMatch(/ORDER BY/);
  });
});

describe('orderBy nearTo on a NATIVE geoPoint still uses PostGIS', () => {
  const sql = () => compileSelect(selectNode('native', 'loc'), Native as never).sql;

  it('emits the distance expression', () => {
    expect(sql()).toMatch(/ST_Distance|ST_GeogFromText/i);
    expect(sql()).toMatch(/_distanceMeters/);
  });

  it('and orders by it', () => {
    expect(sql()).toMatch(/ORDER BY "_distanceMeters"/);
  });
});

describe('upsert VALUES goes through the dialect value emitter', () => {
  // INSERT used valueExpr, the SET clause used valueExpr, upsert's VALUES
  // list used a bare placeholder — so an upsert carrying a vector sent the
  // raw JS array and Postgres answered "Vector contents must start with [".

  it('wraps a vector as ::vector', () => {
    const sql = compileUpdate(
      upsertNode({ name: 'n', embed: [0.1, 0.2, 0.3] }),
      Doc as never,
    ).sql;
    expect(sql).toMatch(/::vector/);
  });

  it('passes the bracketed text form, not a JS array', () => {
    const a = compileUpdate(upsertNode({ name: 'n', embed: [0.1, 0.2, 0.3] }), Doc as never);
    expect(a.params).toContain('[0.1,0.2,0.3]');
    expect(a.params.some((p) => Array.isArray(p))).toBe(false);
  });

  it('wraps a native geoPoint as ST_GeogFromText', () => {
    const sql = compileUpdate(
      upsertNode({ name: 'n', loc: here }),
      Native as never,
    ).sql;
    expect(sql).toMatch(/ST_GeogFromText/i);
  });

  it('leaves a FALLBACK geoPoint alone — it is jsonb', () => {
    const sql = compileUpdate(
      upsertNode({ name: 'n', loc: here }),
      Place as never,
    ).sql;
    expect(sql).not.toMatch(/ST_GeogFromText/i);
  });

  it('ordinary scalars are unaffected', () => {
    const a = compileUpdate(upsertNode({ name: 'n' }), Doc as never);
    expect(a.params).toContain('n');
  });
});
