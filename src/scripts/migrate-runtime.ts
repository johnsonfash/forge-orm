import * as fs from 'fs';
import * as path from 'path';
import type { ForgeDb } from '../factory';
import type { SqlFragment } from '../raw-sql';
import { splitSqlStatements, type SplitDialect } from './sql-split';

// Shared runtime for the migration workflow: a portable `_forge_migrations`
// history table, timestamped up/down files, and apply/rollback helpers.
// Used by diff-apply.ts, rollback.ts and adapters/postgres/migrate-files.ts.

export const MIGRATIONS_DIR = path.resolve(process.cwd(), 'migrations');

function frag(sql: string): SqlFragment {
  return { __forgeSql: true, strings: [sql], values: [] } as unknown as SqlFragment;
}

export async function rawExec(db: ForgeDb, sql: string): Promise<void> {
  await db.$executeRaw(frag(sql));
}
export async function rawQuery<T = any>(db: ForgeDb, sql: string): Promise<T[]> {
  return db.$queryRaw(frag(sql)) as Promise<T[]>;
}

// Portable across PG / MySQL / SQLite (varchar accepted everywhere).
export async function ensureHistoryTable(db: ForgeDb): Promise<void> {
  await rawExec(db, `CREATE TABLE IF NOT EXISTS _forge_migrations (name VARCHAR(255) PRIMARY KEY, applied_at VARCHAR(64))`);
}

export async function listApplied(db: ForgeDb): Promise<string[]> {
  const rows = await rawQuery<{ name: string }>(db, `SELECT name FROM _forge_migrations ORDER BY name ASC`);
  return rows.map((r) => r.name);
}

/** Applied migrations WITH the time they ran. `status` needs the dates;
 *  everything else only needs the names. */
export async function listAppliedWithDates(
  db: ForgeDb,
): Promise<{ name: string; appliedAt: string | null }[]> {
  const rows = await rawQuery<{ name: string; applied_at: string | null }>(
    db,
    `SELECT name, applied_at FROM _forge_migrations ORDER BY name ASC`,
  );
  return rows.map((r) => ({ name: r.name, appliedAt: r.applied_at ?? null }));
}

export async function recordMigration(db: ForgeDb, name: string): Promise<void> {
  const at = new Date().toISOString();
  // Escape single quotes in the (forge-generated, so safe) values defensively.
  await rawExec(db, `INSERT INTO _forge_migrations (name, applied_at) VALUES ('${name.replace(/'/g, "''")}', '${at}')`);
}

export async function removeMigration(db: ForgeDb, name: string): Promise<void> {
  await rawExec(db, `DELETE FROM _forge_migrations WHERE name = '${name.replace(/'/g, "''")}'`);
}

// Split a migration block into individual executable statements, dropping
// comment-only and blank ones (so `-- note` lines never hit the driver).
//
// This used to be `block.split(/;\s*\n/)`, which cut a plpgsql function
// body at every `;` inside its `$$ … $$`, and split string literals and
// comments that held a semicolon. sql-split.ts is the lexer that replaced it.
// Leading comments are still stripped per statement: a generated `down` can
// open with a warning whose last line ends in `;` (alter-column.ts does this
// for a narrowing), and that must not swallow the ALTER after it.
export function splitStatements(block: string, dialect: SplitDialect = 'generic'): string[] {
  return splitSqlStatements(block, dialect).map((s) => s.sql);
}

/** The split dialect for an adapter kind. */
export function splitDialectFor(kind: string): SplitDialect {
  return kind === 'postgres' || kind === 'mysql' || kind === 'sqlite' ? kind : 'generic';
}

export interface RollbackPlan {
  statements: string[];
  /** Set when the rollback must not run — the reason, ready to print. */
  refusal?: string;
}

/**
 * What `forge rollback` should do with a migration's `down` block.
 *
 * A `down` block with no executable statements has to abort rather than
 * fall through to `removeMigration`: running nothing and then deleting the
 * ledger row leaves the database carrying the change while `status` reports
 * the migration as pending, so the next apply re-runs the `up`.
 */
export function planRollback(name: string, down: string, dialect: SplitDialect = 'generic'): RollbackPlan {
  const statements = splitStatements(down, dialect);
  if (statements.length > 0) return { statements };
  return {
    statements,
    refusal:
      `'${name}' has no statements in its \`down\` block, so there is nothing to ` +
      `run. Leaving it recorded as applied — dropping the ledger row after ` +
      `running nothing would report it as pending while the database still ` +
      `carries its changes, and the next \`forge migrate\` would re-run the up.\n` +
      `  → Write the reverse SQL in the \`-- down\` section, or, if this ` +
      `migration genuinely has nothing to reverse, delete its row from ` +
      `_forge_migrations by hand.`,
  };
}

export interface ParsedMigration { up: string; down: string; }

export function renderMigrationFile(name: string, ups: string[], downs: string[]): string {
  return [
    `-- forge migration: ${name}`,
    `-- generated: ${new Date().toISOString()}`,
    ``,
    `-- up`,
    ups.map((s) => `${s};`).join('\n'),
    ``,
    `-- down`,
    downs.map((s) => `${s};`).join('\n'),
    ``,
  ].join('\n');
}

// The markers are whole lines. `indexOf('-- up')` also matched
// `-- update the totals`, so a comment could move where the up block began.
const UP_MARKER = /^--[ \t]*up[ \t]*\r?$/im;
const DOWN_MARKER = /^--[ \t]*down[ \t]*\r?$/im;

export function parseMigrationFile(content: string): ParsedMigration {
  const up = UP_MARKER.exec(content);
  const down = DOWN_MARKER.exec(content);
  if (!up || !down || down.index < up.index) return { up: '', down: '' };
  return {
    up: content.slice(up.index + up[0].length, down.index),
    down: content.slice(down.index + down[0].length),
  };
}

/** Whether a file uses the `-- up` / `-- down` sections at all. A file
 *  without them is a hand-written migration whose whole text is the up. */
export function hasUpDownSections(content: string): boolean {
  return UP_MARKER.test(content) && DOWN_MARKER.test(content);
}

export function timestampSlug(slug: string): string {
  const t = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, '');
  return `${t}_${slug}`;
}

export function writeMigrationFile(name: string, content: string): string {
  if (!fs.existsSync(MIGRATIONS_DIR)) fs.mkdirSync(MIGRATIONS_DIR, { recursive: true });
  const file = path.join(MIGRATIONS_DIR, `${name}.sql`);
  fs.writeFileSync(file, content, 'utf8');
  return file;
}

export function readMigrationFile(name: string): string | null {
  const file = path.join(MIGRATIONS_DIR, /\.sql$/i.test(name) ? name : `${name}.sql`);
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
}
