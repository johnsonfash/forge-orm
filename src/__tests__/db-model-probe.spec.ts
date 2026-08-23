// Reading an unregistered model THROWS (see `unknownModel`) — deliberate, and
// worth keeping: a typo'd model name should be loud, not `undefined` five
// frames away from the cause.
//
// But that made the db un-probeable. `'User' in db` was FALSE even for a
// registered model, because the `has` trap was never defined and `in` fell
// through to the proxy's empty target. So the one idiom that should have let
// a caller check before reading actively lied, and the only working pattern
// was try/catch around a property access.
//
// Live consequence (Dallio, 2026-08-23): a module wrote
// `db.orgIndustryMixView ?? null` to mean "use the view if it's registered".
// The key was mis-cased, the read threw instead of yielding undefined, the
// `??` never ran, and the throw took down bootstrap. `in` would have been
// the correct guard — it just didn't work.

import { createDb } from '../factory';
import { f, model } from '../schema/core';
import type { SqliteDriver } from '../adapters/sqlite/driver';

const Widget = model('widget', { id: f.id(), name: f.string() });
const Gadget = model('gadget', { id: f.id(), size: f.int() });

const appSchema = { Widget, Gadget } as any;

function fakeDriver(): SqliteDriver {
  return {
    kind: 'sqlite',
    all: async () => [],
    get: async () => undefined,
    run: async () => ({ changes: 0 }),
    exec: async () => {},
    close: async () => {},
  };
}

describe('probing which models a db exposes', () => {
  it('`in` is true for a registered model', async () => {
    const db = await createDb({ schema: appSchema, driver: fakeDriver() });
    expect('Widget' in db).toBe(true);
    expect('Gadget' in db).toBe(true);
  });

  it('`in` is false for an unregistered model, and does NOT throw', async () => {
    const db = await createDb({ schema: appSchema, driver: fakeDriver() });
    expect(() => 'Typo' in db).not.toThrow();
    expect('Typo' in db).toBe(false);
  });

  it('`in` is case-sensitive — the exact bug that broke Dallio boot', async () => {
    const db = await createDb({ schema: appSchema, driver: fakeDriver() });
    expect('widget' in db).toBe(false); // mis-cased
    expect('Widget' in db).toBe(true);
  });

  it('guarding a read with `in` makes the optional-model pattern work', async () => {
    const db = await createDb({ schema: appSchema, driver: fakeDriver() });
    const pick = (key: string) => (key in db ? (db as any)[key] : null);
    expect(pick('Widget')).not.toBeNull();
    expect(pick('orgIndustryMixView')).toBeNull(); // no throw, no crash
  });

  it('still THROWS on an unguarded read of an unknown model', async () => {
    const db = await createDb({ schema: appSchema, driver: fakeDriver() });
    expect(() => (db as any).Typo).toThrow(/unknown model "Typo"/);
  });

  it('`in` reports the $ helpers the db actually answers', async () => {
    const db = await createDb({ schema: appSchema, driver: fakeDriver() });
    expect('$transaction' in db).toBe(true);
    expect('$models' in db).toBe(true);
    expect('$queryRaw' in db).toBe(true);
    expect('$notAThing' in db).toBe(false);
  });

  it('$models lists every registered model, sorted', async () => {
    const db = await createDb({ schema: appSchema, driver: fakeDriver() });
    expect(db.$models).toEqual(['Gadget', 'Widget']);
  });

  it('does not resurrect the JS-protocol passthroughs', async () => {
    const db = await createDb({ schema: appSchema, driver: fakeDriver() });
    // `then` must stay absent or `await db` would treat it as a thenable.
    expect('then' in db).toBe(false);
    expect('toJSON' in db).toBe(false);
    await expect(Promise.resolve(db)).resolves.toBeDefined();
  });

  it('works the same inside a transaction, minus the helpers tx lacks', async () => {
    const db = await createDb({ schema: appSchema, driver: fakeDriver() });
    await db.$transaction(async (tx) => {
      expect('Widget' in tx).toBe(true);
      expect('Typo' in tx).toBe(false);
      expect('$transaction' in tx).toBe(true);
      // $migrate is not available mid-transaction, so `in` must not claim it.
      expect('$migrate' in tx).toBe(false);
      expect(tx.$models).toEqual(['Gadget', 'Widget']);
    });
  });
});
