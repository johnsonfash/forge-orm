#!/usr/bin/env node
/* eslint-disable no-console */
//
// `forge` — the consumer-facing CLI binary.
//
// Subcommands (Prisma-style spacing, not colons):
//   forge push           Sync the schema to the live DB (idempotent index/DDL push).
//   forge diff           Report drift between the live DB and the declared schema.
//   forge diff apply     Generate a reconciliation migration and apply it forward.
//   forge rollback       Roll back the most-recently applied migration.
//   forge doctor         Run adapter pre-flight checks (connectivity, perms, etc.).
//   forge --help
//
// The old `forge:push` / `forge:diff` / `forge:diff:apply` / `forge:rollback` npm
// scripts continue to work for the forge monorepo itself; this binary is what
// consumers actually call via `npx forge push` after installing forge-orm.
//

import * as path from 'node:path';

function help() {
  console.log(`
forge — schema sync for MongoDB, PostgreSQL, MySQL & SQLite.

Usage:
  forge push                  Idempotently sync your schema to the live DB
  forge diff                  Show drift between the live DB and your schema
  forge diff --json           Same, machine-readable
  forge diff --check          Exit non-zero (3) if drift is found (for CI)
  forge diff --ignore=<list>  Skip noisy tables (exact names or /regex/ — env
                              var FORGE_DIFF_IGNORE works the same way)
  forge diff apply            Generate + run a reconciliation migration
  forge rollback              Roll back the most-recent applied migration
  forge doctor                Pre-flight adapter checks

Schema is resolved (first hit wins):
  --schema=<path>             explicit
  FORGE_SCHEMA_PATH=<path>    env var
  conventions, from cwd:
    src/schema.ts, src/schema.js
    schema.ts, schema.js
    src/core/database/schema.ts
    src/db/schema.ts
    src/database/schema.ts

Database is read from DATABASE_URL (in your .env or environment).
`);
}

async function main() {
  // Drop the node binary + script path off argv so subcommand parsing is clean.
  const args = process.argv.slice(2);
  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    help();
    process.exit(args.length === 0 ? 1 : 0);
  }

  const cmd = args[0];
  // Trim the subcommand from the remaining args so each underlying script sees
  // a clean argv (its own flags only).
  process.argv = [process.argv[0], process.argv[1], ...args.slice(1)];

  switch (cmd) {
    case 'push':
      await import('./push');
      return;
    case 'diff': {
      // `forge diff apply` is the second-word combo. Re-route.
      if (args[1] === 'apply') {
        // Pop the 'apply' word from argv so diff-apply parses cleanly.
        process.argv = [process.argv[0], process.argv[1], ...args.slice(2)];
        await import('./diff-apply');
        return;
      }
      await import('./diff');
      return;
    }
    case 'rollback':
      await import('./rollback');
      return;
    case 'doctor':
      await import('./doctor');
      return;
    default:
      console.error(`[forge] unknown command: ${cmd}`);
      help();
      process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
