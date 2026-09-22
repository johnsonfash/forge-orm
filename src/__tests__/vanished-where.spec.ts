import { f, model } from '../schema/core';
import type { ModelDef } from '../schema/types';
import { buildCount, buildDelete, buildGroupBy, buildSelect, buildUpdate } from '../ir/build';
import { compileDelete, compileUpdate } from '../adapters/postgres/compile-from-ir';

// `undefined` is skipped throughout the query surface — that is what makes
// `where: { status: maybeStatus }` mean "don't filter on status". The failure
// this pins is what happens when EVERY value is undefined: the filter
// disappears and the statement applies to the whole table.
//
//   deleteMany({ where: { tenant_id: req.user?.tenantId } })
//
// One optional-chain returning undefined emptied a table, with no error.

const Acct: ModelDef<any> = model('accounts', {
  id: f.id(),
  tenant_id: f.string(),
  balance: f.int(),
}) as unknown as ModelDef<any>;

const sql = (a: unknown) => (a as { sql: string }).sql;

describe('a filter whose every value is undefined is refused', () => {
  test('deleteMany would have emptied the table', () => {
    expect(() => buildDelete('a', Acct, { where: { tenant_id: undefined }, many: true }))
      .toThrow(/would apply to EVERY row/);
  });

  test('updateMany would have rewritten every row', () => {
    expect(() => buildUpdate('a', Acct, {
      where: { tenant_id: undefined }, data: { balance: 0 }, many: true,
    })).toThrow(/would apply to EVERY row/);
  });

  test('single-row delete would have deleted an ARBITRARY row', () => {
    // Worse than the many-case: the compiler emitted
    // `WHERE ctid = (SELECT ctid FROM "accounts" LIMIT 1)` — not the row you
    // asked for, whichever row the planner happened to return.
    expect(() => buildDelete('a', Acct, { where: { id: undefined }, many: false }))
      .toThrow(/would apply to EVERY row/);
  });

  test('findUnique / findFirst would have returned an arbitrary row', () => {
    expect(() => buildSelect('a', Acct, { where: { id: undefined } }, 'one'))
      .toThrow(/findFirst\/findUnique/);
  });

  test('findMany would have returned every tenant’s rows', () => {
    expect(() => buildSelect('a', Acct, { where: { tenant_id: undefined } }, 'many'))
      .toThrow(/findMany/);
  });

  test('count would have counted every tenant', () => {
    expect(() => buildCount('a', Acct, { where: { tenant_id: undefined } }))
      .toThrow(/count on 'accounts'/);
  });

  test('groupBy too', () => {
    expect(() => buildGroupBy('a', Acct, { by: ['tenant_id'], where: { tenant_id: undefined } }))
      .toThrow(/groupBy/);
  });

  test('the error names the keys and the operation, and says how to mean it', () => {
    let msg = '';
    try {
      buildDelete('a', Acct, { where: { tenant_id: undefined, balance: undefined }, many: true });
    } catch (e) { msg = (e as Error).message; }
    expect(msg).toContain("deleteMany on 'accounts'");
    expect(msg).toContain('tenant_id, balance');
    expect(msg).toContain('omit `where` entirely');
  });

  test('several undefined keys is still refused', () => {
    expect(() => buildDelete('a', Acct, {
      where: { tenant_id: undefined, id: undefined }, many: true,
    })).toThrow(/EVERY row/);
  });
});

describe('what must keep working', () => {
  test('no `where` at all still means every row — that is how you say it', () => {
    expect(sql(compileDelete(buildDelete('a', Acct, { many: true } as never), Acct)))
      .toBe('DELETE FROM "accounts"  RETURNING *');
  });

  test('an explicitly empty `where: {}` also still means every row', () => {
    // Zero keys were written, so nothing evaporated. The rule is specifically
    // "keys were written and none survived".
    expect(sql(compileDelete(buildDelete('a', Acct, { where: {}, many: true }), Acct)))
      .toContain('DELETE FROM "accounts"');
  });

  test('a real filter is untouched', () => {
    expect(sql(compileDelete(buildDelete('a', Acct, { where: { tenant_id: 't1' }, many: true }), Acct)))
      .toContain('WHERE "accounts"."tenant_id" = $1');
  });

  test('SOME undefined values are still skipped — the whole point of the feature', () => {
    const out = sql(compileDelete(
      buildDelete('a', Acct, { where: { tenant_id: 't1', balance: undefined }, many: true }), Acct,
    ));
    expect(out).toContain('"tenant_id" = $1');
    expect(out).not.toContain('balance');
  });

  test('an update with a real filter still compiles', () => {
    expect(sql(compileUpdate(
      buildUpdate('a', Acct, { where: { id: 'x' }, data: { balance: 1 }, many: false }), Acct,
    ))).toContain('WHERE');
  });

  test('a falsy-but-defined value is not undefined', () => {
    // 0, '' and false are real filters. Treating them as missing would be a
    // different bug in the same family.
    for (const v of [0, '', false, null]) {
      expect(() => buildDelete('a', Acct, { where: { balance: v }, many: true })).not.toThrow();
    }
  });
});
