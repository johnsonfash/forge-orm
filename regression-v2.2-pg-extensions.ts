/* eslint-disable no-console */
//
// 2.2.0 — live regression for the new Postgres IndexDef extensions.
// Pushes a fresh schema with:
//   - a partial unique index (WHERE)
//   - a GIN index on a jsonb column
//   - an INCLUDE covering index
//   - an expression index
// And queries pg_indexes to verify each one landed with the expected shape.

import * as dotenv from 'dotenv';
dotenv.config();

import postgres from 'postgres';
import { f, model } from './src/schema/core';
import type { ModelDef } from './src/schema/types';
import { buildSchemaDDL } from './src/adapters/postgres/ddl';

const STAMP = `${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
const DB = `forge_v22_pg_${STAMP}`;
const PG_HOST = process.env.SMOKE_PG_HOST ?? '127.0.0.1';
const PG_PORT = Number(process.env.SMOKE_PG_PORT ?? 5432);
const PG_USER = process.env.SMOKE_PG_USER ?? 'postgres';
const PG_PASS = process.env.SMOKE_PG_PASSWORD ?? 'postgres';

let pass = 0;
let fail = 0;
function check(label: string, cond: any, detail?: any) {
  if (cond) { console.log(`  ✓ ${label}`); pass++; }
  else { console.log(`  ✗ ${label}`, detail ?? ''); fail++; }
}

async function main() {
  // bootstrap a fresh DB
  const admin = postgres({ host: PG_HOST, port: PG_PORT, user: PG_USER, password: PG_PASS, database: 'postgres' });
  await admin`CREATE DATABASE ${admin(DB)}`;
  await admin.end();

  const sql = postgres({ host: PG_HOST, port: PG_PORT, user: PG_USER, password: PG_PASS, database: DB });

  try {
    const Items: ModelDef<any> = model('items', {
      id: f.id(),
      sku: f.string(),
      tags: f.json(),
      status: f.string(),
      price: f.float(),
      deleted_at: f.dateTime().optional(),
      email: f.string(),
    }, {
      indexes: [
        // 1. Partial unique — only over rows that haven't been soft-deleted
        { keys: { sku: 1 }, unique: true, where: 'deleted_at IS NULL', name: 'idx_items_sku_live' },
        // 2. GIN over jsonb tags for @> containment
        { keys: { tags: 1 }, method: 'gin', name: 'idx_items_tags_gin' },
        // 3. INCLUDE covering — index-only scans for (status) → (price)
        { keys: { status: 1 }, include: ['price'], name: 'idx_items_status_covering' },
        // 4. Expression index — case-insensitive email lookup
        { keys: {}, expression: 'lower(email)', name: 'idx_items_email_lower' },
      ],
    }) as unknown as ModelDef<any>;

    const ddl = buildSchemaDDL({ items: Items });
    for (const s of ddl) {
      await sql.unsafe(s.sql);
    }

    // --- Verify each index landed ---
    type Row = { indexname: string; indexdef: string };
    const rows = await sql<Row[]>`
      SELECT indexname, indexdef
        FROM pg_indexes
       WHERE schemaname = 'public'
         AND tablename = 'items'
    `;
    const byName = new Map(rows.map((r) => [r.indexname, r.indexdef]));

    const skuDef = byName.get('idx_items_sku_live') ?? '';
    check(
      'partial WHERE on idx_items_sku_live',
      /UNIQUE\s+INDEX/i.test(skuDef) && /WHERE \(?deleted_at IS NULL\)?/i.test(skuDef),
      skuDef,
    );

    const tagsDef = byName.get('idx_items_tags_gin') ?? '';
    check(
      'method=gin emits USING gin on idx_items_tags_gin',
      /USING gin/i.test(tagsDef),
      tagsDef,
    );

    const statusDef = byName.get('idx_items_status_covering') ?? '';
    check(
      'INCLUDE on idx_items_status_covering',
      /INCLUDE \(\s*"?price"?\s*\)/i.test(statusDef),
      statusDef,
    );

    const emailDef = byName.get('idx_items_email_lower') ?? '';
    check(
      'expression index uses lower(email)',
      /lower\(email\)/i.test(emailDef) && !/"sku"|"status"/i.test(emailDef),
      emailDef,
    );

    // --- Functional verification of the partial unique index ---
    await sql`INSERT INTO items (id, sku, tags, status, price, deleted_at, email) VALUES
      ('a', 'SKU-1', '[]'::jsonb, 'live', 100, NULL, 'A@example.com'),
      ('b', 'SKU-1', '[]'::jsonb, 'live', 100, now(), 'b@example.com')`;
    let rejected = false;
    try {
      await sql`INSERT INTO items (id, sku, tags, status, price, deleted_at, email) VALUES
        ('c', 'SKU-1', '[]'::jsonb, 'live', 100, NULL, 'c@example.com')`;
    } catch (err: any) {
      rejected = /unique|duplicate key/i.test(err?.message ?? '');
    }
    check('partial unique rejects new live row with duplicate SKU', rejected);

  } finally {
    await sql.end();
    const admin2 = postgres({ host: PG_HOST, port: PG_PORT, user: PG_USER, password: PG_PASS, database: 'postgres' });
    try { await admin2`DROP DATABASE ${admin2(DB)}`; } catch { /* */ }
    await admin2.end();
  }

  console.log(`\n[v2.2-pg-ext] ${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main().catch((err) => { console.error('regression failed', err); process.exit(1); });
