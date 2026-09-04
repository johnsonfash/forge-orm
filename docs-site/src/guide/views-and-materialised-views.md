---
title: "Views and materialised views"
---

## Views and materialised views

Declare a read-only view with `.asView()`. Writes to it are rejected; reads work
normally.

```ts
const PublishedPosts = model('published_posts', {
  id: f.id(), title: f.string(), author_id: f.objectId(),
}).asView({
  sql: `SELECT id, title, author_id FROM posts WHERE status = 'PUBLISHED'`,
  sourceCollection: 'posts',   // Mongo equivalent
  pipeline: [{ $match: { status: 'PUBLISHED' } }],
});
```

Add `materialised: true` to store the results physically and refresh them on
demand. On Postgres this is a real materialised view; on MySQL, SQLite, DuckDB,
and MSSQL it is a table that gets repopulated; on Mongo it is a collection
filled by the pipeline.

```ts
const Stats = model('post_stats', { /* … */ }).asView({ materialised: true, sql, /* … */ });

await db.postStats.refresh();                    // recompute now
const stop = db.postStats.scheduleRefresh('1h'); // recompute hourly; call stop() to cancel
```

See more — **[docs/VIEWS.md](/reference/views)** (updatable rules, SECURITY_BARRIER, indexed views, Mongo collection views) and **[docs/MATERIALIZED-VIEWS.md](/reference/materialized-views)** (refresh strategies, `REFRESH MATERIALIZED VIEW CONCURRENTLY`, MSSQL indexed views, Mongo `$merge`/`$out`, per-dialect emulation for MySQL/SQLite).

---
