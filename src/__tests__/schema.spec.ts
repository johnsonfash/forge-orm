import { schema } from '../schema';

describe('schema integrity (runtime)', () => {
  const allKeys = Object.keys(schema);

  test('sample schema has 10 models registered (8 tables + 1 view + 1 materialised view)', () => {
    expect(allKeys.length).toBe(10);
    expect(allKeys).toEqual(expect.arrayContaining([
      'user', 'profile', 'post', 'comment', 'tag', 'postTag', 'like', 'auditLog',
      'publishedPosts',  // Wave 4c — read-only view over Post
      'postStats',       // Wave 5d — materialised view (per-author rollups)
    ]));
  });

  test('every relation target is a valid schema key', () => {
    const dangling: string[] = [];
    for (const key of allKeys) {
      const rels = (schema as any)[key].relations();
      for (const [relName, rel] of Object.entries(rels) as [string, any][]) {
        if (!(rel.target in schema)) {
          dangling.push(`${key}.${relName} → '${rel.target}'`);
        }
      }
    }
    expect(dangling).toEqual([]);
  });

  test('every collection name is unique', () => {
    const collections = allKeys.map((k) => (schema as any)[k].collection);
    expect(new Set(collections).size).toBe(allKeys.length);
  });

  test('every owning relation\'s `on` field exists on the source model', () => {
    const issues: string[] = [];
    for (const key of allKeys) {
      const m = (schema as any)[key];
      const rels = m.relations();
      for (const [relName, rel] of Object.entries(rels) as [string, any][]) {
        if (rel.kind === 'one' && !rel.inverse) {
          if (!m.fields[rel.on]) {
            issues.push(`${key}.${relName}: 'on' field '${rel.on}' missing on ${key}`);
          }
        }
      }
    }
    expect(issues).toEqual([]);
  });

  test('every relation\'s `refs` resolves to a real field on the appropriate side', () => {
    const issues: string[] = [];
    for (const key of allKeys) {
      const m = (schema as any)[key];
      const rels = m.relations();
      for (const [relName, rel] of Object.entries(rels) as [string, any][]) {
        const target = (schema as any)[rel.target];
        // Inverse rel: refs is on parent (this model), on is on target.
        // Owning rel: on is on parent, refs is on target.
        const refsOn = rel.inverse ? m : target;
        const onOn = rel.inverse ? target : m;
        if (!refsOn.fields[rel.refs]) {
          issues.push(`${key}.${relName}: refs='${rel.refs}' missing on ${rel.inverse ? key : rel.target}`);
        }
        if (!onOn.fields[rel.on]) {
          issues.push(`${key}.${relName}: on='${rel.on}' missing on ${rel.inverse ? rel.target : key}`);
        }
      }
    }
    expect(issues).toEqual([]);
  });

  test('every table model has an `id` field of kind `id` (views may omit it)', () => {
    for (const key of allKeys) {
      // Wave 5d — view / materialised-view models (e.g. aggregate rollups) need
      // no synthetic id; skip them.
      if ((schema as any)[key].view) continue;
      const idField = (schema as any)[key].fields.id;
      expect(idField).toBeDefined();
      expect(idField.kind).toBe('id');
    }
  });
});
