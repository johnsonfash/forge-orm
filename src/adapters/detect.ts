import type { AdapterKind } from './types';

// Detect the adapter kind from a connection-string prefix. Returns `null` if
// the prefix is unrecognised — callers should treat that as an actionable
// error and prompt the user to pass `type:` explicitly.

const URL_PREFIX_TO_KIND: Array<[RegExp, AdapterKind]> = [
  [/^mongodb(\+srv)?:\/\//i, 'mongo'],
  [/^postgres(ql)?:\/\//i, 'postgres'],
  [/^(mysql|mariadb):\/\//i, 'mysql'],
  [/^(sqlite:|file:)/i, 'sqlite'],
  [/^duckdb:/i, 'duckdb'],
  // mssql / sqlserver — both prefixes are in the wild.
  [/^(mssql|sqlserver):\/\//i, 'mssql'],
];

export function detectAdapterKind(url: string): AdapterKind | null {
  for (const [re, kind] of URL_PREFIX_TO_KIND) {
    if (re.test(url)) return kind;
  }
  // Bare file paths ending in .db / .sqlite → sqlite, .duckdb → duckdb.
  if (/\.(db|sqlite|sqlite3)$/i.test(url)) return 'sqlite';
  if (/\.duckdb$/i.test(url)) return 'duckdb';
  return null;
}

export const DRIVER_PACKAGE_FOR: Record<AdapterKind, string> = {
  mongo: 'mongodb',
  postgres: 'pg',
  mysql: 'mysql2',
  sqlite: 'better-sqlite3',
  duckdb: '@duckdb/node-api',
  mssql: 'mssql',
};
