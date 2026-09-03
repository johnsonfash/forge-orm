// Rename detection — the last silent-data-loss case in the generator.
//
// Comparing two schema states shows only that one column name is gone
// and another has appeared. A RENAME and a DROP-plus-ADD look identical
// from there, and they do opposite things to the data: one keeps every
// row, the other deletes a column's worth of it.
//
// Guessing "drop and add" loses data on a column somebody meant to keep.
// Guessing "rename" keeps one somebody meant to delete, and quietly
// moves its data under a new name. So forge takes the answer from the
// schema — `renamedFrom` — and refuses when a change looks like a rename
// and carries no annotation.

import { f, model } from '../schema/core';
import type { IntrospectedColumn } from '../adapters/types';
import type { FieldDef } from '../schema/types';
import { PostgresDialect } from '../adapters/postgres/dialect';
import { planRenames } from '../scripts/rename-column';
import { generateMigration } from '../scripts/migrate-gen';
import { projectSchema } from '../scripts/snapshot';

const cols = (...defs: [string, string, boolean?][]): IntrospectedColumn[] =>
  defs.map(([name, type, nullable]) => ({ name, type, nullable: nullable ?? false }));

const fieldsOf = (m: unknown) =>
  (m as { fields: Record<string, FieldDef> }).fields;

const orgs = (fields: Record<string, unknown>) =>
  model('orgs', { id: f.id(), ...fields } as never);

describe('renamedFrom — the annotation', () => {
  it('records the previous name on the field', () => {
    const m = orgs({ name: f.string().renamedFrom('full_name') });
    expect(fieldsOf(m).name!.renamedFrom).toBe('full_name');
  });

  it('emits RENAME COLUMN, with a correct reverse', () => {
    const m = orgs({ name: f.string().renamedFrom('full_name') });
    const plan = planRenames(PostgresDialect, 'orgs', fieldsOf(m), cols(['full_name', 'text']));
    expect(plan.unsafe).toEqual([]);
    expect(plan.renames).toHaveLength(1);
    expect(plan.renames[0]!.up).toBe(
      'ALTER TABLE "orgs" RENAME COLUMN "full_name" TO "name"',
    );
    expect(plan.renames[0]!.down).toBe(
      'ALTER TABLE "orgs" RENAME COLUMN "name" TO "full_name"',
    );
  });

  it('marks the old column consumed, so it is not also dropped', () => {
    const m = orgs({ name: f.string().renamedFrom('full_name') });
    const plan = planRenames(PostgresDialect, 'orgs', fieldsOf(m), cols(['full_name', 'text']));
    expect([...plan.consumed]).toEqual(['full_name']);
  });

  it('says so when the annotation names a column that is not there', () => {
    // Either the rename already shipped, or it is a typo. Both deserve a
    // sentence rather than a confusing no-op.
    // `name` must be genuinely NEW for the annotation to be consulted —
    // one that names a column already present under its new name is a
    // leftover, and warning about those on every run would be noise.
    const m = orgs({ name: f.string().renamedFrom('nope') });
    const plan = planRenames(PostgresDialect, 'orgs', fieldsOf(m), cols(['other', 'int']));
    expect(plan.unsafe[0]!.reason).toMatch(/no column called 'nope'/);
    expect(plan.unsafe[0]!.guidance).toMatch(/already shipped/);
  });
});

describe('an unannotated rename is refused', () => {
  it('names both columns and prints the annotation to add', () => {
    const m = orgs({ name: f.string() });
    const plan = planRenames(PostgresDialect, 'orgs', fieldsOf(m), cols(['full_name', 'text']));
    expect(plan.renames).toEqual([]);
    expect(plan.unsafe).toHaveLength(1);
    expect(plan.unsafe[0]!.reason).toMatch(/cannot tell a rename from a drop and an add/);
    expect(plan.unsafe[0]!.guidance).toMatch(/renamedFrom\('full_name'\)/);
    expect(plan.unsafe[0]!.guidance).toMatch(/--allow-drop/);
  });

  it('only suspects columns of the SAME type', () => {
    // A dropped text column and a new integer one is not a rename
    // candidate — flagging it would make every real drop noisy.
    const m = orgs({ hits: f.int() });
    const plan = planRenames(PostgresDialect, 'orgs', fieldsOf(m), cols(['full_name', 'text']));
    expect(plan.unsafe).toEqual([]);
  });

  it('lists every candidate when more than one fits', () => {
    const m = orgs({ name: f.string(), label: f.string() });
    const plan = planRenames(PostgresDialect, 'orgs', fieldsOf(m), cols(['full_name', 'text']));
    expect(plan.unsafe[0]!.note).toMatch(/name \/ label|label \/ name/);
  });

  it('--allow-drop is how you say it really is a drop', () => {
    const m = orgs({ name: f.string() });
    const plan = planRenames(
      PostgresDialect, 'orgs', fieldsOf(m), cols(['full_name', 'text']), { allowDrop: true },
    );
    expect(plan.unsafe).toEqual([]);
    expect(plan.renames).toEqual([]);
  });

  it('a plain drop with nothing added is never a rename question', () => {
    const m = orgs({});
    const plan = planRenames(PostgresDialect, 'orgs', fieldsOf(m), cols(['full_name', 'text']));
    expect(plan.unsafe).toEqual([]);
  });
});

describe('through the generator', () => {
  const before = () =>
    projectSchema({ Org: orgs({ full_name: f.string(), hits: f.int() }) }, 'mysql');

  it('the rename comes FIRST — order is not cosmetic here', () => {
    // A rename after the ADD finds the new column already there; one
    // after the DROP has nothing left to rename.
    const pairs = generateMigration(
      { Org: orgs({ name: f.string().renamedFrom('full_name'), hits: f.int() }) } as never,
      before(),
    );
    expect(pairs[0]!.up).toMatch(/RENAME COLUMN/);
    expect(pairs.every((p) => !p.unsafe)).toBe(true);
  });

  it('a renamed column is not also added or dropped', () => {
    const pairs = generateMigration(
      { Org: orgs({ name: f.string().renamedFrom('full_name'), hits: f.int() }) } as never,
      before(),
    );
    expect(pairs.filter((p) => /ADD COLUMN/.test(p.up))).toHaveLength(0);
    expect(pairs.filter((p) => /DROP COLUMN/.test(p.up))).toHaveLength(0);
  });

  it('a rename AND a type change emits BOTH statements', () => {
    // Drizzle emits only the rename here (drizzle-team/drizzle-orm#5499,
    // #3826), so the type change is silently lost. The rename runs first
    // and the ALTER follows it.
    const pairs = generateMigration(
      { Org: orgs({ name: f.text().renamedFrom('full_name'), hits: f.int() }) } as never,
      before(),
    );
    const up = pairs.map((p) => p.up).join('\n');
    expect(up).toMatch(/RENAME COLUMN `full_name` TO `name`/);
    expect(up).toMatch(/MODIFY COLUMN `name` TEXT/);
    // …and the reverse undoes them in the opposite order.
    expect(pairs.findIndex((p) => /RENAME/.test(p.up)))
      .toBeLessThan(pairs.findIndex((p) => /MODIFY/.test(p.up)));
  });

  it('a rename AND an unsafe type change refuses rather than half-applying', () => {
    const pairs = generateMigration(
      { Org: orgs({ name: f.int().renamedFrom('full_name'), hits: f.int() }) } as never,
      before(),
    );
    expect(pairs.some((p) => p.unsafe)).toBe(true);
  });

  it('an unannotated rename refuses through the generator too', () => {
    const pairs = generateMigration(
      { Org: orgs({ name: f.string(), hits: f.int() }) } as never,
      before(),
    );
    const bad = pairs.find((p) => p.unsafe);
    expect(bad!.unsafe!.guidance).toMatch(/renamedFrom/);
  });
});
