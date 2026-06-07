/* eslint-disable no-console */
import * as dotenv from 'dotenv';
dotenv.config();

import { createDb } from '../factory';
import { diffIntrospection, formatDriftReport, parseIgnoreList } from './diff-core';
import { loadConsumerSchema } from './load-consumer-schema';

// Read-only drift detection. Read-write sibling is forge:diff:apply.
// User-facing flag docs live on `forge --help` (./forge-cli.ts).

function readIgnoreFlag(): string | undefined {
  // Accept both `--ignore=foo,bar` and `--ignore foo,bar`.
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
  // CLI flag stacks on top of the env var so a fleet-wide ignore can
  // be extended for a single run without overwriting it.
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
