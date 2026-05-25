/* eslint-disable no-console */
import * as dotenv from 'dotenv';
dotenv.config();

import { createDb } from '../factory';
import {
  ensureHistoryTable, listApplied, parseMigrationFile, rawExec,
  readMigrationFile, removeMigration, splitStatements,
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
    const statements = splitStatements(down);
    console.log(`[forge:rollback] rolling back '${latest}' (${statements.length} statement(s))`);
    for (const s of statements) {
      try { await rawExec(db, s); }
      catch (e: any) { console.error(`  ✗ failed: ${s}\n    ${e.message}`); throw e; }
    }
    await removeMigration(db, latest);
    console.log(`[forge:rollback] rolled back '${latest}'.`);
  } finally {
    await db.$disconnect();
  }
}

main().catch((err) => { console.error('[forge:rollback]', err?.message ?? err); process.exit(1); });
