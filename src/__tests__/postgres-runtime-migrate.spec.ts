// `$migrate()` on the postgres adapter.
//
// It used to refuse and say "use the CLI: npx forge push", which is no
// help at all when the database is PGlite — an in-process WASM Postgres
// with no server to point a CLI at, running in StackBlitz or a browser or
// a serverless function where there is no shell either. sqlite-wasm has
// had a runtime path since 2.4 for exactly this reason.
//
// The implementation reuses the CLI's own plan/apply, driven in-process,
// so what is worth testing here is the plumbing: that an injected
// single-session driver (no pool, no connect()) is adapted correctly, and
// that the DDL actually reaches it.

import { createDb } from '../factory';
import { f, model } from '../schema/core';
import type { PostgresDriver } from '../adapters/postgres/driver';

const Account = model('accounts', {
  id: f.id({ type: 'uuid' }),
  owner: f.string().unique(),
  balance: f.int().default(0),
});
const appSchema = { account: Account } as any;

/**
 * A single-session postgres driver, the shape PGlite and Neon-over-HTTP
 * present: `query` and nothing else. No pool, so no `connect()`.
 */
function fakePgDriver(existing: { tables?: string[]; constraints?: string[] } = {}) {
  const sql: string[] = [];
  const driver = {
    kind: 'postgres',
    query: async (text: string) => {
      sql.push(text);
      // The planner asks what already exists before deciding what to run.
      if (/information_schema\.tables/.test(text)) {
        return { rows: (existing.tables ?? []).map((t) => ({ table_name: t })), rowCount: 0 };
      }
      if (/pg_constraint|constraint_name/.test(text)) {
        return {
          rows: (existing.constraints ?? []).map((c) => ({ conname: c, constraint_name: c })),
          rowCount: 0,
        };
      }
      if (/pg_indexes|indexname/.test(text)) return { rows: [], rowCount: 0 };
      return { rows: [], rowCount: 0 };
    },
    transaction: async (fn: any) => fn({ query: driver.query }),
    close: async () => {},
  } as unknown as PostgresDriver;
  return { driver, sql };
}

describe('$migrate() on postgres', () => {
  it('no longer refuses', async () => {
    const { driver } = fakePgDriver();
    const db = (await createDb({ driver, schema: appSchema })) as any;
    await expect(db.$migrate()).resolves.toBeDefined();
  });

  it('emits CREATE TABLE for the schema', async () => {
    const { driver, sql } = fakePgDriver();
    const db = (await createDb({ driver, schema: appSchema })) as any;
    await db.$migrate();
    expect(sql.join('\n')).toMatch(/CREATE TABLE IF NOT EXISTS "accounts"/);
  });

  it('emits the unique constraint too', async () => {
    const { driver, sql } = fakePgDriver();
    const db = (await createDb({ driver, schema: appSchema })) as any;
    await db.$migrate();
    expect(sql.join('\n')).toMatch(/ADD CONSTRAINT "forge_accounts_uq_owner" UNIQUE/);
  });

  it('reports what it applied', async () => {
    const { driver } = fakePgDriver();
    const db = (await createDb({ driver, schema: appSchema })) as any;
    const r = await db.$migrate();
    expect(r.applied).toContain('accounts');
    expect(r.failures).toEqual([]);
  });

  it('skips what the database already has, rather than failing on it', async () => {
    // ADD CONSTRAINT is not IF NOT EXISTS, so a second run would error if
    // the planner did not look first. This is the idempotency that makes
    // "$migrate() at app boot" a safe thing to write.
    const { driver } = fakePgDriver({
      tables: ['accounts'],
      constraints: ['forge_accounts_uq_owner'],
    });
    const db = (await createDb({ driver, schema: appSchema })) as any;
    const r = await db.$migrate();
    expect(r.applied).toEqual([]);
    expect(r.skipped.length).toBeGreaterThan(0);
    expect(r.failures).toEqual([]);
  });

  it('carries the report shape the sqlite path returns', async () => {
    const { driver } = fakePgDriver();
    const db = (await createDb({ driver, schema: appSchema })) as any;
    const r = await db.$migrate();
    for (const k of ['applied', 'skipped', 'failures', 'alteredColumns', 'pending']) {
      expect(r).toHaveProperty(k);
    }
  });

  it('a driver with no connect() still works — it IS the session', async () => {
    const { driver, sql } = fakePgDriver();
    expect((driver as any).connect).toBeUndefined();
    const db = (await createDb({ driver, schema: appSchema })) as any;
    await db.$migrate();
    expect(sql.some((s) => /CREATE TABLE/.test(s))).toBe(true);
  });

  it('still refuses on an adapter that genuinely has no runtime path', async () => {
    const mysqlish = {
      kind: 'mysql',
      query: async () => ({ rows: [], rowCount: 0 }),
      transaction: async (fn: any) => fn({ query: async () => ({ rows: [], rowCount: 0 }) }),
      close: async () => {},
    } as any;
    const db = (await createDb({ driver: mysqlish, schema: appSchema })) as any;
    await expect(db.$migrate()).rejects.toThrow(/only supported on sqlite, postgres and indexeddb/);
  });
});
