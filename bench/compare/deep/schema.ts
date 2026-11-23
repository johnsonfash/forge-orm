// The relational benchmark schema shared by every engine. forge owns it: its
// DDL creates the tables on every SQL dialect and its $migrate builds the Mongo
// indexes. The Prisma, Drizzle, Kysely and Knex definitions only describe these
// tables, they never create them.
//
// Ids are caller-supplied strings (zero-padded, so lexical order = numeric
// order). Deterministic ids are what let every engine's result be compared
// row for row, including on Mongo where they are stored verbatim as _id.

import { f, model, rel } from "../../../src";

export const ROLES = ["USER", "EDITOR", "ADMIN"] as const;
export const STATUSES = ["DRAFT", "PUBLISHED", "ARCHIVED"] as const;

export interface Prefs { theme: "dark" | "light"; lang: "en" | "fr"; notify: boolean; score: number }
export interface Meta { lang: "en" | "fr"; score: number; flags: string[] }

export function buildSchema(opts: { geo: "native" | "fallback" | "none" }) {
  const User = model("users", {
    id: f.id({ type: "string" }),
    email: f.string().unique(),
    name: f.string(),
    role: f.enumOf(ROLES),
    active: f.bool(),
    created_at: f.dateTime(),
    prefs: f.json<Prefs>(),
  }, {
    indexes: [{ keys: { role: 1, active: 1, created_at: 1 } }],
  }).relate(() => ({
    profiles: rel.many("profile", { on: "user_id", refs: "id" }),
    posts: rel.many("post", { on: "author_id", refs: "id" }),
    comments: rel.many("comment", { on: "author_id", refs: "id" }),
  }));

  const Profile = model("profiles", {
    id: f.id({ type: "string" }),
    user_id: f.string().unique(),
    bio: f.text(),
  }).relate(() => ({
    user: rel.one("user", { on: "user_id", refs: "id", onDelete: "Cascade" }),
  }));

  const Post = model("posts", {
    id: f.id({ type: "string" }),
    author_id: f.string(),
    title: f.string(),
    body: f.text().searchable(),
    status: f.enumOf(STATUSES),
    views: f.int(),
    version: f.int(),
    published_at: f.dateTime().optional(),
    created_at: f.dateTime(),
    meta: f.json<Meta>(),
  }, {
    indexes: [
      { keys: { author_id: 1, status: 1 } },
      { keys: { status: 1, published_at: 1 } },
    ],
  }).relate(() => ({
    author: rel.one("user", { on: "author_id", refs: "id", onDelete: "Cascade" }),
    comments: rel.many("comment", { on: "post_id", refs: "id" }),
    post_tags: rel.many("postTag", { on: "post_id", refs: "id" }),
  }));

  const Comment = model("comments", {
    id: f.id({ type: "string" }),
    post_id: f.string(),
    author_id: f.string().optional(),
    parent_id: f.string().optional(),
    body: f.text(),
    created_at: f.dateTime(),
  }, {
    indexes: [{ keys: { post_id: 1 } }, { keys: { author_id: 1 } }, { keys: { parent_id: 1 } }],
  }).relate(() => ({
    post: rel.one("post", { on: "post_id", refs: "id", onDelete: "Cascade" }),
    author: rel.one("user", { on: "author_id", refs: "id", onDelete: "SetNull" }),
    parent: rel.one("comment", { on: "parent_id", refs: "id", onDelete: "NoAction" }),
    replies: rel.many("comment", { on: "parent_id", refs: "id" }),
  }));

  const Tag = model("tags", {
    id: f.id({ type: "string" }),
    name: f.string().unique(),
  }).relate(() => ({
    post_tags: rel.many("postTag", { on: "tag_id", refs: "id" }),
  }));

  const PostTag = model("post_tags", {
    id: f.id({ type: "string" }),
    post_id: f.string(),
    tag_id: f.string(),
  }, {
    uniques: [["post_id", "tag_id"]],
    indexes: [{ keys: { tag_id: 1 } }],
  }).relate(() => ({
    post: rel.one("post", { on: "post_id", refs: "id", onDelete: "Cascade" }),
    tag: rel.one("tag", { on: "tag_id", refs: "id", onDelete: "Cascade" }),
  }));

  const base = { user: User, profile: Profile, post: Post, comment: Comment, tag: Tag, postTag: PostTag };
  if (opts.geo === "none") return base as typeof base & { place?: never };

  const Place = model("places", {
    id: f.id({ type: "string" }),
    name: f.string(),
    location: opts.geo === "fallback" ? f.geoPoint({ fallback: true }) : f.geoPoint(),
  }, opts.geo === "fallback" ? {} : {
    indexes: [{ keys: { location: 1 }, method: "spatial", name: "idx_places_location" }],
  });
  return { ...base, place: Place };
}

export type BenchSchema = ReturnType<typeof buildSchema>;

// ─── Deterministic seed ─────────────────────────────────────────────────────

const pad = (n: number, w: number) => String(n).padStart(w, "0");
export const userId = (n: number) => `u_${pad(n, 6)}`;
export const postId = (n: number) => `p_${pad(n, 7)}`;
export const commentId = (n: number) => `c_${pad(n, 8)}`;
export const tagId = (n: number) => `t_${pad(n, 4)}`;

// Whole seconds only: MySQL DATETIME(3), SQLite text and Mongo dates all
// round-trip them exactly, so engines cannot disagree on a timestamp.
export const BASE_TIME = Date.UTC(2025, 0, 1, 0, 0, 0);
export const userCreated = (n: number) => new Date(BASE_TIME + n * 3_600_000);
export const postCreated = (n: number) => new Date(BASE_TIME + n * 600_000);

const FIRST = ["alice", "bob", "carol", "dave", "erin", "frank", "grace", "heidi", "ivan", "judy"];
const WORDS = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel", "india",
  "juliet", "kilo", "lima", "mike", "november", "oscar", "papa", "quebec", "romeo", "sierra", "tango"];

export interface SeedSizes { users: number; posts: number; comments: number; tags: number; places: number }

export function sizesFor(users: number): SeedSizes {
  return { users, posts: users * 10, comments: users * 50, tags: 50, places: Math.max(50, users) };
}

export const emailFor = (n: number) => `${FIRST[n % FIRST.length]}.${n}@bench.dev`;

export function seedUsers(s: SeedSizes) {
  return Array.from({ length: s.users }, (_, i) => {
    const n = i + 1;
    return {
      id: userId(n),
      email: emailFor(n),
      name: `${FIRST[n % FIRST.length][0].toUpperCase()}${FIRST[n % FIRST.length].slice(1)} User${n}`,
      role: ROLES[n % 3 === 0 ? 1 : n % 7 === 0 ? 2 : 0],
      active: n % 4 !== 0,
      created_at: userCreated(n),
      prefs: { theme: n % 3 === 0 ? "dark" : "light", lang: n % 5 === 0 ? "fr" : "en", notify: n % 2 === 0, score: n % 100 } as Prefs,
    };
  });
}

export function seedProfiles(s: SeedSizes) {
  const out = [];
  for (let n = 1; n <= s.users; n += 2) out.push({ id: `pr_${pad(n, 6)}`, user_id: userId(n), bio: `Bio of user ${n}` });
  return out;
}

// A user's posts: user n owns posts (n-1)*10+1 .. n*10. Users divisible by 11
// have only drafts, so `some/none/every` published each select a real subset.
export function seedPosts(s: SeedSizes) {
  const per = s.posts / s.users;
  return Array.from({ length: s.posts }, (_, i) => {
    const n = i + 1;
    const author = Math.floor(i / per) + 1;
    const status = author % 11 === 0 ? "DRAFT" : author % 13 === 0 ? "PUBLISHED" : STATUSES[n % 3];
    const words = [WORDS[n % 20], WORDS[(n * 7) % 20], WORDS[(n * 13) % 20], WORDS[(n * 3 + 1) % 20]];
    return {
      id: postId(n),
      author_id: userId(author),
      title: `Post ${n} about ${words[0]}`,
      body: `${words.join(" ")} ${words[1]} story number ${n}`,
      status,
      views: (n * 37) % 1000,
      version: 0,
      published_at: status === "PUBLISHED" ? postCreated(n) : null,
      created_at: postCreated(n),
      meta: { lang: n % 4 === 0 ? "fr" : "en", score: (n * 17) % 100, flags: n % 6 === 0 ? ["featured"] : [] } as Meta,
    };
  });
}

export function seedComments(s: SeedSizes) {
  return Array.from({ length: s.comments }, (_, i) => {
    const n = i + 1;
    const post = Math.floor(i / (s.comments / s.posts)) + 1;
    const first = Math.floor(i / (s.comments / s.posts)) * (s.comments / s.posts) + 1;
    return {
      id: commentId(n),
      post_id: postId(post),
      author_id: n % 9 === 0 ? null : userId(((n * 31) % s.users) + 1),
      parent_id: n === first ? null : commentId(first),
      body: `Comment ${n} on post ${post}`,
      created_at: new Date(postCreated(post).getTime() + (n - first + 1) * 1000),
    };
  });
}

export function seedTags(s: SeedSizes) {
  return Array.from({ length: s.tags }, (_, i) => ({ id: tagId(i + 1), name: `tag-${pad(i + 1, 3)}` }));
}

export function seedPostTags(s: SeedSizes) {
  const out: { id: string; post_id: string; tag_id: string }[] = [];
  for (let n = 1; n <= s.posts; n++) {
    const k = n % 4;
    const seen = new Set<number>();
    for (let j = 0; j < k; j++) {
      const t = ((n * (j + 3)) % s.tags) + 1;
      if (seen.has(t)) continue;
      seen.add(t);
      out.push({ id: `pt_${pad(n, 7)}_${j}`, post_id: postId(n), tag_id: tagId(t) });
    }
  }
  return out;
}

// Around Ouagadougou-sized coordinates; any fixed point set works.
export const GEO_CENTER = { lng: -1.5285, lat: 12.367 };
export function seedPlaces(s: SeedSizes) {
  return Array.from({ length: s.places }, (_, i) => {
    const n = i + 1;
    return {
      id: `pl_${pad(n, 6)}`,
      name: `Place ${n}`,
      location: {
        lng: +(GEO_CENTER.lng + (((n * 7919) % 2000) - 1000) / 10000).toFixed(6),
        lat: +(GEO_CENTER.lat + (((n * 104729) % 2000) - 1000) / 10000).toFixed(6),
      },
    };
  });
}
