import { f, model } from '../schema/core';
import type { ModelDef } from '../schema/types';
import { buildSelect } from '../ir/build';
import { compileSelect } from '../adapters/postgres/compile-from-ir';
import { PostgresDialect } from '../adapters/postgres/dialect';
import { MysqlDialect } from '../adapters/mysql/dialect';
import { SqliteDialect } from '../adapters/sqlite/dialect';
import { DuckdbDialect } from '../adapters/duckdb/dialect';
import { MssqlDialect } from '../adapters/mssql/dialect';

// Every non-Postgres dialect runs the Postgres compiler and rewrites its
// output, so any construct that never got a Dialect hook leaked through as
// Postgres SQL. These pin the ones that did: ILIKE, the array filters, the
// boolean literals, array_append, and the JSON path string.

const Doc: ModelDef<never> = model('docs', {
  id: f.id(),
  title: f.string(),
  tags: f.stringArray(),
  meta: f.json(),
}) as never as ModelDef<never>;

const ALL = [
  ['postgres', PostgresDialect],
  ['mysql', MysqlDialect],
  ['sqlite', SqliteDialect],
  ['duckdb', DuckdbDialect],
  ['mssql', MssqlDialect],
] as const;
const NON_PG = ALL.filter(([n]) => n !== 'postgres');
// DuckDB is deliberately Postgres-compatible and DOES have ILIKE; the three
// that do not are the ones the leak broke.
const NO_ILIKE = ALL.filter(([n]) => n !== 'postgres' && n !== 'duckdb');

const art = (d: unknown, args: unknown) =>
  compileSelect(buildSelect('doc', Doc, args as never, 'many'), Doc, d as never) as
    { sql: string; params: unknown[] };
const sqlFor = (d: unknown, args: unknown) => art(d, args).sql;

describe("mode: 'insensitive'", () => {
  test('Postgres emits ILIKE', () => {
    expect(sqlFor(PostgresDialect, { where: { title: { contains: 'x', mode: 'insensitive' } } }))
      .toContain('ILIKE');
  });

  test('DuckDB has ILIKE too, so it keeps it', () => {
    expect(sqlFor(DuckdbDialect, { where: { title: { contains: 'x', mode: 'insensitive' } } }))
      .toContain('ILIKE');
  });

  test.each(NO_ILIKE)('%s never sees ILIKE — it is a syntax error there', (_n, d) => {
    expect(sqlFor(d, { where: { title: { contains: 'x', mode: 'insensitive' } } }))
      .not.toContain('ILIKE');
  });

  test.each(NO_ILIKE)(
    '%s lowers both sides, so the match really is insensitive',
    (_n, d) => {
      expect(sqlFor(d, { where: { title: { contains: 'x', mode: 'insensitive' } } }))
        .toMatch(/LOWER\(.+\) LIKE LOWER\(/);
    },
  );

  test.each(ALL)('%s still emits a plain LIKE for a case-SENSITIVE contains', (_n, d) => {
    expect(sqlFor(d, { where: { title: { contains: 'x' } } })).toContain('LIKE');
  });
});

describe('array filters on a list column', () => {
  const FILTERS = [
    ['has', { tags: { has: 'a' } }],
    ['hasSome', { tags: { hasSome: ['a', 'b'] } }],
    ['hasEvery', { tags: { hasEvery: ['a', 'b'] } }],
    ['isEmpty', { tags: { isEmpty: true } }],
  ] as const;

  // `f.stringArray()` was writable and readable on MySQL/SQLite/MSSQL but not
  // FILTERABLE: every one of these emitted a Postgres array operator.
  for (const [opName, where] of FILTERS) {
    test.each(NON_PG)(`%s gets no Postgres array operator for ${opName}`, (_n, d) => {
      // `json_array_length` is SQLite's own correct function — only the bare
      // Postgres `array_length` is a leak.
      expect(sqlFor(d, { where })).not.toMatch(/= ANY\(|&&|@>|(?<!json_)\barray_length/);
    });
  }

  test('Postgres keeps its native operators', () => {
    expect(sqlFor(PostgresDialect, { where: { tags: { has: 'a' } } })).toContain('= ANY(');
    expect(sqlFor(PostgresDialect, { where: { tags: { hasSome: ['a'] } } })).toContain('&&');
    expect(sqlFor(PostgresDialect, { where: { tags: { hasEvery: ['a'] } } })).toContain('@>');
    expect(sqlFor(PostgresDialect, { where: { tags: { isEmpty: true } } })).toContain('array_length');
  });

  test('MySQL goes through JSON_CONTAINS / JSON_OVERLAPS', () => {
    expect(sqlFor(MysqlDialect, { where: { tags: { has: 'a' } } })).toContain('JSON_CONTAINS');
    expect(sqlFor(MysqlDialect, { where: { tags: { hasSome: ['a'] } } })).toContain('JSON_OVERLAPS');
    expect(sqlFor(MysqlDialect, { where: { tags: { isEmpty: true } } })).toContain('JSON_LENGTH');
  });

  test("SQLite goes through json_each — which its own header always claimed", () => {
    expect(sqlFor(SqliteDialect, { where: { tags: { has: 'a' } } })).toContain('json_each');
    expect(sqlFor(SqliteDialect, { where: { tags: { isEmpty: true } } })).toContain('json_array_length');
  });

  test('MSSQL goes through OPENJSON', () => {
    expect(sqlFor(MssqlDialect, { where: { tags: { has: 'a' } } })).toContain('OPENJSON');
  });

  test('DuckDB uses its list_* functions', () => {
    expect(sqlFor(DuckdbDialect, { where: { tags: { has: 'a' } } })).toContain('list_contains');
    expect(sqlFor(DuckdbDialect, { where: { tags: { hasEvery: ['a'] } } })).toContain('list_has_all');
  });

  test.each(ALL)('%s treats isEmpty: false as the negation', (_n, d) => {
    const yes = sqlFor(d, { where: { tags: { isEmpty: true } } });
    const no = sqlFor(d, { where: { tags: { isEmpty: false } } });
    expect(no).not.toBe(yes);
    expect(no).toContain('NOT (');
  });
});

describe('boolean literals', () => {
  test('an empty `in` list matches nothing without a bare FALSE on T-SQL', () => {
    // `where: { id: { in: [] } }` is what an empty `.map()` produces. T-SQL
    // has no FALSE keyword, so the bare literal was a syntax error.
    const mssql = sqlFor(MssqlDialect, { where: { id: { in: [] } } });
    expect(mssql).toContain('1=0');
    expect(mssql).not.toMatch(/\bFALSE\b/);
    expect(sqlFor(PostgresDialect, { where: { id: { in: [] } } })).toContain('FALSE');
  });

  test('an empty `notIn` matches everything, likewise', () => {
    const mssql = sqlFor(MssqlDialect, { where: { id: { notIn: [] } } });
    expect(mssql).toContain('1=1');
    expect(mssql).not.toMatch(/\bTRUE\b/);
  });

  test.each(ALL)('%s declares both literals, and they differ', (_n, d) => {
    expect(typeof d.trueLiteral).toBe('string');
    expect(typeof d.falseLiteral).toBe('string');
    expect(d.trueLiteral).not.toBe(d.falseLiteral);
  });
});

describe('array writes', () => {
  test('Postgres uses array_append', () => {
    expect(PostgresDialect.arrayOp('push', '"tags"', [], 'x')).toContain('array_append');
  });

  test.each(NON_PG)('%s can push, and not via array_append', (_n, d) => {
    const expr = d.arrayOp('push', '"tags"', [], 'x');
    expect(expr).not.toBeNull();
    expect(expr).not.toContain('array_append');
  });

  test('a dialect that cannot express addToSet/pull says so instead of guessing', () => {
    // Returning null makes the compiler raise a named error. Emitting
    // something that half-works on text arrays but not numeric ones would be
    // worse than refusing.
    expect(MysqlDialect.arrayOp('pull', '"tags"', [], 'x')).toBeNull();
    expect(SqliteDialect.arrayOp('addToSet', '"tags"', [], 'x')).toBeNull();
    expect(PostgresDialect.arrayOp('pull', '"tags"', [], 'x')).toContain('array_remove');
    expect(DuckdbDialect.arrayOp('addToSet', '"tags"', [], 'x')).toContain('list_contains');
  });
});

describe('a JSON path is never spliced into the SQL text', () => {
  // PG addresses JSON with -> operators rather than a path string, so it is
  // not part of this class.
  test.each(NON_PG)('%s binds the path as a parameter', (_n, d) => {
    const a = art(d, { where: { meta: { path: 'a.b', eq: 1 } } });
    expect(a.sql).not.toContain('$.a.b');
    expect(a.params).toContain('$.a.b');
  });

  test('a path segment carrying a quote cannot break out', () => {
    // MySQL escaped the path by hand and applied the two escapes in the wrong
    // order, so this exact shape closed the string literal and ran as SQL.
    const evil = "a' OR 1=1#";
    const a = art(MysqlDialect, { where: { meta: { path: [evil], eq: 1 } } });
    expect(a.sql).not.toContain('OR 1=1');
    expect(a.params).toContain(`$.${evil}`);
  });
});
