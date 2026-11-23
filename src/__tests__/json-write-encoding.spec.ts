import { f, model } from '../schema/core';
import type { ModelDef } from '../schema/types';
import { MysqlAdapter } from '../adapters/mysql/adapter';
import { MssqlAdapter } from '../adapters/mssql/adapter';
import { SqliteAdapter } from '../adapters/sqlite/adapter';
import { DuckdbAdapter } from '../adapters/duckdb/adapter';
import { mysql2Driver, mariadbDriver } from '../adapters/mysql/driver';
import { mssqlDriver } from '../adapters/mssql/driver';
import { duckdbDriver } from '../adapters/duckdb/driver';

// 2.23.1 fixed a JSON value stored as a JSON *string* on postgres.js, which
// runs its own JSON.stringify on json/jsonb parameters. Checked here for the
// other drivers: forge serialises once, and none of these drivers encodes a
// string parameter again — mysql2, mariadb, tedious and DuckDB bind it as
// text and the server parses it (MySQL JSON) or stores it (TEXT/NVARCHAR).

const Doc: ModelDef<any> = model('docs', { id: f.id(), meta: f.json() });
const value = { a: 1, tags: ['x'] };
const once = JSON.stringify(value);

describe('JSON writes are encoded exactly once', () => {
  it.each([
    ['mysql', new MysqlAdapter()],
    ['mssql', new MssqlAdapter()],
    ['sqlite', new SqliteAdapter()],
    ['duckdb', new DuckdbAdapter()],
  ])('%s coerceInbound turns the object into its JSON text once', (_k, adapter: any) => {
    expect(adapter.coerceInbound(Doc, { meta: value }).meta).toBe(once);
  });

  it('mysql2 and mariadb pass the text through unchanged', async () => {
    const seen: unknown[][] = [];
    // mysql2 gets one options object ({ sql, values, supportBigNumbers }); mariadb gets (sql, params).
    const params = (a: unknown, p?: unknown[]) => (p ?? (a as { values: unknown[] }).values);
    const pool = { query: async (a: unknown, p?: unknown[]) => { seen.push(params(a, p)); return [[], []]; }, execute: async (a: unknown, p?: unknown[]) => { seen.push(params(a, p)); return [{}, []]; } };
    await mysql2Driver(pool).execute('INSERT INTO docs (meta) VALUES (?)', [once]);
    await mariadbDriver(pool).execute('INSERT INTO docs (meta) VALUES (?)', [once]);
    expect(seen).toEqual([[once], [once]]);
  });

  it('mssql binds the text as given', async () => {
    const inputs: unknown[] = [];
    const pool = { request: () => ({ input: (_n: string, v: unknown) => inputs.push(v), query: async () => ({ recordset: [], rowsAffected: [1] }) }) };
    await mssqlDriver(pool).query('INSERT INTO docs (meta) VALUES (@p1)', [once]);
    expect(inputs).toEqual([once]);
  });

  it('duckdb passes a string parameter through (it only stringifies objects)', async () => {
    const got: unknown[][] = [];
    const conn = { run: async (_s: string, p: unknown[]) => { got.push(p); return { getRowObjects: async () => [] }; } };
    await duckdbDriver(conn).query('INSERT INTO docs VALUES ($1)', [once]);
    expect(got).toEqual([[once]]);
  });
});
