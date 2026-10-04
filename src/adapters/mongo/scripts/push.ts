/* eslint-disable no-console */
import * as dotenv from 'dotenv';
dotenv.config();

import { getDefaultClient } from '../client';
import { applyIndexes } from '../apply-indexes';

// `forge push` on Mongo. The engine lives in adapters/mongo/apply-indexes.ts —
// this module is the CLI face: it owns the process default client, renders the
// report to the console, and re-exports the engine so the import paths this
// file has always offered keep resolving.
export * from '../apply-indexes';

/**
 * Push every index declared on the supplied schema to MongoDB, rendering the
 * result to the console. The CLI face of {@link applyIndexes}; an application
 * wants `db.$migrate()` or `applyIndexes` instead, both of which run against
 * the connection the app already holds.
 *
 * @param consumerSchema - The consumer's schema map (`{ Users, Posts, ... }`).
 *                        When omitted, falls back to forge's bundled sample
 *                        schema — exists for forge's internal test/dev runs;
 *                        consumers should always pass their own schema.
 */
export async function pushAllIndexes(
  consumerSchema?: any,
  opts: { dryRun?: boolean; prune?: boolean } = {},
): Promise<void> {
  // A CLI run has no adapter, so it owns the process default outright.
  const client = getDefaultClient();
  await client.connect();

  const report = await applyIndexes(client.db, {
    schema: consumerSchema,
    dryRun: opts.dryRun,
    prune: opts.prune,
    // The CLI has always sent warnings to stderr and progress to stdout. One
    // logger carries both, so route on the marker rather than take a second
    // hook that only the CLI would ever pass.
    logger: (line) => (line.includes('⚠') ? console.warn(line) : console.log(line)),
  });

  // The non-dry-run line is kept byte-identical to the one push has always
  // printed — people grep it.
  const warned = report.failures.length;
  console.log(
    (opts.dryRun
      ? `\n🔍 dry run — nothing was written: would create ${report.created.length}, ` +
        `would rebuild ${report.rebuilt.length}, would skip ${report.skipped.length}` +
        (report.dropped.length ? `, would drop ${report.dropped.length}` : '')
      : `\n✅ done — created ${report.created.length}, rebuilt ${report.rebuilt.length}, ` +
        `skipped ${report.skipped.length}` +
        (report.dropped.length ? `, dropped ${report.dropped.length}` : '')) +
      (warned ? `, ${warned} warning${warned === 1 ? '' : 's'}` : '') +
      '\n',
  );

  // Say what is there that the schema does not describe. Without prune this
  // is the only place it surfaces, and it is the question people actually
  // have after a push ("is anything left over from the last shape?").
  if (!opts.prune && report.extra.length > 0) {
    console.log(
      `ℹ ${report.extra.length} index${report.extra.length === 1 ? '' : 'es'} ` +
      `in the database are not declared in the schema:`,
    );
    for (const e of report.extra) console.log(`   · ${e.collection}.${e.name}`);
    console.log(`  Run 'forge push --prune' to drop them.\n`);
  }
}

if (require.main === module) {
  // Stand-alone invocation: load the consumer's schema first.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { loadConsumerSchema } = require('../../../scripts/load-consumer-schema');
  const { schema, source } = loadConsumerSchema();
  console.log(`[forge:push] mongo — schema: ${source}`);
  pushAllIndexes(schema, {
    dryRun: process.argv.includes('--dry-run'),
    prune: process.argv.includes('--prune'),
  })
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('\n❌ push failed:', err);
      process.exit(1);
    });
}
