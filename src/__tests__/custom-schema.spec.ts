import { f, model, rel } from '../schema/core';
import { buildSchemaDDL } from '../adapters/postgres/ddl';
import { setActiveSchema, getActiveSchema } from '../schema/active';
import { schema, sampleSchema } from '../schema';

// Proves forge is decoupled from its bundled sample schema: a totally different
// consumer schema (e-commerce) drives DDL + the active-schema proxy, with no
// trace of the sample blog models.

const Shop = model('shops', {
  id: f.id(),
  name: f.string().unique(),
  created_at: f.dateTime().default('now'),
}).relate(() => ({ products: rel.many('product', { on: 'shop_id', refs: 'id' }) }));

const Product = model('products', {
  id: f.id(),
  shop_id: f.objectId(),
  title: f.string(),
  price: f.decimal({ precision: 10, scale: 2 }),
  in_stock: f.bool().default(true),
}).relate(() => ({ shop: rel.one('shop', { on: 'shop_id', refs: 'id', onDelete: 'Cascade' }) }));

const mySchema = { shop: Shop, product: Product } as const;

describe('schema decoupling — a custom (non-sample) schema', () => {
  test('buildSchemaDDL emits the CUSTOM tables + FK, and none of the sample tables', () => {
    const ddl = buildSchemaDDL(mySchema as any);
    const tables = ddl.filter((s) => s.kind === 'table').map((s) => s.name);
    expect(tables).toEqual(expect.arrayContaining(['shops', 'products']));
    // The bundled sample (users/posts/…) must not leak in.
    expect(tables).not.toContain('users');
    expect(tables).not.toContain('posts');
    // The custom FK (products.shop_id → shops.id) is emitted.
    const fk = ddl.find((s) => s.kind === 'foreignKey' && s.table === 'products');
    expect(fk?.sql).toContain('REFERENCES "shops"');
    // The custom decimal column maps correctly.
    const productsTable = ddl.find((s) => s.kind === 'table' && s.name === 'products')!;
    expect(productsTable.sql).toContain('"price" numeric(10,2)');
  });

  test('the active-schema registry swaps what the `schema` proxy reflects', () => {
    expect(Object.keys(schema).sort()).toEqual(Object.keys(sampleSchema).sort()); // default = sample
    try {
      setActiveSchema(mySchema as any);
      expect(Object.keys(schema).sort()).toEqual(['product', 'shop']);
      expect((schema as any).product).toBe(Product);
      expect((schema as any).users).toBeUndefined();
      expect(getActiveSchema()).toBe(mySchema);
    } finally {
      setActiveSchema(sampleSchema as any); // restore so sibling tests are unaffected
    }
  });
});
