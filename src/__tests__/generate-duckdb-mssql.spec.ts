import { f, model, rel } from '../schema/core';
import type { ModelDef } from '../schema/types';
import { generateMigration } from '../scripts/migrate-gen';

// `forge generate` / `forge diff apply` wrote NOTHING for DuckDB and SQL
// Server: the generator returned no changes, which `diff apply` reported as
// "already in sync". DuckDB is Postgres-shaped and is generated now; SQL
// Server is refused with what to do instead.

const Post = model('posts', {
  id: f.id({ type: 'uuid' }),
  title: f.string(),
  author_id: f.uuid(),
}).relate(() => ({
  author: rel.one('user', { on: 'author_id', refs: 'id' }),
})) as unknown as ModelDef<any>;
const User = model('users', { id: f.id({ type: 'uuid' }), email: f.string().unique() }) as unknown as ModelDef<any>;
const schema = { post: Post, user: User };
const empty = (kind: string) => ({ kind, tables: [], views: [] }) as never;

describe('generate: duckdb', () => {
  const pairs = generateMigration(schema, empty('duckdb'));
  const ups = pairs.map((p) => p.up);

  it('creates both tables in DuckDB types', () => {
    const creates = ups.filter((u) => u.startsWith('CREATE TABLE'));
    expect(creates).toHaveLength(2);
    expect(creates.join('\n')).toMatch(/"title" VARCHAR/i);
  });

  it('puts UNIQUE inside CREATE TABLE: DuckDB cannot ADD CONSTRAINT afterwards', () => {
    const users = ups.find((u) => u.startsWith('CREATE TABLE IF NOT EXISTS "users"'))!;
    expect(users).toMatch(/CONSTRAINT "[^"]+" UNIQUE \("email"\)\n\)$/);
    expect(ups.some((u) => /ADD CONSTRAINT .* UNIQUE/.test(u))).toBe(false);
  });

  it('writes a foreign key as a note: DuckDB has no ALTER TABLE ADD CONSTRAINT', () => {
    expect(ups.some((u) => /^ALTER TABLE .* FOREIGN KEY/.test(u))).toBe(false);
    expect(ups.some((u) => /^-- DuckDB cannot ALTER ADD FOREIGN KEY/.test(u))).toBe(true);
  });

  it('existing table: ADD COLUMN, ALTER COLUMN TYPE for a widening, RENAME COLUMN', () => {
    const P2 = model('posts', {
      id: f.id({ type: 'uuid' }),
      headline: f.string().renamedFrom('title'),
      author_id: f.uuid(),
      views: f.int().optional(),
    }) as unknown as ModelDef<any>;
    const actual = {
      kind: 'duckdb',
      views: [],
      tables: [{
        name: 'posts',
        columns: [
          { name: 'id', type: 'varchar', nullable: false },
          { name: 'title', type: 'varchar', nullable: false },
          { name: 'author_id', type: 'uuid', nullable: false },
        ],
        indexes: [],
        foreignKeys: [],
      }],
    } as never;
    const out = generateMigration({ post: P2 }, actual).map((p) => p.up);
    expect(out).toContain('ALTER TABLE "posts" RENAME COLUMN "title" TO "headline"');
    expect(out.some((u) => /^ALTER TABLE "posts" ADD COLUMN "views" INTEGER/i.test(u))).toBe(true);
  });
});

describe('generate: refused dialects', () => {
  it('mssql says why and what to do', () => {
    expect(() => generateMigration(schema, empty('mssql'))).toThrow(/does not generate SQL Server migrations[\s\S]*GO lines[\s\S]*forge migrate/);
  });

  it('mongo points at forge push', () => {
    expect(() => generateMigration(schema, empty('mongo'))).toThrow(/forge push/);
  });
});
