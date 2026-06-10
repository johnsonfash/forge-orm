import { ObjectId } from 'mongodb';
import { __stringifyObjectIds as stringifyObjectIds } from '../builder/collection';

// db.<model>.aggregate() post-processes raw pipeline output: ObjectIds are
// stringified and `_id` keys are remapped to `id` (matching the find*
// decode path). Everything else must survive untouched — most notably
// Dates, which a naive recursive walk would flatten to `{}`.
describe('aggregate output post-processing', () => {
  it('stringifies ObjectId values and remaps _id → id', () => {
    const oid = new ObjectId();
    const out = stringifyObjectIds({ _id: oid, userId: oid });
    expect(out).toEqual({ id: oid.toString(), userId: oid.toString() });
  });

  it('remaps _id → id for non-ObjectId group keys', () => {
    expect(stringifyObjectIds({ _id: '2026-06-10', n: 3 })).toEqual({
      id: '2026-06-10',
      n: 3,
    });
  });

  it('remaps nested object group keys recursively', () => {
    const oid = new ObjectId();
    const out = stringifyObjectIds({ _id: { day: '2026-06-10', userId: oid } });
    expect(out).toEqual({ id: { day: '2026-06-10', userId: oid.toString() } });
  });

  it('passes Date values through untouched', () => {
    const at = new Date('2026-06-10T12:00:00Z');
    const out = stringifyObjectIds({ _id: null, lastOrderAt: at });
    expect(out.lastOrderAt).toBe(at);
  });

  it('passes top-level Dates and arrays of Dates through', () => {
    const at = new Date('2026-01-01T00:00:00Z');
    expect(stringifyObjectIds(at)).toBe(at);
    const out = stringifyObjectIds({ days: [at, at] });
    expect(out.days[0]).toBe(at);
  });

  it('passes other BSON scalar types through untouched', () => {
    const fakeDecimal = { _bsontype: 'Decimal128', toString: () => '1.5' };
    const out = stringifyObjectIds({ amount: fakeDecimal });
    expect(out.amount).toBe(fakeDecimal);
  });

  it('handles primitives and null', () => {
    expect(stringifyObjectIds(null)).toBeNull();
    expect(stringifyObjectIds(5)).toBe(5);
    expect(stringifyObjectIds('x')).toBe('x');
  });
});
