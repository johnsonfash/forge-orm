/* eslint-disable no-console */
import { f, model, rel } from './src/schema/core';
import type { ModelDef } from './src/schema/types';
import { CollectionWrapper } from './src/builder/collection';
import { PostgresAdapter } from './src/adapters/postgres/adapter';
import { buildSchemaDDL } from './src/adapters/postgres/ddl';
import { applyMigration } from './src/adapters/postgres/migrate';
import { forgeSql } from './src/raw-sql';
import { DbKnownError } from './src/adapters/mongo/errors';

// Real Postgres integration smoke. Creates tables with a unique prefix, runs
// CRUD + raw SQL + a unique-violation probe through the live adapter, then
// drops the tables. No data outside the prefix is touched.

const STAMP = `${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
const PFX = `forge_smoke_${STAMP}`;
const PG_URL = process.env.SMOKE_PG_URL ?? `postgres://johnfash@127.0.0.1:5432/postgres`;

// Minimal schema: User → Post with FK + cascade.
const User: ModelDef<any> = model(`${PFX}_users`, {
  id: f.id(),                    // f.id() → PK in DDL; PG coerce passes user-supplied text through
  email: f.string().unique(),
  age: f.int().optional(),
  active: f.bool().default(false),
}).relate(() => ({
  posts: rel.many(`${PFX}_post`, { on: 'author_id', refs: 'id' }),
})) as ModelDef<any>;

const Post: ModelDef<any> = model(`${PFX}_posts`, {
  id: f.id(),
  author_id: f.string(),
  title: f.string(),
}).relate(() => ({
  author: rel.one(`${PFX}_user`, { on: 'author_id', refs: 'id', onDelete: 'Cascade' }),
})) as ModelDef<any>;

const SCHEMA: any = { [`${PFX}_user`]: User, [`${PFX}_post`]: Post };

async function main() {
  console.log(`[smoke] connecting to ${PG_URL.replace(/(:\/\/[^:@/]+):([^@/]+)@/, '$1:****@')}`);
  console.log(`[smoke] table prefix: ${PFX}`);

  const adapter = new PostgresAdapter();
  await adapter.connect(PG_URL);
  const pool = (adapter as any).pool;

  let pass = 0, fail = 0;
  const ok = (label: string, cond: any) => {
    if (cond) { pass++; console.log(`  ✓ ${label}`); }
    else      { fail++; console.log(`  ✗ ${label}`); }
  };

  try {
    // ─── 1. Push schema ────────────────────────────────────────────
    console.log('\n[1] forge:push — DDL plan + apply');
    const ddl = buildSchemaDDL(SCHEMA);
    const report = await applyMigration(pool, ddl);
    console.log(`  applied: ${report.applied.length}, skipped: ${report.skipped.length}, failures: ${report.failures.length}`);
    if (report.failures.length) report.failures.forEach((f) => console.log(`  - ${f.name}: ${f.error}`));
    ok('DDL applied with zero failures', report.failures.length === 0);

    // ─── 2. CRUD via wrapper ───────────────────────────────────────
    console.log('\n[2] CollectionWrapper CRUD');
    const userW = new CollectionWrapper(User, undefined, adapter);
    const postW = new CollectionWrapper(Post, undefined, adapter);

    const u = await userW.create({ data: { id: 'u_alice', email: 'alice@x.co', age: 30 } });
    ok('create returned row with id', u?.id === 'u_alice');

    const found = await userW.findMany({ where: { active: false }, take: 10 });
    ok('findMany filters by active=false', found.some((r: any) => r.id === 'u_alice'));

    const n = await userW.count();
    ok(`count returns number (got ${n})`, typeof n === 'number' && n >= 1);

    const updated = await userW.update({
      where: { id: 'u_alice' },
      data: { active: true, age: { increment: 1 } },
    });
    ok('update applied $set + $inc', updated?.active === true && updated?.age === 31);

    await postW.create({ data: { id: 'p_1', author_id: 'u_alice', title: 'hello' } });
    const posts = await postW.findMany({ where: { author_id: 'u_alice' } });
    ok('cross-table query finds the post', posts.length === 1);

    // ─── 3. $queryRaw + $executeRaw ────────────────────────────────
    console.log('\n[3] raw SQL escape hatches');
    const rawRows = await adapter.$queryRaw(
      forgeSql.sql`SELECT id, email FROM ${forgeSql.raw(`"${PFX}_users"`)} WHERE id = ${'u_alice'}`,
    );
    ok('$queryRaw parameterised', rawRows.length === 1 && rawRows[0].email === 'alice@x.co');

    const affected = await adapter.$executeRaw(
      forgeSql.sql`UPDATE ${forgeSql.raw(`"${PFX}_users"`)} SET age = ${100} WHERE id = ${'u_alice'}`,
    );
    ok(`$executeRaw returned count (got ${affected})`, affected === 1);

    // ─── 4. PG error mapping: unique violation → P2002 ─────────────
    console.log('\n[4] error code mapping');
    try {
      await userW.create({ data: { id: 'u_alice2', email: 'alice@x.co' /* duplicate email */ } });
      ok('unique violation should have thrown', false);
    } catch (e: any) {
      ok(`unique violation → DbKnownError P2002 (got code ${e?.code})`,
         e instanceof DbKnownError && e.code === 'P2002');
    }

    // ─── 5. FK cascade on delete ───────────────────────────────────
    console.log('\n[5] ON DELETE CASCADE (DB-enforced)');
    await userW.delete({ where: { id: 'u_alice' } });
    const orphans = await postW.findMany({ where: { author_id: 'u_alice' } });
    ok('deleting user cascaded to posts', orphans.length === 0);

    // ─── 6. $transaction ───────────────────────────────────────────
    console.log('\n[6] $transaction (BEGIN/COMMIT/ROLLBACK)');
    await adapter.$transaction(async (session) => {
      const txUser = new CollectionWrapper(User, session, adapter);
      await txUser.create({ data: { id: 'u_tx', email: 'tx@x.co' } });
    });
    const txed = await userW.findMany({ where: { id: 'u_tx' } });
    ok('committed tx persists', txed.length === 1);

    // Rollback probe — throw inside the tx and expect no row created.
    try {
      await adapter.$transaction(async (session) => {
        const txUser = new CollectionWrapper(User, session, adapter);
        await txUser.create({ data: { id: 'u_rb', email: 'rb@x.co' } });
        throw new Error('rollback me');
      });
    } catch { /* expected */ }
    const rb = await userW.findMany({ where: { id: 'u_rb' } });
    ok('thrown tx rolled back (no row)', rb.length === 0);

    console.log(`\n[smoke] ${pass} passed, ${fail} failed`);
  } finally {
    // ─── Cleanup ─────────────────────────────────────────────────
    console.log('\n[cleanup] dropping tables');
    try { await pool.query(`DROP TABLE IF EXISTS "${PFX}_posts" CASCADE`); } catch {}
    try { await pool.query(`DROP TABLE IF EXISTS "${PFX}_users" CASCADE`); } catch {}
    await adapter.close();
  }
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
