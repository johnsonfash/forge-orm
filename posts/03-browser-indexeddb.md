---
title: "The network died mid-sale. The customer still had cash in her hand."
published: false
description: "Why I made the same models and the same findMany run inside a browser tab — on IndexedDB with nothing to install, or on real SQLite over OPFS when the queries get serious."
tags: typescript, webdev, javascript, database
series: "forge-orm: one API, six databases"
cover_image: ""
---

There is a shop on the ground floor of a plaza off Lagos Island. Fabric,
mostly. Two staff. One counter. The internet is a phone on top of the till,
tethered, propped against a bottle of water because that's the corner of the
room where it holds a signal.

I was standing in that shop when the connection dropped.

The cashier had scanned three items. She tapped **Save**. The button went
into that state buttons go into — greyed, a small spinner, the polite lie
that something is happening. The customer was holding four thousand naira,
counted out, waiting. Ten seconds. Twenty. Behind her, two more people.

The cashier did what anyone would do. She wrote it in a notebook, took the
cash, and told me she'd "enter it later." Which she did — sometimes.

That's the bug. Not the spinner. The notebook.

Every sale that lands in a notebook is a sale that will not match the
inventory count on Friday. Dallio's whole promise to a retailer is *your
numbers are right*, and a dropped connection was quietly turning that into
*your numbers are right when NTEL is having a good day*.

## What you normally do about this

You cache. Of course you cache.

The first version is `localStorage` and a JSON blob. It works for about a
week, until you need to find "unsynced sales for this branch since Monday"
and discover you're writing `Array.prototype.filter` over a parsed string.

The second version is a hand-rolled IndexedDB wrapper. Now you have stores,
and keys, and a promise shim, and you've reinvented about 15% of a query
engine, badly, in a file nobody wants to open.

The third version is the honest one: a second data layer. Local models that
shadow your server models. A second set of types. A second implementation of
soft delete, of tenant scoping, of "don't show voided sales." Every bug fixed
on the server has to be fixed again, slightly differently, in the tab.

I'd already lived that in post 1 — Mongo for operations, Postgres for
reporting, two of everything. I was not doing it a third time in JavaScript.

## The version I wanted

The same models. The same `findMany`. A different driver.

```ts
const sales = await db.sale.findMany({
  where:   { locationId, postedAt: { gte: startOfDay } },
  orderBy: { postedAt: 'desc' },
});
```

That line should not know or care whether it's talking to Postgres over TCP
or to a database living inside the tab. forge ships no driver of its own —
every backend is an optional peer dependency, which sounded like packaging
trivia when I wrote post 1 and turned out to be the reason any of this is
possible.

There are two browser tiers. They read the same schema and take the same
calls.

## Tier one: IndexedDB, nothing to install

Every browser since roughly 2017 has IndexedDB built in. No wasm blob to
download and host, no Web Worker, no bundler plugin, no COOP/COEP headers to
argue with your CDN about.

```ts
import { createDb, f, model } from 'forge-orm';
// Side-effect import registers the IndexedDB adapter with the factory.
import 'forge-orm/indexeddb';

const Sale = model('sales', {
  id:         f.id({ type: 'uuid' }),
  locationId: f.string(),
  total:      f.int(),
  postedAt:   f.dateTime().default('now'),
});

export const schema = { sale: Sale };

const db = await createDb({ schema, url: 'idb:dallio' });
await db.$migrate();
```

The `idb:` prefix (or the alias `indexeddb:`) picks the adapter, and the
string after the colon is the IndexedDB database name — the same thing you'd
hand to `indexedDB.open(name)` yourself. If you'd rather not thread a URL,
`indexedDbDriver({ name: 'dallio' })` from `forge-orm/indexeddb` gets you the
same adapter and lets you hand in a database you opened in your own bootstrap
code.

That's the whole setup. Installed size of the database layer: zero bytes over
what you already shipped.

## `$migrate()`, because there is no CLI in a browser tab

`forge push` is a Node CLI. You cannot shell out to Node from a tab, so the
same DDL emitter is exposed as a runtime call.

```ts
await db.$migrate();
```

Call it at app boot. It's idempotent — existing stores and indexes are
skipped, and on the SQLite tier, columns added since the last boot get
patched in with `ALTER TABLE … ADD COLUMN` where that's safe. Anything
destructive (a dropped column, a type change) is left alone and reported
under `report.pending` for you to decide about, rather than silently eating
someone's sales history.

On IndexedDB it maps onto the platform's own `onupgradeneeded` versioning,
and rather well: adding a field is a no-op because IDB is schemaless, and
adding an index back-populates existing rows for free. The engine
fingerprints the DDL plan and only bumps the IDB version when the fingerprint
changes, so `$migrate()` on an unchanged schema is a boot-time metadata check
and nothing more.

## The offline-first shape

Local write first, sync second. Never the other way round.

```ts
const sale = await db.sale.create({ data: { locationId, total } });

await db.outbox.create({
  data: { saleId: sale.id, op: 'create', payload: { total: sale.total } },
});
```

The outbox is an ordinary model in the same schema — id, target id, op, a
`f.json()` payload, `queuedAt`, `tries`. A drain loop empties it when the
connection comes back:

```ts
setInterval(async () => {
  if (!navigator.onLine) return;
  const pending = await db.outbox.findMany({
    orderBy: { queuedAt: 'asc' },
    take: 10,
  });
  for (const op of pending) {
    await pushToServer(op);
    await db.outbox.delete({ where: { id: op.id } });
  }
}, 5000);
```

The cashier's **Save** button now returns in a millisecond and is honest
about it. The queue depth goes in the corner of the screen — *3 pending* —
because a shop owner would rather see a number than trust a spinner.

That pattern is `examples/02-sqlite-browser-offline-first`, and it is the
shape Dallio's POS uses.

## Tier two: real SQLite, over OPFS

IndexedDB stops being enough at a fairly specific moment: when you want the
browser to answer a *question* rather than hand you rows.

The end-of-day report joins sales to line items to products, groups by
category, and sums. On the SQLite tier that's SQL — the same C engine that
runs on a server, compiled to WebAssembly, in a Web Worker, persisted on the
Origin Private File System.

```ts
import { createDb, f, model, wasmSqliteDriver } from 'forge-orm';

const worker = new Worker(
  new URL('forge-orm/wasm/worker', import.meta.url),
  { type: 'module' },
);

const db = await createDb({
  schema,
  driver: wasmSqliteDriver({ worker, url: 'opfs-sahpool:///dallio.sqlite' }),
});
await db.$migrate();
```

Three URL schemes: `opfs-sahpool:///file.sqlite` is the default and the one
to pick — its VFS coordinates access handles across tabs, so a user with your
app open twice doesn't get a surprise. `opfs:///file.sqlite` is slightly
faster and single-writer; a second tab opening the same file throws
`SQLITE_BUSY`. `:memory:` is for tests and demos, and dies with the tab.

The worker is required, not stylistic — OPFS synchronous access handles only
exist inside a Worker. Bundler wiring is one import: `forgeWasm()` from
`forge-orm/wasm/vite`, `withForgeWasm()` from `forge-orm/wasm/next`, or
`forgeWasmWebpack(config)` from `forge-orm/wasm/webpack`. Parcel needs
nothing.

**Pick sqlite-wasm when** you need real joins, `groupBy`/`having`, FTS5 with
BM25 ranking, or more data than a cursor scan enjoys. **IndexedDB is enough
when** your browser workload is a working set — today's sales, this branch's
stock list, an outbox — that you filter and sort and page, and the serious
reporting happens on a server.

Cost of the second tier: about 1 MB of wasm, a worker file, and COOP/COEP
headers to get right. Code-split it so your landing page doesn't pay.

## The limits, stated plainly

IndexedDB has no SQL. forge compiles your query to an IR, the planner picks
**one** index, scans a cursor over it, and applies the rest as a compiled JS
predicate. That's honest and it's fast enough at the sizes browsers actually
hold — the docs put the comfortable ceiling around 100k rows — but it is not
a query optimiser.

Specifics worth knowing before you commit:

- `AND` at the root of a `where` unlocks index selection. `OR` and `NOT` at
  the root fall back to a full-table scan plus the residual predicate.
- Relations work, but there is no join. The executor does the lookups.
- JSON path queries (`{ meta: { path: 'address.city', equals: 'Lagos' } }`)
  get no index acceleration at all. If a path goes hot, promote it to a real
  field with its own index.
- Vector search is brute-force cosine/L2 in JS — fine to roughly 1k vectors,
  slow past that. Geo is a bbox prefilter plus Haversine. On stock sqlite-wasm
  those two are *also* fallbacks; native R-Tree and sqlite-vec need a custom
  wasm build.
- Full-text is a multiEntry token index and an AND of tokens. No stemming, no
  stopwords, no ranking.
- IDB transactions auto-commit the moment the microtask queue idles. That is
  a platform rule, not a forge choice. `$transaction(fn)` gives you
  best-effort atomicity and rollback on throw, but not strict
  serialisability — a `fetch` between two writes will let the first commit
  alone. For genuine atomicity use the array form, `$transaction([a, b])`,
  which maps to one `readwrite` transaction.

And the one that catches everybody: **Safari deletes it**. Since 2020, ITP
clears IndexedDB, OPFS and LocalStorage for any site the user hasn't visited
in 7 days. Same rule for both tiers. The mitigation is the same for both too:

```ts
if (navigator.storage?.persist) await navigator.storage.persist();
```

Persistence is granted automatically to installed PWAs and after enough
engagement elsewhere; the first call often returns `false`, so retry on later
visits. For data the user can't get back, tell them to add the app to their
home screen and mean it.

## Did it fix the shop?

The spinner is gone. Sales write to the tab in a millisecond, the outbox
drains when the phone finds a signal, and the notebook has stopped being part
of the accounting system.

The part I keep being pleased about is what *didn't* happen: no second set of
models, no shadow query layer, no local-only bugs. `db.sale.findMany` in the
browser is the same call, against the same model, as `db.sale.findMany` on
the server.

---

**Next in this series:** the same models on a phone. React Native and Expo,
where there is no OPFS, no IndexedDB, and a different driver again.

📖 Docs: **[johnsonfash.github.io/forge-orm](https://johnsonfash.github.io/forge-orm/)**
📦 npm: **[forge-orm](https://www.npmjs.com/package/forge-orm)**
⭐ GitHub: **[johnsonfash/forge-orm](https://github.com/johnsonfash/forge-orm)**

What's the worst connection your app has ever had to survive? I'd like to
know whether Lagos is unusual or whether everyone's been quietly building
notebooks.
