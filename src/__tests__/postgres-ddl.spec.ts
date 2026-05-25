import { f, model, rel } from '../schema/core';
import type { ModelDef } from '../schema/types';
import { buildSchemaDDL } from '../adapters/postgres/ddl';

const ROLE_VALUES = ['OWNER', 'ADMIN', 'MEMBER'] as const;

const User: ModelDef<any> = model('users', {
  id: f.id(),
  email: f.string().unique(),
  age: f.int().optional(),
  active: f.bool().default(false),
  role: f.enumOf(ROLE_VALUES).default('MEMBER'),
  tags: f.stringArray().optional(),
  created_at: f.dateTime().default('now'),
}, {
  indexes: [{ keys: { created_at: -1 } }],
}).relate(() => ({
  posts: rel.many('post', { on: 'author_id', refs: 'id' }),
})) as ModelDef<any>;

const Post: ModelDef<any> = model('posts', {
  id: f.id(),
  author_id: f.objectId(),
  title: f.string(),
  body: f.string().optional(),
}).relate(() => ({
  author: rel.one('user', { on: 'author_id', refs: 'id', onDelete: 'Cascade' }),
})) as ModelDef<any>;

const Member: ModelDef<any> = model('members', {
  id: f.id(),
  org_id: f.objectId(),
  user_id: f.objectId(),
}, {
  uniques: [['org_id', 'user_id']],
}).relate(() => ({
  // Hand-rolled composite unique example.
})) as ModelDef<any>;

const SCHEMA: any = { user: User, post: Post, member: Member };

describe('PG DDL — CREATE TABLE', () => {
  it('emits one statement per table, columns + types + NOT NULL + DEFAULT', () => {
    const ddl = buildSchemaDDL(SCHEMA);
    const userTable = ddl.find((s) => s.kind === 'table' && s.name === 'users')!;
    expect(userTable).toBeDefined();
    expect(userTable.sql).toMatch(/CREATE TABLE IF NOT EXISTS "users"/);
    expect(userTable.sql).toMatch(/"id" text NOT NULL/);
    expect(userTable.sql).toMatch(/"email" text NOT NULL/);
    expect(userTable.sql).toMatch(/"age" integer$|"age" integer,/m); // nullable
    expect(userTable.sql).toMatch(/"active" boolean NOT NULL DEFAULT FALSE/);
    expect(userTable.sql).toMatch(/"role" text NOT NULL DEFAULT 'MEMBER'/);
    expect(userTable.sql).toMatch(/"tags" text\[\]/);
    expect(userTable.sql).toMatch(/"created_at" timestamptz NOT NULL DEFAULT now\(\)/);
    expect(userTable.sql).toMatch(/PRIMARY KEY \("id"\)/);
  });

  it('drops cascade by default', () => {
    const ddl = buildSchemaDDL(SCHEMA);
    const userTable = ddl.find((s) => s.kind === 'table' && s.name === 'users')!;
    expect(userTable.dropSql).toBe('DROP TABLE IF EXISTS "users" CASCADE');
  });
});

describe('PG DDL — constraints', () => {
  it('per-field UNIQUE emits ALTER TABLE … ADD CONSTRAINT … UNIQUE', () => {
    const ddl = buildSchemaDDL(SCHEMA);
    const uq = ddl.find((s) => s.kind === 'unique' && s.table === 'users')!;
    expect(uq).toBeDefined();
    expect(uq.sql).toMatch(/ADD CONSTRAINT "forge_users_uq_email" UNIQUE \("email"\)/);
  });

  it('composite @@unique uses both columns, sorted in declaration order', () => {
    const ddl = buildSchemaDDL(SCHEMA);
    const uq = ddl.find((s) => s.kind === 'unique' && s.table === 'members')!;
    expect(uq.sql).toMatch(/UNIQUE \("org_id", "user_id"\)/);
  });

  it('FOREIGN KEY honours onDelete: Cascade and references the target table (not the schema key)', () => {
    const ddl = buildSchemaDDL(SCHEMA);
    const fk = ddl.find((s) => s.kind === 'foreignKey' && s.table === 'posts')!;
    expect(fk).toBeDefined();
    // References "users" (the collection), not "user" (the schema map key).
    expect(fk.sql).toMatch(/FOREIGN KEY \("author_id"\) REFERENCES "users" \("id"\) ON DELETE CASCADE/);
  });

  it('enum field gets a CHECK (col IN (...)) constraint', () => {
    const ddl = buildSchemaDDL(SCHEMA);
    const check = ddl.find((s) => s.kind === 'check' && s.table === 'users')!;
    expect(check).toBeDefined();
    expect(check.sql).toMatch(/CHECK \("role" IN \('OWNER', 'ADMIN', 'MEMBER'\)\)/);
  });

  it('id field is NOT given a redundant per-field UNIQUE (PK covers it)', () => {
    const ddl = buildSchemaDDL(SCHEMA);
    const uqOnId = ddl.find((s) => s.kind === 'unique' && s.name === 'forge_users_uq_id');
    expect(uqOnId).toBeUndefined();
  });
});

describe('PG DDL — indexes', () => {
  it('declared index → CREATE INDEX IF NOT EXISTS', () => {
    const ddl = buildSchemaDDL(SCHEMA);
    const idx = ddl.find((s) => s.kind === 'index' && s.table === 'users')!;
    expect(idx).toBeDefined();
    expect(idx.sql).toMatch(/CREATE INDEX IF NOT EXISTS "forge_users_idx_created_at" ON "users" \("created_at" DESC\)/);
  });
});

describe('PG DDL — deterministic naming', () => {
  it('constraint names are stable across runs (no random ids)', () => {
    const a = buildSchemaDDL(SCHEMA);
    const b = buildSchemaDDL(SCHEMA);
    expect(a.map((s) => s.name)).toEqual(b.map((s) => s.name));
  });

  it('long table+column names collapse via deterministic hash (< 60 chars)', () => {
    const bigCol = 'a'.repeat(60);
    const Big = model('a_table_with_a_long_name', {
      id: f.id(),
      [bigCol]: f.string().unique(),
    }) as ModelDef<any>;
    const ddl = buildSchemaDDL({ big: Big } as any);
    const uq = ddl.find((s) => s.kind === 'unique')!;
    expect(uq.name.length).toBeLessThanOrEqual(60);
    expect(uq.name.startsWith('forge_')).toBe(true);
  });
});

describe('PG DDL — emission order', () => {
  it('all CREATE TABLE statements precede any constraint / index statements', () => {
    const ddl = buildSchemaDDL(SCHEMA);
    const lastTableIdx = ddl.map((s) => s.kind).lastIndexOf('table');
    const firstConstraintIdx = ddl.findIndex((s) => s.kind !== 'table');
    expect(firstConstraintIdx).toBeGreaterThan(lastTableIdx);
  });
});
