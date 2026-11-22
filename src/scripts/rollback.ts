/* eslint-disable no-console */
import * as dotenv from 'dotenv';
dotenv.config();

import { createDb } from '../factory';
import {
  ensureHistoryTable, listApplied, parseMigrationFile, planRollback, rawExec,
  readMigrationFile, removeMigration, splitDialectFor,
} from './migrate-runtime';

// forge:rollback — run the `down` block of the most-recently-applied migration
// and remove its row from _forge_migrations.

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) { console.error('[forge:rollback] DATABASE_URL is not set.'); process.exit(1); }

  const db = await createDb({ url });
  try {
    if (db.adapter.kind === 'mongo') {
      console.error('[forge:rollback] Mongo uses forge:push, not SQL migrations.');
      process.exit(1);
    }
    await ensureHistoryTable(db);
    const applied = await listApplied(db);
    if (applied.length === 0) { console.log('[forge:rollback] no migrations to roll back.'); return; }

    const latest = applied[applied.length - 1];
    const content = readMigrationFile(latest);
    if (!content) {
      console.error(`[forge:rollback] migration file for '${latest}' not found in migrations/ — cannot roll back.`);
      process.exit(1);
    }
    const { down } = parseMigrationFile(content);
    const { statements, refusal } = planRollback(latest, down, splitDialectFor(db.adapter.kind));
    if (refusal) {
      console.error(`[forge:rollback] ${refusal}`);
      process.exit(1);
    }
    console.log(`[forge:rollback] rolling back '${latest}' (${statements.length} statement(s))`);
    // One transaction on Postgres, as for the up: a down that fails part-way
    // must not leave the ledger row deleted with half the reversal applied.
    const run = async (q: any) => {
      for (const s of statements) {
        try { await rawExec(q, s); }
        catch (e: any) { console.error(`  ✗ failed: ${s}\n    ${e.message}`); throw e; }
      }
      await removeMigration(q, latest);
    };
    if (db.adapter.kind === 'postgres') await db.$transaction(run);
    else await run(db);
    console.log(`[forge:rollback] rolled back '${latest}'.`);
  } finally {
    await db.$disconnect();
  }
}

main().catch((err) => { console.error('[forge:rollback]', err?.message ?? err); process.exit(1); });
