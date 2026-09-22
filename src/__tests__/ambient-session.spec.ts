import { f, model } from '../schema/core';
import type { ModelDef } from '../schema/types';
import { CollectionWrapper } from '../builder/collection';
import { ambientSessionsSupported, currentSession, runWithSession } from '../session-context';

// A `$transaction` callback that discards its `tx` argument and calls into a
// repository layer used to run the repository's queries OUTSIDE the
// transaction — the code read as atomic, and nothing rolled back. The only fix
// available was threading `tx` through every function between the route and
// the query.
//
// This pins the mechanism: a wrapper with no session of its own picks up the
// ambient one, and only from its own adapter. The end-to-end proof against a
// real Postgres lives in `regression-transactions.ts`, because a wrapper
// test cannot show a rollback.

const Acct: ModelDef<never> = model('accts', {
  id: f.id(),
  bal: f.int(),
}) as never as ModelDef<never>;

/** Records the ExecOpts every call was given. */
function fakeAdapter() {
  const seen: Array<{ op: string; session: unknown }> = [];
  const record = (op: string) => (_n: unknown, _m: unknown, opts?: { session?: unknown }) => {
    seen.push({ op, session: opts?.session });
    return Promise.resolve(op === 'select' ? [] : { doc: {}, docs: [{}], count: 0 });
  };
  return {
    seen,
    kind: 'postgres' as const,
    capabilities: {
      nativeCascades: true, nativeUpsert: true, nullsOrdering: true,
      jsonPath: true, transactionsRequireReplicaSet: false,
    },
    emitter: { track: <T>(_e: unknown, run: () => T) => run(), on() {}, off() {} },
    executeSelect: record('select'),
    executeCount: record('count'),
    executeGroupBy: record('groupBy'),
    executeInsert: record('insert'),
    executeUpdate: record('update'),
    executeDelete: record('delete'),
    coerceInbound: (_m: unknown, d: unknown) => d,
    decodeOutbound: (_m: unknown, r: unknown) => r,
    applyProjectionAndHydration: () => Promise.resolve(),
    applyCascadesForDelete: () => Promise.resolve(),
  };
}

const wrapperFor = (adapter: unknown, session?: unknown) =>
  new CollectionWrapper(Acct as never, session, adapter as never, false) as unknown as {
    findMany(a?: unknown): Promise<unknown>;
    count(a?: unknown): Promise<unknown>;
    update(a: unknown): Promise<unknown>;
  };

describe('a wrapper with no session of its own', () => {
  test('picks up the ambient one', async () => {
    const a = fakeAdapter();
    await runWithSession(a, 'TX', async () => { await wrapperFor(a).findMany({}); });
    expect(a.seen).toEqual([{ op: 'select', session: 'TX' }]);
  });

  test('gets nothing outside a transaction', async () => {
    const a = fakeAdapter();
    await wrapperFor(a).findMany({});
    expect(a.seen[0].session).toBeUndefined();
  });

  test('reads and writes both pick it up', async () => {
    const a = fakeAdapter();
    await runWithSession(a, 'TX', async () => {
      await wrapperFor(a).count({});
      await wrapperFor(a).update({ where: { id: 'x' }, data: { bal: 1 } });
    });
    expect(a.seen.map((s) => s.session)).toEqual(['TX', 'TX']);
  });

  test('a wrapper built before the transaction still picks it up', async () => {
    // Repositories hold long-lived handles; resolving the session per CALL
    // rather than per wrapper is what makes that work.
    const a = fakeAdapter();
    const repo = wrapperFor(a);
    await runWithSession(a, 'TX', async () => { await repo.findMany({}); });
    await repo.findMany({});
    expect(a.seen.map((s) => s.session)).toEqual(['TX', undefined]);
  });

  test('the scope ends with the callback, so later work is not captured', async () => {
    const a = fakeAdapter();
    await runWithSession(a, 'TX', async () => { await wrapperFor(a).findMany({}); });
    await wrapperFor(a).findMany({});
    expect(a.seen.map((s) => s.session)).toEqual(['TX', undefined]);
  });

  test('it survives an await boundary inside the callback', async () => {
    const a = fakeAdapter();
    await runWithSession(a, 'TX', async () => {
      await new Promise((r) => setTimeout(r, 1));
      await wrapperFor(a).findMany({});
    });
    expect(a.seen[0].session).toBe('TX');
  });
});

describe('an explicit session still wins', () => {
  test('the tx-bound wrapper uses its own, not the ambient one', async () => {
    const a = fakeAdapter();
    await runWithSession(a, 'AMBIENT', async () => {
      await wrapperFor(a, 'EXPLICIT').findMany({});
    });
    expect(a.seen[0].session).toBe('EXPLICIT');
  });
});

describe('a session never crosses adapters', () => {
  test("another adapter's queries do not pick it up", async () => {
    // A driver rejects a session it did not create, so one database's
    // transaction must not be captured by another's queries.
    const a = fakeAdapter();
    const b = fakeAdapter();
    await runWithSession(a, 'TX-A', async () => { await wrapperFor(b).findMany({}); });
    expect(b.seen[0].session).toBeUndefined();
  });

  test('currentSession is adapter-keyed', () => {
    const a = {}; const b = {};
    runWithSession(a, 'TX-A', () => {
      expect(currentSession(a)).toBe('TX-A');
      expect(currentSession(b)).toBeUndefined();
    });
  });
});

describe('the session store', () => {
  test('async context is available on Node', () => {
    expect(ambientSessionsSupported()).toBe(true);
  });

  test('there is no ambient session by default', () => {
    expect(currentSession({})).toBeUndefined();
  });

  test('the scope does not outlive the call', () => {
    const a = {};
    runWithSession(a, 's', () => undefined);
    expect(currentSession(a)).toBeUndefined();
  });
});
