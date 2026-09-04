# IndexedDB adapter (browser, zero install) — full reference

Companion to the README's **[Browser (zero install) — IndexedDB](../README.md#browser-zero-install--indexeddb)** section. The README covers the one-paragraph pitch, the tradeoff vs sqlite-wasm, and a quickstart. This file is the full reference: URL schemes, what survives from the forge surface, per-feature semantics, the query planner's scoring model, migration behaviour, geo / vector / FTS / JSON-path fallback details, the transaction constraints, cascades, and the quota + Safari-eviction story.

For the sqlite-wasm alternative (real SQLite compiled to wasm, running in a Web Worker on OPFS), see **[docs/BROWSER.md](./BROWSER.md)**. For framework recipes, see **[docs/BROWSER-FRAMEWORKS.md](./BROWSER-FRAMEWORKS.md)**.

The IndexedDB adapter is forge's *zero-install* browser tier. It ships in `forge-orm/indexeddb`; no wasm, no worker, no bundler plugin, no COOP / COEP headers. Works in every browser that supports IndexedDB (i.e. every browser since 2017).

Use it when you want a persistent local database in the browser without downloading and hosting a ~1 MB wasm blob. Use the sqlite-wasm adapter (`forge-orm/wasm`) instead when you need real SQL, native geo indexing (R-Tree), sqlite-vec vector search, or the SQLite tooling ecosystem.

## Contents

* [Connecting](#connecting)
* [What survives from the forge-orm surface](#what-survives-from-the-forge-orm-surface)
* [What behaves differently vs SQLite](#what-behaves-differently-vs-sqlite)
* [The query planner](#the-query-planner)
* [Migrations](#migrations)
* [Full-text search](#full-text-search)
* [Geo](#geo)
* [Vector similarity](#vector-similarity)
* [JSON path queries](#json-path-queries)
* [Transactions](#transactions)
* [Cascades](#cascades)
* [Quota, persistence, and the Safari 7-day eviction](#quota-persistence-and-the-safari-7-day-eviction)
* [Server safety](#server-safety)
* [Compatibility matrix](#compatibility-matrix)

---

## Connecting

```ts
import { createDb } from 'forge-orm';
import { schema } from './schema';

const db = await createDb({ url: 'idb:appname', schema });
```

The URL prefix `idb:` (or the alias `indexeddb:`) selects the adapter and the string after the colon is the IndexedDB database name — this is what you'd pass to `indexedDB.open(name)` by hand.

Or drive it via the driver directly:

```ts
import { indexedDbDriver } from 'forge-orm/indexeddb';

const db = await createDb({
  driver: indexedDbDriver({ name: 'appname' }),
  schema,
});
```

Both forms route to the same adapter; the URL form is convenient when you already thread `DATABASE_URL` through your app, the driver form is what you reach for when you want to hand in a pre-opened `IDBDatabase` from your own bootstrap code.

## What survives from the forge-orm surface

Everything the Prisma-shape API exposes — reads, writes, relations, sorts, paging, aggregations, JSON path queries, geo `near` / `withinPolygon`, vector `near` / `nearTo`, full-text `search`, atomic update ops (`increment`, `multiply`, `push`, `unset`), `upsert`, soft-delete + restore, `.compile` escape hatch, `$transaction`, `$migrate`, `$doctor`, `$diff`.

A schema written for Postgres runs unchanged on the browser tier. No feature-flag gymnastics, no code paths that only exist in one runtime.

## What behaves differently vs SQLite

| Concern | SQLite (wasm) | IndexedDB |
|---|---|---|
| Install cost | ~1 MB wasm + worker + COOP/COEP | **zero** |
| Query language | real SQL | IR → cursor scans + JS predicates |
| Filtering | any expression | only indexed leaves get range scans; rest is a cursor scan + JS filter (fine at DB sizes ≤ 100 k rows) |
| Vector | native via sqlite-vec HNSW | brute-force JS cosine / L2 — fine at ≤ 1 k rows, slow beyond |
| Geo | R-Tree via SpatiaLite | Haversine JS + bbox prefilter via compound index |
| FTS | FTS5 with stemmed BM25 | multiEntry token index, AND-of-tokens |
| Transactions | full SQLite | IDB txns, auto-commit on task idle (see [Transactions](#transactions)) |
| Multi-tab | requires SAHPool VFS | **native** — IDB handles it |

## The query planner

Every read call runs the same pipeline:

```
Args → IR (WhereTree + OrderBy) → planner picks ONE index → cursor scan → JS residual filter → JS sort (if planner couldn't cover it) → limit/offset
```

### Selectivity scoring

The planner scores each candidate scan strategy and picks the highest. Scores are 0–100:

| Rank | Score | Example |
|---:|---:|---|
| 1 | 100 | primary-key `eq` — `where: { id: 'X' }` |
| 2 | 95 | full compound-index equality — `where: { org: 'A', status: 'active' }` on index `[org, status]` |
| 3 | 90 | unique-index single-column `eq` — `where: { email: 'x@y.co' }` |
| 4 | 85 | non-unique compound equality on all keys |
| 5 | 70 | non-unique single-column `eq` — `where: { status: 'draft' }` |
| 6 | 60 | `in` on indexed column — `where: { status: { in: [...] } }` |
| 7 | 50 | range op (`lt` / `lte` / `gt` / `gte` / `startsWith`) on indexed column |
| 8 | 20 | orderBy on indexed column with no where match (free sort) |
| 9 | 0 | full-table scan (no index applicable) |

The **residual predicate** is compiled from every leaf the range didn't absorb — a `(row) => boolean` closure applied to each cursor result.

### AND vs OR vs NOT

At the root: `AND` unlocks index optimisation (every child leaf is a candidate). `OR` and `NOT` at the root fall back to a full-table scan + residual predicate. A shipped v1 could union multiple index scans for OR; v0 keeps the code path single.

### Inspecting the plan

Every plan carries an `explain` string:

```ts
import { planSelect } from 'forge-orm/indexeddb';

console.log(planSelect(User, { type: 'leaf', field: 'age', op: 'eq', value: 30 }).explain);
// "eq on 'age'"
```

Feed it into a `$on('query')` handler when you want to watch which index each request lands on.

## Migrations

IndexedDB's native `onupgradeneeded` versioning maps cleanly to forge-orm's non-destructive migration model — better than SQL, in fact, because a lot of the primitives you'd hand-roll on SQL are built into IDB.

| Change | Behaviour on IDB |
|---|---|
| **Add a field** | No-op. IDB is schemaless — start writing it. |
| **Add an index** | `store.createIndex()` runs inside `onupgradeneeded`. IDB re-scans existing rows and back-populates the index automatically. |
| **Rename an index** | Runs as (drop, create) — same reindex behaviour. |
| **Drop an index** | `store.deleteIndex()`. |
| **Add a store** | `createObjectStore()`. |
| **Drop a store** | Destructive — surfaces in `report.pending`, opt-in only via `{ destructive: true }`. |
| **Change a field's type** | No-op at DDL level (IDB is schemaless). Coerce at write side. |
| **Change a store's `keyPath`** | Destructive — not supported by IDB natively; surfaced under pending. |

The migration engine fingerprints the DDL plan (fnv-1a over sorted store + index metadata) and only bumps the IDB version when the fingerprint changes. Same fingerprint → no version bump → no upgrade cycle at all. `$migrate()` on an unchanged schema is effectively a boot-time metadata check.

```ts
const report = await db.$migrate();
// { applied:        ['create store users', 'create index _u_email'],
//   skipped:        [],
//   failures:       [],
//   alteredColumns: [],   // always [] on IDB
//   pending:        [],
//   version:        2 }
```

For the equivalent story on sqlite-wasm (with the 2.5.1 auto-ALTER pass), see **[docs/BROWSER.md](./BROWSER.md#dbmigrate--runtime-ddl-apply--drift-detection)**. For the CLI-side counterpart, see **[docs/MIGRATIONS.md](./MIGRATIONS.md)**.

## Full-text search

Every `.searchable()` field gets a shadow `_tokens_<field>: string[]` column maintained by the executor at write time, indexed by a **multiEntry** index. `multiEntry` is the IDB feature that turns array-valued indexes into one entry per array element — so `getAll(IDBKeyRange.only('word'))` on the index returns every row whose token array includes that word.

Search compiles a query like `bio: { search: 'baker cyclist' }` into:

1. Tokenize the query: `['baker', 'cyclist']`.
2. Open the multiEntry index once per token, collect primary keys.
3. Intersect the ID sets → AND-of-tokens.
4. Feed the surviving IDs back into the executor's row-lookup path.

That gives you index-backed FTS with real per-token complexity, not a full-table cursor scan. Tokeniser rules: lowercase, split on non-`\p{L}\p{N}\s`, dedupe, drop tokens longer than 40 chars (runaway guard). Single-character tokens are kept — matters for CJK and Greek. No stemming, no synonyms, no stopwords; that's the design tradeoff for "batteries-included but simple." Bolt in FlexSearch / MiniSearch behind the same shadow field if you need more.

For per-dialect FTS depth (Postgres GIN tsvector, MySQL FULLTEXT, SQLite FTS5, Mongo `text`, DuckDB `fts`), see **[docs/FTS.md](./FTS.md)**.

## Geo

Points are stored as `{ lng, lat }` (or `{ lng, lat, alt }` for 3D) inside the row — same wire shape the sqlite adapter uses in fallback mode. Filtering is a two-stage pipeline:

1. **Range prefilter**: bbox indexed via `[lng, lat]` compound index (when the schema declares one) → cursor scans just the bounding box.
2. **Post-filter**: Haversine JS on the surviving rows for exact `withinMeters` / `withinPolygon` / `orderBy nearTo` semantics.

`orderBy: { location: 'asc', nearTo: { lng, lat } }` annotates each row with `_distanceMeters` after the post-filter and sorts by it. `nearTo` sort of vector fields uses `_distance` with the field's configured metric.

`withinPolygon` accepts MultiPolygon geometry (`Polygon[]`, `Ring[][]`) — outer ring plus holes, ray-cast with even-odd rule, matches every other forge dialect's semantics.

For per-dialect geo depth (SRIDs, PostGIS, MySQL 8 axis order, MultiPolygon on server dialects, 3D coords), see **[docs/GEO.md](./GEO.md)**.

## Vector similarity

Vectors are plain `number[]` on the row. Filter and sort work through the same executor pipeline as geo:

```ts
await db.article.findMany({
  where:   { embedding: { near: { vector: q, withinDistance: 0.3 } } },
  orderBy: { embedding: { direction: 'asc', nearTo: { vector: q } } },
  take: 10,
});
```

Metrics: `cosine` (distance = 1 − cosine similarity), `l2` (Euclidean), `dot` (negated inner product — ascending gives largest projection first). Dimension mismatch → `Infinity` distance (silent — the row falls to the back).

**Performance**: brute force, O(N × dims) per query. Fine for lists of ≤ ~1 k vectors × 100–1500 dims. Slow beyond. Two scale-ups:

* Route large workloads to the sqlite-wasm-pro adapter (custom-built with sqlite-vec HNSW compiled in — see **[docs/BROWSER.md](./BROWSER.md#custom-wasm-build-vec0--r-tree)**).
* Or hoist vector search to a server tier and cache the results in IDB.

For the RAG pipeline story across every server dialect (pgvector, sqlite-vec, Atlas Vector Search, HeatWave, DuckDB vss), see **[docs/VECTOR.md](./VECTOR.md)**.

## JSON path queries

Any `f.json()` / `f.embed()` / `f.embedMany()` / array field takes `path` queries:

```ts
await db.profile.findMany({
  where: { meta: { path: 'address.city', equals: 'Lagos' } },
});
```

The IR carries a `jsonPath: { path, subOp }` on the leaf; the executor walks the nested value with a dotted-path getter and evaluates the sub-op in JS. No index acceleration — full-table scan. If a path becomes hot, promote it to a shadow field with its own IDB index.

For per-dialect JSON path SQL (`->/->>`, `JSON_EXTRACT`, `json_extract`, `JSON_VALUE`, Mongo dotted keys), see **[docs/JSON-PATH.md](./JSON-PATH.md)**.

## Transactions

IDB transactions **auto-commit as soon as the microtask queue idles**. That's a hard rule of the platform — awaiting a non-IDB promise inside a txn callback silently commits the txn early, and any subsequent request throws `TransactionInactiveError` (mapped to `P2036`).

The adapter's `$transaction(fn)` opens per-op txns and reuses them within the fn body. That gives you:

* **Best-effort atomicity** across the batch under normal awaits.
* **Rollback on throw** (any thrown error propagates, subsequent writes don't happen).
* **NOT strict serialisability** — a network request or timer between writes will let the earlier writes commit before the later ones start.

For strict atomicity of interleaved reads + writes on the same store, use the `batch` form:

```ts
await db.$transaction([
  db.user.create({ data: { ... } }),
  db.post.create({ data: { ... } }),
]);
```

That maps to one IDB `readwrite` txn spanning both stores, committed atomically.

For per-dialect transaction depth (savepoints, isolation levels, deadlock retry, Mongo replica-set rules), see **[docs/TRANSACTIONS.md](./TRANSACTIONS.md)**.

## Cascades

IDB has no foreign-key enforcement. The adapter runs a JS cascade walker before every delete — same pattern the Mongo adapter uses. For each relation on the schema:

| `onDelete` | Behaviour |
|---|---|
| `Cascade` | Recurse (leaves-first) into child rows, then delete parent |
| `SetNull` | `$unset` the FK column on child rows, then delete parent |
| `Restrict` | Throw `[P2003] Restrict: cannot delete X` if children exist |
| `NoAction` / undefined | Skip — orphans allowed |

Cycle protection: the walker tracks visited `collection:id` pairs so self-referential schemas (`comment.parent_id → comment.id`) can't infinite-loop.

For relation-graph depth (join tables, polymorphic, deep includes), see **[docs/RELATIONS.md](./RELATIONS.md)**.

## Quota, persistence, and the Safari 7-day eviction

IndexedDB storage is per-origin. Modern browsers give you a large, elastic quota shared with OPFS + Cache API + WebSQL leftovers:

| Browser | Default | Typical safe ceiling |
|---|---|---|
| Chrome / Edge | ~60% of disk (shared) | 2 GB per DB before slowdown |
| Firefox | ~50% of disk, up to 10 GB per group | 2 GB per DB |
| Safari | ~1 GB per origin, grows | ~1 GB per origin |

Query it: `navigator.storage.estimate()` returns `{ quota, usage }` in bytes.

**Safari + iOS ITP**: since 2020, Safari clears IndexedDB (and OPFS, Cache API, LocalStorage — everything) for websites the user hasn't "interacted with" in 7 days. Same rule that hits sqlite-wasm/OPFS.

Mitigation is the same everywhere:

```ts
if (navigator.storage?.persist) {
  const persistent = await navigator.storage.persist();
  console.log('persistent:', persistent);
}
```

Persistence is granted automatically for installed PWAs (added to home screen / installed via Chrome) and by user prompt for others. Under persistence, ITP eviction is skipped.

The sqlite-wasm doc has a longer treatment of the same policy — see **[docs/BROWSER.md](./BROWSER.md#persistent-storage-and-the-safari-7-day-eviction)**.

## Server safety

The adapter references `indexedDB` and `IDBKeyRange` only inside function bodies — never at module import time. On Node / edge / SSR runtimes, `import { indexedDbDriver } from 'forge-orm/indexeddb'` succeeds; only `openDb()` / `driver.open()` triggers a runtime check.

If a server code path *does* reach the adapter (e.g. an accidentally shared component), the guard throws a specific message:

> `[P2010] forge-orm IndexedDB adapter requires a browser or worker environment. Detected server-side runtime — use a server adapter (postgres / mysql / sqlite / mongo) or route this code path client-only.`

The shipped adapter lives at the `forge-orm/indexeddb` subpath export so your bundler tree-shakes it out of any server bundle that doesn't import it.

## Compatibility matrix

Every browser + Node runtime that has native IndexedDB:

| Runtime | Supported |
|---|---|
| Chrome ≥ 24 | ✓ |
| Firefox ≥ 16 | ✓ |
| Safari ≥ 10 | ✓ |
| Edge ≥ 12 | ✓ |
| iOS Safari ≥ 10 | ✓ (mind ITP eviction) |
| Android Chrome | ✓ |
| Web Worker | ✓ (set the `name` per worker to avoid tab collisions) |
| Service Worker | ✓ |
| Tauri / Electron / CEF renderer | ✓ |
| React Native | ✗ — use the sqlite adapter with `opSqliteDriver` |
| Node ≥ 19 (SSR without a browser) | ✗ — guard throws |
| Node with `fake-indexeddb` (tests) | ✓ (auto-detected) |

## Sample code

See `examples/19-indexeddb-zero-install` in this repo for a runnable StackBlitz demo covering CRUD, geo, vector, and FTS.

---

Back to the [README index](../README.md#contents), or over to the sqlite-wasm sibling at **[docs/BROWSER.md](./BROWSER.md)**.
