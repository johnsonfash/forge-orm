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
  forge generate              Write a migration from the last snapshot (no DB)
  forge migrate status        What has run, what has not, what should not have
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

/** What each subcommand does, for `forge <cmd> --help`. */
const SUBCOMMAND_HELP: Record<string, string> = {
  migrate: `forge migrate status — what the database has actually applied.

  Four states, two of which no other tool reports:
    applied        in the ledger and in this checkout
    pending        a file here that has not run
    OUT OF ORDER   pending, but numbered BEHIND one already applied — a
                   migrator walking forward skips these silently
    NOT IN THIS    the database applied a migration this checkout does
    CHECKOUT       not have; somebody ran a branch against it

    --check        exit 4 when anything needs attention (for CI)

  Needs DATABASE_URL: it is the only command that can say what a
  database has really applied.`,
  generate: `forge generate — write a migration WITHOUT a database.

  Diffs the schema against the last committed snapshot in
  migrations/meta/ and writes a numbered .sql plus a new snapshot. The
  same schema always produces the same SQL, so the migration is
  reviewable in the pull request that changes the schema.
    --name <label>      name the file
    --dialect <kind>    postgres | mysql | sqlite (else read from
                        DATABASE_URL's scheme — nothing connects)
    --check             exit 3 if the schema has changes with no
                        migration (for CI)
    --custom            empty up/down, for a data migration
    --allow-drop        confirm a disappearing column is a deletion, not
                        a rename forge failed to recognise

  Use \`forge diff apply\` instead when ADOPTING an existing database:
  that one introspects what is really there.`,
  push: `forge push — idempotently sync the schema to the live database.

  Creates and rebuilds INDEXES to match the schema. It does not create,
  drop or alter tables/collections, and it never touches rows.
  Reads DATABASE_URL.`,
  diff: `forge diff — report drift between the live database and the schema.

  Read-only. Nothing is written.
    --json            machine-readable
    --check           exit 3 when drift is found (for CI)
    --ignore=<list>   skip tables (exact names or /regex/); FORGE_DIFF_IGNORE too
    apply             generate + run a reconciliation migration (WRITES)`,
  rollback: `forge rollback — roll back the most recently applied migration.`,
  doctor: `forge doctor — pre-flight adapter checks and schema linting.

  Read-only.`,
};

async function main() {
  const args = process.argv.slice(2);
  const wantsHelp = args.some((a) => a === '--help' || a === '-h');

  if (args.length === 0 || (wantsHelp && args.length === 1)) {
    help();
    process.exit(args.length === 0 ? 1 : 0);
  }

  // `forge push --help` used to RUN THE PUSH: only args[0] was checked, so
  // the flag fell through to the subcommand, which ignored it. Asking a
  // schema tool what a command does should never be the way you find out.
  if (wantsHelp) {
    const sub = args.find((a) => !a.startsWith('-'));
    const text = sub ? SUBCOMMAND_HELP[sub] : undefined;
    if (text) {
      console.log(`\n${text}\n`);
      process.exit(0);
    }
    help();
    process.exit(sub ? 1 : 0);
  }

  const cmd = args[0];
  // Underlying scripts see only their own flags — strip the subcommand.
  process.argv = [process.argv[0], process.argv[1], ...args.slice(1)];

  switch (cmd) {
    case 'push':
      await import('./push');
      return;
    case 'generate':
      await import('./generate');
      return;
    case 'migrate': {
      if (args[1] === 'status') {
        process.argv = [process.argv[0], process.argv[1], ...args.slice(2)];
        await import('./status');
        return;
      }
      console.error(`[forge] usage: forge migrate status`);
      process.exit(1);
      return;
    }
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
      // doctor only self-runs when executed directly; the CLI imports it,
      // so ask for the run explicitly.
      process.env.FORGE_DOCTOR_RUN = '1';
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
