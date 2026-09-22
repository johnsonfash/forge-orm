import { f, model } from '../schema/core';
import type { ModelDef } from '../schema/types';
import { CollectionWrapper } from '../builder/collection';
import { DbKnownError } from '../adapters/mongo/errors';

// `updateFirst` / `deleteFirst` exist for one reason: `update()` and
// `delete()` THROW when nothing matched, and a repository wants "update it
// and give it back, or tell me it is not there". Without them that was
// written as
//
//     await db.thing.updateMany({ where: { id }, data });
//     const fresh = await db.thing.findFirst({ where: { id } });
//
// — two round trips, on essentially every write path.

const Thing: ModelDef<never> = model('things', {
  id: f.id(),
  name: f.string(),
  deleted_at: f.dateTime().optional().softDeleteAt(),
}) as never as ModelDef<never>;

/** An adapter whose write either finds a row or does not. */
function fakeAdapter(doc: Record<string, unknown> | undefined) {
  const calls: string[] = [];
  return {
    calls,
    kind: 'postgres' as const,
    capabilities: {
      nativeCascades: true, nativeUpsert: true, nullsOrdering: true,
      jsonPath: true, transactionsRequireReplicaSet: false,
    },
    emitter: { track: <T>(_e: unknown, run: () => T) => run(), on() {}, off() {} },
    executeSelect: () => { calls.push('select'); return Promise.resolve(doc ? [doc] : []); },
    executeCount: () => { calls.push('count'); return Promise.resolve(0); },
    executeGroupBy: () => Promise.resolve([]),
    executeInsert: () => Promise.resolve({ docs: [{}], count: 1 }),
    executeUpdate: () => { calls.push('update'); return Promise.resolve({ doc, count: doc ? 1 : 0 }); },
    executeDelete: () => { calls.push('delete'); return Promise.resolve({ doc, count: doc ? 1 : 0 }); },
    coerceInbound: (_m: unknown, d: unknown) => d,
    decodeOutbound: (_m: unknown, r: unknown) => r,
    applyProjectionAndHydration: () => Promise.resolve(),
    applyCascadesForDelete: () => Promise.resolve(),
  };
}

const wrap = (a: unknown) =>
  new CollectionWrapper(Thing as never, undefined, a as never, false) as unknown as {
    update(a: unknown): Promise<unknown>;
    updateFirst(a: unknown): Promise<unknown>;
    delete(a: unknown): Promise<unknown>;
    deleteFirst(a: unknown): Promise<unknown>;
  };

describe('updateFirst', () => {
  test('returns the row, in ONE call', async () => {
    const a = fakeAdapter({ id: 'x', name: 'after' });
    const r = await wrap(a).updateFirst({ where: { id: 'x' }, data: { name: 'after' } });
    expect(r).toEqual({ id: 'x', name: 'after' });
    // The point of the verb: no follow-up read.
    expect(a.calls).toEqual(['update']);
  });

  test('returns null on a miss instead of throwing', async () => {
    const a = fakeAdapter(undefined);
    expect(await wrap(a).updateFirst({ where: { id: 'gone' }, data: { name: 'x' } })).toBeNull();
  });

  test('update() still throws on a miss — that difference is the whole point', async () => {
    const a = fakeAdapter(undefined);
    await expect(wrap(a).update({ where: { id: 'gone' }, data: { name: 'x' } }))
      .rejects.toThrow(/No things found/);
  });

  test('a miss is still only one call', async () => {
    const a = fakeAdapter(undefined);
    await wrap(a).updateFirst({ where: { id: 'gone' }, data: { name: 'x' } });
    expect(a.calls).toEqual(['update']);
  });

  test('a non-unique filter is accepted, like update()', async () => {
    const a = fakeAdapter({ id: 'x', name: 'n' });
    await expect(wrap(a).updateFirst({ where: { name: 'n' }, data: { name: 'm' } }))
      .resolves.toBeTruthy();
  });

  test('the row comes back even when the patch is what soft-deleted it', async () => {
    // The re-read pattern returns null here, because a READ is soft-delete
    // filtered — which is why callers took a THIRD round trip to read the row
    // before the write and rebuild the result by hand.
    const a = fakeAdapter({ id: 'x', name: 'n', deleted_at: new Date() });
    const r = await wrap(a).updateFirst({
      where: { id: 'x' }, data: { deleted_at: new Date() },
    }) as { id: string };
    expect(r.id).toBe('x');
    expect(a.calls).toEqual(['update']);
  });

  test('an error that is not a miss still propagates', async () => {
    const a = fakeAdapter({ id: 'x' });
    a.executeUpdate = () => Promise.reject(new DbKnownError('P2002', 'duplicate key'));
    await expect(wrap(a).updateFirst({ where: { id: 'x' }, data: { name: 'n' } }))
      .rejects.toThrow(/duplicate key/);
  });
});

describe('deleteFirst', () => {
  test('returns the deleted row', async () => {
    const a = fakeAdapter({ id: 'x', name: 'n' });
    expect(await wrap(a).deleteFirst({ where: { id: 'x' } })).toEqual({ id: 'x', name: 'n' });
    expect(a.calls).toEqual(['delete']);
  });

  test('deleting something already gone is not an error', async () => {
    const a = fakeAdapter(undefined);
    expect(await wrap(a).deleteFirst({ where: { id: 'gone' } })).toBeNull();
  });

  test('delete() still throws', async () => {
    const a = fakeAdapter(undefined);
    await expect(wrap(a).delete({ where: { id: 'gone' } })).rejects.toThrow(/No things found/);
  });

  test('a real failure still propagates', async () => {
    const a = fakeAdapter({ id: 'x' });
    a.executeDelete = () => Promise.reject(new DbKnownError('P2003', 'foreign key constraint'));
    await expect(wrap(a).deleteFirst({ where: { id: 'x' } })).rejects.toThrow(/foreign key/);
  });
});
