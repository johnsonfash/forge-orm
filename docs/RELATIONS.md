# Relations

The README's [Relations](../README.md#relations) section is the surface
tour: two helpers (`rel.one`, `rel.many`), three options (`on`, `refs`,
`onDelete`), and a worked author-post example. This document goes deeper —
every shape forge supports, every cascade action, how includes plan, how
filters traverse relations, how nested writes order themselves, and six
worked patterns lifted from real schemas.

Forge's relation surface is deliberately Prisma-shaped. If you've written
Prisma schemas before, the mental model carries over. The differences live
in two places: forge uses **string keys** rather than type references to
point at related models (so cycles don't collapse the inference graph to
`any`), and forge runs on **six dialects** — five SQL plus Mongo — so
"foreign key" means something slightly different in each.

## Contents

* [Four relation shapes](#four-relation-shapes)
* [The `on` and `refs` columns](#the-on-and-refs-columns)
* [Cascade rules](#cascade-rules)
* [Inverse relations](#inverse-relations)
* [Join tables for many-to-many](#join-tables-for-many-to-many)
* [Self-referential relations](#self-referential-relations)
* [Polymorphic relations (two patterns)](#polymorphic-relations-two-patterns)
* [Deep includes](#deep-includes)
* [`select` inside `include`](#select-inside-include)
* [Filtering by a relation](#filtering-by-a-relation)
* [Counting and aggregating relations](#counting-and-aggregating-relations)
* [Writing through relations](#writing-through-relations)
* [Six worked patterns](#six-worked-patterns)
* [Cascade gotchas](#cascade-gotchas)
* [Performance and the `.compile` escape hatch](#performance-and-the-compile-escape-hatch)

---

## Four relation shapes

Every relation in forge is built from two primitives: `rel.one` (the side
that **owns the foreign key**) and `rel.many` (the inverse, virtual, list
side). The four classic shapes fall out of how you combine them.

### One-to-many (a user has many posts)

```ts
import { f, model, rel } from 'forge-orm';

const User = model('users', {
  id:   f.id(),
  name: f.string(),
}).relate(() => ({
  posts: rel.many('post', { on: 'author_id', refs: 'id' }),
}));

const Post = model('posts', {
  id:        f.id(),
  author_id: f.objectId(),
  title:     f.string(),
}).relate(() => ({
  author: rel.one('user', { on: 'author_id', refs: 'id' }),
}));
```

The `Post.author` side **owns** the relation — its row physically stores
`author_id`. The `User.posts` side is **virtual** — nothing is stored on
the user row; forge hydrates the list by querying posts with a matching
`author_id`.

### Many-to-one (a post belongs to one user)

The inverse direction of the same relation, no extra declaration needed.
The owning side is whichever side stores the FK column, and `rel.one` on
that side always wins.

### Many-to-many (a post has many tags, a tag is on many posts)

Forge does not synthesise a hidden join table for you. Declare one
explicitly and put `rel.one` on it pointing at both sides. See
[Join tables for many-to-many](#join-tables-for-many-to-many) for the
worked example.

### One-to-one (a user has one profile)

```ts
const User = model('users', {
  id: f.id(),
}).relate(() => ({
  profile: rel.one('profile', { on: 'id', refs: 'user_id' }),
  // or: profile: rel.many('profile', { on: 'id', refs: 'user_id' }),
  //     then take[0] in code — see notes below
}));

const Profile = model('profiles', {
  id:      f.id(),
  user_id: f.objectId().unique(),                // the unique is what makes it 1-1
  bio:     f.text(),
}).relate(() => ({
  user: rel.one('user', { on: 'user_id', refs: 'id', onDelete: 'Cascade' }),
}));
```

The `user_id.unique()` is what enforces "at most one profile per user."
Without that unique, a misbehaving migration could insert two profiles
pointing at the same user and the `User.profile` side would silently
return whichever one the executor sees first.

If you declare `User.profile` as `rel.one`, forge will still issue a
`findMany` under the hood and pull the first row — there's no separate
"has-one" planner. Most teams declare the inverse as `rel.many` and read
`profile[0]`, which is the same physical query without the false promise
of singleton semantics in the type.

---

## The `on` and `refs` columns

`on` is the column on **this model** that holds the foreign key value.
`refs` is the column on the **target** model that it points at.

```ts
// On Post:
author: rel.one('user', { on: 'author_id', refs: 'id' });
//                              ^^^^^^^^^         ^^^^
//                              column on posts    column on users
```

The convention forge follows is straightforward: name the FK column
`<target>_id`, point it at the target's `id`, and declare `f.objectId()`
on the column. `f.objectId()` is the right type for a foreign key column
on **every** dialect — it stores an `ObjectId` on Mongo and a plain text
column on the five SQL dialects, matching the string id that
[`f.id()`](../README.md#models-and-automatic-values-id-timestamps)
produces.

If you opt into a different primary-key strategy via
[`f.id({ type })`](../README.md#picking-a-primary-key-strategy), match the
FK column to it:

```ts
// Numeric autoincrement parent:
const Org = model('orgs', { id: f.id({ type: 'bigserial' }) });
const Member = model('members', {
  id:     f.id(),
  org_id: f.int(),                              // not f.objectId() — numeric FK
}).relate(() => ({
  org: rel.one('org', { on: 'org_id', refs: 'id' }),
}));
```

`refs` doesn't have to be `id`. Any column with a unique constraint can be
the referenced side:

```ts
const User = model('users', {
  id:    f.id(),
  email: f.string().unique(),                   // unique → safe to reference
});

const Invitation = model('invitations', {
  id:    f.id(),
  to:    f.string(),
}).relate(() => ({
  user: rel.one('user', { on: 'to', refs: 'email' }),
}));
```

The unique on `email` is load-bearing: without it, the relation could
match multiple users for a single invitation and the include would error.
On SQL dialects forge will emit a foreign-key constraint pointing at
`users(email)`, which requires the unique to exist before the FK can be
added — `forge push` orders DDL accordingly.

---

## Cascade rules

The `onDelete` option on the **owning side** controls what happens to the
owning row when the row it points at is deleted. The four Prisma-shaped
actions are all supported:

| Action       | Effect on this row when the target row is deleted |
|--------------|---------------------------------------------------|
| `Cascade`    | Delete this row too                               |
| `SetNull`    | Set the FK column to `NULL` on this row           |
| `Restrict`   | Block the delete if any owning row references it  |
| `NoAction`   | Defer to the database default (default behaviour) |

`onDelete` is only meaningful on `rel.one` — the side that stores the FK.
Setting it on a `rel.many` is silently ignored.

### Per-dialect emit

On the five SQL dialects, forge generates the FK constraint as part of
`CREATE TABLE` / `forge push` and leaves enforcement to the database
engine. The Mongo path has no FK concept; forge walks the relations
application-side at delete time.

| Dialect  | Emit                                                              |
|----------|-------------------------------------------------------------------|
| Postgres | `FOREIGN KEY (author_id) REFERENCES users(id) ON DELETE CASCADE`  |
| MySQL    | `FOREIGN KEY (author_id) REFERENCES users(id) ON DELETE CASCADE`  |
| SQLite   | `FOREIGN KEY(author_id) REFERENCES users(id) ON DELETE CASCADE`   |
| DuckDB   | `FOREIGN KEY (author_id) REFERENCES users(id) ON DELETE CASCADE`  |
| MSSQL    | `FOREIGN KEY (author_id) REFERENCES users(id) ON DELETE CASCADE`  |
| Mongo    | No emit. Walked at delete time by the cascade walker.             |

SQLite requires `PRAGMA foreign_keys = ON` for FKs to fire; forge sets
that on every connection it opens.

### Worked examples per action

```ts
// Cascade — children die with the parent.
author: rel.one('user', { on: 'author_id', refs: 'id', onDelete: 'Cascade' });
await db.user.delete({ where: { id: 'u1' } });
// Every post with author_id = 'u1' is deleted in the same statement (SQL)
// or by the cascade walker (Mongo).

// SetNull — FK column must be nullable.
author_id: f.objectId().optional(),
author: rel.one('user', { on: 'author_id', refs: 'id', onDelete: 'SetNull' });
await db.user.delete({ where: { id: 'u1' } });
// Posts that used to point at u1 now have author_id = NULL.

// Restrict — hard guard against accidental orphans.
author: rel.one('user', { on: 'author_id', refs: 'id', onDelete: 'Restrict' });
await db.user.delete({ where: { id: 'u1' } });
// Throws on every SQL dialect if any post still points at u1.
// On Mongo, forge runs a precount and throws a matching error.
```

Declaring `SetNull` on a non-nullable FK is accepted at schema time, but
the database rejects the delete at runtime (Postgres raises `null value
… violates not-null constraint`). Make the FK column nullable when you
pick `SetNull`.

`NoAction` is the default when `onDelete` is omitted. On SQL it emits
`ON DELETE NO ACTION` — the deferred check fires at commit time, in
practice behaving like `Restrict`. Mongo treats `NoAction` as
"do nothing" and leaves orphans behind.

---

## Inverse relations

The README mentions an `inverse: true` flag. In current forge, you don't
set it by hand: `rel.many` always **auto-sets** `inverse: true` on the
returned `RelationInfo`, and `rel.one` is always the owning side. The
flag exists on the type so the cascade walker and the schema introspector
can tell the two sides apart at runtime.

What this means practically:

* **Cascade walks only follow owning sides.** The walker in
  `src/adapters/mongo/cascade.ts` skips any relation with `inverse: true`
  to avoid double-walking a one-to-many in both directions.
* **DDL is only emitted from the owning side.** If both ends declared an
  `rel.one`, forge would try to emit two FK constraints and the second
  would fail. Declaring `rel.many` on the inverse side is what tells
  forge "don't emit DDL for me — I'm a virtual list."

### The double-FK bug

If you forget which side owns the FK and declare `rel.one` on both ends,
you end up with two FK columns and two constraints pointing at each
other:

```ts
// WRONG — both sides own the relation
const User = model('users', { id: f.id(), profile_id: f.objectId() })
  .relate(() => ({ profile: rel.one('profile', { on: 'profile_id', refs: 'id' }) }));

const Profile = model('profiles', { id: f.id(), user_id: f.objectId() })
  .relate(() => ({ user: rel.one('user', { on: 'user_id', refs: 'id' }) }));
```

`forge push` will create both `users.profile_id` and `profiles.user_id`,
and the two FK constraints form a circular dependency that's painful to
seed. The fix is to pick a side: typically the **child** (the row whose
existence depends on the parent) owns the FK, and the **parent** declares
the inverse with `rel.many` even when the cardinality is one-to-one. See
[One-to-one](#one-to-one-a-user-has-one-profile) for the canonical shape.

---

## Join tables for many-to-many

Forge does not synthesise a hidden join table the way classic ORMs do. A
many-to-many is a first-class model with `rel.one` pointing at both
sides, plus a composite unique to keep duplicate edges out.

### Worked example — `Post ↔ Tag`

```ts
const Post = model('posts', {
  id:    f.id(),
  title: f.string(),
}).relate(() => ({
  tags: rel.many('postTag', { on: 'id', refs: 'post_id' }),
}));

const Tag = model('tags', {
  id:   f.id(),
  name: f.string().unique(),
}).relate(() => ({
  posts: rel.many('postTag', { on: 'id', refs: 'tag_id' }),
}));

const PostTag = model('post_tags', {
  id:      f.id(),
  post_id: f.objectId(),
  tag_id:  f.objectId(),
})
  .index({ name: 'post_tag_unique', fields: ['post_id', 'tag_id'], unique: true })
  .relate(() => ({
    post: rel.one('post', { on: 'post_id', refs: 'id', onDelete: 'Cascade' }),
    tag:  rel.one('tag',  { on: 'tag_id',  refs: 'id', onDelete: 'Cascade' }),
  }));
```

The composite unique on `(post_id, tag_id)` is what enforces "at most one
edge between this post and this tag." Without it, a retry that re-inserts
the same edge will silently double-count tag membership.

### Reading "posts and their tags"

To get the tag names off a post you traverse the join row in the
include:

```ts
const posts = await db.post.findMany({
  include: { tags: { include: { tag: true } } },
});
// posts[0].tags = [{ id, post_id, tag_id, tag: { id, name } }, ...]
```

If you'd rather not see the join row in the result shape, `select` the
nested tag field and project it client-side:

```ts
const rows = await db.post.findMany({
  select: { id: true, title: true, tags: { select: { tag: { select: { name: true } } } } },
});
const flat = rows.map(p => ({ ...p, tagNames: p.tags.map(t => t.tag.name) }));
```

### Cascade choice on the join model

The example above declares `onDelete: 'Cascade'` on both sides of the
join. That's almost always the right call: when a post is deleted, the
edges it owned should die with it; same for tags. The alternative —
`SetNull` — would orphan the join row, which has no useful meaning.

---

## Self-referential relations

A model can point at itself. The canonical shape is a tree: each row
optionally has a parent, and forge looks the children up by `parent_id`.

```ts
const Category = model('categories', {
  id:        f.id(),
  parent_id: f.objectId().optional(),
  name:      f.string(),
}).relate(() => ({
  parent:   rel.one('category',  { on: 'parent_id', refs: 'id' }),
  children: rel.many('category', { on: 'parent_id', refs: 'id' }),
}));
```

Forge accepts `'self'` as a synonym for the current schema key. Either
form works — use whichever reads better in context.

### Loading one level

`include` works the same as on any other relation:

```ts
await db.category.findFirst({
  where:   { id: 'cat-root' },
  include: { children: true },
});
```

### Loading the whole tree

**Forge does not auto-recurse.** Each `include` adds exactly one level of
joins to the plan; nesting `include: { children: { include: { children:
{ include: { children: true } } } } }` works but is bounded to whatever
depth you typed.

For an unbounded depth, two patterns work:

**Pattern A — manual breadth-first loop.** Pull one level at a time
until you stop finding rows:

```ts
async function loadTree(rootId: string) {
  const root = await db.category.findUnique({ where: { id: rootId } });
  if (!root) return null;
  const byParent = new Map<string, typeof root[]>();
  let frontier = [rootId];
  while (frontier.length) {
    const next = await db.category.findMany({ where: { parent_id: { in: frontier } } });
    if (!next.length) break;
    for (const row of next) {
      const list = byParent.get(row.parent_id!) ?? [];
      list.push(row);
      byParent.set(row.parent_id!, list);
    }
    frontier = next.map(r => r.id);
  }
  // attach children to each parent
  const attach = (n: any) => ({ ...n, children: (byParent.get(n.id) ?? []).map(attach) });
  return attach(root);
}
```

Two round trips on a shallow tree, log(N) on a deeper one. Use this when
the depth varies per row and you don't want to over-include.

**Pattern B — `WITH RECURSIVE` via `$queryRaw`.** When you need the whole
tree in one round trip and you're on a SQL dialect that supports CTEs
(Postgres, SQLite, DuckDB, MSSQL, MySQL 8+):

```ts
const rows = await db.$queryRaw<Array<{ id: string; parent_id: string; depth: number }>>`
  WITH RECURSIVE tree AS (
    SELECT id, parent_id, name, 0 AS depth
      FROM categories
     WHERE id = ${rootId}
    UNION ALL
    SELECT c.id, c.parent_id, c.name, t.depth + 1
      FROM categories c
      JOIN tree t ON c.parent_id = t.id
  )
  SELECT * FROM tree ORDER BY depth, id;
`;
```

See [docs/RAW-SQL.md](./RAW-SQL.md) for the tagged-template rules and
how parameters are bound. On Mongo, use `$graphLookup` via
`$runCommandRaw` for the same shape.

---

## Polymorphic relations (two patterns)

Forge has no native polymorphic relation. A single FK column can only
reference a single target table; there's no equivalent to Rails'
`belongs_to :commentable, polymorphic: true`. You build the same shape
out of primitives.

### Pattern A — Mongo discriminator with `embedMany`

When the polymorphic children belong to a single parent and never need to
be queried independently, embed them with a discriminator field:

```ts
const TextBlock  = () => embed('TextBlock',  { kind: f.string(), text: f.string() });
const ImageBlock = () => embed('ImageBlock', { kind: f.string(), url: f.string(), alt: f.string() });
const QuoteBlock = () => embed('QuoteBlock', { kind: f.string(), text: f.string(), source: f.string() });

const Page = model('pages', {
  id:     f.id(),
  blocks: f.embedMany('Block'),                  // union shape — discriminated on `kind`
});
```

The TS type is a union; you narrow on `kind` at the call site:

```ts
const page = await db.page.findFirst({ where: { id: 'p1' } });
for (const block of page.blocks) {
  if (block.kind === 'image') {
    // block is narrowed to ImageBlock here
  }
}
```

**Trade-offs.** Cheap reads, no joins, the children move with the
parent. But blocks aren't independently queryable ("find all pages with
an image block of URL X" is awkward — see
[JSON path queries](../README.md#json-path-queries) for the workable form
on Mongo and Postgres) and you can't put a unique constraint on a
discriminated field across all blocks.

### Pattern B — SQL multi-FK with `kind` discriminator

When the polymorphic children need to be queried independently or live in
their own tables, give the parent a nullable FK per possible target plus
a discriminator:

```ts
const Comment = model('comments', {
  id:           f.id(),
  body:         f.text(),
  target_kind:  f.string(),                     // 'post' | 'photo' | 'video'
  post_id:      f.objectId().optional(),
  photo_id:     f.objectId().optional(),
  video_id:     f.objectId().optional(),
})
  .index({ name: 'comment_target', fields: ['target_kind', 'post_id', 'photo_id', 'video_id'] })
  .relate(() => ({
    post:  rel.one('post',  { on: 'post_id',  refs: 'id', onDelete: 'Cascade' }),
    photo: rel.one('photo', { on: 'photo_id', refs: 'id', onDelete: 'Cascade' }),
    video: rel.one('video', { on: 'video_id', refs: 'id', onDelete: 'Cascade' }),
  }));
```

Reads:

```ts
const c = await db.comment.findFirst({
  where:   { id: 'c1' },
  include: { post: true, photo: true, video: true },
});
const parent = c.post ?? c.photo ?? c.video;     // exactly one is non-null
```

**Trade-offs.** Each child kind is a real FK with real cascade semantics,
and you can filter independently (`db.comment.findMany({ where: { post:
{ is: { author_id: 'u1' } } } })`). The cost is one nullable column per
possible target plus an app-level invariant that exactly one is set per
row. You can encode that invariant with a `CHECK` constraint on Postgres
or a partial unique index on the populated column.

**Rule of thumb.** Pattern A when the children are content (blocks of a
page, lines of an invoice) and the parent owns their lifecycle. Pattern B
when the children are first-class records (comments, reactions, audit
entries) and need their own indexes and policies.

---

## Deep includes

`include` takes either `true` (load the relation, all columns) or an
options object that can itself nest `include`:

```ts
const user = await db.user.findFirst({
  where: { id: 'u1' },
  include: {
    posts: {
      include: {
        author: { include: { profile: true } },
        comments: { include: { author: true } },
      },
    },
  },
});
```

### How forge plans the joins

On SQL dialects, each level of `include` is a separate query, not a
single mega-join. The IR builder issues a parent query, then one query
per included relation per parent batch, using `IN (...)` to fetch all
matching children at once. This is the **dataloader pattern** — N+1 is
collapsed to a constant number of round trips equal to the depth of the
`include` tree.

A three-level include like the one above runs:

1. Find users matching the where.
2. Find posts where `author_id IN (user.id, ...)`.
3. Find authors where `id IN (post.author_id, ...)` (degenerate — it's
   the user we already have, so the planner short-circuits when the IDs
   match).
4. Find profiles where `user_id IN (author.id, ...)`.
5. Find comments where `post_id IN (post.id, ...)`.
6. Find authors-of-comments where `id IN (comment.author_id, ...)`.

Six queries, regardless of how many users matched the first one. On
Mongo, forge uses `$lookup` for the immediate join and unwinds the result
into the same nested shape.

### N+1 risk

The dataloader plan is the cure for N+1 *inside* a single query. The
classic N+1 — looping over results and issuing a query per row — is
still possible if you don't include in the first place:

```ts
// WRONG — one query per user
const users = await db.user.findMany();
for (const u of users) {
  const posts = await db.post.findMany({ where: { author_id: u.id } });
}

// RIGHT — one query for users + one query for all their posts
const users = await db.user.findMany({ include: { posts: true } });
```

`include` is always cheaper than the loop. The only time to reach for a
manual JOIN via `$queryRaw` is when you need to **filter the parent by
an aggregate over the children** in a single round trip (see
[Performance and the `.compile` escape hatch](#performance-and-the-compile-escape-hatch)).

### Bounded children per parent

You can cap the included children with `take` and order them with
`orderBy`:

```ts
await db.user.findMany({
  include: {
    posts: { orderBy: { created_at: 'desc' }, take: 5 },
  },
});
```

The cap is applied **per parent**, which compiles on SQL to a windowed
subquery (`ROW_NUMBER() OVER (PARTITION BY author_id ORDER BY ...)`) and
on Mongo to a `$slice` inside the `$lookup` pipeline.

---

## `select` inside `include`

`select` and `include` are mutually exclusive at the top level, but you
can nest `select` **inside** an `include` to project the included
relation:

```ts
const slim = await db.user.findFirst({
  where: { id: 'u1' },
  include: {
    posts: {
      select: { id: true, title: true },        // only id + title come back per post
    },
  },
});
// slim.posts: Array<{ id: string; title: string }>
```

The return type narrows to match: TypeScript sees only the fields you
selected, the rest are gone from the inferred shape. This is the same
inference machine that powers top-level `select`; the type infrastructure
walks the `select` tree per `include` branch.

The reverse — `include` inside `select` — also works, because a top-level
`select` is fully shape-controlled:

```ts
const compact = await db.user.findFirst({
  select: {
    id:    true,
    email: true,
    posts: { select: { id: true, title: true } },
  },
});
// compact: { id; email; posts: Array<{ id; title }> }
```

See [docs/TYPES.md](./TYPES.md) for the type rules forge uses to flow
selections through nested relations.

---

## Filtering by a relation

`where` can traverse relations using four operators, mirroring Prisma's
shape:

| Operator | Relation kind | Meaning                                                     |
|----------|---------------|-------------------------------------------------------------|
| `is`     | `rel.one`     | The related row matches this where                          |
| `isNot`  | `rel.one`     | The related row exists but doesn't match, or doesn't exist  |
| `some`   | `rel.many`    | At least one related row matches                            |
| `every`  | `rel.many`    | Every related row matches (vacuously true if none)          |
| `none`   | `rel.many`    | No related row matches                                      |

```ts
// Posts whose author's email contains 'acme':
await db.post.findMany({
  where: { author: { is: { email: { contains: 'acme' } } } },
});

// Users with at least one published post:
await db.user.findMany({
  where: { posts: { some: { status: 'PUBLISHED' } } },
});

// Users every one of whose posts is published:
await db.user.findMany({
  where: { posts: { every: { status: 'PUBLISHED' } } },
});

// Users with no draft posts:
await db.user.findMany({
  where: { posts: { none: { status: 'DRAFT' } } },
});
```

### Per-dialect emit

On Postgres, MySQL, SQLite, DuckDB, and MSSQL, relation filters compile
to `EXISTS` (or `NOT EXISTS`) subqueries. The `every` operator compiles
to a double-negation — "no related row that doesn't match" — because that
shape correctly handles the vacuous-true case (a user with zero posts
satisfies `every`).

```sql
-- some
WHERE EXISTS (SELECT 1 FROM posts p WHERE p.author_id = u.id AND p.status = 'PUBLISHED')
-- every
WHERE NOT EXISTS (SELECT 1 FROM posts p WHERE p.author_id = u.id AND p.status <> 'PUBLISHED')
-- none
WHERE NOT EXISTS (SELECT 1 FROM posts p WHERE p.author_id = u.id AND p.status = 'DRAFT')
```

On Mongo, the same operators compile to a `$lookup` followed by a
`$match` on the lookup result's length or contents:

```js
// some
{ $lookup: { from: 'posts', localField: '_id', foreignField: 'author_id', as: '_posts' } }
{ $match: { _posts: { $elemMatch: { status: 'PUBLISHED' } } } }
```

The `every` and `none` variants similarly use `$not` plus `$elemMatch`.
Mongo executes the `$lookup` once per query, not per parent row.

### `isNot` is not "is missing"

`isNot` matches rows whose related row exists but doesn't match — it does
**not** match rows where the relation is absent. For "the related row is
missing entirely," check the FK column directly:

```ts
await db.post.findMany({ where: { author_id: null } });
```

This distinction matters when the FK column is nullable and you want
either-or semantics.

---

## Counting and aggregating relations

### `_count` in `include`

The README touches on this. The full shape:

```ts
const users = await db.user.findMany({
  include: {
    _count: { select: { posts: true, comments: true } },
  },
});
// users[0]._count: { posts: 5, comments: 12 }
```

Each entry in `_count.select` becomes a single column in the projection —
on SQL a correlated subquery `(SELECT COUNT(*) FROM posts WHERE
posts.author_id = users.id) AS _count_posts`, on Mongo a `$lookup`
followed by `$size`.

You can also count with a filter:

```ts
await db.user.findMany({
  include: {
    _count: {
      select: { posts: { where: { status: 'PUBLISHED' } } },
    },
  },
});
// users[0]._count.posts is now COUNT(*) WHERE status='PUBLISHED'
```

### Filtering on `_count`

You can filter the parent by the count of its children:

```ts
await db.user.findMany({
  where: { posts: { _count: { gt: 0 } } },              // users with ≥1 post
});

await db.user.findMany({
  where: { posts: { _count: { lt: 3 } } },              // users with fewer than 3 posts
});
```

On SQL this compiles to a `HAVING` clause if the planner already
introduced a `GROUP BY`, or to a correlated subquery in the `WHERE`
otherwise. On Mongo it routes through `$lookup` + `$expr`.

### Aggregating across a relation

For sums, averages, min, and max across a relation, use `aggregate` on
the child model with a parent filter, then merge the results
client-side — there is no single forge call that says "sum the orders of
every user." The reason is dialect parity: a correlated-aggregate
subquery would need different rewrites for each dialect and the Mongo
path would route through `$group`, all of which is easier to express
directly than to hide:

```ts
const totals = await db.order.groupBy({
  by:     ['user_id'],
  _sum:   { total: true },
  _count: { _all: true },
});
```

See [docs/QUERIES.md](./QUERIES.md) for the full `groupBy` surface.

---

## Writing through relations

`create`, `update`, and `upsert` all accept relation operations
alongside the row's own fields. The supported verbs:

| Verb              | One side | Many side | Meaning                                                         |
|-------------------|----------|-----------|-----------------------------------------------------------------|
| `create`          | yes      | yes       | Insert a new related row                                        |
| `createMany`      | —        | yes       | Insert a list of related rows                                   |
| `connect`         | yes      | yes       | Attach an existing row by its identifier                        |
| `connectOrCreate` | yes      | yes       | Find by where, otherwise create                                 |
| `disconnect`      | yes      | yes       | Clear the FK (one) or unlink specific rows (many)               |
| `set`             | —        | yes       | Replace the entire list — disconnect everything, then connect   |
| `update`          | yes      | yes       | Update the related row(s)                                       |
| `updateMany`      | —        | yes       | Update many related rows by where                               |
| `upsert`          | yes      | yes       | Update if found, otherwise create                               |
| `delete`          | yes      | yes       | Delete the related row(s)                                       |
| `deleteMany`      | —        | yes       | Delete many related rows by where                               |

### Worked example — nested `create`

```ts
const user = await db.user.create({
  data: {
    email: 'a@x.co',
    name:  'Alice',
    posts: {
      create: [
        { title: 'Hello',  body: 'first post' },
        { title: 'Second', body: 'another'    },
      ],
    },
  },
  include: { posts: true },
});
// user.posts: 2 freshly-created rows with author_id set to the new user's id
```

### Parent-first ordering

Forge always inserts the **parent first**, captures the parent's
generated id, and then writes the children with that id substituted into
the FK column. This means:

* You don't write `author_id` on the nested child — forge fills it in.
* The parent must succeed before any child runs. If the child insert
  fails, the rule that applies depends on whether you're in a
  transaction.

### Transaction guarantee on SQL, best-effort on Mongo

On the five SQL dialects, every nested write runs inside a single
transaction by default. A nested `create` that fails halfway rolls back
the parent and any siblings created so far. The behaviour matches
`db.$transaction(async tx => { ... })` — see
[docs/QUERIES.md](./QUERIES.md#transactions) for the surface.

On Mongo, forge doesn't open a multi-document transaction unless the
deployment is a replica set or sharded cluster. Without
transaction support the nested writes are **best-effort**: if the second
child fails after the first one was inserted, the first child stays
inserted. The cascade walker has no compensating "uncreate" pass.

If you need atomicity on Mongo, open a session and pass `txn` through
the call:

```ts
await db.$transaction(async (tx) => {
  await tx.user.create({
    data: {
      email: 'a@x.co',
      posts: { create: [{ title: 'A' }, { title: 'B' }] },
    },
  });
});
```

This is a no-op on standalone Mongo; on a replica set it pins a session
and the nested writes are committed together or not at all.

### `connect`, `disconnect`, `set`, `connectOrCreate`

```ts
// Attach an existing post:
await db.user.update({ where: { id: 'u1' }, data: { posts: { connect: { id: 'p1' } } } });

// Detach a post (clear its author_id):
await db.user.update({ where: { id: 'u1' }, data: { posts: { disconnect: { id: 'p1' } } } });

// Replace the entire list — anything not in the new set is disconnected:
await db.user.update({ where: { id: 'u1' }, data: { posts: { set: [{ id: 'p1' }, { id: 'p2' }] } } });

// Tagging by name — create the tag if it doesn't already exist:
await db.post.update({
  where: { id: 'p1' },
  data: { tags: { connectOrCreate: [
    { where: { name: 'forge' }, create: { name: 'forge' } },
    { where: { name: 'orm'   }, create: { name: 'orm'   } },
  ]}},
});
```

`set` is the bluntest verb — it compiles to "diff current vs. new,
disconnect removed, connect added," in a transaction on SQL and
sequentially on Mongo. Prefer `connect`+`disconnect` when the caller
already knows what changed; reach for `set` only when the client owns
the full membership list.

`connectOrCreate` runs the `where` lookup first; only misses fall
through to `create`. On SQL it's a `SELECT` + conditional `INSERT`
ordered to avoid double-creating under concurrent writes (the atomic
upsert path covered in [the README](../README.md#writing-data)).

---

## Six worked patterns

The examples so far have been small. These six are real shapes lifted
from production schemas, each picked because it tests a different
corner of the relation surface.

### (a) Blog with users, posts, tags, and comments

The canonical CRUD shape: one-to-many for authorship, many-to-many for
tagging, self-referential for threaded comments. `Post` and `PostTag`
follow the join-table shape from
[Join tables for many-to-many](#join-tables-for-many-to-many);
`Comment.parent`/`Comment.replies` is the self-referential shape from
[Self-referential relations](#self-referential-relations).

```ts
const User = model('users', { id: f.id(), email: f.string().unique(), name: f.string() })
  .relate(() => ({
    posts:    rel.many('post',    { on: 'author_id', refs: 'id' }),
    comments: rel.many('comment', { on: 'author_id', refs: 'id' }),
  }));

const Post = model('posts', {
  id: f.id(), author_id: f.objectId(), title: f.string(), body: f.text(),
  status: f.enum(['DRAFT', 'PUBLISHED']).default('DRAFT'),
}).relate(() => ({
  author:   rel.one('user',     { on: 'author_id', refs: 'id', onDelete: 'Cascade' }),
  comments: rel.many('comment', { on: 'post_id',   refs: 'id' }),
  tags:     rel.many('postTag', { on: 'id',        refs: 'post_id' }),
}));

const Comment = model('comments', {
  id: f.id(), post_id: f.objectId(), author_id: f.objectId(),
  parent_id: f.objectId().optional(), body: f.text(),
}).relate(() => ({
  post:    rel.one('post',     { on: 'post_id',   refs: 'id', onDelete: 'Cascade' }),
  author:  rel.one('user',     { on: 'author_id', refs: 'id', onDelete: 'Cascade' }),
  parent:  rel.one('comment',  { on: 'parent_id', refs: 'id' }),
  replies: rel.many('comment', { on: 'parent_id', refs: 'id' }),
}));
```

"Show me this post with its author, top-level comments, and replies" in
one include tree:

```ts
await db.post.findFirst({
  where: { id: 'p1' },
  include: {
    author:   { select: { id: true, name: true } },
    tags:     { include: { tag: true } },
    comments: {
      where:   { parent_id: null },
      orderBy: { created_at: 'asc' },
      include: { author: true, replies: { include: { author: true } } },
    },
  },
});
```

### (b) Org → users → roles via a permissions join

The "user has many roles in many orgs" shape — three-way join with a
payload (`invited_at`). The unique on `(org_id, user_id, role_id)`
prevents duplicate grants.

```ts
const Membership = model('memberships', {
  id: f.id(), org_id: f.objectId(), user_id: f.objectId(), role_id: f.objectId(),
  invited_at: f.dateTime().default('now'),
})
  .index({ name: 'mem_org_user_role', fields: ['org_id', 'user_id', 'role_id'], unique: true })
  .relate(() => ({
    org:  rel.one('org',  { on: 'org_id',  refs: 'id', onDelete: 'Cascade' }),
    user: rel.one('user', { on: 'user_id', refs: 'id', onDelete: 'Cascade' }),
    role: rel.one('role', { on: 'role_id', refs: 'id', onDelete: 'Restrict' }),
  }));
// Org, User, and Role each declare `memberships: rel.many('membership', ...)`
// on the matching id.
```

`onDelete: 'Restrict'` on the role side is deliberate: deleting a role
that's still assigned to anyone should be a hard error, not a silent
mass-revocation. Org and user deletes cascade through their memberships;
role deletes block until every membership using them is gone.

### (c) BOM — recursive product composition

A bill of materials is a tree where products are composed of other
products: self-referential many-to-many with a quantity payload.

```ts
const Bom = model('bom', {
  id: f.id(), parent_id: f.objectId(), child_id: f.objectId(),
  quantity: f.decimal({ scale: 4 }),
})
  .index({ name: 'bom_unique', fields: ['parent_id', 'child_id'], unique: true })
  .relate(() => ({
    parent: rel.one('product', { on: 'parent_id', refs: 'id', onDelete: 'Cascade' }),
    child:  rel.one('product', { on: 'child_id',  refs: 'id', onDelete: 'Restrict' }),
  }));
// Product declares: components: rel.many('bom', { on: 'id', refs: 'parent_id' })
//                   partOf:     rel.many('bom', { on: 'id', refs: 'child_id' })
```

`Restrict` on the child side stops you deleting a product still used
as a component elsewhere. The full recursive expansion ("what raw
materials does this product depend on, at what quantity?") routes
through the `WITH RECURSIVE` pattern from
[Self-referential relations](#self-referential-relations).

### (d) Discriminated content blocks (polymorphic)

A CMS where a page is composed of typed blocks. Pattern A (Mongo
discriminator with `embedMany`) from the polymorphic section, made
concrete:

```ts
const PageBlock = () => embed('PageBlock', {
  kind:     f.string(),                       // 'text' | 'image' | 'embed' | 'quote'
  position: f.int(),
  text:     f.string().optional(),
  url:      f.string().optional(),
  alt:      f.string().optional(),
  caption:  f.string().optional(),
  source:   f.string().optional(),
});

const Page = model('pages', {
  id:     f.id(),
  slug:   f.string().unique(),
  title:  f.string(),
  blocks: f.embedMany(PageBlock).default([]),
});
```

Writes are a single document:

```ts
await db.page.create({
  data: {
    slug:  'about',
    title: 'About us',
    blocks: [
      { kind: 'text',  position: 0, text: 'Welcome.' },
      { kind: 'image', position: 1, url: '/hero.jpg', alt: 'team' },
      { kind: 'quote', position: 2, text: 'We build', source: 'Bret' },
    ],
  },
});
```

Reads come back fully formed; narrowing on `kind` at render time is the
client's job. On Postgres / SQLite / DuckDB, `embedMany` stores as JSON
and the same `path` operator from
[JSON path queries](../README.md#json-path-queries) gives you partial
read access without unpacking the whole array.

### (e) Marketplace — one user, many orders, many items

Two layers of one-to-many with cascades chosen per layer: deleting a
user `SetNull`s the buyer (audit-safe orphan), deleting an order
`Cascade`s its line items (no independent meaning).

```ts
const Order = model('orders', {
  id: f.id(), buyer_id: f.objectId().optional(),
  total: f.decimal({ scale: 2 }),
  status: f.enum(['PLACED', 'PAID', 'SHIPPED', 'CANCELLED']),
  deleted_at: f.dateTime().optional(),
})
  .softDelete()
  .relate(() => ({
    buyer: rel.one('user', { on: 'buyer_id', refs: 'id', onDelete: 'SetNull' }),
    items: rel.many('orderItem', { on: 'id', refs: 'order_id' }),
  }));

const OrderItem = model('order_items', {
  id: f.id(), order_id: f.objectId(),
  sku: f.string(), quantity: f.int(), unit_price: f.decimal({ scale: 2 }),
}).relate(() => ({
  order: rel.one('order', { on: 'order_id', refs: 'id', onDelete: 'Cascade' }),
}));
```

`.softDelete()` on Order means `db.order.delete` flips `deleted_at`
rather than removing the row; the cascade to items only fires on
`db.order.deleteHard`. See [soft delete](../README.md#soft-delete).

### (f) Multi-tenant SaaS scoped by `orgId`

Every tenant-scoped row carries an `org_id` FK and every query filters
by it. Forge has no native tenant-scope hook; the pattern is small
enough to wrap as a helper.

```ts
const User = model('users', { id: f.id(), org_id: f.objectId(), email: f.string() })
  .index({ name: 'user_email_per_org', fields: ['org_id', 'email'], unique: true })
  .relate(() => ({
    org: rel.one('org', { on: 'org_id', refs: 'id', onDelete: 'Cascade' }),
  }));

function scoped(orgId: string) {
  return {
    user: {
      findMany:  (q: any = {}) => db.user.findMany({ ...q, where: { ...q.where, org_id: orgId } }),
      findFirst: (q: any = {}) => db.user.findFirst({ ...q, where: { ...q.where, org_id: orgId } }),
      create:    (q: any)      => db.user.create({ ...q, data: { ...q.data, org_id: orgId } }),
      // ...same for update, delete, upsert
    },
  };
}

const scopedDb = scoped('org-1');
await scopedDb.user.findMany();                  // implicitly WHERE org_id = 'org-1'
```

The unique on `(org_id, email)` is what makes "email is unique per
tenant" enforceable at the database — without it the scoping is purely
advisory. Switch the cascade to `Restrict` if you want accidental
tenant deletion to be a hard error rather than a mass cascade.

---

## Cascade gotchas

### Mongo has no native FK enforcement

Every other section in this document treats `onDelete` as if it's
enforced by the database. On Mongo, it isn't. The cascade walker in
`src/adapters/mongo/cascade.ts` runs application-side every time you
call `db.x.delete` or `db.x.deleteMany`. The walk:

1. Inspects the schema for every relation pointing at the model you're
   deleting.
2. Skips inverse-side relations (the virtual `rel.many` list) — only
   owning sides drive a cascade.
3. For each owning relation with `onDelete: 'Cascade'`, recursively
   deletes the matching child rows.
4. For each with `onDelete: 'SetNull'`, updates the children's FK to
   `null`.
5. Carries a `visited` set across the recursion to break cycles
   (self-referential relations with `Cascade` would otherwise spin).

The walk is best-effort: if the second cascade level fails after the
first one succeeded, the partial state is left behind. Wrapping the
delete in `db.$transaction` only helps on replica sets / sharded
clusters; standalone Mongo has no rollback.

### `Restrict` is the safe default for cross-tenant references

If a row crosses a tenant boundary — a billing record pointing at a
plan, a webhook pointing at an org — pick `Restrict` rather than
`Cascade`. A misclick that deletes a row the rest of the system depends
on shouldn't cascade silently; making the delete fail forces the caller
to deal with the references.

### `db.$transaction` survival on SQL

On Postgres, MySQL, SQLite, DuckDB, and MSSQL, the cascade is part of
the same statement that deletes the parent — the entire `DELETE` runs
atomically by definition. Wrapping the call in `db.$transaction` doesn't
change that; it only matters when you're issuing **multiple** deletes
and want all-or-nothing across them.

### Schema-driven cascade vs. raw SQL

`db.$executeRaw` does not run the cascade walker. If you delete rows
directly with raw SQL on Mongo, the children stay. On SQL the database's
own FK enforcement still fires (because it's set up via `forge push`),
so a raw delete on Postgres still cascades — but raw deletes on Mongo
need their own application-side cleanup.

### Soft-delete interaction

`softDelete()` on a model rewires the wrapper so `db.x.delete` only
flips the `deleted_at` column. The cascade walker doesn't fire on a soft
delete; children stay live with a parent they can no longer find via the
default query path. If you want a soft delete to soft-delete the
children too, either chain it manually or use `db.x.deleteHard` (which
does fire the cascade and runs the FK constraints).

---

## Performance and the `.compile` escape hatch

### When `include` is the right tool

For "fetch a row and its dependents," `include` is almost always the
correct call. The dataloader plan keeps the round-trip count proportional
to the **depth** of the include, not the **breadth** of the result set.
A page that loads 50 users with their posts and tags is six queries —
the same as a page that loads 5 users with their posts and tags.

### When to drop to a manual JOIN

The case that `include` doesn't handle in one round trip is **filtering
the parent by a join'd aggregate** when you also want the join'd rows in
the result. For example: "users who have a published post in the last 7
days, ranked by total post count, with their three most recent posts."

That single query — filter by a computed property of the relation,
order by an aggregate over the relation, and project a windowed slice of
the relation — needs SQL. Run the parent query with `$queryRaw`:

```ts
const rows = await db.$queryRaw<Array<{ user_id: string; post_count: number }>>`
  SELECT u.id AS user_id, COUNT(p.id) AS post_count
    FROM users u
    JOIN posts p ON p.author_id = u.id
   WHERE p.status = 'PUBLISHED' AND p.created_at > NOW() - INTERVAL '7 days'
   GROUP BY u.id
   ORDER BY post_count DESC
   LIMIT 20;
`;

const posts = await db.post.findMany({
  where:   { author_id: { in: rows.map(r => r.user_id) }, status: 'PUBLISHED' },
  orderBy: { created_at: 'desc' },
  take:    60,                                  // 3 per user × 20 users — coarse cap
});
```

The two-query split keeps the type information forge gives you on the
second query while letting the first query express something the IR
can't yet plan. See [docs/RAW-SQL.md](./RAW-SQL.md) for the parameter
binding rules.

### The `.compile` escape hatch

Every method has a `.compile` variant that returns the SQL (or Mongo
pipeline) it would have run, without executing it. You can hand the
result to `$queryRaw` or `$runCommandRaw` to splice it into a bigger
statement:

```ts
const sub = db.post.compileSelect({
  where:   { status: 'PUBLISHED' },
  select:  { id: true, author_id: true, created_at: true },
});

const rows = await db.$queryRaw`
  SELECT u.name, p.title
    FROM users u
    JOIN (${sub.sql}) p ON p.author_id = u.id
   WHERE u.active = true;
`;
```

See [the README's `.compile` section](../README.md#dropping-to-raw-queries-with-compile)
for the full surface — every read and write verb has a `.compile`
counterpart, the IR builder runs but the executor is bypassed, and the
returned `{ sql, params }` is portable across the connection's dialect.

### Detecting N+1 in development

Forge emits a `query` event for every executed statement (see
[docs/QUERIES.md](./QUERIES.md) for the event surface). The simplest N+1
detector is a counter:

```ts
let count = 0;
db.$on('query', () => count++);

await handleRequest();
if (count > 10) console.warn(`high query count: ${count}`);
```

A handful of queries per request is normal. Hundreds usually means a
loop is running a query per row — the fix is almost always to lift the
loop into a single `include` or a single `groupBy`.
