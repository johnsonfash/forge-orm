# 17 · MSSQL with MERGE upsert

## Free hosted MSSQL options

- **[Azure SQL free tier](https://azure.microsoft.com/free/)** — free for 12 months (750 hours/month)
- **[SQL Server Express](https://www.microsoft.com/sql-server/sql-server-downloads)** — free Windows install if you have one
- Local Docker — `docker run -e "ACCEPT_EULA=Y" -e "MSSQL_SA_PASSWORD=YourStrong!Pass1" -p 1433:1433 -d mcr.microsoft.com/mssql/server:2022-latest`

## Run it

- **[Run on CodeSandbox](https://codesandbox.io/p/devbox/github/johnsonfash/forge-orm-examples/main/17-mssql-merge-erp)** — paste your URI into the env editor as `DATABASE_URL`, hit Run

Or locally with Docker:

```sh
docker run -e "ACCEPT_EULA=Y" -e "MSSQL_SA_PASSWORD=YourStrong!Pass1" \
  -p 1433:1433 -d mcr.microsoft.com/mssql/server:2022-latest
npx degit johnsonfash/forge-orm-examples/17-mssql-merge-erp my-demo
cd my-demo
echo 'DATABASE_URL=mssql://sa:YourStrong!Pass1@localhost:1433/master' > .env
npm install && npm run dev
```

## What this shows

The `upsert()` call lowers to a single `MERGE` statement on MSSQL — atomic and race-safe.
