// JSON path queries — `where: { col: { path: 'a.b.c', gte: 18 } }` compiles
// per dialect to the native JSON extraction + comparison.

import { f, model } from '../schema/core';
import type { ModelDef } from '../schema/types';
import { buildPostgresCompileApi } from '../adapters/postgres/compile';
import { buildMysqlCompileApi } from '../adapters/mysql/compile';
import { buildSqliteCompileApi } from '../adapters/sqlite/compile';
import { buildDuckdbCompileApi } from '../adapters/duckdb/compile';
import { buildMssqlCompileApi } from '../adapters/mssql/compile';

const M = model('users', {
  id: f.id(),
  meta: f.json(),
}) as unknown as ModelDef<any>;

describe('JSON path per dialect', () => {
  it('PG emits ->/->>/ with type cast for numeric comparison', () => {
    const art = buildPostgresCompileApi(M).findMany({
      where: { meta: { path: 'profile.age', gte: 18 } },
    });
    expect(art.sql).toMatch(/"meta"->'profile'->>'age'/);
    expect(art.sql).toMatch(/::numeric/);
    expect(art.params).toContain(18);
  });

  it('PG handles array index path segments via numeric ->', () => {
    const art = buildPostgresCompileApi(M).findMany({
      where: { meta: { path: 'addresses[0].city', eq: 'Lagos' } },
    });
    expect(art.sql).toMatch(/"meta"->'addresses'->0->>'city'/);
    expect(art.params).toContain('Lagos');
  });

  it('MySQL emits JSON_UNQUOTE(JSON_EXTRACT(...))', () => {
    const art = buildMysqlCompileApi(M).findMany({
      where: { meta: { path: 'profile.age', gte: 18 } },
    });
    expect(art.sql).toMatch(/JSON_UNQUOTE\(JSON_EXTRACT\(/);
    expect(art.sql).toMatch(/\$\.profile\.age/);
  });

  it('SQLite emits json_extract(...)', () => {
    const art = buildSqliteCompileApi(M).findMany({
      where: { meta: { path: 'profile.age', gte: 18 } },
    });
    expect(art.sql).toMatch(/json_extract\([^,]+, '\$\.profile\.age'\)/);
  });

  it('DuckDB emits json_extract(...)', () => {
    const art = buildDuckdbCompileApi(M).findMany({
      where: { meta: { path: 'profile.age', gte: 18 } },
    });
    expect(art.sql).toMatch(/json_extract\([^,]+, '\$\.profile\.age'\)/);
  });

  it('MSSQL emits JSON_VALUE(...)', () => {
    const art = buildMssqlCompileApi(M).findMany({
      where: { meta: { path: 'profile.age', gte: 18 } },
    });
    expect(art.sql).toMatch(/JSON_VALUE\([^,]+, '\$\.profile\.age'\)/);
  });

  it('supports the `in` sub-op', () => {
    const art = buildPostgresCompileApi(M).findMany({
      where: { meta: { path: 'status', in: ['active', 'pending'] } },
    });
    expect(art.sql).toMatch(/IN \(\$\d+, \$\d+\)/);
    expect(art.params).toContain('active');
    expect(art.params).toContain('pending');
  });

  it('eq is the default sub-op when only path is given (combined with explicit eq)', () => {
    const art = buildPostgresCompileApi(M).findMany({
      where: { meta: { path: 'role', eq: 'admin' } },
    });
    expect(art.sql).toMatch(/= \$1/);
    expect(art.params).toEqual(['admin']);
  });

  it('contains compiles to a LIKE on the extracted text', () => {
    const art = buildPostgresCompileApi(M).findMany({
      where: { meta: { path: 'bio', contains: 'engineer' } },
    });
    expect(art.sql).toMatch(/LIKE \$1/);
    expect(art.params).toContain('%engineer%');
  });

  it('rejects path use on a non-JSON field', () => {
    const N = model('users', { id: f.id(), name: f.string() }) as unknown as ModelDef<any>;
    expect(() =>
      buildPostgresCompileApi(N).findMany({ where: { name: { path: 'foo', eq: 'bar' } } }),
    ).toThrow(/can only be used on json/);
  });

  it('parses dotted + array-indexed paths', () => {
    const art = buildPostgresCompileApi(M).findMany({
      where: { meta: { path: 'tags[2]', eq: 'urgent' } },
    });
    // 'tags' then index 2.
    expect(art.sql).toMatch(/"meta"->'tags'->>2/);
  });

  it('accepts path as an array form', () => {
    const art = buildPostgresCompileApi(M).findMany({
      where: { meta: { path: ['profile', 'age'], gte: 18 } as any },
    });
    expect(art.sql).toMatch(/"meta"->'profile'->>'age'/);
  });
});
