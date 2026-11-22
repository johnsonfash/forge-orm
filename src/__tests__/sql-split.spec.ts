import { splitSqlStatements } from '../scripts/sql-split';

// The splitter the migration runner, `diff apply` and `rollback` share.
// Every case here is a `;` that the old `split(/;\s*\n/)` treated as a
// statement end and Postgres does not.

const pg = (s: string) => splitSqlStatements(s, 'postgres').map((x) => x.sql);

describe('splitSqlStatements — postgres', () => {
  it('keeps a plpgsql trigger function whole', () => {
    const sql = `CREATE FUNCTION set_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;
CREATE TRIGGER t BEFORE UPDATE ON x FOR EACH ROW EXECUTE FUNCTION set_updated_at();`;
    const out = pg(sql);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatch(/^CREATE FUNCTION[\s\S]*END;\n\$\$$/);
    expect(out[1]).toMatch(/^CREATE TRIGGER/);
  });

  it('honours tagged dollar quotes, including a $$ inside a $body$', () => {
    const sql = `CREATE FUNCTION f() RETURNS text LANGUAGE plpgsql AS $body$
BEGIN
  EXECUTE $q$ SELECT 'a;b' $q$;
  RETURN $$;$$;
END;
$body$; SELECT 2;`;
    expect(pg(sql)).toHaveLength(2);
    expect(pg(sql)[1]).toBe('SELECT 2');
  });

  it('keeps a DO block whole', () => {
    expect(pg(`DO $$ BEGIN PERFORM 1; PERFORM 2; END $$;\nSELECT 1;`)).toEqual([
      'DO $$ BEGIN PERFORM 1; PERFORM 2; END $$',
      'SELECT 1',
    ]);
  });

  it('does not split inside quoted strings, E-strings or identifiers', () => {
    expect(pg(`INSERT INTO t VALUES ('a;\nb', 'it''s; fine');`)).toHaveLength(1);
    expect(pg(`SELECT E'back\\'slash; still';\nSELECT 2;`)).toEqual([
      `SELECT E'back\\'slash; still'`,
      'SELECT 2',
    ]);
    expect(pg(`CREATE TABLE "odd;name" (id int);`)).toEqual([`CREATE TABLE "odd;name" (id int)`]);
  });

  it('a backslash in a standard string is not an escape', () => {
    // standard_conforming_strings: 'C:\' is a complete literal.
    expect(pg(`SELECT 'C:\\'; SELECT 2;`)).toEqual([`SELECT 'C:\\'`, 'SELECT 2']);
  });

  it('ignores semicolons in comments, nested block comments included', () => {
    const sql = `-- first; not a statement
SELECT 1; /* a; /* nested; */ still comment; */ SELECT 2;
-- trailing; comment`;
    expect(pg(sql)).toEqual(['SELECT 1', 'SELECT 2']);
  });

  it('keeps a BEGIN ATOMIC body whole, CASE … END inside it included', () => {
    const sql = `CREATE FUNCTION g(a int) RETURNS int LANGUAGE sql
BEGIN ATOMIC
  SELECT CASE WHEN a > 0 THEN 1 ELSE 0 END;
  SELECT a;
END;
SELECT 3;`;
    const out = pg(sql);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatch(/END$/);
    expect(out[1]).toBe('SELECT 3');
  });

  it('a positional parameter is not a dollar quote', () => {
    expect(pg(`PREPARE p AS SELECT $1; SELECT 2;`)).toEqual(['PREPARE p AS SELECT $1', 'SELECT 2']);
  });

  it('a $ inside an identifier is not a dollar quote', () => {
    expect(pg(`SELECT a$b$ FROM t; SELECT 2;`)).toEqual(['SELECT a$b$ FROM t', 'SELECT 2']);
  });

  it('reports the line each statement starts on', () => {
    const out = splitSqlStatements(`-- header\n\nSELECT 1;\n\n  SELECT\n 2;`, 'postgres');
    expect(out.map((s) => s.line)).toEqual([3, 5]);
  });

  it('drops comment-only and empty statements', () => {
    expect(pg(`;;\n-- only a comment;\n/* and this; */;`)).toEqual([]);
  });

  it('leaves a statement with no final semicolon as the last one', () => {
    expect(pg(`SELECT 1;\nSELECT 2`)).toEqual(['SELECT 1', 'SELECT 2']);
  });
});

describe('splitSqlStatements — other dialects', () => {
  it('mysql: backslash escapes and # comments', () => {
    expect(splitSqlStatements(`SELECT 'a\\';b'; # c; d\nSELECT 2;`, 'mysql').map((s) => s.sql))
      .toEqual([`SELECT 'a\\';b'`, 'SELECT 2']);
  });

  it('sqlite/generic: $$ is not special', () => {
    expect(splitSqlStatements(`SELECT '$$'; SELECT 2;`, 'sqlite').map((s) => s.sql))
      .toEqual([`SELECT '$$'`, 'SELECT 2']);
  });
});
