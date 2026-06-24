# UUID, ULID, Snowflake

A reference for ID-generation strategies — what bits each format carries, how it stores in each dialect, the index-fragmentation trade-off, and which to pick when. For the higher-level PK choice see [PRIMARY-KEYS.md](PRIMARY-KEYS.md); this page is the detailed reference for the formats themselves.

PRIMARY-KEYS.md is shaped around *which `f.id()` option to reach for*.
UUID.md is shaped around *what those 128 (or 64, or 96) bits actually
mean* — the encoding, the generator, the per-dialect emit, the bit-level
trade-offs that pick one strategy over another. If you're trying to
decide whether to switch your hot table from v4 to v7, this page is the
one to read end-to-end; if you're trying to remember whether `f.id()`
takes `kind` or `type`, head back to PRIMARY-KEYS.

Related deep-dives:

* [PRIMARY-KEYS.md](./PRIMARY-KEYS.md) — `f.id()` API surface, FK propagation, migration mechanics.
* [MODEL.md](./MODEL.md#id-strategies) — the canonical three-row id-strategy table.
* [TYPES.md](./TYPES.md) — how the JS type of `id` flows through `Row<typeof Model>`.
* [SHARDING.md](./SHARDING.md) — how the ID shape interacts with shard keys.
* [POSTGRES.md](./POSTGRES.md), [MYSQL.md](./MYSQL.md), [SQLITE.md](./SQLITE.md), [MSSQL.md](./MSSQL.md), [MONGO.md](./MONGO.md) — dialect chapters; each has an ID section.

---

## Contents

* [Scope](#scope)
* [The five strategies at a glance](#the-five-strategies-at-a-glance)
* [Bit layouts](#bit-layouts)
* [Storage size — how the same 128 bits encode](#storage-size--how-the-same-128-bits-encode)
* [JavaScript generators](#javascript-generators)
* [`f.id()` shape — what forge ships](#fid-shape--what-forge-ships)
* [App-generated vs DB-generated](#app-generated-vs-db-generated)
* [Per-dialect DB generation](#per-dialect-db-generation)
* [Index fragmentation under v4](#index-fragmentation-under-v4)
* [URL representation — base62 and friends](#url-representation--base62-and-friends)
* [Sortability — what "sortable" means and what it doesn't](#sortability--what-sortable-means-and-what-it-doesnt)
* [Privacy — what the bits leak](#privacy--what-the-bits-leak)
* [Collision probability — the birthday paradox in real numbers](#collision-probability--the-birthday-paradox-in-real-numbers)
* [ObjectId in Mongo — collection-scoped uniqueness](#objectid-in-mongo--collection-scoped-uniqueness)
* [Choice flowchart](#choice-flowchart)
* [Migrating from serial to UUID](#migrating-from-serial-to-uuid)
* [Worked examples](#worked-examples)
* [Cross-links](#cross-links)

---

## Scope

This page covers ID *format* — the bits, the encoding, the generator,
the storage cost, the index behaviour. It does **not** cover which
`f.id()` option to pass for which strategy (that's
[PRIMARY-KEYS.md](./PRIMARY-KEYS.md)), how `Row<typeof Model>['id']` is
typed (that's [TYPES.md](./TYPES.md#per-dialect-type-quirks)),
composite-PK design (also PRIMARY-KEYS), or shard-key design when the
id is the shard key (that's [SHARDING.md](./SHARDING.md)).

Six format families: UUIDv4, UUIDv6, UUIDv7, UUIDv8, ULID, Snowflake.
CUID/CUID2/NanoID intersect occasionally; dedicated coverage lives in
[PRIMARY-KEYS.md](./PRIMARY-KEYS.md#cuid--cuid2--collision-resistant-url-safe).

---

## The five strategies at a glance

| Format | Bits | Timestamp | Random | Sortable | Encoding | Year |
|---|---|---|---|---|---|---|
| UUIDv4 | 128 | none | 122 | no | hex+hyphens (36) | 2005 (RFC 4122) |
| UUIDv6 | 128 | 60-bit (100-ns) | 62 | yes (re-laid v1) | hex+hyphens (36) | 2024 (RFC 9562) |
| UUIDv7 | 128 | 48-bit (ms) | 74 | yes | hex+hyphens (36) | 2024 (RFC 9562) |
| UUIDv8 | 128 | custom | custom | depends | hex+hyphens (36) | 2024 (RFC 9562) |
| ULID | 128 | 48-bit (ms) | 80 | yes | Crockford base32 (26) | 2016 |
| Snowflake | 64 | 41-bit (ms) | 12 seq + 10 worker | yes | decimal (~19) | 2010 (Twitter) |

Every UUID burns 6 bits on version+variant markers, so the random and
timestamp columns above never sum to 128. Snowflake burns 1 bit on a
sign flag (always 0 so it fits a signed `BIGINT`).

ObjectId is listed separately — 96 bits, 12 bytes — in
[its own section](#objectid-in-mongo--collection-scoped-uniqueness).

---

## Bit layouts

The wire form for each, with field boundaries.

### UUIDv4 — 122 random bits

```
xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx
                ^      ^
                |      `─ y = 8/9/A/B  (variant marker)
                `──────── 4 = version 4
```

122 random bits from a CSPRNG; 4 fixed for version (always 4), 2 fixed
for variant (always RFC 4122). No order, no time, no identity.
Canonical example: `ce6acce8-3a78-4dba-9d9c-2bc28a514cfb`.

### UUIDv6 — rearranged v1 (rare)

```
xxxxxxxx-xxxx-6xxx-yxxx-xxxxxxxxxxxx
└─ 60-bit time (100-ns since 1582) ┘ + 14-bit clock seq + 48-bit node
```

RFC 9562's fix to UUIDv1's bit order — same components (time, clock
seq, MAC) but the time bits are reshuffled so that lexicographic sort
matches creation order. Almost nobody picks v6 — if you wanted v1 you'd
live with v1, if you wanted sortable UUIDs you'd pick v7. v6 is a
bridge for systems already minting v1.

### UUIDv7 — the modern monotonic UUID

```
xxxxxxxx-xxxx-7xxx-yxxx-xxxxxxxxxxxx
└──── 48-bit ms timestamp ────┘ + 74-bit randomness  (version = 7)
```

48-bit Unix ms at the front (~8900 years from 1970), then 4 version
bits, 12 random, 2 variant, 62 more random. Example minted at
2026-06-24T08:00:00Z:

```
0195a020-c000-7c4e-aa8f-2bc28a514cfb
└── 0195a020c000 = 1750464000000 ms since epoch
```

Within the same ms, sort is random (the trailing 74 bits decide). Across
ms, monotonic. RFC 9562 also defines an optional "monotonic counter"
sub-layout for within-ms ordering — most libraries implement it.

### UUIDv8 — custom layout

```
xxxxxxxx-xxxx-8xxx-yxxx-xxxxxxxxxxxx
         all bits app-defined except version+variant
```

UUIDv8 is the escape hatch — RFC 9562 reserves the version number and
demands the variant be correct, but every other bit is yours. Used by
specialised systems that need to embed identity (a tenant id, a shard
hash) into a UUID-shaped column. The cost is that no off-the-shelf
generator can mint a v8 for you; you write the bit-layout code yourself.

### ULID — base32-encoded 48+80

```
[ T T T T T T T T T T ] [ R R R R R R R R R R R R R R R R ]
  └ 48-bit ms (10 ch) ┘   └─── 80-bit random (16 ch) ────┘
```

Crockford alphabet: `0123456789ABCDEFGHJKMNPQRSTVWXYZ` — 32 chars,
excluding I/L/O/U for readability. First 10 chars = ms timestamp
(top-padded); last 16 = randomness. Example:
`01J17878000123456789ABCDEF`.

### Snowflake — 41+10+12 in a signed 64-bit int

```
 bit 63 │ 62 ── 22 │ 21 ── 12 │ 11 ── 0
   0    │ 41-bit ms│ 10-bit   │ 12-bit
        │ timestamp│ worker id│ sequence
   └── sign bit, always 0 (fits a signed BIGINT)
```

41 bits of ms from a chosen epoch — ~69 years before wraparound (2010
epoch → 2079; 2024 epoch → 2093). 10 bits of worker id = 1024 distinct
workers. 12 bits of sequence/ms/worker = 4096 ids/ms/worker, 4.1M
ids/sec/worker.

Discord uses Twitter's layout verbatim; Instagram uses 41+13+10. The
10-bit worker id is most common — budget those 1024 producer slots
carefully.

---

## Storage size — how the same 128 bits encode

A UUID is 16 bytes of entropy. What you pay on disk and over the wire:

| Encoding | Chars | Disk (TEXT) | Disk (binary) | Notes |
|---|---|---|---|---|
| Canonical hex with hyphens | 36 | 36 + prefix | n/a | The `xxxxxxxx-xxxx-...` form |
| Hex no hyphens | 32 | 32 + prefix | n/a | `RAW(16)` Oracle, `BINARY(16)` MySQL |
| Native `uuid` type | n/a | n/a | 16 + alignment | PG, MSSQL (`UNIQUEIDENTIFIER`), DuckDB |
| base64url | 22 | 22 | n/a | URL-safe; rare in the wild |
| ULID base32 | 26 | 26 + prefix | n/a | Crockford alphabet |
| Snowflake decimal | 19 | 8 (BIGINT) | 8 | `f.bigint()` — never a string column |

Take-homes:

* UUID-as-text costs more than 2x the disk vs native binary. PG/MSSQL/DuckDB get the `uuid` column via `f.id({ type: 'uuid' })`.
* SQLite has no native UUID type; you pay 36 bytes per row plus index. Rarely worth fighting — SQLite isn't your hot-write target.
* MySQL `BINARY(16)` halves disk cost but kills interactive queries; forge doesn't emit it. Stick with `CHAR(36)` unless measured as a bottleneck.

Index storage roughly doubles the row cost. A 100M-row table on
36-char UUID: ~8 GB index. Same table on `uuid` binary: ~3 GB. On a
`BIGINT` Snowflake: ~1.6 GB. The arithmetic flips well before 1B rows.

---

## JavaScript generators

The libraries you'll actually call.

### UUIDv4 — built-in

```ts
import { randomUUID } from 'crypto';
randomUUID();
// '5f3b6e2a-9c11-4d4f-8e0b-7c45d8f6a012'
```

Node 14.17+; Bun; Deno; modern browsers under `crypto.randomUUID()`.
Forge's auto-id wrapper uses this — no dependency, CSPRNG-backed, no
allocation overhead worth measuring.

### UUIDv1/v6/v7 — `uuid` npm package

```ts
// npm i uuid
import { v1, v6, v7 } from 'uuid';
v7();   // '01940a02-c000-7c4e-aa8f-2bc28a514cfb'
```

`uuid@9+` ships v1, v3, v4, v5, v6, v7, v8, plus `validate` / `version`.
v7 implements the monotonic counter from RFC 9562 by default, so two
ids minted in the same ms within the same process sort in mint order.
Alternatives: `uuidv7` (smaller bundle, RFC-only) and `@napi-rs/uuid`
(native bindings, faster under bulk mint).

### ULID — `ulid` or `ulidx`

```ts
// npm i ulid
import { ulid } from 'ulid';
ulid();
// '01JBJ8E0G2KQ5Z3WPDJX8M2KQM'
```

`ulidx` is the maintained fork with TypeScript types and a configurable
PRNG. Both libraries support a "monotonic" mode that increments the
random bits within the same ms to preserve sort order — required if you
mint many ULIDs per ms in the same process.

```ts
import { monotonicFactory } from 'ulid';
const ulid = monotonicFactory();
ulid();   // monotonic within this process
```

### Snowflake — `@sapphire/snowflake` or hand-rolled

```ts
// npm i @sapphire/snowflake
import { Snowflake } from '@sapphire/snowflake';
const sf = new Snowflake(new Date('2024-01-01T00:00:00Z'));
sf.generate({ workerId: 1n });
// 1834219123712000001n
```

The library returns `bigint` because the value is 64 bits — JavaScript's
`number` only goes to 53 bits without lossy rounding. forge's
`f.bigint()` is the matching column type.

A hand-rolled Snowflake fits in ~30 lines but the gotchas — clock
regression, worker-id reuse, sequence overflow — are real. Use a
library unless you've solved those problems already.

### CUID2 — `@paralleldrive/cuid2`

```ts
// npm i @paralleldrive/cuid2
import { createId } from '@paralleldrive/cuid2';
createId();
// 'tz4a98xxat96iws9zmbrgj3a'
```

Covered in detail in [PRIMARY-KEYS.md](./PRIMARY-KEYS.md#cuid--cuid2--collision-resistant-url-safe).

---

## `f.id()` shape — what forge ships

Three options from `src/schema/core.ts`:

```ts
export type IdTypeName = 'auto' | 'uuid' | 'bigserial';

f.id()                          // string column, app-filled UUIDv4
f.id({ type: 'uuid' })          // typed UUID column, DB-side default where available
f.id({ type: 'bigserial' })     // DB-assigned integer, JS number
```

Anything else — UUIDv7, ULID, Snowflake, CUID2 — is not a built-in.
Declare `f.id()` (string PK) and supply the value at create time:

```ts
import { uuidv7 } from 'uuidv7';
const Post = model('posts', { id: f.id(), title: f.string() });

await db.post.create({ data: { id: uuidv7(), title: 'hello' } });
```

The wrapper's auto-fill (`randomUUID()`) only runs when `data.id` is
absent. Supplying v7, ULID, or Snowflake at create bypasses the wrapper
and stores your value verbatim.

For Snowflake the column is a 64-bit integer, not a string — use
`f.bigint().unique()`. Detail on why this isn't
`f.id({ type: 'bigserial' })` is in
[PRIMARY-KEYS.md](./PRIMARY-KEYS.md#snowflake--distributed-64-bit).

---

## App-generated vs DB-generated

The first decision before picking a format is whether the app or the DB
mints the id.

| Generator side | Pros | Cons |
|---|---|---|
| **App-generated** | Client knows the id pre-write — idempotency, optimistic UI, pre-allocated FKs. Same code in tests/dev/prod. No worker coordination across regions. | Each client needs a CSPRNG or worker-id. Changing generators is silent until collisions hit. |
| **DB-generated** | Centralised — one collision domain. Raw `INSERT` outside the ORM still gets a defaulted id. | Round-trip cost — id only known post-INSERT. Multi-writer setups serialise on the sequence. Migration is awkward. |

App-generated is forge's default everywhere except where the DB has a
built-in generator and forge can defer to it (`f.id({ type: 'uuid' })`
on PG/MySQL/MSSQL gets DB defaults; SQLite/Mongo get app-side).

Three patterns that only work with app-generated ids:

1. **Idempotent inserts.** Client mints id, retries N times; the unique constraint dedupes. See [IDEMPOTENCY.md](./IDEMPOTENCY.md).
2. **Pre-allocated FKs.** Parent + child inserts in any order — both ids known up front.
3. **Optimistic UI.** Client sends "create with id X"; the server validates. No id swap on confirmation.

---

## Per-dialect DB generation

The native DB-side generators per dialect.

### Postgres

```sql
-- UUIDv4 (always available since PG 13):
SELECT gen_random_uuid();
-- '5f3b6e2a-9c11-4d4f-8e0b-7c45d8f6a012'

-- UUIDv7 — needs the pg_uuidv7 extension:
CREATE EXTENSION pg_uuidv7;
SELECT uuid_generate_v7();
-- '0195a020-c000-7c4e-aa8f-2bc28a514cfb'
```

Forge emits `id uuid PRIMARY KEY DEFAULT gen_random_uuid()` for
`f.id({ type: 'uuid' })`. For v7 you switch the default manually in a
migration (the extension isn't on RDS, Cloud SQL, or Supabase managed
as of mid-2026, so app-side generation is the portable choice):

```sql
ALTER TABLE posts ALTER COLUMN id SET DEFAULT uuid_generate_v7();
```

`forge diff` flags the changed default the next time it inspects the
schema; treat the constraint as external state.

### MySQL

```sql
SELECT UUID();
-- '6f3b6e2a-9c11-11ee-8e0b-7c45d8f6a012'   (v1, no built-in v4 or v7)
```

MySQL's `UUID()` is v1 — encodes the MAC address and a 100-ns timestamp,
with the first hyphenated group as the *low* time bits, so v1 is **not**
sortable as text. MySQL 8.0 ships `UUID_TO_BIN(uuid, 1)` to swap the
time bits and store as `BINARY(16)`, recovering sortability — at the
cost of awkward interactive queries.

forge emits `id CHAR(36) PRIMARY KEY DEFAULT (UUID())` for
`f.id({ type: 'uuid' })` on MySQL 8.0+. Most workloads override at
create time with `randomUUID()` and treat the column as opaque text.

### SQLite

No UUID type, no built-in generator. The canonical workaround stitches
`randomblob(16)` into the v4 hex form:

```sql
SELECT lower(
  hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' ||
  substr(hex(randomblob(2)), 2) || '-' ||
  substr('89ab', abs(random()) % 4 + 1, 1) ||
  substr(hex(randomblob(2)), 2) || '-' || hex(randomblob(6))
);
```

Most apps don't bother — the wrapper fills the value at create time, and
a SQL-side default isn't worth the DDL complexity.

### MSSQL

`NEWID()` is v4-shaped and random; `NEWSEQUENTIALID()` is
monotonic-within-a-process (only valid as a column DEFAULT).
`NEWSEQUENTIALID()` resets across restarts and isn't monotonic across
machines in an Availability Group, but for single-instance OLTP it
gives UUID-shaped clustering without the v4 fragmentation pain:

```sql
ALTER TABLE tokens
  ADD CONSTRAINT DF_tokens_id DEFAULT NEWSEQUENTIALID() FOR [id];
```

forge emits `NEWID()` for `f.id({ type: 'uuid' })` — see
[PRIMARY-KEYS.md MSSQL section](./PRIMARY-KEYS.md#per-dialect-id-generation-reference).

### Mongo

```js
// In the driver:
new ObjectId();
// ObjectId("6675a7c81f5d7c4eaa8f2bc2")
```

12 bytes — 4-byte timestamp (seconds since epoch), 5-byte
per-process-random value, 3-byte counter starting at a random offset.
The driver mints client-side, so `insertOne` knows the id before the
write acks. forge maps `id ↔ _id` and presents the value as a 24-char
hex string in the row.

Detail on `ObjectId` semantics is in
[its own section below](#objectid-in-mongo--collection-scoped-uniqueness).

---

## Index fragmentation under v4

The single biggest reason to prefer v7 / ULID / Snowflake over v4 on a
hot table: B-tree page fill.

Random ids (v4, `NEWID`, CUID2) sort to a random location in the
B-tree. The page that received row `N` rarely receives `N+1`. Pages
fill to ~50% before splitting; the index doubles in size; cache hit
rates drop; insert throughput tops out.

Sorted ids (v7, ULID, Snowflake, `bigserial`) append at the right edge.
Pages fill to ~95%; the rightmost page stays hot in cache.

Order of severity for inserts on a hot table:

```
UUIDv4         ████████████████████  worst — uniform across keyspace
NEWID() MSSQL  ███████████████████   same shape as v4
CUID2          ██████████████████    deliberately randomised
ObjectId       ███                   first 4 bytes timestamp, near-sorted
UUIDv7         ██                    first 48 bits timestamp, sorted
ULID           ██                    first 48 bits timestamp, sorted
Snowflake      █                     monotonic 64-bit integer
bigserial      —                     strictly monotonic; zero fragmentation
```

Two ways out:

1. **Pick an ordered id.** v7, ULID, Snowflake, ObjectId, bigserial — all front-load a timestamp.
2. **Move the PK off the clustered index.** MSSQL: declare the PK `NONCLUSTERED`, put a `CLUSTERED` index on `(created_at)`. PG's `CLUSTER` is a manual periodic op, not a table property.

v4 fragmentation starts hurting past a few thousand inserts/sec on a
hot table. Below that, v4's zero-dependency wins. Above that, switch.
`pg_stat_user_indexes` reports index size; compare to
`pg_stat_user_tables.n_live_tup * <key_width>` to estimate overhead.

---

## URL representation — base62 and friends

If the id appears in a URL, what does the URL look like?

| Format | URL representation | Length | Notes |
|---|---|---|---|
| UUIDv4/v6/v7/v8 | `/posts/5f3b6e2a-9c11-4d4f-8e0b-7c45d8f6a012` | 36 chars | Hyphens are URL-safe per RFC 3986. |
| UUID base64url | `/posts/Xztusqr2TU-OC3xF2PagEg` | 22 chars | Strip the `=` padding; replace `+`/`/` with `-`/`_`. |
| UUID base62 | `/posts/2kVdaW1ZQfXgVo69ZHFmTu` | 22 chars | Lowercase + uppercase + digits; case-sensitive. |
| ULID | `/posts/01JBJ8E0G2KQ5Z3WPDJX8M2KQM` | 26 chars | Crockford base32. Case-insensitive at the alphabet level. |
| CUID2 | `/posts/tz4a98xxat96iws9zmbrgj3a` | 24 chars | Lowercase + digits. |
| Snowflake | `/posts/1834219123712000001` | 19 chars | Pure digits. |
| bigserial | `/posts/4837` | 1-19 chars | Pure digits; variable. |

ULID is the only format that's URL-safe out of the box without losing
ordering — Crockford base32 maps to `[A-HJ-KMNP-TV-Z0-9]`, URL-safe per
RFC 3986. UUIDv7 needs base62/base64url to drop the hyphens, which is a
conversion layer on every URL boundary.

**Base62 for UUIDs.** A 128-bit value fits in 22 base62 chars
(log₆₂(2¹²⁸) ≈ 21.5). Reversible — server stores hex, URL emits
base62 — but the per-URL serialisation cost is rarely worth it; the
36-char form fits modern URLs comfortably.

**ULID's case caveat.** The alphabet is case-insensitive, but column
collations aren't. Pick one casing at create time — otherwise
`WHERE id = '01jbj8e0...'` and `WHERE id = '01JBJ8E0...'` are
different queries. forge doesn't normalise; that's on the application.

---

## Sortability — what "sortable" means and what it doesn't

"v7 is sortable" is true in a narrow sense and false in a few wide ones.

**True senses:**

1. **Lexicographic = chronological at ms granularity.** Two v7s minted at different milliseconds sort by mint time when compared as strings. ULID and Snowflake have the same property — Snowflake's bigint compare is also a time compare.
2. **`ORDER BY id` works as `ORDER BY created_at`.** No second index, no second column. Saves a B-tree.
3. **Range queries work.** `WHERE id > '0195a020-0000-7000-...'` selects everything since the embedded timestamp. Useful for paginating "events since X" without a separate timestamp column.

**False senses:**

1. **Within the same millisecond.** Two v7s minted in the same ms sort by their trailing random bits — randomly. Unless your library implements the monotonic counter sub-layout, you can't tell which of two same-ms ids came first. ULID has the same caveat; `monotonicFactory()` solves it within a process but not across.
2. **Across machines with clock skew.** v7's timestamp is whatever the machine's clock says. Two machines disagreeing by 500ms produce ids that sort in clock-disagreement order. NTP is your only defence.

**Snowflake's monotonicity is stronger** — within a worker, the sequence
guarantees per-id ordering even within the same ms. Across workers,
you're back to clock skew. Worker-id collisions = id collisions; the
mitigation is a coordination service that hands out ids on worker boot.

---

## Privacy — what the bits leak

What a curious party with curl learns from one of your ids.

| Format | What it leaks |
|---|---|
| UUIDv4 | nothing — 122 random bits |
| UUIDv6 | MAC address of the minting machine + 100-ns timestamp |
| UUIDv7 | ms-precision creation time |
| UUIDv8 | whatever you put in it |
| ULID | ms-precision creation time |
| Snowflake | ms-precision creation time + worker id |
| ObjectId | second-precision creation time + process random + counter offset |
| bigserial | the total row count at mint time |
| CUID v1 | second-precision time + counter + host fingerprint |
| CUID v2 | nothing — deliberate |

**The bigserial leak — the German Tank Problem.** `/orders/4837` says
you have ≥ 4837 orders. Poll nightly, diff the highest id, infer the
daily order rate. Measured in real M&A diligence — sequential ids in
customer-facing URLs broadcast growth. Mitigations: don't expose serial
ids in URLs (use a `slug` or `token UUID UNIQUE`); Stripe-style ID
prefix + opaque token (`cus_abc123`); avoid Hashids/Sqids — they're
reversible from the library source, cosmetic not security.

**The v7 / ULID leak.** ms-precision creation time. Fine for internal
references; leaky if creation time is sensitive (e.g., reveals when a
private draft was written). Use v4 there.

**The Snowflake leak.** Timestamp + the 10-bit worker id. If workers
are named per region (`us-east-1=1`, `us-west-2=2`), that mapping
becomes public.

**The ObjectId leak.** Second-precision timestamp — same shape as v7's
leak, lower resolution.

---

## Collision probability — the birthday paradox in real numbers

People ask "but won't two UUIDs collide eventually?" The answer is no
at any sane scale — let's actually compute it.

The birthday-problem formula for a hash space of size `N` and `n`
draws says the expected collision is at roughly `n ≈ sqrt(N)`.

| Format | Random bits | `sqrt(2^bits)` (50% collision after) |
|---|---|---|
| UUIDv4 | 122 | 2.3 × 10¹⁸ ids |
| UUIDv7 | 74 | 1.3 × 10¹¹ ids per ms |
| ULID | 80 | 1.1 × 10¹² ids per ms |
| Snowflake | 12 seq | 4096 ids per ms per worker |

**UUIDv4.** At a billion ids/sec, you'd hit 50% collision after ~73
years. Drop the threshold to 0.0001% and it's still 730,000 years.
Effectively zero at any human scale.

**UUIDv7 and ULID.** Collisions only happen within a ms (timestamp
prefix differs across ms). v7's 74 within-ms random bits give 1.3 ×
10¹¹ ids before 50% collision — you'd need 130 billion ids in a single
ms. Discord's peak snowflake throughput is 3 orders of magnitude below.

**Snowflake.** 12 bits of sequence per ms per worker = 4096 ids/ms. A
hard cap — the 4097th id in the same ms collides unless the library
blocks until the ms ticks over. `@sapphire/snowflake` blocks;
hand-rolled implementations sometimes don't.

**ObjectId.** Counter wraps every 2¹⁶ ids/sec within a process; the
5-byte random gives ~10⁶ processes before a 50% collision. In practice,
ObjectId collisions need you to clone a mongod data directory and run
both copies.

Collision probability is not the right axis to choose between formats.
Pick on index fragmentation, URL safety, sortability, and the privacy
leak — not on the collision math.

---

## ObjectId in Mongo — collection-scoped uniqueness

Mongo's `_id` is unique per collection, not per database. Two
collections in the same DB can both have an ObjectId with the same hex
value — the constraint is on `(collection, _id)`, not `_id` alone.

```js
// Both inserts succeed:
db.users.insertOne({ _id: ObjectId('6675a7c81f5d7c4eaa8f2bc2'), name: 'a' });
db.posts.insertOne({ _id: ObjectId('6675a7c81f5d7c4eaa8f2bc2'), title: 'b' });
```

In practice ObjectId collisions across collections are vanishingly rare
— the embedded timestamp, process random, and counter make it unlikely.
But the guarantee is collection-scoped, which has two consequences:

1. **An ObjectId is not a global identifier.** Streaming all collections to a relational replica needs a `(collection, id)` composite key. The forge Mongo adapter handles this for FKs — `f.objectId()` references a specific model.
2. **Cross-collection FK references work as you'd expect.** `f.objectId()` on the FK side carries the target model; the wrapper enforces the per-collection scope at the query layer.

Layout:

```
4-byte timestamp │ 5-byte per-process random │ 3-byte counter
└─ seconds since epoch (big-endian)
```

Second precision means two ids minted in the same second sort by
(random, counter), not mint order. For sub-second ordering on Mongo,
store a separate `createdAt` or switch to `f.id({ type: 'uuid' })`
with app-generated v7.

---

## Choice flowchart

Walk top to bottom; stop at the first matching branch.

```
Mongo only? → ObjectId (the f.id() default).

Integer ids required?
  Single writer, no privacy concern → bigserial.
  Multi-writer / distributed         → Snowflake.

String ids:
  Inserts > a few thousand/sec on a hot table?
    Yes → UUIDv7 (UUID-shaped column) or ULID (URL-shaped).
    No  → UUIDv4 (forge's default).

  Id appears in a customer-facing URL?
    Yes, creation time sensitive → UUIDv4.
    Yes, creation time fine      → UUIDv7 / ULID.
    No                           → optimise for insert performance.
```

Three tie-breakers:

* **Want the DB to mint on raw inserts?** Pick a format the DB generates: UUIDv4 on PG/MySQL/MSSQL; bigserial; NEWSEQUENTIALID on MSSQL. v7 needs `pg_uuidv7`; ULID/Snowflake need app-side mints.
* **Migrating from another ORM?** Match the source. Prisma defaults to CUID; Sequelize/TypeORM default to v4. Schema migration is cheaper than format conversion.
* **No constraints, want modern?** UUIDv7. RFC since 2024, library coverage in every major language, drops into any column that took v4.

---

## Migrating from serial to UUID

The textbook outage. The five-phase pattern, with downtime ≈ zero if
phases land in separate deploys.

**Phase 0 — establish the new id column.**

```sql
ALTER TABLE orders ADD COLUMN new_id UUID DEFAULT gen_random_uuid();
UPDATE orders SET new_id = gen_random_uuid() WHERE new_id IS NULL;
ALTER TABLE orders ALTER COLUMN new_id SET NOT NULL;
CREATE UNIQUE INDEX orders_new_id_uidx ON orders(new_id);
```

**Phase 1 — backfill every FK with the new shape.** For each FK
referencing `orders.id`:

```sql
ALTER TABLE order_items ADD COLUMN order_new_id UUID;
UPDATE order_items oi
   SET order_new_id = o.new_id
  FROM orders o
 WHERE oi.order_id = o.id;
ALTER TABLE order_items ALTER COLUMN order_new_id SET NOT NULL;
CREATE INDEX ON order_items(order_new_id);
```

Backfill is the slow step — batch it if the table is large.

**Phase 2 — write twice from the app.** Schema writes set both ids;
reads still join on the old column.

**Phase 3 — switch reads to the new column.** Deploy step; rollback by
leaving the old columns intact.

**Phase 4 — drop the old columns.**

```sql
ALTER TABLE order_items DROP COLUMN order_id;
ALTER TABLE order_items RENAME COLUMN order_new_id TO order_id;
ALTER TABLE orders DROP COLUMN id;
ALTER TABLE orders RENAME COLUMN new_id TO id;
ALTER TABLE orders ADD PRIMARY KEY (id);
```

**Phase 5 — drop the dual-write code.**

The reverse direction (UUID → serial) is harder — you can't backfill a
`bigserial` without picking an order, and order matters for
human-facing display ids. Most UUID → serial migrations only happen on
internal tables. Detail on `forge push` / `forge diff` during a
migration is in [MIGRATIONS.md](./MIGRATIONS.md); FK-typing
implications are in [PRIMARY-KEYS.md — Foreign-key impact](./PRIMARY-KEYS.md#foreign-key-impact).

---

## Worked examples

### (a) UUIDv7 in Postgres

A CMS workload. We want UUID-shaped ids (column type `uuid`) with the
time prefix that makes `ORDER BY id` track creation order.

```ts
import { model, f } from 'forge-orm';
import { uuidv7 } from 'uuidv7';                  // npm i uuidv7

export const Post = model('posts', {
  id:        f.id({ type: 'uuid' }),
  author_id: f.objectId(),
  slug:      f.string().unique(),
  title:     f.string(),
  body:      f.text(),
  createdAt: f.dateTime().default('now'),
}, {
  indexes: [{ keys: { author_id: 1, id: -1 }, name: 'author_recent' }],
});

await db.post.create({
  data: {
    id:        uuidv7(),
    author_id: authorId,
    slug:      'why-uuidv7',
    title:     'Why UUIDv7',
    body:      '…',
  },
});

// "Latest 20 posts by author" — ORDER BY id is correct chronologically.
await db.post.findMany({
  where:   { author_id: authorId },
  orderBy: { id: 'desc' },
  take:    20,
});
```

The column emits as `id uuid PRIMARY KEY DEFAULT gen_random_uuid()`. We
override at create time with v7; a third-party INSERT without `id` gets
v4. Mixed-format ids in the column work — the type is `uuid`, the bits
don't care. Why not switch the DB default to v7? `pg_uuidv7` isn't on
RDS, Cloud SQL, or Supabase as of mid-2026, and the same app-side
generator runs unchanged on SQLite (dev), PG (prod), and Mongo
(analytics replica).

### (b) ULID in SQLite

A mobile app stores events locally in SQLite, syncs to a server. We want
URL-safe ids, time-ordered for "latest first" queries, no DB extension.

```ts
import { model, f } from 'forge-orm';
import { ulid, monotonicFactory } from 'ulidx';   // npm i ulidx

// Per-process monotonic factory: same-ms ids sort in mint order.
const newUlid = monotonicFactory();

export const Event = model('events', {
  id:        f.id(),                   // TEXT PRIMARY KEY on SQLite
  kind:      f.string(),
  payload:   f.json(),
  createdAt: f.dateTime().default('now'),
}, {
  indexes: [{ keys: { kind: 1, id: -1 } }],
});

await db.event.create({
  data: { id: newUlid(), kind: 'click', payload: { x: 100, y: 200 } },
});

// "All events since X" — id range works.
await db.event.findMany({
  where:   { id: { gt: lastSyncedId } },
  orderBy: { id: 'asc' },
});
```

The id is a 26-char text column — 27% smaller than UUIDv4 text, free.
SQLite has no native UUID type, so ULID-as-text is competitive with
v4-as-text. The monotonic factory matters because mobile apps often
log multiple events in the same ms; without it, the trailing 80 random
bits shuffle within-ms order and break the "latest first" guarantee.

### (c) Snowflake for a distributed system

Multi-region writers minting messages at thousands/sec/region. We want
sortable integer ids, no central allocator round-trip.

```ts
import { model, f } from 'forge-orm';
import { Snowflake } from '@sapphire/snowflake';

const epoch    = new Date('2024-01-01T00:00:00Z');
const sf       = new Snowflake(epoch);
const workerId = BigInt(process.env.WORKER_ID ?? '1');   // from K8s ordinal

export const Message = model('messages', {
  id:        f.bigint().unique(),       // 64-bit; the snowflake
  channel:   f.string(),
  body:      f.text(),
  createdAt: f.dateTime().default('now'),
}, {
  indexes: [{ keys: { channel: 1, id: -1 } }],
});

await db.message.create({
  data: { id: sf.generate({ workerId }), channel: 'general', body: '…' },
});

// "Messages since X in this channel" — id range, no second column.
await db.message.findMany({
  where:   { channel: 'general', id: { gt: lastSeenId } },
  orderBy: { id: 'asc' },
});
```

Three notes:

* `f.bigint()` not `f.id({ type: 'bigserial' })` — the DB would otherwise mint values that fight our snowflakes.
* `f.bigint().unique()` is a unique index, not a PK constraint. If you need a PK declaration, add it via raw migration — see [PRIMARY-KEYS.md — Snowflake](./PRIMARY-KEYS.md#snowflake--distributed-64-bit).
* Worker-id collisions = id collisions. K8s StatefulSet ordinals are a workable source; Zookeeper or Consul is the production-grade answer.

The bigint doesn't fit JS `number`; forge hands it back as TypeScript
`bigint` and decimal-string over the wire. Detail in
[TYPES.md](./TYPES.md#per-dialect-type-quirks).

### (d) ObjectId vs string id in Mongo

Two valid Mongo shapes; pick by whether the same ids cross to a
relational system.

**ObjectId — the Mongo-native shape.**

```ts
const Event = model('events', {
  id:      f.id(),                   // _id: ObjectId
  user_id: f.objectId(),
  kind:    f.string(),
});
```

* 12 bytes on disk; index entries ~16 bytes.
* `_id` index roughly time-ordered (second-precision timestamp at the front).
* Forge maps `id ↔ _id` transparently; the application never sees `_id`.
* The driver mints the id before insert acks.

**String UUID — when ids cross to a SQL replica.**

```ts
import { uuidv7 } from 'uuidv7';

const Event = model('events', {
  id:      f.id({ type: 'uuid' }),   // _id: string, app-filled
  user_id: f.objectId(),
  kind:    f.string(),
});

await db.event.create({ data: { id: uuidv7(), user_id: 'u_1', kind: 'click' } });
```

* 36 bytes on disk; index entries ~46 bytes. ~30 GB more disk on a billion-row collection.
* `_id` index sorted because we mint v7. Same B-tree locality as ObjectId.
* The same id flows to PG / ClickHouse / Snowflake without translation.

A Mongo-only audit log → ObjectId. A shared-id event stream fanning
out to multiple databases → string UUID with app-mint v7.

---

## Cross-links

* [PRIMARY-KEYS.md](./PRIMARY-KEYS.md) — `f.id()` API surface, the strategy table, FK propagation, migration patterns.
* [MODEL.md](./MODEL.md#id-strategies) — the three-row strategy table that this page expands.
* [TYPES.md](./TYPES.md#per-dialect-type-quirks) — JS type per id strategy (`string` vs `number` vs `bigint`).
* [SHARDING.md](./SHARDING.md) — how the id shape interacts with shard keys; hot-shard avoidance for monotonic ids.
* [INDEXES.md](./INDEXES.md) — what the PK becomes on each dialect's clustered/secondary indexes.
* [MIGRATIONS.md](./MIGRATIONS.md) — `forge push` mechanics during an id-strategy change.
* [IDEMPOTENCY.md](./IDEMPOTENCY.md) — app-generated ids as the foundation for retry-safe inserts.
* [POSTGRES.md](./POSTGRES.md) — `gen_random_uuid`, `pg_uuidv7`, sequence ownership, `RETURNING id`.
* [MYSQL.md](./MYSQL.md) — `UUID()`, `UUID_TO_BIN(uuid, 1)`, `AUTO_INCREMENT`, `LAST_INSERT_ID()`.
* [SQLITE.md](./SQLITE.md) — `randomblob(16)`, the lack of native UUID type, app-side generation.
* [MSSQL.md](./MSSQL.md) — `NEWID` vs `NEWSEQUENTIALID`, `UNIQUEIDENTIFIER`, `IDENTITY`.
* [MONGO.md](./MONGO.md) — `_id` mapping, ObjectId semantics, `id ↔ _id` rewrite.
