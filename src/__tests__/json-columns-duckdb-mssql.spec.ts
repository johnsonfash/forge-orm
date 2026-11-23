// f.json() on DuckDB and SQL Server.
//
// DuckDB: json_extract returns a JSON value, and comparing it with a VARCHAR
// parameter makes DuckDB parse the parameter as JSON, so a path filter like
// `{ prefs: { path: 'theme', eq: 'dark' } }` failed with "Malformed JSON ...
// Input: "dark"". Both dialects also handed f.json() back as the stored text
// instead of the object that was written.

import { f, model } from '../schema/core';
import { openDuckdb } from './_live-dbs';
import { executeMssqlSelect } from '../adapters/mssql/execute';
import { compileSelect as duckCompileSelect } from '../adapters/duckdb/compile-from-ir';
import { buildSelect } from '../ir/build';

const Doc = model('docs', {
  id: f.id({ type: 'string' }),
  prefs: f.json<{ theme: string; score: number; on: boolean; tags: string[] }>().optional(),
  tags: f.stringArray().optional(),
});
const schema = { doc: Doc };

describe('DuckDB JSON path filters and decode', () => {
  let live: Awaited<ReturnType<typeof openDuckdb>>;
  beforeAll(async () => {
    live = await openDuckdb(schema);
    await live.db.doc.createMany({ data: [
      { id: 'a', prefs: { theme: 'dark', score: 30, on: true, tags: ['x'] } },
      { id: 'b', prefs: { theme: 'dark', score: 10, on: false, tags: [] } },
      { id: 'c', prefs: { theme: 'light', score: 50, on: true, tags: ['x', 'y'] } },
      { id: 'd', prefs: null },
    ] });
  });
  afterAll(() => live.close());

  const ids = (rows: any[]) => rows.map((r) => r.id).sort();

  it('compares a string path against a string', async () => {
    const rows = await live.db.doc.findMany({ where: { prefs: { path: 'theme', eq: 'dark' } } });
    expect(ids(rows)).toEqual(['a', 'b']);
  });

  it('compares a numeric path numerically', async () => {
    const rows = await live.db.doc.findMany({ where: { AND: [
      { prefs: { path: 'theme', eq: 'dark' } }, { prefs: { path: 'score', gte: 20 } },
    ] } });
    expect(ids(rows)).toEqual(['a']);
    expect(await live.db.doc.count({ where: { prefs: { path: 'score', gt: 9 } } })).toBe(3);
  });

  it('handles booleans, in, and has', async () => {
    expect(ids(await live.db.doc.findMany({ where: { prefs: { path: 'on', eq: true } } }))).toEqual(['a', 'c']);
    expect(ids(await live.db.doc.findMany({ where: { prefs: { path: 'theme', in: ['light', 'blue'] } } }))).toEqual(['c']);
    expect(ids(await live.db.doc.findMany({ where: { prefs: { path: 'tags', has: 'y' } } }))).toEqual(['c']);
  });

  it('reads f.json() back as an object, on reads and on writes', async () => {
    const a = await live.db.doc.findUnique({ where: { id: 'a' } });
    expect(a.prefs).toEqual({ theme: 'dark', score: 30, on: true, tags: ['x'] });
    const made = await live.db.doc.create({ data: { id: 'e', prefs: { theme: 'x', score: 1, on: false, tags: [] } } });
    expect(made.prefs).toEqual({ theme: 'x', score: 1, on: false, tags: [] });
    const upd = await live.db.doc.update({ where: { id: 'e' }, data: { prefs: { theme: 'y', score: 2, on: true, tags: [] } } });
    expect(upd.prefs.theme).toBe('y');
    expect((await live.db.doc.findUnique({ where: { id: 'd' } })).prefs ?? null).toBeNull();
  });

  it('extracts with the operand\'s type', () => {
    const sql = duckCompileSelect(buildSelect('doc', Doc as never, { where: { AND: [
      { prefs: { path: 'theme', eq: 'dark' } }, { prefs: { path: 'score', gte: 1 } },
    ] } }, 'many'), Doc as never).sql;
    expect(sql).toMatch(/json_extract_string\("docs"\."prefs", \$\d\) = \$\d/);
    expect(sql).toMatch(/TRY_CAST\(json_extract\("docs"\."prefs", \$\d\) AS DOUBLE\) >= \$\d/);
  });
});

describe('SQL Server decodes JSON text columns', () => {
  it('parses f.json() and array columns stored as NVARCHAR(MAX)', async () => {
    const driver = {
      query: async () => ({ rows: [{ id: 'a', prefs: '{"theme":"dark","score":3}', tags: '["x","y"]' }], rowCount: 1 }),
    };
    const rows = await executeMssqlSelect(driver as never, buildSelect('doc', Doc as never, {}, 'many'), Doc as never);
    expect(rows[0].prefs).toEqual({ theme: 'dark', score: 3 });
    expect(rows[0].tags).toEqual(['x', 'y']);
  });
});
