// PGlite — Postgres compiled to WASM, running in-process.
//
// `DRIVERS.md` has always documented how to hand-roll this driver and pass
// it as `createDb({ driver })`. What it did not have was a URL, so
//
//     createDb({ url: 'pglite:./data' })
//
// failed with "Could not infer adapter from URL" — including in the two
// PGlite examples the README links as one-click StackBlitz demos, and in
// six others beside them. The wrapper is twenty lines and identical every
// time, so it belongs here rather than in every consumer.
//
// PGlite speaks Postgres, so everything downstream is the postgres
// adapter unchanged: same compiler, same executors, same dialect.

import type { PgQueryable, PostgresDriver } from './driver';

/** `pglite:./data` → `./data`; bare `pglite:` → in-memory. */
export function pgliteDataDir(url: string): string | undefined {
  const rest = url.replace(/^pglite:(\/\/)?/i, '').trim();
  // PGlite treats `memory://` as ephemeral, and so does an empty dir.
  if (!rest || rest === ':memory:' || rest === 'memory://') return undefined;
  return rest;
}

/**
 * Wrap an already-constructed PGlite instance.
 *
 * Exported so callers who need constructor options (extensions, a custom
 * filesystem, a shared worker) can build their own instance and still get
 * the driver plumbing.
 */
export function pgliteDriver(pg: {
  query(sql: string, params?: unknown[]): Promise<{ rows: unknown[]; affectedRows?: number }>;
  close(): Promise<void>;
}): PostgresDriver {
  const queryable: PgQueryable = {
    query: async (sql, params) => {
      const r = await pg.query(sql, (params ?? []) as unknown[]);
      return {
        rows: r.rows as any[],
        // PGlite reports writes as `affectedRows` and leaves it undefined
        // for reads. `?? rows.length` covers both, and RETURNING rows come
        // back in `rows` exactly as they do on the wire protocol.
        rowCount: (r.affectedRows ?? r.rows.length) as number,
      };
    },
  };
  return {
    kind: 'postgres',
    query: queryable.query,
    // PGlite is a single in-process database with no pool, so the
    // "session" is the same instance. BEGIN/COMMIT still nest correctly
    // because there is exactly one connection to serialise on.
    transaction: async (fn) => {
      await pg.query('BEGIN');
      try {
        const out = await fn(queryable);
        await pg.query('COMMIT');
        return out;
      } catch (err) {
        try { await pg.query('ROLLBACK'); } catch { /* the original error is the useful one */ }
        throw err;
      }
    },
    close: async () => { await pg.close(); },
  };
}

/**
 * Build a PGlite-backed driver from a `pglite:` URL, importing the package
 * lazily so it is never a hard dependency of forge.
 */
export async function pgliteDriverFromUrl(url: string): Promise<PostgresDriver> {
  let mod: any;
  try {
    mod = await import(/* @vite-ignore */ '@electric-sql/pglite');
  } catch {
    throw new Error(
      `[forge] '${url}' needs the PGlite package, which is not installed.\n` +
      `  → npm i @electric-sql/pglite\n` +
      `  It is an optional peer: forge only loads it when a URL asks for it.`,
    );
  }
  const PGlite = mod.PGlite ?? mod.default?.PGlite ?? mod.default;
  if (typeof PGlite !== 'function') {
    throw new Error(
      `[forge] '@electric-sql/pglite' did not export a PGlite constructor. ` +
      `Build an instance yourself and pass createDb({ driver: pgliteDriver(pg) }).`,
    );
  }
  const dir = pgliteDataDir(url);
  const extensions = await loadPgliteExtensions();
  // `create` waits for the WASM boot; the constructor alone does not, and
  // the first query would race it.
  const pg = typeof PGlite.create === 'function'
    ? await PGlite.create(dir, Object.keys(extensions).length ? { extensions } : undefined)
    : new PGlite(dir);
  if (typeof pg.waitReady?.then === 'function') await pg.waitReady;

  // Registering the extension is only half of it — Postgres still needs the
  // CREATE. Done here rather than from $migrate so `f.vector()` works on a
  // pglite: URL whichever way the tables were made. It is a no-op on a
  // database that already has it, and PGlite is single-user and embedded,
  // so none of the reasons `--enable-extensions` is opt-in on a real server
  // (superuser rights, a shared database) apply.
  if (extensions.vector) {
    try {
      await pg.query('CREATE EXTENSION IF NOT EXISTS vector');
    } catch {
      // An older PGlite that exports the module but cannot install it —
      // let the failure surface where it means something, on the CREATE
      // TABLE that actually needs the type.
    }
  }
  return pgliteDriver(pg);
}

/**
 * PGlite's bundled extensions, where this build has them.
 *
 * pgvector ships inside the package as `@electric-sql/pglite/vector` on
 * 0.2.x. It is not there on every version — 0.5.x drops it from the bundle
 * — so this resolves what it can and returns what it found, rather than
 * making `f.vector()` a hard requirement on a particular PGlite release.
 */
async function loadPgliteExtensions(): Promise<Record<string, unknown>> {
  const found: Record<string, unknown> = {};
  for (const spec of ['@electric-sql/pglite/vector', '@electric-sql/pglite/contrib/vector']) {
    try {
      const mod: any = await import(/* @vite-ignore */ spec);
      const ext = mod.vector ?? mod.default?.vector ?? mod.default;
      if (ext) { found.vector = ext; break; }
    } catch { /* not in this build — carry on */ }
  }
  return found;
}
