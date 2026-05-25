import { f, model } from '../schema/core';
import { buildSchemaDDL as buildPg } from '../adapters/postgres/ddl';
import { buildSchemaDDL as buildMysql } from '../adapters/mysql/ddl';
import { buildSchemaDDL as buildSqlite } from '../adapters/sqlite/ddl';

// Wave 5e — native types (decimal / uuid / bigint) + dbgenerated columns must
// emit dialect-correct DDL. This pins the column-type mapping so a regression
// in any dialect's columnType()/renderColumn() is caught without a live DB.

const Money = model('money', {
  id: f.id(),
  amount: f.decimal({ precision: 12, scale: 2 }),
  ref: f.uuid({ default: 'gen_random_uuid' }),
  big: f.bigint(),
  // generated column referencing another column
  doubled: f.decimal({ precision: 14, scale: 2 }).dbgenerated('amount * 2'),
});
const sample = { money: Money } as any;

function createTableSql(stmts: { kind: string; name: string; sql: string }[]): string {
  return stmts.find((s) => s.kind === 'table' && s.name === 'money')!.sql;
}

describe('Wave 5e — native-type DDL', () => {
  test('Postgres: numeric(p,s), uuid + gen_random_uuid(), bigint, GENERATED STORED', () => {
    const sql = createTableSql(buildPg(sample));
    expect(sql).toContain('"amount" numeric(12,2)');
    expect(sql).toContain('"ref" uuid');
    expect(sql).toContain('DEFAULT gen_random_uuid()');
    expect(sql).toContain('"big" bigint');
    expect(sql).toContain('"doubled" numeric(14,2) GENERATED ALWAYS AS (amount * 2) STORED');
  });

  test('MySQL: DECIMAL(p,s), CHAR(36) + UUID() default, BIGINT, GENERATED STORED', () => {
    const sql = createTableSql(buildMysql(sample));
    expect(sql).toContain('`amount` DECIMAL(12,2)');
    expect(sql).toContain('`ref` CHAR(36)');
    expect(sql).toContain('DEFAULT (UUID())');
    expect(sql).toContain('`big` BIGINT');
    expect(sql).toContain('`doubled` DECIMAL(14,2) GENERATED ALWAYS AS (amount * 2) STORED');
  });

  test('SQLite: NUMERIC, TEXT (uuid), INTEGER (bigint), GENERATED STORED', () => {
    const sql = createTableSql(buildSqlite(sample));
    expect(sql).toContain('"amount" NUMERIC');
    expect(sql).toContain('"ref" TEXT');
    expect(sql).toContain('"big" INTEGER');
    expect(sql).toContain('"doubled" NUMERIC GENERATED ALWAYS AS (amount * 2) STORED');
  });
});
