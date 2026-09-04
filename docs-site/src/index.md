---
layout: home

hero:
  name: forge-orm
  text: One query API. Six databases.
  tagline: >-
    A small, Prisma-shaped data layer for MongoDB, PostgreSQL, MySQL, SQLite,
    DuckDB and SQL Server. Write your models once in plain TypeScript — no
    codegen step, no query engine, no framework to adopt.
  actions:
    - theme: brand
      text: Get started
      link: /guide/install-and-pick-your-driver
    - theme: alt
      text: Introduction
      link: /guide/introduction
    - theme: alt
      text: Reference
      link: /reference/model
    - theme: alt
      text: GitHub
      link: https://github.com/johnsonfash/forge-orm

features:
  - icon: 🗄️
    title: Six databases, one code path
    details: >-
      The same findMany, upsert and transaction run against Postgres, MySQL,
      SQLite, Mongo, DuckDB and SQL Server. One adapter per database, over the
      official drivers.
    link: /guide/connecting
    linkText: Connecting

  - icon: 🧩
    title: No codegen, full autocomplete
    details: >-
      Types come from your schema object through inference, so there is no
      generated client to regenerate, commit, or get out of sync with the code
      it types.
    link: /guide/type-safety
    linkText: Type safety

  - icon: 🌐
    title: Runs in the browser
    details: >-
      sqlite-wasm over OPFS, or IndexedDB with zero install. Same API as the
      server, including runtime migrations and drift detection.
    link: /guide/browser-sqlite-wasm--opfs
    linkText: Browser

  - icon: 🔍
    title: See the SQL before it runs
    details: >-
      db.$explain() returns the statement and parameters for a call site without
      executing it, and the database's own query plan on request.
    link: /guide/seeing-a-query-without-running-it--dbexplain
    linkText: $explain

  - icon: 🚧
    title: Migrations that refuse to guess
    details: >-
      Generate from a committed snapshot with no database. A narrowing type
      change, an unannotated rename, or a drop with data is refused with the
      correction printed.
    link: /guide/creating-tables-and-migrations
    linkText: Migrations

  - icon: 📚
    title: Eighty-three deep dives
    details: >-
      Every surface has a companion reference — per-dialect emit tables, worked
      patterns, edge cases, and the honest notes about what does not work.
    link: /reference/model
    linkText: Reference
---
