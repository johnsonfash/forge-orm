# 19 · IndexedDB (zero install)

[![Open in StackBlitz](https://developer.stackblitz.com/img/open_in_stackblitz.svg)](https://stackblitz.com/github/johnsonfash/forge-orm-examples/tree/main/19-indexeddb-zero-install)

forge-orm running on IndexedDB. No wasm, no bundler plugin, no headers. Works in every browser since 2017.

An **interactive playground** — five sections, each with an input + button, each showing exactly the forge-orm call it makes.

## What you can do

| Section | What it demos |
|---|---|
| 1. Create      | `db.cafe.create({ data: … })` |
| 2. All + delete | `db.cafe.findMany({ orderBy })` + `db.cafe.delete({ where: { id } })` |
| 3. Pagination  | `db.cafe.findMany({ take, skip, orderBy })` |
| 4. Geo         | `where: { location: { near: { lng, lat, withinMeters } } }` + `orderBy nearTo` |
| 5. Vector      | `orderBy: { embedding: { nearTo: [ … ] } }` (cosine) |

Type into the inputs, click the button — the result shows underneath and the `<code>` line prints the actual forge-orm call.

## Files

| | |
|---|---|
| `src/db.ts` | schema (5 fields) + `openDb()` |
| `src/App.tsx` | five `<section>` components — read them one at a time |
| `src/main.tsx` | React mount |

## Run locally

```sh
npm install
npm run dev
```

## Deep dive

**[forge-orm docs/INDEXEDDB.md](https://github.com/johnsonfash/forge-orm/blob/main/docs/INDEXEDDB.md)** — planner, migrations, FTS, MultiPolygon geo, vector metrics, capability differences vs sqlite-wasm.
