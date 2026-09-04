/* eslint-disable no-console */
import * as dotenv from 'dotenv';
dotenv.config();

import { createDb } from '../factory';
import { loadConsumerSchema } from './load-consumer-schema';
import {
  MIGRATIONS_DIR,
  ensureHistoryTable,
  listAppliedWithDates,
} from './migrate-runtime';
import { buildStatus, formatStatus, listLocalMigrations } from './migrate-status';

// forge migrate status — what has run, what has not, and the two states
// nobody reports.
//
//   npx forge migrate status
//   npx forge migrate status --check    # CI: exit 4 if anything is wrong
//
// This one DOES need a database. It is the only command that can say
// what a database has actually applied, and that is the whole point of
// it: `generate` and `diff --check` compare intent, this compares
// reality.

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error(
      '[forge:status] DATABASE_URL is not set. This is the one command that ' +
        'has to ask a database what it has applied — `forge generate` is the ' +
        'offline one.',
    );
    process.exit(1);
  }
  const check = process.argv.includes('--check');

  const { schema } = loadConsumerSchema();
  const db = (await createDb({ url, schema })) as never as Parameters<typeof ensureHistoryTable>[0];

  try {
    await ensureHistoryTable(db);
    const applied = await listAppliedWithDates(db);
    const local = listLocalMigrations(MIGRATIONS_DIR);
    const report = buildStatus(local, applied, MIGRATIONS_DIR);

    console.log('');
    console.log(formatStatus(report, MIGRATIONS_DIR));
    console.log('');

    if (check && !report.clean) {
      // Distinct from generate's 2 and 3 so a pipeline can tell which
      // gate refused it.
      process.exit(4);
    }
    if (check && report.pending > 0) {
      console.error('[forge:status] there are unapplied migrations.');
      process.exit(4);
    }
  } finally {
    await (db as unknown as { $disconnect(): Promise<void> }).$disconnect();
  }
}

main().catch((err) => {
  console.error('[forge:status]', err?.message ?? err);
  process.exit(1);
});
