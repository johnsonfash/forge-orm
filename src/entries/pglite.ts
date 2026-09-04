// forge-orm/pglite — PGlite imported statically.
//
// The main entry reaches PGlite from a `pglite:` URL, and the pglite driver
// factory imports the package dynamically so it stays optional. Neither is
// something a bundler can follow, and PGlite's whole point is running where
// a bundle does — a browser tab, a Worker, a bundled function. So this entry
// takes the static import, which is the only reason it exists.
import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite/vector';
import { pgliteDriver, pgliteDataDir } from '../adapters/postgres/pglite-driver';
import { connectWith, type DialectDbOptions } from './_shared';
import type { SchemaShape } from '../schema/active';
import type { SchemaMap } from '../schema';

export async function createDb<S extends SchemaShape = SchemaMap>(
  opts: DialectDbOptions<S>,
) {
  return connectWith<S>('pglite', async (url) => {
    // `create` waits for the WASM boot; the constructor alone does not, and
    // the first query would race it.
    const pg = await PGlite.create(pgliteDataDir(url), { extensions: { vector } });
    // Registering pgvector is only half of it — Postgres still needs the
    // CREATE, or `f.vector()` fails at CREATE TABLE with "type vector does
    // not exist".
    try { await pg.query('CREATE EXTENSION IF NOT EXISTS vector'); } catch { /* not in this build */ }
    return pgliteDriver(pg);
  }, opts);
}

export * from './_shared';
