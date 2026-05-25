/* eslint-disable no-console */
//
// Drop-in library demo — forge with a COMPLETELY DIFFERENT schema from the
// bundled blog sample. Proves the decoupling end to end: you bring your own
// `model(...)` map, pass it to `createDb({ schema })`, and everything (DDL,
// queries, relations, typing) is driven by YOUR models.
//
// Run: npm run forge:example:custom   (uses an in-memory SQLite db)

import * as dotenv from 'dotenv';
dotenv.config();

import { createDb, f, model, rel } from '../src';
import { buildSchemaDDL } from '../src/adapters/sqlite/ddl';
import { applyMigration } from '../src/adapters/sqlite/migrate';

// ─── Your domain — an e-commerce schema (nothing to do with the sample) ─────
const Shop = model('shops', {
  id: f.id(),
  name: f.string().unique(),
  created_at: f.dateTime().default('now'),
}).relate(() => ({
  products: rel.many('product', { on: 'shop_id', refs: 'id' }),
}));

const Product = model('products', {
  id: f.id(),
  shop_id: f.objectId(),
  title: f.string(),
  price: f.decimal({ precision: 10, scale: 2 }),   // exact money → JS string
  in_stock: f.bool().default(true),
  created_at: f.dateTime().default('now'),
}).relate(() => ({
  shop: rel.one('shop', { on: 'shop_id', refs: 'id', onDelete: 'Cascade' }),
}));

const mySchema = { shop: Shop, product: Product } as const;

(async () => {
  // 1. createDb with YOUR schema — db.shop / db.product are typed from it.
  const db = await createDb({ url: 'sqlite::memory:', schema: mySchema });

  // 2. Create the tables for the custom schema (in real apps: `forge:push`).
  await applyMigration((db.adapter as any).db, buildSchemaDDL(mySchema as any));

  // 3. Use it — full Prisma-shape API over your own models.
  await db.shop.create({ data: { id: 'acme', name: 'Acme Co' } });
  await db.product.create({ data: { id: 'w1', shop_id: 'acme', title: 'Widget', price: '9.99' } });
  await db.product.create({ data: { id: 'w2', shop_id: 'acme', title: 'Gadget', price: '19.95', in_stock: false } });

  // 4. Relations resolve against the custom schema.
  const shop = await db.shop.findFirst({ where: { id: 'acme' }, include: { products: true } });
  console.log(`shop "${shop?.name}" has ${(shop as any)?.products?.length} products`);

  // 5. Filtered read + the exact-decimal round-trip.
  const inStock = await db.product.findMany({ where: { in_stock: true }, orderBy: { title: 'asc' } });
  console.log('in-stock products:', inStock.map((p: any) => `${p.title} @ ${p.price}`).join(', '));

  // 6. Cascade: deleting the shop removes its products (FK ON DELETE CASCADE).
  await db.shop.delete({ where: { id: 'acme' } });
  const left = await db.product.count();
  console.log('products after shop delete (cascade):', left);

  await db.$disconnect();
  console.log(left === 0
    ? '\n✓ custom (non-sample) schema works end-to-end — forge is a true drop-in library'
    : '\n✗ unexpected: cascade did not clear products');
  process.exit(left === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
