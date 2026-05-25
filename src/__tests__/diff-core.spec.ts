import { f, model } from '../schema/core';
import { diffIntrospection, expectedFromSchema } from '../scripts/diff-core';
import type { DbIntrospection } from '../adapters/types';

// Wave 5b — drift comparator. Uses a tiny ad-hoc schema (diffIntrospection
// accepts the schema as a parameter) so the assertions are self-contained.

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
});
