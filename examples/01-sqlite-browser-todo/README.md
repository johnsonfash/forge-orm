# 01 · SQLite browser todo

[![Open in StackBlitz](https://developer.stackblitz.com/img/open_in_stackblitz.svg)](https://stackblitz.com/github/johnsonfash/forge-orm-examples/tree/main/01-sqlite-browser-todo)

The "hello world" of `forge-orm` in the browser. A real SQLite database lives inside a Web Worker — every CRUD operation is real SQL through `sqlite-wasm`.

## What this shows

- Browser-side schema definition with `f.string()` / `f.bool()` / `f.dateTime()`
- `wasmSqliteDriver` + Vite's `forgeWasm` plugin wiring
- `db.$migrate()` for runtime DDL (no separate migration step)
- The same `db.todo.create / findMany / update / delete` API as the backend

## Demo vs production

This example uses `url: ":memory:"` so it runs everywhere — including sandboxed iframes (StackBlitz / CodeSandbox) where OPFS sync access handles are blocked. The data resets on reload.

For a **production offline-first app** that persists across reloads, switch the line in `src/db.ts`:

```ts
// Demo: ephemeral, runs anywhere
url: ":memory:"

// Production: persistent OPFS storage
url: "opfs-sahpool:///todo.sqlite"
```

OPFS requires:
- Chrome 102+ / Edge 102+ / Safari 17+
- A top-level page (not an embedded iframe)
- Cross-origin isolated headers (the `forgeWasm()` Vite plugin sets COOP/COEP automatically)

## Run locally

```sh
npm install
npm run dev
```

## Files

- `src/db.ts` — schema + driver wiring (~30 lines)
- `src/App.tsx` — React UI calling forge-orm directly
- `vite.config.ts` — `forgeWasm()` plugin for wasm + COOP/COEP

## When you'd use the browser adapter

- **Offline-first apps** — full SQL in the tab, no server
- **Local-first** — sync to a backend lazily
- **Privacy-sensitive** — data never leaves the device
- **Demos / prototypes** — no DB to set up

Pair with `02-sqlite-browser-offline-first` for the optimistic-UI + sync pattern.
