import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import Database from 'better-sqlite3';
import { readMigrationFiles, MigrationError } from '../scripts/migrate-files-core';
import { betterSqlite3Driver } from '../adapters/sqlite/driver';
import { applySqliteMigrationFiles } from '../adapters/sqlite/migrate-files';
import { applyMysqlMigrationFiles } from '../adapters/mysql/migrate-files';
import { applyMssqlMigrationFiles } from '../adapters/mssql/migrate-files';
import { applyDuckdbMigrationFiles } from '../adapters/duckdb/migrate-files';
import type { MysqlDriver } from '../adapters/mysql/driver';
import type { MssqlDriver } from '../adapters/mssql/driver';
import type { DuckdbDriver } from '../adapters/duckdb/driver';

function folder(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-mig-'));
  for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), body);
  return dir;
}

describe('readMigrationFiles — per-dialect refusals', () => {
  it('sqlite: PRAGMA foreign_keys inside a transaction does nothing, so it is refused', () => {
    expect(() => readMigrationFiles(folder({ '1.sql': 'PRAGMA foreign_keys = ON;' }), 'sqlite'))
      .toThrow(/PRAGMA foreign_keys[\s\S]*forge:no-transaction/);
    expect(() => readMigrationFiles(folder({ '1.sql': '-- forge:no-transaction\nVACUUM;' }), 'sqlite')).not.toThrow();
  });

  it('sqlite: BEGIN/COMMIT refused, a trigger body and ROLLBACK TO are not', () => {
    expect(() => readMigrationFiles(folder({ '1.sql': 'BEGIN IMMEDIATE;\nCREATE TABLE t (a);\nCOMMIT;' }), 'sqlite'))
      .toThrow(/Remove the BEGIN\/COMMIT/);
    expect(() => readMigrationFiles(folder({
      '1.sql': 'CREATE TRIGGER tr AFTER INSERT ON t BEGIN SELECT 1; END;\nSAVEPOINT s; ROLLBACK TO s; RELEASE s;',
    }), 'sqlite')).not.toThrow();
  });

  it('mssql: transaction control in a plain batch is refused, inside a procedure it is not', () => {
    expect(() => readMigrationFiles(folder({ '1.sql': 'BEGIN TRAN;\nCREATE TABLE t (a INT);\nCOMMIT;' }), 'mssql'))
      .toThrow(/Remove the BEGIN\/COMMIT/);
    expect(() => readMigrationFiles(folder({
      '1.sql': 'CREATE PROCEDURE p AS BEGIN BEGIN TRAN; UPDATE t SET a = 1; COMMIT; END\nGO\n',
    }), 'mssql')).not.toThrow();
    expect(() => readMigrationFiles(folder({ '1.sql': "SELECT 'COMMIT';" }), 'mssql')).not.toThrow();
  });

  it('mssql: ALTER DATABASE needs a no-transaction file; GO n is refused', () => {
    expect(() => readMigrationFiles(folder({ '1.sql': 'ALTER DATABASE CURRENT SET READ_COMMITTED_SNAPSHOT ON' }), 'mssql'))
      .toThrow(/cannot run inside a transaction/);
    expect(() => readMigrationFiles(folder({ '1.sql': 'INSERT INTO t DEFAULT VALUES\nGO 3' }), 'mssql'))
      .toThrow(/GO 3' repeats a batch/);
  });

  it('mysql: no file is transactional; an unclosed START TRANSACTION is refused', () => {
    const [f] = readMigrationFiles(folder({ '1.sql': 'CREATE TABLE t (id int);' }), 'mysql');
    expect(f!.transactional).toBe(false);
    expect(() => readMigrationFiles(folder({ '1.sql': 'START TRANSACTION;\nUPDATE t SET a = 1;' }), 'mysql'))
      .toThrow(/never committed/);
    expect(() => readMigrationFiles(folder({ '1.sql': 'START TRANSACTION;\nUPDATE t SET a = 1;\nCOMMIT;' }), 'mysql'))
      .not.toThrow();
  });
});

describe('forge migrate on SQLite (better-sqlite3, in memory)', () => {
  const setup = () => {
    const raw = new Database(':memory:');
    return { raw, db: betterSqlite3Driver(raw) };
  };
  const tables = (raw: Database.Database) =>
    (raw.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`).all() as any[]).map((r) => r.name);

  it('applies files in order with checksums, then skips them', async () => {
    const { raw, db } = setup();
    const dir = folder({
      '0001_a.sql': 'CREATE TABLE a (id INTEGER PRIMARY KEY, n INTEGER);',
      '0002_b.sql': `-- up
CREATE TABLE b (id INTEGER);
CREATE TRIGGER a_bump AFTER INSERT ON a
BEGIN
  UPDATE a SET n = CASE WHEN NEW.n IS NULL THEN 1 ELSE NEW.n END WHERE id = NEW.id;
END;
-- down
DROP TABLE b;`,
    });
    const r1 = await applySqliteMigrationFiles(db, { dir });
    expect(r1.applied.map((a) => a.name)).toEqual(['0001_a', '0002_b']);
    expect(tables(raw)).toEqual(['_forge_migrations', 'a', 'b']);
    const ledger = raw.prepare('SELECT name, checksum FROM _forge_migrations ORDER BY name').all() as any[];
    expect(ledger.map((r) => r.name)).toEqual(['0001_a', '0002_b']);
    expect(ledger[0].checksum).toMatch(/^[0-9a-f]{64}$/);
    raw.prepare('INSERT INTO a (id) VALUES (1)').run();
    expect((raw.prepare('SELECT n FROM a').get() as any).n).toBe(1);

    const r2 = await applySqliteMigrationFiles(db, { dir });
    expect(r2.applied).toEqual([]);
    expect(r2.skipped).toEqual(['0001_a', '0002_b']);
  });

  it('a file that fails part-way leaves nothing and is not recorded', async () => {
    const { raw, db } = setup();
    const dir = folder({
      '0001_ok.sql': 'CREATE TABLE ok (id INTEGER);',
      '0002_bad.sql': 'CREATE TABLE half (id INTEGER);\nINSERT INTO ok VALUES (1);\nINSERT INTO nope VALUES (1);',
    });
    await expect(applySqliteMigrationFiles(db, { dir })).rejects.toThrow(/0002_bad.sql line 3[\s\S]*Rolled back/);
    expect(tables(raw)).toEqual(['_forge_migrations', 'ok']);
    expect((raw.prepare('SELECT COUNT(*) AS c FROM ok').get() as any).c).toBe(0);
    expect((raw.prepare('SELECT name FROM _forge_migrations').all() as any[]).map((r) => r.name)).toEqual(['0001_ok']);
  });

  it('refuses a file edited after it ran', async () => {
    const { db } = setup();
    const dir = folder({ '0001_a.sql': 'CREATE TABLE a (id INTEGER);' });
    await applySqliteMigrationFiles(db, { dir });
    fs.writeFileSync(path.join(dir, '0001_a.sql'), 'CREATE TABLE a (id INTEGER, b TEXT);');
    await expect(applySqliteMigrationFiles(db, { dir })).rejects.toThrow(/edited after it ran/);
  });

  it('refuses out-of-order and unknown files unless allowed; dry run writes nothing', async () => {
    const { raw, db } = setup();
    const dir = folder({ '0002_b.sql': 'CREATE TABLE b (id INTEGER);' });
    const dry = await applySqliteMigrationFiles(db, { dir, dryRun: true });
    expect(dry.pending).toEqual(['0002_b']);
    expect(tables(raw)).toEqual([]);
    await applySqliteMigrationFiles(db, { dir });
    fs.writeFileSync(path.join(dir, '0001_a.sql'), 'CREATE TABLE a (id INTEGER);');
    await expect(applySqliteMigrationFiles(db, { dir })).rejects.toThrow(/numbered behind/);
    await applySqliteMigrationFiles(db, { dir, allowOutOfOrder: true });
    fs.unlinkSync(path.join(dir, '0001_a.sql'));
    await expect(applySqliteMigrationFiles(db, { dir })).rejects.toThrow(/not in/);
  });

  it('runs started together on one connection apply each file once', async () => {
    const { raw, db } = setup();
    const dir = folder({
      '0001_a.sql': 'CREATE TABLE a (id INTEGER);',
      '0002_b.sql': 'CREATE TABLE b (id INTEGER);',
    });
    const reports = await Promise.all([1, 2, 3, 4, 5].map(() => applySqliteMigrationFiles(db, { dir })));
    expect(reports.flatMap((r) => r.applied.map((a) => a.name)).sort()).toEqual(['0001_a', '0002_b']);
    expect((raw.prepare('SELECT COUNT(*) AS c FROM _forge_migrations').get() as any).c).toBe(2);
  });

  it('adopts a ledger written by diff apply before checksums existed', async () => {
    const { raw, db } = setup();
    raw.exec(`CREATE TABLE _forge_migrations (name VARCHAR(255) PRIMARY KEY, applied_at VARCHAR(64));
      CREATE TABLE a (id INTEGER); INSERT INTO _forge_migrations VALUES ('0001_a', 'x');`);
    const dir = folder({ '0001_a.sql': 'CREATE TABLE a (id INTEGER);' });
    const r = await applySqliteMigrationFiles(db, { dir });
    expect(r.skipped).toEqual(['0001_a']);
    expect((raw.prepare('SELECT checksum FROM _forge_migrations').get() as any).checksum).toMatch(/^[0-9a-f]{64}$/);
  });

  it('a no-transaction file runs outside a transaction and says what stayed applied', async () => {
    const { raw, db } = setup();
    const dir = folder({ '0001_v.sql': '-- forge:no-transaction\nCREATE TABLE v (id INTEGER);\nINSERT INTO nope VALUES (1);' });
    await expect(applySqliteMigrationFiles(db, { dir })).rejects.toThrow(/1 statement before it stayed applied/);
    expect(tables(raw)).toContain('v');
    expect((raw.prepare('SELECT COUNT(*) AS c FROM _forge_migrations').get() as any).c).toBe(0);
  });
});

// A scripted connection: answers by SQL pattern and records what was sent.
function scripted(answer: (sql: string, params?: unknown[]) => any[] | Error | undefined) {
  const log: string[] = [];
  const run = (sql: string, params?: unknown[]) => {
    log.push(sql.replace(/\s+/g, ' ').trim());
    const a = answer(sql, params);
    if (a instanceof Error) throw a;
    return a ?? [];
  };
  return { log, run };
}

describe('forge migrate on MySQL (scripted driver)', () => {
  const make = (fail?: RegExp) => {
    const ledger: string[] = [];
    const s = scripted((sql, params) => {
      if (fail && fail.test(sql)) return new Error('Table nope does not exist');
      if (/GET_LOCK/.test(sql)) return [{ l: 1 }];
      if (/information_schema/.test(sql)) return [{ x: 1 }];
      if (/^SELECT checksum/.test(sql)) return ledger.includes(String(params?.[0])) ? [{ checksum: null }] : [];
      if (/^SELECT name, checksum/.test(sql)) return ledger.map((name) => ({ name, checksum: null }));
      if (/^INSERT INTO _forge_migrations/.test(sql)) ledger.push(String(params?.[0]));
      return [];
    });
    const q = { query: async (sql: string, p?: unknown[]) => [s.run(sql, p), undefined] as [any, any] };
    const driver = {
      kind: 'mysql', ...q, execute: q.query,
      transaction: async () => { throw new Error('not used'); },
      reserve: async () => ({ ...q, execute: q.query, release: () => { s.log.push('release'); } }),
      close: async () => {},
    } as unknown as MysqlDriver;
    return { driver, log: s.log, ledger };
  };

  it('holds GET_LOCK for the run, runs statement by statement, records after the last', async () => {
    const { driver, log, ledger } = make();
    const dir = folder({
      '0001_p.sql': `CREATE TABLE t (id int);
DELIMITER $$
CREATE PROCEDURE p() BEGIN INSERT INTO t VALUES (1); INSERT INTO t VALUES (2); END$$
DELIMITER ;
INSERT INTO t VALUES ('a?b');`,
    });
    const r = await applyMysqlMigrationFiles(driver, { dir });
    expect(r.applied.map((a) => a.name)).toEqual(['0001_p']);
    expect(ledger).toEqual(['0001_p']);
    const i = (re: RegExp) => log.findIndex((l) => re.test(l));
    expect(i(/GET_LOCK/)).toBe(0);
    expect(i(/^CREATE PROCEDURE p\(\) BEGIN INSERT INTO t VALUES \(1\); INSERT INTO t VALUES \(2\); END$/)).toBeGreaterThan(0);
    expect(i(/^INSERT INTO _forge_migrations/)).toBeGreaterThan(i(/a\?b/));
    expect(log.slice(-2)).toEqual(['SELECT RELEASE_LOCK(?)', 'release']);
  });

  it('a failure says the earlier statements stayed applied', async () => {
    const { driver, ledger } = make(/nope/);
    const dir = folder({ '0001_x.sql': 'CREATE TABLE a (id int);\nCREATE TABLE b (id int);\nINSERT INTO nope VALUES (1);' });
    await expect(applyMysqlMigrationFiles(driver, { dir }))
      .rejects.toThrow(/line 3 \(statement 3 of 3\)[\s\S]*MySQL commits each statement as it runs, so the 2 statements before it stayed applied/);
    expect(ledger).toEqual([]);
  });

  it('refuses a driver that cannot hold a connection', async () => {
    const { driver } = make();
    delete (driver as any).reserve;
    await expect(applyMysqlMigrationFiles(driver, { dir: folder({ '1.sql': 'SELECT 1;' }) }))
      .rejects.toThrow(MigrationError);
  });
});

describe('forge migrate on SQL Server (scripted driver)', () => {
  it('one transaction per file: applock, ledger check, GO batches, ledger row', async () => {
    const ledger: string[] = [];
    let inTx = false;
    const txLog: string[] = [];
    const s = scripted((sql, params) => {
      if (inTx) txLog.push(sql.replace(/\s+/g, ' ').trim());
      if (/sp_getapplock/.test(sql)) return [{ r: 0 }];
      if (/OBJECT_ID/.test(sql)) return [{ t: 1 }];
      if (/COL_LENGTH/.test(sql)) return [{ c: 128 }];
      if (/^SELECT checksum/.test(sql)) return ledger.includes(String(params?.[0])) ? [{ checksum: null }] : [];
      if (/^SELECT name, checksum/.test(sql)) return ledger.map((name) => ({ name, checksum: null }));
      if (/^INSERT INTO _forge_migrations/.test(sql)) ledger.push(String(params?.[0]));
      return [];
    });
    const q = { query: async (sql: string, p?: unknown[]) => ({ rows: s.run(sql, p) }) };
    const driver = {
      kind: 'mssql', ...q,
      transaction: async (fn: any) => { inTx = true; try { return await fn(q); } finally { inTx = false; } },
      close: async () => {},
    } as unknown as MssqlDriver;
    const dir = folder({
      '0001_p.sql': 'CREATE TABLE [t] (id INT);\nGO\nCREATE PROCEDURE p AS BEGIN SELECT 1; SELECT 2; END\nGO\n',
    });
    const r = await applyMssqlMigrationFiles(driver, { dir });
    expect(r.applied.map((a) => a.name)).toEqual(['0001_p']);
    expect(txLog[0]).toMatch(/sp_getapplock @Resource = N'forge_migrate'.*@LockOwner = N'Transaction'/);
    expect(txLog.slice(2)).toEqual([
      'CREATE TABLE [t] (id INT);',
      'CREATE PROCEDURE p AS BEGIN SELECT 1; SELECT 2; END',
      'INSERT INTO _forge_migrations (name, applied_at, checksum) VALUES (@p1, @p2, @p3)',
    ]);
  });
});

describe('forge migrate on DuckDB (scripted driver)', () => {
  it('statements and ledger row share one transaction; a failure rolls them back', async () => {
    const committed: string[] = [];
    let pending: string[] = [];
    const s = scripted((sql) => {
      if (/nope/.test(sql)) return new Error('Table nope does not exist');
      if (/information_schema/.test(sql)) return [{ x: 1 }];
      return [];
    });
    const q = { query: async (sql: string, p?: unknown[]) => { pending.push(sql); return { rows: s.run(sql, p) }; } };
    const driver = {
      kind: 'duckdb', ...q,
      transaction: async (fn: any) => {
        pending = [];
        try { const out = await fn(q); committed.push(...pending); return out; } finally { pending = []; }
      },
      close: async () => {},
    } as unknown as DuckdbDriver;
    const dir = folder({ '0001_a.sql': 'CREATE TABLE a (id INT);\nINSERT INTO nope VALUES (1);' });
    await expect(applyDuckdbMigrationFiles(driver, { dir })).rejects.toThrow(/Rolled back/);
    expect(committed.some((c) => /CREATE TABLE a/.test(c))).toBe(false);
    expect(committed.some((c) => /INSERT INTO _forge_migrations/.test(c))).toBe(false);
  });
});
