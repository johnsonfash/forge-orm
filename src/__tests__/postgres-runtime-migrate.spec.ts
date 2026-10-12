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
 * The same model after a correction: `balance` turned out not to be written
 * on every path, so the declaration was wrong and is now `.optional()`.
 * Dropping the default too — a field with a default is never NULL anyway, so
 * it would not exercise the widening.
 */
const AccountOptionalBalance = model('accounts', {
  id: f.id({ type: 'uuid' }),
  owner: f.string().unique(),
  balance: f.int().optional(),
});
const optionalBalanceSchema = { account: AccountOptionalBalance } as any;

/**
 * A single-session postgres driver, the shape PGlite and Neon-over-HTTP
 * present: `query` and nothing else. No pool, so no `connect()`.
 */
function fakePgDriver(
  existing: {
    tables?: string[];
    constraints?: string[];
    columns?: string[];
    /** "<table>.<column>" entries the database currently has as NOT NULL. */
    notNull?: string[];
  } = {},
) {
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
      // "<table>.<column>", the shape the planner keys ADD COLUMN on. A
      // listed table with no columns is not a state a real database can be
      // in, so a caller that declares `tables` declares its columns too.
      if (/information_schema\.columns/.test(text)) {
        // Two different lookups hit this table: every column, and the subset
        // that is NOT NULL. The second carries `is_nullable` in its WHERE.
        const wantNotNull = /is_nullable/.test(text);
        const src = wantNotNull ? (existing.notNull ?? []) : (existing.columns ?? []);
        return {
          rows: src.map((c) => {
            const [table_name, column_name] = c.split('.');
            return { table_name, column_name };
          }),
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
      // The columns the table already has. Without these the planner would
      // rightly want to ADD them: a table is not "already there" if its
      // columns are missing, which is the gap buildAddColumns closes.
      columns: ['accounts.id', 'accounts.owner', 'accounts.balance'],
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
    await expect(db.$migrate()).rejects.toThrow(/only supported on mongo, sqlite, postgres and indexeddb/);
  });
});

/**
 * THE COLUMN THAT NEVER ARRIVED.
 *
 * `forge push` used to decide "already applied?" per statement, and a CREATE
 * TABLE counts as applied the moment the TABLE exists. So adding a field to a
 * model and pushing against a database that already had the table did
 * NOTHING: push printed `applied 1, skipped 703`, exited 0, and the column was
 * not there. The first query naming it failed at runtime instead, a long way
 * from the push that was supposed to have created it.
 *
 * Caught on a real schema — `media_tags.assetCreatedAt` was added, pushed, and
 * reported as a success against a database without the column.
 */
describe('$migrate() adds a column to a table that already exists', () => {
  it('ALTERs in the missing column instead of reporting success', async () => {
    const { driver, sql } = fakePgDriver({
      tables: ['accounts'],
      constraints: ['forge_accounts_uq_owner'],
      // `balance` is absent — the field was added to the model after this
      // database was first pushed.
      columns: ['accounts.id', 'accounts.owner'],
    });
    const db = (await createDb({ driver, schema: appSchema })) as any;
    const r = await db.$migrate();
    expect(sql.join('\n')).toMatch(
      /ALTER TABLE "accounts" ADD COLUMN IF NOT EXISTS "balance"/,
    );
    expect(r.applied).toContain('accounts.balance');
    expect(r.failures).toEqual([]);
    // The two it already has are left alone.
    expect(r.applied).not.toContain('accounts.id');
    expect(r.applied).not.toContain('accounts.owner');
  });

  it('leaves a fully-migrated database completely alone', async () => {
    const { driver } = fakePgDriver({
      tables: ['accounts'],
      constraints: ['forge_accounts_uq_owner'],
      columns: ['accounts.id', 'accounts.owner', 'accounts.balance'],
    });
    const db = (await createDb({ driver, schema: appSchema })) as any;
    const r = await db.$migrate();
    expect(r.applied).toEqual([]);
    expect(r.failures).toEqual([]);
  });
});

/**
 * A FIELD THAT WAS DECLARED REQUIRED AND IS NOT.
 *
 * This is the correction that cannot be made any other way. A required field
 * means nothing on Mongo — forge leaves a valueless field off the document —
 * so a declaration drifts from what the code actually writes without anyone
 * noticing, and the drift only surfaces when a NOT NULL column refuses the
 * same write on SQL. Fixing `schema.ts` then has to reach a database that has
 * already been pushed, or it is only a fix for databases nobody has made yet.
 *
 * Widening is the one column change that is safe unasked: every value already
 * in the column still fits. Narrowing (SET NOT NULL) can fail on the rows that
 * are already there and is left to the operator, with the statement to run.
 */
describe('$migrate() widens a column the schema no longer requires', () => {
  it('drops NOT NULL when the field became optional', async () => {
    const { driver, sql } = fakePgDriver({
      tables: ['accounts'],
      constraints: ['forge_accounts_uq_owner'],
      columns: ['accounts.id', 'accounts.owner', 'accounts.balance'],
      // The database still has it required; the schema has moved on.
      notNull: ['accounts.id', 'accounts.owner', 'accounts.balance'],
    });
    const db = (await createDb({ driver, schema: optionalBalanceSchema })) as any;
    const r = await db.$migrate();
    expect(sql.join('\n')).toMatch(
      /ALTER TABLE "accounts" ALTER COLUMN "balance" DROP NOT NULL/,
    );
    expect(r.applied).toContain('accounts.balance');
    expect(r.failures).toEqual([]);
  });

  it('never emits SET NOT NULL on its own', async () => {
    const { driver, sql } = fakePgDriver({
      tables: ['accounts'],
      constraints: ['forge_accounts_uq_owner'],
      columns: ['accounts.id', 'accounts.owner', 'accounts.balance'],
      // Nullable in the database, required in the schema — the NARROWING
      // direction, which can fail on existing rows.
      notNull: ['accounts.id'],
    });
    const db = (await createDb({ driver, schema: appSchema })) as any;
    await db.$migrate();
    expect(sql.join('\n')).not.toMatch(/SET NOT NULL/);
  });

  it('leaves an already-nullable column alone', async () => {
    const { driver, sql } = fakePgDriver({
      tables: ['accounts'],
      constraints: ['forge_accounts_uq_owner'],
      columns: ['accounts.id', 'accounts.owner', 'accounts.balance'],
      notNull: ['accounts.id', 'accounts.owner'],
    });
    const db = (await createDb({ driver, schema: optionalBalanceSchema })) as any;
    const r = await db.$migrate();
    expect(sql.join('\n')).not.toMatch(/DROP NOT NULL/);
    expect(r.applied).toEqual([]);
  });
});
