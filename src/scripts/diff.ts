/* eslint-disable no-console */
import * as dotenv from 'dotenv';
dotenv.config();

import { createDb } from '../factory';
import { diffIntrospection, formatDriftReport, parseIgnoreList } from './diff-core';
import { loadConsumerSchema } from './load-consumer-schema';

// forge:diff — drift detection. Introspects the live database (chosen from
// DATABASE_URL) and compares it to the declared forge schema, reporting
// structural drift across all four dialects.
//
// Flags:
//   --json                  machine-readable output (for CI / tooling)
//   --check                 exit non-zero (3) when drift is found (default: informational, exit 0)
//   --ignore=<list>         comma-separated tables/collections to skip — exact
//                           names or regex like `/^_atlas_/i`. Stacks with the
//                           `FORGE_DIFF_IGNORE` env var.
//
// Catches the "someone ALTER'd the DB outside forge" class of bug, and is the
// read-only sibling of forge:diff:apply (Wave 5c), which reconciles the drift.

function readIgnoreFlag(): string | undefined {
  // Accept both `--ignore=foo,bar` and `--ignore foo,bar` shapes so flag
  // parsing matches the rest of the CLI surface.
  for (let i = 0; i < process.argv.length; i++) {
    const a = process.argv[i];
    if (a.startsWith('--ignore=')) return a.slice('--ignore='.length);
    if (a === '--ignore') return process.argv[i + 1];
  }
  return undefined;
}

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('[forge:diff] DATABASE_URL is not set. Point it at the DB you want to inspect.');
    process.exit(1);
  }
  const asJson = process.argv.includes('--json');
  const gate = process.argv.includes('--check');
  // Merge CLI flag + env var. CLI wins precedence-wise but both contribute
  // — env covers the CI-fleet case ("ignore Atlas metadata everywhere"),
  // flag covers ad-hoc local runs.
  const ignore = [
    ...parseIgnoreList(readIgnoreFlag()),
    ...parseIgnoreList(process.env.FORGE_DIFF_IGNORE),
  ];

  const { schema, source } = loadConsumerSchema();
  if (!asJson) console.log(`[forge:diff] schema: ${source}`);

  const db = (await createDb({ url, schema })) as any;
  try {
    if (typeof db.adapter.introspect !== 'function') {
      console.error(`[forge:diff] adapter '${db.adapter.kind}' does not support introspection.`);
      process.exit(1);
    }
    const actual = await db.adapter.introspect();
    const report = diffIntrospection(schema as any, actual, ignore);

    if (asJson) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log(formatDriftReport(report));
    }
    if (!report.inSync && gate) process.exit(3);
  } finally {
    await db.$disconnect();
  }
}

main().catch((err) => {
  console.error('[forge:diff]', err?.message ?? err);
  process.exit(1);
});
