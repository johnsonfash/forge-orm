// Rename detection — the last silent-data-loss case in the generator.
//
// A generator comparing two schema states sees only that one column name
// is gone and another has appeared. It cannot tell a RENAME from a DROP
// plus an ADD, and the two produce opposite outcomes on the same data:
// one keeps every row, the other deletes a column's worth of it.
//
// Guessing "drop and add" loses data silently on a column somebody meant
// to keep. Guessing "rename" is worse: it keeps a column somebody meant
// to delete, and quietly moves its data under a new name.
//
// So forge does not guess. It takes the answer from the schema:
//
//     name: f.string().renamedFrom('full_name'),
//
// …and where a change LOOKS like a rename and carries no annotation, it
// refuses and says which two columns it is unsure about.
//
// Drizzle asks the same question with an interactive prompt. That is the
// right shape and the wrong medium: a prompt answered once at 2am is
// recorded nowhere, cannot run in CI, and the answer is invisible in
// review. An annotation is in the schema, in the diff, and in the pull
// request — which is where a decision about somebody's data belongs.
//
// It also fixes drizzle's known bug in this area: renaming a column AND
// changing its type in one step emits only the rename
// (drizzle-team/drizzle-orm#5499, #3826). Here the rename runs first and
// the type change goes through the ordinary ALTER path afterwards, so
// either both statements appear or the whole run is refused.

import type { Dialect } from '../adapters/postgres/dialect';
import type { IntrospectedColumn } from '../adapters/types';
import type { FieldDef } from '../schema/types';
import { dbTypeCategory } from './diff-core';

export interface RenamePlan {
  /** Renames to emit, in order, before any other column work. */
  renames: { from: string; to: string; up: string; down: string; note: string }[];
  /** Columns that were going to be dropped but are a rename's source —
   *  the DROP pass must skip them. */
  consumed: Set<string>;
  /** Ambiguous drop+add pairs. Any entry refuses the whole run. */
  unsafe: { note: string; reason: string; guidance: string }[];
}

function renameSql(d: Dialect, table: string, from: string, to: string): string | null {
  const q = d.quoteIdent(table);
  // Every dialect forge emits SQL for supports the same form. MySQL 8.0+
  // does too — the older CHANGE COLUMN syntax needed the full column
  // definition repeated, which is how a rename silently dropped a
  // constraint somebody had added by hand.
  if (d.name === 'postgres' || d.name === 'mysql' || d.name === 'sqlite') {
    return `ALTER TABLE ${q} RENAME COLUMN ${d.quoteIdent(from)} TO ${d.quoteIdent(to)}`;
  }
  return null;
}

/**
 * Work out which of this table's dropped/added columns are renames.
 *
 * `declared` is the schema's fields; `actual` is the columns as the
 * database (or the last snapshot) has them.
 */
export function planRenames(
  d: Dialect,
  table: string,
  declared: Record<string, FieldDef>,
  actual: IntrospectedColumn[],
  opts: { allowDrop?: boolean } = {},
): RenamePlan {
  const plan: RenamePlan = { renames: [], consumed: new Set(), unsafe: [] };

  const actualByName = new Map(actual.map((c) => [c.name, c]));
  const declaredNames = new Set(Object.keys(declared));
  const dropped = actual.filter((c) => !declaredNames.has(c.name));
  const added = Object.entries(declared).filter(
    ([n, f]) => !actualByName.has(n) && f.kind !== 'id' && !f.dbGenerated,
  );

  // ── 1. explicit annotations ───────────────────────────────────────
  for (const [name, f] of added) {
    const from = f.renamedFrom;
    if (!from) continue;
    if (!actualByName.has(from)) {
      // Either the rename already shipped, or the annotation names a
      // column that never existed. Saying so beats a confusing no-op.
      plan.unsafe.push({
        note: `${table}.${name} renamedFrom('${from}')`,
        reason:
          `${table}.${name} declares renamedFrom('${from}'), but there is no ` +
          `column called '${from}' in the previous state.`,
        guidance:
          `If the rename has already shipped, delete the renamedFrom — it has ` +
          `done its job. If it is a typo, correct it to the column's real ` +
          `previous name.`,
      });
      continue;
    }
    const up = renameSql(d, table, from, name);
    if (!up) {
      plan.unsafe.push({
        note: `${table}.${from} → ${name}`,
        reason: `${d.name} has no RENAME COLUMN that forge can emit.`,
        guidance: `Write the rename by hand with \`forge generate --custom\`.`,
      });
      continue;
    }
    plan.renames.push({
      from,
      to: name,
      up,
      down: renameSql(d, table, name, from)!,
      note: `rename ${table}.${from} → ${name}`,
    });
    plan.consumed.add(from);
  }

  // ── 2. the ambiguous rest ─────────────────────────────────────────
  // A drop and an add of the SAME TYPE on the same table is the shape of
  // a rename. It might genuinely be both — so this asks rather than
  // deciding, and `--allow-drop` is how you say it really is both.
  if (opts.allowDrop) return plan;

  const stillDropped = dropped.filter((c) => !plan.consumed.has(c.name));
  const stillAdded = added.filter(([, f]) => !f.renamedFrom);
  if (stillDropped.length === 0 || stillAdded.length === 0) return plan;

  for (const gone of stillDropped) {
    const goneCat = dbTypeCategory(gone.type ?? '');
    const candidates = stillAdded
      .filter(([, f]) => {
        // Mongo reports no types, so every pair is a candidate there —
        // which is the honest answer, not a reason to skip the check.
        if (!goneCat) return true;
        const t = d.columnType(f).toLowerCase();
        return dbTypeCategory(t) === goneCat;
      })
      .map(([n]) => n);
    if (candidates.length === 0) continue;

    plan.unsafe.push({
      note: `${table}.${gone.name} dropped, ${candidates.join(' / ')} added`,
      reason:
        `${table}.${gone.name} is gone and ${candidates.length === 1 ? 'a new column of the same type has appeared' : 'new columns of the same type have appeared'} ` +
        `(${candidates.join(', ')}). forge cannot tell a rename from a drop and an add, ` +
        `and the two do opposite things to the data in that column.`,
      guidance:
        `If it is a rename, say so in the schema: ` +
        `\`${candidates[0]}: f.…().renamedFrom('${gone.name}')\` — the migration ` +
        `becomes a RENAME COLUMN and every row survives. ` +
        `If ${gone.name} really is being deleted, re-run with --allow-drop to confirm ` +
        `you mean to lose it.`,
    });
  }

  return plan;
}
