// `forge rollback` — running nothing and calling it rolled back.
//
// Two faults, one outcome. `splitStatements` tested its comment pattern
// against a whole statement chunk instead of line by line, and a generated
// `down` opens with a warning whose first line ends in `;` — so the chunk
// that reached the filter was `-- review…\nALTER TABLE …` and the ALTER was
// thrown away with the comment. Then rollback deleted the ledger row
// regardless of how many statements had run.
//
// Net effect: the column stayed changed, the row was gone, `status`
// reported the migration as pending, and the next apply re-ran the `up`.
// Of the available failures that is the worst one — the database and the
// ledger now disagree and nothing said so.

import { PostgresDialect } from '../adapters/postgres/dialect';
import { f, model } from '../schema/core';
import type { FieldDef } from '../schema/types';
import type { IntrospectedColumn } from '../adapters/types';
import { diffColumn } from '../scripts/alter-column';
import {
  parseMigrationFile,
  planRollback,
  renderMigrationFile,
  splitStatements,
} from '../scripts/migrate-runtime';

/** The real generated `down` for a widening — two comment lines, then the SQL. */
function wideningDown(): string {
  const m = model('orgs', { id: f.id(), c: f.text() } as never);
  const field = (m as unknown as { fields: Record<string, FieldDef> }).fields.c!;
  const actual: IntrospectedColumn = { name: 'c', type: 'varchar(64)', nullable: false };
  return diffColumn(PostgresDialect, 'orgs', 'c', field, actual)!.down!;
}

describe('splitStatements', () => {
  it('keeps the SQL under a leading comment block', () => {
    const down = wideningDown();
    expect(down).toMatch(/^--/);              // the generator really does lead with one
    const statements = splitStatements(down);
    expect(statements).toHaveLength(1);
    expect(statements[0]).toMatch(/^ALTER TABLE "orgs" ALTER COLUMN "c" TYPE varchar\(64\)$/);
  });

  it('keeps it after a round trip through the migration file', () => {
    const file = renderMigrationFile('0002_widen.sql', ['SELECT 1'], [wideningDown()]);
    const { down } = parseMigrationFile(file);
    expect(splitStatements(down).map((s) => s.replace(/\s+/g, ' '))).toEqual([
      'ALTER TABLE "orgs" ALTER COLUMN "c" TYPE varchar(64)',
    ]);
  });

  it('still drops a statement that is only a comment', () => {
    expect(splitStatements('-- (nothing to reverse);\n')).toEqual([]);
    expect(splitStatements('-- one\n-- two\n')).toEqual([]);
  });

  it('still drops blank chunks and keeps every real statement', () => {
    const block = '\nDROP INDEX a;\n\nDROP INDEX b;\n';
    expect(splitStatements(block)).toEqual(['DROP INDEX a', 'DROP INDEX b']);
  });

  it('does not treat a `--` inside a string literal as a comment', () => {
    // Only the LEADING run of comment lines is stripped, so once real SQL
    // has started a `--` is left exactly where the author put it.
    const block = "INSERT INTO notes (body) VALUES ('a\n-- not a comment');\n";
    expect(splitStatements(block)).toEqual([
      "INSERT INTO notes (body) VALUES ('a\n-- not a comment')",
    ]);
  });

  it('strips a leading /* … */ block and keeps what follows', () => {
    expect(splitStatements('/* why */ DROP TABLE t;\n')).toEqual(['DROP TABLE t']);
    expect(splitStatements('/* nothing to do */;\n')).toEqual([]);
  });

  it('strips mixed leading comment forms', () => {
    expect(splitStatements('-- a\n/* b */\n-- c\nDROP TABLE t;\n')).toEqual(['DROP TABLE t']);
  });
});

describe('planRollback', () => {
  it('runs the statements a real down block contains', () => {
    const { statements, refusal } = planRollback('0002_widen.sql', `\n${wideningDown()};\n`);
    expect(refusal).toBeUndefined();
    expect(statements).toHaveLength(1);
  });

  it('refuses when the down block has nothing to run', () => {
    const { statements, refusal } = planRollback('0003_data.sql', '\n-- (nothing to reverse);\n');
    expect(statements).toEqual([]);
    expect(refusal).toBeDefined();
  });

  it("refuses the placeholder `generate --custom` leaves behind", () => {
    const file = renderMigrationFile('0004_custom.sql', ['-- write your UP statements here'], ['-- and the reverse here']);
    const { down } = parseMigrationFile(file);
    expect(planRollback('0004_custom.sql', down).refusal).toBeDefined();
  });

  it('says what would have gone wrong, not just that it stopped', () => {
    const { refusal } = planRollback('0003_data.sql', '');
    expect(refusal).toContain("'0003_data.sql'");
    expect(refusal).toMatch(/nothing to run/);
    expect(refusal).toMatch(/Leaving it recorded as applied/);
    expect(refusal).toMatch(/re-run the up/);
    expect(refusal).toMatch(/_forge_migrations/);          // the way out
  });
});
