import { f, model, rel } from '../schema/core';
import type { ModelDef } from '../schema/types';
import { buildSelect, buildUpdate, buildWhereTree } from '../ir/build';
import { col, isColRef, colRefField, FORGE_COL } from '../col';
import { compileSelect as mongoSelect } from '../adapters/mongo/compile-from-ir';
import { compileSelect as pgSelect, compileUpdate as pgUpdate } from '../adapters/postgres/compile-from-ir';
import { compileSelect as mysqlSelect } from '../adapters/mysql/compile-from-ir';
import { compileSelect as sqliteSelect } from '../adapters/sqlite/compile-from-ir';

// A promo-shaped model: the canonical use case is the guarded counter update
// `currentUsage < globalLimit`.
const Promo = model('promos', {
  id: f.id(),
  code: f.string(),
  currentUsage: f.int().default(0),
  globalLimit: f.int().default(0),
  startsAt: f.dateTime().optional(),
  endsAt: f.dateTime().optional(),
  ownerId: f.objectId().optional(),
  refId: f.objectId().optional(),
}) as unknown as ModelDef<any>;

// A model with a relation, to prove col() rejects relation references.
const User = model('users', {
  id: f.id(),
  age: f.int().default(0),
  minAge: f.int().default(0),
}, (m: any) => ({
  posts: rel.many('post', { on: 'author_id', refs: 'id' }),
})) as unknown as ModelDef<any>;

const leaves = (where: any, m: ModelDef<any> = Promo) => {
  const tree = buildWhereTree(m, where);
  return tree;
};

// ─── 1. col() helper ─────────────────────────────────────────────────────────
describe('col() helper', () => {
  test('produces a recognisable ColRef carrying the field name', () => {
    const ref = col('globalLimit');
    expect(isColRef(ref)).toBe(true);
    expect(colRefField(ref as any)).toBe('globalLimit');
    expect((ref as any)[FORGE_COL]).toBe('globalLimit');
  });

  test('isColRef rejects plain values', () => {
    expect(isColRef(null)).toBe(false);
    expect(isColRef(undefined)).toBe(false);
    expect(isColRef(5)).toBe(false);
    expect(isColRef('globalLimit')).toBe(false);
    expect(isColRef({})).toBe(false);
    expect(isColRef({ globalLimit: 1 })).toBe(false);
    expect(isColRef([col('x')])).toBe(false);
    // A literal object that mimics the marker by string key must NOT pass —
    // the brand is a Symbol, unreachable from JSON / request bodies.
    expect(isColRef({ 'forge.orm.col': 'globalLimit' })).toBe(false);
    expect(isColRef(JSON.parse(JSON.stringify(col('x'))))).toBe(false);
  });

  test('rejects an empty / non-string field name', () => {
    expect(() => col('')).toThrow(/non-empty field name/);
    expect(() => col(undefined as any)).toThrow(/non-empty field name/);
  });
});

// ─── 2. IR build ─────────────────────────────────────────────────────────────
describe('buildWhereTree — col() → rhsField leaf', () => {
  test('operator form { field: { lt: col(x) } }', () => {
    expect(leaves({ currentUsage: { lt: col('globalLimit') } })).toEqual({
      kind: 'leaf', field: 'currentUsage', op: 'lt', value: undefined, rhsField: 'globalLimit',
    });
  });

  test('all comparison ops map through', () => {
    for (const [userOp, irOp] of [
      ['equals', 'eq'], ['not', 'ne'], ['lt', 'lt'], ['lte', 'lte'], ['gt', 'gt'], ['gte', 'gte'],
    ] as const) {
      expect(leaves({ currentUsage: { [userOp]: col('globalLimit') } })).toMatchObject({
        kind: 'leaf', op: irOp, rhsField: 'globalLimit',
      });
    }
  });

  test('bare form { field: col(x) } → eq', () => {
    expect(leaves({ currentUsage: col('globalLimit') })).toEqual({
      kind: 'leaf', field: 'currentUsage', op: 'eq', value: undefined, rhsField: 'globalLimit',
    });
  });

  test('col() composes inside AND with a literal leaf', () => {
    const tree = leaves({ code: 'X', currentUsage: { lt: col('globalLimit') } }) as any;
    expect(tree.kind).toBe('and');
    expect(tree.children).toEqual(
      expect.arrayContaining([
        { kind: 'leaf', field: 'code', op: 'eq', value: 'X' },
        { kind: 'leaf', field: 'currentUsage', op: 'lt', value: undefined, rhsField: 'globalLimit' },
      ]),
    );
  });

  test('col() works under OR / NOT', () => {
    const orTree = leaves({ OR: [{ currentUsage: { gte: col('globalLimit') } }, { code: 'Y' }] }) as any;
    expect(orTree.kind).toBe('or');
    expect(orTree.children[0]).toMatchObject({ op: 'gte', rhsField: 'globalLimit' });
  });

  // Validation
  test('throws on a non-existent rhs field', () => {
    expect(() => leaves({ currentUsage: { lt: col('nope') } }))
      .toThrow(/col\('nope'\) references a field that does not exist/);
  });

  test('throws when col() is used with a non-comparison op', () => {
    expect(() => leaves({ code: { contains: col('globalLimit') } }))
      .toThrow(/col\(\) can only be used with/);
    expect(() => leaves({ currentUsage: { in: col('globalLimit') } }))
      .toThrow(/col\(\) can only be used with/);
  });

  test('throws when rhs references a relation', () => {
    expect(() => buildWhereTree(User, { age: { lt: col('posts') } }, { post: User }))
      .toThrow(/col\('posts'\)/);
  });
});

// ─── 3. Mongo compile → $expr ────────────────────────────────────────────────
const mFilter = (where: any) =>
  (mongoSelect(buildSelect('promos', Promo, { where }, 'many'), Promo) as any).args.filter;

describe('mongo compile — col() → $expr', () => {
  test('lt → $expr $lt with $-prefixed db paths', () => {
    expect(mFilter({ currentUsage: { lt: col('globalLimit') } })).toEqual({
      $expr: { $lt: ['$currentUsage', '$globalLimit'] },
    });
  });

  test('each op maps to the right $expr operator', () => {
    const cases: Array<[string, string]> = [
      ['equals', '$eq'], ['not', '$ne'], ['lt', '$lt'], ['lte', '$lte'], ['gt', '$gt'], ['gte', '$gte'],
    ];
    for (const [userOp, exprOp] of cases) {
      expect(mFilter({ currentUsage: { [userOp]: col('globalLimit') } })).toEqual({
        $expr: { [exprOp]: ['$currentUsage', '$globalLimit'] },
      });
    }
  });

  test('id field remaps to $_id inside $expr', () => {
    expect(mFilter({ id: col('refId') })).toEqual({
      $expr: { $eq: ['$_id', '$refId'] },
    });
  });

  test('mixed literal + col() → separate $and entries (no $expr collision)', () => {
    const filter = mFilter({ code: 'X', currentUsage: { lt: col('globalLimit') } });
    expect(filter.$and).toEqual(
      expect.arrayContaining([
        { code: 'X' },
        { $expr: { $lt: ['$currentUsage', '$globalLimit'] } },
      ]),
    );
  });

  test('two col() comparisons each keep their own $expr', () => {
    const filter = mFilter({
      currentUsage: { lt: col('globalLimit') },
      startsAt: { lte: col('endsAt') },
    });
    expect(filter.$and).toEqual([
      { $expr: { $lt: ['$currentUsage', '$globalLimit'] } },
      { $expr: { $lte: ['$startsAt', '$endsAt'] } },
    ]);
  });

  test('guarded counter update compiles to findOneAndUpdate with $expr filter', () => {
    const node = buildUpdate('promos', Promo, {
      where: { id: '507f1f77bcf86cd799439011', currentUsage: { lt: col('globalLimit') } },
      data: { currentUsage: { increment: 1 } },
      many: false,
    });
    const art = mongoSelectUpdate(node);
    expect(art.args.filter.$and).toEqual(
      expect.arrayContaining([{ $expr: { $lt: ['$currentUsage', '$globalLimit'] } }]),
    );
    expect(art.args.update.$inc).toEqual({ currentUsage: 1 });
    expect(art.args.options).toMatchObject({ returnDocument: 'after' });
  });
});

// helper: compileUpdate for mongo
function mongoSelectUpdate(node: any): any {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { compileUpdate } = require('../adapters/mongo/compile-from-ir');
  return compileUpdate(node, Promo);
}

// ─── 4. SQL compile (postgres / mysql / sqlite) ──────────────────────────────
describe('SQL compile — col() → column-vs-column', () => {
  const sql = (compile: any, where: any) =>
    compile(buildSelect('promos', Promo, { where }, 'many'), Promo);

  test('postgres: lhs <op> rhs with no extra params', () => {
    const a = sql(pgSelect, { currentUsage: { lt: col('globalLimit') } });
    expect(a.sql).toMatch(/WHERE "promos"\."currentUsage" < "promos"\."globalLimit"/);
    expect(a.params).toEqual([]);
  });

  test('postgres: each comparison operator', () => {
    const ops: Array<[string, string]> = [
      ['equals', '='], ['not', '<>'], ['lt', '<'], ['lte', '<='], ['gt', '>'], ['gte', '>='],
    ];
    for (const [userOp, sqlOp] of ops) {
      const a = sql(pgSelect, { currentUsage: { [userOp]: col('globalLimit') } });
      expect(a.sql).toContain(`"promos"."currentUsage" ${sqlOp} "promos"."globalLimit"`);
    }
  });

  test('postgres: mixed literal keeps a bound param for the literal only', () => {
    const a = sql(pgSelect, { code: 'X', currentUsage: { lt: col('globalLimit') } });
    expect(a.params).toEqual(['X']);                // rhs column is NOT a param
    expect(a.sql).toMatch(/"promos"\."code" = \$1/);
    expect(a.sql).toMatch(/"promos"\."currentUsage" < "promos"\."globalLimit"/);
  });

  test('mysql: backtick-quoted column-vs-column', () => {
    const a = sql(mysqlSelect, { currentUsage: { gte: col('globalLimit') } });
    expect(a.dialect).toBe('mysql');
    expect(a.sql).toMatch(/`promos`\.`currentUsage` >= `promos`\.`globalLimit`/);
    expect(a.params).toEqual([]);
  });

  test('sqlite: column-vs-column', () => {
    const a = sql(sqliteSelect, { currentUsage: { not: col('globalLimit') } } as any);
    expect(a.dialect).toBe('sqlite');
    expect(a.sql).toMatch(/"promos"\."currentUsage" <> "promos"\."globalLimit"/);
    expect(a.params).toEqual([]);
  });

  test('postgres UPDATE ... WHERE col-vs-col (the guarded counter)', () => {
    const a = pgUpdate(buildUpdate('promos', Promo, {
      where: { id: 'p1', currentUsage: { lt: col('globalLimit') } },
      data: { currentUsage: { increment: 1 } },
      many: false,
    }), Promo);
    expect(a.sql).toMatch(/"currentUsage" = "promos"\."currentUsage" \+ \$\d/);   // SET ... +1
    expect(a.sql).toMatch(/"promos"\."currentUsage" < "promos"\."globalLimit"/);  // guard
  });
});
