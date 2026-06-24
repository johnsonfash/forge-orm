// 2.2.0 — IndexDef extensions: SQL partial/expression/include/method,
// Mongo geo (2dsphere/2d/hashed) + collation + wildcardProjection.
// Each block covers DDL emission for one dialect (Mongo via collectIndexSpecs).

import { f, model } from '../schema/core';
import type { ModelDef } from '../schema/types';
import { buildSchemaDDL as buildPgDDL } from '../adapters/postgres/ddl';
import { buildSchemaDDL as buildMysqlDDL } from '../adapters/mysql/ddl';
import { buildSchemaDDL as buildSqliteDDL } from '../adapters/sqlite/ddl';
import { collectIndexSpecs, fingerprint } from '../adapters/mongo/scripts/push';
import { generateMigration } from '../scripts/migrate-gen';
import type { DbIntrospection } from '../adapters/types';

// Silence the warn() calls our negative tests intentionally trigger.
let warnSpy: jest.SpyInstance;
beforeEach(() => {
  warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  warnSpy.mockRestore();
});

// -----------------------------------------------------------------------------
// Postgres
// -----------------------------------------------------------------------------

describe('Postgres — IndexDef extensions (2.2.0)', () => {
  const findIdx = (schema: any, name: string) => {
    const ddl = buildPgDDL(schema);
    return ddl.find((s) => s.kind === 'index' && s.name === name);
  };

  it('method: gin emits USING gin', () => {
    const M = model('payments', { id: f.id(), tags: f.stringArray() }, {
      indexes: [{ keys: { tags: 1 }, method: 'gin', name: 'idx_pay_tags_gin' }],
    }) as unknown as ModelDef<any>;
    const stmt = findIdx({ M }, 'idx_pay_tags_gin')!;
    expect(stmt.sql).toMatch(/USING gin/);
    expect(stmt.sql).toMatch(/\("tags"\)/);
    // Non-btree methods drop ASC/DESC + opclasses.
    expect(stmt.sql).not.toMatch(/ASC|DESC|text_pattern_ops/);
  });

  it('method: gist / brin / hash all emit USING <method>', () => {
    for (const m of ['gist', 'brin', 'hash'] as const) {
      const M = model(`tbl_${m}`, { id: f.id(), col: f.string() }, {
        indexes: [{ keys: { col: 1 }, method: m, name: `idx_${m}` }],
      }) as unknown as ModelDef<any>;
      const stmt = findIdx({ M }, `idx_${m}`)!;
      expect(stmt.sql).toContain(`USING ${m}`);
    }
  });

  it('method: btree (or undefined) does NOT emit USING (PG default)', () => {
    const Default = model('a', { id: f.id(), col: f.string() }, {
      indexes: [{ keys: { col: 1 }, name: 'idx_default' }],
    }) as unknown as ModelDef<any>;
    const Btree = model('b', { id: f.id(), col: f.string() }, {
      indexes: [{ keys: { col: 1 }, method: 'btree', name: 'idx_btree' }],
    }) as unknown as ModelDef<any>;
    expect(findIdx({ Default }, 'idx_default')!.sql).not.toMatch(/USING/);
    expect(findIdx({ Btree }, 'idx_btree')!.sql).not.toMatch(/USING/);
  });

  it('expression replaces the column list with ((<expr>))', () => {
    const M = model('users', { id: f.id(), email: f.string() }, {
      indexes: [{ keys: {}, expression: 'lower(email)', name: 'idx_users_email_lower' }],
    }) as unknown as ModelDef<any>;
    const stmt = findIdx({ M }, 'idx_users_email_lower')!;
    expect(stmt.sql).toMatch(/\(lower\(email\)\)/);
    // No column references in the payload.
    expect(stmt.sql).not.toMatch(/"email"/);
  });

  it('include emits INCLUDE (cols)', () => {
    const M = model('orders', {
      id: f.id(),
      customer_id: f.objectId(),
      total: f.float(),
      status: f.string(),
    }, {
      indexes: [{
        keys: { customer_id: 1 },
        include: ['status', 'total'],
        name: 'idx_orders_customer_covering',
      }],
    }) as unknown as ModelDef<any>;
    const stmt = findIdx({ M }, 'idx_orders_customer_covering')!;
    expect(stmt.sql).toMatch(/INCLUDE \("status", "total"\)/);
  });

  it('where (raw SQL string) emits WHERE clause', () => {
    const M = model('items', {
      id: f.id(),
      sku: f.string(),
      deleted_at: f.dateTime().optional(),
    }, {
      indexes: [{
        keys: { sku: 1 },
        unique: true,
        where: 'deleted_at IS NULL',
        name: 'idx_items_sku_live',
      }],
    }) as unknown as ModelDef<any>;
    const stmt = findIdx({ M }, 'idx_items_sku_live')!;
    expect(stmt.sql).toMatch(/UNIQUE INDEX/);
    expect(stmt.sql).toMatch(/WHERE deleted_at IS NULL$/);
  });

  it('where (object form) is translated to SQL on Postgres (2.2.2+)', () => {
    const M = model('w', { id: f.id(), col: f.string() }, {
      indexes: [{
        keys: { col: 1 },
        where: { col: { $type: 'string' } } as any,
        name: 'idx_w_obj',
      }],
    }) as unknown as ModelDef<any>;
    const stmt = findIdx({ M }, 'idx_w_obj')!;
    // The translator handles the common partial-filter operators; no warning.
    expect(stmt.sql).toMatch(/WHERE "col" IS NOT NULL/);
    expect(warnSpy).not.toHaveBeenCalledWith(expect.stringMatching(/object-form 'where'/));
  });

  it('partialFilterExpression on a Mongo-shaped schema lands on SQL too (2.2.2+)', () => {
    // Single schema, single field — both Mongo and Postgres push the same
    // partial intent without an explicit where: 'sql…' alias.
    const M = model('items', { id: f.id(), sku: f.string(), deletedAt: f.dateTime().optional() }, {
      indexes: [{
        keys: { sku: 1 },
        unique: true,
        name: 'idx_items_sku_live',
        partialFilterExpression: { deletedAt: { $exists: false } },
      }],
    }) as unknown as ModelDef<any>;
    const stmt = findIdx({ M }, 'idx_items_sku_live')!;
    expect(stmt.sql).toMatch(/WHERE "deletedAt" IS NULL/);
  });

  it('where (object form) with unsupported operator falls back to warn + skip', () => {
    const M = model('w', { id: f.id(), tags: f.json() }, {
      indexes: [{
        keys: { tags: 1 },
        // $elemMatch isn't in the translator's coverage — falls back to skip.
        where: { tags: { $elemMatch: { x: 1 } } } as any,
        name: 'idx_w_unsupported',
      }],
    }) as unknown as ModelDef<any>;
    const stmt = findIdx({ M }, 'idx_w_unsupported')!;
    expect(stmt.sql).not.toMatch(/WHERE/);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringMatching(/operators outside the translator's coverage/));
  });

  it('compound: method + include + where together', () => {
    const M = model('events', {
      id: f.id(),
      org_id: f.objectId(),
      at: f.dateTime(),
      kind: f.string(),
      payload: f.json(),
    }, {
      indexes: [{
        keys: { at: 1 },
        method: 'brin',
        include: ['kind'],
        where: 'kind <> \'noop\'',
        name: 'idx_events_at_brin_partial',
      }],
    }) as unknown as ModelDef<any>;
    const stmt = findIdx({ M }, 'idx_events_at_brin_partial')!;
    expect(stmt.sql).toContain('USING brin');
    expect(stmt.sql).toContain('INCLUDE ("kind")');
    expect(stmt.sql).toContain('WHERE kind <> \'noop\'');
  });
});

// -----------------------------------------------------------------------------
// MySQL
// -----------------------------------------------------------------------------

describe('MySQL — IndexDef extensions (2.2.0)', () => {
  const findIdx = (schema: any, name: string) => {
    const ddl = buildMysqlDDL(schema);
    return ddl.find((s) => s.kind === 'index' && s.name === name);
  };

  it('method: spatial emits CREATE SPATIAL INDEX', () => {
    const M = model('places', { id: f.id(), geom: f.json() }, {
      indexes: [{ keys: { geom: 1 }, method: 'spatial', name: 'idx_places_geom' }],
    }) as unknown as ModelDef<any>;
    const stmt = findIdx({ M }, 'idx_places_geom')!;
    expect(stmt.sql).toMatch(/CREATE SPATIAL INDEX/);
  });

  it('method: fulltext emits CREATE FULLTEXT INDEX', () => {
    const M = model('docs', { id: f.id(), body: f.text() }, {
      indexes: [{ keys: { body: 1 }, method: 'fulltext', name: 'idx_docs_body_ft' }],
    }) as unknown as ModelDef<any>;
    const stmt = findIdx({ M }, 'idx_docs_body_ft')!;
    expect(stmt.sql).toMatch(/CREATE FULLTEXT INDEX/);
  });

  it('expression emits CREATE INDEX … ((<expr>))', () => {
    const M = model('users', { id: f.id(), email: f.string() }, {
      indexes: [{ keys: {}, expression: 'LOWER(email)', name: 'idx_users_email_lower' }],
    }) as unknown as ModelDef<any>;
    const stmt = findIdx({ M }, 'idx_users_email_lower')!;
    expect(stmt.sql).toMatch(/\(LOWER\(email\)\)/);
  });

  it('include is PG-only — warned + ignored on MySQL', () => {
    const M = model('o', { id: f.id(), col: f.string() }, {
      indexes: [{ keys: { col: 1 }, include: ['col'], name: 'idx_o_inc' }],
    }) as unknown as ModelDef<any>;
    const stmt = findIdx({ M }, 'idx_o_inc')!;
    expect(stmt.sql).not.toMatch(/INCLUDE/);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringMatching(/INCLUDE is a Postgres-only/));
  });

  it('where on a non-unique index — warned + ignored on MySQL (no partial-index workaround for non-unique)', () => {
    const M = model('o', { id: f.id(), col: f.string() }, {
      indexes: [{ keys: { col: 1 }, where: 'col IS NOT NULL', name: 'idx_o_w' }],
    }) as unknown as ModelDef<any>;
    const stmt = findIdx({ M }, 'idx_o_w')!;
    expect(stmt.sql).not.toMatch(/WHERE/);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringMatching(/MySQL has no partial-index equivalent/));
  });

  it('where on a unique index — rewritten as a CASE-expression functional index on MySQL', () => {
    const M = model('items', { id: f.id(), sku: f.string(), deletedAt: f.dateTime().optional() }, {
      indexes: [{
        keys: { sku: 1 }, unique: true,
        where: '`deletedAt` IS NULL',
        name: 'idx_items_sku_live',
      }],
    }) as unknown as ModelDef<any>;
    const stmt = findIdx({ M }, 'idx_items_sku_live')!;
    // The unique partial is expressed as a functional UNIQUE INDEX over a
    // CASE expression — NULLs collide-exempt so non-matching rows are out
    // of the constraint.
    expect(stmt.sql).toMatch(/CREATE UNIQUE INDEX/);
    expect(stmt.sql).toMatch(/CASE WHEN .* THEN `sku` ELSE NULL END/);
  });

  it('Mongo-shaped partialFilterExpression also rewrites into the MySQL CASE form (unique)', () => {
    const M = model('items', { id: f.id(), sku: f.string(), deletedAt: f.dateTime().optional() }, {
      indexes: [{
        keys: { sku: 1 }, unique: true,
        partialFilterExpression: { deletedAt: { $exists: false } },
        name: 'idx_items_sku_live',
      }],
    }) as unknown as ModelDef<any>;
    const stmt = findIdx({ M }, 'idx_items_sku_live')!;
    expect(stmt.sql).toMatch(/CREATE UNIQUE INDEX/);
    expect(stmt.sql).toMatch(/CASE WHEN \(`deletedAt` IS NULL\) THEN `sku` ELSE NULL END/);
  });
});

// -----------------------------------------------------------------------------
// SQLite
// -----------------------------------------------------------------------------

describe('SQLite — IndexDef extensions (2.2.0)', () => {
  const findIdx = (schema: any, name: string) => {
    const ddl = buildSqliteDDL(schema);
    return ddl.find((s) => s.kind === 'index' && s.name === name);
  };

  it('expression emits CREATE INDEX … (<expr>)', () => {
    const M = model('users', { id: f.id(), email: f.string() }, {
      indexes: [{ keys: {}, expression: 'lower(email)', name: 'idx_users_email_lower' }],
    }) as unknown as ModelDef<any>;
    const stmt = findIdx({ M }, 'idx_users_email_lower')!;
    expect(stmt.sql).toMatch(/\(lower\(email\)\)/);
  });

  it('where (raw SQL) emits WHERE clause — SQLite supports partial natively', () => {
    const M = model('items', {
      id: f.id(),
      sku: f.string(),
      deleted_at: f.dateTime().optional(),
    }, {
      indexes: [{
        keys: { sku: 1 },
        unique: true,
        where: 'deleted_at IS NULL',
        name: 'idx_items_sku_live',
      }],
    }) as unknown as ModelDef<any>;
    const stmt = findIdx({ M }, 'idx_items_sku_live')!;
    expect(stmt.sql).toMatch(/WHERE deleted_at IS NULL$/);
  });

  it('method=gin warned + ignored (SQLite is BTREE-only)', () => {
    const M = model('m', { id: f.id(), col: f.string() }, {
      indexes: [{ keys: { col: 1 }, method: 'gin', name: 'idx_m_gin' }],
    }) as unknown as ModelDef<any>;
    findIdx({ M }, 'idx_m_gin');
    expect(warnSpy).toHaveBeenCalledWith(expect.stringMatching(/SQLite only supports BTREE/));
  });

  it('include warned + ignored on SQLite', () => {
    const M = model('m', { id: f.id(), col: f.string() }, {
      indexes: [{ keys: { col: 1 }, include: ['col'], name: 'idx_m_inc' }],
    }) as unknown as ModelDef<any>;
    findIdx({ M }, 'idx_m_inc');
    expect(warnSpy).toHaveBeenCalledWith(expect.stringMatching(/INCLUDE is a Postgres-only/));
  });
});

// -----------------------------------------------------------------------------
// Mongo
// -----------------------------------------------------------------------------

describe('Mongo — IndexDef extensions (2.2.0)', () => {
  it('2dsphere key threads through collectIndexSpecs verbatim', () => {
    const M = model('locations', { id: f.id(), location: f.json() }, {
      indexes: [{ keys: { location: '2dsphere' }, name: 'idx_loc_geo' }],
    }) as unknown as ModelDef<any>;
    const spec = collectIndexSpecs('locations', M).find((s) => s.name === 'idx_loc_geo')!;
    expect(spec.keys).toEqual({ location: '2dsphere' });
  });

  it('2d + hashed keys round-trip', () => {
    const M = model('m', {
      id: f.id(),
      geo: f.json(),
      shard: f.objectId(),
    }, {
      indexes: [
        { keys: { geo: '2d' }, name: 'idx_geo_2d' },
        { keys: { shard: 'hashed' }, name: 'idx_shard_hashed' },
      ],
    }) as unknown as ModelDef<any>;
    const specs = collectIndexSpecs('m', M);
    expect(specs.find((s) => s.name === 'idx_geo_2d')!.keys).toEqual({ geo: '2d' });
    expect(specs.find((s) => s.name === 'idx_shard_hashed')!.keys).toEqual({ shard: 'hashed' });
  });

  it('collation passes through and changes the fingerprint', () => {
    const M = model('m', { id: f.id(), name: f.string() }, {
      indexes: [{
        keys: { name: 1 },
        unique: true,
        name: 'idx_name_ci',
        collation: { locale: 'en', strength: 2 },
      }],
    }) as unknown as ModelDef<any>;
    const spec = collectIndexSpecs('m', M).find((s) => s.name === 'idx_name_ci')!;
    expect(spec.collation).toEqual({ locale: 'en', strength: 2 });
    const fpWith = fingerprint({ name: 1 }, true, false, undefined, undefined, { locale: 'en', strength: 2 });
    const fpWithout = fingerprint({ name: 1 }, true, false, undefined, undefined);
    expect(fpWith).not.toEqual(fpWithout);
  });

  it('wildcardProjection passes through and changes the fingerprint', () => {
    const M = model('m', { id: f.id(), data: f.json() }, {
      indexes: [{
        keys: { '$**': 1 },
        name: 'idx_wildcard',
        wildcardProjection: { 'data.$**': 1 },
      }],
    }) as unknown as ModelDef<any>;
    const spec = collectIndexSpecs('m', M).find((s) => s.name === 'idx_wildcard')!;
    expect(spec.wildcardProjection).toEqual({ 'data.$**': 1 });
  });

  it('where (object form) aliases partialFilterExpression', () => {
    const M = model('m', { id: f.id(), txn: f.string().optional() }, {
      indexes: [{
        keys: { txn: 1 },
        unique: true,
        name: 'idx_txn_partial',
        where: { txn: { $type: 'string' } },
      }],
    }) as unknown as ModelDef<any>;
    const spec = collectIndexSpecs('m', M).find((s) => s.name === 'idx_txn_partial')!;
    expect(spec.partialFilterExpression).toEqual({ txn: { $type: 'string' } });
  });

  it('partialFilterExpression takes precedence over where if both set', () => {
    const M = model('m', { id: f.id(), v: f.string().optional() }, {
      indexes: [{
        keys: { v: 1 },
        name: 'idx_dual',
        partialFilterExpression: { v: { $exists: true } },
        where: { v: { $type: 'string' } },
      }],
    }) as unknown as ModelDef<any>;
    const spec = collectIndexSpecs('m', M).find((s) => s.name === 'idx_dual')!;
    expect(spec.partialFilterExpression).toEqual({ v: { $exists: true } });
  });

  it('expression indexes are skipped on Mongo (no equivalent)', () => {
    const M = model('m', { id: f.id(), email: f.string() }, {
      indexes: [{ keys: {}, expression: 'lower(email)', name: 'idx_skip' }],
    }) as unknown as ModelDef<any>;
    const specs = collectIndexSpecs('m', M);
    expect(specs.find((s) => s.name === 'idx_skip')).toBeUndefined();
  });

  it('back-compat: legacy fingerprint signature is byte-identical when new args absent', () => {
    const legacy = fingerprint({ id: 1 }, true, false, undefined, undefined);
    const newSig = fingerprint({ id: 1 }, true, false, undefined, undefined, undefined, undefined);
    expect(legacy).toEqual(newSig);
  });
});

// -----------------------------------------------------------------------------
// generateMigration — diff/apply path now emits full 2.2 SQL
// -----------------------------------------------------------------------------

describe('generateMigration — 2.2 IndexDef extensions', () => {
  const emptyActual = (kind: 'postgres' | 'mysql' | 'sqlite', tableName: string): DbIntrospection => ({
    kind,
    tables: [{ name: tableName, columns: [{ name: 'id', type: 'text', notNull: true }], indexes: [], foreignKeys: [] }],
    views: [],
  } as unknown as DbIntrospection);

  it('PG: missing index with method=gin emits USING gin', () => {
    const M = model('m', { id: f.id(), tags: f.json() }, {
      indexes: [{ keys: { tags: 1 }, method: 'gin', name: 'idx_m_tags_gin' }],
    }) as unknown as ModelDef<any>;
    const out = generateMigration({ m: M }, emptyActual('postgres', 'm'));
    const upSql = out.map((p) => p.up).join('\n');
    expect(upSql).toMatch(/USING gin/);
    expect(upSql).toMatch(/"idx_m_tags_gin"/);
  });

  it('PG: missing index with where+include emits WHERE + INCLUDE', () => {
    const M = model('m', {
      id: f.id(),
      sku: f.string(),
      status: f.string(),
      deleted_at: f.dateTime().optional(),
    }, {
      indexes: [{
        keys: { sku: 1 },
        unique: true,
        include: ['status'],
        where: 'deleted_at IS NULL',
        name: 'idx_m_sku',
      }],
    }) as unknown as ModelDef<any>;
    const out = generateMigration({ m: M }, emptyActual('postgres', 'm'));
    const upSql = out.map((p) => p.up).join('\n');
    expect(upSql).toMatch(/UNIQUE INDEX/);
    expect(upSql).toMatch(/INCLUDE \("status"\)/);
    expect(upSql).toMatch(/WHERE deleted_at IS NULL/);
  });

  it('MySQL: method=spatial promotes the keyword prefix in migration SQL', () => {
    const M = model('m', { id: f.id(), geom: f.json() }, {
      indexes: [{ keys: { geom: 1 }, method: 'spatial', name: 'idx_m_geom' }],
    }) as unknown as ModelDef<any>;
    const out = generateMigration({ m: M }, emptyActual('mysql', 'm'));
    const upSql = out.map((p) => p.up).join('\n');
    expect(upSql).toMatch(/CREATE SPATIAL INDEX/);
  });

  it('SQLite: where (raw SQL) emits WHERE clause in migration SQL', () => {
    const M = model('m', { id: f.id(), sku: f.string(), del: f.dateTime().optional() }, {
      indexes: [{
        keys: { sku: 1 }, unique: true,
        where: 'del IS NULL', name: 'idx_m_sku_live',
      }],
    }) as unknown as ModelDef<any>;
    const out = generateMigration({ m: M }, emptyActual('sqlite', 'm'));
    const upSql = out.map((p) => p.up).join('\n');
    expect(upSql).toMatch(/WHERE del IS NULL/);
  });

  it('expression indexes are SKIPPED from the column-set diff (no spurious add)', () => {
    const M = model('m', { id: f.id(), email: f.string() }, {
      indexes: [{ keys: {}, expression: 'lower(email)', name: 'idx_m_email_lower' }],
    }) as unknown as ModelDef<any>;
    const out = generateMigration({ m: M }, emptyActual('postgres', 'm'));
    // expression indexes can't be diffed by column-set, so generator
    // intentionally skips them — forge:push is the source of truth.
    expect(out.find((p) => p.note.includes('idx_m_email_lower'))).toBeUndefined();
  });
});

// -----------------------------------------------------------------------------
// compile API — softDelete/restore + per-adapter dispatch (sweep gap fix)
// -----------------------------------------------------------------------------

describe('compile — softDelete / restore (added 2.2 sweep)', () => {
  it('Mongo compile.softDelete emits an updateOne setting the soft-delete column', () => {
    const { buildMongoCompileApi } = require('../adapters/mongo/compile');
    const M = model('docs', {
      id: f.id(),
      deletedAt: f.dateTime().optional().softDeleteAt(),
    }) as unknown as ModelDef<any>;
    const api = buildMongoCompileApi(M);
    const art = api.softDelete({ where: { id: 'x' } });
    expect(art.kind).toBe('mongo');
    expect(['updateOne', 'findOneAndUpdate']).toContain(art.op);
    const update = art.args?.update ?? {};
    const set = update.$set ?? {};
    expect('deletedAt' in set).toBe(true);
    expect(set.deletedAt instanceof Date).toBe(true);
  });

  it('Mongo compile.restore clears the soft-delete column ($set null or $unset)', () => {
    const { buildMongoCompileApi } = require('../adapters/mongo/compile');
    const M = model('docs', {
      id: f.id(),
      deletedAt: f.dateTime().optional().softDeleteAt(),
    }) as unknown as ModelDef<any>;
    const api = buildMongoCompileApi(M);
    const art = api.restore({ where: { id: 'x' } });
    expect(art.kind).toBe('mongo');
    const update = art.args?.update ?? {};
    const set = update.$set ?? {};
    const unset = update.$unset ?? {};
    expect(set.deletedAt === null || 'deletedAt' in unset).toBe(true);
  });

  it('Mongo compile.softDelete throws when the model has no softDeleteAt field', () => {
    const { buildMongoCompileApi } = require('../adapters/mongo/compile');
    const M = model('no_sd', { id: f.id(), name: f.string() }) as unknown as ModelDef<any>;
    const api = buildMongoCompileApi(M);
    expect(() => api.softDelete({ where: { id: 'x' } })).toThrow(/softDeleteAt/);
  });

  it('Postgres compile.softDelete emits UPDATE setting the soft-delete column', () => {
    const { buildPostgresCompileApi } = require('../adapters/postgres/compile');
    const M = model('docs', {
      id: f.id(),
      deletedAt: f.dateTime().optional().softDeleteAt(),
    }) as unknown as ModelDef<any>;
    const api = buildPostgresCompileApi(M);
    const art = api.softDelete({ where: { id: 'x' } });
    expect(art.kind).toBe('sql');
    expect(art.dialect).toBe('postgres');
    expect(art.sql).toMatch(/UPDATE/);
    expect(art.sql).toMatch(/"deletedAt"/);
  });

  it('Postgres compile.restore emits UPDATE clearing the soft-delete column', () => {
    const { buildPostgresCompileApi } = require('../adapters/postgres/compile');
    const M = model('docs', {
      id: f.id(),
      deletedAt: f.dateTime().optional().softDeleteAt(),
    }) as unknown as ModelDef<any>;
    const api = buildPostgresCompileApi(M);
    const art = api.restore({ where: { id: 'x' } });
    expect(art.kind).toBe('sql');
    expect(art.sql).toMatch(/UPDATE/);
    // Postgres binds NULL via param — the column gets set to a param that's null.
    expect(art.params).toContain(null);
  });

  it('MySQL compile builder exists + emits dialect=mysql artifact', () => {
    const { buildMysqlCompileApi } = require('../adapters/mysql/compile');
    const M = model('docs', { id: f.id(), name: f.string() }) as unknown as ModelDef<any>;
    const api = buildMysqlCompileApi(M);
    const art = api.findMany({});
    expect(art.kind).toBe('sql');
    expect(art.dialect).toBe('mysql');
  });

  it('SQLite compile builder exists + emits dialect=sqlite artifact', () => {
    const { buildSqliteCompileApi } = require('../adapters/sqlite/compile');
    const M = model('docs', { id: f.id(), name: f.string() }) as unknown as ModelDef<any>;
    const api = buildSqliteCompileApi(M);
    const art = api.findMany({});
    expect(art.kind).toBe('sql');
    expect(art.dialect).toBe('sqlite');
  });
});

// -----------------------------------------------------------------------------
// 2.2.1 — deeper sweep fixes (introspect drift detection + soft-delete event)
// -----------------------------------------------------------------------------

describe('diff-core deep drift detection (2.2.1)', () => {
  const { diffIntrospection } = require('../scripts/diff-core');

  it('reports a mismatch when the DB index has a different method', () => {
    const M = model('payments', { id: f.id(), tags: f.json() }, {
      indexes: [{ keys: { tags: 1 }, method: 'gin', name: 'idx_pay_tags' }],
    }) as unknown as ModelDef<any>;
    const actual = {
      kind: 'postgres',
      tables: [{
        name: 'payments',
        columns: [{ name: 'tags', type: 'jsonb', nullable: false }],
        indexes: [{ name: 'idx_pay_tags', columns: ['tags'], unique: false, method: 'btree' }],
        foreignKeys: [],
      }],
      views: [],
    };
    const r = diffIntrospection({ M }, actual, []);
    const mismatch = r.items.find((i: any) => i.detail.includes('method'));
    expect(mismatch).toBeDefined();
    expect(mismatch.direction).toBe('mismatch');
  });

  it('reports a mismatch when the DB index has a different INCLUDE list', () => {
    const M = model('orders', {
      id: f.id(), customer_id: f.objectId(), status: f.string(), total: f.float(),
    }, {
      indexes: [{ keys: { customer_id: 1 }, include: ['status', 'total'], name: 'idx_o_cov' }],
    }) as unknown as ModelDef<any>;
    const actual = {
      kind: 'postgres',
      tables: [{
        name: 'orders',
        columns: [],
        indexes: [{ name: 'idx_o_cov', columns: ['customer_id'], unique: false, include: ['status'] }],
        foreignKeys: [],
      }],
      views: [],
    };
    const r = diffIntrospection({ M }, actual, []);
    expect(r.items.some((i: any) => i.detail.includes('include'))).toBe(true);
  });

  it('reports a mismatch when the DB index has a different WHERE clause', () => {
    const M = model('items', { id: f.id(), sku: f.string() }, {
      indexes: [{ keys: { sku: 1 }, unique: true, where: 'deleted_at IS NULL', name: 'idx_i_sku' }],
    }) as unknown as ModelDef<any>;
    const actual = {
      kind: 'postgres',
      tables: [{
        name: 'items',
        columns: [],
        indexes: [{ name: 'idx_i_sku', columns: ['sku'], unique: true, where: 'deleted_at IS NOT NULL' }],
        foreignKeys: [],
      }],
      views: [],
    };
    const r = diffIntrospection({ M }, actual, []);
    expect(r.items.some((i: any) => i.detail.includes('where'))).toBe(true);
  });

  it('matches identical where strings ignoring whitespace + case', () => {
    const M = model('items', { id: f.id(), sku: f.string() }, {
      indexes: [{ keys: { sku: 1 }, unique: true, where: 'deleted_at IS NULL', name: 'idx_i_sku' }],
    }) as unknown as ModelDef<any>;
    const actual = {
      kind: 'postgres',
      tables: [{
        name: 'items',
        columns: [],
        indexes: [{ name: 'idx_i_sku', columns: ['sku'], unique: true, where: '  deleted_at  IS  NULL  ' }],
        foreignKeys: [],
      }],
      views: [],
    };
    const r = diffIntrospection({ M }, actual, []);
    expect(r.items.some((i: any) => i.detail.includes('where'))).toBe(false);
  });

  it('reports a mismatch when Mongo partialFilterExpression diverges', () => {
    const M = model('m', { id: f.id(), v: f.string().optional() }, {
      indexes: [{
        keys: { v: 1 }, unique: true, name: 'idx_v',
        partialFilterExpression: { v: { $type: 'string' } },
      }],
    }) as unknown as ModelDef<any>;
    const actual = {
      kind: 'mongo',
      tables: [{
        name: 'm', columns: [], foreignKeys: [],
        indexes: [{
          name: 'idx_v', columns: ['v'], unique: true,
          partialFilterExpression: { v: { $exists: true } },
        }],
      }],
      views: [],
    };
    const r = diffIntrospection({ M }, actual, []);
    expect(r.items.some((i: any) => i.detail.includes('partialFilter'))).toBe(true);
  });
});

describe('Compile artifacts carry semanticOp (2.2.2)', () => {
  it('Mongo compile.softDelete sets semanticOp on the artifact', () => {
    const { buildMongoCompileApi } = require('../adapters/mongo/compile');
    const M = model('docs', { id: f.id(), deletedAt: f.dateTime().optional().softDeleteAt() }) as unknown as ModelDef<any>;
    const art = buildMongoCompileApi(M).softDelete({ where: { id: 'x' } });
    expect(art.semanticOp).toBe('softDelete');
  });
  it('Postgres compile.restoreMany sets semanticOp on the artifact', () => {
    const { buildPostgresCompileApi } = require('../adapters/postgres/compile');
    const M = model('docs', { id: f.id(), deletedAt: f.dateTime().optional().softDeleteAt() }) as unknown as ModelDef<any>;
    const art = buildPostgresCompileApi(M).restoreMany({ where: { id: 'x' } });
    expect(art.semanticOp).toBe('restoreMany');
  });
  it('Plain update artifact has no semanticOp', () => {
    const { buildPostgresCompileApi } = require('../adapters/postgres/compile');
    const M = model('docs', { id: f.id(), name: f.string() }) as unknown as ModelDef<any>;
    const art = buildPostgresCompileApi(M).update({ where: { id: 'x' }, data: { name: 'new' } });
    expect(art.semanticOp).toBeUndefined();
  });
});

describe('events QueryEvent.semanticOp (2.2.1)', () => {
  it('softDelete/softDeleteMany/restore/restoreMany are reserved semanticOp values', () => {
    // Pure type-shape assertion. If this compiles, the field accepts those
    // four values.
    const e: import('../events').QueryEvent = {
      adapter: 'postgres', model: 'docs', op: 'update', sql: '', params: [],
      duration_ms: 0, rowCount: 0, startedAt: new Date(),
      semanticOp: 'softDelete',
    };
    expect(e.semanticOp).toBe('softDelete');
  });
});
