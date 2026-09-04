# 16 · MongoDB (Atlas free tier)

## Setup (~3 minutes, no credit card)

1. Create a free cluster at https://www.mongodb.com/cloud/atlas/register
2. Add a database user + allow access from `0.0.0.0/0` (or your specific IP)
3. Copy the connection string — looks like `mongodb+srv://user:pass@cluster.mongodb.net/blog`

## Run it

- **[Run on CodeSandbox](https://codesandbox.io/p/devbox/github/johnsonfash/forge-orm-examples/main/16-mongo-atlas-blog)** — paste your URI into the env editor as `DATABASE_URL`, hit Run

Or locally:

```sh
npx degit johnsonfash/forge-orm-examples/16-mongo-atlas-blog my-demo
cd my-demo
echo "DATABASE_URL=mongodb+srv://USER:PASS@CLUSTER.mongodb.net/blog" > .env
npm install && npm run dev
```

## What this shows

Uses `f.text().searchable()` which compiles to a Mongo text index. Atlas Vector Search is supported too — see `09-vector-rag` for the pattern.
