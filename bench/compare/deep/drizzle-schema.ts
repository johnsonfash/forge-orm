// Drizzle's description of the deep-bench tables, per dialect. forge creates
// the tables; drizzle-kit is never run against them. Column types mirror what
// forge's DDL emits (see `npm run forge:bench:deep -- --dialect=X --capture-only`).

import { relations } from "drizzle-orm";
import { pgTable, text as pgText, boolean as pgBool, timestamp as pgTs, jsonb, integer as pgInt } from "drizzle-orm/pg-core";
import { mysqlTable, varchar, boolean as myBool, datetime, json as myJson, int as myInt, text as myText } from "drizzle-orm/mysql-core";
import { sqliteTable, text as sqText, integer as sqInt, customType } from "drizzle-orm/sqlite-core";

function withRelations<T extends Record<string, any>>(t: T) {
  const { users, profiles, posts, comments, tags, postTags } = t;
  return {
    ...t,
    usersRel: relations(users, ({ many, one }) => ({ posts: many(posts), comments: many(comments), profile: one(profiles) })),
    profilesRel: relations(profiles, ({ one }) => ({ user: one(users, { fields: [profiles.user_id], references: [users.id] }) })),
    postsRel: relations(posts, ({ one, many }) => ({
      author: one(users, { fields: [posts.author_id], references: [users.id] }),
      comments: many(comments), post_tags: many(postTags),
    })),
    commentsRel: relations(comments, ({ one }) => ({
      post: one(posts, { fields: [comments.post_id], references: [posts.id] }),
      author: one(users, { fields: [comments.author_id], references: [users.id] }),
    })),
    tagsRel: relations(tags, ({ many }) => ({ post_tags: many(postTags) })),
    postTagsRel: relations(postTags, ({ one }) => ({
      post: one(posts, { fields: [postTags.post_id], references: [posts.id] }),
      tag: one(tags, { fields: [postTags.tag_id], references: [tags.id] }),
    })),
  };
}

const pgT = (n: string) => pgTs(n, { withTimezone: true, mode: "date" });
export const pg = withRelations({
  users: pgTable("users", { id: pgText("id").primaryKey(), email: pgText("email").notNull(), name: pgText("name").notNull(), role: pgText("role").notNull(), active: pgBool("active").notNull(), created_at: pgT("created_at").notNull(), prefs: jsonb("prefs").notNull() }),
  profiles: pgTable("profiles", { id: pgText("id").primaryKey(), user_id: pgText("user_id").notNull(), bio: pgText("bio").notNull() }),
  posts: pgTable("posts", { id: pgText("id").primaryKey(), author_id: pgText("author_id").notNull(), title: pgText("title").notNull(), body: pgText("body").notNull(), status: pgText("status").notNull(), views: pgInt("views").notNull(), version: pgInt("version").notNull(), published_at: pgT("published_at"), created_at: pgT("created_at").notNull(), meta: jsonb("meta").notNull() }),
  comments: pgTable("comments", { id: pgText("id").primaryKey(), post_id: pgText("post_id").notNull(), author_id: pgText("author_id"), parent_id: pgText("parent_id"), body: pgText("body").notNull(), created_at: pgT("created_at").notNull() }),
  tags: pgTable("tags", { id: pgText("id").primaryKey(), name: pgText("name").notNull() }),
  postTags: pgTable("post_tags", { id: pgText("id").primaryKey(), post_id: pgText("post_id").notNull(), tag_id: pgText("tag_id").notNull() }),
});

const myS = (n: string) => varchar(n, { length: 255 });
const myD = (n: string) => datetime(n, { fsp: 3, mode: "date" });
export const mysql = withRelations({
  users: mysqlTable("users", { id: myS("id").primaryKey(), email: myS("email").notNull(), name: myS("name").notNull(), role: varchar("role", { length: 64 }).notNull(), active: myBool("active").notNull(), created_at: myD("created_at").notNull(), prefs: myJson("prefs").notNull() }),
  profiles: mysqlTable("profiles", { id: myS("id").primaryKey(), user_id: myS("user_id").notNull(), bio: myText("bio").notNull() }),
  posts: mysqlTable("posts", { id: myS("id").primaryKey(), author_id: myS("author_id").notNull(), title: myS("title").notNull(), body: myText("body").notNull(), status: varchar("status", { length: 64 }).notNull(), views: myInt("views").notNull(), version: myInt("version").notNull(), published_at: myD("published_at"), created_at: myD("created_at").notNull(), meta: myJson("meta").notNull() }),
  comments: mysqlTable("comments", { id: myS("id").primaryKey(), post_id: myS("post_id").notNull(), author_id: myS("author_id"), parent_id: myS("parent_id"), body: myText("body").notNull(), created_at: myD("created_at").notNull() }),
  tags: mysqlTable("tags", { id: myS("id").primaryKey(), name: myS("name").notNull() }),
  postTags: mysqlTable("post_tags", { id: myS("id").primaryKey(), post_id: myS("post_id").notNull(), tag_id: myS("tag_id").notNull() }),
});

// forge stores SQLite timestamps as ISO-8601 text, so Drizzle needs a custom
// column type to read and write that representation.
const isoDate = customType<{ data: Date; driverData: string }>({
  dataType: () => "text",
  toDriver: (d) => d.toISOString(),
  fromDriver: (s) => new Date(s),
});
export const sqlite = withRelations({
  users: sqliteTable("users", { id: sqText("id").primaryKey(), email: sqText("email").notNull(), name: sqText("name").notNull(), role: sqText("role").notNull(), active: sqInt("active", { mode: "boolean" }).notNull(), created_at: isoDate("created_at").notNull(), prefs: sqText("prefs", { mode: "json" }).notNull() }),
  profiles: sqliteTable("profiles", { id: sqText("id").primaryKey(), user_id: sqText("user_id").notNull(), bio: sqText("bio").notNull() }),
  posts: sqliteTable("posts", { id: sqText("id").primaryKey(), author_id: sqText("author_id").notNull(), title: sqText("title").notNull(), body: sqText("body").notNull(), status: sqText("status").notNull(), views: sqInt("views").notNull(), version: sqInt("version").notNull(), published_at: isoDate("published_at"), created_at: isoDate("created_at").notNull(), meta: sqText("meta", { mode: "json" }).notNull() }),
  comments: sqliteTable("comments", { id: sqText("id").primaryKey(), post_id: sqText("post_id").notNull(), author_id: sqText("author_id"), parent_id: sqText("parent_id"), body: sqText("body").notNull(), created_at: isoDate("created_at").notNull() }),
  tags: sqliteTable("tags", { id: sqText("id").primaryKey(), name: sqText("name").notNull() }),
  postTags: sqliteTable("post_tags", { id: sqText("id").primaryKey(), post_id: sqText("post_id").notNull(), tag_id: sqText("tag_id").notNull() }),
});
