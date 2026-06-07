import { f, model } from '../schema/core';
import { diffIntrospection, expectedFromSchema, parseIgnoreList } from '../scripts/diff-core';
import type { DbIntrospection } from '../adapters/types';

// Tiny ad-hoc schema — diffIntrospection takes the schema as a param so
// the suite is self-contained.

const Widget = model('widgets', {
  id: f.id(),
  name: f.string().unique(),
  price: f.decimal({ precision: 10, scale: 2 }),
});
const miniSchema = { widget: Widget } as any;

function pgActual(overrides: Partial<DbIntrospection['tables'][0]> = {}): DbIntrospection {
  return {
    kind: 'postgres',
    tables: [{
      name: 'widgets',
      columns: [
        { name: 'id', type: 'text', nullable: false },
        { name: 'name', type: 'text', nullable: false },
        { name: 'price', type: 'numeric(10,2)', nullable: false },
      ],
      indexes: [
        { name: 'widgets_pkey', columns: ['id'], unique: true },
        { name: 'forge_widgets_uq_name', columns: ['name'], unique: true },
      ],
      foreignKeys: [],
      ...overrides,
    }],
    views: [],
  };
}

describe('Wave 5b — drift comparator', () => {
  test('expectedFromSchema derives table, pk + unique index sigs', () => {
    const exp = expectedFromSchema(miniSchema);
    const t = exp.tables.get('widgets')!;
    expect([...t.columns.keys()].sort()).toEqual(['id', 'name', 'price']);
    expect(t.indexSigs.has('u:id')).toBe(true);
    expect(t.indexSigs.has('u:name')).toBe(true);
  });

  test('matching DB → in sync', () => {
    const r = diffIntrospection(miniSchema, pgActual());
    expect(r.inSync).toBe(true);
    expect(r.items).toEqual([]);
  });

  test('missing column is reported', () => {
    const r = diffIntrospection(miniSchema, pgActual({
      columns: [
        { name: 'id', type: 'text', nullable: false },
        { name: 'name', type: 'text', nullable: false },
      ],
    }));
    expect(r.inSync).toBe(false);
    expect(r.items).toContainEqual(expect.objectContaining({ kind: 'column', direction: 'missing', table: 'widgets' }));
  });

  test('extra table is reported', () => {
    const act = pgActual();
    act.tables.push({ name: 'leftover', columns: [{ name: 'id', type: 'text', nullable: false }], indexes: [], foreignKeys: [] });
    const r = diffIntrospection(miniSchema, act);
    expect(r.items).toContainEqual(expect.objectContaining({ kind: 'table', direction: 'extra', table: 'leftover' }));
  });

  test('column type mismatch is reported (decimal vs text)', () => {
    const r = diffIntrospection(miniSchema, pgActual({
      columns: [
        { name: 'id', type: 'text', nullable: false },
        { name: 'name', type: 'text', nullable: false },
        { name: 'price', type: 'text', nullable: false },
      ],
    }));
    expect(r.items).toContainEqual(expect.objectContaining({ kind: 'columnType', table: 'widgets' }));
  });

  test('_forge_migrations + FTS shadow tables are ignored as extras', () => {
    const act = pgActual();
    act.tables.push({ name: '_forge_migrations', columns: [], indexes: [], foreignKeys: [] });
    act.tables.push({ name: 'widgets_fts', columns: [], indexes: [], foreignKeys: [] });
    const r = diffIntrospection(miniSchema, act);
    expect(r.inSync).toBe(true);
  });

  // ── user-supplied ignore patterns (v1.3.1) ─────────────────────────

  test('parseIgnoreList parses strings, regex, and trims whitespace', () => {
    expect(parseIgnoreList('logs, /^_atlas_/i , events')).toEqual([
      'logs',
      /^_atlas_/i,
      'events',
    ]);
    expect(parseIgnoreList('')).toEqual([]);
    expect(parseIgnoreList(undefined)).toEqual([]);
  });

  test('parseIgnoreList tolerates a malformed regex by falling back to literal', () => {
    const parsed = parseIgnoreList('/[unclosed/');
    // It's a literal string — exact-match by design — not a thrown error.
    expect(parsed).toEqual(['/[unclosed/']);
  });

  test('exact-string ignore pattern drops a table from the report', () => {
    const act = pgActual();
    act.tables.push({ name: 'sessions', columns: [], indexes: [], foreignKeys: [] });
    act.tables.push({ name: 'logs', columns: [], indexes: [], foreignKeys: [] });
    const r = diffIntrospection(miniSchema, act, ['logs']);
    expect(r.items).toContainEqual(expect.objectContaining({ table: 'sessions', direction: 'extra' }));
    expect(r.items).not.toContainEqual(expect.objectContaining({ table: 'logs' }));
    expect(r.ignored).toEqual(['logs']);
  });

  test('regex ignore pattern matches every collection in a family', () => {
    const act = pgActual();
    act.tables.push({ name: '_atlas_metadata', columns: [], indexes: [], foreignKeys: [] });
    act.tables.push({ name: '_atlas_tokens', columns: [], indexes: [], foreignKeys: [] });
    act.tables.push({ name: 'events', columns: [], indexes: [], foreignKeys: [] });
    const r = diffIntrospection(miniSchema, act, [/^_atlas_/i]);
    expect(r.items).toContainEqual(expect.objectContaining({ table: 'events', direction: 'extra' }));
    expect(r.ignored?.sort()).toEqual(['_atlas_metadata', '_atlas_tokens']);
  });

  test('ignored tables that are otherwise the only drift land the report inSync', () => {
    const act = pgActual();
    act.tables.push({ name: 'noise', columns: [], indexes: [], foreignKeys: [] });
    const r = diffIntrospection(miniSchema, act, ['noise']);
    expect(r.inSync).toBe(true);
    expect(r.ignored).toEqual(['noise']);
  });

  test('an empty ignore list is identical to omitting the parameter', () => {
    const act = pgActual();
    act.tables.push({ name: 'leftover', columns: [], indexes: [], foreignKeys: [] });
    const baseline = diffIntrospection(miniSchema, act);
    const withEmpty = diffIntrospection(miniSchema, act, []);
    expect(withEmpty.items).toEqual(baseline.items);
    expect(withEmpty.ignored).toBeUndefined();
  });
});
