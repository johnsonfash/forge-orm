// `id` in an index key is Mongo's `_id`.
//
// The schema calls the primary key `id` and `coerce.ts` has translated it
// on every read and write for as long as the Mongo adapter has existed.
// Index keys did NOT go through that translation — they were handed to
// createIndex verbatim — so an index declared as `{ threadId: 1, id: -1 }`
// created a real index on a field literally called `id`, which no
// document has.
//
// Nothing reported it. push said "created", doctor said nothing, the
// index appeared in getIndexes(). Only explain() gave it away: the sort
// the index existed for was still performed in memory (stage SORT rather
// than FETCH). `diff` then called it permanent drift, comparing the
// declared `id` against the stored `_id`.
//
// The rule was already half-applied — single-field uniques skip
// `kind === 'id'` because "_id is automatic". It just never reached
// compound keys.

import { f, model } from '../schema/core';
import type { ModelDef } from '../schema/types';
import { collectIndexSpecs, normaliseIndexKeys } from '../adapters/mongo/scripts/push';

const messages = () =>
  model('chat_messages', {
    id: f.id(),
    threadId: f.objectId(),
    body: f.string(),
    createdAt: f.dateTime().default('now'),
  }, {
    indexes: [
      { keys: { threadId: 1, createdAt: -1, id: -1 }, name: 'idx_thread_created_id' },
    ],
  }) as unknown as ModelDef<any>;

describe('mongo index keys: id → _id', () => {
  it('translates a declared `id` key to `_id`', () => {
    const spec = collectIndexSpecs('ChatMessage', messages())
      .find((s) => s.name === 'idx_thread_created_id');
    expect(spec).toBeDefined();
    expect(Object.keys(spec!.keys)).toEqual(['threadId', 'createdAt', '_id']);
    // The direction survives — this is a rename, not a rewrite.
    expect((spec!.keys as Record<string, number>)._id).toBe(-1);
    expect('id' in spec!.keys).toBe(false);
  });

  it('leaves an index that never mentions the primary key alone', () => {
    const m = model('t', {
      id: f.id(),
      orgId: f.objectId(),
      createdAt: f.dateTime().default('now'),
    }, {
      indexes: [{ keys: { orgId: 1, createdAt: -1 }, name: 'idx_org_created' }],
    }) as unknown as ModelDef<any>;
    const spec = collectIndexSpecs('T', m).find((s) => s.name === 'idx_org_created');
    expect(Object.keys(spec!.keys)).toEqual(['orgId', 'createdAt']);
  });

  it('translates composite uniques too', () => {
    const m = model('t', {
      id: f.id(),
      orgId: f.objectId(),
    }, { uniques: [['orgId', 'id']] }) as unknown as ModelDef<any>;
    const spec = collectIndexSpecs('T', m).find((s) => s.unique);
    expect(Object.keys(spec!.keys)).toEqual(['orgId', '_id']);
  });

  it('normaliseIndexKeys returns the SAME object when there is nothing to do', () => {
    // Cheap guard: the common path must not allocate a copy of every key
    // map on every push.
    const keys = { orgId: 1 as const };
    expect(normaliseIndexKeys(keys)).toBe(keys);
  });

  it('does not touch a field that merely ENDS in id', () => {
    const m = model('t', {
      id: f.id(),
      threadId: f.objectId(),
      parentMessageId: f.objectId(),
    }, {
      indexes: [{ keys: { threadId: 1, parentMessageId: 1 }, name: 'idx_t_parent' }],
    }) as unknown as ModelDef<any>;
    const spec = collectIndexSpecs('T', m).find((s) => s.name === 'idx_t_parent');
    expect(Object.keys(spec!.keys)).toEqual(['threadId', 'parentMessageId']);
  });
});
