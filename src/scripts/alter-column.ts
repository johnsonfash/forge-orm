// ALTER COLUMN — type and nullability changes, or a refusal that says why.
//
// `migrate-gen` handled ADD, DROP, tables, foreign keys and indexes, but
// not a column whose TYPE or NULLABILITY changed. Such a change was
// silently absent from the generated migration: the schema said
// `varchar(255)`, the database kept `varchar(64)`, the migration applied
// cleanly, and nothing said a word.
//
// Silently omitting a change is the worst of the three options. This
// module picks one of the other two:
//
//   * WIDENING is emitted. varchar(64) → varchar(255), int → bigint,
//     numeric(10,2) → numeric(12,2), NOT NULL → NULL. Every existing row
//     still fits, so the statement cannot fail on data.
//
//   * ANYTHING ELSE IS REFUSED, with the two-step migration printed. A
//     narrowing, a change of category, or NULL → NOT NULL are not things
//     a generator should guess at: they fail on live data, or they lose
//     it. The author knows what the data looks like; the differ does not.
//
// The refusal is the feature. A tool that emits `ALTER COLUMN … TYPE int`
// against a column holding text is more dangerous than one that emits
// nothing, because the migration looks reviewed.

import type { Dialect } from '../adapters/postgres/dialect';
import type { IntrospectedColumn } from '../adapters/types';
import type { FieldDef } from '../schema/types';
import { dbTypeCategory, fieldCategory } from './diff-core';

export interface ColumnChange {
  /** Emitted when the change is safe. */
  up?: string;
  down?: string;
  note: string;
  /** Set when the change must NOT be generated. `generate` refuses the
   *  whole run rather than writing a file that omits it. */
  unsafe?: { reason: string; guidance: string };
}

/** The declared length/precision, when the type carries one:
 *  `varchar(64)` → 64, `numeric(12,2)` → 12. */
function width(type: string): number | null {
  const m = /\((\d+)/.exec(type);
  return m ? Number(m[1]) : null;
}

/** Is `to` guaranteed to hold everything `from` could? */
function isWidening(from: string, to: string): boolean {
  const a = from.toLowerCase().trim();
  const b = to.toLowerCase().trim();
  if (a === b) return true;

  const ca = dbTypeCategory(a);
  const cb = dbTypeCategory(b);

  // int → bigint is the one cross-category widening that is always safe.
  if (ca === 'int' && cb === 'bigint') return true;
  if (ca !== cb) return false;

  const wa = width(a);
  const wb = width(b);
  // varchar(64) → text: no declared width means no limit.
  if (wa !== null && wb === null) return cb === 'string';
  if (wa === null || wb === null) return false;
  return wb >= wa;
}

function alterTypeSql(d: Dialect, table: string, col: string, f: FieldDef): string | null {
  const t = d.columnType(f);
  const q = d.quoteIdent(table);
  const c = d.quoteIdent(col);
  switch (d.name) {
    case 'postgres':
      return `ALTER TABLE ${q} ALTER COLUMN ${c} TYPE ${t}`;
    case 'mysql':
      // MySQL restates the whole definition, so nullability rides along.
      return `ALTER TABLE ${q} MODIFY COLUMN ${c} ${t}${f.optional ? '' : ' NOT NULL'}`;
    default:
      // SQLite cannot alter a column type at all — see below.
      return null;
  }
}

function alterNullSql(d: Dialect, table: string, col: string, f: FieldDef): string | null {
  const q = d.quoteIdent(table);
  const c = d.quoteIdent(col);
  if (d.name === 'postgres') {
    return `ALTER TABLE ${q} ALTER COLUMN ${c} ${f.optional ? 'DROP' : 'SET'} NOT NULL`;
  }
  if (d.name === 'mysql') {
    return `ALTER TABLE ${q} MODIFY COLUMN ${c} ${d.columnType(f)}${f.optional ? '' : ' NOT NULL'}`;
  }
  return null;
}

/**
 * SQLite has no `ALTER COLUMN`. Changing a type or a constraint means the
 * twelve-step rebuild from its own documentation: new table, copy, drop,
 * rename. That is a data migration, and generating it blind — without
 * knowing the indexes, triggers and views that point at the old table —
 * is how a "schema change" quietly drops half a database.
 */
function sqliteRefusal(table: string, col: string): ColumnChange['unsafe'] {
  return {
    reason: `SQLite cannot ALTER the type or nullability of a column.`,
    guidance:
      `Write it by hand with \`forge generate --custom\`, following SQLite's ` +
      `documented rebuild: create ${table}_new with the wanted shape, ` +
      `INSERT … SELECT from ${table}, drop ${table}, rename, then recreate ` +
      `its indexes and triggers. Copying ${col} is the easy part; the ` +
      `objects pointing at the old table are the part a generator cannot see.`,
  };
}

/**
 * Compare one declared column against the one in the database (or in the
 * last snapshot), and decide what — if anything — should be generated.
 */
export function diffColumn(
  d: Dialect,
  table: string,
  name: string,
  field: FieldDef,
  actual: IntrospectedColumn,
): ColumnChange | null {
  const declaredType = d.columnType(field).toLowerCase();
  const actualType = (actual.type ?? '').toLowerCase();
  const typeChanged =
    actualType !== '' &&
    declaredType !== actualType &&
    // Only compare when both sides categorise. An uncategorised type is a
    // shape we do not understand well enough to rewrite.
    fieldCategory(field.kind) !== undefined &&
    dbTypeCategory(actualType) !== undefined;
  const nullChanged = actual.nullable !== (field.optional === true);

  if (!typeChanged && !nullChanged) return null;

  if (d.name !== 'postgres' && d.name !== 'mysql') {
    return { note: `${table}.${name} changed`, unsafe: sqliteRefusal(table, name) };
  }

  // ── the type ──────────────────────────────────────────────────────
  if (typeChanged) {
    if (!isWidening(actualType, declaredType)) {
      return {
        note: `${table}.${name}: ${actualType} → ${declaredType}`,
        unsafe: {
          reason:
            `${table}.${name} changes from ${actualType} to ${declaredType}, ` +
            `which is not a widening — existing rows may not fit, or may not ` +
            `convert at all.`,
          guidance:
            `forge will not guess at this. Write it with \`forge generate ` +
            `--custom\`: add the new column, backfill it with whatever ` +
            `conversion is correct for YOUR data, verify, then drop the old ` +
            `one and rename. Doing it in one ALTER locks the table and fails ` +
            `on the first row that will not cast.`,
        },
      };
    }
    const up = alterTypeSql(d, table, name, field);
    if (!up) return { note: `${table}.${name} changed`, unsafe: sqliteRefusal(table, name) };
    return {
      up,
      // The reverse is a NARROWING, so it can fail on rows written since.
      // Say so in the file rather than pretend the rollback is free.
      down:
        `-- narrowing ${name} back to ${actualType} can fail on rows added since;\n` +
        `-- review before rolling back.\n` +
        (d.name === 'postgres'
          ? `ALTER TABLE ${d.quoteIdent(table)} ALTER COLUMN ${d.quoteIdent(name)} TYPE ${actualType}`
          : `ALTER TABLE ${d.quoteIdent(table)} MODIFY COLUMN ${d.quoteIdent(name)} ${actualType}`),
      note: `widen ${table}.${name}: ${actualType} → ${declaredType}`,
    };
  }

  // ── nullability ───────────────────────────────────────────────────
  // Dropping NOT NULL always succeeds. Adding it fails the moment one row
  // holds a NULL, and the generator cannot know whether one does.
  if (field.optional) {
    const up = alterNullSql(d, table, name, field);
    if (!up) return { note: `${table}.${name} changed`, unsafe: sqliteRefusal(table, name) };
    return {
      up,
      down:
        d.name === 'postgres'
          ? `ALTER TABLE ${d.quoteIdent(table)} ALTER COLUMN ${d.quoteIdent(name)} SET NOT NULL`
          : `ALTER TABLE ${d.quoteIdent(table)} MODIFY COLUMN ${d.quoteIdent(name)} ${d.columnType(field)} NOT NULL`,
      note: `${table}.${name} becomes nullable`,
    };
  }

  // A DEFAULT does not save an ALTER on a populated table: it applies to
  // NEW rows, not to the NULLs already there.
  return {
    note: `${table}.${name} becomes NOT NULL`,
    unsafe: {
      reason:
        `${table}.${name} becomes NOT NULL. That fails outright if any row ` +
        `holds a NULL, and a DEFAULT does not help — a default applies to new ` +
        `rows, not to the ones already there.`,
      guidance:
        `Two migrations. First \`forge generate --custom\` with the backfill ` +
        `(UPDATE ${table} SET ${name} = … WHERE ${name} IS NULL), ship it, and ` +
        `confirm SELECT count(*) FROM ${table} WHERE ${name} IS NULL returns 0. ` +
        `Then make the column required in the schema and generate again — this ` +
        `refusal turns into the ALTER once the data is clean.`,
    },
  };
}
