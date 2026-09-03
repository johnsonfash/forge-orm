# Primary keys

Choosing an ID strategy — UUIDv4 vs UUIDv7 vs ULID vs CUID vs Snowflake vs serial — affects index fragmentation, URL safety, distributed-system fit, and forge-orm's relation typing. This page covers what `id()` accepts, per-dialect emit, the trade-offs of each choice, and the migration patterns for changing PK strategy.

The [id-strategy section in MODEL.md](./MODEL.md#id-strategies) is the
surface — three strategies, four worked DDL examples. This file is the
deep-dive: every kind of ID people pick in 2026, why they pick it, what
forge ships natively, what you wire in yourself with `f.string()` plus an
app-side generator, and how the choice propagates through foreign keys,
indexes, sharding, and migrations.

Related deep-dives:

* [MODEL.md](./MODEL.md#identifiers--fid-and-fobjectid) — the `f.id()` / `f.objectId()` reference.
* [INDEXES.md](./INDEXES.md) — how the PK becomes a clustered/secondary index per dialect.
* [MIGRATIONS.md](./MIGRATIONS.md) — what `forge push` does when the id strategy changes.
* [SHARDING.md](./SHARDING.md) — how the ID shape interacts with shard keys.
* [POSTGRES.md](./POSTGRES.md) and [MYSQL.md](./MYSQL.md) and [MONGO.md](./MONGO.md) — dialect chapters; each has a PK section.

---

## Contents

* [What `f.id()` accepts](#what-fid-accepts)
* [The shipped strategies](#the-shipped-strategies)
* [UUIDv4 — the safe default](#uuidv4--the-safe-default)
* [UUIDv7 — time-ordered UUID](#uuidv7--time-ordered-uuid)
* [ULID — time-ordered, URL-safe](#ulid--time-ordered-url-safe)
* [CUID / CUID2 — collision-resistant, URL-safe](#cuid--cuid2--collision-resistant-url-safe)
* [Snowflake — distributed 64-bit](#snowflake--distributed-64-bit)
* [Serial / IDENTITY — DB-assigned auto-increment](#serial--identity--db-assigned-auto-increment)
* [Mongo ObjectId — the Mongo default](#mongo-objectid--the-mongo-default)
* [Composite primary keys](#composite-primary-keys)
* [Per-dialect ID generation reference](#per-dialect-id-generation-reference)
* [App-generated vs DB-generated](#app-generated-vs-db-generated)
* [Index fragmentation](#index-fragmentation)
* [Privacy — what sequential IDs leak](#privacy--what-sequential-ids-leak)
* [URL safety](#url-safety)
* [Foreign-key impact](#foreign-key-impact)
* [Migrating from serial to UUID](#migrating-from-serial-to-uuid)
* [Hot-shard avoidance](#hot-shard-avoidance)
* [Worked examples](#worked-examples)
* [Cross-links](#cross-links)

---

## What `f.id()` accepts

The actual API from `src/schema/core.ts`:

```ts
export type IdTypeName = 'auto' | 'uuid' | 'bigserial' | 'string';
export type IdJsType<T extends IdTypeName> = T extends 'bigserial' ? number : string;

f.id()                         // { type: 'auto' } — JS string
f.id({ type: 'auto' })         // explicit
f.id({ type: 'uuid' })         // typed UUID column, JS string
f.id({ type: 'bigserial' })    // DB-assigned integer, JS number
f.id({ type: 'string' })       // YOU assign it. Nothing is generated.
```

Three kinds. That's it. Anything else — ULID, CUID, Snowflake, NanoID,
Hashids — is **not** a built-in choice; you wire it in by declaring the
id as a plain `f.string()` and supplying your own generator at create
time. The pattern is in [Worked examples](#worked-examples) below.

Why so few built-ins? The shipped set covers the four behaviours that
need different DDL or different wrapper behaviour:

1. **`auto`** — string PK with a wrapper-supplied UUID at create time on SQL, ObjectId on Mongo.
2. **`uuid`** — typed UUID column (`uuid` on PG, `CHAR(36)` on MySQL, `UNIQUEIDENTIFIER` on MSSQL) with a DB-side default where the dialect has one.
3. **`bigserial`** — DB-assigned integer; the JS row type flips from `string` to `number`.
4. **`string`** — *you* supply the key. Forge generates nothing and stores
   the value exactly as given.

### `string` — natural keys (2.8.0)

Use it when the row's identity **is** its content, so that a single
upsert is atomic on one document:

```ts
export const NumberSequence = model('number_sequences', {
  // "<orgId>:<series>" — one document per counter.
  id: f.id({ type: 'string' }),
  seq: f.int().default(0),
});

// Atomic: one findOneAndUpdate, no read-then-write race.
await db.numberSequence.upsert({
  where: { id: `${orgId}:invoice` },
  create: { id: `${orgId}:invoice`, seq: 1 },
  update: { seq: { increment: 1 } },
});
```

Before 2.8.0 this collection could not be *declared at all* — the three
generated types were the only options — so push, diff and doctor could
not see it, and `diff` reported it as an unmanaged table forever.

On Mongo the value is stored verbatim and is **never** coerced to an
ObjectId. That matters more than it sounds: a 24-hex natural key would
otherwise be silently rewritten and every lookup would miss. On MySQL the
column widens to `VARCHAR(255)`, since an application key runs past the
64 that suffices for a generated one.
4. (`objectId`-style FKs) — `f.objectId()` is the FK shape, not a PK; covered in [Foreign-key impact](#foreign-key-impact).

Every other strategy is a string column with an app-side generator —
forge's job is to store it without judging the contents.

---

## The shipped strategies

Reproduced from [MODEL.md](./MODEL.md#id-strategies):

| Strategy | JS type | Generated by | Pass at create? |
|---|---|---|---|
| `auto` (default) | `string` | App (`ObjectId` on Mongo, `randomUUID()` on SQL) | Optional |
| `uuid` | `string` | DB on PG/MySQL/MSSQL; app on SQLite/Mongo | Optional |
| `bigserial` | `number` | DB (always) | Never |

The wrapper code that fills the auto id (`src/builder/collection.ts`):

```ts
import { randomUUID } from 'crypto';

private _fillAutoId(data: any): any {
  if (this.adapter.kind === 'mongo') return data;   // Mongo coerce mints ObjectId
  // …on SQL: randomUUID() (UUIDv4) into the id column.
  if (this._autoIdName && data[this._autoIdName] == null) {
    return { ...data, [this._autoIdName]: randomUUID() };
  }
  return data;
}
```

Two things follow immediately:

* On every SQL dialect, `f.id()` is **UUIDv4** unless you supply your own value at create. That's a deliberate baseline — portable, no DB-side dependency, no extension needed.
* On Mongo, `f.id()` becomes `_id: ObjectId` — the natural default.

If you want UUIDv7, ULID, CUID2, Snowflake, or anything else, you keep
`f.id()` (or `f.string().unique()` for non-default field names) and pass
the generated id at create time. The remainder of this document is
about which of those choices fits which workload and how to wire it in
without losing the foreign-key typing.

---

## UUIDv4 — the safe default

128-bit identifier; 122 random bits, 6 fixed (version + variant). The
text form is the familiar `xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx`.

```
ce6acce8-3a78-4dba-9d9c-2bc28a514cfb
```

**Why pick it.**

* Generated locally with `crypto.randomUUID()` — zero dependencies.
* Universal — every dialect has a column type or fallback for 36-char strings.
* No coordination — two services can mint IDs without ever talking.

**Why hesitate.**

* No ordering. Two rows inserted a second apart get IDs that are billions apart in B-tree-sort order, which means the B-tree page that just received row N rarely receives row N+1. The b-tree fragments; cache hit rates drop; insert throughput on hot tables tops out.
* Long string — 36 chars including hyphens. In URLs, in foreign keys, in indexes.
* No timestamp. You can't read "when was this created" off the id.

**forge wiring.** This is the default behaviour of `f.id()` on SQL —
`crypto.randomUUID()` fills the id at create time. Per-dialect DDL is in
[the table below](#per-dialect-id-generation-reference).

If you want the DB to do it instead (so a raw `INSERT` from outside the
ORM still gets a defaulted id):

```ts
const Token = model('tokens', { id: f.id({ type: 'uuid' }) });
```

* PG: `id uuid PRIMARY KEY DEFAULT gen_random_uuid()` — `pgcrypto` ships with PG 13+.
* MySQL: `id CHAR(36) PRIMARY KEY DEFAULT (UUID())` — 8.0+.
* MSSQL: `id UNIQUEIDENTIFIER PRIMARY KEY DEFAULT NEWID()`.
* SQLite: no UUID type, no default — the wrapper still fills it.

Pick UUIDv4 when: you have low-to-medium insert volume on the hot
tables, no requirement for ordered ids, and you don't want a generator
dependency.

---

## UUIDv7 — time-ordered UUID

128-bit; the leading 48 bits are a Unix timestamp in milliseconds; the
rest is randomness. Sort order matches creation order at millisecond
granularity. Defined in RFC 9562 (May 2024).

```
018f4e6c-1f5d-7c4e-aa8f-2bc28a514cfb
└─── ms timestamp ───┘
```

**Why pick it.**

* B-tree friendly — new rows append at the right edge of the index, same as a serial. Insert throughput on hot tables stays high; index pages stay dense.
* Still globally unique — 74 bits of randomness is plenty.
* Embeds creation time — you can read it off the id, no `created_at` round-trip needed for "was this row inserted before X?".
* Same wire format as UUIDv4 — drop-in for columns that already store UUID text.

**Why hesitate.**

* No built-in PG / MySQL / SQLite generator in 2026. You need a Postgres extension (`pg_uuidv7`), a generated column, or an app-side generator.
* The first 48 bits leak millisecond-precision creation time — fine for internal references, sometimes leaky on public URLs.

**forge wiring.** Use `f.id({ type: 'uuid' })` for the typed UUID
column, then supply the value at create time with a v7 generator:

```ts
import { uuidv7 } from 'uuidv7';      // npm i uuidv7
const Post = model('posts', { id: f.id({ type: 'uuid' }), title: f.string() });

await db.post.create({ data: { id: uuidv7(), title: 'hello' } });
```

If you want the DB to mint v7s on raw inserts, install `pg_uuidv7` (an
extension) on PG and switch the default in a migration:

```sql
CREATE EXTENSION pg_uuidv7;
ALTER TABLE posts ALTER COLUMN id SET DEFAULT uuid_generate_v7();
```

`forge diff` will flag the changed default; `forge push --enable-extensions`
emits the extension `CREATE` before it touches the table.

Pick UUIDv7 when: you're inserting more than a few hundred rows/sec on
the hot table, want UUID-shaped tokens for external use, and accept the
ms-timestamp leak.

---

## ULID — time-ordered, URL-safe

128 bits, same idea as UUIDv7 (48-bit timestamp + 80-bit randomness),
but encoded as 26-char Crockford base32 instead of hyphenated hex.

```
01HZQF3K8XVNW9R2YPMQ4D7TCN
```

**Why pick it.**

* URL-safe out of the box — no hyphens, no `+`/`/` like base64, no case sensitivity (Crockford excludes I/L/O/U).
* Sortable — alphabetical sort equals chronological sort.
* Shorter than UUID (26 vs 36 chars).
* Library landscape is mature: `ulid`, `ulidx`, `ulid-workers`.

**Why hesitate.**

* No native column type anywhere — stored as a 26-char `text` / `CHAR(26)`. Marginal storage saving over UUID-as-text; same-or-worse than UUID-as-`uuid` (16 bytes binary).
* Crockford base32 isn't case-insensitive at the DB layer unless the column collation cooperates — pick one casing (lowercase or upper) and stick.
* Same ms-timestamp leak as UUIDv7.

**forge wiring.** Plain `f.id()` with the wrapper auto-fill turned off
by supplying an id at every create:

```ts
import { ulid } from 'ulidx';     // npm i ulidx
const Event = model('events', { id: f.id(), kind: f.string() });

await db.event.create({ data: { id: ulid(), kind: 'click' } });
```

Or, to take the wrapper out of the picture entirely:

```ts
const Event = model('events', {
  id:   f.string().unique(),   // wrapper won't auto-fill a non-id field
  kind: f.string(),
});
// You must always pass id at create — there's no fallback.
```

The first form is what most consumers want — `f.id()` keeps `id` as the
PK, and the create call provides a ULID instead of letting the wrapper
mint a v4.

Pick ULID when: you need URL-friendly ordered IDs, you'd rather not
depend on PG extensions, and you're comfortable with the base32
alphabet showing up in user-facing URLs.

---

## CUID / CUID2 — collision-resistant, URL-safe

Designed by Eric Elliott for "collision-resistant unique identifiers"
in horizontal-scale web apps. Two generations:

* **CUID v1** — 25 chars, `c` + timestamp + counter + fingerprint + random. Ordered. Deprecated by upstream in 2023; still widely deployed.
* **CUID v2** — 24 chars by default, configurable, deliberately *not* ordered for privacy. The current recommendation.

```
clx7n3k9j0000zzmd1234abcd   // cuid v1
tz4a98xxat96iws9zmbrgj3a    // cuid2 (entropy first, no leading 'c')
```

**Why pick it.**

* Lowercase URL-safe by design.
* Built-in collision resistance via host fingerprint (v1) or hash-based mixing (v2).
* Slightly shorter than UUID.
* Well-known via Prisma's default `@id @default(cuid())`.

**Why hesitate.**

* v1 leaks creation time and a counter that exposes process activity.
* v2 explicitly drops sortability — your hot inserts fragment again. The library README is explicit: "if you need sortable, use ULID."
* Cuid2 generation is a hash chain — measurably slower than v4 or ULID under load. Fine at app scale, not a bulk-load tool.

**forge wiring.** Same shape as ULID:

```ts
import { createId } from '@paralleldrive/cuid2';
const Comment = model('comments', { id: f.id(), body: f.string() });

await db.comment.create({ data: { id: createId(), body: '…' } });
```

Pick CUID2 when: you're migrating a Prisma app to forge and want id
stability, or you specifically need an opaque non-ordered URL token and
don't want to roll your own.

---

## Snowflake — distributed 64-bit

Twitter's 64-bit ID scheme. Bit layout (Twitter's original; many
variants):

```
 0 │ 41-bit timestamp (ms since epoch)  │ 10-bit worker id │ 12-bit sequence
   └─ sign bit (always 0; fits a signed BIGINT)
```

* 41 bits of ms timestamp ≈ 69 years from the chosen epoch.
* 10 bits of worker id = 1024 distinct machines.
* 12 bits of sequence = 4096 ids/ms/worker = ~4M ids/sec/worker.

```
1834219123712000001
```

**Why pick it.**

* Fits a `BIGINT` — 8 bytes, half the storage of a UUID-as-text and a quarter of UUID-as-text-with-hyphens.
* Integer sort = chronological sort.
* No central coordination during the hot path; coordination is at worker-id assignment time only.
* Battle-tested at Twitter/Discord/Instagram scale.

**Why hesitate.**

* You must hand out worker ids reliably — duplicate workers = duplicate ids = silent data corruption. Discord uses Zookeeper; smaller shops use environment variables or container ordinal IDs.
* Clock skew is a hazard — if a worker's clock goes backwards, you can mint duplicates. Production implementations refuse to issue ids when the clock regresses.
* Discloses worker id and creation time in the bit pattern; treat as semi-public.
* Not a UUID — clients expecting RFC 4122 / 9562 won't accept it.

**forge wiring.** It's a `bigint` field — the wrapper doesn't run an
auto-fill on bigint, so you always supply it:

```ts
import { Snowflake } from '@sapphire/snowflake';
const epoch = new Date('2024-01-01T00:00:00Z');
const snowflake = new Snowflake(epoch);

const Message = model('messages', {
  id:   f.bigint().unique(),      // 64-bit, JS bigint
  body: f.string(),
});

await db.message.create({
  data: { id: snowflake.generate({ workerId: 1n }), body: '…' },
});
```

Note `f.id({ type: 'bigserial' })` is the wrong choice here — that's a
DB-side `AUTO_INCREMENT` / `BIGSERIAL`, which fights you for control of
the bits. Snowflake wants `f.bigint().unique()` so the application owns
the value.

Pick Snowflake when: you're building a fleet of writer services that
need globally-unique sortable integer IDs and you've already solved the
worker-id coordination problem.

---

## Serial / IDENTITY — DB-assigned auto-increment

The thing every relational tutorial reaches for first. Per dialect:

| Dialect | `bigserial` DDL |
|---|---|
| Postgres | `id BIGSERIAL PRIMARY KEY` (≡ `BIGINT` + sequence + default + ownership) |
| MySQL | `id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY` |
| SQLite | `id INTEGER PRIMARY KEY AUTOINCREMENT` |
| MSSQL | `id BIGINT NOT NULL IDENTITY(1,1) PRIMARY KEY` |
| DuckDB | `id BIGINT PRIMARY KEY DEFAULT nextval('orders_id_seq')` (forge emits the sequence too) |
| Mongo | rejected at push — `'bigserial' has no Mongo equivalent` |

**Why pick it.**

* The DB does the work — no app-side generator.
* Compact — 8 bytes; fits a clustered B-tree perfectly.
* Reads well — the smallest ids are the oldest; `WHERE id > N` is a built-in cursor.

**Why hesitate.**

* Leaks count — see [Privacy](#privacy--what-sequential-ids-leak).
* Single-master — every insert touches the sequence; in a multi-writer / multi-region setup this is a bottleneck or a coordination problem.
* Can't generate the id before the INSERT — you find out the id only after the round-trip. Limits some patterns (idempotency keys, upload tokens, eventual-consistency outboxes).
* Migrating from serial → UUID is a non-trivial outage; see [Migrating from serial to UUID](#migrating-from-serial-to-uuid).

**forge wiring.**

```ts
const Order = model('orders', {
  id:    f.id({ type: 'bigserial' }),
  total: f.int(),
});

await db.order.create({ data: { total: 4200 } });   // never pass id
```

`Row<typeof Order>['id']` is `number`. The wrapper rejects a `data.id`
at create — there's no scenario where you'd legitimately want to override
the sequence's choice.

Pick serial when: you're a single-writer monolithic app, the table is
not customer-facing in its raw form, and you want the smallest possible
integer key for an inner join column.

---

## Mongo ObjectId — the Mongo default

12-byte BSON id; 4-byte timestamp + 5-byte random per-process + 3-byte
counter. The wire form in BSON; the JS form is a 24-char hex string when
serialised.

```
6675a7c81f5d7c4eaa8f2bc2
└── 32-bit ts ─┘
```

**Why it's the Mongo default.**

* Time-prefixed — same B-tree-locality argument as UUIDv7.
* 12 bytes — smaller than a UUID-as-text.
* Generated client-side, so the driver knows the id before the insert acknowledges. Mongo's `insertOne` returns the id; forge surfaces it through the standard create result.

**forge wiring.** `f.id()` on Mongo:

* On the wire — `_id: ObjectId(...)`.
* In the model — the field is named `id` and typed as `string`. The Mongo adapter maps `id ↔ _id` in both directions and serialises ObjectId to its hex string.

If you'd rather use a string PK on Mongo (e.g. to keep id shapes
identical between a Postgres write tier and a Mongo cache):

```ts
const Doc = model('docs', { id: f.id({ type: 'uuid' }) });
// On Mongo the id column becomes string, _id stores the same string,
// and the wrapper mints a UUID v4 at create time.
```

Don't reach for `f.id({ type: 'bigserial' })` on Mongo — `forge push`
rejects it. Mongo has no native auto-incrementing scalar concept; the
counter collection pattern is left to userland.

---

## Composite primary keys

The TL;DR: forge doesn't directly support `@@id([a, b])`. The supported
shape is **synthetic `id` + composite `unique`**. From MODEL.md:

> Composite PK workaround. There's no `@@id([a, b])` form. The pattern
> is: keep the row's synthetic `id`, declare the natural key via
> `uniques`, and look up by the composite when needed.

```ts
const Membership = model('memberships', {
  id:      f.id(),               // synthetic — always present
  org_id:  f.objectId(),
  user_id: f.objectId(),
  role:    f.string(),
}, {
  uniques: [['org_id', 'user_id']],
});

// Lookup by the composite key uses the synthetic name:
await db.membership.findFirst({
  where: { org_id_user_id: { org_id: 'o_1', user_id: 'u_1' } },
});
```

**Trade-offs vs a true composite PK.**

| Concern | True composite PK | Synthetic id + composite unique |
|---|---|---|
| Insert throughput | Fast (no extra index) | One extra B-tree (`id`) |
| FK target | Two-column FK in dependents | Single-column FK on `id` |
| Storage | Two columns | Three (`id` + the two natural cols) |
| Dialect portability | Mongo has no compound `_id` | Works on every adapter |
| ORM ergonomics | Awkward — every helper needs two args | Standard — `findById` works |

The synthetic-id shape is the right default for an ORM that targets six
dialects including Mongo. The exceptions where a true composite PK pays
off — heavy junction tables in append-only OLAP — are better served by
hand-rolled DDL via [RAW-SQL.md](./RAW-SQL.md).

The full IndexDef surface that `uniques` desugars into is in
[INDEXES.md](./INDEXES.md).

---

## Per-dialect ID generation reference

Where each `f.id()` choice gets its bytes:

| | `f.id()` (auto) | `f.id({ type: 'uuid' })` | `f.id({ type: 'bigserial' })` |
|---|---|---|---|
| **PG** | `text PRIMARY KEY`. Wrapper fills with `randomUUID()` at create. | `uuid PRIMARY KEY DEFAULT gen_random_uuid()`. PG mints it. | `BIGSERIAL PRIMARY KEY`. PG mints from the sequence. |
| **MySQL** | `VARCHAR(64) PRIMARY KEY`. Wrapper fills `randomUUID()`. | `CHAR(36) PRIMARY KEY DEFAULT (UUID())`. MySQL mints it (8.0+). | `BIGINT AUTO_INCREMENT PRIMARY KEY`. MySQL mints it. |
| **SQLite** | `TEXT PRIMARY KEY`. Wrapper fills. No DB default (SQLite has no UUID generator). | Same as auto — SQLite has no UUID type. | `INTEGER PRIMARY KEY AUTOINCREMENT`. SQLite mints from ROWID. |
| **MSSQL** | `NVARCHAR(64) PRIMARY KEY`. Wrapper fills. | `UNIQUEIDENTIFIER PRIMARY KEY DEFAULT NEWID()`. Random. | `BIGINT IDENTITY(1,1) PRIMARY KEY`. MSSQL mints it. |
| **DuckDB** | `VARCHAR PRIMARY KEY`. Wrapper fills. | `UUID PRIMARY KEY DEFAULT gen_random_uuid()`. DuckDB mints it. | `BIGINT PRIMARY KEY DEFAULT nextval(...)`. Sequence emitted. |
| **Mongo** | `_id: ObjectId` minted in `coerceInbound`. | Same shape as auto, but the value is a string UUID v4 minted by the wrapper. | Rejected at push — no Mongo equivalent. |

**MSSQL `NEWID` vs `NEWSEQUENTIALID`.** `NEWID()` is random — the
analogue of UUIDv4, with the same fragmentation pain on clustered
indexes. `NEWSEQUENTIALID()` is monotonic within a process but resets
across restarts, which has its own caveats (you can read the previous
sequential bucket from the public id). Forge emits `NEWID()` for
`f.id({ type: 'uuid' })` — switch to `NEWSEQUENTIALID()` via a manual
default in a migration if your workload demands it:

```sql
ALTER TABLE [tokens]
  ADD CONSTRAINT DF_tokens_id DEFAULT NEWSEQUENTIALID() FOR [id];
```

`forge diff` will flag the changed default; treat the constraint as
external state and add it to the ignore list if you don't want it
fighting drift detection.

**Postgres `uuid_generate_v7`.** Not standard. The community
`pg_uuidv7` extension supplies it; `forge push --enable-extensions`
will run the `CREATE EXTENSION` for you if the extension is in
`shared_preload_libraries`. Otherwise the migration must include the
`CREATE EXTENSION` step manually.

---

## App-generated vs DB-generated

Two axes that affect every PK choice:

**1. Can the app know the id before the INSERT lands?**

| Strategy | App knows id pre-INSERT? |
|---|---|
| `f.id()` (auto) | Yes — the wrapper mints `randomUUID()` and the create returns it. |
| `f.id({ type: 'uuid' })` on PG/MySQL/MSSQL | No — DB picks. The `RETURNING id` clause hands it back. |
| `f.id({ type: 'uuid' })` on SQLite/Mongo | Yes — wrapper fills it. |
| `f.id({ type: 'bigserial' })` | No — DB picks. `RETURNING id` / `LAST_INSERT_ID()` / Mongo n/a. |
| ULID/CUID/Snowflake (app-supplied) | Yes — you generated it. |

The "yes" cases unlock three patterns:

* **Idempotent inserts.** The client mints the id, retries the insert N times; the unique constraint dedupes. No round-trip to learn the id. Detail in [IDEMPOTENCY.md](./IDEMPOTENCY.md).
* **Pre-allocated foreign keys.** Insert parent and child in any order — both ids are known up front. The wrapper inserts in dependency order anyway; this matters for hand-rolled `$queryRaw` batches.
* **Optimistic UI.** The client tells the server its id; the server validates and stores. The UI never has to swap a temporary id for a real one.

**2. Who validates uniqueness?**

DB-generated ids inherit the dialect's collision guarantee — sequences
never collide; `gen_random_uuid` collides with vanishing probability.
App-generated ids inherit your generator's guarantee. UUIDv4 is fine.
Snowflake requires you to not double-assign worker ids. CUID2 mixes a
host fingerprint so two processes on the same host don't collide.

The DB always has the last word — the unique index on the PK column
rejects duplicates regardless of who minted them. App-side dedup is a
prefiltering convenience, not a guarantee.

---

## Index fragmentation

The B-tree page that just received row `N` rarely receives row `N+1`
when ids are random — the new id sorts elsewhere. The page-fill rate
drops; the index gets bigger than it needs to; bufferpool cache hit
rate drops; insert throughput tanks on hot tables.

Order of severity, hot-table-insert workload:

```
UUIDv4         ████████████████████  worst — random across the keyspace
NEWID() MSSQL  ███████████████████   same shape
CUID2          ██████████████████    deliberately randomised
ObjectId       ███                   first 4 bytes are timestamp — near-sorted
UUIDv7         ██                    first 48 bits are timestamp — sorted
ULID           ██                    first 48 bits are timestamp — sorted
Snowflake      █                     full integer, monotonic
bigserial      —                     strictly monotonic; no fragmentation
```

Two ways to escape v4 fragmentation:

1. **Pick an ordered ID.** UUIDv7, ULID, Snowflake, ObjectId, bigserial.
2. **Move the PK off the clustered index.** On MSSQL you can declare the
   PK as `NONCLUSTERED` and add a `CLUSTERED` index on `(created_at)` or
   another truly-monotonic column. On Postgres there is no
   clustering equivalent at insert time — `CLUSTER` is a manual
   periodic operation, not a property of the table.

The cost of v4 fragmentation only matters past a few thousand
inserts/sec on the hot table. Below that, the readability and
zero-dependency wins of UUIDv4 outweigh the index shape concerns.

---

## Privacy — what sequential IDs leak

`https://example.com/orders/4837` tells anyone with curl two things:

* You have at least 4837 orders.
* You'll have N more orders by next week (poll the endpoint nightly,
  diff the highest 200 response, infer growth rate).

This is the German Tank Problem and it's been measured against real
SaaS companies during M&A diligence. Sequential ids in user-facing URLs
or invoices broadcast your revenue trajectory to anyone who cares.

Mitigations:

* **Use a non-sequential id in URLs.** UUIDv4/ULID/CUID2 all fix it.
* **Keep `bigserial` internally, expose a separate token.** Add a `slug TEXT UNIQUE` or `token UUID UNIQUE` column for external references; the inner join column stays a tight integer. This is the pattern Stripe documents under "ID prefix + opaque token".
* **Hashids / Sqids — don't.** They obfuscate but are reversible by anyone who reads the source for the library. Treat them as cosmetic, not security.

If you do use `bigserial`, make sure no public endpoint exposes the
raw id. Forge can't enforce this — your API contract has to.

---

## URL safety

What characters end up in a URL when you string-concat the id:

| Strategy | URL-safe? | Notes |
|---|---|---|
| UUIDv4 / v7 | Mostly | Hyphens are URL-safe per RFC 3986. 36 chars. |
| ULID | Yes | Crockford base32 — `[0-9A-HJKMNP-TV-Z]`. 26 chars. |
| CUID2 | Yes | Lowercase + digits. ~24 chars. |
| Snowflake | Yes | Pure digits. ~19 chars. |
| `bigserial` | Yes | Pure digits. Variable length. |
| Mongo ObjectId | Yes | 24 hex chars. |
| Base64 (if you roll your own) | **No** | `+`, `/`, `=` need escaping. Use base64url if you must. |

URL-safe doesn't mean human-readable. `tz4a98xxat96iws9zmbrgj3a` reads
as line noise; the URL won't break, but the support ticket where a
human reads it back over the phone will. For order numbers or invoice
ids that humans transcribe, a separate `serial`-style display id is
worth carrying alongside the opaque PK.

---

## Foreign-key impact

The id type cascades — every FK column has to be the same type as the
referenced PK. `f.objectId()` is forge's portable FK shape; on the
wire it's a string everywhere except Mongo (where it's an `ObjectId`),
which lines up with `f.id()`'s default behaviour.

**Same `f.id()` strategy, no surprises.**

```ts
const User = model('users', { id: f.id() });
const Post = model('posts', {
  id:        f.id(),
  author_id: f.objectId(),     // string FK to users.id
});
```

`author_id` is a string. Joins compile to `posts.author_id = users.id` —
both string-typed.

**Mixed strategies trip you up.**

```ts
const User = model('users', { id: f.id({ type: 'bigserial' }) });
const Post = model('posts', {
  id:        f.id(),
  author_id: f.objectId(),     // <-- WRONG: string vs number
});
```

`f.objectId()` is the string-FK shape; pointing it at a `bigserial` PK
gives you a string column referencing an integer column. Forge won't
emit a `FOREIGN KEY` constraint that mismatches the type — `forge push`
will complain. Use `f.int()` (or `f.bigint()`) on the FK side and
manage the constraint yourself via `indexes`:

```ts
const Post = model('posts', {
  id:        f.id(),
  author_id: f.int(),
}, {
  indexes: [{ keys: { author_id: 1 } }],
});
// Add the FK constraint explicitly in a migration; the wrapper doesn't
// know it's an FK in this shape.
```

The safest rule: **pick one PK strategy for the entire schema** and
keep all FKs on `f.objectId()`. Mixed strategies work but cost
ergonomics. Mixing UUID PKs with `bigserial` PKs in the same schema is
the most common foot-gun.

---

## Migrating from serial to UUID

The textbook outage. Here's the safe pattern.

**Phase 0 — establish the new id column.**

```sql
ALTER TABLE orders ADD COLUMN new_id UUID DEFAULT gen_random_uuid();
UPDATE orders SET new_id = gen_random_uuid() WHERE new_id IS NULL;
ALTER TABLE orders ALTER COLUMN new_id SET NOT NULL;
CREATE UNIQUE INDEX orders_new_id_uidx ON orders(new_id);
```

The table has both columns now. Reads still go to the old `id`.

**Phase 1 — backfill every FK with the new shape.**

For each FK column referencing `orders.id`:

```sql
ALTER TABLE order_items ADD COLUMN order_new_id UUID;
UPDATE order_items oi
   SET order_new_id = o.new_id
  FROM orders o
 WHERE oi.order_id = o.id;
ALTER TABLE order_items ALTER COLUMN order_new_id SET NOT NULL;
CREATE INDEX ON order_items(order_new_id);
```

**Phase 2 — write twice from the app.** Update the schema so writes set
both old and new ids. Reads still join on the old column.

**Phase 3 — switch reads to the new column.** This is the deploy step;
strictly speaking the app downtime is the time between flipping the
read code-path and verifying it. Plan a rollback by leaving the old FK
columns intact.

**Phase 4 — drop the old columns.**

```sql
ALTER TABLE order_items DROP COLUMN order_id;
ALTER TABLE order_items RENAME COLUMN order_new_id TO order_id;

ALTER TABLE orders DROP COLUMN id;
ALTER TABLE orders RENAME COLUMN new_id TO id;
ALTER TABLE orders ADD PRIMARY KEY (id);
```

**Phase 5 — drop the dual-write.**

Total downtime: zero if you split the phases across deploys, single-digit
seconds if you batch phases 2-3 in a maintenance window. The opposite
direction (UUID → serial) is the same shape but harder — you can't
generate a backfill sequence without picking an order.

The forge wrapper doesn't ship a "migrate id strategy" command. The DDL
above is `$executeRaw` or a hand-written migration script; forge's role
is to keep the schema definition in sync once the migration lands.

`forge diff` is your friend during this — run it against staging after
each phase to confirm the live schema matches expectations.

Detail on migration mechanics in [MIGRATIONS.md](./MIGRATIONS.md).

---

## Hot-shard avoidance

In a sharded setup — Mongo's hashed shard key, Postgres + Citus, MySQL
+ Vitess, app-level sharding — the shard key is derived from the PK
(directly or via hash). Two anti-patterns:

**1. Ranged shard key on a strictly monotonic PK.**

Every new row lands on the same shard until the range tips over. The
last shard runs hot; the others starve. Classic at write rates above
~10k inserts/sec.

Fix: hash the PK before sharding (Mongo: `sh.shardCollection(..., { id: 'hashed' })`)
or move to a non-monotonic id strategy for the sharded table.

**2. Time-bucket primary keys with cross-bucket reads.**

Composite PKs like `(year_month, sequence)` cluster writes by month —
great for write throughput, terrible for cross-month range reads. Every
month-boundary query touches every bucket.

Fix: keep the time-bucketed id as a secondary clustered index; keep the
PK on a UUID/ULID.

**ULID's natural shape.** ULID's leading 48-bit timestamp is in the
millisecond range, not the month range. Inserts cluster on the
millisecond — fine-grained enough that a healthy shard count
distributes the load. This is the sweet spot for write-heavy sharded
workloads.

For the full shard-key picker see [SHARDING.md](./SHARDING.md).

---

## Worked examples

### (a) Blog post with UUIDv7

A standard CMS workload: more reads than writes, but bursty publish
events, and we want IDs to sort by creation time for "latest posts"
queries without an `ORDER BY created_at`.

```ts
import { model, f, rel } from 'forge-orm';
import { uuidv7 } from 'uuidv7';                 // npm i uuidv7

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

// At create time, supply a v7 instead of letting PG mint v4:
await db.post.create({
  data: {
    id:        uuidv7(),
    author_id: authorId,
    slug:      'why-uuidv7',
    title:     'Why UUIDv7',
    body:      '…',
  },
});

// "Latest 20 posts by author" — ORDER BY id DESC is now correct.
await db.post.findMany({
  where:   { author_id: authorId },
  orderBy: { id: 'desc' },
  take:    20,
});
```

Why not switch the DB default to v7? You can on PG with `pg_uuidv7`,
but two things stop most teams:

* The extension isn't on managed Postgres providers as of mid-2026 (RDS, Cloud SQL, Supabase managed).
* The app-side generator works the same on SQLite (dev), Postgres (prod), and Mongo (analytics replica) — one library, three storage engines.

### (b) Order with composite [year, sequence]

A bookkeeping table where the natural identifier is "the Nth order of
year Y" — used on invoices, transcribed by humans, must be reset every
January 1.

forge has no true composite PK; the pattern is synthetic `id` + unique
`(year, seq)` + a derived display string.

```ts
export const Order = model('orders', {
  id:           f.id({ type: 'uuid' }),
  year:         f.int(),
  seq:          f.int(),
  display_no:   f.string().unique(),    // "2026-000123"
  total_cents:  f.int(),
  createdAt:    f.dateTime().default('now'),
}, {
  uniques: [['year', 'seq']],
});

// Allocate the next sequence — DB-side to keep contention sane.
const next = await db.$queryRaw<{ seq: number }[]>`
  INSERT INTO order_seqs (year, seq)
  VALUES (${year}, 1)
  ON CONFLICT (year) DO UPDATE SET seq = order_seqs.seq + 1
  RETURNING seq
`;

const seq = next[0].seq;
await db.order.create({
  data: {
    year,
    seq,
    display_no: `${year}-${String(seq).padStart(6, '0')}`,
    total_cents,
  },
});
```

Three things to call out:

* `display_no` is the URL-visible id; the UUID PK is internal.
* The `(year, seq)` unique guards against double-allocation if the seq table is wrong.
* The seq counter is a tiny separate table; in MySQL it's the same shape with `ON DUPLICATE KEY UPDATE` instead of `ON CONFLICT`. Cross-dialect detail in [UPSERT.md](./UPSERT.md).

### (c) Snowflake for a distributed message bus

Multi-region writers minting messages at high rates. We want sortable
integer ids across regions, no round-trip to a central allocator.

```ts
import { Snowflake } from '@sapphire/snowflake';

const epoch = new Date('2024-01-01T00:00:00Z');
const sf = new Snowflake(epoch);

// Worker id assigned at boot from env (Kubernetes ordinal, or Consul).
const workerId = BigInt(process.env.WORKER_ID ?? '1');

export const Message = model('messages', {
  id:        f.bigint().unique(),       // 64-bit; never null; PK by app convention
  channel:   f.string(),
  body:      f.text(),
  createdAt: f.dateTime().default('now'),
}, {
  indexes: [{ keys: { channel: 1, id: -1 } }],
});

await db.message.create({
  data: { id: sf.generate({ workerId }), channel: 'general', body: '…' },
});

// "Messages since X" — id range works because Snowflake is monotonic.
await db.message.findMany({
  where:   { channel: 'general', id: { gt: lastSeenId } },
  orderBy: { id: 'asc' },
});
```

Caveats:

* `f.bigint().unique()` gives a unique index, not a PRIMARY KEY. If you need `id` to be the PK, the cleanest workaround is to leave the column structure as-is and add a `PRIMARY KEY (id)` via raw DDL in a migration — forge will respect the existing constraint on subsequent pushes. (Forge doesn't model "bigint as PK" because `f.id({ type: 'bigserial' })` already covers DB-assigned ints, and we don't want two ways to do it.)
* Don't use `f.id({ type: 'bigserial' })` here — the DB will mint values that fight your snowflake values.
* Worker-id collisions = id collisions. Treat the worker-id allocation table as a sacred mutex.

### (d) Mongo ObjectId vs string PK

Two valid Mongo shapes; pick by whether you'll ever read this collection
from a relational replica.

**ObjectId — the default.**

```ts
const Event = model('events', {
  id:      f.id(),                   // _id: ObjectId
  user_id: f.objectId(),
  kind:    f.string(),
});

await db.event.create({ data: { user_id: 'u_1', kind: 'click' } });
```

* 12 bytes on disk per id, 16 bytes per `_id` index entry.
* `_id` index is `{ _id: 1 }` — ordered by ObjectId, which is roughly ordered by time.
* Forge maps `id ↔ _id` transparently; the app never sees `_id`.

**String UUID — when ids cross to a SQL replica.**

```ts
const Event = model('events', {
  id:      f.id({ type: 'uuid' }),   // _id: string (UUID v4)
  user_id: f.objectId(),
  kind:    f.string(),
});
```

* 36 bytes on disk per id, ~46 bytes per `_id` index entry — measurable on a billion-row collection.
* `_id` index is random — same fragmentation pattern as UUID v4 anywhere else.
* But: the same string id flows to Postgres / ClickHouse / Snowflake for analytics. No translation step in the ETL.

The right call is workload-driven. A Mongo-only audit log → ObjectId.
A shared-id event stream → string UUID (or app-supplied UUIDv7 to keep
sortability).

---

## Cross-links

* [MODEL.md](./MODEL.md#id-strategies) — `f.id()` surface, the four DDL examples this page expands on.
* [MODEL.md — Identifiers](./MODEL.md#identifiers--fid-and-fobjectid) — `f.id()` vs `f.objectId()`; field-type table.
* [INDEXES.md](./INDEXES.md) — what a PK becomes on each dialect's clustered/non-clustered index.
* [SHARDING.md](./SHARDING.md) — how PK shape interacts with shard keys and hot-shard avoidance.
* [MIGRATIONS.md](./MIGRATIONS.md) — running the DDL for an id-strategy change; `forge push` mechanics.
* [MONGO.md](./MONGO.md) — `_id` mapping, ObjectId semantics, the `id ↔ _id` rewrite.
* [POSTGRES.md](./POSTGRES.md) — `gen_random_uuid`, `pg_uuidv7`, sequence ownership, `RETURNING id`.
* [MYSQL.md](./MYSQL.md) — `UUID()`, `AUTO_INCREMENT`, `LAST_INSERT_ID()` semantics.
* [MSSQL.md](./MSSQL.md) — `NEWID` vs `NEWSEQUENTIALID`, `IDENTITY` semantics.
* [IDEMPOTENCY.md](./IDEMPOTENCY.md) — app-generated ids as the foundation for retry-safe inserts.
* [UPSERT.md](./UPSERT.md) — composite-unique lookups when the PK is synthetic.
* [RAW-SQL.md](./RAW-SQL.md) — hand-rolled DDL for true composite PKs and id-strategy migrations.
