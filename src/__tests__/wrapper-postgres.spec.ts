import { f, model, rel } from '../schema/core';
import type { ModelDef } from '../schema/types';
import { CollectionWrapper } from '../builder/collection';
import { PostgresAdapter } from '../adapters/postgres/adapter';
import { pgDriver } from '../adapters/postgres/driver';

// Wave 2c-2 end-to-end check: drive a CollectionWrapper through the Postgres
// adapter (via a fake pg pool) and assert the queries that flow through.
// This proves the wrapper-adapter plumbing works for non-Mongo dialects.

interface QLog { sql: string; params?: unknown[] }

function mkFakePool(scripts: Array<{ rows: any[]; rowCount?: number | null }>) {
  const log: QLog[] = [];
  let i = 0;
  return {
    log,
    query: async (sql: string, params?: unknown[]) => {
      log.push({ sql, params });
      const r = scripts[i++] ?? { rows: [] };
      return { rows: r.rows, rowCount: r.rowCount ?? r.rows.length };
    },
    async connect() {
      return {
        query: async (sql: string, params?: unknown[]) => {
          log.push({ sql, params });
          const r = scripts[i++] ?? { rows: [] };
          return { rows: r.rows, rowCount: r.rowCount ?? r.rows.length };
        },
        release: () => {},
      };
    },
    end: async () => {},
  };
}

// Wire a PostgresAdapter to the fake pool without going through connect()
// (which would try to load the real `pg` driver). Inject through the driver
// port — the same path createDb({ driver }) uses.
function adapterWithPool(pool: any): PostgresAdapter {
  const ad = new PostgresAdapter();
  (ad as any)._driver = pgDriver(pool);
  (ad as any)._rawPool = pool;
  return ad;
}

const User: ModelDef<any> = model('users', {
  id: f.id(),
  email: f.string().unique(),
  age: f.int().optional(),
  active: f.bool().default(false),
}).relate(() => ({
  posts: rel.many('post', { on: 'author_id', refs: 'id' }),
})) as ModelDef<any>;

describe('CollectionWrapper + PostgresAdapter — read path', () => {
  it('findMany routes through the PG executor and emits parameterised SQL', async () => {
    const pool = mkFakePool([{ rows: [{ id: 'u1', email: 'a@b.co', active: true }] }]);
    const w = new CollectionWrapper(User, undefined, adapterWithPool(pool));
    const rows = await w.findMany({ where: { active: true }, take: 5 });
    expect(rows).toEqual([{ id: 'u1', email: 'a@b.co', active: true }]);
    expect(pool.log[0].sql).toMatch(/SELECT .* FROM "users" WHERE "users"\."active" = \$1 LIMIT 5/);
    expect(pool.log[0].params).toEqual([true]);
  });

  it('count routes through the PG executor', async () => {
    const pool = mkFakePool([{ rows: [{ count: '7' }] }]);
    const w = new CollectionWrapper(User, undefined, adapterWithPool(pool));
    const n = await w.count({ where: { active: false } });
    expect(n).toBe(7);
    expect(pool.log[0].sql).toMatch(/SELECT COUNT\(\*\) AS count FROM "users" WHERE/);
  });
});

describe('CollectionWrapper + PostgresAdapter — write path', () => {
  it('create emits INSERT INTO … VALUES … RETURNING * and returns the row', async () => {
    const pool = mkFakePool([{ rows: [{ id: 'u1', email: 'a@b.co', active: false }] }]);
    const w = new CollectionWrapper(User, undefined, adapterWithPool(pool));
    const out = await w.create({ data: { id: 'u1', email: 'a@b.co' } });
    expect(out).toMatchObject({ id: 'u1', email: 'a@b.co' });
    expect(pool.log[0].sql).toMatch(/INSERT INTO "users" \("id", "email"\) VALUES \(\$1, \$2\) RETURNING \*/);
  });

  it('update single → findOneAndUpdate-equivalent with ctid idiom', async () => {
    const pool = mkFakePool([{ rows: [{ id: 'u1', active: true }], rowCount: 1 }]);
    const w = new CollectionWrapper(User, undefined, adapterWithPool(pool));
    const out = await w.update({ where: { id: 'u1' }, data: { active: true } });
    expect(out).toMatchObject({ id: 'u1', active: true });
    expect(pool.log[0].sql).toMatch(/UPDATE "users" SET "active" = \$1 WHERE ctid = \(SELECT ctid FROM "users" WHERE/);
  });

  it('updateMany returns count only', async () => {
    const pool = mkFakePool([{ rows: [], rowCount: 3 }]);
    const w = new CollectionWrapper(User, undefined, adapterWithPool(pool));
    const r = await w.updateMany({ where: { active: false }, data: { active: true } });
    expect(r).toEqual({ count: 3 });
  });

  it('delete returns the deleted row + cascade is a no-op on PG (DB-enforced)', async () => {
    const pool = mkFakePool([{ rows: [{ id: 'u1' }], rowCount: 1 }]);
    const w = new CollectionWrapper(User, undefined, adapterWithPool(pool));
    const out = await w.delete({ where: { id: 'u1' } });
    expect(out).toMatchObject({ id: 'u1' });
    // Single DELETE statement, no follow-up cascade walker queries.
    expect(pool.log.length).toBe(1);
    expect(pool.log[0].sql).toMatch(/DELETE FROM "users" WHERE ctid =/);
  });
});

describe('CollectionWrapper falls back to Mongo singleton when no adapter is injected', () => {
  it('uses Mongo executor by default — proves default-adapter back-compat', () => {
    const w = new CollectionWrapper(User);
    expect((w as any).adapter.kind).toBe('mongo');
  });
});

// 2.2 — compile namespace must dispatch by adapter kind. Up to 2.2 it
// was hardcoded to buildMongoCompileApi and silently returned Mongo
// artifacts on Postgres / MySQL / SQLite. These tests pin that fix.

describe('CollectionWrapper.compile dispatches by adapter kind (2.2)', () => {
  it('returns a SQLArtifact with dialect=postgres on a Postgres adapter', () => {
    const pool = mkFakePool([]);
    const w = new CollectionWrapper(User, undefined, adapterWithPool(pool));
    const art = w.compile.findMany({ where: { active: true }, take: 5 });
    expect(art.kind).toBe('sql');
    expect((art as any).dialect).toBe('postgres');
    expect((art as any).sql).toMatch(/SELECT/);
  });

  it('.compileSql is a narrowed getter that throws on a Mongo adapter', () => {
    const w = new CollectionWrapper(User); // default Mongo singleton
    expect(() => w.compileSql).toThrow(/SQL adapter|not available on a Mongo adapter/i);
  });

  it('.compileMongo throws on a Postgres adapter', () => {
    const pool = mkFakePool([]);
    const w = new CollectionWrapper(User, undefined, adapterWithPool(pool));
    expect(() => w.compileMongo).toThrow(/Mongo adapter|only available on a Mongo adapter/i);
  });
});

// 2.2 — soft delete on the SQL compile + runtime paths.

const Account: ModelDef<any> = model('accounts', {
  id: f.id(),
  name: f.string(),
  // softDeleteAt marker — added in 2.0; the wrapper's softDelete /
  // restore methods route through update with a hint.
  deletedAt: f.dateTime().optional().softDeleteAt(),
}) as ModelDef<any>;

describe('CollectionWrapper soft delete through Postgres (2.0 + 2.2)', () => {
  it('softDelete sets the soft-delete column via an UPDATE', async () => {
    const pool = mkFakePool([{ rows: [{ id: 'a1', name: 'A', deletedAt: new Date() }], rowCount: 1 }]);
    const w = new CollectionWrapper<any>(Account, undefined, adapterWithPool(pool));
    await w.softDelete({ where: { id: 'a1' } });
    expect(pool.log.length).toBe(1);
    expect(pool.log[0].sql).toMatch(/UPDATE\s+"accounts"\s+SET/);
    expect(pool.log[0].sql).toMatch(/"deletedAt"/);
  });

  it('restore clears the soft-delete column via an UPDATE', async () => {
    const pool = mkFakePool([{ rows: [{ id: 'a1', name: 'A', deletedAt: null }], rowCount: 1 }]);
    const w = new CollectionWrapper<any>(Account, undefined, adapterWithPool(pool));
    await w.restore({ where: { id: 'a1' } });
    expect(pool.log.length).toBe(1);
    expect(pool.log[0].sql).toMatch(/UPDATE\s+"accounts"\s+SET/);
    expect(pool.log[0].sql).toMatch(/"deletedAt"/);
    // NULL flows as a parameter (param value undefined or null) — assert
    // the params list carries a null entry.
    expect((pool.log[0].params ?? []).includes(null)).toBe(true);
  });

  it('compile.softDelete on Postgres returns an UPDATE SQLArtifact', () => {
    const pool = mkFakePool([]);
    const w = new CollectionWrapper<any>(Account, undefined, adapterWithPool(pool));
    const art = w.compile.softDelete({ where: { id: 'a1' } });
    expect(art.kind).toBe('sql');
    expect((art as any).sql).toMatch(/UPDATE/);
    expect((art as any).sql).toMatch(/"deletedAt"/);
  });
});
