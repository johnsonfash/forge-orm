// updateMany's count is the rows the filter matched, as on every SQL dialect.
// Mongo reported modifiedCount, so re-running an update that left the rows
// unchanged (views already 42) answered 0 where Postgres answers 10.

import { f, model } from '../schema/core';
import { executeUpdate } from '../adapters/mongo/execute';

const Post = model('posts', { id: f.id({ type: 'string' }), author_id: f.string(), views: f.int() });

function fakeDb(result: { matchedCount: number; modifiedCount: number }) {
  return {
    collection: () => ({ updateMany: async () => result }),
  } as never;
}

const node = {
  model: 'post', kind: 'update', many: true,
  where: { kind: 'leaf', field: 'author_id', op: 'eq', value: 'u1' },
  set: { views: 42 },
} as never;

describe('mongo updateMany count', () => {
  it('counts matched rows, including ones already at the new value', async () => {
    const r = await executeUpdate(node, Post as never, { db: fakeDb({ matchedCount: 10, modifiedCount: 0 }) });
    expect(r.count).toBe(10);
  });

  it('counts zero when nothing matched', async () => {
    const r = await executeUpdate(node, Post as never, { db: fakeDb({ matchedCount: 0, modifiedCount: 0 }) });
    expect(r.count).toBe(0);
  });
});
