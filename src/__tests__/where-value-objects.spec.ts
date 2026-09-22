import { ObjectId, Decimal128, Long, Binary, UUID } from 'mongodb';
import { f, model } from '../schema/core';
import type { ModelDef } from '../schema/types';
import { buildWhereTree } from '../ir/build';

// A where value that is an object but NOT a plain one — an ObjectId, a
// Decimal128, a Buffer — is a VALUE to compare against, never a container of
// operators. forge used to decide that with "object, not array, not Date",
// which classified every class instance as operators and then read
// Object.keys() off it: an ObjectId enumerates as ['buffer'], so the shape
// docs/MONGO.md promises works threw "unknown operator 'buffer'".
const Doc = model('docs', {
  id: f.id(),
  author_id: f.objectId().optional(),
  price: f.decimal().optional(),
  meta: f.json().optional(),
  created_at: f.dateTime().optional(),
  name: f.string().optional(),
}) as unknown as ModelDef<any>;

const tree = (where: any) => buildWhereTree(Doc, where);

describe('where: non-plain objects are values, not operator containers', () => {
  const cases: Array<[string, any]> = [
    ['ObjectId', new ObjectId()],
    ['Decimal128', Decimal128.fromString('1.5')],
    ['Long', Long.fromNumber(5)],
    ['Binary', new Binary(Buffer.from('a'))],
    ['UUID', new UUID()],
    ['Buffer', Buffer.from('ab')],
    ['Date', new Date()],
  ];

  for (const [label, value] of cases) {
    it(`compares against a ${label} instead of throwing`, () => {
      expect(() => tree({ author_id: value })).not.toThrow();
      expect(tree({ author_id: value })).toEqual({
        kind: 'leaf',
        field: 'author_id',
        op: 'eq',
        value,
      });
    });

    it(`negates a ${label} with not:`, () => {
      expect(() => tree({ author_id: { not: value } })).not.toThrow();
      // `not` against a value compiles to a straight inequality — the point
      // here is that the value is compared whole, not walked for operators.
      expect(tree({ author_id: { not: value } })).toMatchObject({
        kind: 'leaf',
        field: 'author_id',
        op: 'ne',
        value,
      });
    });
  }

  it('still reads a plain object as operators', () => {
    expect(tree({ name: { contains: 'ab' } })).toEqual({
      kind: 'leaf',
      field: 'name',
      op: 'contains',
      value: 'ab',
    });
  });

  it('still rejects a genuinely unknown operator', () => {
    expect(() => tree({ name: { definitelyNotAnOperator: 1 } })).toThrow(/unknown operator/);
  });

  it('reads an operator container built with a null prototype', () => {
    const ops = Object.create(null);
    ops.gte = 5;
    expect(tree({ price: ops })).toEqual({
      kind: 'leaf',
      field: 'price',
      op: 'gte',
      value: 5,
    });
  });

  it('treats an ObjectId inside in: as a value', () => {
    const ids = [new ObjectId(), new ObjectId()];
    expect(() => tree({ author_id: { in: ids } })).not.toThrow();
    expect(tree({ author_id: { in: ids } })).toEqual({
      kind: 'leaf',
      field: 'author_id',
      op: 'in',
      value: ids,
    });
  });
});
