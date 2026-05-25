import { f, model, rel } from '../schema/core';
import type { ModelDef } from '../schema/types';
import { buildSchemaDDL } from '../adapters/postgres/ddl';
import { applyMigration, planMigration } from '../adapters/postgres/migrate';
import type { PgPoolHandle } from '../adapters/postgres/execute';

// Fake pool that scripts answers to introspection queries and captures every
// statement the migrator runs.

interface QLog { sql: string; params?: unknown[] }

function mkClient(opts: {
  existingTables?: string[];
  existingConstraints?: string[];
  existingIndexes?: string[];
  errorOn?: (sql: string) => Error | undefined;
} = {}) {
  const log: QLog[] = [];
  const handle: PgPoolHandle & { release?: () => void; connect?: () => any } = {
    async query(sql, params) {
      log.push({ sql, params });
      if (opts.errorOn) {
        const e = opts.errorOn(sql);
        if (e) throw e;
      }
      if (/FROM information_schema\.tables/.test(sql)) {
        return { rows: (opts.existingTables ?? []).map((t) => ({ table_name: t })), rowCount: null };
      }
      if (/FROM pg_constraint/.test(sql)) {
        return { rows: (opts.existingConstraints ?? []).map((n) => ({ conname: n })), rowCount: null };
      }
      if (/FROM pg_indexes/.test(sql)) {
        return { rows: (opts.existingIndexes ?? []).map((n) => ({ indexname: n })), rowCount: null };
      }
      return { rows: [], rowCount: null };
    },
  };
  return { handle, log };
}

function mkPool(client: ReturnType<typeof mkClient>['handle']) {
  return {
    query: client.query.bind(client),
    connect: async () => client,
  };
}

const Post: ModelDef<any> = model('posts', {
  id: f.id(),
  author_id: f.objectId(),
  title: f.string(),
}).relate(() => ({
  author: rel.one('user', { on: 'author_id', refs: 'id', onDelete: 'Cascade' }),
})) as ModelDef<any>;

const User: ModelDef<any> = model('users', {
  id: f.id(),
  email: f.string().unique(),
}) as ModelDef<any>;

const SCHEMA: any = { user: User, post: Post };

describe('PG migrate — plan', () => {
  it('first-time push plans everything', async () => {
    const { handle } = mkClient();
    const ddl = buildSchemaDDL(SCHEMA);
    const plan = await planMigration(handle, ddl);
    expect(plan.toSkip.length).toBe(0);
    expect(plan.toApply.length).toBe(ddl.length);
    expect(plan.summary).toMatch(/\d+ statements? to apply, 0 already in place/);
  });

  it('already-existing objects get skipped', async () => {
    const { handle } = mkClient({
      existingTables: ['users', 'posts'],
      existingConstraints: ['forge_users_uq_email', 'forge_posts_fk_author_id'],
    });
    const ddl = buildSchemaDDL(SCHEMA);
    const plan = await planMigration(handle, ddl);
    // 2 tables + 1 unique + 1 FK = 4 skipped objects (plus nothing for index since none in schema)
    expect(plan.toSkip.length).toBe(4);
    // toApply should not include the skipped names.
    const applyNames = new Set(plan.toApply.map((s) => s.name));
    expect(applyNames.has('users')).toBe(false);
    expect(applyNames.has('forge_users_uq_email')).toBe(false);
  });
});

describe('PG migrate — apply', () => {
  it('wraps the batch in BEGIN/COMMIT + acquires advisory lock', async () => {
    const { handle, log } = mkClient();
    const ddl = buildSchemaDDL(SCHEMA);
    await applyMigration(mkPool(handle), ddl);
    const sqls = log.map((q) => q.sql);
    expect(sqls[0]).toBe('BEGIN');
    expect(sqls[1]).toMatch(/pg_advisory_xact_lock/);
    expect(sqls[sqls.length - 1]).toBe('COMMIT');
  });

  it('each statement is run inside a savepoint', async () => {
    const { handle, log } = mkClient();
    const ddl = buildSchemaDDL(SCHEMA);
    await applyMigration(mkPool(handle), ddl);
    const savepoints = log.filter((q) => /^SAVEPOINT forge_step_/.test(q.sql));
    expect(savepoints.length).toBeGreaterThan(0);
  });

  it('failed statements roll back to their savepoint but do not abort the batch', async () => {
    const { handle } = mkClient({
      errorOn: (sql) => /FOREIGN KEY/.test(sql) ? new Error('FK target missing') : undefined,
    });
    const ddl = buildSchemaDDL(SCHEMA);
    const report = await applyMigration(mkPool(handle), ddl);
    expect(report.failures.length).toBe(1);
    expect(report.failures[0].error).toMatch(/FK target missing/);
    // Other statements (tables, unique) should still have succeeded.
    expect(report.applied.length).toBeGreaterThan(0);
  });

  it('skips objects already present and lists them in the report', async () => {
    const { handle } = mkClient({ existingTables: ['users'] });
    const ddl = buildSchemaDDL(SCHEMA);
    const report = await applyMigration(mkPool(handle), ddl);
    expect(report.skipped).toContain('users');
    // The users CREATE TABLE shouldn't appear in the apply log.
    expect(report.applied).not.toContain('users');
  });
});
