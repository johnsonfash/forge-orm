// ============================================================================
// Sample schema — a multi-tenant blog/CMS domain, designed to exercise every
// feature the wrapper supports:
//
//   • enums (Role, PostStatus, LikeKind)
//   • embed (Address — fixed embedded composite type)
//   • embedMany (SocialLink, Revision — variable-length embedded list)
//   • per-field unique (User.email, Post.slug, Tag.name)
//   • composite @@unique (Like[user_id, post_id, kind], PostTag[post_id, tag_id])
//   • multi-column indexes ([author_id, status], [post_id, created_at])
//   • single-column index ([slug], [role])
//   • one-to-one via FK (User ↔ Profile)
//   • one-to-many (User → Posts → Comments)
//   • many-to-many via join (Post ↔ Tag through PostTag)
//   • self-referential (Comment.parent_id → Comment)
//   • cascade variants (Cascade / SetNull / NoAction)
//   • JSON field (AuditLog.payload, Post.meta)
//   • stringArray (Post.tag_names cached list)
//   • Optional / required fields, default(now()), default(literal), updatedAt
//
// Names are deliberately generic so anyone can read the schema as documentation.
// ============================================================================

import { rel as $rel, embed, enums, f, ModelRelations, RelationInfo } from './core';
import { model } from './core';
import { getActiveSchema, setActiveSchema, type SchemaShape } from './active';

const rel = $rel;

// ─── Enums ──────────────────────────────────────────────────────────────────

export const Role = enums(['USER', 'EDITOR', 'ADMIN'] as const);
export type Role = (typeof Role.values)[number];

export const PostStatus = enums(['DRAFT', 'PUBLISHED', 'ARCHIVED'] as const);
export type PostStatus = (typeof PostStatus.values)[number];

export const LikeKind = enums(['LIKE', 'BOOKMARK'] as const);
export type LikeKind = (typeof LikeKind.values)[number];

// ─── Composite (embedded) types ─────────────────────────────────────────────

export const AddressEmbed = () =>
  embed('Address', {
    street: f.string(),
    city: f.string(),
    zip: f.string(),
    country: f.string(),
  });

export const SocialLinkEmbed = () =>
  embed('SocialLink', {
    platform: f.string(),
    url: f.string(),
  });

export const RevisionEmbed = () =>
  embed('Revision', {
    title: f.string(),
    body: f.string(),
    edited_at: f.dateTime().default('now'),
  });

// ─── Models ─────────────────────────────────────────────────────────────────

export const User = model('users', {
  id: f.id(),
  email: f.string().unique(),
  name: f.string(),
  role: f.enumOf(Role.values).default('USER'),
  address: f.embed(AddressEmbed).optional(),
  active: f.bool().default(true),
  created_at: f.dateTime().default('now'),
  updated_at: f.dateTime().default('now').updatedAt(),
}, {
  indexes: [{ keys: { role: 1 } }],
}).relate(() => ({
  // Inverse-one: Profile.user_id is the actual FK (declared on Profile below).
  // We use rel.many here so it's clearly the inverse side; callers fetch
  // via `db.profile.findFirst({ where: { user_id } })` for the singleton.
  profiles: rel.many('profile', { on: 'user_id', refs: 'id' }),
  posts: rel.many('post', { on: 'author_id', refs: 'id' }),
  comments: rel.many('comment', { on: 'author_id', refs: 'id' }),
  likes: rel.many('like', { on: 'user_id', refs: 'id' }),
  audit_logs: rel.many('auditLog', { on: 'actor_id', refs: 'id' }),
}));

export const Profile = model('profiles', {
  id: f.id(),
  user_id: f.objectId().unique(),
  bio: f.text().optional(),
  avatar: f.string().optional(),
  social_links: f.embedMany(SocialLinkEmbed),
  created_at: f.dateTime().default('now'),
}).relate(() => ({
  user: rel.one('user', { on: 'user_id', refs: 'id', onDelete: 'Cascade' }),
}));

export const Post = model('posts', {
  id: f.id(),
  author_id: f.objectId(),
  title: f.string(),
  slug: f.string().unique(),
  body: f.text().searchable(),                       // searchable → auto-FTS index per dialect via forge:push
  status: f.enumOf(PostStatus.values).default('DRAFT'),
  tag_names: f.stringArray().optional(),
  view_count: f.int().default(0),
  meta: f.json().optional(),
  revisions: f.embedMany(RevisionEmbed),
  published_at: f.dateTime().optional(),
  created_at: f.dateTime().default('now'),
  updated_at: f.dateTime().default('now').updatedAt(),
}, {
  indexes: [
    { keys: { author_id: 1, status: 1 } },
    { keys: { slug: 1 } },
  ],
}).relate(() => ({
  author: rel.one('user', { on: 'author_id', refs: 'id', onDelete: 'Cascade' }),
  comments: rel.many('comment', { on: 'post_id', refs: 'id' }),
  likes: rel.many('like', { on: 'post_id', refs: 'id' }),
  post_tags: rel.many('postTag', { on: 'post_id', refs: 'id' }),
}));

export const Comment = model('comments', {
  id: f.id(),
  post_id: f.objectId(),
  author_id: f.objectId().optional(),
  parent_id: f.objectId().optional(),
  body: f.text(),                                    // unbounded comment body
  like_count: f.int().default(0),
  is_deleted: f.bool().default(false),
  created_at: f.dateTime().default('now'),
}, {
  indexes: [
    { keys: { post_id: 1, created_at: 1 } },
    { keys: { parent_id: 1 } },
  ],
}).relate(() => ({
  post: rel.one('post', { on: 'post_id', refs: 'id', onDelete: 'Cascade' }),
  author: rel.one('user', { on: 'author_id', refs: 'id', onDelete: 'SetNull' }),
  parent: rel.one('comment', { on: 'parent_id', refs: 'id', onDelete: 'NoAction' }),
  replies: rel.many('comment', { on: 'parent_id', refs: 'id' }),
}));

export const Tag = model('tags', {
  id: f.id(),
  name: f.string().unique(),
  description: f.text().optional(),
  created_at: f.dateTime().default('now'),
}).relate(() => ({
  post_tags: rel.many('postTag', { on: 'tag_id', refs: 'id' }),
}));

export const PostTag = model('post_tags', {
  id: f.id(),
  post_id: f.objectId(),
  tag_id: f.objectId(),
  created_at: f.dateTime().default('now'),
}, {
  uniques: [['post_id', 'tag_id']],
}).relate(() => ({
  post: rel.one('post', { on: 'post_id', refs: 'id', onDelete: 'Cascade' }),
  tag: rel.one('tag', { on: 'tag_id', refs: 'id', onDelete: 'Cascade' }),
}));

export const Like = model('likes', {
  id: f.id(),
  user_id: f.objectId(),
  post_id: f.objectId(),
  kind: f.enumOf(LikeKind.values).default('LIKE'),
  created_at: f.dateTime().default('now'),
}, {
  uniques: [['user_id', 'post_id', 'kind']],
}).relate(() => ({
  user: rel.one('user', { on: 'user_id', refs: 'id', onDelete: 'Cascade' }),
  post: rel.one('post', { on: 'post_id', refs: 'id', onDelete: 'Cascade' }),
}));

export const AuditLog = model('audit_logs', {
  id: f.id(),
  actor_id: f.objectId().optional(),
  event: f.string(),
  payload: f.json().optional(),
  created_at: f.dateTime().default('now'),
  deleted_at: f.dateTime().softDeleteAt(),  // soft-delete marker (Wave 4b)
}, {
  indexes: [{ keys: { actor_id: 1, created_at: -1 } }],
}).relate(() => ({
  actor: rel.one('user', { on: 'actor_id', refs: 'id', onDelete: 'SetNull' }),
}));

// Wave 4c — a read-only view over Post.
// `published_posts` exposes only PUBLISHED, non-soft-deleted posts. Writes
// against this model throw at the wrapper layer; reads work transparently.
export const PublishedPosts = model('published_posts', {
  id: f.id(),
  title: f.string(),
  slug: f.string(),
  author_id: f.objectId(),
  view_count: f.int(),
  published_at: f.dateTime().optional(),
}).asView({
  // SQL dialects: a parameter-free SELECT body. forge:push emits
  // `CREATE OR REPLACE VIEW published_posts AS <sql>`.
  sql: `SELECT id, title, slug, author_id, view_count, published_at FROM posts WHERE status = 'PUBLISHED'`,
  // Mongo equivalent: the aggregation pipeline that the view materialises.
  sourceCollection: 'posts',
  pipeline: [
    { $match: { status: 'PUBLISHED' } },
    { $project: { _id: 1, title: 1, slug: 1, author_id: 1, view_count: 1, published_at: 1 } },
  ],
});

// Wave 5d — a materialised view: per-author post rollups, recomputed on
// demand via `db.postStats.refresh()`. PG emits CREATE MATERIALIZED VIEW;
// MySQL/SQLite back it with a TABLE repopulated on refresh; Mongo populates a
// collection via the pipeline's $out. `post_count`/`total_views` use f.bigint()
// to also exercise the Wave 5e bigint type end-to-end.
export const PostStats = model('post_stats', {
  author_id: f.objectId(),
  post_count: f.bigint(),
  total_views: f.bigint(),
}).asView({
  materialised: true,
  sql: `SELECT author_id, COUNT(*) AS post_count, COALESCE(SUM(view_count), 0) AS total_views FROM posts GROUP BY author_id`,
  sourceCollection: 'posts',
  pipeline: [
    { $group: { _id: '$author_id', post_count: { $sum: 1 }, total_views: { $sum: '$view_count' } } },
    { $project: { _id: 0, author_id: '$_id', post_count: 1, total_views: 1 } },
    { $out: 'post_stats' },
  ],
});

// ─── Schema registry ────────────────────────────────────────────────────────
//
// `sampleSchema` is the bundled demonstration schema (a blog/CMS domain that
// exercises every feature). It is ALSO the default active schema, so forge
// works out of the box for the sample and the test suite.
//
// To use forge for YOUR domain, define your own `model(...)` map and pass it:
//   const db = await createDb({ url, schema: mySchema });
// forge then reads *your* models everywhere — nothing here is hardwired.
export const sampleSchema = {
  user: User,
  profile: Profile,
  post: Post,
  comment: Comment,
  tag: Tag,
  postTag: PostTag,
  like: Like,
  auditLog: AuditLog,
  publishedPosts: PublishedPosts,
  postStats: PostStats,
} as const;

// Default the active schema to the sample on module load.
setActiveSchema(sampleSchema as unknown as SchemaShape);

// `schema` is a LIVE VIEW of whichever schema is currently active (the sample
// by default; whatever `createDb({ schema })` set otherwise). The entire
// codebase reads models through this proxy, so consumer schemas flow in without
// threading a map through every function. It's typed as the sample `SchemaMap`
// for back-compat; per-consumer static typing flows through `ForgeDb<S>`.
export const schema: SchemaMap = new Proxy({} as SchemaMap, {
  get: (_t, k) => (getActiveSchema() as any)[k as any],
  has: (_t, k) => (k as any) in getActiveSchema(),
  ownKeys: () => Reflect.ownKeys(getActiveSchema() as object),
  getOwnPropertyDescriptor: (_t, k) => {
    const a = getActiveSchema() as any;
    if (!((k as any) in a)) return undefined;
    return { enumerable: true, configurable: true, writable: false, value: a[k as any] };
  },
});

// The sample schema's concrete shape — the default type when no consumer
// schema is supplied. Consumer schemas type through ForgeDb<S> generically.
export type SchemaMap = typeof sampleSchema;

// ─── Type-level relation-target validation ──────────────────────────────────

type AllRelationTargets<S> = {
  [K in keyof S]: ModelRelations<S[K]> extends infer R
    ? R extends Record<string, RelationInfo>
      ? { [RN in keyof R]: R[RN] extends RelationInfo<infer T, any> ? T : never }[keyof R]
      : never
    : never;
}[keyof S];

type _UnknownTargets = Exclude<AllRelationTargets<typeof schema>, keyof typeof schema>;

type _AssertSchemaIntegrity<E = _UnknownTargets> = [E] extends [never]
  ? true
  : `Relation target(s) not in schema map: ${E & string}`;

const _assertAllTargetsValid: _AssertSchemaIntegrity = true;
void _assertAllTargetsValid;
