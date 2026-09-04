// forge-orm/mysql — `mysql2` imported statically, so bundlers see it.
import mysql from 'mysql2/promise';
import { mysql2Driver } from '../adapters/mysql/driver';
import { connectWith, type DialectDbOptions } from './_shared';
import type { SchemaShape } from '../schema/active';
import type { SchemaMap } from '../schema';

export async function createDb<S extends SchemaShape = SchemaMap>(
  opts: DialectDbOptions<S>,
) {
  return connectWith<S>('mysql', (url) => mysql2Driver(mysql.createPool(url)), opts);
}

export * from './_shared';
