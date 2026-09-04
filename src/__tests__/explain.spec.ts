// `db.$explain()` — see the query without running it.
//
// The load-bearing claim is the second half of that sentence. A dry run
// that turns out to have run is worse than no dry run at all, so the
// driver here counts every call it receives and the tests assert zero.

import { createDb } from '../factory';
import { f, model } from '../schema/core';
import {
  fragmentFromSql,
  inlineParams,
  splitSql,
  formatExplain,
  type ExplainReport,
} from '../explain';
import type { SqliteDriver } from '../adapters/sqlite/driver';

const User = model('users', {
  id: f.id(),
  name: f.string(),
  age: f.int(),
});
const appSchema = { User } as any;

/** Records every call, so "nothing ran" is a measurement, not a hope. */
function countingDriver() {
  const calls: string[] = [];
  const driver: SqliteDriver = {
    kind: 'sqlite',
    all: async (sql: string) => { calls.push(sql); return []; },
    get: async (sql: string) => { calls.push(sql); return undefined; },
    run: async (sql: string) => { calls.push(sql); return { changes: 0 }; },
    exec: async (sql: string) => { calls.push(sql); },
    close: async () => {},
  } as unknown as SqliteDriver;
  return { driver, calls };
}

/**
 * A connected db whose call log starts empty.
 *
 * The sqlite adapter issues its own statements on connect (`PRAGMA
 * foreign_keys = ON`, the spatialite probe). Counting those as "the
 * query ran" would have made every assertion below fail for a reason
 * that has nothing to do with $explain — so the log is cleared once the
 * connection is up, and everything after it is the code under test.
 */
const newDb = async () => {
  const { driver, calls } = countingDriver();
  const db = (await createDb({ schema: appSchema, driver })) as any;
  calls.length = 0;
  return { db, calls };
};

describe('splitting compiled SQL at its placeholders', () => {
  it('sequential ? placeholders', () => {
    const r = splitSql('SELECT * FROM t WHERE a = ? AND b = ?', 'sqlite');
    expect(r.chunks).toEqual(['SELECT * FROM t WHERE a = ', ' AND b = ', '']);
    expect(r.holes).toEqual([0, 1]);
  });

  it('numbered $n placeholders map to their own index', () => {
    const r = splitSql('SELECT * FROM t WHERE a = $2 AND b = $1', 'postgres');
    expect(r.holes).toEqual([1, 0]);
  });

  it('a repeated $1 binds the same value twice', () => {
    const r = splitSql('SELECT * FROM t WHERE a = $1 OR b = $1', 'postgres');
    expect(r.holes).toEqual([0, 0]);
  });

  // The cases a regex gets wrong, silently, on SQL that still parses.
  it('ignores a ? inside a string literal', () => {
    const r = splitSql("SELECT * FROM t WHERE a LIKE 'who?' AND b = ?", 'sqlite');
    expect(r.holes).toEqual([0]);
    expect(r.chunks[0]).toBe("SELECT * FROM t WHERE a LIKE 'who?' AND b = ");
  });

  it("a doubled quote is an escaped quote, not the end of the literal", () => {
    const r = splitSql("SELECT 'it''s ? here' , ?", 'sqlite');
    expect(r.holes).toEqual([0]);
  });

  it('ignores placeholders inside quoted identifiers', () => {
    expect(splitSql('SELECT "we?rd" FROM t WHERE a = ?', 'sqlite').holes).toEqual([0]);
    expect(splitSql('SELECT `we?rd` FROM t WHERE a = ?', 'mysql').holes).toEqual([0]);
    expect(splitSql('SELECT [we?rd] FROM t WHERE a = ?', 'mssql').holes).toEqual([0]);
  });

  it('ignores placeholders inside comments', () => {
    expect(splitSql('SELECT 1 -- ? not this\nWHERE a = ?', 'sqlite').holes).toEqual([0]);
    expect(splitSql('SELECT /* ? no */ 1 WHERE a = ?', 'sqlite').holes).toEqual([0]);
  });

  it('a postgres dollar-quoted body is a literal, not a placeholder', () => {
    // $$…$$ and $tag$…$tag$ open a string. The `$1` inside one is text.
    expect(splitSql('SELECT $$ hi $1 $$ , $1', 'postgres').holes).toEqual([0]);
    expect(splitSql('SELECT $tag$ $1 $tag$ , $2', 'postgres').holes).toEqual([1]);
  });

  it('$ before a letter is a dollar-quote tag; $ before a digit is a placeholder', () => {
    expect(splitSql('SELECT $1', 'postgres').holes).toEqual([0]);
  });
});

describe('rebuilding a fragment', () => {
  it('round-trips through the fragment shape the adapters render', () => {
    // Adapters render strings[0] + placeholder + strings[1] + …
    const frag = fragmentFromSql('SELECT * FROM t WHERE a = ? AND b = ?', [7, 'x'], 'sqlite');
    expect(frag.values).toEqual([7, 'x']);
    expect(frag.strings.length).toBe(frag.values.length + 1);
  });

  it('carries the values a repeated $1 refers to, once per occurrence', () => {
    const frag = fragmentFromSql('WHERE a = $1 OR b = $1', ['dup'], 'postgres');
    expect(frag.values).toEqual(['dup', 'dup']);
  });

  it('a prefix lands before the statement, not inside it', () => {
    const frag = fragmentFromSql('SELECT 1 WHERE a = ?', [1], 'sqlite', 'EXPLAIN QUERY PLAN ');
    expect(frag.strings[0]).toBe('EXPLAIN QUERY PLAN SELECT 1 WHERE a = ');
  });
});

describe('inlining values for reading', () => {
  const inline = (s: string, p: unknown[]) => inlineParams(s, p, 'sqlite');

  it('substitutes in order', () => {
    expect(inline('a = ? AND b = ?', [1, 'x'])).toBe("a = 1 AND b = 'x'");
  });

  it('quotes strings and escapes the quote', () => {
    expect(inline('a = ?', ["it's"])).toBe("a = 'it''s'");
  });

  it('renders null, booleans and dates recognisably', () => {
    expect(inline('a = ?', [null])).toBe('a = NULL');
    expect(inline('a = ?', [true])).toBe('a = TRUE');
    expect(inline('a = ?', [new Date('2026-09-04T00:00:00Z')]))
      .toBe("a = '2026-09-04T00:00:00.000Z'");
  });

  it('does not pretend to render a binary blob', () => {
    expect(inline('a = ?', [new Uint8Array(4)])).toBe('a = <4 bytes>');
  });
});

describe('capturing a query without running it', () => {
  it('returns the SQL and its params', async () => {
    const { db, calls } = await newDb();
    const r: ExplainReport = await db.$explain((q: any) =>
      q.User.findMany({ where: { age: { gt: 30 } } }),
    );
    expect(r.queries).toHaveLength(1);
    const a = r.queries[0]!.artifact as any;
    expect(a.kind).toBe('sql');
    expect(a.sql).toMatch(/select/i);
    expect(a.params).toContain(30);
    expect(calls).toEqual([]);            // ← the whole point
  });

  it('names the model, the table and the op', async () => {
    const { db } = await newDb();
    const r = await db.$explain((q: any) => q.User.findMany());
    expect(r.queries[0]!.model).toBe('User');
    expect(r.queries[0]!.table).toBe('users');
    expect(r.queries[0]!.op).toBe('findMany');
  });

  it('captures several queries in one call, in order', async () => {
    const { db, calls } = await newDb();
    const r = await db.$explain((q: any) => {
      q.User.findMany({ where: { age: { gt: 30 } } });
      q.User.count();
    });
    expect(r.queries.map((x: any) => x.op)).toEqual(['findMany', 'count']);
    expect(calls).toEqual([]);
  });

  it('a write compiles too, and still writes nothing', async () => {
    const { db, calls } = await newDb();
    const r = await db.$explain((q: any) =>
      q.User.deleteMany({ where: { age: { lt: 18 } } }),
    );
    expect((r.queries[0]!.artifact as any).sql).toMatch(/delete/i);
    expect(calls).toEqual([]);
  });

  it('an async callback is safe when it takes the capturing db', async () => {
    const { db, calls } = await newDb();
    const r = await db.$explain(async (q: any) => {
      await Promise.resolve();
      return q.User.findMany();
    });
    expect(r.queries).toHaveLength(1);
    expect(calls).toEqual([]);
  });
});

describe('the zero-argument callback form', () => {
  it('works when the query is issued synchronously', async () => {
    const { db, calls } = await newDb();
    const r = await db.$explain(() => db.User.findMany({ where: { age: { gt: 1 } } }));
    expect(r.queries).toHaveLength(1);
    expect(calls).toEqual([]);
  });

  it('closes the window — the SAME call afterwards reaches the driver', async () => {
    // The flag must not outlive the callback. If it did, $explain would
    // quietly turn every later query into a no-op returning [], which is
    // the worst possible failure: a read that succeeds and returns
    // nothing.
    const { db, calls } = await newDb();
    await db.$explain(() => db.User.findMany());
    expect(calls).toEqual([]);

    await db.User.findMany();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatch(/^SELECT/i);
  });

  it('refuses loudly rather than returning an empty report', async () => {
    const { db } = await newDb();
    await expect(db.$explain(() => undefined)).rejects.toThrow(/captured no query/);
  });

  it('says outright that an async zero-arg callback RAN the query', async () => {
    // The dangerous case, and the reason the argument form exists. The
    // window shuts at the first await, so anything after it hits the
    // real driver — the error has to say so, not just report nothing.
    const { db } = await newDb();
    await expect(
      db.$explain(async () => { await Promise.resolve(); return db.User.findMany(); }),
    ).rejects.toThrow(/RAN FOR REAL/);
  });

  it('the fix is in the message', async () => {
    const { db } = await newDb();
    await expect(db.$explain(() => undefined)).rejects.toThrow(/\$explain\(\(q\) =>/);
  });
});

describe('what it refuses, and how it says so', () => {
  it('names the op that has no compiled form', async () => {
    const { db } = await newDb();
    await expect(
      db.$explain((q: any) => q.User.groupBy({ by: ['age'] })),
    ).rejects.toThrow(/cannot compile User\.groupBy/);
  });

  it('an unknown model throws the same way it would outside $explain', async () => {
    const { db } = await newDb();
    await expect(db.$explain((q: any) => q.Nope.findMany())).rejects.toThrow(/Nope/);
  });

  it('the capturing db cannot reach the driver at all', async () => {
    const { db } = await newDb();
    await expect(
      db.$explain((q: any) => q.$queryRaw`SELECT 1`),
    ).rejects.toThrow(/never reaches the driver/);
  });

  it('a non-callback argument is told what the shape is', async () => {
    const { db } = await newDb();
    await expect(db.$explain('SELECT 1' as any)).rejects.toThrow(/takes a callback/);
  });

  it('findFirstOrThrow explains as the query it actually is', async () => {
    // …OrThrow differs only in what it does with an empty result, which
    // happens after the statement. Refusing it would be pedantry.
    const { db } = await newDb();
    const r = await db.$explain((q: any) => q.User.findFirstOrThrow({ where: { age: 1 } }));
    expect((r.queries[0]!.artifact as any).sql).toMatch(/select/i);
    expect(r.queries[0]!.op).toBe('findFirstOrThrow');
  });
});

describe('the report reads like something you can hand to a DBA', () => {
  it('shows the statement, the params and the inlined form', async () => {
    const { db } = await newDb();
    const r = await db.$explain((q: any) => q.User.findMany({ where: { age: { gt: 30 } } }));
    const text = r.toString();
    expect(text).toMatch(/User\.findMany/);
    expect(text).toMatch(/users/);
    expect(text).toMatch(/params: 30/);
    expect(text).toMatch(/for reading, not for running/);
  });

  it('numbers the queries when there is more than one', async () => {
    const { db } = await newDb();
    const r = await db.$explain((q: any) => { q.User.findMany(); q.User.count(); });
    expect(r.toString()).toMatch(/^1\. /m);
    expect(r.toString()).toMatch(/^2\. /m);
  });

  it('says so plainly when there is nothing to show', () => {
    const empty = { dialect: 'sqlite', queries: [], analyzed: false } as any;
    expect(formatExplain(empty)).toBe('(no queries captured)');
  });

  it('reports analyzed=false until a plan is actually fetched', async () => {
    const { db } = await newDb();
    const r = await db.$explain((q: any) => q.User.findMany());
    expect(r.analyzed).toBe(false);
    expect(r.queries[0]!.plan).toBeUndefined();
  });
});

describe('rendering a plan', () => {
  const withPlan = (plan: unknown) =>
    formatExplain({
      dialect: 'sqlite',
      analyzed: true,
      queries: [{
        model: 'User', table: 'users', op: 'findMany',
        artifact: { kind: 'sql', dialect: 'sqlite', sql: 'SELECT 1', params: [] },
        plan,
      }],
    } as any);

  it('lifts sqlite detail lines out of their row wrappers', () => {
    // The useful sentence is `detail`; id/parent/notused are noise at a
    // glance. The raw rows stay on `query.plan` for anyone walking them.
    const text = withPlan([
      { id: 3, parent: 0, notused: 203, detail: 'SEARCH users USING INDEX users_age (age>?)' },
      { id: 7, parent: 0, notused: 0, detail: 'USE TEMP B-TREE FOR ORDER BY' },
    ]);
    expect(text).toMatch(/SEARCH users USING INDEX users_age \(age>\?\)/);
    expect(text).toMatch(/USE TEMP B-TREE FOR ORDER BY/);
    expect(text).not.toMatch(/notused/);
  });

  it('leaves structured postgres/mysql JSON as JSON', () => {
    expect(withPlan([{ Plan: { 'Node Type': 'Seq Scan' } }])).toMatch(/"Node Type": "Seq Scan"/);
  });

  it('passes a plain string through', () => {
    expect(withPlan('Seq Scan on users')).toMatch(/Seq Scan on users/);
  });
});

describe('analyze — the database plans it, and still never runs it', () => {
  it('sends EXPLAIN QUERY PLAN on sqlite, once, with the params bound', async () => {
    const { db, calls } = await newDb();
    const r = await db.$explain(
      (q: any) => q.User.findMany({ where: { age: { gt: 30 } } }),
      { analyze: true },
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatch(/^EXPLAIN QUERY PLAN SELECT/i);
    // The statement is planned, not executed — the bare SELECT never ran.
    expect(calls.filter((c) => /^SELECT/i.test(c))).toEqual([]);
    expect(r.analyzed).toBe(true);
  });

  it('never emits EXPLAIN ANALYZE, which would execute the statement', async () => {
    const { db, calls } = await newDb();
    await db.$explain((q: any) => q.User.deleteMany({ where: { age: { lt: 1 } } }), {
      analyze: true,
    });
    expect(calls.join(' ')).not.toMatch(/EXPLAIN ANALYZE/i);
  });
});
