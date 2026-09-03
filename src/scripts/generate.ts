/* eslint-disable no-console */
import * as dotenv from 'dotenv';
dotenv.config();

import fs from 'node:fs';
import path from 'node:path';
import type { AdapterKind } from '../adapters/types';
import { generateMigration } from './migrate-gen';
import { loadConsumerSchema } from './load-consumer-schema';
import { MIGRATIONS_DIR, renderMigrationFile } from './migrate-runtime';
import {
  latestSnapshot,
  projectSchema,
  writeJournal,
  writeSnapshot,
  type JournalEntry,
} from './snapshot';

// forge generate — write a migration WITHOUT touching a database.
//
//   npx forge generate                    # diff against the last snapshot
//   npx forge generate --name add-orgs    # label the file
//   npx forge generate --dialect postgres # when DATABASE_URL is absent
//   npx forge generate --check            # CI: fail if a migration is missing
//   npx forge generate --custom           # empty up/down for a data migration
//   npx forge generate --allow-drop       # yes, that column really is going
//
// The difference from `forge diff apply` is where the "before" comes
// from. `diff apply` introspects the live database, which is right when
// adopting an existing one and wrong for everything else: it needs a
// database to run at all, so CI cannot verify that a schema change ships
// with its migration, and two developers on two branches each generate
// against their own local state.
//
// `generate` diffs against the last committed snapshot, so the same
// schema always produces the same SQL, and the artifact is reviewable in
// the pull request that changes the schema.

function flagValue(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1] && !process.argv[i + 1]!.startsWith('--')) {
    return process.argv[i + 1];
  }
  const inline = process.argv.find((a) => a.startsWith(`--${name}=`));
  return inline?.split('=').slice(1).join('=');
}

/** The dialect to generate for. Explicit flag wins; otherwise read it off
 *  DATABASE_URL WITHOUT connecting — the scheme is enough. */
function resolveDialect(): AdapterKind {
  const explicit = flagValue('dialect');
  if (explicit) return explicit as AdapterKind;
  const url = process.env.DATABASE_URL ?? '';
  if (/^postgres(ql)?:/.test(url)) return 'postgres';
  if (/^mysql:/.test(url)) return 'mysql';
  if (/^(sqlite|file):/.test(url)) return 'sqlite';
  if (/^mongodb(\+srv)?:/.test(url)) return 'mongo';
  throw new Error(
    '[forge:generate] cannot tell which dialect to generate for. Pass ' +
      '--dialect=postgres|mysql|sqlite, or set DATABASE_URL (it is only read ' +
      'for its scheme — nothing connects).',
  );
}

async function main(): Promise<void> {
  const kind = resolveDialect();
  if (kind === 'mongo') {
    console.error(
      '[forge:generate] Mongo has no DDL migrations — indexes are reconciled by ' +
        '`forge push`, which is idempotent and needs no history.',
    );
    process.exit(1);
  }

  const { schema, source } = loadConsumerSchema();
  console.log(`[forge:generate] schema: ${source}  dialect: ${kind}`);

  const { snapshot, nextIdx, journal } = latestSnapshot(MIGRATIONS_DIR, kind);
  const custom = process.argv.includes('--custom');
  const check = process.argv.includes('--check');
  const label = flagValue('name') ?? (custom ? 'custom' : 'schema');

  // The snapshot IS a DbIntrospection, so the existing differ takes it
  // with no idea it did not come from a database.
  // `--allow-drop` confirms that a column disappearing really is a
  // deletion and not a rename forge failed to recognise.
  const allowDrop = process.argv.includes('--allow-drop');
  const pairs = custom
    ? []
    : generateMigration(schema as Record<string, unknown>, snapshot, { allowDrop });

  // A refused change stops the whole run. Writing the file without it
  // would produce a migration that applies cleanly and leaves the schema
  // and the database disagreeing — which is the failure this stage
  // exists to remove, not a smaller version of it.
  const blocked = pairs.filter((p) => p.unsafe);
  if (blocked.length > 0) {
    console.error(
      `\n[forge:generate] refusing to generate ${blocked.length} change(s). ` +
        `Each needs a decision forge cannot make for you.\n`,
    );
    for (const b of blocked) {
      console.error(`  ✖ ${b.note}`);
      console.error(`    ${b.unsafe!.reason}`);
      console.error(`    → ${b.unsafe!.guidance}\n`);
    }
    const safe = pairs.length - blocked.length;
    if (safe > 0) {
      console.error(
        `  ${safe} other change(s) in this diff are safe and were NOT written — ` +
          `fix or revert the above, then run again.\n`,
      );
    }
    process.exit(2);
  }

  if (!custom && pairs.length === 0) {
    console.log('[forge:generate] schema matches the last snapshot — nothing to generate.');
    return;
  }

  if (check) {
    // CI gate: a schema change that arrives without its migration is the
    // thing this catches. Exit 3, matching `forge diff --check`.
    console.error(
      `[forge:generate] ${pairs.length} change(s) are in the schema but not in ` +
        `any migration. Run \`npx forge generate --name <what-changed>\` and ` +
        `commit both the .sql and its snapshot.`,
    );
    for (const p of pairs) console.error(`  - ${p.note}`);
    process.exit(3);
  }

  const file = `${nextIdx}_${label.replace(/[^a-z0-9_-]+/gi, '-').toLowerCase()}.sql`;
  const content = custom
    ? renderMigrationFile(file, ['-- write your UP statements here'], ['-- and the reverse here'])
    : renderMigrationFile(
        file,
        pairs.map((p) => p.up),
        // Reversed: rollback undoes in the opposite order to apply.
        pairs.map((p) => p.down).reverse(),
      );

  fs.mkdirSync(MIGRATIONS_DIR, { recursive: true });
  fs.writeFileSync(path.join(MIGRATIONS_DIR, file), content, 'utf8');

  // The snapshot records the state AFTER this migration. For a custom
  // migration that is the same state as before — forge cannot know what
  // hand-written SQL does, and guessing would corrupt every later diff.
  writeSnapshot(MIGRATIONS_DIR, nextIdx, custom ? snapshot : projectSchema(schema as Record<string, unknown>, kind));

  const entry: JournalEntry = {
    idx: nextIdx,
    file,
    createdAt: new Date().toISOString(),
    ...(label ? { label } : {}),
  };
  writeJournal(MIGRATIONS_DIR, { ...journal, dialect: kind, entries: [...journal.entries, entry] });

  console.log(`[forge:generate] wrote migrations/${file}`);
  console.log(`[forge:generate] wrote migrations/meta/${nextIdx}_snapshot.json`);
  if (custom) {
    console.log('[forge:generate] empty migration — fill in the SQL, then `forge migrate`.');
  } else {
    for (const p of pairs) console.log(`  - ${p.note}`);
  }
  console.log('[forge:generate] review both files, commit them together.');
}

main().catch((err) => {
  console.error('[forge:generate]', err?.message ?? err);
  process.exit(1);
});
