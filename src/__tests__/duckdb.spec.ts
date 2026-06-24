// DuckDB adapter — DDL emission + compile API smoke tests. Live CRUD lives
// in regression-duckdb.ts (needs @duckdb/node-api at runtime).

import { f, model } from '../schema/core';
import type { ModelDef } from '../schema/types';
import { buildSchemaDDL } from '../adapters/duckdb/ddl';
import { buildDuckdbCompileApi } from '../adapters/duckdb/compile';
import { DuckdbDialect } from '../adapters/duckdb/dialect';

describe('DuckDB DDL', () => {
  it('emits CREATE TABLE with DuckDB type names', () => {
    const M = model('users', {
      id: f.id(),
      email: f.string().unique(),
      name: f.string(),
      meta: f.json().optional(),
    }) as unknown as ModelDef<any>;
    const ddl = buildSchemaDDL({ user: M });
    const tableStmt = ddl.find((s) => s.kind === 'table' && s.name === 'users')!;
    expect(tableStmt).toBeDefined();
    // DuckDB native types: VARCHAR (not text), JSON (not jsonb).
    expect(tableStmt.sql).toMatch(/"email" VARCHAR/);
    expect(tableStmt.sql).toMatch(/"meta" JSON/);
    // Identifier quoting is the same as Postgres.
    expect(tableStmt.sql).toMatch(/CREATE TABLE IF NOT EXISTS "users"/);
  });

  it('strips WHERE + INCLUDE on DuckDB (it doesn\'t support partial / covering indexes yet)', () => {
    // Silence the warn that buildSchemaDDL emits in this case.
    const spy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const M = model('items', {
      id: f.id(),
      sku: f.string(),
      status: f.string(),
      deletedAt: f.dateTime().optional(),
    }, {
      indexes: [
        { keys: { sku: 1 }, unique: true, where: '"deletedAt" IS NULL', name: 'idx_items_sku_live' },
        { keys: { status: 1 }, include: ['sku'], name: 'idx_items_status_covering' },
      ],
    }) as unknown as ModelDef<any>;
    const ddl = buildSchemaDDL({ item: M });
    const partial = ddl.find((s) => s.name === 'idx_items_sku_live')!;
    const covering = ddl.find((s) => s.name === 'idx_items_status_covering')!;
    expect(partial.sql).not.toMatch(/WHERE/);
    expect(covering.sql).not.toMatch(/INCLUDE/);
    expect(spy).toHaveBeenCalledWith(expect.stringMatching(/DuckDB doesn't support partial \/ covering/));
    spy.mockRestore();
  });
});

describe('DuckDB Dialect', () => {
  it('quoteIdent uses double quotes and rejects null bytes', () => {
    expect(DuckdbDialect.quoteIdent('users')).toBe('"users"');
    expect(() => DuckdbDialect.quoteIdent('bad"name')).toThrow();
  });

  it('placeholder produces $1, $2, …', () => {
    const params: unknown[] = [];
    expect(DuckdbDialect.placeholder(params, 'a')).toBe('$1');
    expect(DuckdbDialect.placeholder(params, 'b')).toBe('$2');
    expect(params).toEqual(['a', 'b']);
  });

  it('columnType maps schema kinds to DuckDB types', () => {
    expect(DuckdbDialect.columnType({ kind: 'string', optional: false, unique: false, updatedAt: false } as any)).toBe('VARCHAR');
    expect(DuckdbDialect.columnType({ kind: 'json', optional: false, unique: false, updatedAt: false } as any)).toBe('JSON');
    expect(DuckdbDialect.columnType({ kind: 'dateTime', optional: false, unique: false, updatedAt: false } as any)).toBe('TIMESTAMPTZ');
    expect(DuckdbDialect.columnType({ kind: 'stringArray', optional: false, unique: false, updatedAt: false } as any)).toBe('VARCHAR[]');
  });

  it('searchClause falls back to ILIKE (no native FTS yet)', () => {
    const sql = DuckdbDialect.searchClause('"body"', '$1', { rawColumn: 'body', baseTable: 'docs', quoteIdent: (s) => `"${s}"` });
    expect(sql).toBe(`"body" ILIKE '%' || $1 || '%'`);
  });
});

describe('DuckDB compile API', () => {
  it('returns SQLArtifact with dialect=duckdb', () => {
    const M = model('users', { id: f.id(), name: f.string() }) as unknown as ModelDef<any>;
    const api = buildDuckdbCompileApi(M);
    const art = api.findMany({ where: { name: 'a' } });
    expect(art.kind).toBe('sql');
    expect(art.dialect).toBe('duckdb');
    expect(art.sql).toMatch(/SELECT/);
  });

  it('softDelete sets semantic + semanticOp', () => {
    const M = model('docs', {
      id: f.id(),
      deletedAt: f.dateTime().optional().softDeleteAt(),
    }) as unknown as ModelDef<any>;
    const art = buildDuckdbCompileApi(M).softDelete({ where: { id: 'x' } });
    expect(art.semanticOp).toBe('softDelete');
    expect(art.dialect).toBe('duckdb');
  });
});
