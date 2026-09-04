# 18 · Postgres Row-Level Security

Hard multi-tenant isolation enforced by the database, not the app. Even if your code forgets to filter by `orgId`, RLS prevents the leak.

## Free hosted Postgres (~2 minutes, no credit card)

Pick one — all free, all instant signup:

- **[Neon](https://neon.tech)** — generous free tier, serverless Postgres
- **[Supabase](https://supabase.com)** — free Postgres + dashboard
- **[Aiven](https://aiven.io)** — 1-month free trial

Copy the connection string — looks like `postgres://user:pass@host:5432/db?sslmode=require`.

## Run it

- **[Run on CodeSandbox](https://codesandbox.io/p/devbox/github/johnsonfash/forge-orm-examples/main/18-postgres-rls-auth)** — paste URI into the env editor as `DATABASE_URL`, hit Run

Or locally with Docker:

```sh
docker run -e POSTGRES_PASSWORD=postgres -p 5432:5432 -d postgres:16
npx degit johnsonfash/forge-orm-examples/18-postgres-rls-auth my-demo
cd my-demo
echo 'DATABASE_URL=postgres://postgres:postgres@localhost:5432/postgres' > .env
npm install && npm run dev
```

For soft RLS (app-layer filter, no DB enforcement), see `11-multi-tenant`.
