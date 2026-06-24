# Postgres

forge-orm's most feature-rich dialect. This page documents the Postgres-specific behavior: drivers, type round-trip, extensions, transaction quirks, and the patterns that make Postgres-with-forge production-ready.

## Contents

* [Driver matrix](#driver-matrix) — pg, postgres.js, Neon HTTP, Hyperdrive
* [DDL forge emits](#ddl-forge-emits) — types, defaults, sequences, IDENTITY, ENUM emit
* [Type round-trip](#type-round-trip) — every `f.*` type → Postgres column → JS value
* [JSONB](#jsonb) — JSONB vs JSON, GIN indexes, path queries
* [Arrays](#arrays) — native `text[]` / `integer[]`, gotchas
* [Extensions](#extensions) — pgvector, postgis, pgcrypto, citext, ltree, hstore
* [UUID generation](#uuid-generation) — `gen_random_uuid()`, `uuid_generate_v4`, UUIDv7 patterns
* [Transactions and isolation](#transactions-and-isolation) — READ COMMITTED vs REPEATABLE READ vs SERIALIZABLE, advisory locks
* [CONCURRENTLY index creation](#concurrently-index-creation)
* [LISTEN / NOTIFY](#listen--notify)
* [Partitioned tables and row-level security](#partitioned-tables-and-row-level-security)
* [Replication and read replicas](#replication-and-read-replicas)
* [Per-statement timeouts](#per-statement-timeouts)
* [Connection pooling — PgBouncer caveats](#connection-pooling--pgbouncer-caveats)
* [Common errors and fixes](#common-errors-and-fixes)
* [Cross-references](#cross-references)

---

## Driver matrix

forge's Postgres adapter talks to a normalized port, `PostgresDriver`,
defined in `src/adapters/postgres/driver.ts`. The executor only ever
calls `query(sql, params)`, so any client that can be wrapped into the
port is a valid backend. Four wrappers are interesting in practice:
`pg`, `postgres.js`, `@neondatabase/serverless` (Pool and HTTP), and
clients sitting behind Cloudflare Hyperdrive.

| Wrapper | Module | Connection string | Pooling | Streams | Transactions | Best at |
|---|---|---|---|---|---|---|
| `pgDriver` (default) | `pg` | `postgres://…` | `pg.Pool` (process-local) | Server-side cursor (`DECLARE … CURSOR`) | Pinned `PoolClient`, `BEGIN`/`COMMIT` | Long-lived Node, real cursors, advisory locks |
| `postgresJsDriver` | `postgres` (porsager) | `postgres://…` | Built-in, `max` on `postgres()` | None (no `stream?`) | `sql.begin(fn)` | Faster simple queries on Node 20+, binary protocol bulk inserts |
| `pgDriver` over Neon WebSocket Pool | `@neondatabase/serverless` | `postgres://…neon.tech/…` | Mimics `pg.Pool` | Falls back to OFFSET/LIMIT | Yes — WebSocket session | Serverless functions with transactions |
| `neonHttpDriver` (custom wrap) | `@neondatabase/serverless` (`neon()`) | `postgres://…neon.tech/…` | None — per-request HTTP | Falls back to OFFSET/LIMIT | **Throws** — HTTP is single-shot | Edge runtime reads (Workers, Vercel Edge) |
| `pgDriver` behind Hyperdrive | `pg` | `postgres://user:pass@<hyperdrive-id>.hyperdrive.cf` | Hyperdrive multiplexes | Yes (Hyperdrive forwards) | Yes — Hyperdrive holds a session-mode pool | Cloudflare Workers with full PG features |

`pg` is the default the adapter picks from the URL prefix. If you don't
construct a driver and just pass `url`, forge calls `loadDriver('postgres',
url)` which `require`s the `pg` package, opens a `Pool`, and runs a
`SELECT 1` probe so auth/host errors surface at `connect()`, not at the
first query.

```ts
// Default — URL only.
import { createDb } from 'forge-orm';
await createDb({ url: process.env.DATABASE_URL!, schema });

// Custom pool sizing — own the pool, hand it to pgDriver.
import { Pool } from 'pg';
import { createDb, pgDriver } from 'forge-orm';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 8, min: 0,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
  statement_timeout: 10_000,
});
export const db = await createDb({ schema, driver: pgDriver(pool) });
```

### postgres.js (porsager)

```ts
import postgres from 'postgres';
import { createDb, postgresJsDriver } from 'forge-orm';

const sql = postgres(process.env.DATABASE_URL!, {
  max: 10,
  idle_timeout: 30,
  // PgBouncer transaction-pooling needs prepared statements off — see below.
  prepare: false,
});
export const db = await createDb({ schema, driver: postgresJsDriver(sql) });
```

Wire-compatible. The compiler emits the same SQL; the wrapper translates
`{ rows, rowCount }` into and out of postgres.js's array-with-`.count`
result shape. Transactions delegate to `sql.begin(fn)` — different
implementation, identical contract.

### Neon

Neon ships two surfaces. The WebSocket `Pool` matches `pg.Pool`
directly:

```ts
import { Pool } from '@neondatabase/serverless';
import { createDb, pgDriver } from 'forge-orm';

const pool = new Pool({ connectionString: process.env.NEON_DATABASE_URL! });
export const db = await createDb({ schema, driver: pgDriver(pool) });
```

The tagged-template HTTP transport — `neon(connStr)` — is per-request,
no socket. It can't hold a transaction across calls, so the wrap throws
from `transaction`:

```ts
import type { PostgresDriver } from 'forge-orm';
import { neon } from '@neondatabase/serverless';

export function neonHttpDriver(sql: ReturnType<typeof neon>): PostgresDriver {
  return {
    kind: 'postgres',
    query: async (text, params) => {
      const r = await sql.unsafe(text, (params ?? []) as any[]);
      return { rows: r as any[], rowCount: (r as any).rowCount ?? (r as any[]).length };
    },
    transaction: async () => {
      throw new Error('[forge] neon HTTP transport does not support transactions');
    },
    close: async () => { /* stateless */ },
  };
}
```

Use it for single-round-trip reads on the edge; switch to the
WebSocket `Pool` the moment you need a tx.

### Cloudflare Hyperdrive

Hyperdrive is a session-mode connection pool fronting any Postgres.
From the Worker it looks like a regular Postgres URL — point `pg` at it
and the WebSocket layer takes care of routing.

```ts
import { Pool } from 'pg';
import { createDb, pgDriver } from 'forge-orm';

export default {
  async fetch(_req, env: { HYPERDRIVE: { connectionString: string } }) {
    const pool = new Pool({ connectionString: env.HYPERDRIVE.connectionString, max: 5 });
    const db = await createDb({ schema, driver: pgDriver(pool) });
    try { /* … */ } finally { await pool.end(); }
  },
};
```

Hyperdrive runs in **session mode**, so prepared statements, server-
side cursors, `LISTEN/NOTIFY`, and transactions all work. The one
constraint is per-isolate connection lifetime: open the pool inside the
handler, close before return. Don't pin globals at module level —
isolates outlive individual requests, not connections.

---

## DDL forge emits

`buildSchemaDDL(schema)` (in `src/adapters/postgres/ddl.ts`) walks the
schema in three passes and produces a list of `DDLStatement` objects —
each is a single SQL string with a deterministic name the migrator can
reconcile against `pg_class` / `pg_constraint` / `pg_indexes`.

Pass 1: tables (`CREATE TABLE IF NOT EXISTS …`).
Pass 2: per-field unique constraints, composite uniques, foreign keys,
enum CHECK constraints, indexes, FTS GIN indexes for `.searchable()`
fields.
Pass 3: views (`CREATE OR REPLACE VIEW` / `CREATE MATERIALIZED VIEW IF
NOT EXISTS`).

Every constraint and index name is prefixed `forge_<table>_<kind>_<parts>`
and hash-collapsed when it exceeds Postgres's 63-byte identifier limit.
That naming convention is what makes drift detection idempotent — the
migrator looks up names, not SQL bodies.

### Defaults

| `FieldDef` | Emitted default |
|---|---|
| `.default('now')` | `DEFAULT now()` |
| `.default(42)` | `DEFAULT 42` |
| `.default('foo')` | `DEFAULT 'foo'` (single-quoted, escaped) |
| `.default(true)` | `DEFAULT TRUE` |
| `.default({ a: 1 })` | `DEFAULT '{"a":1}'::jsonb` |
| `f.uuid({ default: 'gen_random_uuid' })` | `DEFAULT gen_random_uuid()` |
| `f.embedMany(…)` (non-optional) | `DEFAULT '[]'::jsonb` |

`autoId` defaults emit nothing — forge generates ObjectId-flavour ids in
the wrapper before insert.

### Primary keys

Three `idType` strategies. forge picks the column type per kind:

| `f.id()` form | Postgres column | Default emitted | Sequence? |
|---|---|---|---|
| `f.id()` (default `'auto'`) | `text` | none — wrapper generates | no |
| `f.id({ type: 'uuid' })` | `uuid` | none (declare with `f.uuid({ default: 'gen_random_uuid' })` for DB-side) | no |
| `f.id({ type: 'bigserial' })` | `bigserial` | implicit `nextval(…)` | yes — implicit sequence |

`bigserial` expands to `BIGINT NOT NULL DEFAULT nextval('<table>_<col>_seq'::regclass)`
plus the sequence. The DDL builder recognises this and skips the usual
`NOT NULL`/default rendering — appending them again is a syntax error.
The sequence object is dropped on `DROP TABLE … CASCADE`.

### IDENTITY columns

forge currently emits `bigserial`, not `GENERATED BY DEFAULT AS IDENTITY`.
For pure-PG schemas where you want IDENTITY semantics — e.g. the
`OVERRIDING SYSTEM VALUE` opt-out for backfills — declare the column as
`f.bigint()` and ride a manual sequence created via raw SQL:

```ts
await db.$executeRaw`
  ALTER TABLE invoices
  ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (START WITH 10000)
`;
```

Drift detection treats sequence ownership as orthogonal to the column
declaration — running `forge push` after this raw step will not try to
rewrite the column.

### ENUM emit

forge does **not** emit Postgres native `CREATE TYPE … AS ENUM`.
`f.enumOf(['DRAFT', 'PUB'])` becomes `text NOT NULL` with a `CHECK`:

```sql
ALTER TABLE "posts"
  ADD CONSTRAINT "forge_posts_enum_status"
  CHECK ("status" IN ('DRAFT', 'PUB'));
```

Why: native enums need `ALTER TYPE … ADD VALUE` to grow, which can't run
inside a transaction. Adding a value via the schema would require a
multi-step migration; the CHECK approach grows in-place inside the same
`forge push`. Tradeoff: native enums are slightly cheaper to store (4
bytes vs. text), and they show up in `\dT+`. The CHECK form wins on
ergonomics; reach for raw SQL if you specifically need a native enum.

### GENERATED columns

`.dbgenerated('"price" * "qty"')` emits a `GENERATED ALWAYS AS (…) STORED`
column. The expression governs nullability — forge never adds an explicit
`NOT NULL` or default to a generated column. Use these for computed
totals, derived bounding boxes (`ST_Envelope(geom)`), or extracted JSONB
paths kept in their own indexed column.

```ts
total: f.decimal().dbgenerated('"unit_price" * "qty"'),
// →  ALTER TABLE … "total" numeric GENERATED ALWAYS AS ("unit_price" * "qty") STORED
```

### Materialized views

A model with `view: { sql: '…', materialised: true }` emits `CREATE
MATERIALIZED VIEW IF NOT EXISTS`. Refresh is a `REFRESH MATERIALIZED VIEW
<name>` issued via `adapter.refreshView(model, { concurrently? })`.
`CONCURRENTLY` needs a unique index on the matview, so it's opt-in —
declare a `uniques` on the model so the index exists before turning it
on.

---

## Type round-trip

Every `f.*` builder maps to one Postgres column type. The round-trip
back to JS is whatever the `pg` (or postgres.js) type parser hands you,
optionally massaged in `decodeOutbound`. For Postgres specifically,
forge's `decodeOutbound` is a pass-through — `pg`'s parsers already give
sensible JS types — but **numeric values come back as strings** to
preserve precision, which is by design.

| Builder | Postgres column | JS read shape | Notes |
|---|---|---|---|
| `f.id()` | `text` PRIMARY KEY | `string` | wrapper-generated, ObjectId-flavour token |
| `f.id({ type: 'uuid' })` | `uuid` PRIMARY KEY | `string` | `pg` parses to a string |
| `f.id({ type: 'bigserial' })` | `bigserial` PRIMARY KEY | `number` | wraps to string if > `MAX_SAFE_INTEGER` — set `pg.types.setTypeParser(20, …)` to force bigint |
| `f.objectId()` | `text` | `string` | foreign-key style; pure-PG schemas use `uuid` instead |
| `f.string()` | `text` | `string` | PG `text` is unlimited; no `VARCHAR(N)` ceiling |
| `f.text()` | `text` | `string` | identical on PG (the distinction is MySQL-only) |
| `f.int()` | `integer` | `number` | 32-bit, fits in `Number` |
| `f.float()` | `double precision` | `number` | 64-bit IEEE |
| `f.decimal({ precision, scale })` | `numeric(p, s)` | **`string`** | preserves exact precision; pass `decimalNumbers: true` on `pg.Pool` to convert to JS `number` (loses precision past 15 digits) |
| `f.decimal()` (no p/s) | `numeric` | `string` | unbounded numeric |
| `f.uuid()` | `uuid` | `string` | `pg` parses to lowercase hex |
| `f.bigint()` | `bigint` | `string` by default | `pg` parses bigint as string to avoid `Number` precision loss; install a custom parser to get `BigInt` |
| `f.bool()` | `boolean` | `boolean` | |
| `f.dateTime()` | `timestamptz` | `Date` | UTC-stored; `pg` parses through `Date` constructor |
| `f.json()` | `jsonb` | object/array/scalar | parsed by `pg`'s JSON parser |
| `f.enumOf([...])` | `text` + `CHECK` | `string` | CHECK constraint enforces membership |
| `f.embed(() => …)` | `jsonb` | object | shape derived from the embed definition |
| `f.embedMany(() => …)` | `jsonb` DEFAULT `'[]'::jsonb` | array | optional embedManys stay nullable |
| `f.stringArray()` | `text[]` | `string[]` | native array — see [Arrays](#arrays) |
| `f.intArray()` | `integer[]` | `number[]` | native array |
| `f.geoPoint()` | `geography(Point, 4326)` | `{ lng, lat }` | needs PostGIS; falls back to `jsonb` with `{ fallback: true }` |
| `f.geoPoint({ dims: 3 })` | `geography(PointZ, 4326)` | `{ lng, lat, alt }` | 3D point on the WGS84 sphere |
| `f.geoPoint({ srid: 3857 })` | `geometry(Point, 3857)` | `{ lng, lat }` | non-WGS84 falls off `geography` onto `geometry` |
| `f.vector({ dims: 1536 })` | `vector(1536)` | `number[]` | needs `CREATE EXTENSION vector` |

### Numeric returning as string

This is the single biggest type-round-trip surprise on Postgres. The
`pg` driver's default `numeric` parser returns a string, because the
underlying value can carry more precision than IEEE-754 affords:

```ts
const { unit_price } = await db.product.findUniqueOrThrow({ where: { id } });
// unit_price is a string like "19.99", NOT a number.
unit_price * 1.07;  // NaN
```

Three ways out:

1. **Use `decimal.js` or `BigNumber.js`** — the right answer for money.
   forge keeps the field typed as `string` so this is the obvious path.
2. **Cast at read time** — `Number(unit_price)` if you know the value
   fits in 15 digits.
3. **Override the parser** — early in startup:

   ```ts
   import pg from 'pg';
   pg.types.setTypeParser(1700, (v) => parseFloat(v));  // 1700 = NUMERIC
   ```

   Affects every `numeric` column the pool reads. Don't do this for
   money.

### Date / timestamptz

`f.dateTime()` emits `timestamptz`, which Postgres stores as UTC and
returns adjusted to the session timezone. `pg` parses via `new Date(…)`,
which lands a UTC instant. Two things to watch:

* **Session timezone matters at write time** for `now()` defaults that
  flow through the session's `SET TIME ZONE`. Default is the cluster
  default (usually UTC); override per-pool with
  `process.env.PGTZ = 'UTC'` or `SET TIME ZONE 'UTC'` as the first
  statement.
* **Precision** — `timestamptz` defaults to 6 fractional digits. JS
  `Date` is millisecond-precise, so the last 3 digits are zero on
  reads. Use `bigint` epoch ns if you need sub-millisecond precision.

---

## JSONB

forge picks `jsonb` for every JSON-shaped field — `f.json()`, `f.embed()`,
`f.embedMany()`. The dialect's `columnType` (`src/adapters/postgres/dialect.ts`)
returns the string `'jsonb'` for all three.

Why JSONB and not JSON: JSONB is parsed once at insert, stored as a binary
tree, and supports GIN indexes. The only thing plain JSON preserves that
JSONB drops is exact whitespace and key order — neither is relevant once
the data is in the database.

### When you'd want plain JSON

Round-trip preservation of a third-party payload that you'll later
hand back verbatim. Sign-event webhooks, audit logs of raw vendor JSON.
forge has no first-class switch for plain `json` — declare a `f.text()`
column and serialise yourself. The cost of forfeiting JSONB indexing
should be a deliberate decision.

### GIN indexes on JSONB

GIN is the index method for "is this JSONB containing / matching X". For
a JSONB column you query with `@>` or `?`, add a GIN index via the
schema's index list with `method: 'gin'`:

```ts
defineModel({
  collection: 'events',
  fields: { id: f.id(), payload: f.json() },
  indexes: [
    { keys: { payload: 1 }, method: 'gin' },
  ],
});
```

That compiles to:

```sql
CREATE INDEX IF NOT EXISTS "forge_events_idx_payload"
  ON "events" USING gin ("payload")
```

For path-targeted queries (`payload->>'user_id' = $1`), an expression
index over the path is cheaper:

```ts
indexes: [
  { expression: `("payload"->>'user_id')`, name: 'forge_events_user_id_idx' },
],
```

### Path queries

forge's JSON path operator (`where: { payload: { path: ['user_id'] } }`)
compiles per-dialect via `jsonPathExpr`. On Postgres the read is
`(col->'a'->'b'->>'c')::<cast>`, where the cast depends on the operand
type — text comparisons stay as text, numeric comparisons cast to
`numeric`, boolean to `boolean`. See [JSON-PATH](./JSON-PATH.md) for the
full operator reference.

---

## Arrays

`f.stringArray()` and `f.intArray()` map to native Postgres array types
(`text[]` and `integer[]`). The wrapper hands the array straight through
to `pg`'s array binder; the driver returns a JS array.

```ts
const u = await db.user.findUniqueOrThrow({ where: { id } });
u.tags         // string[] from text[]
u.scores       // number[] from integer[]
```

### Gotchas

* **No element-level uniqueness or NOT NULL inside an array.** The
  Postgres type system doesn't carry constraints into array elements.
  If you need "no empty strings in this array", validate in
  application code or add a CHECK using `array_position(tags, '')`.

* **Operator coverage is limited.** forge supports `equals` and basic
  containment on arrays. For `tags @> '{x,y}'` (does the array contain
  every value), reach for `$queryRaw`:

  ```ts
  const events = await db.$queryRaw`
    SELECT * FROM events WHERE tags @> ${['security', 'p0']}::text[]
  `;
  ```

* **Empty arrays vs. NULL.** `''::text[]` is a syntax error; the empty
  array literal is `'{}'::text[]`. forge passes `[]` through to `pg`
  which handles the boundary correctly. Reads of NULL arrays come back
  as `null`, not `[]`. Declare `.optional()` if NULL is meaningful;
  otherwise initialise to `[]` on insert.

* **GIN index for `@>` queries.** Same recipe as JSONB:
  `{ keys: { tags: 1 }, method: 'gin' }`. Without it, `@>` table-scans.

### When to use JSONB instead

`text[]` is right for "an unordered set of tags". JSONB wins when the
elements have structure (`[{ key, value }]`), when you want path queries
into the elements, or when the array might mix scalar types. Arrays are
the cheaper choice when the elements are uniform scalars and you query
with `ANY`/`ALL`/`@>`.

---

## Extensions

forge doesn't `CREATE EXTENSION` for you. The runtime adapter expects
the extensions it uses (pgvector, PostGIS) to be present, and surfaces
SQLSTATE `42704` (`type "vector" does not exist`) etc. as a `P2022` if
they aren't. The doctor probe (see [DOCTOR](./DOCTOR.md)) reports the
extensions installed in the current database so you can spot the gap
before pushing.

The list in practice:

| Extension | Why forge needs it | `CREATE EXTENSION` ordering |
|---|---|---|
| `pgcrypto` | `gen_random_uuid()` for `f.uuid({ default: 'gen_random_uuid' })`. Postgres 13+ ships `gen_random_uuid` in core, so this is only needed on older clusters. | Before any `forge push` that creates a uuid-defaulted column |
| `vector` (pgvector) | `vector(N)` column type, distance operators, HNSW index | Before tables that declare `f.vector()`; HNSW operator classes register on `CREATE EXTENSION` |
| `postgis` | `geography`/`geometry` types, `ST_*` functions | Before tables that declare `f.geoPoint()` |
| `citext` | Case-insensitive text columns. forge doesn't emit `citext` directly — declare a column as raw SQL via `dbgenerated` or post-migrate `ALTER COLUMN TYPE`. | Before columns that use it |
| `ltree` | Hierarchical labels (forum categories, file paths). No forge primitive — raw `ltree` columns via `$executeRaw` DDL. | Before columns that use it |
| `hstore` | Legacy key-value column. JSONB is the modern answer; hstore is kept around for compatibility with older schemas. | Before columns that use it |
| `pg_trgm` | Trigram similarity indexes for fuzzy text search. Pair with a GIN index using `gin_trgm_ops`. | Before the trigram index |

### Bootstrapping extensions

Run extensions before `forge push`:

```ts
import { Pool } from 'pg';
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
await pool.query(`CREATE EXTENSION IF NOT EXISTS pgcrypto`);
await pool.query(`CREATE EXTENSION IF NOT EXISTS vector`);
await pool.query(`CREATE EXTENSION IF NOT EXISTS postgis`);
```

On managed Postgres (RDS, Neon, Supabase) the cluster owner has to
allowlist the extension first — `CREATE EXTENSION` from a non-owner
fails with SQLSTATE `42501`. `adapter.doctor()` reports the missing
extensions for the schema you're about to push; pair with `forge push
--plan` to dry-run.

---

## UUID generation

Three layers stack here: `f.id({ type: 'uuid' })` (the primary-key
strategy), `f.uuid({ default: 'gen_random_uuid' })` (the DB-side default
on any uuid column), and application-side UUIDv7 generation when you
want sortable ids.

### App-generated UUIDs

`f.id({ type: 'uuid' })` declares a `uuid PRIMARY KEY` column with **no**
default — the wrapper generates the id app-side. The trade-off vs. DB-
side is that the id is known before insert (which simplifies write-
ahead logging) at the cost of importing a generator:

```ts
import { v4 as uuidv4 } from 'uuid';
await db.user.create({ data: { id: uuidv4(), email: 'me@x.co' } });
```

### DB-generated UUIDs (`gen_random_uuid`)

`f.uuid({ default: 'gen_random_uuid' })` emits the column with `DEFAULT
gen_random_uuid()`. Postgres 13+ ships `gen_random_uuid` in core; older
clusters need `CREATE EXTENSION pgcrypto`. forge keys off the `uuidDefault`
field flag in the DDL builder:

```ts
fields: {
  id: f.uuid({ default: 'gen_random_uuid' }),
  // …
}
// →  "id" uuid NOT NULL DEFAULT gen_random_uuid()
```

The caller can omit `id` on insert; the database fills it in. On read,
`pg` parses the value to a lowercase hex string.

`uuid-ossp` provides the older `uuid_generate_v4()` — functionally
equivalent. Pick `gen_random_uuid` for new schemas; it's in core.

### UUIDv7 — sortable ids

UUIDv7 packs a millisecond timestamp into the high bits, so values
generated on the same machine sort lexicographically by creation time.
That makes them dramatically friendlier to B-tree indexes than v4 (no
random scatter across the page tree).

Postgres doesn't ship `uuid_generate_v7()` yet (as of PG 16). Two paths:

1. **App-side generation** — `import { v7 } from 'uuid'` (uuid v9.0+) and
   pass the value yourself. The simplest answer.
2. **DB-side function** — install a community `uuidv7()` (e.g.
   `postgres-uuidv7`) and `ALTER TABLE … ALTER COLUMN id SET DEFAULT
   uuidv7()` after push. The differ doesn't compare default expressions
   on uuid columns, so the override survives subsequent pushes.

UUIDv7's win on index size and write throughput is large enough that
it's the default recommendation for new uuid-keyed tables expecting
more than a few million rows.

---

## Transactions and isolation

`db.$transaction(fn)` opens a `pgDriver.transaction(fn)` call, which
checks a client out of the pool, runs `BEGIN`, calls `fn` with a
`PgQueryable` bound to that client, and `COMMIT`s on success or
`ROLLBACK`s on throw. Every executor call inside the callback receives
that queryable via `ExecOpts.session`, so reads and writes inside the tx
land on the same connection.

```ts
await db.$transaction(async (tx) => {
  const acct = await tx.account.findUniqueOrThrow({ where: { id } });
  await tx.account.update({ where: { id }, data: { balance: acct.balance - 100 } });
});
```

### The three isolation levels

PG's default is **READ COMMITTED**. forge does not override it.

| Level | What you get | When to use |
|---|---|---|
| `READ COMMITTED` (default) | Each statement sees the latest committed snapshot. Reads inside the tx can change between statements. | Most CRUD; default for HTTP handlers |
| `REPEATABLE READ` | The whole tx sees one snapshot, taken at the first non-transaction-block statement. No phantoms inside the tx. Serialization failures on write conflicts. | Reports that read multiple tables and need a consistent view |
| `SERIALIZABLE` | True serializability — predicates and all. Concurrent transactions that would conflict get one rolled back with SQLSTATE `40001`. | Money movements, inventory reservations, anything where "two simultaneous reads + writes both succeeding" is incorrect |

Override per-transaction with a `SET TRANSACTION` as the first statement:

```ts
await db.$transaction(async (tx) => {
  await tx.$executeRaw`SET TRANSACTION ISOLATION LEVEL SERIALIZABLE`;
  // …
});
```

For `REPEATABLE READ` or `SERIALIZABLE`, code defensively: forge maps
SQLSTATE `40001` to `P2034`. Wrap the call in a small retry that backs
off on `P2034` (and `40P01` deadlock) before giving up — see [Common
errors and fixes](#common-errors-and-fixes) below.

### The aborted-transaction trap

Postgres marks the whole tx as failed after **any** statement error and
the next statement gets `current transaction is aborted, commands ignored
until end of transaction block`. Forge rolls back cleanly and reports the
original error — but catch-and-continue inside a tx body doesn't work the
way it does outside one:

```ts
// Wrong — second .create runs on an aborted tx.
await db.$transaction(async (tx) => {
  try { await tx.user.create({ data: { email } }); }
  catch (e) { /* swallow */ }
  await tx.user.create({ data: { email: alt } });   // throws aborted-tx
});
```

Two workarounds:

1. **Branch before the failing call.** Check existence with
   `findUnique`, or use `upsert` (`ON CONFLICT DO UPDATE`) so the second
   path is the same statement.
2. **Wrap the risky statement in a savepoint.** PG savepoints survive
   inner errors:

   ```ts
   await db.$transaction(async (tx) => {
     await tx.$executeRaw`SAVEPOINT sp1`;
     try { await tx.user.create({ data: { email } }); }
     catch { await tx.$executeRaw`ROLLBACK TO SAVEPOINT sp1`; }
     await tx.user.create({ data: { email: alt } });   // works
   });
   ```

### Advisory locks

PG advisory locks are session- or transaction-scoped 64-bit lock ids
that *aren't* tied to any row. Use them for "only one process should run
this leader task" patterns. forge uses them internally for migrations —
`applyMigration` takes `pg_advisory_xact_lock($1, $2)` with the constant
pair `0x6f6f7267` / `0x65000001` (the bytes spell `forge\0\0\1`) so two
concurrent `forge push` runs serialise instead of trampling each other.

In application code:

```ts
await db.$transaction(async (tx) => {
  const [{ locked }] = await tx.$queryRaw<[{ locked: boolean }]>`
    SELECT pg_try_advisory_xact_lock(${LEADER_LOCK_ID}) AS locked
  `;
  if (!locked) return;       // another worker has it; bail
  await doExclusiveWork(tx);
  // lock released at COMMIT — pg_advisory_xact_lock is tx-scoped
});
```

Two flavours:

* `pg_advisory_lock(id)` / `pg_advisory_unlock(id)` — session-scoped,
  manually released. Survives across transactions on the same
  connection.
* `pg_advisory_xact_lock(id)` — transaction-scoped, released at
  `COMMIT` / `ROLLBACK`. Safer default.

Both have two-int variants (`pg_advisory_lock(hi, lo)`) for cross-driver
compatibility — some clients can't transmit a 64-bit int parameter.

---

## CONCURRENTLY index creation

`CREATE INDEX CONCURRENTLY` builds an index without an `ACCESS EXCLUSIVE`
lock on the table. Writers keep working through the build. The cost:
the operation can't run inside a transaction, takes two passes over the
table, and a failure leaves an invalid index behind that you have to
drop manually.

**forge does not emit `CONCURRENTLY` by default.** The reason is that
`forge push` wraps the whole DDL batch in `BEGIN … COMMIT` (so a single
failure rolls back a single statement via savepoint, while the rest of
the batch commits). `CONCURRENTLY` can't run inside that. For initial
push against an empty table the regular `CREATE INDEX IF NOT EXISTS` is
fast (no data) and the locking trade-off doesn't matter.

For adding an index to a live table after the fact, take it outside the
schema and run it as raw SQL on its own connection:

```ts
await pool.query(`
  CREATE INDEX CONCURRENTLY IF NOT EXISTS "events_user_created_idx"
    ON "events" ("user_id", "created_at" DESC)
`);
```

After the manual creation, declare the matching index in the schema so
drift detection treats it as already-present. The migrator looks up
indexes by name in `pg_indexes` — if the name matches what `buildIndex`
would have emitted, the next `forge push` skips it.

Naming convention: `forge_<table>_idx_<col1>_<col2>` (or `forge_<table>_idx_expr`
for expression indexes). The DDL builder reproduces this so the runtime
and manual paths agree.

Materialized views can also be refreshed concurrently (see [DDL forge
emits](#ddl-forge-emits)) — `adapter.refreshView(model, { concurrently:
true })` issues `REFRESH MATERIALIZED VIEW CONCURRENTLY` and needs a
unique index on the matview to do so.

---

## LISTEN / NOTIFY

Postgres's pub/sub: any session can `NOTIFY channel, 'payload'` and
every session that has `LISTEN`'d to that channel receives the message
when its connection is idle. Lightweight (the broadcast goes through
shared memory), but with caveats: payloads are capped at 8000 bytes and
the channel queue holds messages only while a session is listening.

forge doesn't surface `LISTEN/NOTIFY` as a first-class API — it's an
application pattern, not an ORM feature. Wire it up with raw SQL on a
**dedicated long-lived connection** outside the pool:

```ts
import { Client } from 'pg';

const listener = new Client({ connectionString: process.env.DATABASE_URL });
await listener.connect();
await listener.query('LISTEN events');

listener.on('notification', (msg) => {
  if (msg.channel === 'events') handleEvent(JSON.parse(msg.payload!));
});

// In the writer path — emits inside any tx
await db.$executeRaw`SELECT pg_notify('events', ${JSON.stringify(payload)})`;
```

Three rules:

1. **Listener is its own client, not pool-borrowed.** A pool returns the
   client between queries; the `LISTEN` registration is lost.
2. **NOTIFY inside a transaction queues until COMMIT.** Listeners don't
   see uncommitted notifications. This is the right semantics for "tell
   the world after I successfully wrote the row".
3. **Don't put the listener behind PgBouncer.** Transaction-mode pooling
   recycles the connection — the `LISTEN` evaporates. Connect direct, or
   use Hyperdrive (session-mode) for the listener and Hyperdrive (or
   PgBouncer) for the rest of the app.

For higher-volume pub/sub with replay and at-least-once delivery, write
to an outbox table and tail it from a poll-and-mark-consumed loop. See
[BACKEND](./BACKEND.md) for the full pattern.

---

## Partitioned tables and row-level security

forge's IR doesn't model partitions or RLS policies directly. Both are
fully supported — they live in DDL that the schema doesn't generate but
the runtime queries against transparently.

### Partitioned tables

Declarative partitioning (`PARTITION BY RANGE / LIST / HASH`) is a
Postgres-side concern. forge's `CREATE TABLE` emits a non-partitioned
table by default; to make it partitioned, add the partition clause via
raw SQL **before** the first push:

```sql
CREATE TABLE events (
  id        text PRIMARY KEY,
  org_id    text NOT NULL,
  ts        timestamptz NOT NULL DEFAULT now(),
  payload   jsonb NOT NULL
) PARTITION BY RANGE (ts);

CREATE TABLE events_2026_06 PARTITION OF events
  FOR VALUES FROM ('2026-06-01') TO ('2026-07-01');
```

Then declare the matching model with `defineModel({ collection: 'events',
… })`. The runtime queries `events` and the partition router does its
work transparently. The DDL builder's `CREATE TABLE IF NOT EXISTS` is
idempotent on the parent — it sees the table exists and moves on.

Caveat: the migrator can't add a `PARTITION BY` to a table that already
exists. Partitioning has to be decided before first push, or applied via
a `CREATE TABLE … PARTITION BY …; INSERT … SELECT; DROP …; ALTER … RENAME`
manual cutover.

### Row-level security

RLS policies are independent of the schema declaration. Push the schema,
then enable RLS and add policies via raw SQL:

```ts
await db.$executeRaw`ALTER TABLE events ENABLE ROW LEVEL SECURITY`;
await db.$executeRaw`
  CREATE POLICY events_org_isolation ON events
    USING (org_id = current_setting('app.org_id', true))
`;
```

The policy keys off a session variable. In the request handler, set the
variable before the query:

```ts
await db.$transaction(async (tx) => {
  await tx.$executeRaw`SET LOCAL app.org_id = ${orgId}`;
  return tx.event.findMany({ where: { type: 'login' } });
  //                                  ↑ Postgres adds: AND org_id = current_setting('app.org_id')
});
```

`SET LOCAL` lives only for the current transaction, so it doesn't leak
across pool borrows. This is the cleanest tenant-isolation pattern on
Postgres — it works with any forge query because the policy is enforced
below the SQL forge emits.

See [BACKEND](./BACKEND.md#tenant-isolation) for the full pattern,
including a recipe for swapping `current_setting` for a JWT claim via
`set_config()`.

---

## Replication and read replicas

Postgres replication is operational, not schema-level. forge's pattern:
**two adapters, two pools, one schema** — a primary for writes and one
or more replicas for reads.

```ts
import { createDb, pgDriver } from 'forge-orm';
import { Pool } from 'pg';

const writer = await createDb({
  schema,
  driver: pgDriver(new Pool({ connectionString: process.env.PG_PRIMARY })),
});
const reader = await createDb({
  schema,
  driver: pgDriver(new Pool({ connectionString: process.env.PG_REPLICA })),
});

// Write goes to primary
await writer.user.create({ data: { email } });
// Read can go to replica
const u = await reader.user.findUnique({ where: { email } });
```

The trap is **read-your-own-writes**. Streaming replication is
asynchronous; a read against the replica milliseconds after the write
on the primary can miss the row. Three options:

1. **Force reads after writes onto the primary.** Easiest pattern is
   "everything inside this HTTP handler hits the writer", which is the
   default if you only pass the writer to request-scoped code.

2. **Wait for replay.** `pg_last_wal_replay_lsn()` on the replica
   reports how far it's caught up. Bound by an upper LSN you remember
   from the write:

   ```ts
   const { rows } = await writer.$queryRaw`SELECT pg_current_wal_lsn() AS lsn`;
   const targetLsn = rows[0].lsn;
   // poll the replica until it has crossed targetLsn
   ```

3. **Synchronous replication.** Configure `synchronous_commit = on` and
   `synchronous_standby_names` on the primary. Writes don't return until
   one replica acknowledges. Most operators leave this off — the latency
   cost is real.

Connection routing usually lives above forge — either explicit ("read
paths use `reader`") or a custom driver that branches on `SELECT` vs.
write (fragile, rarely worth it). On Neon, read-replica branches expose
their own connection string; same `pgDriver`. On Supabase, pooler vs.
direct serves a related role (pooler is transaction-mode; direct is
session-mode).

---

## Per-statement timeouts

Three timeouts to set on every production pool. They're independent —
`statement_timeout` doesn't cover lock waits, `lock_timeout` doesn't
cover query execution, `idle_in_transaction_session_timeout` covers
neither:

| Setting | Bounds | Recommended default |
|---|---|---|
| `statement_timeout` | Total wall-clock time for a single statement | 10s for HTTP, 5min for jobs |
| `lock_timeout` | Time waiting to acquire a lock before giving up | 5s — enough to ride out usual contention, short enough to fail fast on a stuck transaction |
| `idle_in_transaction_session_timeout` | Time a tx can sit idle before being killed | 60s — kills runaway BEGIN-and-forget |

Set them per-pool:

```ts
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  statement_timeout: 10_000,
  lock_timeout: 5_000,
  idle_in_transaction_session_timeout: 60_000,
});
```

Or per-transaction with `SET LOCAL`:

```ts
await db.$transaction(async (tx) => {
  await tx.$executeRaw`SET LOCAL statement_timeout = 30000`;
  await runReport(tx);
});
```

When the timeout fires, Postgres throws SQLSTATE `57014` (query
canceled). forge maps it to `P2024`. Catch and degrade:

```ts
try {
  return await report();
} catch (e: any) {
  if (e.code === 'P2024') return { degraded: true, partial: cachedSnapshot };
  throw e;
}
```

---

## Connection pooling — PgBouncer caveats

For a single Node process talking to a single managed Postgres,
`pg.Pool` is enough. The math is "vCPUs × 2 connections per replica"
against the managed cluster's connection ceiling (RDS gives `max_connections`,
Neon gives 100 on free tier, etc.). Past ~8 replicas × 8 connections =
64 you're approaching the wall on most managed plans.

For Lambda / serverless / many-instance fan-out, you need
**PgBouncer in transaction mode** (or Hyperdrive, or Neon's pooler
endpoint — all the same shape). Transaction-mode pooling multiplexes
many short-lived client connections onto a small server-side pool.

forge is compatible with transaction-mode pooling out of the box, but
two settings on the driver have to be turned off because they require
session-pinned state that transaction pooling doesn't preserve:

### Prepared statements

`pg`'s default sends queries via the extended-query protocol with
implicit server-side prepared statements (keyed by the SQL text). The
prepared-statement handle lives on the server side and PgBouncer's
transaction-mode recycle would orphan it.

The fix differs by driver:

| Driver | How to disable prepares |
|---|---|
| `pg` | No client switch — but `pg` only prepares parameterised queries that go through `client.query(text, params)`, and forge always passes params, so each query is a one-shot prepare-bind-execute-deallocate. **As long as forge owns every call**, transaction-mode pooling works. Don't manually call `client.query({ text, name: 'foo' })` — naming a query turns on caching |
| `postgres.js` | Pass `prepare: false` to `postgres(url, …)` or `pgbouncer=true` on the URL. Disables the cache that postgres.js maintains client-side |
| `@neondatabase/serverless` (Pool) | No prepares — Neon's transport doesn't use them |

### Server-side cursors

`pgDriver.stream` uses `DECLARE … CURSOR FOR <sql>` inside a transaction
to stream large result sets. Cursors are session-scoped — transaction-
mode pooling can recycle the connection mid-stream and your `FETCH 200
FROM cursor` returns "cursor does not exist".

The stream wraps everything in `BEGIN … COMMIT`, so the cursor lives
exactly as long as the surrounding transaction. **PgBouncer hands the
same server connection to the client for the whole transaction**, so as
long as the cursor read happens inside the BEGIN/COMMIT, transaction-mode
is safe. forge's built-in stream does this — but custom streams that
keep a cursor open across transactions break.

### LISTEN / NOTIFY

Already covered above — don't put the listener behind PgBouncer
transaction-mode. Either direct connect, or use session-mode pooling
for that one client.

### Session variables

`SET app.org_id = …` (no `LOCAL`) persists for the session; PgBouncer
transaction-mode loses it on connection recycle. **Always use `SET
LOCAL` inside an explicit transaction** for tenant tagging, isolation
overrides, timeouts. The RLS pattern above is correct because of this.

### When to use which mode

| Mode | What's allowed | Best for |
|---|---|---|
| Session | Everything | Long-lived Node, Hyperdrive, single-process API |
| Transaction | Everything inside a transaction; no LISTEN/NOTIFY/SET | Lambda, Vercel Functions, Cloudflare Workers behind PgBouncer or Neon pooler |
| Statement | One statement per connection — no transactions, no prepares | Almost never; transaction mode is strictly more useful |

---

## Common errors and fixes

forge maps Postgres SQLSTATE codes to its uniform `DbKnownError` shape
(`src/adapters/postgres/errors.ts`). The mapping table covers the codes
that matter in practice:

| SQLSTATE | forge code | What it means | Fix |
|---|---|---|---|
| `23505` | `P2002` | Unique constraint failed | Branch with `findUnique` before the insert, or use `upsert` |
| `23503` | `P2003` | Foreign key constraint failed | Insert the parent first; or check `parent_id` exists before insert |
| `23502` | `P2011` | NOT NULL violation | Required field missing — declare `.optional()` if it should be nullable |
| `23514` | `P2004` | CHECK constraint failed | Value outside enum / range; validate before insert |
| `42P01` | `P2021` | Table does not exist | Run `forge push` to apply DDL |
| `42703` | `P2022` | Column does not exist | Run `forge push`; if intentional, regenerate types |
| `40P01` | `P2034` | Deadlock | Retry the transaction (see below) |
| `40001` | `P2034` | Serialization failure | Retry the transaction |
| `57014` | `P2024` | Query timeout | Increase `statement_timeout` or partition the query |
| `08000`/`08006` | `P1001` | Connection error | Check network, host, pool exhaustion |
| `28P01` | `P1010` | Authentication failed | Check password, role grants |

### Deadlock and serialization-failure retry

`40P01` (deadlock) and `40001` (serialization failure under REPEATABLE
READ / SERIALIZABLE) are not bugs — they're the database telling you
"these two transactions couldn't both win, redo yours". The right
response is small-jittered exponential backoff:

```ts
async function withRetry<T>(fn: () => Promise<T>, max = 3): Promise<T> {
  for (let i = 0; i < max; i++) {
    try { return await fn(); }
    catch (e: any) {
      if (e.code !== 'P2034' || i === max - 1) throw e;
      await new Promise((r) => setTimeout(r, 50 * 2 ** i + Math.random() * 25));
    }
  }
  throw new Error('unreachable');
}

await withRetry(() => db.$transaction(async (tx) => { … }));
```

Don't retry indefinitely — three attempts catches transient contention;
beyond that the contention is a design issue (lock ordering, hot rows).

### Unique violation: constraint vs index

PG enforces UNIQUE via a unique index. forge emits these as constraints
(`ADD CONSTRAINT … UNIQUE (…)`), which Postgres internally backs with a
unique index. The constraint and index share a name — `forge_<table>_uq_<col>`.

The trap: a manually-added `CREATE UNIQUE INDEX` and a forge-managed
`UNIQUE` constraint can collide on names, and `\d <table>` shows them
identically. If you've manually created a unique index that overlaps a
column the schema declares as `.unique()`, drift detection will try to
add the constraint and fail with `42P07` (duplicate object). Either:

* Drop the manual index, let forge add the constraint, or
* Rename the manual index out of the `forge_*` namespace so the
  migrator skips it.

Partial unique indexes (`UNIQUE (email) WHERE deleted_at IS NULL`)
don't have an `ADD CONSTRAINT … UNIQUE WHERE` form. forge emits them as
indexes, not constraints:

```ts
indexes: [
  { keys: { email: 1 }, unique: true, where: `"deleted_at" IS NULL` },
],
// →  CREATE UNIQUE INDEX … ON … ("email") WHERE "deleted_at" IS NULL
```

### Aborted transaction

Already covered under [Transactions and isolation](#transactions-and-isolation).
The fix is `upsert`, branch-before, or savepoint — not `try/catch`.

### `numeric` as string

Already covered under [Type round-trip](#type-round-trip). The fix is
`decimal.js`, not a parser override.

### "current transaction is aborted, commands ignored until end of transaction block"

The error after the error. The original error is the one to fix; the
aborted-tx error is the symptom. Forge's wrapper rethrows the first
SQLSTATE it saw, so the actual root cause is usually already in the
stack trace.

---

## Cross-references

* [DRIVERS](./DRIVERS.md) — the full driver-port reference; how
  `pgDriver`, `postgresJsDriver`, and custom wrappers all share one
  port shape
* [QUERIES](./QUERIES.md) — operator-per-dialect emit table; the
  `where: { col: { search: q } }` PG path uses `to_tsvector` / `plainto_tsquery`
* [INDEXES](./INDEXES.md) — every `IndexDef` field; PG-specific
  `INCLUDE`, partial indexes, `text_pattern_ops`, GIN / GIST / BRIN /
  HNSW
* [JSON-PATH](./JSON-PATH.md) — the JSON path operator's per-dialect
  compilation, including the Postgres cast rules
* [GEO](./GEO.md) — `f.geoPoint`, PostGIS `geography` vs `geometry`,
  non-WGS84 SRIDs, MultiPolygon `withinPolygon`
* [VECTOR](./VECTOR.md) — `f.vector`, pgvector HNSW with cosine / L2 /
  inner-product opclasses, `<=>` / `<->` / `<#>` operators
* [MIGRATIONS](./MIGRATIONS.md) — `forge push`, drift detection,
  `applyDrift`, the runtime `db.$migrate()` API on supported drivers
* [TRANSACTIONS](./TRANSACTIONS.md) — `$transaction`, savepoints,
  isolation levels, deadlock retry, the AsyncLocalStorage HTTP pattern
* [BACKEND](./BACKEND.md) — pool sizing, PgBouncer recipe, RLS-based
  tenant isolation, the outbox pattern that subsumes LISTEN/NOTIFY for
  durability
* [DOCTOR](./DOCTOR.md) — the runtime probe that reports installed
  extensions and missing capabilities before they bite at query time
* [DIFF](./DIFF.md) — the introspection differ; what's compared,
  what's deliberately not (default expressions, comments, ownership)
