import { f, model } from '../schema/core';
import type { ModelDef } from '../schema/types';
import { fingerprint, stableJson, collectIndexSpecs } from '../adapters/mongo/scripts/push';

// 2.1.0 — partialFilterExpression on a Mongo IndexDef. These cover the schema
// threading + the push idempotency fingerprint without needing a live DB;
// regression-mongo-partial-index.ts covers the live createIndex behaviour.

const partialModel = () =>
  model('m', { id: f.id(), txn: f.string().optional(), amount: f.int() }, {
    indexes: [{ keys: { txn: 1 }, unique: true, name: 'idx_txn', partialFilterExpression: { txn: { $type: 'string' } } }],
  }) as unknown as ModelDef<any>;

describe('mongo partial index (partialFilterExpression)', () => {
  test('model() preserves partialFilterExpression on a declared index', () => {
    expect(partialModel().indexes[0].partialFilterExpression).toEqual({ txn: { $type: 'string' } });
  });

  test('collectIndexSpecs threads partialFilterExpression + unique through', () => {
    const spec = collectIndexSpecs('m', partialModel()).find((x) => x.name === 'idx_txn')!;
    expect(spec.partialFilterExpression).toEqual({ txn: { $type: 'string' } });
    expect(spec.unique).toBe(true);
    expect(spec.keys).toEqual({ txn: 1 });
  });

  test('fingerprint distinguishes presence and shape of partialFilterExpression', () => {
    const none = fingerprint({ txn: 1 }, true, false, undefined, undefined);
    const withPfe = fingerprint({ txn: 1 }, true, false, undefined, { txn: { $type: 'string' } });
    const other = fingerprint({ txn: 1 }, true, false, undefined, { txn: { $exists: true } });
    expect(none).not.toEqual(withPfe); // adding a PFE must force a rebuild
    expect(withPfe).not.toEqual(other); // a different PFE must differ
  });

  test('fingerprint is stable regardless of key order in the filter', () => {
    expect(fingerprint({ k: 1 }, false, false, undefined, { x: 1, y: 2 }))
      .toEqual(fingerprint({ k: 1 }, false, false, undefined, { y: 2, x: 1 }));
  });

  test('stableJson sorts nested keys deterministically', () => {
    expect(stableJson({ b: 1, a: { d: 4, c: 3 } })).toEqual(stableJson({ a: { c: 3, d: 4 }, b: 1 }));
  });
});
