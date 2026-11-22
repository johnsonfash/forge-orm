/* eslint-disable no-console */
import * as dotenv from 'dotenv';
dotenv.config();

import { createDb } from '../factory';
import { generateMigration } from './migrate-gen';
import { loadConsumerSchema } from './load-consumer-schema';
import {
  ensureHistoryTable, listApplied, rawExec, recordMigration,
  renderMigrationFile, splitDialectFor, splitStatements, timestampSlug, writeMigrationFile,
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

  const { schema, source } = loadConsumerSchema();
  console.log(`[forge:diff:apply] schema: ${source}`);

  const db = (await createDb({ url, schema })) as any;
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

    const statements = splitStatements(ups.join(';\n'), splitDialectFor(db.adapter.kind));
    if (statements.length === 0) {
      // The mirror of the rollback case: recording a migration as applied when
      // nothing ran makes the ledger lie. It happens for real — a diff whose
      // only entries are the SQLite "cannot ALTER ADD FOREIGN KEY" comment
      // notes splits to zero executable statements.
      console.error(
        `[forge:diff:apply] '${name}' contains no executable SQL — ${pairs.length} ` +
        'change(s) were written to the migration file as comments only.\n' +
        '  NOT recording it as applied: the schema is unchanged, and marking it ' +
        'applied would hide that.\n' +
        '  Edit the generated file to add the real SQL, then re-run.',
      );
      process.exitCode = 1;
      return;
    }
    // Postgres DDL is transactional, so the statements and the ledger row go
    // in together: a failure part-way leaves neither. Elsewhere (MySQL
    // commits DDL implicitly) the statements run one by one as before.
    const run = async (q: any) => {
      for (const s of statements) {
        try { await rawExec(q, s); }
        catch (e: any) { console.error(`  ✗ failed: ${s}\n    ${e.message}`); throw e; }
      }
      await recordMigration(q, name);
    };
    if (db.adapter.kind === 'postgres') await db.$transaction(run);
    else await run(db);
    console.log(`[forge:diff:apply] applied ${statements.length} statement(s); recorded migration '${name}'.`);
  } finally {
    await db.$disconnect();
  }
}

main().catch((err) => { console.error('[forge:diff:apply]', err?.message ?? err); process.exit(1); });
