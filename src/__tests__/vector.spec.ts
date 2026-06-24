// Vector field + typed near/nearTo across dialects.

import { f, model } from '../schema/core';
import type { ModelDef } from '../schema/types';
import { buildSchemaDDL as buildPgDDL } from '../adapters/postgres/ddl';
import { buildSchemaDDL as buildMysqlDDL } from '../adapters/mysql/ddl';
import { buildSchemaDDL as buildDuckdbDDL } from '../adapters/duckdb/ddl';
import { buildSchemaDDL as buildMssqlDDL } from '../adapters/mssql/ddl';
import { buildPostgresCompileApi } from '../adapters/postgres/compile';
import { buildMysqlCompileApi } from '../adapters/mysql/compile';
import { buildDuckdbCompileApi } from '../adapters/duckdb/compile';
import { buildMssqlCompileApi } from '../adapters/mssql/compile';

function vecModel(metric: 'cosine' | 'l2' | 'dot' = 'cosine') {
  return model('docs', {
    id: f.id(),
    body: f.text(),
    embedding: f.vector(4, { metric }),
  }, {
    indexes: [{ keys: { embedding: 1 }, method: 'vector', name: 'idx_docs_emb' }],
  }) as unknown as ModelDef<any>;
}

const Q = [0.1, 0.2, 0.3, 0.4];

describe('Vector — column types per dialect', () => {
  it('PG emits vector(N)', () => {
    const ddl = buildPgDDL({ doc: vecModel() });
    const tbl = ddl.find((s) => s.kind === 'table' && s.name === 'docs')!;
    expect(tbl.sql).toMatch(/"embedding" vector\(4\)/);
  });
  it('MySQL emits VECTOR(N)', () => {
    const ddl = buildMysqlDDL({ doc: vecModel() });
    const tbl = ddl.find((s) => s.kind === 'table' && s.name === 'docs')!;
    expect(tbl.sql).toMatch(/`embedding` VECTOR\(4\)/);
  });
  it('DuckDB emits FLOAT[N]', () => {
    const ddl = buildDuckdbDDL({ doc: vecModel() });
    const tbl = ddl.find((s) => s.kind === 'table' && s.name === 'docs')!;
    expect(tbl.sql).toMatch(/"embedding" FLOAT\[4\]/);
  });
  it('MSSQL emits VECTOR(N)', () => {
    const ddl = buildMssqlDDL({ doc: vecModel() });
    const tbl = ddl.find((s) => s.kind === 'table' && s.name === 'docs')!;
    expect(tbl.sql).toMatch(/\[embedding\] VECTOR\(4\)/);
  });
});

describe('Vector — index method per dialect', () => {
  it('PG resolves vector to USING hnsw + vector_cosine_ops', () => {
    const ddl = buildPgDDL({ doc: vecModel('cosine') });
    const idx = ddl.find((s) => s.name === 'idx_docs_emb')!;
    expect(idx.sql).toMatch(/USING hnsw/);
    expect(idx.sql).toMatch(/vector_cosine_ops/);
  });
  it('PG vector_l2_ops on l2 metric', () => {
    const ddl = buildPgDDL({ doc: vecModel('l2') });
    const idx = ddl.find((s) => s.name === 'idx_docs_emb')!;
    expect(idx.sql).toMatch(/vector_l2_ops/);
  });
  it('DuckDB resolves to USING HNSW (no opclass)', () => {
    const ddl = buildDuckdbDDL({ doc: vecModel() });
    const idx = ddl.find((s) => s.name === 'idx_docs_emb')!;
    expect(idx.sql).toMatch(/USING HNSW/);
    expect(idx.sql).not.toMatch(/vector_cosine_ops/);
  });
  it('MSSQL rewrites to USING VECTOR WITH (algorithm = HNSW)', () => {
    const ddl = buildMssqlDDL({ doc: vecModel() });
    const idx = ddl.find((s) => s.name === 'idx_docs_emb')!;
    expect(idx.sql).toMatch(/USING VECTOR WITH \(algorithm = 'HNSW'\)/);
  });
});

describe('Vector — insert value coercion', () => {
  it('PG binds the bracketed text form ::vector', () => {
    const art = buildPostgresCompileApi(vecModel()).create({
      data: { id: 'a', body: 'hi', embedding: Q },
    });
    expect(art.sql).toMatch(/::vector/);
    expect(art.params).toContain('[0.1,0.2,0.3,0.4]');
  });
  it('MySQL binds via STRING_TO_VECTOR', () => {
    const art = buildMysqlCompileApi(vecModel()).create({
      data: { id: 'a', body: 'hi', embedding: Q },
    });
    expect(art.sql).toMatch(/STRING_TO_VECTOR/);
  });
  it('DuckDB inlines as ::FLOAT[N] typed literal', () => {
    const art = buildDuckdbCompileApi(vecModel()).create({
      data: { id: 'a', body: 'hi', embedding: Q },
    });
    expect(art.sql).toMatch(/\[0\.1,0\.2,0\.3,0\.4\]::FLOAT\[4\]/);
  });
  it('MSSQL binds via CAST AS VECTOR(N)', () => {
    const art = buildMssqlCompileApi(vecModel()).create({
      data: { id: 'a', body: 'hi', embedding: Q },
    });
    expect(art.sql).toMatch(/CAST\(@p\d+ AS VECTOR\(4\)\)/);
  });
});

describe('Vector — where { col: { near: { vector, withinDistance? } } }', () => {
  it('PG cosine emits <=> operator', () => {
    const art = buildPostgresCompileApi(vecModel('cosine')).findMany({
      where: { embedding: { near: { vector: Q, withinDistance: 0.5 } } },
    });
    expect(art.sql).toMatch(/<=>/);
    expect(art.params).toContain(0.5);
  });
  it('PG l2 emits <-> operator', () => {
    const art = buildPostgresCompileApi(vecModel('l2')).findMany({
      where: { embedding: { near: { vector: Q, withinDistance: 1.5 } } },
    });
    expect(art.sql).toMatch(/<->/);
  });
  it('PG dot emits <#> operator', () => {
    const art = buildPostgresCompileApi(vecModel('dot')).findMany({
      where: { embedding: { near: { vector: Q, withinDistance: 0.5 } } },
    });
    expect(art.sql).toMatch(/<#>/);
  });
  it('MySQL emits DISTANCE(...,..,COSINE)', () => {
    const art = buildMysqlCompileApi(vecModel('cosine')).findMany({
      where: { embedding: { near: { vector: Q, withinDistance: 0.5 } } },
    });
    expect(art.sql).toMatch(/DISTANCE\(/);
    expect(art.sql).toMatch(/'COSINE'/);
  });
  it('DuckDB emits array_cosine_distance', () => {
    const art = buildDuckdbCompileApi(vecModel('cosine')).findMany({
      where: { embedding: { near: { vector: Q, withinDistance: 0.5 } } },
    });
    expect(art.sql).toMatch(/array_cosine_distance/);
  });
  it('MSSQL emits VECTOR_DISTANCE', () => {
    const art = buildMssqlCompileApi(vecModel('cosine')).findMany({
      where: { embedding: { near: { vector: Q, withinDistance: 0.5 } } },
    });
    expect(art.sql).toMatch(/VECTOR_DISTANCE\(/);
  });
  it('rejects vector with wrong dims', () => {
    expect(() => buildPostgresCompileApi(vecModel()).findMany({
      where: { embedding: { near: { vector: [0.1, 0.2] } } }, // only 2 dims, need 4
    })).toThrow(/does not match the column dims/);
  });
});

describe('Vector — orderBy nearTo + _distance synthetic field', () => {
  it('PG adds AS _distance and ORDER BY _distance ASC', () => {
    const art = buildPostgresCompileApi(vecModel()).findMany({
      orderBy: { embedding: { nearTo: Q } },
    });
    expect(art.sql).toMatch(/AS _distance/);
    expect(art.sql).toMatch(/ORDER BY "_distance" ASC/);
  });
  it('combined near + nearTo + take works on PG', () => {
    const art = buildPostgresCompileApi(vecModel()).findMany({
      where:   { embedding: { near: { vector: Q, withinDistance: 0.5 } } },
      orderBy: { embedding: { nearTo: Q } },
      take: 10,
    });
    expect(art.sql).toMatch(/SELECT.*<=>.*AS _distance.*FROM.*WHERE.*<=>/s);
    expect(art.sql).toMatch(/LIMIT 10/);
  });
  it('DuckDB nearTo emits array_cosine_distance', () => {
    const art = buildDuckdbCompileApi(vecModel('cosine')).findMany({
      orderBy: { embedding: { nearTo: Q } },
    });
    expect(art.sql).toMatch(/array_cosine_distance.*AS _distance/);
  });
});

describe('Vector field validation', () => {
  it('rejects f.vector(0) and f.vector(-1)', () => {
    expect(() => f.vector(0)).toThrow(/positive integer/);
    expect(() => f.vector(-1)).toThrow(/positive integer/);
  });
});
