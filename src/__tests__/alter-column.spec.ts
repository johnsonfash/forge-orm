// ALTER COLUMN — widen, or refuse and say why.
//
// A column whose TYPE or NULLABILITY changed used to be silently absent
// from a generated migration. The schema said varchar(255), the database
// kept varchar(64), the migration applied cleanly, and nothing said a
// word. Silently omitting a change is the worst of the three options.
//
// The rule: emit only what cannot fail on data. Everything else is
// refused WITH the two-step migration to write instead — because a tool
// that emits `ALTER COLUMN … TYPE int` against a column holding text is
// more dangerous than one that emits nothing, since the migration looks
// reviewed.

import { f, model } from '../schema/core';
import type { IntrospectedColumn } from '../adapters/types';
import type { FieldDef } from '../schema/types';
import { PostgresDialect } from '../adapters/postgres/dialect';
import { MysqlDialect } from '../adapters/mysql/dialect';
import { SqliteDialect } from '../adapters/sqlite/dialect';
import { diffColumn } from '../scripts/alter-column';
import { generateMigration } from '../scripts/migrate-gen';
import { projectSchema } from '../scripts/snapshot';

const col = (type: string, nullable = false): IntrospectedColumn => ({
  name: 'c',
  type,
  nullable,
});
const fieldOf = (m: ReturnType<typeof model>, name: string): FieldDef =>
  (m as unknown as { fields: Record<string, FieldDef> }).fields[name]!;

const org = (fields: Record<string, unknown>) => model('orgs', { id: f.id(), ...fields } as never);

describe('widening — emitted', () => {
  it('varchar → text on mysql', () => {
    const m = org({ c: f.text() });
    const r = diffColumn(MysqlDialect, 'orgs', 'c', fieldOf(m, 'c'), col('varchar(255)'));
    expect(r?.unsafe).toBeUndefined();
    expect(r?.up).toMatch(/MODIFY COLUMN `c` TEXT NOT NULL/);
    expect(r?.note).toMatch(/widen/);
  });

  it('int → bigint, the one safe cross-category change', () => {
    const m = org({ c: f.bigint() });
    const r = diffColumn(PostgresDialect, 'orgs', 'c', fieldOf(m, 'c'), col('integer'));
    expect(r?.unsafe).toBeUndefined();
    expect(r?.up).toMatch(/ALTER COLUMN "c" TYPE bigint/i);
  });

  it('a longer varchar', () => {
    const m = org({ c: f.string() });    // varchar(255) on mysql
    const r = diffColumn(MysqlDialect, 'orgs', 'c', fieldOf(m, 'c'), col('varchar(64)'));
    expect(r?.unsafe).toBeUndefined();
    expect(r?.up).toMatch(/MODIFY COLUMN/);
  });

  it('warns that the DOWN is a narrowing that can fail', () => {
    // The reverse of a widening is not free, and saying "rollback" without
    // saying that is a lie the file tells the person running it.
    const m = org({ c: f.text() });
    const r = diffColumn(MysqlDialect, 'orgs', 'c', fieldOf(m, 'c'), col('varchar(255)'));
    expect(r?.down).toMatch(/can fail on rows added since/);
  });

  it('dropping NOT NULL always succeeds', () => {
    const m = org({ c: f.string().optional() });
    const r = diffColumn(PostgresDialect, 'orgs', 'c', fieldOf(m, 'c'), col('text', false));
    expect(r?.unsafe).toBeUndefined();
    expect(r?.up).toMatch(/DROP NOT NULL/);
  });
});

describe('refused — with the fix printed', () => {
  it('a narrowing', () => {
    const m = org({ c: f.string() });    // varchar(255)
    const r = diffColumn(MysqlDialect, 'orgs', 'c', fieldOf(m, 'c'), col('text'));
    expect(r?.unsafe).toBeDefined();
    expect(r!.unsafe!.reason).toMatch(/not a widening/);
    expect(r!.unsafe!.guidance).toMatch(/--custom/);
  });

  it('a change of category', () => {
    const m = org({ c: f.int() });
    const r = diffColumn(PostgresDialect, 'orgs', 'c', fieldOf(m, 'c'), col('text'));
    expect(r!.unsafe!.reason).toMatch(/text to integer|not a widening/);
  });

  it('NULL → NOT NULL, and says a DEFAULT will not save it', () => {
    // A default applies to NEW rows. The NULLs already there are what
    // makes the ALTER fail, and that is the part people get wrong.
    const m = org({ c: f.string() });
    const r = diffColumn(PostgresDialect, 'orgs', 'c', fieldOf(m, 'c'), col('text', true));
    expect(r!.unsafe!.reason).toMatch(/DEFAULT does not help/);
    expect(r!.unsafe!.guidance).toMatch(/Two migrations/);
    expect(r!.unsafe!.guidance).toMatch(/IS NULL/);
  });

  it('anything at all on SQLite, which has no ALTER COLUMN', () => {
    const m = org({ c: f.string().optional() });
    const r = diffColumn(SqliteDialect, 'orgs', 'c', fieldOf(m, 'c'), col('text', false));
    expect(r!.unsafe!.reason).toMatch(/SQLite cannot ALTER/);
    // The rebuild is the answer, and the hard part is named.
    expect(r!.unsafe!.guidance).toMatch(/orgs_new/);
    expect(r!.unsafe!.guidance).toMatch(/indexes and triggers/);
  });
});

describe('when nothing should happen', () => {
  it('an unchanged column', () => {
    const m = org({ c: f.text() });
    expect(diffColumn(PostgresDialect, 'orgs', 'c', fieldOf(m, 'c'), col('text'))).toBeNull();
  });

  it('a type it cannot categorise is left alone', () => {
    // Better to say nothing than to rewrite a column whose shape we do
    // not understand.
    const m = org({ c: f.text() });
    expect(diffColumn(PostgresDialect, 'orgs', 'c', fieldOf(m, 'c'), col('tsvector'))).toBeNull();
  });

  it('Mongo, where introspection reports no column types at all', () => {
    const m = org({ c: f.text() });
    expect(diffColumn(PostgresDialect, 'orgs', 'c', fieldOf(m, 'c'), col(''))).toBeNull();
  });
});

describe('through the generator', () => {
  const before = () => projectSchema({ Org: org({ hits: f.int() }) }, 'postgres');

  it('a widening reaches the migration', () => {
    const pairs = generateMigration({ Org: org({ hits: f.bigint() }) } as never, before());
    expect(pairs.some((p) => /ALTER COLUMN "hits" TYPE bigint/i.test(p.up))).toBe(true);
    expect(pairs.every((p) => !p.unsafe)).toBe(true);
  });

  it('an unsafe change is marked, not emitted as SQL', () => {
    const pairs = generateMigration({ Org: org({ hits: f.string() }) } as never, before());
    const bad = pairs.find((p) => p.unsafe);
    expect(bad).toBeDefined();
    // `generate` refuses the whole run on this — writing the file without
    // the change would leave schema and database disagreeing, which is
    // the failure this exists to remove, not a smaller version of it.
    expect(bad!.up).toMatch(/refused/);
  });

  it('a column that only changed type is not also re-added', () => {
    const pairs = generateMigration({ Org: org({ hits: f.bigint() }) } as never, before());
    expect(pairs.filter((p) => /ADD COLUMN/.test(p.up))).toHaveLength(0);
  });
});
