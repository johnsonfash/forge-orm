/* eslint-disable no-console */
import * as dotenv from 'dotenv';
dotenv.config();

import { createDb } from '../factory';
import { schema } from '../schema';
import { diffIntrospection, formatDriftReport } from './diff-core';

// forge:diff — drift detection. Introspects the live database (chosen from
// DATABASE_URL) and compares it to the declared forge schema, reporting
// structural drift across all four dialects.
//
// Flags:
//   --json     machine-readable output (for CI / tooling)
//   --check    exit non-zero (3) when drift is found (default: informational, exit 0)
//
// Catches the "someone ALTER'd the DB outside forge" class of bug, and is the
// read-only sibling of forge:diff:apply (Wave 5c), which reconciles the drift.

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('[forge:diff] DATABASE_URL is not set. Point it at the DB you want to inspect.');
    process.exit(1);
  }
  const asJson = process.argv.includes('--json');
  const gate = process.argv.includes('--check');

  const db = await createDb({ url });
  try {
    if (typeof db.adapter.introspect !== 'function') {
      console.error(`[forge:diff] adapter '${db.adapter.kind}' does not support introspection.`);
      process.exit(1);
    }
    const actual = await db.adapter.introspect();
    const report = diffIntrospection(schema as any, actual);

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
