// forge-orm/postgres — `pg` imported statically, so bundlers see it.
import pg from 'pg';
import { pgDriver } from '../adapters/postgres/driver';
import { connectWith, type DialectDbOptions } from './_shared';
import type { SchemaShape } from '../schema/active';
import type { SchemaMap } from '../schema';

export async function createDb<S extends SchemaShape = SchemaMap>(
  opts: DialectDbOptions<S>,
) {
  return connectWith<S>('postgres', (url) => pgDriver(new pg.Pool({ connectionString: url })), opts);
}

export * from './_shared';
