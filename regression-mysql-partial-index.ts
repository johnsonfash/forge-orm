/* eslint-disable no-console */
//
// Regression: MySQL partial-unique workaround via a CASE-expression
// functional index. forge rewrites
//     { keys: { sku: 1 }, unique: true, where: 'deleted_at IS NULL' }
// into
//     CREATE UNIQUE INDEX … ON … ((CASE WHEN (deleted_at IS NULL) THEN `sku` ELSE NULL END))
// so the partial-unique semantics still hold on MySQL (NULLs aren't
// duplicate-checked in MySQL unique indexes).

import * as dotenv from 'dotenv';
dotenv.config();

import { f, model, createDb } from './src';
import { mysql2Driver } from './src/adapters/mysql/driver';
import mysql from 'mysql2/promise';

const STAMP = `${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
const DB = `forge_mysql_partial_${STAMP}`;
const HOST = process.env.SMOKE_MYSQL_HOST ?? '127.0.0.1';
const PORT = Number(process.env.SMOKE_MYSQL_PORT ?? 3306);
const USER = process.env.SMOKE_MYSQL_USER ?? 'root';
const PASS = process.env.SMOKE_MYSQL_PASSWORD ?? '';

let pass = 0, fail = 0;
const ok = (label: string, cond: boolean, detail?: any) => {
  if (cond) { console.log('  ✓', label); pass++; }
  else { console.log('  ✗', label, detail ?? ''); fail++; }
};

async function main() {
  const admin = await mysql.createConnection({ host: HOST, port: PORT, user: USER, password: PASS });
  await admin.query(`CREATE DATABASE \`${DB}\``);
  await admin.end();

  const pool = mysql.createPool({ host: HOST, port: PORT, user: USER, password: PASS, database: DB });
  try {
    const Item = model('items', {
      id: f.id(),
      sku: f.string(),
      deletedAt: f.dateTime().optional(),
    }, {
      indexes: [
        // Unique partial — should rewrite to a functional CASE index.
        { keys: { sku: 1 }, unique: true, where: '`deletedAt` IS NULL', name: 'idx_items_sku_live' },
      ],
    });

    const db = await createDb({ schema: { item: Item } as any, driver: mysql2Driver(pool) });
    const { buildSchemaDDL } = await import('./src/adapters/mysql/ddl');
    const ddl = buildSchemaDDL({ item: Item } as any);
    for (const s of ddl) await pool.query(s.sql);

    // Verify the index was created as a CASE-expression functional index.
    const [rows] = await pool.query(
      `SELECT INDEX_NAME, EXPRESSION FROM information_schema.STATISTICS
        WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND INDEX_NAME = ?`,
      [DB, 'items', 'idx_items_sku_live'],
    ) as any;
    ok('idx_items_sku_live exists', Array.isArray(rows) && rows.length > 0, rows);
    const expr = rows[0]?.EXPRESSION ?? '';
    ok('idx_items_sku_live is a functional CASE index', /CASE WHEN/i.test(String(expr)), expr);

    // Live constraint check — two live rows with the same sku must collide.
    await (db as any).item.create({ data: { sku: 'SKU-1' } });
    let rejected = false;
    try {
      await (db as any).item.create({ data: { sku: 'SKU-1' } });
    } catch (err: any) {
      rejected = /Duplicate entry|duplicate key/i.test(err?.message ?? '');
    }
    ok('partial unique rejects duplicate live SKU', rejected);

    // Soft-deleted rows can coexist with new live rows of the same SKU.
    await (db as any).item.update({ where: { id: (await (db as any).item.findFirst({ where: { sku: 'SKU-1' } })).id }, data: { deletedAt: new Date() } });
    let allowed = false;
    try {
      await (db as any).item.create({ data: { sku: 'SKU-1' } });
      allowed = true;
    } catch { /* */ }
    ok('partial unique allows re-insert after soft-delete', allowed);

  } finally {
    await pool.end();
    const admin2 = await mysql.createConnection({ host: HOST, port: PORT, user: USER, password: PASS });
    try { await admin2.query(`DROP DATABASE \`${DB}\``); } catch { /* */ }
    await admin2.end();
  }

  console.log(`\n[mysql-partial] ${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main().catch((err) => { console.error(err); process.exit(1); });
