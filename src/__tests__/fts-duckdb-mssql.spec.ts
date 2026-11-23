// `.searchable()` on DuckDB and SQL Server compiled to ILIKE / LIKE '%term%'
// always, ignoring a full-text index that was there. Both adapters now look
// the index up (once per table) and use it — DuckDB's fts `match_bm25`, SQL
// Server's CONTAINS — keeping LIKE for a column without one.

import { f, model } from '../schema/core';
import { openDuckdb } from './_live-dbs';
import { createDb } from '../factory';
import { containsCondition } from '../adapters/mssql/dialect';

const Post = model('posts', {
  id: f.id({ type: 'string' }),
  body: f.text().searchable(),
  title: f.string().searchable(),
});
const schema = { post: Post };

describe('DuckDB full-text', () => {
  let live: Awaited<ReturnType<typeof openDuckdb>> | null = null;
  let ftsAvailable = true;
  beforeAll(async () => {
    live = await openDuckdb(schema);
    await live.db.post.createMany({ data: [
      { id: 'a', body: 'alpha kilo bravo', title: 'one' },
      { id: 'b', body: 'kilogram of charlie', title: 'two' },
      { id: 'c', body: 'delta echo', title: 'kilo three' },
      { id: 'd', body: 'kilo delta', title: 'four' },
    ] });
    try {
      await live.db.$executeRaw`LOAD fts`;
    } catch {
      ftsAvailable = false;
    }
  });
  afterAll(() => live?.close());

  const sqlOf = async (fn: () => Promise<unknown>) => {
    const seen: string[] = [];
    const on = (e: any) => seen.push(e.sql);
    live!.db.$on('query', on);
    try { await fn(); } finally { live!.db.$off('query', on); }
    return seen.join('\n');
  };

  it('falls back to ILIKE with no index', async () => {
    const sql = await sqlOf(() => live!.db.post.findMany({ where: { body: { search: 'kilo' } } }));
    expect(sql).toMatch(/ILIKE/);
    const rows = await live!.db.post.findMany({ where: { body: { search: 'kilo' } }, orderBy: { id: 'asc' } });
    expect(rows.map((r: any) => r.id)).toEqual(['a', 'b', 'd']);
  });

  it('uses match_bm25 once an index covers the column, and words not substrings', async () => {
    if (!ftsAvailable) return;
    await live!.db.$executeRaw`PRAGMA create_fts_index('posts', 'id', 'body', overwrite = 1)`;
    // A table with no index is re-checked after a few seconds; skip the wait.
    (live!.db.adapter as any)._fts.clear();
    const sql = await sqlOf(() => live!.db.post.findMany({ where: { body: { search: 'kilo' } } }));
    expect(sql).toMatch(/"fts_main_posts"\.match_bm25\("posts"\."id", \$1, fields := 'body', conjunctive := 1\) IS NOT NULL/);
    const rows = await live!.db.post.findMany({ where: { body: { search: 'kilo' } }, orderBy: { id: 'asc' } });
    expect(rows.map((r: any) => r.id)).toEqual(['a', 'd']);
    expect(await live!.db.post.count({ where: { body: { search: 'delta kilo' } } })).toBe(1);
  });

  it('keeps ILIKE for a searchable column the index does not cover', async () => {
    if (!ftsAvailable) return;
    const sql = await sqlOf(() => live!.db.post.findMany({ where: { title: { search: 'kilo' } } }));
    expect(sql).toMatch(/"posts"\."title" ILIKE/);
  });
});

describe('SQL Server full-text', () => {
  function fakeMssql(indexed: string[]) {
    const seen: string[] = [];
    const query = async (sql: string) => {
      seen.push(sql);
      if (/sys\.fulltext_index_columns/.test(sql)) return { rows: indexed.map((field) => ({ field })), rowCount: indexed.length };
      return { rows: [], rowCount: 0 };
    };
    return { seen, driver: { kind: 'mssql', query, transaction: async (fn: any) => fn({ query }), close: async () => {} } };
  }

  it('uses CONTAINS with every word required on an indexed column', async () => {
    const { seen, driver } = fakeMssql(['body']);
    const db: any = await createDb({ schema, driver } as never);
    await db.post.findMany({ where: { body: { search: 'kilo  "bravo' } } });
    const sel = seen.filter((s) => /^SELECT .* FROM \[posts\]/.test(s));
    expect(sel[0]).toMatch(/CONTAINS\(\[posts\]\.\[body\], @p1\)/);
    expect(containsCondition('kilo  "bravo')).toBe('"kilo" AND """bravo"');
    await db.post.findMany({ where: { title: { search: 'kilo' } } });
    expect(seen.filter((s) => /FROM \[posts\]/.test(s)).pop()).toMatch(/LIKE/);
  });

  it('keeps LIKE when there is no full-text index', async () => {
    const { seen, driver } = fakeMssql([]);
    const db: any = await createDb({ schema, driver } as never);
    await db.post.count({ where: { body: { search: 'kilo' } } });
    expect(seen.filter((s) => /FROM \[posts\]/.test(s)).pop()).toMatch(/LIKE '%' \+ @p1 \+ '%'/);
  });
});
