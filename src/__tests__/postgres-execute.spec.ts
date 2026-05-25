import { f, model, rel } from '../schema/core';
import type { ModelDef } from '../schema/types';
import {
  buildCount,
  buildDelete,
  buildInsert,
  buildSelect,
  buildUpdate,
} from '../ir/build';
import {
  executePgCount,
  executePgDelete,
  executePgInsert,
  executePgSelect,
  executePgUpdate,
  type PgPoolHandle,
} from '../adapters/postgres/execute';

// Fake pg pool that captures the SQL + params it was asked to run, and
// returns scripted rows. Lets us assert end-to-end IR → executor → driver
// behaviour without spinning up a real Postgres.

interface ScriptedQuery { sql: string; params: unknown[] | undefined }

function mkPool(scripts: Array<{ rows: any[]; rowCount?: number | null }>): {
  pool: PgPoolHandle;
  history: ScriptedQuery[];
} {
  const history: ScriptedQuery[] = [];
  let i = 0;
  const pool: PgPoolHandle = {
    async query(sql, params) {
      history.push({ sql, params });
      const r = scripts[i++] ?? { rows: [] };
      return { rows: r.rows, rowCount: r.rowCount ?? r.rows.length };
    },
  };
  return { pool, history };
}

const User: ModelDef<any> = model('users', {
  id: f.id(),
  email: f.string().unique(),
  age: f.int().optional(),
  active: f.bool().default(false),
}).relate(() => ({
  posts: rel.many('post', { on: 'author_id', refs: 'id' }),
})) as ModelDef<any>;

describe('PG execute — reads', () => {
  it('executePgSelect runs compiled SQL + returns rows', async () => {
    const { pool, history } = mkPool([{ rows: [{ id: 'u1', email: 'a@b.co', active: true }] }]);
    const rows = await executePgSelect(
      pool,
      buildSelect('user', User, { where: { active: true } }, 'many'),
      User,
    );
    expect(rows).toEqual([{ id: 'u1', email: 'a@b.co', active: true }]);
    expect(history[0].sql).toMatch(/WHERE "users"\."active" = \$1/);
    expect(history[0].params).toEqual([true]);
  });

  it('executePgCount coerces bigint string to number', async () => {
    const { pool } = mkPool([{ rows: [{ count: '42' }] }]);
    const n = await executePgCount(pool, buildCount('user', User, undefined), User);
    expect(n).toBe(42);
  });

  it('executePgSelect with distinct dedupes client-side too', async () => {
    const { pool } = mkPool([{ rows: [
      { id: 'a', email: 'x@y.co' }, { id: 'b', email: 'x@y.co' },
    ] }]);
    const rows = await executePgSelect(
      pool,
      buildSelect('user', User, { distinct: ['email'] }, 'many'),
      User,
    );
    expect(rows.length).toBe(1);
  });
});

describe('PG execute — writes', () => {
  it('executePgInsert returns inserted row + count', async () => {
    const { pool, history } = mkPool([{ rows: [{ id: 'u1', email: 'a@b.co' }] }]);
    const r = await executePgInsert(
      pool,
      buildInsert('user', User, { rows: [{ email: 'a@b.co' }] }),
      User,
    );
    expect(r.docs[0].email).toBe('a@b.co');
    expect(r.count).toBe(1);
    expect(history[0].sql).toMatch(/INSERT INTO "users" \("email"\) VALUES \(\$1\) RETURNING/);
  });

  it('executePgUpdate (single) returns updated doc + count', async () => {
    const { pool } = mkPool([{ rows: [{ id: 'u1', active: true }], rowCount: 1 }]);
    const r = await executePgUpdate(
      pool,
      buildUpdate('user', User, { where: { id: 'u1' }, data: { active: true }, many: false }),
      User,
    );
    expect(r.doc?.active).toBe(true);
    expect(r.count).toBe(1);
  });

  it('executePgUpdate (many) returns count only', async () => {
    const { pool } = mkPool([{ rows: [], rowCount: 3 }]);
    const r = await executePgUpdate(
      pool,
      buildUpdate('user', User, { where: { active: false }, data: { active: true }, many: true }),
      User,
    );
    expect(r.count).toBe(3);
    expect((r as any).doc).toBeUndefined();
  });

  it('executePgDelete (single) returns deleted doc', async () => {
    const { pool } = mkPool([{ rows: [{ id: 'u1' }], rowCount: 1 }]);
    const r = await executePgDelete(
      pool,
      buildDelete('user', User, { where: { id: 'u1' }, many: false }),
      User,
    );
    expect(r.doc?.id).toBe('u1');
    expect(r.count).toBe(1);
  });
});

describe('PG execute — opts.client routes onto a specific connection', () => {
  it('uses opts.client when provided (for $transaction)', async () => {
    const { pool: defaultPool, history: defaultHist } = mkPool([]);
    const { pool: txPool,      history: txHist }      = mkPool([{ rows: [{ id: 'x' }] }]);
    await executePgSelect(
      defaultPool,
      buildSelect('user', User, undefined, 'many'),
      User,
      { client: txPool },
    );
    expect(defaultHist.length).toBe(0);
    expect(txHist.length).toBe(1);
  });
});
