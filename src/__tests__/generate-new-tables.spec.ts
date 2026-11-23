// `forge generate` for tables the database does not have yet.
//
// Each new table's SQL used to be built from that ONE model on its own. A
// foreign key then could not look the other model up, so it fell back to the
// schema KEY: a relation to 'post' came out as REFERENCES "post" when the
// table is "posts", and the migration failed on apply. The keys were also
// emitted in schema order, so a key pointing at a table later in the schema
// referenced a table that did not exist yet.

import { f, model, rel } from '../schema/core';
import type { ModelDef } from '../schema/types';
import { generateMigration } from '../scripts/migrate-gen';

// The child comes FIRST in the schema, and every key differs from its table.
const Comment = model('blog_comments', {
  id: f.id({ type: 'uuid' }),
  post_id: f.uuid(),
  author_id: f.uuid().optional(),
}).relate(() => ({
  post: rel.one('blogPost', { on: 'post_id', refs: 'id', onDelete: 'Cascade' }),
  author: rel.one('blogUser', { on: 'author_id', refs: 'id', onDelete: 'SetNull' }),
})) as unknown as ModelDef<any>;

const Post = model('blog_posts', {
  id: f.id({ type: 'uuid' }),
  title: f.string(),
  subtitle: f.string().optional(),
}).relate(() => ({
  comments: rel.many('blogComment', { on: 'post_id', refs: 'id' }),
})) as unknown as ModelDef<any>;

const User = model('blog_users', { id: f.id({ type: 'uuid' }) }) as unknown as ModelDef<any>;

const schema = { blogComment: Comment, blogPost: Post, blogUser: User };
const empty = (kind: string) => ({ kind, tables: [] }) as never;

describe('generate: new tables (postgres)', () => {
  const ups = generateMigration(schema, empty('postgres')).map((p) => p.up);

  it('a foreign key references the physical table, not the schema key', () => {
    const fks = ups.filter((u) => u.includes('FOREIGN KEY'));
    expect(fks).toEqual([
      expect.stringContaining('REFERENCES "blog_posts" ("id") ON DELETE CASCADE'),
      expect.stringContaining('REFERENCES "blog_users" ("id") ON DELETE SET NULL'),
    ]);
    expect(ups.join('\n')).not.toMatch(/REFERENCES "blog(Post|User)"/);
  });

  it('every CREATE TABLE comes before the first foreign key', () => {
    const lastCreate = Math.max(...ups.map((u, i) => (u.startsWith('CREATE TABLE') ? i : -1)));
    const firstFk = ups.findIndex((u) => u.includes('FOREIGN KEY'));
    expect(firstFk).toBeGreaterThan(lastCreate);
  });

  it('does not repeat the columns CREATE TABLE already made', () => {
    expect(ups.some((u) => u.includes('ADD COLUMN IF NOT EXISTS'))).toBe(false);
    expect(ups.some((u) => u.includes('DROP NOT NULL'))).toBe(false);
    const create = ups.find((u) => u.startsWith('CREATE TABLE IF NOT EXISTS "blog_posts"'))!;
    expect(create).toMatch(/"title" text NOT NULL/);
    expect(create).toMatch(/"subtitle" text,/);
  });
});

// `forge generate` writes SQL for postgres, mysql and sqlite (Mongo has no DDL
// to version; DuckDB and MSSQL use push). The same schema must come out right
// on all three.
describe('generate: new tables (mysql)', () => {
  const ups = generateMigration(schema, empty('mysql')).map((p) => p.up);

  it('foreign keys reference the physical tables, after every CREATE TABLE', () => {
    const fks = ups.filter((u) => u.includes('FOREIGN KEY'));
    expect(fks).toHaveLength(2);
    expect(fks[0]).toContain('REFERENCES `blog_posts`');
    expect(fks[1]).toContain('REFERENCES `blog_users`');
    const lastCreate = Math.max(...ups.map((u, i) => (u.startsWith('CREATE TABLE') ? i : -1)));
    expect(ups.findIndex((u) => u.includes('FOREIGN KEY'))).toBeGreaterThan(lastCreate);
    expect(ups.join('\n')).not.toMatch(/blog(Post|User)/);
  });
});

describe('generate: new tables (sqlite)', () => {
  const ups = generateMigration(schema, empty('sqlite')).map((p) => p.up);

  it('the inline foreign keys reference the physical tables', () => {
    const create = ups.find((u) => /CREATE TABLE[^(]*"blog_comments"/.test(u))!;
    expect(create).toContain('REFERENCES "blog_posts"');
    expect(create).toContain('REFERENCES "blog_users"');
    expect(ups.join('\n')).not.toMatch(/blog(Post|User)/);
  });
});

describe('a bigserial id is an integer column', () => {
  it('diff does not call it text', async () => {
    const { fieldCategory } = await import('../scripts/diff-core');
    const Log = model('logs', { id: f.id({ type: 'bigserial' }) }) as unknown as ModelDef<any>;
    expect(fieldCategory(Log.fields.id as never)).toBe('bigint');
    expect(fieldCategory('id')).toBe('string');
  });
});
