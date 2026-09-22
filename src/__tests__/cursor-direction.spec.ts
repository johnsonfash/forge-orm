import { f, model } from '../schema/core';
import type { ModelDef } from '../schema/types';
import { buildSelect } from '../ir/build';
import { compileSelect } from '../adapters/postgres/compile-from-ir';
import { compileSelect as compileMongoSelect } from '../adapters/mongo/compile-from-ir';
import { MssqlDialect } from '../adapters/mssql/dialect';

// Keyset pagination has to agree with the sort order it pages through. The
// bug these pin: the comparison was a hardcoded `>` / `$gt`, so the single
// most common feed query — newest first — paged backwards and re-served rows
// it had already returned.

const Post: ModelDef<any> = model('posts', {
  id: f.id(),
  score: f.int(),
  created_at: f.dateTime(),
}) as unknown as ModelDef<any>;

const sql = (args: any) =>
  (compileSelect(buildSelect('post', Post, args, 'many'), Post) as any).sql as string;

const mongoFilter = (args: any) =>
  (compileMongoSelect(buildSelect('post', Post, args, 'many'), Post) as any).args.filter;

describe('SQL keyset cursor — direction', () => {
  test('ascending sort pages forward with >', () => {
    expect(sql({ orderBy: { created_at: 'asc' }, cursor: { created_at: 'X' }, take: 20 }))
      .toContain('"created_at" > $');
  });

  test('descending sort pages forward with < , not >', () => {
    const out = sql({ orderBy: { created_at: 'desc' }, cursor: { created_at: 'X' }, take: 20 });
    expect(out).toContain('"created_at" < $');
    expect(out).not.toContain('"created_at" > $');
  });

  test('a cursor key with no orderBy entry stays ascending', () => {
    expect(sql({ cursor: { id: 'abc' }, take: 5 })).toContain('"id" > $');
  });

  test('uniform descending composite uses a row comparison with <', () => {
    const out = sql({
      orderBy: [{ score: 'desc' }, { id: 'desc' }],
      cursor: { score: 5, id: 'abc' },
      take: 10,
    });
    expect(out).toMatch(/\("posts"\."score", "posts"\."id"\) < \(\$\d+, \$\d+\)/);
  });

  test('mixed directions expand lexicographically instead of one row comparison', () => {
    // `(a, b) > (x, y)` applies ONE operator to the whole tuple, so it cannot
    // express "score descending, id ascending" at all.
    const out = sql({
      orderBy: [{ score: 'desc' }, { id: 'asc' }],
      cursor: { score: 5, id: 'abc' },
      take: 10,
    });
    expect(out).toContain('"score" < $');
    expect(out).toContain('"score" = $');
    expect(out).toContain('"id" > $');
    expect(out).toContain(' OR ');
    expect(out).not.toMatch(/\("posts"\."score", "posts"\."id"\) [<>]/);
  });
});

describe('T-SQL has no row comparison', () => {
  test('mssql expands even when the directions are uniform', () => {
    const node = buildSelect('post', Post, {
      orderBy: [{ score: 'desc' }, { id: 'desc' }],
      cursor: { score: 5, id: 'abc' },
      take: 10,
    }, 'many');
    const out = (compileSelect(node, Post, MssqlDialect) as any).sql as string;
    expect(out).not.toMatch(/\) < \(/);
    expect(out).toContain(' OR ');
  });

  test('postgres still gets the row comparison — the expansion is not universal', () => {
    expect(sql({
      orderBy: [{ score: 'desc' }, { id: 'desc' }],
      cursor: { score: 5, id: 'abc' },
      take: 10,
    })).toMatch(/\) < \(/);
  });
});

describe('Mongo keyset cursor', () => {
  test('descending sort uses $lt', () => {
    const fil = mongoFilter({ orderBy: { score: 'desc' }, cursor: { score: 5 }, take: 10 });
    expect(JSON.stringify(fil)).toContain('$lt');
    expect(JSON.stringify(fil)).not.toContain('$gt');
  });

  test('ascending sort uses $gt', () => {
    const fil = mongoFilter({ orderBy: { score: 'asc' }, cursor: { score: 5 }, take: 10 });
    expect(JSON.stringify(fil)).toContain('$gt');
  });

  test('a composite cursor is a real tuple comparison, not an AND of two $gt', () => {
    // The old shape was { $and: [ {score: {$gt: 5}}, {id: {$gt: 'abc'}} ] }.
    // Sorted by (score, id), the row after (5, 'abd') is (5, 'abe') — which
    // has score 5, NOT > 5, so the $and rejected it. Every row sharing the
    // cursor's leading value was skipped.
    const fil: any = mongoFilter({
      orderBy: [{ score: 'asc' }, { id: 'asc' }],
      cursor: { score: 5, id: 'abc' },
      take: 10,
    });
    expect(fil.$or).toBeDefined();
    expect(fil.$or).toHaveLength(2);
    expect(fil.$or[0]).toEqual({ score: { $gt: 5 } });
    expect(fil.$or[1].$and[0]).toEqual({ score: 5 });
    // `id` is the public name of Mongo's `_id`, so the compiled filter uses _id.
    expect(fil.$or[1].$and[1]).toEqual({ _id: { $gt: 'abc' } });
  });

  test('mixed directions are honoured per key', () => {
    const fil: any = mongoFilter({
      orderBy: [{ score: 'desc' }, { id: 'asc' }],
      cursor: { score: 5, id: 'abc' },
      take: 10,
    });
    expect(fil.$or[0]).toEqual({ score: { $lt: 5 } });
    expect(fil.$or[1].$and[1]).toEqual({ _id: { $gt: 'abc' } });
  });
});
