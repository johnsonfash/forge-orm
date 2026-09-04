// forge-orm/mongo — the mongodb client imported statically.
import { MongoClient } from 'mongodb';
import { mongoDriver } from '../adapters/mongo/driver';
import { connectWith, type DialectDbOptions } from './_shared';
import type { SchemaShape } from '../schema/active';
import type { SchemaMap } from '../schema';

export async function createDb<S extends SchemaShape = SchemaMap>(
  opts: DialectDbOptions<S> & { database?: string },
) {
  return connectWith<S>(
    'mongo',
    (url) => mongoDriver(new MongoClient(url), opts.database),
    opts,
  );
}

export * from './_shared';
