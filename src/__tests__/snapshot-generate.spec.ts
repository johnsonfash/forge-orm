// Generating a migration from a snapshot instead of from a database.
//
// `forge diff apply` produces a migration by introspecting DATABASE_URL.
// That is right for adopting an existing database and wrong for
// everything else: it cannot run in CI, so nothing can verify that a
// schema change shipped with its migration; and two developers on two
// branches each generate against their own local state, so each file is
// correct only relative to a world that stops existing at the merge.
//
// A snapshot is what `introspect()` WOULD return if the schema were
// applied. `diffIntrospection` already takes a `DbIntrospection` as its
// "actual" side and cannot tell where it came from — so the whole change
// is about supplying that from a committed file rather than a socket.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { f, model } from '../schema/core';
import { generateMigration } from '../scripts/migrate-gen';
import {
  latestSnapshot,
  projectSchema,
  readJournal,
  writeJournal,
  writeSnapshot,
} from '../scripts/snapshot';

const orgs = (extra: Record<string, unknown> = {}, opts: any = {}) => ({
  Org: model('orgs', {
    id: f.id(),
    name: f.string(),
    createdAt: f.dateTime().default('now'),
    ...extra,
  }, opts),
});

describe('projectSchema', () => {
  it('produces what introspection would report', () => {
    const snap = projectSchema(orgs(), 'postgres');
    expect(snap.kind).toBe('postgres');
    expect(snap.tables.map((t) => t.name)).toEqual(['orgs']);
    const cols = snap.tables[0]!.columns.map((c) => c.name);
    expect(cols).toEqual(['createdAt', 'id', 'name']);
    expect(snap.tables[0]!.columns.find((c) => c.name === 'name')!.type).toBe('text');
  });

  it('is stable under reordering, so a review diff is the schema change', () => {
    // Without sorting, moving two models in the schema file rewrites the
    // whole snapshot and buries the actual change.
    const a = projectSchema({ ...orgs(), Zed: model('zeds', { id: f.id() }) }, 'postgres');
    const b = projectSchema({ Zed: model('zeds', { id: f.id() }), ...orgs() }, 'postgres');
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('calls the primary key `_id` on Mongo and `id` everywhere else', () => {
    expect(projectSchema(orgs(), 'mongo').tables[0]!.columns.map((c) => c.name)).toContain('_id');
    expect(projectSchema(orgs(), 'postgres').tables[0]!.columns.map((c) => c.name)).toContain('id');
  });

  it('claims no column types on Mongo', () => {
    // Mongo introspection reports none. Inventing them would make every
    // diff show drift forever.
    const snap = projectSchema(orgs(), 'mongo');
    expect(snap.tables[0]!.columns.every((c) => c.type === '')).toBe(true);
  });

  it('emits no foreign keys on Mongo', () => {
    expect(projectSchema(orgs(), 'mongo').tables[0]!.foreignKeys).toEqual([]);
  });

  it('round-trips through JSON — it IS the on-disk format', () => {
    const snap = projectSchema(orgs(), 'postgres');
    expect(JSON.parse(JSON.stringify(snap))).toEqual(snap);
  });
});

describe('generating against a snapshot', () => {
  it('a first generate creates everything, with real DDL', () => {
    const empty = { kind: 'postgres' as const, tables: [], views: [] };
    const pairs = generateMigration(orgs() as never, empty);
    const up = pairs.map((p) => p.up).join('\n');
    // It used to emit `-- create table 'orgs' via forge:push`, on the
    // assumption push had just run. Against a snapshot the file is the
    // only record, and a migration whose up is a comment applies cleanly
    // and creates nothing.
    expect(up).toMatch(/CREATE TABLE/i);
    expect(up).toMatch(/"orgs"/);
    expect(up).not.toMatch(/via forge:push/);
    expect(pairs.some((p) => /DROP TABLE IF EXISTS "orgs"/.test(p.down))).toBe(true);
  });

  it('a second generate emits only the delta', () => {
    const first = projectSchema(orgs(), 'postgres');
    const pairs = generateMigration(orgs({ slug: f.string().optional() }) as never, first);
    const up = pairs.map((p) => p.up).join('\n');
    expect(up).toMatch(/ADD COLUMN "slug"/);
    expect(up).not.toMatch(/CREATE TABLE/i);
  });

  it('an unchanged schema generates nothing', () => {
    const snap = projectSchema(orgs(), 'postgres');
    expect(generateMigration(orgs() as never, snap)).toEqual([]);
  });

  it('the snapshot it writes is the state the NEXT diff starts from', () => {
    // The property that makes the chain work: applying a generated
    // migration to its previous snapshot must land on the new one.
    const before = projectSchema(orgs(), 'postgres');
    const after = projectSchema(orgs({ slug: f.string().optional() }), 'postgres');
    expect(generateMigration(orgs({ slug: f.string().optional() }) as never, before).length)
      .toBeGreaterThan(0);
    expect(generateMigration(orgs({ slug: f.string().optional() }) as never, after)).toEqual([]);
  });
});

describe('the migrations folder', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-snap-'));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('an empty folder means an empty database, not a special case', () => {
    const { snapshot, nextIdx } = latestSnapshot(dir, 'postgres');
    expect(snapshot.tables).toEqual([]);
    expect(nextIdx).toBe('0001');
  });

  it('numbers each migration in sequence', () => {
    writeJournal(dir, {
      version: 1,
      dialect: 'postgres',
      entries: [{ idx: '0001', file: '0001_a.sql', createdAt: 'x' }],
    });
    writeSnapshot(dir, '0001', projectSchema(orgs(), 'postgres'));
    const { snapshot, nextIdx } = latestSnapshot(dir, 'postgres');
    expect(nextIdx).toBe('0002');
    expect(snapshot.tables.map((t) => t.name)).toEqual(['orgs']);
  });

  it('refuses a folder generated for a different dialect', () => {
    // A snapshot describes ONE dialect — column types and index shapes
    // differ. Silently diffing postgres types against a mysql snapshot
    // would generate an ALTER for every column in the schema.
    writeJournal(dir, { version: 1, dialect: 'mysql', entries: [] });
    expect(() => latestSnapshot(dir, 'postgres')).toThrow(/generated for 'mysql'/);
  });

  it('writes a journal a human can read', () => {
    writeJournal(dir, {
      version: 1,
      dialect: 'postgres',
      entries: [{ idx: '0001', file: '0001_a.sql', createdAt: 'x', label: 'a' }],
    });
    const j = readJournal(dir)!;
    expect(j.entries[0]!.file).toBe('0001_a.sql');
    expect(fs.readFileSync(path.join(dir, 'meta', '_journal.json'), 'utf8')).toContain('\n');
  });
});
