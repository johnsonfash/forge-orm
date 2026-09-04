---
title: "Browser (sqlite-wasm + OPFS)"
---

## Browser (sqlite-wasm + OPFS)

forge runs in a browser tab. The wasm adapter wraps the official
[`@sqlite.org/sqlite-wasm`](https://sqlite.org/wasm/doc/trunk/index.md) build
of SQLite — the same C engine that runs on a server, compiled to WebAssembly —
inside a Web Worker, persisted on the **Origin Private File System (OPFS)**.
Every forge feature that compiles to SQLite works here unchanged: relations,
joins, aggregates, transactions, `groupBy`, FTS5 search, JSON path,
`softDelete()`, `partialFilterExpression` indexes, `$queryRaw`. The full IR
is reused; only the connection backend changes.

The browser adapter is sqlite-only by design — it's the one dialect with a
wasm story. PostgreSQL / MySQL / MongoDB / DuckDB / MSSQL stay on the server.

### Quickstart

Three steps, ~10 lines:

```sh
npm install forge-orm @sqlite.org/sqlite-wasm
```

```ts
// db.ts
import { createDb, wasmSqliteDriver, f, model } from 'forge-orm';

const Item = model('items', {
  id:    f.id(),
  name:  f.string(),
  qty:   f.int().default(0),
});
export const schema = { item: Item };

const worker = new Worker(
  new URL('forge-orm/wasm/worker', import.meta.url),
  { type: 'module' },
);

export const db = await createDb({
  schema,
  driver: wasmSqliteDriver({ worker, url: 'opfs-sahpool:///app.sqlite' }),
});

// First boot — apply schema DDL.
await db.$migrate();
```

```tsx
// React component — identical to server-side forge.
import { db } from './db';

export function ItemList() {
  const [rows, setRows] = useState<Awaited<ReturnType<typeof load>>>([]);
  useEffect(() => { load().then(setRows); }, []);
  return <ul>{rows.map((r) => <li key={r.id}>{r.name} × {r.qty}</li>)}</ul>;
}

async function load() {
  return db.item.findMany({ where: { qty: { gt: 0 } }, orderBy: { name: 'asc' } });
}
```

That's it. Persistent SQLite in the browser, with the full forge surface.

### URL schemes (`opfs:`, `opfs-sahpool:`, `:memory:`)

| URL | Backend | Persistence | Multi-tab |
|---|---|---|---|
| `opfs-sahpool:///app.sqlite` | OPFS SAH-pool VFS | Full | **Safe (recommended)** |
| `opfs:///app.sqlite` | OPFS VFS | Full | Single-tab writer |
| `:memory:` | In-RAM | None — lost on tab close | N/A |

The path after the prefix is the file name inside OPFS. OPFS files are
sandboxed per origin — `app.example.com` can't see `evil.com`'s files. The
default URL is `opfs-sahpool:///forge.sqlite`.

Pick **`opfs-sahpool:`** unless you have a specific reason not to. The SAH
pool VFS pre-allocates a small pool of synchronous access handles and
coordinates across tabs — opening the same DB in two tabs of your app just
works. The plain `opfs:` VFS gives a slight perf edge but throws if a second
tab tries to open the same file.

`:memory:` is useful for tests, demos, or strictly-ephemeral state.

### The worker file

sqlite-wasm needs OPFS *synchronous* access handles (`FileSystemSyncAccessHandle`),
which the browser only exposes inside a **Web Worker**. forge ships the
worker file at `forge-orm/wasm/worker` — bundlers resolve it via the standard
`new Worker(new URL(...), { type: 'module' })` pattern:

```ts
const worker = new Worker(
  new URL('forge-orm/wasm/worker', import.meta.url),
  { type: 'module' },
);
```

| Bundler | Pattern works? | Extra config |
|---|---|---|
| **Vite 4+** | Yes | `forgeWasm()` plugin (see below) |
| **Next.js 13+ (App Router)** | Yes | `withForgeWasm()` wrapper (see below) |
| **Webpack 5** | Yes | `forgeWasmWebpack(config)` helper (see below) |
| **Parcel 2+** | Yes | None — native worker support |
| **esbuild standalone** | Manual | Mark `@sqlite.org/sqlite-wasm` as external; bundle the worker separately |
| **Rollup** | Manual | Use `@rollup/plugin-web-worker-loader` |

If your bundler isn't listed, the worker pattern above is plain web-standard
syntax — modern bundlers all support it; the plugins below just take care
of the COOP/COEP headers and wasm asset handling.

### Vite setup

```ts
// vite.config.ts
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { forgeWasm } from 'forge-orm/wasm/vite';

export default defineConfig({
  plugins: [react(), forgeWasm()],
});
```

What `forgeWasm()` does:

- Adds `optimizeDeps.exclude: ['@sqlite.org/sqlite-wasm']` so Vite's
  pre-bundler doesn't touch the wasm package.
- Sets `worker.format: 'es'` so the worker file is emitted as a real ES module.
- Adds `Cross-Origin-Opener-Policy: same-origin` and
  `Cross-Origin-Embedder-Policy: require-corp` to the dev server (required if
  you use SharedArrayBuffer; harmless otherwise).

Options:

```ts
forgeWasm({
  coopCoep: true,             // default — disable if your dev server hosts
                              // third-party scripts that break under COEP
  excludeSqliteWasm: true,    // default — keeps wasm out of the dep optimizer
});
```

In production (`vite build`), the worker is bundled as a separate chunk. You
need to set the same COOP/COEP headers on your CDN / origin if the threaded
build is used; the stock build doesn't strictly require them.

### Next.js setup

```js
// next.config.js (or next.config.mjs)
import { withForgeWasm } from 'forge-orm/wasm/next';

export default withForgeWasm({
  reactStrictMode: true,
  // ...your existing Next config
});
```

What `withForgeWasm()` does:

- Wraps `webpack` to enable `asyncWebAssembly` + `topLevelAwait` experiments.
- Adds an `asset/resource` rule for `.wasm` files.
- Wraps `headers()` to emit COOP/COEP for the matched routes.
- Sets `experimental.esmExternals: 'loose'` (some Next versions need this for
  the wasm package's ESM-only export).

Options:

```ts
withForgeWasm(nextConfig, {
  coopCoepMatcher: '/(.*)',   // default — every route. Tighten to '/app/(.*)'
                              // if your marketing pages embed third-party widgets.
  noHeaders: false,           // skip COOP/COEP entirely if you set them at the CDN.
});
```

Note: COOP/COEP are app-wide policies. If a marketing page or auth callback
embeds Stripe / Intercom / GA that doesn't send `Cross-Origin-Resource-Policy`
back, the embed will break. Narrow the matcher in that case, or host the
SQLite-using parts on a subdomain.

### Webpack / CRA / Rsbuild setup

```js
// webpack.config.js
const { forgeWasmWebpack } = require('forge-orm/wasm/webpack');

module.exports = forgeWasmWebpack({
  // ...your existing webpack config
});
```

For Create React App, use `craco` to inject the same changes, or eject. For
Rsbuild, the same helper works against the underlying webpack config.

You'll also need to serve COOP/COEP headers from your dev server / CDN.
Express:

```js
app.use((req, res, next) => {
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
  next();
});
```

### `db.$migrate()` — runtime DDL apply

`forge push` is a Node CLI. In the browser you can't shell out to Node, so
forge ships the same emitter and applier as a runtime call:

```ts
const report = await db.$migrate();
// {
//   applied:        ['items', 'forge_items_unique_name'],
//   skipped:        [],                 // tables / indexes already present
//   failures:       [],                 // { name, error }
//   alteredColumns: ['items.email'],    // ALTER TABLE … ADD COLUMN run for these
//   pending:        [],                 // destructive drift left untouched
// }
```

Behind the scenes:

1. Reads the active schema (the one passed to `createDb({ schema })`).
2. Calls `buildSqliteSchemaDDL(schema)` — the same DDL emitter `forge push`
   uses against `better-sqlite3`.
3. Filters out tables / indexes that already exist (via `sqlite_master`).
4. Wraps the remaining batch in `BEGIN / COMMIT` and applies through the
   wasm driver.
5. Runs a drift-apply pass: introspects the live DB, diffs against the
   schema, emits `ALTER TABLE … ADD COLUMN` for every missing column that
   can be added safely (nullable, or with a constant default). Destructive
   drift — column drops, column-type changes, extra tables — is left alone
   and surfaced under `pending` for the caller to decide.

It's **idempotent**. Safe to call on every app boot — already-present tables
and indexes get skipped, columns added since the last boot get patched in,
the rest stays untouched. The shape of the report matches the `forge push`
output exactly (plus the two new fields), so it can be rendered in-app.

For verbose progress:

```ts
await db.$migrate({ logger: (line) => console.log(line) });
// ✓ table       items
// ✓ index       forge_items_unique_name
```

If you'd rather not couple migration to app boot, the lower-level pieces are
also exported — call them manually:

```ts
import { buildSqliteSchemaDDL, applySqliteMigration, runMigrate } from 'forge-orm';

// Build DDL once at build time, ship as a static asset:
const ddl = buildSqliteSchemaDDL(schema);   // DDLStatement[]
// Apply on demand:
const report = await applySqliteMigration(driver, ddl, { logger: console.log });
// Or, equivalent of db.$migrate():
const report2 = await runMigrate(driver);
```

**Drift detection** (since 2.5.1). After the create-pass, `$migrate()`
introspects the live DB and diffs it against the active schema:

* **Missing column, safe to add** (nullable, or has a constant default) →
  `ALTER TABLE … ADD COLUMN` is emitted automatically. Existing rows get
  `NULL` or the declared default. Each one is reported under
  `report.alteredColumns` as `'table.column'`.
* **Missing column, NOT NULL with no default** → surfaced under
  `report.pending`. SQLite would reject the ADD COLUMN against a non-empty
  table, so the runtime won't try; the caller decides whether to wipe the
  DB, hand-write a `$executeRaw` rebuild, or relax the schema.
* **Column-type change / column drop / extra table** → also `pending`.
  These need a full table rebuild, which is more than a runtime drift fix
  should attempt.

If you want the strict 2.5.0 create-or-skip behaviour back (no ALTER pass),
pass `await db.$migrate({ alter: false })`. `db.$diff()` is still
available when you only want the report and not the apply.

### `browserDoctor()` — runtime capability probe

The browser analog of `forge doctor`. Probes the environment and the SQLite
build, returns a structured report:

```ts
import { browserDoctor, wasmSqliteDriver } from 'forge-orm/wasm';

const driver = wasmSqliteDriver({ worker });
const report = await browserDoctor(driver);

console.table(report.capabilities);
// ┌─────────────────────────────────────┬────────────┐
// │ softDelete                          │ 'native'   │
// │ unique                              │ 'native'   │
// │ partialFilterIndex                  │ 'native'   │
// │ relationsAndJoins                   │ 'native'   │
// │ aggregations                        │ 'native'   │
// │ transactions                        │ 'native'   │
// │ json(path)                          │ 'native'   │
// │ text.searchable() / FTS5            │ 'native'   │
// │ geoPoint near / withinPolygon       │ 'fallback' │  ← R-Tree not in stock build
// │ vector near / nearTo                │ 'fallback' │  ← sqlite-vec not in stock build
// │ persistent OPFS storage             │ 'native'   │
// │ multi-tab safe                      │ 'native'   │
// └─────────────────────────────────────┴────────────┘
```

The full `BrowserDoctorReport` shape:

```ts
interface BrowserDoctorReport {
  environment: {
    runtime: 'browser' | 'worker' | 'node' | 'unknown';
    opfs: boolean;
    opfsSyncHandles: boolean;
    sharedArrayBuffer: boolean;
    persistent: 'granted' | 'requestable' | 'unavailable';
    estimatedQuotaMB?: number;
    estimatedUsageMB?: number;
    userAgent?: string;
  };
  sqlite: {
    version?: string;
    json1: boolean;
    fts5: boolean;
    rtree: boolean;
    sqliteVec: boolean;
    foreignKeys: boolean;
  };
  capabilities: Record<string, 'native' | 'fallback' | 'unavailable'>;
  notes: string[];   // human-readable warnings + remediation hints
}
```

### Persistent storage and the Safari 7-day eviction

Browsers grant every origin a storage quota — Chromium typically allows up to
~60% of free disk per origin pool. Two policies decide whether your data
survives:

1. **Disk-pressure eviction** — if the browser runs low on disk space, it can
   wipe any origin's storage. Mitigate by calling `navigator.storage.persist()`.
2. **Safari ITP 7-day eviction (iOS + macOS)** — Apple's Intelligent Tracking
   Prevention deletes IndexedDB + OPFS + LocalStorage after **7 days of no
   foreground visit**. This is the most-cited gotcha for offline-first browser
   apps. Two escapes:

   ```ts
   // 1. Ask for persistent storage at app boot. Once granted, ITP doesn't apply.
   if (navigator.storage?.persist) {
     const granted = await navigator.storage.persist();
     console.log('persistent storage:', granted ? 'granted' : 'not yet');
   }
   // 2. Tell users to "Add to Home Screen". PWAs are exempt from the 7-day timer.
   ```

   Apple grants `persist()` automatically once a site is "engaged with"
   (multiple visits, bookmarked, or installed). The first call may return
   `false`; retry on later visits.

For data you can rebuild from a server (offline cache shape), wiping the OPFS
DB is recoverable — the next online session re-fetches. For data the user
created locally and can't restore, treat persistence as critical: call
`persist()` early, surface a banner if it's not granted, and consider a sync
adapter.

### Multi-tab safety

If a user opens your app in two tabs and both try to write to the same OPFS
file, the rules are VFS-dependent:

| VFS | Two-tab behavior |
|---|---|
| `opfs:` | Second tab's open throws `SQLITE_BUSY`. Single-writer per file. |
| **`opfs-sahpool:`** | **Pool coordinates handles across tabs; multi-tab safe.** |

Default to **`opfs-sahpool:`**. The SAH pool pre-allocates a small set of
file handles (default 6) — your DB is one of them; the rest absorb the
multi-tab arbitration cost. The first tab grabs a handle; subsequent tabs
queue and resume when the first releases. Latency goes up under contention
but no writes are lost.

For tighter control, use a **SharedWorker** as a single owner of one
`opfs:` handle, and have each tab `postMessage` through it. That's outside
forge's scope today — issue a request if you want a built-in SharedWorker
host.

Cross-tab cache invalidation (refetch when another tab writes) is your
concern. The standard `BroadcastChannel` pattern works:

```ts
const bc = new BroadcastChannel('forge-invalidate');
// after a mutation:
bc.postMessage({ model: 'item' });
// in other tabs:
bc.onmessage = (ev) => queryClient.invalidateQueries({ queryKey: [ev.data.model] });
```

### Feature parity matrix

What the **stock** `@sqlite.org/sqlite-wasm` build gives you vs. the **pro**
build (custom-compiled with R-Tree + sqlite-vec, see next section):

| forge feature | Stock wasm | Pro wasm | Server (better-sqlite3 + extensions) |
|---|---|---|---|
| CRUD (findMany/Unique/create/update/delete) | ✓ | ✓ | ✓ |
| where ops (`contains` / `in` / `gt` / `OR` / `AND` / …) | ✓ | ✓ | ✓ |
| Relations (`include`, `select`, joins) | ✓ | ✓ | ✓ |
| Aggregates (`count`, `groupBy`, `having`, `_avg`/`_sum`/…) | ✓ | ✓ | ✓ |
| Transactions (`$transaction`) | ✓ | ✓ | ✓ |
| `softDelete()` / `restore()` | ✓ | ✓ | ✓ |
| `unique()` / partial-filter indexes | ✓ | ✓ | ✓ |
| `f.json()` + JSON path (`{ path: 'a.b', gte: 18 }`) | ✓ | ✓ | ✓ |
| `f.text().searchable()` (FTS5) | ✓ | ✓ | ✓ |
| `f.geoPoint()` + `near` / `withinPolygon` | Fallback (Haversine in JS) | **Native (R-Tree index)** | Native (SpatiaLite) |
| `f.vector()` + `near` / `nearTo` | Fallback (brute-force JS) | **Native (sqlite-vec HNSW)** | Native (sqlite-vec) |
| Atomic upsert (`INSERT … ON CONFLICT`) | ✓ | ✓ | ✓ |
| `$queryRaw` / `$executeRaw` | ✓ | ✓ | ✓ |
| Migrations | `db.$migrate()` (runtime) | `db.$migrate()` (runtime) | `forge push` (CLI) |
| Doctor probe | `browserDoctor()` | `browserDoctor()` | `forge doctor` (CLI) |
| Drift detection (`forge diff`) | Roadmap (2.5) | Roadmap (2.5) | ✓ |

Fallback mode is correct — it works — but slower. Rule of thumb:

- Fallback geo / vector: fine to ~50k rows. Past that, build the pro wasm.
- Stock FTS5 / JSON path: fast at any size — these are native in the stock build.

### Custom wasm build (vec0 + R-Tree)

The stock `@sqlite.org/sqlite-wasm` ships SQLite with FTS5 + json1 but
**without** R-Tree or sqlite-vec. To unlock native `f.geoPoint()` indexes and
native `f.vector()` similarity search, compile your own wasm bundle.

forge ships a build script that does this:

```sh
# 1. Install Emscripten (one-time)
git clone https://github.com/emscripten-core/emsdk
cd emsdk && ./emsdk install latest && ./emsdk activate latest
source ./emsdk_env.sh
cd -

# 2. Run the build (fetches SQLite + sqlite-vec sources, compiles, emits artifacts)
bash node_modules/forge-orm/scripts/wasm-pro/build.sh

# Artifacts land in dist/wasm-pro/sqlite3.{mjs,wasm}
```

What it includes:
- SQLite (configurable via `SQLITE_VERSION` env var, default 3.46.1)
- FTS5, json1, R-Tree, GeoPoly (all `SQLITE_ENABLE_*` flags set)
- sqlite-vec (configurable via `SQLITE_VEC_VERSION`, default `v0.1.6`)
- ES module output (`MODULARIZE=1 EXPORT_ES6=1`)
- Memory growth enabled (32 MB initial, grows as needed)

To use the pro build:

```sh
# 3. Copy the artifacts to your app's public/ folder
cp dist/wasm-pro/sqlite3.{mjs,wasm} public/wasm-pro/
```

```ts
// 4. Point the worker at the pro entry instead of the stock one
const worker = new Worker(
  new URL('forge-orm/wasm/worker-pro', import.meta.url),
  { type: 'module' },
);

// 5. Set the wasm URL on the worker (defaults to /wasm-pro/sqlite3.mjs)
worker.postMessage({ FORGE_WASM_PRO_URL: '/wasm-pro/sqlite3.mjs' });

// 6. Use as normal
const db = await createDb({
  schema,
  driver: wasmSqliteDriver({ worker, url: 'opfs-sahpool:///app.sqlite' }),
});
```

Now `f.geoPoint()` builds a real `USING rtree` index, and `f.vector()`
queries route through `vec_distance_cosine()` instead of JS brute-force.

Trade-offs of the pro build:

| | Stock | Pro |
|---|---|---|
| wasm size | ~1.0 MB | ~1.6 MB |
| Hosting | npm peer dep | You host the artifacts |
| Updates | `npm update` | Re-run `build.sh` |
| Geo / vector | Fallback | Native (10–100× faster on 100k+ rows) |
| Maintenance | None | Rebuild when sqlite-vec ships a fix |

For most apps, **stock + fallback is fine**. Reach for pro when you're doing
serious in-browser geo or vector work and the fallback isn't fast enough.

A pre-built `@forge-orm/sqlite-wasm-pro` npm artifact is on the roadmap —
issue a request if you want it sooner.

### Troubleshooting

**`SecurityError: Cross-Origin-Embedder-Policy: require-corp`**
Your dev server / CDN isn't sending COOP/COEP headers. Add the bundler plugin
above, or set them at your reverse proxy.

**`The operation cannot be performed in the current state` (OPFS)**
You're opening the DB from the main thread instead of a Worker. OPFS sync
handles are worker-only. Verify the `wasmSqliteDriver({ worker })` arg is a
constructed `Worker`, not an inline init.

**`SQLITE_BUSY` when opening in a second tab**
Switch from `opfs:` to `opfs-sahpool:` — the SAH pool VFS is multi-tab safe.

**Storage was empty after 7 days (Safari)**
Apple's ITP wiped it. Call `await navigator.storage.persist()` at app boot,
ideally guarded behind a successful auth (Apple grants persistence after
engagement). For long-lived data, prompt the user to add to Home Screen.

**`Failed to fetch dynamically imported module: ./sqlite3.mjs` (pro build)**
Set the `FORGE_WASM_PRO_URL` on the worker before any message, or hard-code
it inside `worker-pro.ts`. Default is `/wasm-pro/sqlite3.mjs`.

**Bundle size warnings**
`@sqlite.org/sqlite-wasm` is ~1 MB. Code-split it into the part of the app
that needs the DB so the marketing page doesn't pay the cost. Vite + Next
already handle this via the `import()` boundary at the worker URL.

**Slow startup on first visit**
The wasm fetch + compile is one-time and gets cached by the HTTP cache + the
wasm code cache. Subsequent loads are <50 ms. If you need a pre-warm, fire
the worker construction in the root layout instead of waiting for a route.

### Framework worked examples

End-to-end recipes for React + Vite, Next.js App Router, Vue 3, Nuxt 3, SvelteKit, Angular, SolidStart, Astro, Remix, React Native + op-sqlite, and Tauri desktop live in **[docs/BROWSER-FRAMEWORKS.md](/reference/browser-frameworks)**. Each one is the production-shaped install → bundler config → schema → db singleton → component flow.

See more — **[docs/BROWSER.md](/reference/browser)** for the complete browser reference (URL schemes, worker, every bundler setup, `$migrate` semantics including 2.5.1 drift, browserDoctor, persistent storage, multi-tab, stock-vs-pro matrix, custom build, troubleshooting), **[docs/BROWSER-FRAMEWORKS.md](/reference/browser-frameworks)** for 11 framework recipes, and **[docs/REACT.md](/reference/react)** for React patterns (hooks, TanStack Query, Suspense, server vs client components, optimistic updates, sync).

---
