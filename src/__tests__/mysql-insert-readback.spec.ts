// MySQL 8 has no RETURNING, so every insert used to be INSERT + SELECT. When
// every column's value is already known (written by forge, a literal default,
// the insert id) the row is handed back without the SELECT. createMany, which
// returns only a count, never reads back. MariaDB 10.5+ takes RETURNING.

import { f, model } from '../schema/core';
import { executeMysqlDelete, executeMysqlInsert } from '../adapters/mysql/execute';
import { mariadbReturning } from '../adapters/mysql/adapter';
import { buildDelete, buildInsert } from '../ir/build';

const User = model('users', {
  id: f.id({ type: 'string' }),
  email: f.string(),
  active: f.bool(),
  score: f.float(),
  prefs: f.json<{ a: number }>(),
  role: f.string().default('USER'),
  bio: f.text().optional(),
  joined: f.dateTime(),
});
const Stamped = model('stamped', { id: f.id({ type: 'string' }), at: f.dateTime().default('now') });
const Serial = model('serials', { id: f.id({ type: 'bigserial' }), name: f.string() });

function fakePool(result: any, selectRows: any[] = []) {
  const calls: string[] = [];
  const pool = {
    calls,
    execute: async (sql: string) => { calls.push(sql); return [result, undefined]; },
    query: async (sql: string) => { calls.push(sql); return [selectRows, undefined]; },
  };
  return pool as any;
}

const row = { id: 'u1', email: 'a@b', active: 1, score: 1.5, prefs: '{"a":1}', joined: new Date(Date.UTC(2025, 0, 1)) };

describe('MySQL insert read-back', () => {
  it('returns a fully known row without a SELECT', async () => {
    const pool = fakePool({ affectedRows: 1, insertId: 0 });
    const { docs, count } = await executeMysqlInsert(pool, buildInsert('user', User as never, { rows: [row] }), User as never);
    expect(pool.calls).toHaveLength(1);
    expect(count).toBe(1);
    expect(docs[0]).toEqual({ ...row, active: true, prefs: { a: 1 }, role: 'USER', bio: null });
  });

  it('reads back when a column has a database-side default', async () => {
    const pool = fakePool({ affectedRows: 1 }, [{ id: 's1', at: new Date() }]);
    await executeMysqlInsert(pool, buildInsert('stamped', Stamped as never, { rows: [{ id: 's1' }] }), Stamped as never);
    expect(pool.calls).toHaveLength(2);
    expect(pool.calls[1]).toMatch(/^SELECT/);
  });

  it('uses insertId for one auto-increment row, and reads back a multi-row range', async () => {
    const one = fakePool({ affectedRows: 1, insertId: 41 });
    const r1 = await executeMysqlInsert(one, buildInsert('serial', Serial as never, { rows: [{ name: 'x' }] }), Serial as never);
    expect(one.calls).toHaveLength(1);
    expect(r1.docs[0]).toEqual({ id: 41, name: 'x' });
    const many = fakePool({ affectedRows: 2, insertId: 41 }, [{ id: 41, name: 'x' }, { id: 42, name: 'y' }]);
    await executeMysqlInsert(many, buildInsert('serial', Serial as never, { rows: [{ name: 'x' }, { name: 'y' }] }), Serial as never);
    expect(many.calls).toHaveLength(2);
  });

  it('reads back when the driver reports fewer rows than were sent', async () => {
    const pool = fakePool({ affectedRows: 0 }, []);
    await executeMysqlInsert(pool, buildInsert('user', User as never, { rows: [row] }), User as never);
    expect(pool.calls).toHaveLength(2);
  });

  it('a count-only insert (createMany) never reads back', async () => {
    const pool = fakePool({ affectedRows: 2, insertId: 7 });
    const node = buildInsert('serial', Serial as never, { rows: [{ name: 'x' }, { name: 'y' }] });
    node.countOnly = true;
    const r = await executeMysqlInsert(pool, node, Serial as never);
    expect(pool.calls).toHaveLength(1);
    expect(r).toEqual({ docs: [], count: 2 });
  });
});

describe('MariaDB RETURNING', () => {
  it('is detected from the server version', () => {
    expect(mariadbReturning('10.5.8-MariaDB')).toBe(true);
    expect(mariadbReturning('11.4.2-MariaDB-ubu2404')).toBe(true);
    expect(mariadbReturning('10.4.30-MariaDB')).toBe(false);
    expect(mariadbReturning('8.0.36')).toBe(false);
    expect(mariadbReturning('9.7.1')).toBe(false);
  });

  it('inserts and deletes in one statement', async () => {
    const pool = fakePool({}, [{ id: 's1', at: new Date() }]);
    const ins = await executeMysqlInsert(pool, buildInsert('stamped', Stamped as never, { rows: [{ id: 's1' }] }), Stamped as never, { returning: true });
    expect(pool.calls).toEqual([expect.stringMatching(/^INSERT .* RETURNING \*$/)]);
    expect(ins.docs[0].id).toBe('s1');
    const del = fakePool({}, [{ id: 's1', at: new Date() }]);
    const r = await executeMysqlDelete(del, buildDelete('stamped', Stamped as never, { where: { id: 's1' } }), Stamped as never, { returning: true });
    expect(del.calls).toEqual([expect.stringMatching(/^DELETE .* LIMIT 1 RETURNING \*$/)]);
    expect(r.doc.id).toBe('s1');
  });
});
