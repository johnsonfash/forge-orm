// Per-dialect entry points — `forge-orm/postgres`, `forge-orm/mysql`, …
//
// The main entry resolves your driver from the URL prefix, which reads
// well and swaps databases with an env var. It does it with
// `require(pkg)` where `pkg` is computed at runtime, and a bundler cannot
// see through that: webpack, rollup, esbuild and Vite all lose the
// dependency, so a bundled target (Cloudflare Workers, Vercel Edge, a
// bundled Lambda) either drops the driver or fails at runtime, far from
// the cause. It also means no adapter can be tree-shaken, because nothing
// proves which one you use.
//
// These entries import one driver STATICALLY. The bundler sees it, the
// other five adapters fall away, and the call site stays as short as the
// URL form:
//
//     import { createDb } from 'forge-orm/postgres';
//     const db = await createDb({ url, schema });
//
// What you give up is the env-var swap: this call site is a Postgres call
// site. That is the trade, and it is the right way round for a deploy
// target where the bundle is fixed anyway.

import type { CreateDbOptions, ForgeDb } from '../factory';
import type { SchemaShape } from '../schema/active';
import type { SchemaMap } from '../schema';
import type { ForgeDriver } from '../factory';

/** Options for a per-dialect entry: the dialect is implied by the import. */
export type DialectDbOptions<S extends SchemaShape = SchemaMap> = Omit<
  Extract<CreateDbOptions, { url: string }>,
  'type' | 'driver'
> & { schema?: S };

/**
 * Shared plumbing: build the driver, hand it to the real createDb.
 *
 * Written as a factory so each entry file is a static import plus three
 * lines, and so a driver that fails to construct reports the dialect it
 * was for.
 */
export async function connectWith<S extends SchemaShape = SchemaMap>(
  dialect: string,
  build: (url: string) => ForgeDriver | Promise<ForgeDriver>,
  opts: DialectDbOptions<S>,
): Promise<ForgeDb<S>> {
  const { createDb } = await import('../factory');
  if (!opts?.url) {
    throw new Error(
      `[forge] createDb from 'forge-orm/${dialect}' needs a url. ` +
      `Build the client yourself and use the main entry's driver option if ` +
      `you need to configure it.`,
    );
  }
  const driver = await build(opts.url);
  return createDb({ ...opts, driver } as CreateDbOptions & { schema?: S }) as Promise<ForgeDb<S>>;
}

export * from '../index';
