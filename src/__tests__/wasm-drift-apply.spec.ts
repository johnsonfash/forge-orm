import Database from 'better-sqlite3';
import { betterSqlite3Driver } from '../adapters/sqlite/driver';
import { runMigrate } from '../wasm/migrate';
import { applyDrift } from '../wasm/drift-apply';
import { f, model } from '../schema/core';

// Real in-memory sqlite via better-sqlite3. The wasm/drift-apply path is
// SqliteDriver-agnostic — what matters is the introspect-then-diff loop, which
// needs round-tripping PRAGMA table_info / index_list. Better-sqlite3 gives us
// that without spinning up a worker.

function open() {
  const real = new Database(':memory:');
  return { real, driver: betterSqlite3Driver(real) };
}

const baseSchema = () => ({
  item: model('items', {
    id:         f.id(),
    name:       f.string(),
    created_at: f.dateTime().default('now'),
  }),
});

describe('runMigrate — drift-apply (2.5.1)', () => {
  test('first call creates the table; second call no-ops', async () => {
    const { driver, real } = open();
    const schema = baseSchema();

    const r1 = await runMigrate(driver, { schema });
    expect(r1.applied).toContain('items');
    expect(r1.alteredColumns).toEqual([]);
    expect(r1.pending).toEqual([]);

    const r2 = await runMigrate(driver, { schema });
    expect(r2.applied).toEqual([]);          // CREATE pass: nothing new
    expect(r2.skipped).toContain('items');
    expect(r2.alteredColumns).toEqual([]);   // drift pass: in sync
    expect(r2.pending).toEqual([]);
    real.close();
  });

  test('adding a nullable column to the schema triggers ALTER TABLE ADD COLUMN', async () => {
    const { driver, real } = open();

    await runMigrate(driver, { schema: baseSchema() });
    real.exec(`INSERT INTO items (id, name) VALUES ('x', 'one')`);

    const evolved = {
      item: model('items', {
        id:         f.id(),
        name:       f.string(),
        created_at: f.dateTime().default('now'),
        email:      f.string().optional(),            // ← added, nullable
      }),
    };

    const r = await runMigrate(driver, { schema: evolved });
    expect(r.alteredColumns).toContain('items.email');
    expect(r.pending).toEqual([]);

    // Existing row survives; new column reads as NULL.
    const row = real.prepare(`SELECT id, name, email FROM items`).get() as any;
    expect(row.id).toBe('x');
    expect(row.email).toBeNull();

    // Idempotent — re-run reports no further drift.
    const r2 = await runMigrate(driver, { schema: evolved });
    expect(r2.alteredColumns).toEqual([]);
    expect(r2.pending).toEqual([]);
    real.close();
  });

  test('NOT NULL column with a constant default is added safely', async () => {
    const { driver, real } = open();
    await runMigrate(driver, { schema: baseSchema() });
    real.exec(`INSERT INTO items (id, name) VALUES ('y', 'two')`);

    const evolved = {
      item: model('items', {
        id:         f.id(),
        name:       f.string(),
        created_at: f.dateTime().default('now'),
        tag:        f.string().default('untagged'),   // NOT NULL + literal default
      }),
    };

    const r = await runMigrate(driver, { schema: evolved });
    expect(r.alteredColumns).toContain('items.tag');
    expect(r.pending).toEqual([]);

    // Existing row gets the default backfill.
    const row = real.prepare(`SELECT id, tag FROM items WHERE id = ?`).get('y') as any;
    expect(row.tag).toBe('untagged');
    real.close();
  });

  test('NOT NULL column without a default is left pending, never applied', async () => {
    const { driver, real } = open();
    await runMigrate(driver, { schema: baseSchema() });
    real.exec(`INSERT INTO items (id, name) VALUES ('z', 'three')`);

    const evolved = {
      item: model('items', {
        id:         f.id(),
        name:       f.string(),
        created_at: f.dateTime().default('now'),
        count:      f.int(),                          // NOT NULL, no default → unsafe
      }),
    };

    const r = await runMigrate(driver, { schema: evolved });
    expect(r.alteredColumns).not.toContain('items.count');
    expect(r.pending.some((p) => p.kind === 'column' && p.detail.includes('count'))).toBe(true);
    // No partial state — column not present in the live table.
    const cols = real.prepare(`PRAGMA table_info(items)`).all() as any[];
    expect(cols.map((c) => c.name)).not.toContain('count');
    real.close();
  });

  test('extra columns in the DB show up under pending, never dropped', async () => {
    const { driver, real } = open();
    await runMigrate(driver, { schema: baseSchema() });
    // Simulate a column added outside forge — drift in the "DB has more than
    // schema" direction.
    real.exec(`ALTER TABLE items ADD COLUMN legacy_blob TEXT`);

    const r = await runMigrate(driver, { schema: baseSchema() });
    expect(r.alteredColumns).toEqual([]);
    expect(r.pending.some((p) => p.kind === 'column' && p.direction === 'extra' && p.detail.includes('legacy_blob'))).toBe(true);
    // Column still there — we don't drop.
    const cols = real.prepare(`PRAGMA table_info(items)`).all() as any[];
    expect(cols.map((c) => c.name)).toContain('legacy_blob');
    real.close();
  });

  test('alter: false reverts to the 2.5.0 strict create-only behaviour', async () => {
    const { driver, real } = open();
    await runMigrate(driver, { schema: baseSchema() });

    const evolved = {
      item: model('items', {
        id:         f.id(),
        name:       f.string(),
        created_at: f.dateTime().default('now'),
        email:      f.string().optional(),
      }),
    };

    const r = await runMigrate(driver, { schema: evolved, alter: false });
    // No ALTER pass — alteredColumns and pending stay empty.
    expect(r.alteredColumns).toEqual([]);
    expect(r.pending).toEqual([]);
    // Column not added.
    const cols = real.prepare(`PRAGMA table_info(items)`).all() as any[];
    expect(cols.map((c) => c.name)).not.toContain('email');
    real.close();
  });

  test('applyDrift can be called directly against a live driver', async () => {
    const { driver, real } = open();
    await runMigrate(driver, { schema: baseSchema() });

    const evolved = {
      item: model('items', {
        id:         f.id(),
        name:       f.string(),
        created_at: f.dateTime().default('now'),
        email:      f.string().optional(),
      }),
    };

    const r = await applyDrift(driver, { schema: evolved });
    expect(r.alteredColumns).toEqual(['items.email']);
    expect(r.pending).toEqual([]);
    expect(r.failures).toEqual([]);
    real.close();
  });
});
