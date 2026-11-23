import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { maskSqlLiterals, splitSqlStatements, type SplitStatement } from './sql-split';
import { hasUpDownSections, parseMigrationFile } from './migrate-runtime';
import type { MigrationFile, MigrateFilesOptions, MigrateFilesReport } from '../adapters/postgres/migrate-files-types';

// The dialect-neutral half of `forge migrate` / `db.$migrateFiles()`: reading
// and validating the folder, and deciding what may run. How a file is applied
// — in one transaction with its ledger row, or statement by statement — and
// how concurrent runners are kept apart is each dialect's engine
// (adapters/<kind>/migrate-files.ts).

export type MigrateDialect = 'postgres' | 'mysql' | 'sqlite' | 'mssql' | 'duckdb';

export const LEDGER = '_forge_migrations';

export class MigrationError extends Error {
  constructor(message: string, readonly migration?: string, readonly cause?: unknown) {
    super(message);
    this.name = 'MigrationError';
  }
}

const NO_TX_DIRECTIVE = /^--[ \t]*forge:no-transaction[ \t]*\r?$/im;

interface DialectRules {
  /** DDL commits implicitly, so no file can be all-or-nothing. */
  noTransactions?: boolean;
  /** A statement (mssql: a batch) that ends the runner's transaction. */
  txControl?: RegExp;
  /** Statements the server will not run inside a transaction. */
  cannotRunInTx: Array<[RegExp, string]>;
}

const PG_TX_CONTROL = /^(BEGIN|START\s+TRANSACTION|COMMIT|END|ABORT)\b|^ROLLBACK\b(?!\s+(TO|PREPARED)\b)/i;

const RULES: Record<MigrateDialect, DialectRules> = {
  postgres: {
    txControl: PG_TX_CONTROL,
    cannotRunInTx: [
      [/^CREATE\s+(UNIQUE\s+)?INDEX\s+CONCURRENTLY\b/i, 'CREATE INDEX CONCURRENTLY'],
      [/^DROP\s+INDEX\s+CONCURRENTLY\b/i, 'DROP INDEX CONCURRENTLY'],
      [/^REINDEX\b[\s\S]*\bCONCURRENTLY\b/i, 'REINDEX … CONCURRENTLY'],
      [/^ALTER\s+TABLE\b[\s\S]*\bDETACH\s+PARTITION\b[\s\S]*\bCONCURRENTLY\b/i, 'DETACH PARTITION … CONCURRENTLY'],
      [/^VACUUM\b/i, 'VACUUM'],
      [/^(CREATE|DROP)\s+DATABASE\b/i, 'CREATE/DROP DATABASE'],
      [/^(CREATE|DROP)\s+TABLESPACE\b/i, 'CREATE/DROP TABLESPACE'],
      [/^ALTER\s+SYSTEM\b/i, 'ALTER SYSTEM'],
      [/^CREATE\s+SUBSCRIPTION\b/i, 'CREATE SUBSCRIPTION'],
    ],
  },
  duckdb: {
    txControl: PG_TX_CONTROL,
    cannotRunInTx: [],
  },
  sqlite: {
    txControl: /^(BEGIN|COMMIT|END)\b|^ROLLBACK\b(?!\s+(TRANSACTION\s+)?TO\b)/i,
    cannotRunInTx: [
      [/^VACUUM\b/i, 'VACUUM'],
      [/^(ATTACH|DETACH)\b/i, 'ATTACH/DETACH'],
      // Both are accepted inside a transaction and do nothing there, which is
      // worse than an error: the file "applies" and foreign keys stay off.
      [/^PRAGMA\s+(\w+\.)?foreign_keys\s*=/i, 'PRAGMA foreign_keys = … (ignored inside a transaction)'],
      [/^PRAGMA\s+(\w+\.)?journal_mode\s*=/i, 'PRAGMA journal_mode = …'],
    ],
  },
  mssql: {
    // Searched over the whole batch: a batch holds several statements.
    txControl: /\b(BEGIN\s+(DISTRIBUTED\s+)?TRAN(SACTION)?|COMMIT|ROLLBACK)\b/i,
    cannotRunInTx: [
      [/\b(CREATE|ALTER|DROP)\s+DATABASE\b/i, 'CREATE/ALTER/DROP DATABASE'],
      [/\b(BACKUP|RESTORE)\s+(DATABASE|LOG)\b/i, 'BACKUP/RESTORE'],
      [/\bRECONFIGURE\b/i, 'RECONFIGURE'],
      [/\b(CREATE|ALTER|DROP)\s+FULLTEXT\s+(CATALOG|INDEX)\b/i, 'CREATE/ALTER/DROP FULLTEXT'],
    ],
  },
  mysql: {
    noTransactions: true,
    cannotRunInTx: [],
  },
};

// A procedure, function or trigger body may hold transaction control of its
// own; it runs when the routine is called, not when the file is applied.
const MSSQL_MODULE = /^\s*(CREATE|ALTER|CREATE\s+OR\s+ALTER)\s+(PROC|PROCEDURE|FUNCTION|TRIGGER)\b/i;

const normalise = (s: string) => s.replace(/\r\n/g, '\n');
export const sha256 = (s: string) => createHash('sha256').update(normalise(s)).digest('hex');
export const ledgerName = (s: string) => s.replace(/\.sql$/i, '');

/** The statements (mssql: batches) a migration file runs, in order. */
export function migrationStatements(f: MigrationFile, dialect: MigrateDialect): SplitStatement[] {
  return splitSqlStatements(f.sql, dialect);
}

/** Read and validate every `.sql` file in `dir`, in the order they apply. */
export function readMigrationFiles(dir: string, dialect: MigrateDialect = 'postgres'): MigrationFile[] {
  if (!fs.existsSync(dir)) return [];
  const names = fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.sql')).sort();
  return names.map((file) => {
    const text = fs.readFileSync(path.join(dir, file), 'utf8');
    const sql = hasUpDownSections(text) ? parseMigrationFile(text).up : text;
    const transactional = !RULES[dialect].noTransactions && !NO_TX_DIRECTIVE.test(text);
    const m: MigrationFile = { name: ledgerName(file), file, sql, checksum: sha256(sql), transactional };
    validate(m, dialect);
    return m;
  });
}

function validate(m: MigrationFile, dialect: MigrateDialect): void {
  const rules = RULES[dialect];
  const statements = splitSqlStatements(m.sql, dialect);
  if (statements.length === 0) {
    throw new MigrationError(
      `[forge:migrate] ${m.file} has no SQL to run. Recording it as applied would ` +
        `make the ledger say something happened that did not. Write the statements, ` +
        `or delete the file.`,
      m.name,
    );
  }
  if (dialect === 'mysql') return validateMysql(m, statements);
  for (const s of statements) {
    if (dialect === 'mssql' && s.repeat != null && s.repeat !== 1) {
      throw new MigrationError(
        `[forge:migrate] ${m.file} line ${s.line}: 'GO ${s.repeat}' repeats a batch, and ` +
          `forge runs each batch once. Write the repetition in T-SQL (a WHILE loop).`,
        m.name,
      );
    }
    const code = dialect === 'mssql' ? maskSqlLiterals(s.sql, 'mssql') : s.sql;
    const isModule = dialect === 'mssql' && MSSQL_MODULE.test(code);
    if (rules.txControl && !isModule && rules.txControl.test(code)) {
      throw new MigrationError(
        `[forge:migrate] ${m.file} line ${s.line}: '${firstLine(s.sql)}'. Each file already ` +
          `runs in its own transaction, together with its ledger row; a COMMIT inside it ` +
          `would commit the file without the row. Remove the BEGIN/COMMIT lines.`,
        m.name,
      );
    }
    if (!m.transactional) continue;
    const hit = rules.cannotRunInTx.find(([re]) => re.test(code));
    if (hit) {
      throw new MigrationError(
        `[forge:migrate] ${m.file} line ${s.line}: ${hit[1]} cannot run inside a ` +
          `transaction. Put it in a file of its own that starts with the line\n` +
          `  -- forge:no-transaction\n` +
          `Such a file runs one statement at a time and is NOT all-or-nothing, so ` +
          `write it to be safe to re-run (IF NOT EXISTS).`,
        m.name,
      );
    }
  }
}

// MySQL runs no file in a transaction (DDL commits as it goes), so a file
// may carry its own START TRANSACTION … COMMIT around data changes. What it
// must not do is leave one open: the ledger row would join it, and the
// connection would go back to the pool mid-transaction.
function validateMysql(m: MigrationFile, statements: SplitStatement[]): void {
  let open: SplitStatement | null = null;
  for (const s of statements) {
    if (/^(START\s+TRANSACTION|BEGIN(\s+WORK)?)\s*$|^START\s+TRANSACTION\b/i.test(s.sql)) open = s;
    else if (/^(COMMIT|ROLLBACK)\b(?!\s+(WORK\s+)?TO\b)/i.test(s.sql)) open = null;
    else if (/^XA\b/i.test(s.sql)) {
      throw new MigrationError(`[forge:migrate] ${m.file} line ${s.line}: XA transactions are not supported in a migration file.`, m.name);
    }
  }
  if (open) {
    throw new MigrationError(
      `[forge:migrate] ${m.file} line ${open.line}: '${firstLine(open.sql)}' is never committed. ` +
        `Add a COMMIT after the statements it covers.`,
      m.name,
    );
  }
}

export interface LedgerRow { raw: string; checksum: string | null }

export function toLedgerMap(rows: Array<Record<string, unknown>>): Map<string, LedgerRow> {
  return new Map(rows.map((r) => [
    ledgerName(String(r.name)),
    { raw: String(r.name), checksum: (r.checksum as string | null | undefined) ?? null },
  ]));
}

/** What a dialect has to provide for the runner to apply files. */
export interface MigrateEngine {
  readonly dialect: MigrateDialect;
  /**
   * Wrap the whole run. MySQL holds a named lock on one connection for it;
   * SQLite and DuckDB queue runs on the same connection.
   */
  run?<T>(fn: () => Promise<T>): Promise<T>;
  hasLedger(): Promise<boolean>;
  ensureLedger(): Promise<void>;
  readLedger(dryRun: boolean): Promise<Map<string, LedgerRow>>;
  setChecksum(raw: string, checksum: string): Promise<void>;
  /** Apply one file. `false` when another runner applied it first. */
  apply(f: MigrationFile): Promise<boolean>;
}

/**
 * Apply every pending migration file in order. Throws on the first failure,
 * after which later files have not been touched.
 */
export async function runMigrationFiles(
  engine: MigrateEngine,
  opts: MigrateFilesOptions = {},
): Promise<MigrateFilesReport> {
  const body = () => runUnlocked(engine, opts);
  return engine.run ? engine.run(body) : body();
}

async function runUnlocked(engine: MigrateEngine, opts: MigrateFilesOptions): Promise<MigrateFilesReport> {
  const log = opts.logger ?? (() => {});
  const dir = path.resolve(opts.dir ?? path.join(process.cwd(), 'migrations'));
  const files = readMigrationFiles(dir, engine.dialect);
  const report: MigrateFilesReport = { applied: [], skipped: [], pending: [] };

  const ledgerExists = await engine.hasLedger();
  if (!opts.dryRun && !ledgerExists) await engine.ensureLedger();
  const ledger = ledgerExists || !opts.dryRun
    ? await engine.readLedger(!!opts.dryRun)
    : new Map<string, LedgerRow>();

  const byName = new Map(files.map((f) => [f.name, f]));
  const changed = files.filter((f) => {
    const sum = ledger.get(f.name)?.checksum;
    return sum != null && sum !== f.checksum;
  });
  if (changed.length) {
    throw new MigrationError(
      `[forge:migrate] ${changed.length} migration${changed.length === 1 ? ' was' : 's were'} ` +
        `edited after ${changed.length === 1 ? 'it' : 'they'} ran:\n` +
        changed.map((f) => `  ${f.file}`).join('\n') +
        `\nThe database has the old version. Put the file back as it was and add a new ` +
        `migration for the change.`,
      changed[0]!.name,
    );
  }

  const unknown = [...ledger.keys()].filter((n) => !byName.has(n));
  if (unknown.length && !opts.allowUnknown) {
    throw new MigrationError(
      `[forge:migrate] the database has applied migrations that are not in ${dir}:\n` +
        unknown.map((n) => `  ${n}`).join('\n') +
        `\nSomebody ran another branch against it. Find that branch, or pass ` +
        `--allow-unknown (allowUnknown: true) if you know why.`,
    );
  }

  const pending = files.filter((f) => !ledger.has(f.name));
  const applied = files.filter((f) => ledger.has(f.name));
  const highest = applied.length ? applied[applied.length - 1]!.name : null;
  const behind = highest ? pending.filter((f) => f.name < highest) : [];
  if (behind.length && !opts.allowOutOfOrder) {
    throw new MigrationError(
      `[forge:migrate] pending migration${behind.length === 1 ? '' : 's'} numbered behind ` +
        `${highest}, which is already applied:\n` +
        behind.map((f) => `  ${f.file}`).join('\n') +
        `\nRenumber ${behind.length === 1 ? 'it' : 'them'} after ${highest}, or pass ` +
        `--allow-out-of-order (allowOutOfOrder: true) to apply as they stand.`,
    );
  }

  // A row from before checksums were recorded is adopted now, once, rather
  // than left unverified forever.
  for (const f of applied) {
    const row = ledger.get(f.name)!;
    if (row.checksum === null && !opts.dryRun) {
      await engine.setChecksum(row.raw, f.checksum);
      log(`recorded checksum for ${f.file} (it had none)`);
    }
    report.skipped.push(f.name);
  }

  const mode = (f: MigrationFile) =>
    engine.dialect === 'mysql' ? ' (statement by statement; MySQL commits DDL as it runs)'
      : f.transactional ? '' : ' (no transaction)';

  if (opts.dryRun) {
    report.pending = pending.map((f) => f.name);
    for (const f of pending) log(`would apply ${f.file}${mode(f)}`);
    if (!pending.length) log('nothing to apply');
    return report;
  }

  for (let k = 0; k < pending.length; k++) {
    const f = pending[k]!;
    const t0 = Date.now();
    let ran: boolean;
    try {
      ran = await engine.apply(f);
    } catch (err) {
      report.pending = pending.slice(k).map((p) => p.name);
      throw err;
    }
    if (ran) {
      const ms = Date.now() - t0;
      report.applied.push({ name: f.name, ms });
      log(`applied ${f.file}${mode(f)} (${ms} ms)`);
    } else {
      report.skipped.push(f.name);
      log(`${f.file} was applied by another runner`);
    }
  }
  if (!report.applied.length) log('nothing to apply');
  return report;
}

/** Throws when a ledger row exists for `f` with a different checksum. */
export function checkAppliedRow(f: MigrationFile, rows: Array<{ checksum?: unknown }>): boolean {
  if (!rows.length) return false;
  const sum = (rows[0]!.checksum as string | null | undefined) ?? null;
  if (sum != null && sum !== f.checksum) {
    throw new MigrationError(
      `[forge:migrate] ${f.file} was edited after it ran. Put it back and add a new migration.`,
      f.name,
    );
  }
  return true;
}

/**
 * Run statements one at a time. `atomic` says whether they share a
 * transaction, which decides what the error says about the ones before.
 */
export async function runStatements(
  f: MigrationFile,
  statements: SplitStatement[],
  exec: (sql: string) => Promise<unknown>,
  atomic: boolean,
  committedHow = 'This file is forge:no-transaction',
): Promise<void> {
  for (let i = 0; i < statements.length; i++) {
    const s = statements[i]!;
    try {
      await exec(s.sql);
    } catch (err) {
      throw new MigrationError(
        `[forge:migrate] ${f.file} line ${s.line} (statement ${i + 1} of ${statements.length}): ` +
          `${errMessage(err)}\n` +
          (atomic
            ? `Rolled back: nothing from this file is in the database, and it is not recorded.`
            : i > 0
              ? `${committedHow}, so the ${i} statement${i === 1 ? '' : 's'} before it ` +
                `stayed applied. It is not recorded; fix it and re-run.`
              : `Nothing from this file was applied, and it is not recorded.`),
        f.name,
        err,
      );
    }
  }
}

/** One promise chain per key: runs on one connection must not interleave. */
export function serialiser(): <T>(key: object, fn: () => Promise<T>) => Promise<T> {
  const tails = new WeakMap<object, Promise<unknown>>();
  return <T>(key: object, fn: () => Promise<T>): Promise<T> => {
    const prev = tails.get(key) ?? Promise.resolve();
    const next = prev.catch(() => undefined).then(fn);
    tails.set(key, next);
    return next;
  };
}

export function errMessage(err: unknown): string {
  return (err as { message?: string })?.message ?? String(err);
}

function firstLine(s: string): string {
  const l = s.split('\n')[0]!;
  return l.length > 80 ? `${l.slice(0, 77)}…` : l;
}
