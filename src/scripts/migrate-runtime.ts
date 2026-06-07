import * as fs from 'fs';
import * as path from 'path';
import type { ForgeDb } from '../factory';
import type { SqlFragment } from '../raw-sql';

// Shared runtime for the migration workflow: a portable `_forge_migrations`
// history table, timestamped up/down files, and apply/rollback helpers.
// Used by diff-apply.ts and rollback.ts.

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

export async function recordMigration(db: ForgeDb, name: string): Promise<void> {
  const at = new Date().toISOString();
  // Escape single quotes in the (forge-generated, so safe) values defensively.
  await rawExec(db, `INSERT INTO _forge_migrations (name, applied_at) VALUES ('${name.replace(/'/g, "''")}', '${at}')`);
}

export async function removeMigration(db: ForgeDb, name: string): Promise<void> {
  await rawExec(db, `DELETE FROM _forge_migrations WHERE name = '${name.replace(/'/g, "''")}'`);
}

// Split a migration block into individual executable statements, dropping
// comment-only and blank lines (so `-- note` lines never hit the driver).
export function splitStatements(block: string): string[] {
  return block
    .split(/;\s*(?:\n|$)/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && !/^--/.test(s));
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

export function parseMigrationFile(content: string): ParsedMigration {
  const upIdx = content.indexOf('-- up');
  const downIdx = content.indexOf('-- down');
  if (upIdx === -1 || downIdx === -1) return { up: '', down: '' };
  return {
    up: content.slice(upIdx + 5, downIdx),
    down: content.slice(downIdx + 7),
  };
}

export function timestampSlug(slug: string): string {
  const t = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, '').replace('T', 'T');
  return `${t}_${slug}`;
}

export function writeMigrationFile(name: string, content: string): string {
  if (!fs.existsSync(MIGRATIONS_DIR)) fs.mkdirSync(MIGRATIONS_DIR, { recursive: true });
  const file = path.join(MIGRATIONS_DIR, `${name}.sql`);
  fs.writeFileSync(file, content, 'utf8');
  return file;
}

export function readMigrationFile(name: string): string | null {
  const file = path.join(MIGRATIONS_DIR, `${name}.sql`);
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
}
