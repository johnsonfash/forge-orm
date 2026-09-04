---
title: Introduction
---

# Introduction

<div align="center">



**One Prisma-shaped query API. Six databases. No codegen.**

[![npm version](https://img.shields.io/npm/v/forge-orm?color=cb3837&label=npm&logo=npm)](https://www.npmjs.com/package/forge-orm)
[![downloads](https://img.shields.io/npm/dm/forge-orm?color=cb3837&label=downloads)](https://www.npmjs.com/package/forge-orm)
[![stars](https://img.shields.io/github/stars/johnsonfash/forge-orm?style=flat&color=f5a623&logo=github)](https://github.com/johnsonfash/forge-orm/stargazers)
[![ci](https://github.com/johnsonfash/forge-orm/actions/workflows/ci.yml/badge.svg)](https://github.com/johnsonfash/forge-orm/actions/workflows/ci.yml)
[![examples](https://github.com/johnsonfash/forge-orm/actions/workflows/examples.yml/badge.svg)](https://github.com/johnsonfash/forge-orm/actions/workflows/examples.yml)
[![license](https://img.shields.io/npm/l/forge-orm?color=blue)](./LICENSE)
[![types](https://img.shields.io/npm/types/forge-orm?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)

**[Documentation](https://johnsonfash.github.io/forge-orm/)** ·
[Quick start](https://johnsonfash.github.io/forge-orm/guide/install-and-pick-your-driver) ·
[Examples](https://github.com/johnsonfash/forge-orm/tree/main/examples) ·
[Changelog](/reference/changelog)

</div>

---

A small, Prisma-shaped data layer for **MongoDB, PostgreSQL, MySQL, SQLite,
DuckDB and SQL Server**. You write your models once in plain TypeScript and
the same query code runs against any of the six databases. There is no code
generation step, no Rust query engine, and no framework to adopt — just
readable TypeScript over the official drivers, organised one adapter per
database.

```sh
npm install forge-orm
```

> **📖 The full documentation reads far better as a website:
> [johnsonfash.github.io/forge-orm](https://johnsonfash.github.io/forge-orm/)** —
> same content, with a sidebar, search, and one page per topic instead of
> three thousand lines of scroll.

| | | |
|---|---|---|
| 🐘 PostgreSQL | 🐬 MySQL / MariaDB | 🪶 SQLite |
| 🍃 MongoDB | 🦆 DuckDB | 🟦 SQL Server |
| 🌐 Browser (sqlite-wasm) | 💾 Browser (IndexedDB) | ⚡ PGlite (embedded PG) |

```ts
import { createDb, f, model } from 'forge-orm';

const User = model('users', {
  id:    f.id(),
  email: f.string().unique(),
  name:  f.string(),
});

const db = await createDb({ url: process.env.DATABASE_URL!, schema: { user: User } });

const alice = await db.user.create({ data: { email: 'a@x.co', name: 'Alice' } }); // no id needed
const users = await db.user.findMany({ where: { name: { contains: 'Ali' } }, take: 10 });
```

The same code works whether `DATABASE_URL` is a Postgres, MySQL, SQLite,
DuckDB, SQL Server, or Mongo connection string. forge picks the right
driver from the URL prefix (`postgres:`, `pglite:`, `mysql:`, `sqlite:`, `duckdb:`,
`mssql:`, `mongodb:`).

Beyond the basics, forge ships first-class typed support for the things
you usually have to drop to raw SQL for:

* **Geo** — `f.geoPoint()` + `near` / `nearTo` / `withinPolygon`,
  compiling to PostGIS / MySQL spatial / SpatiaLite / DuckDB spatial /
  MSSQL `GEOGRAPHY` / Mongo `2dsphere`. App-side Haversine fallback when
  no spatial extension is installed.
* **Vector similarity** — `f.vector(1536, { metric: 'cosine' })` + the
  same `near` / `nearTo` vocabulary, compiling to pgvector / DuckDB vss
  HNSW / MSSQL `VECTOR_DISTANCE` / MySQL 9 `DISTANCE` / sqlite-vec /
  Mongo Atlas `$vectorSearch`.
* **JSON path queries** — `where: { meta: { path: 'profile.age', gte: 18 } }`
  on any `f.json()` / `f.embed()` / `f.embedMany()` / array column,
  compiling to PG `->/->>`, MySQL `JSON_EXTRACT`, SQLite / DuckDB
  `json_extract`, MSSQL `JSON_VALUE`, Mongo dotted-key form.
* **Full-text search** — `f.text().searchable()` builds the right index
  per dialect (Postgres GIN tsvector, MySQL `FULLTEXT`, SQLite FTS5 with
  shadow-table triggers, Mongo `text`, DuckDB `fts`) and the `search`
  operator queries it.

---
