// Types for the migration-file runner, kept apart from migrate-files.ts so
// the public entry can export them without reaching a module that imports
// node:fs.

export interface MigrationFile {
  /** Ledger name: the file name without `.sql`. */
  name: string;
  file: string;
  /** What runs: the `-- up` section, or the whole file when it has none. */
  sql: string;
  /** sha256 of `sql`, line endings normalised. */
  checksum: string;
  transactional: boolean;
}

export interface MigrateFilesOptions {
  /** Folder holding the `.sql` files. Default `./migrations`. */
  dir?: string;
  logger?: (line: string) => void;
  /** Report what would run; write nothing, not even the ledger table. */
  dryRun?: boolean;
  /** Apply a pending file numbered behind one already applied. */
  allowOutOfOrder?: boolean;
  /** Proceed although the ledger holds migrations this folder does not. */
  allowUnknown?: boolean;
}

export interface MigrateFilesReport {
  applied: Array<{ name: string; ms: number }>;
  /** Already in the ledger with a matching checksum. */
  skipped: string[];
  /** What would run (dry run), or what is still pending after a stop. */
  pending: string[];
}
