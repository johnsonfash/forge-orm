import { forgeSql, compileSqlFragment, isSqlFragment } from '../raw-sql';

describe('forge.sql — tagged template', () => {
  it('compiles values to $1, $2, $3 (postgres)', () => {
    const { sql, params } = compileSqlFragment(
      forgeSql.sql`SELECT * FROM users WHERE active = ${true} AND age >= ${18}`,
      'postgres',
    );
    expect(sql).toBe('SELECT * FROM users WHERE active = $1 AND age >= $2');
    expect(params).toEqual([true, 18]);
  });

  it('compiles values to ? placeholders (mysql / sqlite)', () => {
    const a = compileSqlFragment(forgeSql.sql`UPDATE users SET active = ${true}`, 'mysql');
    const b = compileSqlFragment(forgeSql.sql`UPDATE users SET active = ${true}`, 'sqlite');
    expect(a.sql).toBe('UPDATE users SET active = ?');
    expect(b.sql).toBe('UPDATE users SET active = ?');
  });

  it('values are parameterised — injection attempts go into params, not SQL', () => {
    const evil = "1'; DROP TABLE users;--";
    const { sql, params } = compileSqlFragment(
      forgeSql.sql`SELECT * FROM users WHERE email = ${evil}`,
    );
    expect(sql).not.toContain('DROP');
    expect(params).toEqual([evil]);
  });

  it('a fragment with no values is just literal SQL', () => {
    const { sql, params } = compileSqlFragment(forgeSql.sql`SELECT COUNT(*) FROM users`);
    expect(sql).toBe('SELECT COUNT(*) FROM users');
    expect(params).toEqual([]);
  });
});

describe('forge.raw — literal passthrough', () => {
  it('emits raw SQL with no placeholders', () => {
    const { sql, params } = compileSqlFragment(forgeSql.raw('SELECT NOW()'));
    expect(sql).toBe('SELECT NOW()');
    expect(params).toEqual([]);
  });
});

describe('forge.sql — nested composition', () => {
  it('inlines a nested fragment\'s SQL and renumbers placeholders', () => {
    const tail = forgeSql.sql`AND active = ${true}`;
    const { sql, params } = compileSqlFragment(
      forgeSql.sql`SELECT * FROM users WHERE org_id = ${'org_1'} ${tail}`,
    );
    expect(sql).toBe('SELECT * FROM users WHERE org_id = $1 AND active = $2');
    expect(params).toEqual(['org_1', true]);
  });

  it('forge.empty is a safe "no clause" sentinel', () => {
    const filter = forgeSql.empty;
    const { sql, params } = compileSqlFragment(
      forgeSql.sql`SELECT * FROM users WHERE id = ${'u1'} ${filter}`,
    );
    expect(sql).toBe('SELECT * FROM users WHERE id = $1 ');
    expect(params).toEqual(['u1']);
  });

  it('forge.join concatenates fragments with a separator', () => {
    const parts = [forgeSql.sql`name = ${'a'}`, forgeSql.sql`age = ${30}`];
    const { sql, params } = compileSqlFragment(
      forgeSql.sql`SELECT * FROM users WHERE ${forgeSql.join(parts, ' AND ')}`,
    );
    expect(sql).toBe('SELECT * FROM users WHERE name = $1 AND age = $2');
    expect(params).toEqual(['a', 30]);
  });
});

describe('isSqlFragment — type guard', () => {
  it('recognises forge.sql output', () => {
    expect(isSqlFragment(forgeSql.sql`SELECT 1`)).toBe(true);
    expect(isSqlFragment(forgeSql.raw('SELECT 1'))).toBe(true);
    expect(isSqlFragment(forgeSql.empty)).toBe(true);
  });

  it('rejects everything else', () => {
    expect(isSqlFragment('SELECT 1')).toBe(false);
    expect(isSqlFragment(null)).toBe(false);
    expect(isSqlFragment({ sql: 'SELECT 1' })).toBe(false);
  });
});
