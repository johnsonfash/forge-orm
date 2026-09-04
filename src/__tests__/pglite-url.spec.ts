// `pglite:` as a first-class URL.
//
// DRIVERS.md has always shown how to hand-wrap PGlite and pass it as
// `createDb({ driver })`. What it never had was a URL — so
// `createDb({ url: 'pglite:./data' })` failed with "Could not infer
// adapter from URL", including in the two PGlite demos the README links
// as one-click StackBlitz projects, and six more examples beside them.
//
// PGlite is Postgres compiled to WASM. It speaks the same protocol, so it
// resolves to the postgres adapter unchanged; only the driver differs.

import { detectAdapterKind } from '../adapters/detect';
import { pgliteDataDir, pgliteDriver } from '../adapters/postgres/pglite-driver';

describe('detecting a pglite URL', () => {
  it('resolves to the postgres adapter', () => {
    expect(detectAdapterKind('pglite:./data')).toBe('postgres');
  });

  it('is case-insensitive, like every other prefix', () => {
    expect(detectAdapterKind('PGLite:./data')).toBe('postgres');
  });

  it('a bare pglite: is still postgres', () => {
    expect(detectAdapterKind('pglite:')).toBe('postgres');
  });

  it('does not shadow a real postgres:// URL', () => {
    expect(detectAdapterKind('postgres://user@host/db')).toBe('postgres');
    expect(detectAdapterKind('postgresql://user@host/db')).toBe('postgres');
  });

  it('leaves every other scheme alone', () => {
    expect(detectAdapterKind('sqlite://x.db')).toBe('sqlite');
    expect(detectAdapterKind('mongodb://h/db')).toBe('mongo');
    expect(detectAdapterKind('idb:app')).toBe('indexeddb');
    expect(detectAdapterKind('nonsense://x')).toBeNull();
  });
});

describe('the data directory', () => {
  it('is whatever follows the scheme', () => {
    expect(pgliteDataDir('pglite:./tx')).toBe('./tx');
    expect(pgliteDataDir('pglite:/var/lib/app')).toBe('/var/lib/app');
  });

  it('tolerates the // form', () => {
    expect(pgliteDataDir('pglite://./tx')).toBe('./tx');
  });

  it('is undefined — ephemeral — when no path is given', () => {
    expect(pgliteDataDir('pglite:')).toBeUndefined();
    expect(pgliteDataDir('pglite::memory:')).toBeUndefined();
    expect(pgliteDataDir('pglite:memory://')).toBeUndefined();
  });
});

describe('the driver wrapper', () => {
  const fakePg = (rows: unknown[], affectedRows?: number) => {
    const seen: string[] = [];
    const pg = {
      query: async (sql: string) => { seen.push(sql); return { rows, affectedRows }; },
      close: async () => { seen.push('CLOSE'); },
    };
    return { pg, seen };
  };

  it('reports rowCount from affectedRows on a write', async () => {
    const { pg } = fakePg([], 3);
    const d = pgliteDriver(pg);
    expect((await d.query('UPDATE x SET y = 1')).rowCount).toBe(3);
  });

  it('falls back to the row count on a read, where affectedRows is absent', async () => {
    const { pg } = fakePg([{ a: 1 }, { a: 2 }]);
    const d = pgliteDriver(pg);
    expect((await d.query('SELECT 1')).rowCount).toBe(2);
  });

  it('returns RETURNING rows rather than filtering them out', async () => {
    const { pg } = fakePg([{ id: 'x' }], 1);
    const d = pgliteDriver(pg);
    expect((await d.query('UPDATE x SET y = 1 RETURNING *')).rows).toEqual([{ id: 'x' }]);
  });

  it('wraps a transaction in BEGIN/COMMIT', async () => {
    const { pg, seen } = fakePg([]);
    await pgliteDriver(pg).transaction(async (s) => { await s.query('SELECT 1'); });
    expect(seen).toEqual(['BEGIN', 'SELECT 1', 'COMMIT']);
  });

  it('rolls back on a throw, and rethrows the ORIGINAL error', async () => {
    const { pg, seen } = fakePg([]);
    await expect(
      pgliteDriver(pg).transaction(async () => { throw new Error('boom'); }),
    ).rejects.toThrow('boom');
    expect(seen).toEqual(['BEGIN', 'ROLLBACK']);
  });

  it('a failing ROLLBACK does not mask the error that caused it', async () => {
    const pg = {
      query: async (sql: string) => {
        if (sql === 'ROLLBACK') throw new Error('connection gone');
        return { rows: [], affectedRows: 0 };
      },
      close: async () => {},
    };
    await expect(
      pgliteDriver(pg).transaction(async () => { throw new Error('the real problem'); }),
    ).rejects.toThrow('the real problem');
  });
});
