import { f, model } from '../schema/core';
import type { ModelDef } from '../schema/types';
import { buildSchemaDDL as pgBuild } from '../adapters/postgres/ddl';
import { buildSchemaDDL as mysqlBuild } from '../adapters/mysql/ddl';
import { buildSchemaDDL as sqliteBuild } from '../adapters/sqlite/ddl';

// v1.4.0 — primary-key strategies. `f.id()` / `f.id({ type: 'uuid' })` /
// `f.id({ type: 'bigserial' })` each emit the right DDL per dialect. The
// Mongo bigserial throw lives in adapters/mongo/scripts/push.ts and is
// covered by a unit-level error check below.

const Order = (idField: ReturnType<typeof f.id> | ReturnType<typeof f.uuid>): ModelDef<any> =>
  model('orders', {
    id: idField as any,
    total: f.int(),
  }) as ModelDef<any>;

describe('f.id() — default (auto)', () => {
  const schema: any = { order: Order(f.id()) };

  it('PG emits TEXT', () => {
    const sql = pgBuild(schema).find((s) => s.kind === 'table' && s.name === 'orders')!.sql;
    expect(sql).toMatch(/"id" text NOT NULL/);
    expect(sql).toMatch(/PRIMARY KEY \("id"\)/);
  });

  it('MySQL emits VARCHAR(64)', () => {
    const sql = mysqlBuild(schema).find((s) => s.kind === 'table' && s.name === 'orders')!.sql;
    expect(sql).toMatch(/`id` VARCHAR\(64\) NOT NULL/);
  });

  it('SQLite emits TEXT + separate PRIMARY KEY clause', () => {
    const sql = sqliteBuild(schema).find((s) => s.kind === 'table' && s.name === 'orders')!.sql;
    expect(sql).toMatch(/"id" TEXT NOT NULL/);
    expect(sql).toMatch(/PRIMARY KEY \("id"\)/);
  });
});

describe("f.id({ type: 'uuid' }) — DB-side UUID default", () => {
  const schema: any = { order: Order(f.id({ type: 'uuid' })) };

  it('PG emits uuid (caller can layer gen_random_uuid via f.uuid for now)', () => {
    const sql = pgBuild(schema).find((s) => s.kind === 'table' && s.name === 'orders')!.sql;
    expect(sql).toMatch(/"id" uuid NOT NULL/);
  });

  it('MySQL emits CHAR(36)', () => {
    const sql = mysqlBuild(schema).find((s) => s.kind === 'table' && s.name === 'orders')!.sql;
    expect(sql).toMatch(/`id` CHAR\(36\) NOT NULL/);
  });

  it('SQLite emits TEXT (uuid type is portable-string on SQLite)', () => {
    const sql = sqliteBuild(schema).find((s) => s.kind === 'table' && s.name === 'orders')!.sql;
    expect(sql).toMatch(/"id" TEXT NOT NULL/);
  });
});

describe("f.id({ type: 'bigserial' }) — auto-incrementing integer PK", () => {
  const schema: any = { order: Order(f.id({ type: 'bigserial' }) as any) };

  it('PG emits BIGSERIAL with no separate NOT NULL / DEFAULT (BIGSERIAL implies both)', () => {
    const sql = pgBuild(schema).find((s) => s.kind === 'table' && s.name === 'orders')!.sql;
    expect(sql).toMatch(/"id" bigserial(,|\n)/);
    expect(sql).not.toMatch(/"id" bigserial.*NOT NULL/);
    expect(sql).not.toMatch(/"id" bigserial.*DEFAULT/);
    expect(sql).toMatch(/PRIMARY KEY \("id"\)/);
  });

  it('MySQL emits BIGINT NOT NULL AUTO_INCREMENT, no DEFAULT', () => {
    const sql = mysqlBuild(schema).find((s) => s.kind === 'table' && s.name === 'orders')!.sql;
    expect(sql).toMatch(/`id` BIGINT NOT NULL AUTO_INCREMENT/);
    expect(sql).not.toMatch(/`id`.*DEFAULT/);
  });

  it('SQLite emits INTEGER PRIMARY KEY AUTOINCREMENT inline + suppresses the table-level PK clause', () => {
    const sql = sqliteBuild(schema).find((s) => s.kind === 'table' && s.name === 'orders')!.sql;
    expect(sql).toMatch(/"id" INTEGER PRIMARY KEY AUTOINCREMENT/);
    // The standalone `PRIMARY KEY ("id")` row would conflict with the
    // inline declaration — it must NOT appear.
    expect(sql).not.toMatch(/^\s*PRIMARY KEY \("id"\)/m);
  });

  it('drops the autoId app-side default — DB assigns the value', () => {
    const field = (f.id({ type: 'bigserial' }) as any).def;
    expect(field.idType).toBe('bigserial');
    expect(field.default).toBeUndefined();
  });

  it('preserves the autoId app-side default on auto/uuid (back-compat)', () => {
    expect((f.id() as any).def.default).toEqual({ kind: 'autoId' });
    expect((f.id({ type: 'auto' }) as any).def.default).toEqual({ kind: 'autoId' });
    expect((f.id({ type: 'uuid' }) as any).def.default).toEqual({ kind: 'autoId' });
  });
});

describe('TypeScript narrowing — Field<T> for the id', () => {
  // Compile-time only — the assertions run as no-ops, but the file fails to
  // compile if the generics ever drift back to string for bigserial.
  it('bigserial yields a number-typed Field', () => {
    const idField = f.id({ type: 'bigserial' });
    const fakeRow: { id: typeof idField._t } = { id: 1 };
    expect(typeof fakeRow.id).toBe('number');
  });
  it('uuid + auto + default yield a string-typed Field', () => {
    const a = f.id();
    const b = f.id({ type: 'auto' });
    const c = f.id({ type: 'uuid' });
    const rowA: { id: typeof a._t } = { id: 'abc' };
    const rowB: { id: typeof b._t } = { id: 'abc' };
    const rowC: { id: typeof c._t } = { id: 'abc' };
    expect(typeof rowA.id).toBe('string');
    expect(typeof rowB.id).toBe('string');
    expect(typeof rowC.id).toBe('string');
  });
});
