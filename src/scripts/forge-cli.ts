#!/usr/bin/env node
/* eslint-disable no-console */
// `forge` — consumer-facing CLI. Subcommand list lives in help() below.
// Internal `forge:*` npm scripts (forge:push etc.) point at the same
// underlying entry points so the monorepo's own dev/test paths still work.

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
  forge doctor                Pre-flight adapter checks + schema linting

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

What's in the schema:
  Indexes: keys / unique / sparse / name / expireAfterSeconds, plus
    where (SQL string on PG/SQLite, object on Mongo — alias of
    partialFilterExpression), expression (SQL expression index),
    include (PG covering columns), method ('gin'/'gist'/'brin'/'hash'
    on PG, 'spatial'/'fulltext' on MySQL), collation +
    wildcardProjection (Mongo), parser ('ngram'/'mecab' for MySQL
    FULLTEXT), visible (MySQL 8 INVISIBLE), expireAfterSeconds (TTL),
    plus Mongo IndexKey '2dsphere' / '2d' / 'hashed'.
  Soft delete: f.dateTime().softDeleteAt() — adds .softDelete() /
    .softDeleteMany() / .restore() / .restoreMany() to the model.
    delete() / deleteMany() are always hard deletes since 2.0.
  Compile: db.<model>.compile.<op>() returns the artifact instead of
    executing. Dispatches by adapter; use .compileMongo / .compileSql
    for a narrowed surface.

Full docs: https://github.com/johnsonfash/forge-orm#readme
`);
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    help();
    process.exit(args.length === 0 ? 1 : 0);
  }

  const cmd = args[0];
  // Underlying scripts see only their own flags — strip the subcommand.
  process.argv = [process.argv[0], process.argv[1], ...args.slice(1)];

  switch (cmd) {
    case 'push':
      await import('./push');
      return;
    case 'diff': {
      if (args[1] === 'apply') {
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
