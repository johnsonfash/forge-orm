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

describe('splitSqlStatements — mysql', () => {
  const my = (s: string) => splitSqlStatements(s, 'mysql').map((x) => x.sql);

  it('backtick identifiers and backslash escapes in both quote styles', () => {
    expect(my('CREATE TABLE `a;b` (id int); SELECT "x\\";y"; SELECT 3;'))
      .toEqual(['CREATE TABLE `a;b` (id int)', 'SELECT "x\\";y"', 'SELECT 3']);
  });

  it('-- is a comment only when a space follows it', () => {
    expect(my('SELECT 1--1;\n-- note; here\nSELECT 2;')).toEqual(['SELECT 1--1', 'SELECT 2']);
  });

  it('DELIMITER blocks: the body keeps its semicolons, the DELIMITER lines are dropped', () => {
    const sql = `CREATE TABLE t (id int);
DELIMITER $$
CREATE PROCEDURE p()
BEGIN
  INSERT INTO t VALUES (1);
  INSERT INTO t VALUES (2);
END$$
CREATE TRIGGER tr BEFORE INSERT ON t FOR EACH ROW
BEGIN
  SET NEW.id = NEW.id + 1;
END$$
DELIMITER ;
SELECT 1;`;
    const out = splitSqlStatements(sql, 'mysql');
    expect(out.map((s) => s.sql)).toEqual([
      'CREATE TABLE t (id int)',
      'CREATE PROCEDURE p()\nBEGIN\n  INSERT INTO t VALUES (1);\n  INSERT INTO t VALUES (2);\nEND',
      'CREATE TRIGGER tr BEFORE INSERT ON t FOR EACH ROW\nBEGIN\n  SET NEW.id = NEW.id + 1;\nEND',
      'SELECT 1',
    ]);
    expect(out.map((s) => s.line)).toEqual([1, 3, 8, 13]);
  });

  it('a routine body without DELIMITER is kept whole, IF / CASE / LOOP blocks included', () => {
    const sql = `CREATE DEFINER=\`root\`@\`%\` PROCEDURE p(IN n INT)
BEGIN
  DECLARE i INT DEFAULT 0;
  IF n > 0 THEN SET i = 1; END IF;
  SET i = CASE WHEN n > 1 THEN 2 ELSE 3 END;
  lbl: LOOP
    SET i = i + 1;
    IF i > 10 THEN LEAVE lbl; END IF;
  END LOOP;
  BEGIN
    SELECT i;
  END;
END;
SELECT 2;`;
    const out = my(sql);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatch(/^CREATE DEFINER[\s\S]*END;\nEND$/);
    expect(out[1]).toBe('SELECT 2');
  });

  it('BEGIN outside a routine does not swallow the next statement', () => {
    expect(my('CREATE TABLE begin_log (id int); SELECT 1;')).toEqual(['CREATE TABLE begin_log (id int)', 'SELECT 1']);
  });

  it('keeps /*! … */ version comments, which the server runs', () => {
    expect(my('/*!40101 SET NAMES utf8mb4 */;\nSELECT 1;')).toEqual(['/*!40101 SET NAMES utf8mb4 */', 'SELECT 1']);
  });
});

describe('splitSqlStatements — sqlite', () => {
  const lite = (s: string) => splitSqlStatements(s, 'sqlite').map((x) => x.sql);

  it('keeps a trigger body whole, CASE … END inside included', () => {
    const sql = `CREATE TABLE t (id INTEGER, n INTEGER);
CREATE TRIGGER t_bump AFTER UPDATE ON t
BEGIN
  UPDATE t SET n = CASE WHEN n IS NULL THEN 1 ELSE n + 1 END WHERE id = NEW.id;
  INSERT INTO log VALUES (NEW.id);
END;
CREATE TEMP TRIGGER t2 AFTER INSERT ON t BEGIN SELECT 1; END;
SELECT 3;`;
    const out = lite(sql);
    expect(out).toHaveLength(4);
    expect(out[1]).toMatch(/^CREATE TRIGGER t_bump[\s\S]*END$/);
    expect(out[2]).toBe('CREATE TEMP TRIGGER t2 AFTER INSERT ON t BEGIN SELECT 1; END');
    expect(out[3]).toBe('SELECT 3');
  });

  it('[bracket] and `backtick` identifiers', () => {
    expect(lite('CREATE TABLE [a;b] (`c;d` int); SELECT 2;')).toEqual(['CREATE TABLE [a;b] (`c;d` int)', 'SELECT 2']);
  });

  it('a backslash is not an escape', () => {
    expect(lite(`SELECT 'C:\\'; SELECT 2;`)).toEqual([`SELECT 'C:\\'`, 'SELECT 2']);
  });
});

describe('splitSqlStatements — mssql', () => {
  const ms = (s: string) => splitSqlStatements(s, 'mssql');

  it('splits on GO lines only; semicolons stay inside the batch', () => {
    const sql = `CREATE TABLE [t;x] (id INT);
INSERT INTO [t;x] VALUES (1);
GO
CREATE PROCEDURE p AS
BEGIN
  SELECT N'it''s; fine';
  SELECT 2;
END
go -- end of procedure
SELECT 3`;
    const out = ms(sql);
    expect(out.map((s) => s.sql)).toEqual([
      'CREATE TABLE [t;x] (id INT);\nINSERT INTO [t;x] VALUES (1);',
      "CREATE PROCEDURE p AS\nBEGIN\n  SELECT N'it''s; fine';\n  SELECT 2;\nEND",
      'SELECT 3',
    ]);
    expect(out.map((s) => s.line)).toEqual([1, 4, 10]);
  });

  it('GO inside a string, a comment, or mid-line is not a separator', () => {
    const sql = `SELECT 'a
GO
b';
/* GO
GO */
SELECT 1 AS go;
GO`;
    expect(ms(sql)).toHaveLength(1);
  });

  it('records a GO repeat count', () => {
    expect(ms('INSERT INTO t DEFAULT VALUES\nGO 5\n')[0]).toMatchObject({ repeat: 5 });
  });

  it('nested block comments', () => {
    expect(ms('/* a /* b */ GO\n */ SELECT 1').map((s) => s.sql)).toEqual(['SELECT 1']);
  });
});

describe('splitSqlStatements — duckdb', () => {
  it('lexes like postgres: dollar quotes and E-strings', () => {
    expect(splitSqlStatements(`SELECT $$a;b$$; SELECT E'\\';'; SELECT 3;`, 'duckdb').map((s) => s.sql))
      .toEqual([`SELECT $$a;b$$`, `SELECT E'\\';'`, 'SELECT 3']);
  });
});
