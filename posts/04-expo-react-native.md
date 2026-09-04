---
title: "The same models, on a phone with no signal"
published: false
description: "Running forge-orm on Expo and bare React Native — why it's the driver option and never forge-orm/sqlite, and what one dialect with six driver packages behind it actually buys you."
tags: reactnative, typescript, expo, database
series: "forge-orm: one API, six databases"
cover_image: ""
---

There is a stretch of the Lagos–Ibadan expressway where the network drops
for about four minutes. Not enough to notice if you're a passenger. Plenty
if you're a Dallio user standing at the back of a customer's shop trying to
record twelve cartons of soap against an invoice.

One of the first people to use Dallio's field app was a distributor's rep
who spent his day exactly like that: shop to shop, six or seven stops,
somewhere between two bars of signal and none. The first version of that
app did the obvious thing — every action was a request. Tap "record
delivery", spinner, timeout, retry, and a rep who had learned to take a
photo of his paper ledger as a backup. Which tells you the app had already
lost.

So the local database stopped being a cache and became the database. Write
to SQLite on the phone, always, whether or not there's signal. Push to the
server when there is. That part is not a novel idea; it's the standard
shape of an offline-first app and half the mobile ecosystem is built around
it.

The problem was what it did to my models.

## Three codebases describing the same invoice

By that point Dallio had a server — Node, talking to Postgres and Mongo. It
had a browser build where the whole thing ran locally in a tab (that was post 3 —
sqlite-wasm and IndexedDB). And now it had a phone.

Same invoice in all three. Three definitions of it.

The server had the real one. The web build had a copy, close enough that
you'd never spot the difference reading them side by side, subtly wrong in
one place — the discount field was nullable on the server and defaulted to
zero in the browser, which meant one report disagreed with another by a few
hundred naira and took me a full evening to find. The phone had a third,
hand-written `CREATE TABLE` in a string literal, because that's what you do
when your ORM won't run on React Native.

Three files. One concept. Every schema change was a three-way merge I
performed in my head.

## The models are the same file

Here is what I actually wanted, and what forge does now.

```ts
// models.ts — shared. Node imports it. The browser imports it. The phone imports it.
import { f, model, rel } from 'forge-orm';

export const Customer = model('customers', {
  id:         f.id(),
  name:       f.string(),
  phone:      f.string().optional(),
  created_at: f.dateTime().default('now'),
}).relate(() => ({
  invoices: rel.many('invoice', { on: 'customer_id', refs: 'id' }),
}));

export const Invoice = model('invoices', {
  id:          f.id(),
  customer_id: f.objectId(),
  total_cents: f.int().default(0),
  status:      f.string().default('draft'),
  created_at:  f.dateTime().default('now'),
  updated_at:  f.dateTime().default('now').updatedAt(),
}).relate(() => ({
  customer: rel.one('customer', { on: 'customer_id', refs: 'id', onDelete: 'Cascade' }),
}));

export const schema = { customer: Customer, invoice: Invoice } as const;
```

Three ways to open it.

```ts
// server.ts — Node, Postgres
import { createDb } from 'forge-orm/postgres';
import { schema } from './models';

export const db = await createDb({ url: process.env.DATABASE_URL!, schema });
```

```ts
// web.ts — browser, sqlite-wasm over OPFS
import { createDb, wasmSqliteDriver } from 'forge-orm';
import { schema } from './models';

const worker = new Worker(new URL('forge-orm/wasm/worker', import.meta.url), { type: 'module' });
export const db = await createDb({
  schema,
  driver: wasmSqliteDriver({ worker, url: 'opfs-sahpool:///app.sqlite' }),
});
```

```ts
// mobile.ts — Expo
import * as SQLite from 'expo-sqlite';
import { createDb, expoSqliteDriver } from 'forge-orm';
import { schema } from './models';

export const db = await createDb({
  schema,
  driver: expoSqliteDriver(SQLite.openDatabaseSync('app.db')),
});
await db.$migrate();
```

Bare React Native, where you can prebuild, uses op-sqlite instead — it talks
JSI directly rather than crossing an async bridge per row, which shows up on
write-heavy work:

```ts
import { open as openSqlite } from '@op-engineering/op-sqlite';
import { createDb, opSqliteDriver } from 'forge-orm';
import { schema } from './models';

const native = openSqlite({ name: 'app.sqlite' });
export const db = await createDb({ schema, driver: opSqliteDriver(native) });
await db.$migrate();
```

`db.invoice.findMany({ where: { status: 'draft' }, include: { customer: true } })`
is the same call in all four files. Not a similar call. The same one, against
the same models, fully typed, with nothing generated.

## A warning: never import `forge-orm/sqlite` on React Native

This one deserves a box, because I watched someone hit it and lose an hour.

forge has per-dialect entry points — `forge-orm/postgres`, `forge-orm/mysql`,
`forge-orm/sqlite` and so on. They exist so a bundler can *see* the driver:
inside `forge-orm/postgres`, `pg` is brought in with a static import, which
webpack and esbuild understand in a way they never understand a computed
`require`.

`forge-orm/sqlite` is the **better-sqlite3** one. better-sqlite3 is a native
Node addon. It cannot exist on React Native — not "is slow there", not
"needs configuration": there is no build of it that runs. Import it from an
Expo or RN app and Metro fails on a module that has no business being in the
graph.

The entry point isn't wrong. It's a server entry point that happens to
share a dialect name with the thing you want. On a phone you use the main
`forge-orm` entry and pass `driver:` — and because *you* write the
`import * as SQLite from 'expo-sqlite'` line yourself, it's static, and Metro
resolves it like any other import. The pluggable driver is the bundler-safe
path here, not the escape hatch.

## One dialect, several packages

This is the part I find genuinely interesting, and it took me a while to see
it clearly.

Fifteen driver packages sit behind forge's six dialects. SQLite alone
accounts for six of them: `better-sqlite3` on a server, `expo-sqlite` and
OP-SQLite on React Native, `@libsql/client` for libSQL and Turso,
`@sqlite.org/sqlite-wasm` in a browser tab, `@tauri-apps/plugin-sql` on
desktop. Postgres has three, MySQL three, and MongoDB, DuckDB and SQL Server
one each.

Six packages, one adapter. Every one of those SQLite clients runs the same
forge sqlite adapter — same IR compiler, same DDL emitter, same
introspection reader — and emits identical SQL. The adapter has no idea
which of them is underneath. It hands down a SQL string and an array of
params and gets rows back; that is the entire contract, five methods wide.

Which is why no two of them can share an entry point. Each would drag in a
package the others cannot load. A single `forge-orm/sqlite` importing all
six would put a WebAssembly SQLite and a native Node addon into your Metro
bundle together, and neither belongs there.

Adapters are stable. Engines aren't. Keeping them apart is the reason the
phone got the real models instead of a hand-written `CREATE TABLE`.

## `$migrate()`, because there's no CLI on a phone

`forge push` is a Node CLI. You cannot shell out to Node from an iPhone, so
forge ships the same emitter and applier as a runtime call:

```ts
const report = await db.$migrate();
// { applied, skipped, failures, alteredColumns, pending }
```

It reads the schema you passed to `createDb`, emits the same DDL `forge push`
would, skips tables and indexes that already exist, then introspects the live
database and adds any missing column that can be added safely — nullable, or
with a constant default. Destructive drift (column drops, type changes) is
left alone and reported under `pending`.

It's idempotent, so calling it on every app boot is the intended usage. On
mobile that matters more than it does on a server, because over-the-air
updates ship a JS bundle whose schema can run ahead of what the installed
build's database knows about. `db.$diff()` gives you the report without the
apply, which makes a decent release-branch test.

One Metro-specific wrinkle: fast refresh re-runs your module, so memoise the
handle at module scope rather than opening a connection on every save.

## The honest limits

- **Expo managed gets stock SQLite.** FTS5 is there from SDK 51, but there's
  no SQLCipher and no extensions — you prebuild and move to op-sqlite for
  those. The forge schema, models and queries don't change when you do.
- **Geo needs fallback mode.** No mobile build ships SpatiaLite, so
  `f.geoPoint({ fallback: true })` stores `{lng, lat}` as JSON and the
  adapter post-filters with Haversine. Correct, and slower —
  fine to roughly 50k rows.
- **`f.vector(N)` needs a custom build** that links sqlite-vec. Stock
  op-sqlite and expo-sqlite don't have it.
- **Size.** forge itself is around 80 KB minified with no driver. The
  drivers carry the weight: expo-sqlite is roughly 150 KB of JS plus about
  1.2 MB of native per arch, op-sqlite roughly 600 KB plus 3–4 MB per arch.
  ABI splits keep the per-APK number down.
- **Sync is yours.** forge is local-first and ships none. MOBILE.md
  documents three patterns — pull-on-foreground, an outbox table replayed
  with backoff, CRDT blobs — and the outbox is a plain forge model, not a
  special API. Which is the point: the local SQLite *is* the app's database,
  and sync is a separate program that happens to read and write it.

The rep on the expressway doesn't know any of this. He taps, it saves, the
number is right when he gets back into signal. That was the whole
requirement.

---

**Next in this series:** the CLI — `forge push`, `forge diff`, migration
snapshots, and the bugs that shipped before I got drift detection right.

📖 Docs: **[johnsonfash.github.io/forge-orm](https://johnsonfash.github.io/forge-orm/)**
📦 npm: **[forge-orm](https://www.npmjs.com/package/forge-orm)**
⭐ GitHub: **[johnsonfash/forge-orm](https://github.com/johnsonfash/forge-orm)**

If you've shipped an offline-first mobile app, how did you keep the phone's
schema and the server's schema from drifting apart? I've yet to hear two
people answer that the same way.
