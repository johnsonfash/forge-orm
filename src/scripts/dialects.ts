// One place that maps an adapter kind to its SQL dialect helpers.
//
// `migrate-gen.ts` had this privately; `snapshot.ts` needs the same
// mapping to project a schema's column types. Two copies of a lookup
// like this drift the moment a dialect is added — the second one keeps
// compiling and quietly returns null.
import type { Dialect } from '../adapters/postgres/dialect';
import { PostgresDialect } from '../adapters/postgres/dialect';
import { MysqlDialect } from '../adapters/mysql/dialect';
import { SqliteDialect } from '../adapters/sqlite/dialect';

/** `null` for adapters with no SQL DDL — Mongo, and anything else
 *  schemaless. Callers must handle it rather than assume SQL. */
export function dialectFor(kind: string): Dialect | null {
  if (kind === 'postgres') return PostgresDialect;
  if (kind === 'mysql') return MysqlDialect;
  if (kind === 'sqlite') return SqliteDialect;
  return null;
}
