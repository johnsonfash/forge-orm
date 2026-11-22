/* eslint-disable no-console */
import * as dotenv from 'dotenv';
dotenv.config();

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
  if (kind !== 'postgres') {
    console.error(
      `[forge:migrate] migration files run on postgres only; this URL is ${kind ?? 'unrecognised'}. ` +
        '`forge push` syncs the schema on every dialect.',
    );
    process.exit(1);
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
