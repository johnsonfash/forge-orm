// MSSQL adapter unit tests — verifies the T-SQL rewriting layer over PG's
// compile-from-ir produces statements SQL Server will accept.

import { f, model } from '../schema/core';
import type { ModelDef } from '../schema/types';
import { buildSchemaDDL } from '../adapters/mssql/ddl';
import { buildMssqlCompileApi } from '../adapters/mssql/compile';
import { MssqlDialect } from '../adapters/mssql/dialect';

describe('MSSQL dialect', () => {
  it('quoteIdent uses bracket notation', () => {
    expect(MssqlDialect.quoteIdent('users')).toBe('[users]');
    expect(() => MssqlDialect.quoteIdent('bad]name')).toThrow();
  });

  it('placeholder produces @p1, @p2, …', () => {
    const params: unknown[] = [];
    expect(MssqlDialect.placeholder(params, 'a')).toBe('@p1');
    expect(MssqlDialect.placeholder(params, 'b')).toBe('@p2');
    expect(params).toEqual(['a', 'b']);
  });

  it('columnType maps schema kinds to T-SQL types', () => {
    expect(MssqlDialect.columnType({ kind: 'string', optional: false, unique: false, updatedAt: false } as any)).toBe('NVARCHAR(255)');
    expect(MssqlDialect.columnType({ kind: 'bool', optional: false, unique: false, updatedAt: false } as any)).toBe('BIT');
    expect(MssqlDialect.columnType({ kind: 'dateTime', optional: false, unique: false, updatedAt: false } as any)).toBe('DATETIMEOFFSET');
    expect(MssqlDialect.columnType({ kind: 'json', optional: false, unique: false, updatedAt: false } as any)).toBe('NVARCHAR(MAX)');
    // Native arrays don't exist in T-SQL.
    expect(MssqlDialect.columnType({ kind: 'stringArray', optional: false, unique: false, updatedAt: false } as any)).toBe('NVARCHAR(MAX)');
  });

  it('orderClause emits the CASE-WHEN workaround for NULLS FIRST/LAST', () => {
    const c = '[col]';
    expect(MssqlDialect.orderClause(c, 'asc')).toBe('[col] ASC');
    expect(MssqlDialect.orderClause(c, 'asc', 'first')).toContain('CASE WHEN [col] IS NULL THEN 0');
    expect(MssqlDialect.orderClause(c, 'desc', 'last')).toContain('CASE WHEN [col] IS NULL THEN 1');
  });

  it('searchClause falls back to LIKE %…%', () => {
    const sql = MssqlDialect.searchClause('[body]', '@p1', { rawColumn: 'body', baseTable: 'docs', quoteIdent: (s) => `[${s}]` });
    expect(sql).toBe(`[body] LIKE '%' + @p1 + '%'`);
  });
});

describe('MSSQL DDL', () => {
  it('wraps CREATE TABLE in IF NOT EXISTS (sys.tables …) BEGIN … END', () => {
    const M = model('users', {
      id: f.id(),
      email: f.string().unique(),
      active: f.bool().default(true),
    }) as unknown as ModelDef<any>;
    const ddl = buildSchemaDDL({ user: M });
    const tbl = ddl.find((s) => s.kind === 'table' && s.name === 'users')!;
    expect(tbl).toBeDefined();
    expect(tbl.sql).toMatch(/IF NOT EXISTS \(SELECT 1 FROM sys\.tables WHERE name = 'users'\) BEGIN/);
    expect(tbl.sql).toContain('CREATE TABLE [users]');
    expect(tbl.sql).toContain('END');
    // bool → BIT.
    expect(tbl.sql).toMatch(/\[active\] BIT/);
  });

  it('wraps CREATE INDEX in IF NOT EXISTS (sys.indexes …) BEGIN … END', () => {
    const M = model('orders', {
      id: f.id(),
      customer_id: f.objectId(),
      status: f.string(),
    }, {
      indexes: [{ keys: { customer_id: 1, status: 1 }, name: 'idx_orders_cust_status' }],
    }) as unknown as ModelDef<any>;
    const ddl = buildSchemaDDL({ order: M });
    const idx = ddl.find((s) => s.name === 'idx_orders_cust_status')!;
    expect(idx.sql).toMatch(/IF NOT EXISTS \(SELECT 1 FROM sys\.indexes WHERE name = 'idx_orders_cust_status'/);
    expect(idx.sql).toContain('CREATE INDEX [idx_orders_cust_status]');
  });
});

describe('MSSQL compile API', () => {
  it('returns SQLArtifact with dialect=mssql and bracket identifiers', () => {
    const M = model('users', { id: f.id(), email: f.string() }) as unknown as ModelDef<any>;
    const api = buildMssqlCompileApi(M);
    const art = api.findMany({});
    expect(art.kind).toBe('sql');
    expect(art.dialect).toBe('mssql');
    expect(art.sql).toMatch(/\[users\]/);
    // No double-quoted identifiers should survive.
    expect(art.sql).not.toMatch(/"[^"]+"\s/);
  });

  it('rewrites LIMIT/OFFSET to OFFSET … ROWS FETCH NEXT … ROWS ONLY', () => {
    const M = model('users', { id: f.id(), email: f.string() }) as unknown as ModelDef<any>;
    const art = buildMssqlCompileApi(M).findMany({ take: 10, skip: 20, orderBy: { id: 'asc' } });
    expect(art.sql).toMatch(/OFFSET 20 ROWS FETCH NEXT 10 ROWS ONLY/);
    expect(art.sql).not.toMatch(/\bLIMIT\b/);
  });

  it('uses @-prefixed placeholders', () => {
    const M = model('users', { id: f.id(), email: f.string() }) as unknown as ModelDef<any>;
    const art = buildMssqlCompileApi(M).findMany({ where: { email: 'a@b.co' } });
    expect(art.sql).toMatch(/@p1/);
    expect(art.params).toEqual(['a@b.co']);
  });

  it('rewrites RETURNING * → OUTPUT INSERTED.* on INSERT', () => {
    const M = model('users', { id: f.id(), email: f.string() }) as unknown as ModelDef<any>;
    const art = buildMssqlCompileApi(M).create({ data: { id: 'a', email: 'x@y.z' } });
    expect(art.sql).toMatch(/OUTPUT INSERTED\.\*/);
    expect(art.sql).not.toMatch(/RETURNING/);
  });

  it('rewrites RETURNING * → OUTPUT INSERTED.* on UPDATE', () => {
    const M = model('users', { id: f.id(), email: f.string() }) as unknown as ModelDef<any>;
    const art = buildMssqlCompileApi(M).update({ where: { id: 'a' }, data: { email: 'new@x' } });
    expect(art.sql).toMatch(/OUTPUT INSERTED\.\*/);
    // The PG ctid pattern is replaced with `[id] IN (SELECT TOP 1 …)`.
    expect(art.sql).toMatch(/\[id\] IN \(SELECT TOP 1 \[id\]/);
    expect(art.sql).not.toMatch(/ctid/);
  });

  it('rewrites RETURNING * → OUTPUT DELETED.* on DELETE', () => {
    const M = model('users', { id: f.id(), email: f.string() }) as unknown as ModelDef<any>;
    const art = buildMssqlCompileApi(M).delete({ where: { id: 'a' } });
    expect(art.sql).toMatch(/OUTPUT DELETED\.\*/);
    expect(art.sql).not.toMatch(/ctid/);
  });

  it('upsert throws a clear NotImplemented error pointing at v2.4', () => {
    const M = model('users', { id: f.id(), email: f.string().unique() }) as unknown as ModelDef<any>;
    expect(() =>
      buildMssqlCompileApi(M).upsert({ where: { email: 'a@b' }, create: { id: '1', email: 'a@b' }, update: { email: 'a@b' } }),
    ).toThrow(/upsert .* not implemented/i);
  });

  it('softDelete sets semanticOp + dialect', () => {
    const M = model('docs', {
      id: f.id(),
      deletedAt: f.dateTime().optional().softDeleteAt(),
    }) as unknown as ModelDef<any>;
    const art = buildMssqlCompileApi(M).softDelete({ where: { id: 'x' } });
    expect(art.dialect).toBe('mssql');
    expect(art.semanticOp).toBe('softDelete');
    expect(art.sql).toMatch(/UPDATE/);
  });
});
