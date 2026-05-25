/* eslint-disable no-console */
import * as dotenv from 'dotenv';
dotenv.config();

import { createDb } from '../factory';
import { schema } from '../schema';
import { generateMigration } from './migrate-gen';
import {
  ensureHistoryTable, listApplied, rawExec, recordMigration,
  renderMigrationFile, splitStatements, timestampSlug, writeMigrationFile,
} from './migrate-runtime';

// forge:diff:apply — generate a reconciliation migration from live drift and
// apply it forward (bring the DB up to the schema). Records the migration in
// _forge_migrations and writes a timestamped up/down file to migrations/.
//
//   --dry   print the SQL without applying or writing the file
//
// SQL dialects only (Mongo manages indexes via forge:push).

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) { console.error('[forge:diff:apply] DATABASE_URL is not set.'); process.exit(1); }
  const dry = process.argv.includes('--dry');

  const db = await createDb({ url });
  try {
    if (db.adapter.kind === 'mongo') {
      console.error('[forge:diff:apply] Mongo uses forge:push for index management, not SQL migrations.');
      process.exit(1);
    }
    const actual = await db.adapter.introspect!();
    const pairs = generateMigration(schema as any, actual);
    if (pairs.length === 0) {
      console.log('[forge:diff:apply] already in sync — nothing to apply.');
      return;
    }

    const ups = pairs.map((p) => p.up);
    const downs = pairs.map((p) => p.down).reverse();   // reverse for correct rollback order
    const name = timestampSlug('drift');
    const content = renderMigrationFile(name, ups, downs);

    console.log(`[forge:diff:apply] ${pairs.length} change(s):`);
    for (const p of pairs) console.log(`  • ${p.note}`);

    if (dry) { console.log('\n--- migration (dry run) ---\n' + content); return; }

    writeMigrationFile(name, content);
    await ensureHistoryTable(db);
    if ((await listApplied(db)).includes(name)) { console.log('[forge:diff:apply] already applied.'); return; }

    const statements = splitStatements(ups.join(';\n'));
    let applied = 0;
    for (const s of statements) {
      try { await rawExec(db, s); applied++; }
      catch (e: any) { console.error(`  ✗ failed: ${s}\n    ${e.message}`); throw e; }
    }
    await recordMigration(db, name);
    console.log(`[forge:diff:apply] applied ${applied} statement(s); recorded migration '${name}'.`);
  } finally {
    await db.$disconnect();
  }
}

main().catch((err) => { console.error('[forge:diff:apply]', err?.message ?? err); process.exit(1); });
