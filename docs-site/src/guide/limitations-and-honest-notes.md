---
title: "Limitations and honest notes"
---

## Limitations and honest notes

* **It is young.** No long production history, one main author. Treat it as
  early-stage. If a quiet data bug would be costly, test your own queries
  against it thoroughly first.
* **Primary keys are auto-generated strings, not sequential numbers, by default.**
  forge fills in a UUID (or ObjectId on Mongo) when you omit `id`. An
  auto-incrementing integer key is SQL-only via `f.id({ type: 'bigserial' })`.
* **One schema per process.** `createDb({ schema })` sets the active schema for
  the whole process. That fits one schema per service. For several different
  schemas at once, run them in separate processes.
* **Some nested writes are partial.** Deeply nested `upsert`, `update`, and
  `set` cover the common cases but not every Prisma shape.
* **MSSQL upsert is not implemented in 2.3** — it throws `NotImplemented`
  pointing at v2.4 (`MERGE` rewrite). INSERT / UPDATE / DELETE / SELECT work
  today.
* **Mongo cross-field geo `nearTo`** — a `near` filter on field A combined
  with a `nearTo` orderBy on field B will only honor B (single `$geoNear`
  stage limit). Same field on both sides works fine.
* **MultiPolygon, GeometryCollection, holes** — single-polygon
  `withinPolygon` works. Multi-ring shapes need raw queries.
* **3D / Z coordinates** — not modelled. Store altitude as a separate scalar.
* **SRID reprojection** — WGS84 only. UTM, state-plane, or other CRSes need
  raw queries.
* **MySQL 5.7** — spatial works but without SRID enforcement; `forge doctor`
  warns.
* **DuckDB** — no FK enforcement (forge's app-side cascade walker handles
  it); no `SAVEPOINT` (a failing migration batch can't partially recover);
  no partial indexes / `INCLUDE` columns / `ctid` (replaced with `rowid`
  where needed); unique constraints cover soft-deleted rows since there are
  no partial indexes.
* **No GUI, no plugin system.** If you need a data browser or middleware, this
  is not that.

---
