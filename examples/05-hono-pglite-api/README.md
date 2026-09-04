# 05 · Hono + PGlite REST API

[![Open in StackBlitz](https://developer.stackblitz.com/img/open_in_stackblitz.svg)](https://stackblitz.com/github/johnsonfash/forge-orm-examples/tree/main/05-hono-pglite-api)

Backend REST API on Hono with Postgres-via-PGlite (Postgres compiled to wasm). Zero external services — `npm install && npm run dev` and you have a working API at `http://localhost:3000`.

## What this shows

- 1:N relations via `rel.one` / `rel.many`
- `include` for relation expansion (no N+1)
- The same `createDb` shape for real Postgres — change one URL

## Try it

```sh
curl -X POST localhost:3000/users -d '{"email":"a@b.co","name":"Alice"}' -H 'content-type: application/json'
curl localhost:3000/users
```

## Switching to real Postgres

```ts
const db = await createDb({ url: process.env.DATABASE_URL!, ... })
```

That's the only line that changes.
