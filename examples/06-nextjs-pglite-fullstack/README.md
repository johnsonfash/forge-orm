# 06 · Next.js + PGlite (full-stack)

[![Open in StackBlitz](https://developer.stackblitz.com/img/open_in_stackblitz.svg)](https://stackblitz.com/github/johnsonfash/forge-orm-examples/tree/main/06-nextjs-pglite-fullstack)

Next.js App Router + Server Actions calling forge-orm directly. PGlite means no external Postgres — works in WebContainer.

To target a real Postgres, swap `pglite:./.pgdata` → `process.env.DATABASE_URL`.
