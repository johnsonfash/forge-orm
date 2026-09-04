// Per-dialect entry points — `forge-orm/postgres`, `forge-orm/sqlite`, …
//
// The main entry picks your adapter from the URL prefix and pulls the
// driver in with `require(pkg)`, where `pkg` is computed at runtime. No
// bundler can see through that: webpack, rollup, esbuild and Vite all
// lose the dependency, so a bundled target (Workers, Vercel Edge, a
// bundled Lambda) either drops the driver or dies at runtime a long way
// from the cause. It also pins all six adapters into the bundle, because
// nothing proves which one is in use.
//
// The entries in src/entries fix that by importing exactly one driver
// STATICALLY, and by re-exporting the whole of the main index so a single
// import line still covers the schema DSL:
//
//     import { createDb, f, model } from 'forge-orm/sqlite';
//
// Three things have to hold for that promise to be real, and each is
// easy to break by accident, so each has tests below:
//
//   1. The re-export is genuinely the SAME module — not a copy, not a
//      subset. `f` from the entry has to be `f` from the index, or a
//      model built through one and registered through the other would
//      quietly fail an identity check somewhere downstream.
//   2. The entry's own `createDb` has to WIN over the `createDb` that
//      arrives via `export * from './_shared'` (which re-exports the
//      index, factory `createDb` and all). If the star export shadowed
//      the local one, every call would fall back through the runtime
//      require and the entries would be pure ceremony — the emit order
//      that makes the local one win is a compiler detail, so it is
//      asserted rather than assumed.
//   3. sqlite's private `filename()` transform has to accept all the URL
//      shapes the docs promise. It is not exported, so it is tested
//      through a real better-sqlite3 database and PRAGMA database_list,
//      which reports the file the driver actually opened.
//
// Postgres, MySQL and Mongo need a live server to connect, so those are
// tested for module shape only — no connection is attempted anywhere in
// this file.

import { mkdtempSync, realpathSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import * as index from '../index';
import * as mongoEntry from '../entries/mongo';
import * as mysqlEntry from '../entries/mysql';
import * as pgliteEntry from '../entries/pglite';
import * as postgresEntry from '../entries/postgres';
import * as sqliteEntry from '../entries/sqlite';

/** Every entry, with the dialect name each one reports in its errors. */
const entries = [
  ['postgres', postgresEntry],
  ['mysql', mysqlEntry],
  ['sqlite', sqliteEntry],
  ['pglite', pgliteEntry],
  ['mongo', mongoEntry],
] as const;

const { f, model } = index;

const Widget = model('widget', {
  id: f.id(),
  name: f.string(),
  size: f.int(),
});
const appSchema = { Widget } as any;

describe('each entry re-exports the core API', () => {
  // The selling point is "one import line is enough". If the re-export
  // were a shallow copy or a hand-maintained subset, this is where it
  // would show: the entry's `f` would be a different object from the
  // index's, and a schema built through the entry would be a different
  // schema as far as any identity check is concerned.
  it.each(entries)('%s re-exports the SAME f / model / rel as the index', (_name, entry) => {
    expect((entry as any).f).toBe(index.f);
    expect((entry as any).model).toBe(index.model);
    expect((entry as any).rel).toBe(index.rel);
  });

  it.each(entries)('%s re-exports working functions, not just bound names', (_name, entry) => {
    const e = entry as any;
    expect(typeof e.f.string).toBe('function');
    expect(typeof e.model).toBe('function');

    // Build a model entirely through the entry's exports. This is the
    // call an app would make after `import { f, model } from
    // 'forge-orm/sqlite'`, so it has to produce a usable model.
    const Gadget = e.model('gadget', { id: e.f.id(), label: e.f.string() }) as any;
    expect(Gadget.collection).toBe('gadget');
    expect(Object.keys(Gadget.fields)).toEqual(['id', 'label']);
    expect(Gadget.fields.label.kind).toBe('string');
  });

  it.each(entries)('%s carries the rest of the surface through too', (_name, entry) => {
    const e = entry as any;
    // A spot check across unrelated corners of the index — the schema
    // DSL, the driver wrappers, the URL detector, the raw-SQL tag —
    // because `export *` either brings everything or the entry is not
    // a drop-in replacement for the main import.
    expect(e.detectAdapterKind).toBe(index.detectAdapterKind);
    expect(e.forgeSql).toBe(index.forgeSql);
    expect(e.col).toBe(index.col);
    expect(e.betterSqlite3Driver).toBe(index.betterSqlite3Driver);
    expect(e.setActiveSchema).toBe(index.setActiveSchema);
  });
});

describe('each entry exports its own createDb', () => {
  it.each(entries)('%s exports createDb as a function', (_name, entry) => {
    expect(typeof (entry as any).createDb).toBe('function');
  });

  // The whole point of the file. `export * from './_shared'` re-exports
  // the index, which exports the factory's `createDb` — so the entry
  // exports that name twice, and only the locally declared one takes
  // the url apart with a statically imported driver. If the star export
  // ever wins, the entries still "work" and still tree-shake nothing,
  // which is exactly the sort of regression nobody notices.
  it.each(entries)('%s createDb is the dialect wrapper, NOT the factory one', (_name, entry) => {
    expect((entry as any).createDb).not.toBe(index.createDb);
  });

  it('the factory createDb is still reachable — it is the same object everywhere', () => {
    // Sanity check on the assertion above: the index's createDb really
    // is a single shared reference, so `not.toBe` above means "shadowed",
    // not "two copies of the same module".
    expect(index.createDb).toBe(require('../factory').createDb);
  });
});

describe('createDb without a url', () => {
  // connectWith() builds the driver from the url, so a missing url used
  // to surface as whatever the driver constructor did with `undefined`
  // — `new pg.Pool({ connectionString: undefined })` connects to
  // localhost, `new Database(undefined)` throws about types. The guard
  // has to fire first, name the dialect that was imported, and point at
  // the escape hatch (the main entry's `driver` option) for the case
  // where the caller needs to configure the client by hand.
  //
  // Nothing connects here: the guard runs before the driver is built.
  it.each(entries)('%s rejects with a message naming the dialect', async (name, entry) => {
    await expect((entry as any).createDb({ schema: appSchema })).rejects.toThrow(
      `createDb from 'forge-orm/${name}' needs a url`,
    );
  });

  it.each(entries)('%s points at the driver option as the way out', async (_name, entry) => {
    await expect((entry as any).createDb({ schema: appSchema })).rejects.toThrow(/driver option/);
  });

  it('an empty-string url counts as no url, rather than an empty filename', async () => {
    // `sqlite:` is a legitimate in-memory url (below); `''` is not one,
    // and must not slip through into `new Database('')`.
    await expect(sqliteEntry.createDb({ url: '', schema: appSchema } as any)).rejects.toThrow(
      /needs a url/,
    );
  });
});

describe('the sqlite entry, against a real better-sqlite3 database', () => {
  let dir: string;
  const open: Array<{ $disconnect(): Promise<void> }> = [];

  /** Where better-sqlite3 actually opened its file — '' means in-memory. */
  const openedFile = async (db: any): Promise<string> => {
    const rows = await db.$queryRaw`PRAGMA database_list`;
    return rows.find((r: any) => r.name === 'main').file;
  };

  const connect = async (url: string) => {
    const db = (await sqliteEntry.createDb({ url, schema: appSchema } as any)) as any;
    open.push(db);
    return db;
  };

  beforeEach(() => {
    // realpath: on macOS tmpdir() is a symlink into /private, and sqlite
    // reports the resolved path back — so the expected and actual strings
    // would differ for a reason that has nothing to do with the code.
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'forge-dialect-entries-')));
  });

  afterEach(async () => {
    // Close every handle before unlinking, or Windows/NFS leave the file
    // locked and the next test inherits a half-deleted directory.
    for (const db of open.splice(0)) await db.$disconnect();
    rmSync(dir, { recursive: true, force: true });
  });

  // filename() is private, so these three cases are the only way to
  // prove the transform: whatever it returns is the string better-
  // sqlite3 opened, and PRAGMA database_list reports it back.
  it('opens the file behind a sqlite:// url', async () => {
    const file = join(dir, 'a.db');
    const db = await connect(`sqlite://${file}`);
    expect(await openedFile(db)).toBe(file);
    expect(existsSync(file)).toBe(true);
  });

  it('opens the file behind a file: url', async () => {
    const file = join(dir, 'b.db');
    const db = await connect(`file:${file}`);
    expect(await openedFile(db)).toBe(file);
    expect(existsSync(file)).toBe(true);
  });

  it('a bare sqlite: is an in-memory database', async () => {
    // The scheme strips to '', which the transform turns into
    // ':memory:'. An in-memory database reports an empty file path —
    // and, crucially, writes nothing to disk.
    const db = await connect('sqlite:');
    expect(await openedFile(db)).toBe('');
  });

  it('the scheme is matched case-insensitively, like every other url', async () => {
    const file = join(dir, 'c.db');
    const db = await connect(`SQLite://${file}`);
    expect(await openedFile(db)).toBe(file);
  });

  it('a bare path with no scheme at all is taken as the filename', async () => {
    const file = join(dir, 'd.db');
    const db = await connect(file);
    expect(await openedFile(db)).toBe(file);
  });

  // Everything above proves the file was opened. This proves the db that
  // came back is a real ForgeDb wired to it — schema registered, DDL
  // applied, rows in and out — which is what "one import line is enough"
  // actually claims.
  it('returns a working ForgeDb: $migrate, create, findMany', async () => {
    const file = join(dir, 'app.db');
    const db = await connect(`sqlite://${file}`);

    const report = await db.$migrate();
    expect(report.applied).toContain('widget');
    expect(report.failures).toEqual([]);

    const made = await db.Widget.create({ data: { name: 'anvil', size: 3 } });
    expect(made.name).toBe('anvil');

    const rows = await db.Widget.findMany({ where: { name: 'anvil' } });
    expect(rows).toHaveLength(1);
    expect(rows[0].size).toBe(3);
    expect(rows[0].id).toBe(made.id);
  });

  it('the row really landed in the file, not in a memory db by accident', async () => {
    // The failure this guards against is a url transform that quietly
    // degrades to ':memory:' — every assertion above about the query
    // path would still pass, and the app would silently lose its data
    // on restart. So: write, close, reopen the same path, read back.
    const file = join(dir, 'persist.db');
    const first = await connect(`sqlite://${file}`);
    await first.$migrate();
    await first.Widget.create({ data: { name: 'kept', size: 1 } });
    await first.$disconnect();
    open.pop();

    const second = await connect(`file:${file}`);
    const rows = await second.Widget.findMany({ where: { name: 'kept' } });
    expect(rows).toHaveLength(1);
  });

  it('$executeRaw and $queryRaw go to the same database as the model API', async () => {
    // The db handed back is one adapter, not a model API bolted onto a
    // separate connection — a table made with raw SQL is visible to the
    // typed reader, and vice versa.
    const db = await connect('sqlite:');
    await db.$executeRaw`CREATE TABLE widget (id TEXT PRIMARY KEY, name TEXT, size INTEGER)`;
    await db.Widget.create({ data: { name: 'raw', size: 7 } });
    const rows = await db.$queryRaw`SELECT name, size FROM widget`;
    expect(rows).toEqual([{ name: 'raw', size: 7 }]);
  });
});
