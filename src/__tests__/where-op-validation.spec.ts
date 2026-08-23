import { buildWhereTree } from '../ir/build/where';
import { buildUpdateData } from '../ir/build/data';
import { schema } from '../schema';

// Unknown operators used to be DROPPED from the where tree, so the condition
// vanished and the query matched every row — a filter that silently does not
// filter. They throw now, with the bare-name correction first when the slip
// is a Mongo-style $ prefix.
describe('where: unknown operators throw instead of being dropped', () => {
  const post = schema.post as any;
  const user = schema.user as any;

  it('rejects $-prefixed Mongo operators with a correction', () => {
    expect(() => buildWhereTree(post, { view_count: { $gte: 3 } }))
      .toThrow(/unknown operator '\$gte'.*Did you mean 'gte'/s);
    expect(() => buildWhereTree(post, { published_at: { $lte: new Date() } }))
      .toThrow(/\$lte/);
    expect(() => buildWhereTree(post, { author_id: { $in: ['a'] } }))
      .toThrow(/Did you mean 'in'/);
  });

  it('rejects typos with a closest-match suggestion', () => {
    expect(() => buildWhereTree(post, { title: { contians: 'x' } }))
      .toThrow(/Did you mean 'contains'/);
  });

  it('points container columns at path filters', () => {
    expect(() => buildWhereTree(post, { meta: { level: 3 } }))
      .toThrow(/path/);
  });

  it('still builds every documented operator', () => {
    expect(buildWhereTree(post, {
      view_count: { gte: 1, lt: 100 },
      title: { contains: 'x', mode: 'insensitive' },
      tag_names: { has: 'a' },
      published_at: { not: null },
    })).toBeTruthy();
  });

  it('negates a nested not-filter instead of comparing against the object', () => {
    const tree: any = buildWhereTree(post, { title: { not: { contains: 'x' } } });
    expect(tree.kind).toBe('not');
    expect(tree.child).toMatchObject({ kind: 'leaf', field: 'title', op: 'contains', value: 'x' });
  });

  it('keeps not: <literal> and not: null as plain ne', () => {
    expect(buildWhereTree(post, { status: { not: 'DRAFT' } }))
      .toMatchObject({ kind: 'leaf', op: 'ne', value: 'DRAFT' });
    expect(buildWhereTree(post, { published_at: { not: null } }))
      .toMatchObject({ kind: 'leaf', op: 'ne', value: null });
  });

  it('keeps not: <object> literal on json columns (keys there are data)', () => {
    expect(buildWhereTree(post, { meta: { not: { a: 1 } } }))
      .toMatchObject({ kind: 'leaf', field: 'meta', op: 'ne', value: { a: 1 } });
  });

  it('translates dotted container paths to jsonPath leaves', () => {
    expect(buildWhereTree(user, { 'address.city': 'sf' })).toMatchObject({
      kind: 'leaf', field: 'address', op: 'jsonPath',
      value: 'sf', jsonPath: { path: ['city'], subOp: 'eq' },
    });
    expect(buildWhereTree(post, { 'meta.stats.views': { gte: 10 } })).toMatchObject({
      kind: 'leaf', field: 'meta', op: 'jsonPath',
      value: 10, jsonPath: { path: ['stats', 'views'], subOp: 'gte' },
    });
  });

  it('rejects unsupported operators on dotted paths', () => {
    expect(() => buildWhereTree(post, { 'meta.name': { startsWith: 'x' } }))
      .toThrow(/Paths support/);
  });
});

describe('update data: operator objects are validated on scalar columns', () => {
  const post = schema.post as any;

  it('throws on a typoed operator instead of writing the object into the column', () => {
    expect(() => buildUpdateData(post, { view_count: { incrment: 5 } }))
      .toThrow(/not a valid operator form/);
  });

  it('throws on numeric ops applied to non-numeric columns', () => {
    expect(() => buildUpdateData(post, { title: { increment: 1 } }))
      .toThrow(/only valid on numeric columns/);
  });

  it('throws on ambiguous multi-operator objects', () => {
    expect(() => buildUpdateData(post, { view_count: { set: 1, increment: 2 } }))
      .toThrow(/ambiguous/);
  });

  it('still supports every operator form', () => {
    expect(buildUpdateData(post, { view_count: { increment: 2 } }).increment).toEqual({ view_count: 2 });
    expect(buildUpdateData(post, { view_count: { decrement: 2 } }).increment).toEqual({ view_count: -2 });
    expect(buildUpdateData(post, { view_count: { multiply: 3 } }).multiply).toEqual({ view_count: 3 });
    expect(buildUpdateData(post, { view_count: { set: 9 } }).set).toEqual({ view_count: 9 });
    expect(buildUpdateData(post, { published_at: { unset: true } }).unset).toEqual(['published_at']);
  });

  it('leaves json / embed object values untouched', () => {
    expect(buildUpdateData(post, { meta: { any: 'shape' } }).set).toEqual({ meta: { any: 'shape' } });
  });

  it('passes Dates and null through as plain assignment', () => {
    const at = new Date();
    const frag = buildUpdateData(post, { published_at: at, author_id: null });
    expect(frag.set).toEqual({ published_at: at, author_id: null });
  });
});

// The fixes live in the shared IR builder, so they must land identically on
// every dialect — not just Mongo. Compile the new shapes through the SQL
// compilers and check the emitted SQL is native, not a passthrough.
import { buildSelect } from '../ir/build';
import { compileSelect as sqlSelect } from '../adapters/postgres/compile-from-ir';
import { MysqlDialect } from '../adapters/mysql/dialect';
import { SqliteDialect } from '../adapters/sqlite/dialect';
import { compileSelect as mongoSelect } from '../adapters/mongo/compile-from-ir';

describe('cross-dialect compilation of the 2.7 where shapes', () => {
  const post = schema.post as any;
  const user = schema.user as any;

  it('not:{contains} emits NOT(LIKE) on SQL and $nor on Mongo', () => {
    const node = buildSelect('post', post, { where: { title: { not: { contains: 'x' } } } }, 'many', schema as any);
    expect((sqlSelect(node, post) as any).sql).toContain(`NOT ("posts"."title" LIKE $1)`);
    expect((sqlSelect(node, post, MysqlDialect as any) as any).sql).toContain('NOT (`posts`.`title` LIKE ?)');
    expect((sqlSelect(node, post, SqliteDialect as any) as any).sql).toContain(`NOT ("posts"."title" LIKE ?)`);
    expect((mongoSelect(node, post) as any).args.filter).toEqual({ $nor: [{ title: { $regex: 'x' } }] });
  });

  it('dotted embed path emits native JSON access per dialect', () => {
    const node = buildSelect('user', user, { where: { 'address.city': 'sf' } }, 'many', schema as any);
    expect((sqlSelect(node, user) as any).sql).toContain(`"users"."address"->>'city' = $1`);
    expect((sqlSelect(node, user, MysqlDialect as any) as any).sql).toContain(`JSON_EXTRACT(\`users\`.\`address\`, '$.city')`);
    expect((sqlSelect(node, user, SqliteDialect as any) as any).sql).toContain(`json_extract("users"."address", '$.city')`);
    expect((mongoSelect(node, user) as any).args.filter).toEqual({ 'address.city': 'sf' });
  });

  it('dotted json path with a comparison emits typed access', () => {
    const node = buildSelect('post', post, { where: { 'meta.stats.views': { gte: 10 } } }, 'many', schema as any);
    expect((sqlSelect(node, post) as any).sql).toContain(`("posts"."meta"->'stats'->>'views')::numeric >= $1`);
    expect((mongoSelect(node, post) as any).args.filter).toEqual({ 'meta.stats.views': { $gte: 10 } });
  });
});
