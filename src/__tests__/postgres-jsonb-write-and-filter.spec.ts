import { compileUpdate, compileSelect } from '../adapters/postgres/compile-from-ir';
import { buildUpdate, buildSelect } from '../ir/build';
import { model, f } from '../index';
import type { ModelDef } from '../schema/types';

/**
 * TWO THINGS A `jsonb` COLUMN COULD NOT DO, both found by running a real
 * application's suite against Postgres for the first time. Each worked on
 * Mongo, and each worked there for a reason that does not generalise.
 */

const Sale = model('pos_sales', {
  id: f.id(),
  orgId: f.objectId(),
  // Untyped on purpose: a json column holding an array is indistinguishable
  // from one holding an object until you look at the value, which is why the
  // operators have to be chosen by the COLUMN type.
  customer: f.json(),
  tags: f.json(),
  // A real array column, for contrast — this is what the array operators
  // were written for and it must keep emitting exactly what it did.
  labels: f.stringArray(),
}) as unknown as ModelDef<any>;

const SCHEMA: any = { sale: Sale };

describe('a dotted key writes INSIDE a json column', () => {
  const compile = (data: Record<string, unknown>) =>
    compileUpdate(
      buildUpdate('sale', Sale, { where: { orgId: 'o1' }, data, many: true }, SCHEMA) as any,
      Sale,
    );

  it('emits jsonb_set, not a column called "customer.id"', () => {
    const a = compile({ 'customer.id': 'newcust' });
    // Before: SET "customer.id" = $1 — Postgres looked for a column of that
    // literal name and answered "column does not exist", so a customer merge
    // could not repoint a till sale. The read side understood the path
    // already, so a filter matched rows that could not then be updated.
    expect(a.sql).not.toMatch(/"customer\.id"/);
    expect(a.sql).toMatch(
      /SET "customer" = jsonb_set\(coalesce\("customer", '\{\}'::jsonb\), \$1::text\[\], \$2::jsonb, true\)/,
    );
    expect(a.params[0]).toBe('{id}');
    // The value goes in JSON-encoded, so a string lands as a json string and
    // not as a bare word Postgres would reject.
    expect(a.params[1]).toBe('"newcust"');
  });

  it('coalesces, so a NULL column does not swallow the write', () => {
    // jsonb_set(NULL, …) returns NULL. Without the coalesce, setting a key on
    // a row whose column was never written would blank the column instead.
    expect(compile({ 'customer.id': 'x' }).sql).toMatch(/coalesce\("customer", '\{\}'::jsonb\)/);
  });

  it('nests two writes to the same column instead of losing one', () => {
    const a = compile({ 'customer.id': 'c1', 'customer.name': 'Ada' });
    expect(a.sql).toMatch(/jsonb_set\(jsonb_set\(/);
    // One SET clause for the column, not two fighting over it.
    expect(a.sql.match(/"customer" =/g)).toHaveLength(1);
    expect(a.params.slice(0, 4)).toEqual(['{id}', '"c1"', '{name}', '"Ada"']);
  });

  it('handles a path more than one level deep', () => {
    expect(compile({ 'customer.address.city': 'Lagos' }).params[0]).toBe('{address,city}');
  });

  it('leaves an ordinary column alone', () => {
    const a = compile({ orgId: 'o2' });
    expect(a.sql).toMatch(/SET "orgId" = \$1/);
    expect(a.sql).not.toMatch(/jsonb_set/);
  });
});

describe('array filters on a json column', () => {
  const where = (w: Record<string, unknown>) =>
    compileSelect(buildSelect('sale', Sale, { where: w }, 'many') as any, Sale).sql;

  it('`has` uses containment, not = ANY', () => {
    // `$1 = ANY("tags")` is right for a real array column and invalid for
    // jsonb — there is no ANY for it. `@>` is both correct and the form a GIN
    // index on the column can answer.
    const sql = where({ tags: { has: 'vip' } });
    expect(sql).toMatch(/"tags" @> \$\d+::jsonb/);
    expect(sql).not.toMatch(/= ANY\("tags"\)/);
  });

  it('`hasSome` ORs one containment per candidate', () => {
    // `?|` would be shorter and only works for strings; these columns hold
    // numbers too.
    const sql = where({ tags: { hasSome: ['vip', 'wholesale'] } });
    expect(sql).toMatch(/"tags" @> \$\d+::jsonb OR .*"tags" @> \$\d+::jsonb/);
  });

  it('`hasEvery` is one containment of the whole candidate array', () => {
    const sql = where({ tags: { hasEvery: ['vip', 'wholesale'] } });
    expect(sql.match(/"tags" @>/g)).toHaveLength(1);
  });

  it('`isEmpty` does not raise on a column holding an object or a scalar', () => {
    // jsonb_array_length throws on a non-array, and a json column is free to
    // hold one — so anything that is not an array counts as empty.
    expect(where({ tags: { isEmpty: true } })).toMatch(/jsonb_typeof\(.*"tags"\) = 'array'/);
  });

  it('a REAL array column still uses the array operators', () => {
    expect(where({ labels: { has: 'vip' } })).toMatch(/= ANY\(.*"labels"\)/);
    expect(where({ labels: { hasSome: ['a', 'b'] } })).toMatch(/"labels" && ARRAY\[/);
    expect(where({ labels: { isEmpty: true } })).toMatch(/array_length\(.*"labels", 1\)/);
  });
});

/**
 * THE PATH FORM'S OPERATORS, which were half wired.
 *
 * Both of these were silent: no error, just the wrong rows.
 */
describe('a path filter speaks the public operator vocabulary', () => {
  const Doc = model('docs', { id: f.id(), meta: f.json() }) as unknown as ModelDef<any>;
  const sql = (w: Record<string, unknown>) =>
    compileSelect(buildSelect('doc', Doc, { where: w }, 'many') as any, Doc).sql;
  const params = (w: Record<string, unknown>) =>
    compileSelect(buildSelect('doc', Doc, { where: w }, 'many') as any, Doc).params;

  it('`equals` works — it used to compile to IS NULL', () => {
    // The builder scanned for the INTERNAL spellings ('eq', 'ne'), so the
    // form forge's own error message tells people to write matched
    // nothing: subOp stayed at its 'eq' default and the value stayed
    // null, giving `meta->>'a' IS NULL` for `equals: 5`.
    expect(sql({ meta: { path: ['a'], equals: 5 } })).toMatch(/->>'a'\)::numeric = \$1/);
    expect(params({ meta: { path: ['a'], equals: 5 } })).toEqual([5]);
    expect(sql({ meta: { path: ['a'], equals: 5 } })).not.toMatch(/IS NULL/);
  });

  it('the other public names work too', () => {
    expect(sql({ meta: { path: ['a'], not: 5 } })).toMatch(/<> \$1/);
    expect(sql({ meta: { path: ['a'], gte: 5 } })).toMatch(/>= \$1/);
    expect(sql({ meta: { path: ['a'], in: [1, 2] } })).toMatch(/IN \(\$1, \$2\)/);
  });

  it('the internal spellings still work, so nothing written before breaks', () => {
    expect(params({ meta: { path: ['a'], eq: 5 } })).toEqual([5]);
  });

  it('`equals: null` still means IS NULL, which is a real question', () => {
    expect(sql({ meta: { path: ['a'], equals: null } })).toMatch(/IS NULL/);
  });

  it('`mode: insensitive` reaches a path `contains`', () => {
    // It emitted a bare LIKE while the same operator on a scalar column
    // emitted ILIKE, so a case-insensitive search inside a json blob
    // matched only the case it was handed. Measured on a live database:
    // searching 'BOLA' found nothing for a row holding
    // 'bola@example.com'.
    expect(sql({ meta: { path: ['email'], contains: 'X', mode: 'insensitive' } })).toMatch(/ILIKE/);
    expect(sql({ meta: { path: ['email'], contains: 'X' } })).toMatch(/LIKE/);
    expect(sql({ meta: { path: ['email'], contains: 'X' } })).not.toMatch(/ILIKE/);
  });

  it('and reaches the dotted form as well', () => {
    expect(sql({ 'meta.email': { contains: 'X', mode: 'insensitive' } })).toMatch(/ILIKE/);
  });
});
