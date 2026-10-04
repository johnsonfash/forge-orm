// 2.20.5 — the Mongo index set at RUNTIME.
//
// `forge push` was the only way to create a declared Mongo index, and the CLI
// needs a shell, its own connection, and somebody to remember to run it. A
// server that wants its indexes guaranteed present before it serves a request
// had nowhere to call, so applications hand-rolled a boot-time createIndex
// loop — and a hand-rolled loop has no listIndexes diff, so it re-issues every
// index on every boot and silently diverges from the schema it was copied from.
//
// These cover the three things that were missing: applyIndexes() against a
// caller-supplied Db, the dry-run plan, and prune/report of indexes the schema
// does not declare. Plus the TTL drift the differ could not see.

import { f, model } from '../schema/core';
import type { ModelDef } from '../schema/types';
import { applyIndexes } from '../adapters/mongo/apply-indexes';
import { indexNameFor } from '../adapters/mongo/index-name';
import { diffIntrospection } from '../scripts/diff-core';

// A Db double. Only the surface applyIndexes touches: collection(),
// listCollections(), createCollection(), dropCollection(). Every call is
// recorded so the tests can assert what reached the driver — which is the
// whole point: "did it write, and exactly what".
interface Call { op: string; collection: string; args: unknown[] }

function fakeDb(existing: Record<string, { name: string; key: any; [k: string]: any }[]> = {}) {
  const calls: Call[] = [];
  const live: Record<string, any[]> = {};
  for (const [c, idx] of Object.entries(existing)) live[c] = [...idx];

  const collection = (name: string) => ({
    listIndexes: () => ({
      toArray: async () => {
        if (!live[name]) {
          const err: any = new Error('ns does not exist');
          err.code = 26;      // NamespaceNotFound — a brand-new collection
          throw err;
        }
        return live[name];
      },
    }),
    createIndex: async (keys: any, opts: any) => {
      calls.push({ op: 'createIndex', collection: name, args: [keys, opts] });
      return opts?.name;
    },
    dropIndex: async (idxName: string) => {
      calls.push({ op: 'dropIndex', collection: name, args: [idxName] });
    },
    aggregate: () => ({ toArray: async () => [] }),
  });

  const db = {
    collection,
    listCollections: () => ({ toArray: async () => [] }),
    createCollection: async (name: string, opts: any) => {
      calls.push({ op: 'createCollection', collection: name, args: [opts] });
    },
    dropCollection: async (name: string) => {
      calls.push({ op: 'dropCollection', collection: name, args: [] });
    },
  };

  return { db: db as never, calls };
}

const Session = () =>
  model('sessions', {
    id: f.id(),
    token: f.string().unique(),
    orgId: f.objectId(),
    createdAt: f.dateTime().default('now'),
  }, {
    indexes: [
      { keys: { orgId: 1, createdAt: -1 } },
      { keys: { createdAt: 1 }, expireAfterSeconds: 3600, name: 'idx_sessions_ttl' },
    ],
  }) as unknown as ModelDef<any>;

// -----------------------------------------------------------------------------
// applyIndexes — the runtime entry point
// -----------------------------------------------------------------------------

describe('applyIndexes — boot-time index apply', () => {
  it('creates every declared index on a collection that has none', async () => {
    const { db, calls } = fakeDb();
    const report = await applyIndexes(db, { schema: { Session: Session() } });

    const created = calls.filter((c) => c.op === 'createIndex');
    expect(created).toHaveLength(3);                 // unique token + 2 indexes
    expect(report.created).toEqual(expect.arrayContaining([
      'idx_Session_token_uq', 'idx_Session_orgId_createdAt', 'idx_sessions_ttl',
    ]));
    expect(report.failures).toEqual([]);
    expect(report.skipped).toEqual([]);
  });

  it('runs against the Db it is handed — no process-global client', async () => {
    // The whole reason this exists: push took the process default client, so
    // an app with its own connection (or two) could not use it.
    const a = fakeDb();
    const b = fakeDb();
    await applyIndexes(a.db, { schema: { Session: Session() } });
    expect(a.calls.length).toBeGreaterThan(0);
    expect(b.calls).toEqual([]);
  });

  it('writes NOTHING on a second run against an in-sync database', async () => {
    const first = fakeDb();
    await applyIndexes(first.db, { schema: { Session: Session() } });

    // Feed back what the first run created, as Mongo would echo it.
    const live = first.calls
      .filter((c) => c.op === 'createIndex')
      .map((c) => ({ name: (c.args[1] as any).name, key: c.args[0], ...(c.args[1] as any) }));

    const second = fakeDb({ sessions: live as never });
    const report = await applyIndexes(second.db, { schema: { Session: Session() } });

    expect(second.calls.filter((c) => c.op !== 'listIndexes')).toEqual([]);
    expect(report.created).toEqual([]);
    expect(report.rebuilt).toEqual([]);
    expect(report.skipped).toHaveLength(3);
  });

  it('rebuilds an index whose declared spec drifted', async () => {
    // Same keys, different TTL — a retention-window change.
    const { db, calls } = fakeDb({
      sessions: [
        { name: 'idx_sessions_ttl', key: { createdAt: 1 }, expireAfterSeconds: 60 },
      ],
    });
    const report = await applyIndexes(db, { schema: { Session: Session() } });

    expect(report.rebuilt).toContain('idx_sessions_ttl');
    expect(calls).toEqual(expect.arrayContaining([
      expect.objectContaining({ op: 'dropIndex', args: ['idx_sessions_ttl'] }),
    ]));
  });

  it('reports a createIndex failure instead of throwing', async () => {
    // A unique index over data that already has duplicates is the common one,
    // and a boot must not die of it.
    const { db } = fakeDb();
    (db as any).collection = (name: string) => ({
      listIndexes: () => ({ toArray: async () => [] }),
      createIndex: async () => {
        const err: any = new Error('E11000 duplicate key error');
        err.code = 11000;
        throw err;
      },
      dropIndex: async () => {},
      aggregate: () => ({ toArray: async () => [] }),
    });
    const report = await applyIndexes(db, { schema: { Session: Session() } });

    expect(report.created).toEqual([]);
    expect(report.failures.length).toBeGreaterThan(0);
    expect(report.failures[0].error).toMatch(/duplicate key/);
  });

  it('is silent unless a logger is passed', async () => {
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const { db } = fakeDb();
    await applyIndexes(db, { schema: { Session: Session() } });
    expect(logSpy).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
    logSpy.mockRestore();
    warnSpy.mockRestore();
  });

  it('feeds progress lines to a logger when one is passed', async () => {
    const lines: string[] = [];
    const { db } = fakeDb();
    await applyIndexes(db, { schema: { Session: Session() }, logger: (l) => lines.push(l) });
    expect(lines.join('\n')).toContain('sessions');
    expect(lines.some((l) => l.includes('idx_sessions_ttl'))).toBe(true);
  });

  it('still refuses a bigserial id, which has no Mongo equivalent', async () => {
    const M = model('t', { id: f.id({ type: 'bigserial' }) }) as unknown as ModelDef<any>;
    const { db } = fakeDb();
    await expect(applyIndexes(db, { schema: { T: M } })).rejects.toThrow(/bigserial/);
  });
});

// -----------------------------------------------------------------------------
// dryRun — the plan
// -----------------------------------------------------------------------------

describe('applyIndexes — dryRun', () => {
  it('reports what it would create and writes nothing', async () => {
    const { db, calls } = fakeDb();
    const report = await applyIndexes(db, { schema: { Session: Session() }, dryRun: true });

    expect(report.created).toHaveLength(3);
    expect(calls.filter((c) => c.op === 'createIndex')).toEqual([]);
    expect(calls.filter((c) => c.op === 'dropIndex')).toEqual([]);
  });

  it('reports a drifted index as a rebuild without dropping it', async () => {
    const { db, calls } = fakeDb({
      sessions: [{ name: 'idx_sessions_ttl', key: { createdAt: 1 }, expireAfterSeconds: 60 }],
    });
    const report = await applyIndexes(db, { schema: { Session: Session() }, dryRun: true });

    expect(report.rebuilt).toContain('idx_sessions_ttl');
    expect(calls.filter((c) => c.op === 'dropIndex')).toEqual([]);
  });

  it('does not create or replace views', async () => {
    const V = (model('active_sessions', { id: f.id(), orgId: f.objectId() }) as any)
      .asView({ sourceCollection: 'sessions', pipeline: [{ $match: { revoked: false } }] }) as ModelDef<any>;
    const { db, calls } = fakeDb();
    const report = await applyIndexes(db, { schema: { V }, dryRun: true });

    expect(report.views).toEqual(['active_sessions']);
    expect(calls).toEqual([]);
  });
});

// -----------------------------------------------------------------------------
// Undeclared indexes — report always, drop only on request
// -----------------------------------------------------------------------------

describe('applyIndexes — undeclared indexes', () => {
  const liveWithStrays = () => fakeDb({
    sessions: [
      { name: '_id_', key: { _id: 1 } },
      { name: 'idx_left_over', key: { legacyField: 1 } },
      { name: 'forge_sessions_fts', key: { body: 'text' } },
    ],
  });

  it('reports them and leaves them alone by default', async () => {
    const { db, calls } = liveWithStrays();
    const report = await applyIndexes(db, { schema: { Session: Session() } });

    expect(report.extra).toEqual([{ collection: 'sessions', name: 'idx_left_over' }]);
    expect(report.dropped).toEqual([]);
    expect(calls.filter((c) => c.op === 'dropIndex')).toEqual([]);
  });

  it('never counts _id_ or an *_fts shadow as undeclared', async () => {
    const { db } = liveWithStrays();
    const report = await applyIndexes(db, { schema: { Session: Session() } });
    const names = report.extra.map((e) => e.name);
    expect(names).not.toContain('_id_');
    expect(names).not.toContain('forge_sessions_fts');
  });

  it('drops them when prune is set', async () => {
    const { db, calls } = liveWithStrays();
    const report = await applyIndexes(db, { schema: { Session: Session() }, prune: true });

    expect(report.dropped).toEqual([{ collection: 'sessions', name: 'idx_left_over' }]);
    expect(calls).toEqual(expect.arrayContaining([
      expect.objectContaining({ op: 'dropIndex', args: ['idx_left_over'] }),
    ]));
    // _id_ is not droppable and must never be attempted.
    expect(calls.filter((c) => c.op === 'dropIndex' && c.args[0] === '_id_')).toEqual([]);
  });

  it('plans the drop under prune + dryRun without issuing it', async () => {
    const { db, calls } = liveWithStrays();
    const report = await applyIndexes(db, {
      schema: { Session: Session() }, prune: true, dryRun: true,
    });
    expect(report.dropped).toEqual([{ collection: 'sessions', name: 'idx_left_over' }]);
    expect(calls.filter((c) => c.op === 'dropIndex')).toEqual([]);
  });
});

// -----------------------------------------------------------------------------
// The auto-name rule, shared by push and diff
// -----------------------------------------------------------------------------

describe('indexNameFor', () => {
  it('matches the name push has always generated', () => {
    expect(indexNameFor('Session', { orgId: 1, createdAt: -1 }))
      .toBe('idx_Session_orgId_createdAt');
    expect(indexNameFor('Session', { token: 1 }, true)).toBe('idx_Session_token_uq');
  });

  it('collapses characters that cannot appear in an identifier', () => {
    expect(indexNameFor('Doc', { '$**': 1 })).toBe('idx_Doc____');
    expect(indexNameFor('Org', { 'email_config.alias': 1 }))
      .toBe('idx_Org_email_config_alias');
  });
});

// -----------------------------------------------------------------------------
// TTL drift — introspected and compared since 2.20.5
// -----------------------------------------------------------------------------

describe('diff — Mongo TTL drift', () => {
  const ttlModel = (seconds: number, name?: string) =>
    model('sessions', { id: f.id(), createdAt: f.dateTime() }, {
      indexes: [{ keys: { createdAt: 1 }, expireAfterSeconds: seconds, ...(name ? { name } : {}) }],
    }) as unknown as ModelDef<any>;

  const liveMongo = (indexes: any[]) => ({
    kind: 'mongo' as const,
    tables: [{ name: 'sessions', columns: [], foreignKeys: [], indexes }],
    views: [],
  });

  it('reports a changed retention window', () => {
    const r = diffIntrospection({ Session: ttlModel(3600, 'idx_ttl') }, liveMongo([
      { name: 'idx_ttl', columns: ['createdAt'], unique: false, expireAfterSeconds: 60, keySpec: { createdAt: 1 } },
    ]) as never, []);
    const item = r.items.find((i) => i.detail.includes('expireAfterSeconds'));
    expect(item).toBeDefined();
    expect(item!.detail).toContain('schema=3600');
    expect(item!.detail).toContain('db=60');
  });

  it('reports a TTL that has gone missing from the live index', () => {
    // The worse direction: documents quietly stop expiring and nothing says so.
    const r = diffIntrospection({ Session: ttlModel(3600, 'idx_ttl') }, liveMongo([
      { name: 'idx_ttl', columns: ['createdAt'], unique: false, keySpec: { createdAt: 1 } },
    ]) as never, []);
    expect(r.items.some((i) => i.detail.includes('expireAfterSeconds'))).toBe(true);
  });

  it('treats expireAfterSeconds: 0 as a value, not as absent', () => {
    const r = diffIntrospection({ Session: ttlModel(0, 'idx_ttl') }, liveMongo([
      { name: 'idx_ttl', columns: ['createdAt'], unique: false, expireAfterSeconds: 0, keySpec: { createdAt: 1 } },
    ]) as never, []);
    expect(r.items.some((i) => i.detail.includes('expireAfterSeconds'))).toBe(false);
  });

  it('says nothing when the TTL matches', () => {
    const r = diffIntrospection({ Session: ttlModel(3600, 'idx_ttl') }, liveMongo([
      { name: 'idx_ttl', columns: ['createdAt'], unique: false, expireAfterSeconds: 3600, keySpec: { createdAt: 1 } },
    ]) as never, []);
    expect(r.items.some((i) => i.detail.includes('expireAfterSeconds'))).toBe(false);
  });

  it('finds an UNNAMED index under the name push gave it, and compares its TTL', () => {
    // The deep pass only ever matched on an explicit `name`, so on Mongo —
    // where naming an index by hand is rare — it never ran at all.
    const r = diffIntrospection({ Session: ttlModel(3600) }, liveMongo([
      {
        name: 'idx_Session_createdAt', columns: ['createdAt'], unique: false,
        expireAfterSeconds: 60, keySpec: { createdAt: 1 },
      },
    ]) as never, []);
    const item = r.items.find((i) => i.detail.includes('expireAfterSeconds'));
    expect(item).toBeDefined();
    expect(item!.detail).toContain(`index 'idx_Session_createdAt'`);
  });
});

// -----------------------------------------------------------------------------
// Drift false-positives the deep-pass fallback must not introduce
// -----------------------------------------------------------------------------

describe('diff — Mongo index comparison does not cry wolf', () => {
  const liveMongo = (table: string, indexes: any[]) => ({
    kind: 'mongo' as const,
    tables: [{ name: table, columns: [], foreignKeys: [], indexes }],
    views: [],
  });

  it("method: 'spatial' is compared as the 2dsphere token push actually creates", () => {
    const Place = model('places', { id: f.id(), location: f.geoPoint() }, {
      indexes: [{ keys: { location: 1 }, method: 'spatial' }],
    }) as unknown as ModelDef<any>;
    const r = diffIntrospection({ Place }, liveMongo('places', [
      { name: '_id_', columns: ['_id'], unique: true, keySpec: { _id: 1 } },
      {
        name: 'idx_Place_location', columns: ['location'], unique: false,
        keySpec: { location: '2dsphere' },
      },
    ]) as never, []);
    expect(r.items.filter((i) => i.kind === 'index')).toEqual([]);
  });

  it('`id` in a declared key is compared as `_id`', () => {
    const M = model('messages', { id: f.id(), threadId: f.objectId() }, {
      indexes: [{ keys: { threadId: 1, id: -1 } }],
    }) as unknown as ModelDef<any>;
    const r = diffIntrospection({ M }, liveMongo('messages', [
      { name: '_id_', columns: ['_id'], unique: true, keySpec: { _id: 1 } },
      {
        name: 'idx_M_threadId__id', columns: ['threadId', '_id'], unique: false,
        keySpec: { threadId: 1, _id: -1 },
      },
    ]) as never, []);
    expect(r.items.filter((i) => i.kind === 'index')).toEqual([]);
  });

  it("method: 'vector' is not reported missing on Mongo — push skips it by design", () => {
    // Atlas Vector Search is a separate Search Index API, so push warns and
    // skips. Reporting it missing was permanent drift nobody could clear.
    const Doc = model('docs', { id: f.id(), embedding: f.vector(4) }, {
      indexes: [{ keys: { embedding: 1 }, method: 'vector' }],
    }) as unknown as ModelDef<any>;
    const r = diffIntrospection({ Doc }, liveMongo('docs', [
      { name: '_id_', columns: ['_id'], unique: true, keySpec: { _id: 1 } },
    ]) as never, []);
    expect(r.items.filter((i) => i.kind === 'index')).toEqual([]);
  });

  it('still reports it missing on Postgres, where push really does create it', () => {
    const Doc = model('docs', { id: f.id(), embedding: f.vector(4) }, {
      indexes: [{ keys: { embedding: 1 }, method: 'vector' }],
    }) as unknown as ModelDef<any>;
    const r = diffIntrospection({ Doc }, {
      kind: 'postgres',
      tables: [{
        name: 'docs',
        columns: [{ name: 'id', type: 'text', nullable: false }, { name: 'embedding', type: 'vector', nullable: false }],
        foreignKeys: [],
        indexes: [{ name: 'docs_pkey', columns: ['id'], unique: true }],
      }],
      views: [],
    } as never, []);
    expect(r.items.some((i) => i.kind === 'index' && i.direction === 'missing')).toBe(true);
  });

  it('leaves an unnamed index on a SQL dialect out of the deep pass', () => {
    // The Mongo auto-name is derived from the SCHEMA KEY; SQL names come from
    // the TABLE. Matching a SQL index by the Mongo name would be luck.
    const M = model('items', { id: f.id(), sku: f.string() }, {
      indexes: [{ keys: { sku: 1 }, method: 'gin' }],
    }) as unknown as ModelDef<any>;
    const r = diffIntrospection({ M }, {
      kind: 'postgres',
      tables: [{
        name: 'items',
        columns: [{ name: 'id', type: 'text', nullable: false }, { name: 'sku', type: 'text', nullable: false }],
        foreignKeys: [],
        indexes: [
          { name: 'items_pkey', columns: ['id'], unique: true, method: 'btree' },
          { name: 'idx_M_sku', columns: ['sku'], unique: false, method: 'btree' },
        ],
      }],
      views: [],
    } as never, []);
    expect(r.items.some((i) => i.detail.includes('method'))).toBe(false);
  });
});

// -----------------------------------------------------------------------------
// A Mongo schema that matches the database reports NO drift
// -----------------------------------------------------------------------------

describe('diff — a matching Mongo collection is silent', () => {
  it('does not report the primary key as both missing and extra', () => {
    // `id` in the schema, `_id` in the database. Every Mongo collection
    // reported "missing index u:id" AND "extra unique index u:_id" — two
    // permanent drift items per collection that no push could ever clear.
    const M = model('widgets', {
      id: f.id(),
      sku: f.string().unique(),
      orgId: f.objectId(),
    }, {
      uniques: [['orgId', 'id']],
      indexes: [{ keys: { orgId: 1 } }],
    }) as unknown as ModelDef<any>;

    const r = diffIntrospection({ M }, {
      kind: 'mongo',
      tables: [{
        name: 'widgets', columns: [], foreignKeys: [],
        indexes: [
          { name: '_id_', columns: ['_id'], unique: true, keySpec: { _id: 1 } },
          { name: 'idx_M_sku_uq', columns: ['sku'], unique: true, keySpec: { sku: 1 } },
          { name: 'idx_M_orgId__id_uq', columns: ['orgId', '_id'], unique: true, keySpec: { orgId: 1, _id: 1 } },
          { name: 'idx_M_orgId', columns: ['orgId'], unique: false, keySpec: { orgId: 1 } },
        ],
      }],
      views: [],
    } as never, []);

    expect(r.items).toEqual([]);
    expect(r.inSync).toBe(true);
  });
});

// -----------------------------------------------------------------------------
// db.$migrate() on the mongo adapter
// -----------------------------------------------------------------------------

describe('db.$migrate() — mongo', () => {
  // A mock MongoClient is a documented use of mongoDriver(), so the whole
  // factory path is exercisable without a server.
  const fakeClient = (dbHandle: unknown) => ({
    connect: async () => {},
    db: () => dbHandle,
    close: async () => {},
  });

  let logSpy: jest.SpyInstance;
  beforeEach(() => { logSpy = jest.spyOn(console, 'log').mockImplementation(() => {}); });
  afterEach(() => { logSpy.mockRestore(); });

  it('applies the declared indexes instead of throwing', async () => {
    const { createDb } = require('../factory');
    const { mongoDriver } = require('../adapters/mongo/driver');
    const { db: handle, calls } = fakeDb();
    (handle as any).databaseName = 'test';

    const schema = { Session: Session() };
    const forge = await createDb({ driver: mongoDriver(fakeClient(handle), 'test'), schema });
    const report = await forge.$migrate();

    expect(report.applied).toEqual(expect.arrayContaining(['idx_sessions_ttl']));
    expect(report.failures).toEqual([]);
    expect(calls.filter((c) => c.op === 'createIndex')).toHaveLength(3);
    await forge.$disconnect();
  });

  it('surfaces undeclared indexes under `pending` and leaves them alone', async () => {
    const { createDb } = require('../factory');
    const { mongoDriver } = require('../adapters/mongo/driver');
    const { db: handle, calls } = fakeDb({
      sessions: [{ name: 'idx_stale', key: { gone: 1 } }],
    });
    (handle as any).databaseName = 'test';

    const forge = await createDb({
      driver: mongoDriver(fakeClient(handle), 'test'),
      schema: { Session: Session() },
    });
    const report = await forge.$migrate();

    expect(report.pending).toEqual([{
      kind: 'index', direction: 'extra', table: 'sessions',
      detail: `index 'idx_stale' in DB but not in schema`,
    }]);
    expect(calls.filter((c) => c.op === 'dropIndex')).toEqual([]);
    await forge.$disconnect();
  });

  it('writes nothing under dryRun', async () => {
    const { createDb } = require('../factory');
    const { mongoDriver } = require('../adapters/mongo/driver');
    const { db: handle, calls } = fakeDb();
    (handle as any).databaseName = 'test';

    const forge = await createDb({
      driver: mongoDriver(fakeClient(handle), 'test'),
      schema: { Session: Session() },
    });
    const report = await forge.$migrate({ dryRun: true });

    expect(report.applied).toHaveLength(3);
    expect(calls.filter((c) => c.op === 'createIndex')).toEqual([]);
    await forge.$disconnect();
  });
});
