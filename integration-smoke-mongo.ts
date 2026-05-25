/* eslint-disable no-console */
import { f, model, rel } from './src/schema/core';
import type { ModelDef } from './src/schema/types';
import { CollectionWrapper } from './src/builder/collection';
import { MongoAdapter } from './src/adapters/mongo/adapter';
import { dbClient } from './src/adapters/mongo/client';
import { DbKnownError } from './src/adapters/mongo/errors';

// Real Mongo integration smoke. Uses a unique db name so it doesn't touch
// anything real; drops the db at the end.

const STAMP = `${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
const DB = `forge_smoke_${STAMP}`;
const MONGO_URL = process.env.SMOKE_MONGO_URL ?? `mongodb://127.0.0.1:27017/${DB}`;

const User: ModelDef<any> = model('users', {
  id: f.id(),
  email: f.string().unique(),
  age: f.int().optional(),
  active: f.bool().default(false),
}).relate(() => ({})) as ModelDef<any>;

async function main() {
  console.log(`[smoke] connecting to ${MONGO_URL}`);
  console.log(`[smoke] db: ${DB}`);

  const adapter = new MongoAdapter();
  await adapter.connect(MONGO_URL);

  let pass = 0, fail = 0;
  const ok = (label: string, cond: any) => {
    if (cond) { pass++; console.log(`  ✓ ${label}`); }
    else      { fail++; console.log(`  ✗ ${label}`); }
  };

  try {
    const userW = new CollectionWrapper(User, undefined, adapter);

    // ─── 1. Indexes via doctor — no DDL push for Mongo, just probe ──
    console.log('\n[1] adapter doctor');
    const doc = await adapter.doctor();
    ok('mongo driver installed', doc.driverInstalled === true);
    ok('driver version reported', !!doc.driverVersion);

    // ─── 2. CRUD ───────────────────────────────────────────────────
    console.log('\n[2] CollectionWrapper CRUD');
    const u = await userW.create({ data: { email: 'alice@x.co', age: 30 } as any });
    ok('create returned doc with id (ObjectId stringified)', typeof (u as any)?.id === 'string');

    const found = await userW.findMany({ where: { active: false } as any, take: 10 });
    ok('findMany finds the created user', (found as any[]).some((r: any) => r.email === 'alice@x.co'));

    const n = await userW.count();
    ok(`count returned (got ${n})`, typeof n === 'number' && n >= 1);

    const updated = await userW.update({
      where: { email: 'alice@x.co' } as any,
      data: { active: true, age: { increment: 1 } } as any,
    });
    ok('update applied $set + $inc', (updated as any)?.active === true && (updated as any)?.age === 31);

    // ─── 3. Unique violation → P2002 ───────────────────────────────
    console.log('\n[3] unique constraint error mapping');
    // Need a unique index first — Mongo applies it lazily. For the smoke,
    // create the index explicitly via the driver.
    await dbClient.db.collection('users').createIndex({ email: 1 }, { unique: true });
    try {
      await userW.create({ data: { email: 'alice@x.co' /* dup */ } as any });
      ok('unique violation should have thrown', false);
    } catch (e: any) {
      ok(`unique violation → DbKnownError P2002 (got ${e?.code})`,
         e instanceof DbKnownError && e.code === 'P2002');
    }

    // ─── 4. findUnique + findFirstOrThrow (P2025) ──────────────────
    console.log('\n[4] not-found error mapping');
    try {
      await userW.findFirstOrThrow({ where: { email: 'nobody@x.co' } as any });
      ok('findFirstOrThrow should have thrown', false);
    } catch (e: any) {
      ok(`not found → DbKnownError P2025 (got ${e?.code})`,
         e instanceof DbKnownError && e.code === 'P2025');
    }

    // ─── 5. delete then verify ─────────────────────────────────────
    console.log('\n[5] delete');
    const deleted = await userW.delete({ where: { email: 'alice@x.co' } as any });
    ok('delete returned the doc', (deleted as any)?.email === 'alice@x.co');
    const aliceGone = await userW.findFirst({ where: { email: 'alice@x.co' } as any });
    ok('user is gone', aliceGone === null);

    console.log(`\n[smoke] ${pass} passed, ${fail} failed`);
  } finally {
    // ─── Cleanup: drop the test db ─────────────────────────────────
    console.log('\n[cleanup] dropping database');
    try { await dbClient.db.dropDatabase(); } catch {}
    await adapter.close();
  }
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
