// Foreign keys in a snapshot — the reason `forge generate` used to loop.
//
// `projectForeignKeys` read the relation's target from a field that does
// not exist on `RelationDef` (`model`, behind an `as` cast, where the real
// field is `target`). Every lookup resolved to `schema['']`, so no snapshot
// ever recorded a foreign key. The next `generate` therefore saw every FK
// as missing and re-emitted the same ADD CONSTRAINT — forever, failing with
// "already exists" on apply and never letting `--check` pass in CI.
//
// The property under test is convergence: a schema diffed against its own
// snapshot must generate nothing.

import { f, model, rel } from '../schema/core';
import type { ModelDef } from '../schema/types';
import { generateMigration } from '../scripts/migrate-gen';
import { projectSchema } from '../scripts/snapshot';

const Post = model('posts', {
  id: f.id(),
  author_id: f.objectId(),
  title: f.string(),
}).relate(() => ({
  author: rel.one('user', { on: 'author_id', refs: 'id', onDelete: 'Cascade' }),
})) as unknown as ModelDef<any>;

const User = model('users', {
  id: f.id(),
  email: f.string().unique(),
}).relate(() => ({
  posts: rel.many('post', { on: 'author_id', refs: 'id' }),
})) as unknown as ModelDef<any>;

const blog = { user: User, post: Post };

const fksOf = (snap: ReturnType<typeof projectSchema>, table: string) =>
  snap.tables.find((t) => t.name === table)!.foreignKeys;

describe('projectForeignKeys', () => {
  it('records the owning side, resolved through `target`', () => {
    const fks = fksOf(projectSchema(blog, 'postgres'), 'posts');
    expect(fks).toHaveLength(1);
    expect(fks[0]!.column).toBe('author_id');
    expect(fks[0]!.refTable).toBe('users');
    expect(fks[0]!.refColumn).toBe('id');
  });

  it('leaves the inverse side alone — it holds no column', () => {
    // `rel.many` is the hydrated "list" side of a one-to-many. The
    // constraint lives on `posts`, and claiming one on `users` would put a
    // foreign key in the snapshot that no database has.
    expect(fksOf(projectSchema(blog, 'postgres'), 'users')).toEqual([]);
  });

  it('skips a relation whose `on` is the primary key', () => {
    // The inverse side of a one-to-one: `users.id` is not a foreign key,
    // the other table carries it.
    const Profile = model('profiles', {
      id: f.id(),
      user_id: f.objectId(),
    }) as unknown as ModelDef<any>;
    const Owner = model('users', { id: f.id() }).relate(() => ({
      profile: rel.one('profile', { on: 'id', refs: 'user_id' }),
    })) as unknown as ModelDef<any>;
    const snap = projectSchema({ user: Owner, profile: Profile }, 'postgres');
    expect(fksOf(snap, 'users')).toEqual([]);
  });

  it('skips a relation pointing at a model that is not in the schema', () => {
    const snap = projectSchema({ post: Post }, 'postgres');
    expect(fksOf(snap, 'posts')).toEqual([]);
  });

  it('skips a relation whose `on` field is not declared', () => {
    const Orphan = model('orphans', { id: f.id() }).relate(() => ({
      owner: rel.one('user', { on: 'owner_id', refs: 'id' }),
    })) as unknown as ModelDef<any>;
    const snap = projectSchema({ user: User, orphan: Orphan }, 'postgres');
    expect(fksOf(snap, 'orphans')).toEqual([]);
  });

  it('emits none on mongo, which has no foreign keys', () => {
    const snap = projectSchema(blog, 'mongo');
    expect(fksOf(snap, 'posts')).toEqual([]);
  });
});

describe('generate converges on an unchanged schema', () => {
  it('a schema diffed against its own snapshot generates nothing', () => {
    const snap = projectSchema(blog, 'postgres');
    expect(generateMigration(blog as never, snap)).toEqual([]);
  });

  it('specifically, no ADD CONSTRAINT is re-emitted', () => {
    // This is what `--check` tripped over on every CI run.
    const snap = projectSchema(blog, 'postgres');
    const up = generateMigration(blog as never, snap).map((p) => p.up).join('\n');
    expect(up).not.toMatch(/ADD CONSTRAINT/i);
  });

  it('still emits the constraint against a database that lacks it', () => {
    const snap = projectSchema(blog, 'postgres');
    const withoutFk = {
      ...snap,
      tables: snap.tables.map((t) => ({ ...t, foreignKeys: [] })),
    };
    const up = generateMigration(blog as never, withoutFk).map((p) => p.up).join('\n');
    expect(up).toMatch(/ADD CONSTRAINT .* FOREIGN KEY \("author_id"\) REFERENCES "users"/);
  });
});
