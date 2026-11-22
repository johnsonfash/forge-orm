import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { readMigrationFiles } from '../adapters/postgres/migrate-files';
import { parseMigrationFile } from '../scripts/migrate-runtime';

// What the migration runner refuses BEFORE it touches a database. Each of
// these would otherwise be found by Postgres half-way through a deploy.

function folder(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-mig-'));
  for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), body);
  return dir;
}

describe('readMigrationFiles', () => {
  it('orders by name, names without .sql, whole file is the up when there are no sections', () => {
    const dir = folder({
      '0002_b.sql': 'SELECT 2;',
      '0001_a.sql': '-- a hand-written file\nCREATE TABLE a (id int);',
      'notes.txt': 'ignored',
    });
    const files = readMigrationFiles(dir);
    expect(files.map((f) => f.name)).toEqual(['0001_a', '0002_b']);
    expect(files[0]!.sql).toContain('CREATE TABLE a');
    expect(files[0]!.transactional).toBe(true);
  });

  it('runs only the -- up section of a forge generate file', () => {
    const dir = folder({ '0001_x.sql': '-- forge migration: 0001_x.sql\n\n-- up\nCREATE TABLE x (id int);\n\n-- down\nDROP TABLE x;\n' });
    const [f] = readMigrationFiles(dir);
    expect(f!.sql).toContain('CREATE TABLE x');
    expect(f!.sql).not.toContain('DROP TABLE');
  });

  it('a comment starting "-- update" is not an up marker', () => {
    const text = '-- update the totals\nUPDATE t SET n = 1;\n';
    expect(parseMigrationFile(text)).toEqual({ up: '', down: '' });
    const [f] = readMigrationFiles(folder({ '0001_u.sql': text }));
    expect(f!.sql).toBe(text);
  });

  it('the checksum ignores CRLF vs LF', () => {
    const a = readMigrationFiles(folder({ '0001_a.sql': 'SELECT 1;\nSELECT 2;\n' }))[0]!;
    const b = readMigrationFiles(folder({ '0001_a.sql': 'SELECT 1;\r\nSELECT 2;\r\n' }))[0]!;
    expect(a.checksum).toBe(b.checksum);
    expect(a.checksum).toMatch(/^[0-9a-f]{64}$/);
  });

  it('refuses a file with nothing to run (the generate --custom placeholder)', () => {
    const dir = folder({ '0001_c.sql': '-- up\n-- write your UP statements here\n-- down\n-- and the reverse here\n' });
    expect(() => readMigrationFiles(dir)).toThrow(/no SQL to run/);
  });

  it('refuses a BEGIN/COMMIT inside a file', () => {
    expect(() => readMigrationFiles(folder({ '0001_t.sql': 'BEGIN;\nCREATE TABLE t (id int);\nCOMMIT;' })))
      .toThrow(/line 1: 'BEGIN'[\s\S]*Remove the BEGIN\/COMMIT/);
  });

  it('does not mistake BEGIN inside a function body, or ROLLBACK TO SAVEPOINT, for one', () => {
    const body = `CREATE FUNCTION f() RETURNS void LANGUAGE plpgsql AS $$ BEGIN COMMIT; END $$;
SAVEPOINT s; ROLLBACK TO SAVEPOINT s; RELEASE SAVEPOINT s;`;
    expect(() => readMigrationFiles(folder({ '0001_f.sql': body }))).not.toThrow();
  });

  it('refuses CREATE INDEX CONCURRENTLY without the opt-out, and names the fix', () => {
    const dir = folder({ '0001_i.sql': 'CREATE INDEX CONCURRENTLY t_i ON t (a);' });
    expect(() => readMigrationFiles(dir)).toThrow(/cannot run inside a transaction[\s\S]*-- forge:no-transaction/);
  });

  it('accepts it with the opt-out, and marks the file non-transactional', () => {
    const dir = folder({ '0001_i.sql': '-- forge:no-transaction\nCREATE INDEX CONCURRENTLY IF NOT EXISTS t_i ON t (a);' });
    expect(readMigrationFiles(dir)[0]!.transactional).toBe(false);
  });
});
