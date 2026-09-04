# 04 · Node + SQLite (CLI)

[![Open in StackBlitz](https://developer.stackblitz.com/img/open_in_stackblitz.svg)](https://stackblitz.com/github/johnsonfash/forge-orm-examples/tree/main/04-node-sqlite-cli)

The minimum-viable `forge-orm` program. One file, three queries, real SQLite via `better-sqlite3`. Use this as the mental model — every other example is variations on top.

## Run

```sh
npm install && npm run dev
```

Re-run it — the upsert is idempotent. A `data.db` file appears in the folder; delete it to start fresh.

## The interesting line

```ts
const db = await createDb({ url: "file:./data.db", schema: { user: User } })
```

That's the whole driver setup. `forge-orm` detects `file:` and loads the SQLite adapter. Same pattern for `postgres://`, `mysql://`, `mongodb://`, `mssql://`, `duckdb:`.
