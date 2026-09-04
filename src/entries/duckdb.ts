// forge-orm/duckdb — `@duckdb/node-api` imported statically.
import { DuckDBInstance } from '@duckdb/node-api';
import { duckdbDriver } from '../adapters/duckdb/driver';
import { connectWith, type DialectDbOptions } from './_shared';
import type { SchemaShape } from '../schema/active';
import type { SchemaMap } from '../schema';

export async function createDb<S extends SchemaShape = SchemaMap>(
  opts: DialectDbOptions<S>,
) {
  return connectWith<S>('duckdb', async (url) => {
    const path = url.replace(/^duckdb:(\/\/)?/i, '') || ':memory:';
    const instance = await DuckDBInstance.create(path);
    return duckdbDriver(await instance.connect()) as never;
  }, opts);
}

export * from './_shared';
