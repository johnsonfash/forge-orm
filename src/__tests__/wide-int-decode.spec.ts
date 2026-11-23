import { f, model } from '../schema/core';
import type { ModelDef } from '../schema/types';
import { buildSelect } from '../ir/build';
import { decodeWideIntegers } from '../adapters/shared/wide-int';
import { executePgSelect, executePgInsert } from '../adapters/postgres/execute';
import { executeMssqlSelect } from '../adapters/mssql/execute';
import { executeDuckdbSelect } from '../adapters/duckdb/execute';
import { decodeRow as mysqlDecode } from '../adapters/mysql/execute';
import { decodeRow as sqliteDecode } from '../adapters/sqlite/execute';

// forge types a bigserial id as `number` and f.bigint() as `bigint`. What the
// drivers hand back for a 64-bit column, measured per driver:
//   pg, postgres.js, tedious (mssql)   string          "42"
//   mariadb connector, @duckdb/node-api  bigint          42n
//   mysql2, better-sqlite3             number          42

const Ledger: ModelDef<any> = model('ledger', {
  id: f.id({ type: 'bigserial' }),
  amount: f.bigint(),
  note: f.string(),
});

describe('decodeWideIntegers', () => {
  it.each([
    ['a string (pg, postgres.js, tedious)', '42', '9007199254740993'],
    ['a bigint (mariadb, duckdb)', 42n, 9007199254740993n],
    ['a number (mysql2, better-sqlite3)', 42, 12],
  ])('%s → id number, amount bigint', (_label, id, amount) => {
    const row = decodeWideIntegers(Ledger, { id, amount, note: 'x' });
    expect(row.id).toBe(42);
    expect(typeof row.amount).toBe('bigint');
    expect(row.amount).toBe(BigInt(amount as any));
    expect(row.note).toBe('x');
  });

  it('refuses a bigserial id past MAX_SAFE_INTEGER rather than rounding it', () => {
    expect(() => decodeWideIntegers(Ledger, { id: '9007199254740993' })).toThrow(/past Number.MAX_SAFE_INTEGER[\s\S]*f.bigint\(\)/);
    expect(() => decodeWideIntegers(Ledger, { id: 9007199254740993n })).toThrow(/rounded to a different id/);
  });

  it('refuses a bigint the driver already rounded to an unsafe number', () => {
    expect(() => decodeWideIntegers(Ledger, { amount: 2 ** 60 })).toThrow(/already rounded/);
  });

  it('leaves nulls, absent fields and models without wide columns alone', () => {
    const plain = { a: 1 };
    const M: ModelDef<any> = model('m', { id: f.id(), n: f.int() });
    expect(decodeWideIntegers(M, plain)).toBe(plain);
    expect(decodeWideIntegers(Ledger, { id: null, note: 'n' })).toEqual({ id: null, note: 'n' });
  });
});

describe('each executor returns what the types promise', () => {
  const node = () => buildSelect('ledger', Ledger, {}, 'many');

  it('postgres (string from node-postgres), select and insert RETURNING', async () => {
    const pool = { query: async () => ({ rows: [{ id: '7', amount: '9007199254740993', note: 'a' }], rowCount: 1 }) };
    const [row] = await executePgSelect(pool, node(), Ledger);
    expect(row).toEqual({ id: 7, amount: 9007199254740993n, note: 'a' });
    const ins = await executePgInsert(pool, { kind: 'insert', model: 'ledger', rows: [{ note: 'a' }] } as any, Ledger);
    expect(ins.docs[0].id).toBe(7);
  });

  it('mssql (string from tedious)', async () => {
    const q = { query: async () => ({ rows: [{ id: '7', amount: '5', note: 'a' }] }) };
    const [row] = await executeMssqlSelect(q as any, node(), Ledger);
    expect(row).toEqual({ id: 7, amount: 5n, note: 'a' });
  });

  it('duckdb (bigint from @duckdb/node-api)', async () => {
    const q = { query: async () => ({ rows: [{ id: 7n, amount: 5n, note: 'a' }] }) };
    const [row] = await executeDuckdbSelect(q as any, node(), Ledger);
    expect(row).toEqual({ id: 7, amount: 5n, note: 'a' });
  });

  it('mysql (number from mysql2, bigint from mariadb)', () => {
    expect(mysqlDecode(Ledger, { id: 7, amount: 5, note: 'a' })).toEqual({ id: 7, amount: 5n, note: 'a' });
    expect(mysqlDecode(Ledger, { id: 7n, amount: 5n, note: 'a' })).toEqual({ id: 7, amount: 5n, note: 'a' });
  });

  it('sqlite (number from better-sqlite3, bigint with safeIntegers)', () => {
    expect(sqliteDecode(Ledger, { id: 7, amount: 5, note: 'a' })).toEqual({ id: 7, amount: 5n, note: 'a' });
    expect(sqliteDecode(Ledger, { id: 7n, amount: 5n, note: 'a' })).toEqual({ id: 7, amount: 5n, note: 'a' });
  });
});
