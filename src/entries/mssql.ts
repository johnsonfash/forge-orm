// forge-orm/mssql — the `mssql` client imported statically.
import sql from 'mssql';
import { mssqlDriver } from '../adapters/mssql/driver';
import { connectWith, type DialectDbOptions } from './_shared';
import type { SchemaShape } from '../schema/active';
import type { SchemaMap } from '../schema';

export async function createDb<S extends SchemaShape = SchemaMap>(
  opts: DialectDbOptions<S>,
) {
  return connectWith<S>(
    'mssql',
    async (url) => mssqlDriver(await sql.connect(url)) as never,
    opts,
  );
}

export * from './_shared';
