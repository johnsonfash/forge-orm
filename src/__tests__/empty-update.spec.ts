// An empty SET list is valid input and was invalid SQL.
//
//   db.user.upsert({ where, create, update: {} })
//
// is the ordinary "insert if it isn't there, otherwise leave it alone"
// idiom — the first thing anyone writes for an idempotent seed. It
// compiled to `... DO UPDATE SET  RETURNING *`, and because the parser
// blames the token after the empty clause, every dialect reported
// `near "RETURNING": syntax error` — pointing at the one part of the
// statement that was fine.
//
// Found by running forge-orm-examples/04-node-cli, whose entire body is
// that upsert.

import { f, model } from '../schema/core';
import { compileUpdate as pgCompileUpdate } from '../adapters/postgres/compile-from-ir';
import { compileUpdate as sqliteCompileUpdate } from '../adapters/sqlite/compile-from-ir';
import { compileUpdate as mysqlCompileUpdate } from '../adapters/mysql/compile-from-ir';
import { compileUpdate as duckdbCompileUpdate } from '../adapters/duckdb/compile-from-ir';

const User = model('users', {
  id: f.id({ type: 'uuid' }),
  email: f.string().unique(),
  name: f.string(),
});

const upsertNode = (set?: Record<string, unknown>) =>
  ({
    model: 'user',
    kind: 'update',
    where: { kind: 'leaf', field: 'email', op: 'eq', value: 'a@b.c' },
    upsertCreate: { email: 'a@b.c', name: 'A' },
    ...(set ? { set } : {}),
    many: false,
  }) as never;

const updateNode = (many: boolean, set?: Record<string, unknown>) =>
  ({
    model: 'user',
    kind: 'update',
    where: { kind: 'leaf', field: 'id', op: 'eq', value: 'x' },
    ...(set ? { set } : {}),
    many,
  }) as never;

const compilers = [
  ['postgres', pgCompileUpdate],
  ['sqlite', sqliteCompileUpdate],
  ['duckdb', duckdbCompileUpdate],
  ['mysql', mysqlCompileUpdate],
] as const;

describe('an empty update never emits an empty SET', () => {
  for (const [name, compile] of compilers) {
    describe(name, () => {
      it('upsert with update:{} produces no dangling SET', () => {
        const sql = compile(upsertNode(), User as never).sql;
        expect(sql).not.toMatch(/SET\s*$/);
        expect(sql).not.toMatch(/SET\s+RETURNING/);
        expect(sql).not.toMatch(/SET\s{2,}/);
      });

      it('update with data:{} produces no dangling SET', () => {
        const sql = compile(updateNode(false), User as never).sql;
        expect(sql).not.toMatch(/SET\s+WHERE/);
        expect(sql).not.toMatch(/SET\s{2,}/);
      });

      it('updateMany with data:{} produces no dangling SET', () => {
        const sql = compile(updateNode(true), User as never).sql;
        expect(sql).not.toMatch(/SET\s+RETURNING/);
        expect(sql).not.toMatch(/SET\s*$/);
      });

      it('a real update is untouched by the fix', () => {
        const sql = compile(upsertNode({ name: 'B' }), User as never).sql;
        expect(sql).toMatch(/name/);
        // The no-op column must NOT appear when there is real work to do.
        expect(sql).not.toMatch(/id.*=.*id/i);
      });
    });
  }
});

describe('the substitute assignment is genuinely a no-op', () => {
  it('postgres assigns the column to its own stored value', () => {
    expect(pgCompileUpdate(upsertNode(), User as never).sql).toContain(
      'DO UPDATE SET "id" = "users"."id"',
    );
  });

  it('sqlite does the same', () => {
    expect(sqliteCompileUpdate(upsertNode(), User as never).sql).toContain(
      'DO UPDATE SET "id" = "users"."id"',
    );
  });

  it('MySQL uses its own `col` = `col` idiom, NOT VALUES(col)', () => {
    // This one is the dangerous case. MySQL rewrites each assignment to
    // `col = VALUES(col)` so the upsert reuses the INSERT's values —
    // correct for a real update, catastrophic for the no-op, because
    // VALUES(`id`) is the id the INSERT proposed. On conflict that
    // silently replaces the existing row's primary key with a freshly
    // generated uuid, and every foreign key pointing at it goes stale.
    const sql = mysqlCompileUpdate(upsertNode(), User as never).sql;
    expect(sql).toContain('ON DUPLICATE KEY UPDATE `id` = `id`');
    expect(sql).not.toMatch(/VALUES\(`id`\)/);
  });

  it('MySQL still rewrites a REAL assignment to VALUES(col)', () => {
    const sql = mysqlCompileUpdate(upsertNode({ name: 'B' }), User as never).sql;
    expect(sql).toContain('ON DUPLICATE KEY UPDATE `name` = VALUES(`name`)');
  });
});

describe('upsert still returns its row', () => {
  it('does not fall back to DO NOTHING, which returns none on conflict', () => {
    // `DO NOTHING` parses and would have been the shorter fix. But with
    // RETURNING it yields no row when the conflict fires, so upsert would
    // resolve to undefined exactly when the record already existed — a
    // silent wrong answer in place of a loud syntax error.
    const sql = pgCompileUpdate(upsertNode(), User as never).sql;
    expect(sql).not.toMatch(/DO NOTHING/);
    expect(sql).toMatch(/RETURNING \*/);
  });
});
