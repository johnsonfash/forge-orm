/* eslint-disable no-console */
import { loadEnv } from './load-env';
loadEnv();

import * as path from 'node:path';
import { createDb } from '../factory';
import { detectAdapterKind } from '../adapters/detect';
import { MIGRATIONS_DIR } from './migrate-runtime';

// forge migrate — apply the pending .sql files in migrations/, in order.
//
//   npx forge migrate
//   npx forge migrate --dry-run
//   npx forge migrate --dir=db/migrations
//
// The URL is MIGRATION_DATABASE_URL when set, else DATABASE_URL. The
// separate name exists because an app that reaches Postgres through a
// transaction-mode pooler (PgBouncer) wants migrations on a direct
// connection: a forge:no-transaction file holds a session advisory lock,
// and a pooler hands each statement to whichever server connection is free.
//
// Postgres, SQLite, SQL Server and DuckDB run each file in one transaction
// with its ledger row. MySQL cannot (DDL commits implicitly), so there a
// file runs statement by statement. MongoDB has no SQL and is refused.

function flag(name: string): string | undefined {
  const inline = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (inline) return inline.slice(name.length + 3);
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] && !process.argv[i + 1]!.startsWith('--')
    ? process.argv[i + 1]
    : undefined;
}

async function main(): Promise<void> {
  const url = flag('url') ?? process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!url) {
    console.error('[forge:migrate] set MIGRATION_DATABASE_URL or DATABASE_URL (or pass --url).');
    process.exit(1);
  }
  const kind = detectAdapterKind(url);
  if (kind === 'mongo') {
    console.error(
      '[forge:migrate] MongoDB has no SQL migration files. `forge push` (or db.$migrate() ' +
        'at boot) creates and rebuilds its indexes from the schema.',
    );
    process.exit(1);
  }
  if (!kind) {
    console.error(`[forge:migrate] cannot tell which database this URL is for: ${url.replace(/\/\/[^@]*@/, '//***@')}`);
    process.exit(1);
  }
  if (kind === 'mysql' && !process.argv.includes('--dry-run')) {
    console.log(
      '[forge:migrate] MySQL commits DDL as it runs: each file is applied statement by ' +
        'statement and is NOT all-or-nothing. Write files that are safe to re-run.',
    );
  }
  const dir = flag('dir') ? path.resolve(flag('dir')!) : MIGRATIONS_DIR;
  const db = await createDb({ url });
  try {
    const report = await db.$migrateFiles({
      dir,
      dryRun: process.argv.includes('--dry-run'),
      allowOutOfOrder: process.argv.includes('--allow-out-of-order'),
      allowUnknown: process.argv.includes('--allow-unknown'),
      logger: (line) => console.log(`[forge:migrate] ${line}`),
    });
    if (report.applied.length) {
      console.log(`[forge:migrate] ${report.applied.length} applied, ${report.skipped.length} already in place`);
    }
  } finally {
    await db.$disconnect();
  }
}

main().catch((err) => {
  console.error(err?.message ?? err);
  process.exit(1);
});
