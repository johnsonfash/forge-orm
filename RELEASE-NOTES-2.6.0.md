# forge-orm 2.6.0 — IndexedDB adapter

Adds a native IndexedDB adapter alongside the sqlite-wasm adapter shipped in
2.4. Every modern browser has IndexedDB natively, so the new tier has no wasm
blob to download, no worker file to bundle, no COOP/COEP headers to set, no
bundler plugin. Drop-in upgrade for 2.5.x — the URL prefix `idb:` /
`indexeddb:` is new; no other prefix behaviour shifted.

```ts
import { createDb } from 'forge-orm';

const db = await createDb({ url: 'idb:appname', schema });
await db.user.create({ data: { email: 'a@x.co', name: 'Alice' } });
```

## Two browser adapters, same API

Pick by capability, not by rewriting your queries. The full Prisma-shape
surface — reads, writes, relations, sorts, paging, aggregations, JSON path,
geo `near` / `withinPolygon`, vector `near` / `nearTo`, full-text `search`,
atomic ops, upsert, soft-delete + restore, `.compile`, `$transaction`,
`$migrate`, `$doctor`, `$diff` — runs unchanged on both.

The tradeoff vs sqlite-wasm:

| | sqlite-wasm | IndexedDB |
|---|---|---|
| Bundle cost | ~1 MB wasm + worker | zero |
| Query engine | real SQL | IR → cursor scan + JS predicate |
| Vector | native (sqlite-vec HNSW) | brute-force JS (< 1 k rows) |
| Geo | native (R-Tree via SpatiaLite) | Haversine JS + bbox prefilter |
| FTS | FTS5 with BM25 | multiEntry token index, AND-of-tokens |
| Multi-tab | needs SAHPool VFS | native |

## Under the hood

- **Query planner** — every read goes `Args → IR → planner picks ONE index
  → cursor scan → JS residual filter → JS sort → limit/offset`. Candidate
  scans are scored 0–100 (primary-key eq > compound eq > unique eq >
  compound eq > single-column eq > `in` > range > free sort > full scan)
  and the highest wins. Every plan carries an `explain` string — feed it
  through `$on('query')` to see which index each request lands on.
- **Migrations** — schema fingerprint (fnv-1a over sorted store + index
  metadata) drives IDB version bumps. `onupgradeneeded` runs the diff:
  create stores, create indexes (IDB re-scans existing rows and
  back-populates automatically), drop indexes. Adding a field is a no-op —
  IDB is schemaless. Destructive changes (drop store, type change, keyPath
  rename) surface in `report.pending` and require explicit opt-in.
- **Full-text search** — every `.searchable()` field maintains a shadow
  `_tokens_<field>: string[]` column indexed with `multiEntry`. `search`
  compiles into one `getAll` per token and intersects the ID sets —
  index-backed AND-of-tokens with real per-token complexity, not a
  full-table cursor scan.
- **Geo** — `{ lng, lat }` JSON + Haversine JS post-filter + optional
  `[lng, lat]` bbox prefilter via compound index. Same wire shape the
  sqlite adapter uses in fallback mode. Full MultiPolygon + hole support
  via ray-cast with even-odd rule.
- **Vector** — brute-force JS `cosine` / `l2` / `dot`. Fine at ≤ 1 k rows;
  route heavier workloads to the sqlite-wasm-pro adapter (sqlite-vec HNSW
  compiled in) or to a server tier.
- **Cascades** — JS walker matches the Mongo adapter. `Cascade` / `SetNull`
  / `Restrict` / `NoAction` all implemented, with cycle protection for
  self-referential relations.
- **Server-safety guard** — the adapter throws a specific `[P2010]` message
  when reached from a server runtime (`typeof indexedDB === 'undefined'`)
  instead of a cryptic `ReferenceError`. Shipped at the `forge-orm/indexeddb`
  subpath export so tree-shaking keeps server bundles clean.

## Tests

**113/113** jest tests in the new `test/adapters/indexeddb/` suite via
`fake-indexeddb`. Covers CRUD, every operator, relations, pagination, cursor,
aggregations, planner scoring, migrations (add store / add index / drop
index / no-op field / destructive pending), geo (Haversine correctness,
antipodes, polygon with holes), vector (all three metrics), FTS (Unicode,
punctuation, no-match), JSON path (deep nesting, missing intermediate), soft
delete, transactions, cascades (all four actions), edge cases (limit 0,
offset beyond length, unique constraint, updatedAt stamping), a 1000-row
stress test, and the server-guard.

## Upgrade

Drop-in for 2.5.x. Nothing else changed. The URL prefix `idb:` / `indexeddb:`
is new; no other prefix behaviour shifted.

```sh
npm install forge-orm@2.6.0
```

## Links

- **Full CHANGELOG:** https://github.com/johnsonfash/forge-orm/blob/main/CHANGELOG.md
- **Deep dive:** https://github.com/johnsonfash/forge-orm/blob/main/docs/INDEXEDDB.md
- **Runnable example (StackBlitz):** https://stackblitz.com/github/johnsonfash/forge-orm-examples/tree/main/19-indexeddb-zero-install
