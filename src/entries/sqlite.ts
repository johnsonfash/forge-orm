// forge-orm/sqlite — `better-sqlite3` imported statically, so bundlers see it.
import Database from 'better-sqlite3';
import { betterSqlite3Driver } from '../adapters/sqlite/driver';
import { connectWith, type DialectDbOptions } from './_shared';
import type { SchemaShape } from '../schema/active';
import type { SchemaMap } from '../schema';

/** `sqlite:./app.db`, `file:./app.db` or a bare path. */
function filename(url: string): string {
  return url.replace(/^(sqlite|file):(\/\/)?/i, '') || ':memory:';
}

export async function createDb<S extends SchemaShape = SchemaMap>(
  opts: DialectDbOptions<S>,
) {
  return connectWith<S>('sqlite', (url) => betterSqlite3Driver(new Database(filename(url))), opts);
}

export * from './_shared';
