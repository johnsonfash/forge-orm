# Dates and times

`f.dateTime`, `f.date`, `f.time` — what forge-orm emits per dialect, what
JS `Date` actually carries (UTC instant, no timezone), and the patterns
for the three different "date" problems (UTC instants, calendar events
with local time, plain dates without time).

The first thing to clear up: forge ships **one** date/time builder.
There is no `f.date()`, no `f.time()`, no `f.timestamp()`, no
`f.timestampTz()` — just `f.dateTime()`. Every per-dialect column type
in the README emits from that one builder. The reason is that JS only
has one date primitive (`Date`), and a typed field whose JS-side type
doesn't match its SQL-side semantics is a footgun. Dropping the time
component, storing wall-clock without a zone, separating date and time
columns — those are all schema patterns *on top of* `f.dateTime()` (or
`f.string()` / `f.int()` when JS `Date` would actively lie). This doc
walks through each pattern with the reasoning.

Related deep-dives:

* [MODEL.md](./MODEL.md#boolean-and-datetime) — `f.dateTime()` in the
  field catalogue.
* [TYPES.md](./TYPES.md#row-typeof-model) — what `Row` resolves to per
  builder.
* [RUNTIME-VALIDATION.md](./RUNTIME-VALIDATION.md) — zod transforms for
  parsing dates at API boundaries.
* [JSON-PATH.md](./JSON-PATH.md) — dates inside JSON columns.
* [POSTGRES.md](./POSTGRES.md), [MYSQL.md](./MYSQL.md), [SQLITE.md](./SQLITE.md),
  [MONGO.md](./MONGO.md), [MSSQL.md](./MSSQL.md), [DUCKDB.md](./DUCKDB.md)
  — per-dialect details.

---

## Contents

* [The forge surface — what exists](#the-forge-surface--what-exists)
* [JS `Date` — UTC instant, timezone-naive (it lies)](#js-date--utc-instant-timezone-naive-it-lies)
* [Per-dialect emit](#per-dialect-emit)
* [Round-trip — what gets lost](#round-trip--what-gets-lost)
* [The three "date" problems](#the-three-date-problems)
* [Pattern 1 — UTC instant (the default, the recommendation)](#pattern-1--utc-instant-the-default-the-recommendation)
* [Pattern 2 — calendar event (wall-clock + tz)](#pattern-2--calendar-event-wall-clock--tz)
* [Pattern 3 — plain date (no time at all)](#pattern-3--plain-date-no-time-at-all)
* [Pattern 4 — plain time (time-of-day, no date)](#pattern-4--plain-time-time-of-day-no-date)
* [`now()` — server time vs DB time](#now--server-time-vs-db-time)
* [Dates in JSON](#dates-in-json)
* [Range queries](#range-queries)
* [DST gotchas](#dst-gotchas)
* [Indexes on date columns](#indexes-on-date-columns)
* [Date arithmetic — intervals, date_trunc, age](#date-arithmetic--intervals-date_trunc-age)
* [Temporal API (TC39) and userland libraries](#temporal-api-tc39-and-userland-libraries)
* [Worked examples](#worked-examples)
* [Common bugs](#common-bugs)

---

## The forge surface — what exists

```ts
f.dateTime()                              // the only builder
f.dateTime().optional()                   // nullable
f.dateTime().default('now')               // DB default — now() / CURRENT_TIMESTAMP
f.dateTime().default('now').updatedAt()   // wrapper bumps on every UPDATE
f.dateTime().softDeleteAt()               // soft-delete marker column
```

That is the whole API. The README is honest about it (see
[MODEL.md — Boolean and dateTime](./MODEL.md#boolean-and-datetime)): one
builder, one JS-side type (`Date`), six per-dialect storage emissions.

A note on the column types other ORMs expose:

* **Date-only (no time)** — store as `f.dateTime()` and discard the time
  in your write code, *or* store as `f.string()` (YYYY-MM-DD) and let
  the application read it as a string. See
  [Pattern 3](#pattern-3--plain-date-no-time-at-all).
* **Time-only (no date)** — store as `f.string()` (HH:MM:SS) or as
  `f.int()` (minutes since midnight). JS has no time-of-day primitive,
  so `Date` would be a lie here. See
  [Pattern 4](#pattern-4--plain-time-time-of-day-no-date).
* **Timestamp (no tz)** — there's no separate builder, but PG
  `timestamp` (no tz) and MySQL `DATETIME` (no tz) are the *default*
  emissions when you use `f.dateTime()` on those dialects in a few
  framework wrappers. forge takes the opposite stance: every dialect
  emits a tz-aware column type when one is available, because mixing
  tz-aware and tz-naive columns in the same database is the single
  fastest way to lose a timezone bug for six months. See
  [Per-dialect emit](#per-dialect-emit).
* **Timestamp with tz** — that's what `f.dateTime()` already gives you
  on PG (`timestamptz`), DuckDB (`TIMESTAMPTZ`), and MSSQL
  (`DATETIMEOFFSET`). MySQL `DATETIME(3)` is tz-naive but normalised to
  UTC by convention (see below). SQLite has no timestamp type, so forge
  stores ISO-8601 text with an explicit `Z` suffix.

The narrowness is the feature. One builder, one JS type, six dialect
columns chosen to behave the same way on round-trip. If you want a
calendar-event store (local wall-clock + zone) or a date-only column,
that's *schema design* on top of the primitives — not a separate
builder.

The remaining sections walk through the four problem shapes and how to
solve them with what forge actually ships.

---

## JS `Date` — UTC instant, timezone-naive (it lies)

A primer on `Date` itself. The single source of every date bug worth
fixing.

A JS `Date` holds **one number**: milliseconds since
1970-01-01T00:00:00Z (the Unix epoch, in UTC). No timezone, no
calendar, no offset — just a 64-bit count of milliseconds.

```ts
const d = new Date('2026-06-24T15:30:00Z');
d.valueOf();    // 1782143400000 — the only field that exists
d.getTime();    // 1782143400000 — same number, alternate accessor
```

Everything else `Date` shows you is derived from the host runtime's
local timezone. That's the lie:

```ts
const d = new Date('2026-06-24T15:30:00Z');

d.toString();           // 'Wed Jun 24 2026 16:30:00 GMT+0100 (BST)'   if TZ=Europe/London
d.getHours();           // 16                                          (BST hour)
d.getUTCHours();        // 15                                          (the truth)
d.toLocaleString();     // '6/24/2026, 4:30:00 PM'                     (local)
d.toISOString();        // '2026-06-24T15:30:00.000Z'                  (the only safe stringification)
```

A `Date` is **an instant**, not a date+time. `new Date('2026-06-24')`
parses as midnight UTC — *not midnight in your local zone*.
`new Date('2026-06-24T00:00:00')` (no `Z`) parses as midnight in the
runtime's local zone, which is a different instant depending on where
the code runs:

```ts
process.env.TZ = 'UTC';
new Date('2026-06-24T00:00:00').toISOString();
// '2026-06-24T00:00:00.000Z'

process.env.TZ = 'America/Los_Angeles';
new Date('2026-06-24T00:00:00').toISOString();
// '2026-06-24T07:00:00.000Z'    — seven hours later
```

Three operational rules:

1. **Always use `toISOString()` for stringification** — never
   `toString`, never `toLocaleString`.
2. **Always include the `Z` suffix on parse** — a parse without an
   explicit offset depends on the runtime's TZ env.
3. **Never compare wall-clocks with `Date`.** "Is 3pm London the same
   as 3pm New York?" — `Date` cannot represent the question. Use two
   strings + two zones + a library (or Temporal).

Every forge adapter stores the underlying instant and returns a `Date`
whose `getTime()` matches what went in. Wall-clock per zone is
render-time, not storage.

---

## Per-dialect emit

What `f.dateTime()` emits per dialect, verified against the adapter
source:

| Dialect | Column type | TZ behaviour | Precision | Source |
|---|---|---|---|---|
| Postgres | `timestamptz` | stores UTC, displays in client tz | µs (6 digits) | `src/adapters/postgres/dialect.ts` |
| MySQL | `DATETIME(3)` | tz-naive; forge writes ISO-UTC | ms (3 digits) | `src/adapters/mysql/dialect.ts` |
| SQLite | `TEXT` (ISO-8601 with `Z`) | UTC by convention | ms (whatever ISO carries) | `src/adapters/sqlite/dialect.ts` |
| DuckDB | `TIMESTAMPTZ` | stores UTC, displays in session tz | µs | `src/adapters/duckdb/dialect.ts` |
| MSSQL | `DATETIMEOFFSET` | stores the instant + offset | 100 ns | `src/adapters/mssql/dialect.ts` |
| Mongo | `ISODate` (BSON `Date`) | ms since epoch (UTC) | ms | `src/adapters/mongo/dialect.ts` |

A few things this table is hiding.

**Postgres `timestamptz`.** The name is misleading: PG does *not* store
the original timezone. It converts the input to UTC at write time and
stores a UTC instant. On read, it formats according to the session's
`TimeZone` setting (default varies on hosted PG). The forge driver pins
the session to UTC on connect, so reads come back as UTC ISO strings —
which `pg`'s built-in type parser hands to the application as `Date`.

**MySQL `DATETIME(3)`.** MySQL has two relevant types: `DATETIME`
(tz-naive, stored as wall-clock) and `TIMESTAMP` (UTC-internal,
session-converted). forge picks `DATETIME(3)` — millisecond precision,
tz-naive — because `TIMESTAMP` has a fixed 1970–2038 range (32-bit
seconds) and a "session timezone changes the value on read" footgun.
forge always writes `new Date().toISOString()`, MySQL2 parses that as
UTC, stores the wall-clock, and reads it back as a `Date` whose
`getTime()` matches. Trade-off: a non-forge tool reading the column
(BI dashboard, DBA at the CLI) sees the UTC wall-clock without a `Z`
— accurate, but confusing in a non-UTC zone.

**SQLite.** No native date or time type. SQLite's "type" is metadata
only — every value is `TEXT`, `INTEGER`, `REAL`, or `BLOB`. forge
stores `f.dateTime()` as ISO-8601 text with a `Z` suffix; the read
path (`src/adapters/sqlite/execute.ts`) calls `new Date(value)` on
every `dateTime` column. ISO-8601 sorts correctly lexically — range
queries on a text column are O(log n) B-tree scans, no slower than
numeric. Alternative encodings (INTEGER unix-epoch, REAL julian day)
both work for math but are opaque on `SELECT * FROM` from the CLI;
forge picked text for readability. If you want either, store as
`f.bigint()` / `f.float()` and convert in your write/read layer.

**DuckDB `TIMESTAMPTZ`.** Same semantics as Postgres — UTC-internal,
session-tz on render, returned as JS `Date`. DuckDB also has
`TIMESTAMP_S` / `TIMESTAMP_MS` / `TIMESTAMP_NS` and a `DATE` type;
forge emits none of them because every path settles on JS `Date`
(ms precision) and `TIMESTAMPTZ` is the closest match.

**MSSQL `DATETIMEOFFSET`.** Unlike PG and DuckDB, MSSQL actually
stores the offset bytes alongside the instant
(`YYYY-MM-DDTHH:MM:SS.fffffff +HH:MM`). forge writes with `+00:00`
always; on read, `mssql` returns a JS `Date` (instant only — offset
discarded). The offset survives on disk and is available to SQL-side
queries (`AT TIME ZONE`). MSSQL also has `DATETIME2` (tz-naive, 100ns)
and legacy `DATETIME` (~3.33ms); forge picks `DATETIMEOFFSET` for the
same reason it picks `timestamptz` on PG — tz-aware is strictly more
information.

**Mongo `ISODate`.** BSON `Date` is a 64-bit signed integer of
milliseconds since epoch. No timezone, no sub-ms precision. The Node
driver returns a JS `Date`; round-trip is lossless at JS-side
resolution.

---

## Round-trip — what gets lost

For each dialect, what survives a `db.x.update({ data: { ts: d } })`
followed by a `db.x.findFirst()` read of the same row.

| Dialect | Preserved | Lost |
|---|---|---|
| Postgres | UTC instant to µs | sub-µs precision; original tz (normalised to UTC) |
| MySQL | UTC instant to ms | sub-ms precision |
| SQLite | UTC instant to ms (string-encoded) | sub-ms precision; numeric efficiency |
| DuckDB | UTC instant to µs | sub-µs precision; original tz |
| MSSQL | UTC instant to 100ns + offset bytes | sub-100ns precision; JS-side offset (driver discards) |
| Mongo | UTC instant to ms | sub-ms precision |

JS `Date` is ms-precise (`valueOf()` is a millisecond count). The
DB-side precision exceeds JS on PG / DuckDB / MSSQL — *if* you wrote
through forge. A non-forge writer (e.g. `INSERT … VALUES (now())` in
PG, which is µs-precise) can store a value below ms granularity; a
forge read rounds it to the nearest ms on the way to JS. That rounding
is in the driver type parser, not in forge. The Temporal API (see
[below](#temporal-api-tc39-and-userland-libraries)) is the JS-side fix
for the sub-ms gap; it doesn't change what the DB stores.

---

## The three "date" problems

The reason `Date` is the source of so many bugs is that three completely
different problems all share the word "date" in casual English:

1. **An instant.** A specific moment that everyone in the world
   experiences simultaneously. "The order was placed at 2026-06-24
   15:30:00 UTC." This is what `f.dateTime()` is for. JS `Date`
   represents it correctly.

2. **A calendar event.** A wall-clock time in a specific place that
   *doesn't change* when the user travels. "The meeting is at 9am
   Tuesday in London" — if I fly to NYC on Monday, the meeting is still
   at 9am London, which is now 4am NYC for me. The same instant on the
   wire would be wrong if the meeting got rescheduled because BST
   started/ended (DST shifts the offset, not the wall-clock). JS `Date`
   *cannot represent this correctly* — it's an instant. You need
   wall-clock + zone, stored separately.

3. **A plain date with no time at all.** "User's birthday is 1990-04-15."
   Asking "what timezone is this in?" makes no sense — birthdays don't
   shift with offsets. Asking "what time of day?" makes no sense either
   — there's no time. JS `Date` *cannot represent this correctly* —
   any moment you pick (midnight UTC? midnight local?) is wrong on some
   axis. You need a date string (`'1990-04-15'`) or a 3-tuple
   `{ year, month, day }`.

The next three sections show the schema patterns for each, in forge.

---

## Pattern 1 — UTC instant (the default, the recommendation)

The 80% case. Order placed, user signed up, row was created — anything
where the question is "when did this happen?" and every reader anywhere
on Earth would agree.

```ts
const Order = model('orders', {
  id:         f.id(),
  customerId: f.objectId(),
  placedAt:   f.dateTime().default('now'),
  shippedAt:  f.dateTime().optional(),
});
```

What this gives you:

* `Row<typeof Order>['placedAt']` is `Date` — a UTC instant.
* PG / DuckDB / MSSQL store with tz-aware column types; MySQL stores
  UTC wall-clock; SQLite stores ISO-8601 text with `Z`; Mongo stores
  BSON `Date`. The application never sees the difference.
* `placedAt` reads back as `Date` with the same `getTime()` that was
  written (modulo sub-ms truncation if a non-forge writer set µs).
* Range queries on `placedAt` work cross-dialect with `gte` / `lte`
  filters.

Render in the user's timezone at the *view* layer, never at the data
layer:

```ts
// API: server returns ISO strings (the wire format every consumer agrees on)
return {
  id: order.id,
  placedAt: order.placedAt.toISOString(),  // '2026-06-24T15:30:00.000Z'
};

// Client: render in the viewer's zone at the last possible moment
const placed = new Date(serverOrder.placedAt);
return new Intl.DateTimeFormat('en-GB', {
  dateStyle: 'medium',
  timeStyle: 'short',
  timeZone: viewer.timezone,            // 'Africa/Lagos', 'America/New_York', …
}).format(placed);
```

`Intl.DateTimeFormat` ships with every modern JS runtime (Node, Bun,
every browser since 2017) and gets its zone data from ICU / CLDR.
Pass the viewer's IANA zone name explicitly — never trust the runtime
default.

**Default value.** `f.dateTime().default('now')` emits a DB-side
default per dialect:

* PG → `DEFAULT now()`
* MySQL → `DEFAULT CURRENT_TIMESTAMP(3)`
* SQLite → `DEFAULT CURRENT_TIMESTAMP`
* DuckDB → `DEFAULT now()`
* MSSQL → `DEFAULT SYSDATETIMEOFFSET()`
* Mongo → application-side (no DDL); wrapper fills in at write

For Mongo and SQLite, the value comes from the *application* clock at
the wrapper layer (because Mongo has no notion of DDL defaults and
SQLite's `CURRENT_TIMESTAMP` only has second precision). For PG /
MySQL / DuckDB / MSSQL, the value comes from the *database* clock. See
[`now()` — server time vs DB time](#now--server-time-vs-db-time) below
for why this matters.

**Updated-at.** `f.dateTime().default('now').updatedAt()` adds the
field to the wrapper's "bump on every update" list. The bump happens
in JavaScript before the SQL is built (see `src/builder/collection.ts`),
not via dialect-specific `ON UPDATE` triggers, so the behaviour is
identical across every adapter.

```ts
const User = model('users', {
  id:        f.id(),
  email:     f.string(),
  createdAt: f.dateTime().default('now'),
  updatedAt: f.dateTime().default('now').updatedAt(),
});

await db.user.update({ where: { id }, data: { email: 'new@x.co' } });
// updatedAt is silently set to new Date() in the data payload before SQL emit.
```

`updatedAt` is not writable from user code — it's marked read-only on
the `Update` input type. If you bypass the wrapper (`db.$queryRaw`),
the column is whatever you write.

---

## Pattern 2 — calendar event (wall-clock + tz)

The 10% case that breaks every product that ignores it. Calendar
events, business hours, scheduled jobs that should run "at 9am local
time" — anywhere the wall-clock is the source of truth and the
underlying instant depends on the zone.

The wrong way:

```ts
// ❌ This loses the zone. If the user reschedules to a date that crosses
//    a DST boundary, the meeting will land an hour off.
const Meeting = model('meetings', {
  id:      f.id(),
  startAt: f.dateTime(),   // stored as UTC instant
});
```

The right way:

```ts
const Meeting = model('meetings', {
  id:           f.id(),
  // The wall-clock as the user typed it: 'YYYY-MM-DDTHH:MM:SS' (no Z).
  startLocal:   f.string(),
  // IANA timezone name: 'Europe/London', 'America/New_York', 'Africa/Lagos'.
  startTz:      f.string(),
  // Optional: pre-computed instant for fast querying. Recompute on every
  // mutation of startLocal or startTz. Useful for "what's coming up in
  // the next hour?" queries without scanning every row's tz.
  startInstant: f.dateTime().optional(),
});
```

The `startInstant` is a *derived* column. It's the instant the meeting
*currently* corresponds to, given the current zone offset. If the zone
rules change (some jurisdiction abolishes DST, a new historical TZ
rule lands in the IANA db), the instant might shift. The source of
truth is `startLocal` + `startTz`.

To recompute `startInstant` (and to render the wall-clock to viewers
in other zones), reach for a userland library:

```ts
import { DateTime } from 'luxon';

function computeInstant(startLocal: string, startTz: string): Date {
  return DateTime.fromISO(startLocal, { zone: startTz }).toUTC().toJSDate();
}

await db.meeting.create({
  data: {
    startLocal:   '2026-06-24T09:00:00',
    startTz:      'Europe/London',
    startInstant: computeInstant('2026-06-24T09:00:00', 'Europe/London'),
  },
});
```

Same with `date-fns-tz`, `day.js` (with the `timezone` plugin), or the
Temporal API (`ZonedDateTime`) once that lands natively. The library
choice doesn't matter — the *schema shape* (wall-clock and zone stored
separately) is the load-bearing decision.

**Why a string for `startLocal` and not `f.dateTime()`.** A `Date` is
an instant; storing a wall-clock as a `Date` requires picking a
fictional zone to anchor it (usually UTC), and then *every read* has
to remember to re-interpret it as a wall-clock. That re-interpretation
is the bug source. A string of the form `'2026-06-24T09:00:00'` is
self-describing — no parse ever needs to ask "what zone is this in?"
The zone lives in the sibling column.

For the `startInstant` column you *do* want `f.dateTime()` — it's a
real instant, and you want range queries on it.

**Indexing.** Index `startInstant` for "upcoming meetings" queries.
Index `(startTz, startLocal)` if you query "meetings between 9am and
5pm local" across zones — that lets you range-scan within a single zone
without recomputing offsets.

---

## Pattern 3 — plain date (no time at all)

Birthdays, anniversaries, due dates, fiscal-period boundaries. The
date is the answer; asking for a time or a zone is meaningless.

The wrong way:

```ts
// ❌ Storing 1990-04-15 as a UTC Date silently shifts the date for any
//    viewer west of UTC.
//
// new Date('1990-04-15')         → 1990-04-15T00:00:00.000Z
// On a client in California:     → "April 14, 1990" (it's 5pm the previous day)
const User = model('users', {
  id:       f.id(),
  birthday: f.dateTime(),
});
```

Two right ways, depending on whether you need DB-side date arithmetic.

**Right way A — store as a string.** Three characters cheaper, zero
ambiguity, zero risk of TZ shift:

```ts
const User = model('users', {
  id:       f.id(),
  birthday: f.string(),   // 'YYYY-MM-DD' — validate at the API boundary
});
```

Pair with a zod transform at the IO boundary (see
[RUNTIME-VALIDATION.md](./RUNTIME-VALIDATION.md)):

```ts
import { z } from 'zod';

const dateOnly = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD');

const userCreateSchema = z.object({
  birthday: dateOnly,
});
```

Sorts correctly (ISO-8601 dates are lexically ordered), range-queries
correctly (`birthday >= '1990-01-01' AND birthday < '2000-01-01'` works
on every dialect), and renders correctly (the string IS the date —
there's nothing to render). The cost is that DB-side functions like
`date_trunc('month', col)` won't work without a cast.

**Right way B — store as a UTC `Date` at midnight, treat the time
component as garbage.** Use this if you need DB-side date arithmetic
(PG `date_trunc`, MySQL `DATE_FORMAT`) and you're willing to enforce
"the time component is always 00:00:00 UTC" at the write site:

```ts
const Invoice = model('invoices', {
  id:      f.id(),
  // Always midnight UTC; the time component is enforced to zero at writes.
  dueDate: f.dateTime(),
});

function toUtcMidnight(y: number, m: number, d: number): Date {
  // Date.UTC takes month 0-indexed. Returns ms since epoch at UTC midnight.
  return new Date(Date.UTC(y, m - 1, d));
}

await db.invoice.create({
  data: { dueDate: toUtcMidnight(2026, 6, 24) },
});

function renderDueDate(d: Date): string {
  // Always read with getUTC* methods — never let local-tz creep in.
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
```

The risk: anywhere a developer writes `new Date('2026-06-24')` and
forgets to enforce the "UTC midnight" convention, the row drifts.
There's no type-level way to catch this. The string approach is
safer; reach for B only if the DB-side date functions are doing real
work.

---

## Pattern 4 — plain time (time-of-day, no date)

"Store hours: 09:00–17:00." The hours apply every day; there's no
specific date attached.

There is no good `Date` representation for this. Pick one of:

```ts
// ✅ Strings — readable, sorts lexically as long as you pad hours to 2 digits.
const StoreHours = model('store_hours', {
  id:    f.id(),
  open:  f.string(),    // '09:00' or '09:00:00'
  close: f.string(),    // '17:00' or '17:00:00'
});

// ✅ Integer minutes since midnight — cheap, no parsing.
const StoreHoursI = model('store_hours_i', {
  id:    f.id(),
  open:  f.int(),       // 540   = 9 * 60
  close: f.int(),       // 1020 = 17 * 60
});
```

Both validate at the API boundary; both index and range-query
trivially. The integer form is the lighter touch if you do a lot of
"is now within open–close?" comparisons.

Watch out for the close-after-midnight case ("bar open 8pm–2am") —
neither encoding handles wrap-around without a sentinel. Either store
`close > open` always (so 2am encodes as 26:00 / 1560 minutes — and
your reader knows to mod by 24), or add a `closeNextDay: bool`
sibling column.

---

## `now()` — server time vs DB time

`f.dateTime().default('now')` is unambiguous on its surface, but
the actual moment captured depends on which clock writes the value.

| Dialect | `default('now')` source |
|---|---|
| Postgres | DB-side — `now()` runs at the start of the transaction |
| MySQL | DB-side — `CURRENT_TIMESTAMP(3)` runs at insert |
| SQLite | DB-side — `CURRENT_TIMESTAMP` (1-second precision!) |
| DuckDB | DB-side — `now()` at insert |
| MSSQL | DB-side — `SYSDATETIMEOFFSET()` at insert |
| Mongo | App-side — `new Date()` at the wrapper layer |

Two implications:

**SQLite has only 1-second resolution.** `CURRENT_TIMESTAMP` in SQLite
is the SQL-92 standard form: `'YYYY-MM-DD HH:MM:SS'` — no fractional
seconds. If you need millisecond ordering on a SQLite `createdAt`
column, fill the value app-side instead:

```ts
const Audit = model('audit', {
  id:        f.id(),
  ts:        f.dateTime(),
});

await db.audit.create({
  data: {
    ts: new Date(),     // app clock, ms precision
  },
});
```

forge doesn't currently expose a "`default('now')` but ms-precision on
SQLite" knob — the workaround is to drop `default('now')` and fill at
the call site. The [`forge:push`](./MIGRATIONS.md) layer treats the
adapter-supplied default as the source.

**Clock drift between app and DB.** If your app server's wall-clock
differs from the DB's (which it absolutely will, by some tens of
milliseconds at minimum, more if NTP is misconfigured), then rows
created via Mongo and rows created via PG don't share an ordering even
inside the same business minute. Two patterns help:

* **Pick one clock.** If you need a single coherent ordering across
  dialects, fill all timestamps app-side (drop `default('now')`).
* **Use a logical clock.** A monotonic per-row sequence (PG bigserial,
  Mongo timestamps inside ObjectId) gives a strict ordering that
  doesn't depend on wall-clock agreement.

For "when did this happen, roughly?" you don't usually care about NTP
skew. For "what was the exact order of events?", consider a sequence
column instead of (or alongside) a timestamp.

---

## Dates in JSON

`f.json()` columns can't enforce a date type — JSON has no date
primitive. The wire convention is ISO-8601 strings:

```ts
const Event = model('events', {
  id:      f.id(),
  payload: f.json(),
});

await db.event.create({
  data: {
    payload: {
      occurredAt: new Date().toISOString(),   // → '2026-06-24T15:30:00.000Z'
    },
  },
});
```

On read, `payload.occurredAt` comes back as the string you wrote.
If you need a `Date` on the read side, parse at the boundary:

```ts
const row = await db.event.findFirst({ where: { id } });
const occurredAt = new Date(row!.payload.occurredAt);
```

For typed read-side conversion, layer a zod schema over the payload:

```ts
import { z } from 'zod';

const payloadSchema = z.object({
  occurredAt: z.string().datetime().transform((s) => new Date(s)),
});

const payload = payloadSchema.parse(row!.payload);
//    ^ { occurredAt: Date }
```

`z.string().datetime()` (zod 3.20+) enforces ISO-8601 with `Z` (or an
offset) at parse time. The transform converts to `Date` only after the
shape check passes.

JSON path queries against ISO-8601 date strings work cross-dialect with
the `gte` / `lte` operators (see [JSON-PATH.md](./JSON-PATH.md)) —
lexical comparison on ISO-8601 *is* chronological comparison, as long
as you're consistent about the `Z` suffix.

`f.embed(() => Type)` columns get typed `f.dateTime()` slots that
round-trip as JS `Date` correctly, because the wrapper handles the
parse/stringify pair when reading and writing the embed. Prefer `embed`
over raw `json` when the date is part of a known structure.

---

## Range queries

`gte` / `lte` / `gt` / `lt` on `dateTime` columns work everywhere:

```ts
const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);  // 7 days ago

await db.order.findMany({
  where: {
    placedAt: { gte: since },
  },
});
```

For a half-open range (`>= start, < end` — the canonical day-bucket
shape):

```ts
const dayStart = new Date('2026-06-24T00:00:00.000Z');
const dayEnd   = new Date('2026-06-25T00:00:00.000Z');

await db.order.findMany({
  where: {
    placedAt: { gte: dayStart, lt: dayEnd },
  },
});
```

Why exclusive on the upper bound: if you write
`{ gte: dayStart, lte: dayEndOfDay }` where `dayEndOfDay` is
`'2026-06-24T23:59:59.999Z'`, you've created a tiny gap at the
millisecond boundary. Rows with `placedAt` between 23:59:59.9995 and
00:00:00.0005 the next day fall into nobody's bucket. Half-open
intervals (`[start, next-day-start)`) tile the timeline exactly, no
gaps and no overlaps. Use them.

**BETWEEN is inclusive on both ends.** Don't reach for it for day
buckets — it has the same boundary-overlap problem from the other
side: a row at `'2026-06-24T00:00:00.000Z'` is in both
`BETWEEN d23 AND d24` and `BETWEEN d24 AND d25`. Half-open with
`gte` / `lt` is the safe shape.

**Comparing to "now"** — make the boundary explicit, not implicit:

```ts
// ❌ "All future orders" — but `now` is computed once per process, not per query.
const now = new Date();
await db.order.findMany({ where: { placedAt: { gte: now } } });

// ✅ Evaluate at query time
await db.order.findMany({ where: { placedAt: { gte: new Date() } } });
```

Both work, but the second one is unambiguous to a code reviewer about
when "now" is.

---

## DST gotchas

Daylight Saving Time shifts the offset of a wall-clock without
shifting the wall-clock itself. Two flavours of bug:

**Spring forward — wall-clocks that don't exist.** In US/Eastern, on
2026-03-08, the clock jumps from 02:00 to 03:00 EST → EDT. So
`'2026-03-08T02:30:00'` in `America/New_York` is *not a valid local
time*. If your scheduler stores a daily 02:30am job and that day
arrives, you have to decide: skip the run, run at 01:30, run at 03:30?

Luxon's `DateTime.fromISO('2026-03-08T02:30:00', { zone: 'America/New_York' })`
returns `invalid` for this. Most libraries silently shift it (to 03:30
EDT in luxon-fluent-style, depending on the option). Decide your
policy explicitly; don't rely on the library's silent default.

**Fall back — wall-clocks that happen twice.** In US/Eastern, on
2026-11-01, the clock jumps from 02:00 to 01:00 EDT → EST. So
`'2026-11-01T01:30:00'` happens *twice* — once at EDT (UTC−4), once at
EST (UTC−5). Same scheduler question: which one do you run? Both? The
later? The earlier?

If you're storing `startLocal + startTz` per [Pattern 2](#pattern-2--calendar-event-wall-clock--tz),
the source-of-truth is unambiguous (the user typed a wall-clock), but
when you compute `startInstant`, you have to pick. Most libraries pick
the *first* (EDT) by default. Make the choice explicit at the
computation site:

```ts
import { DateTime } from 'luxon';

// 'compatible' = first occurrence on fall-back; throw on spring-forward.
const dt = DateTime.fromISO('2026-11-01T01:30:00', {
  zone: 'America/New_York',
  disambiguation: 'earlier',   // or 'later', or 'compatible'
});
```

Pure UTC instants (Pattern 1) don't have either bug — instants don't
DST-shift, only wall-clocks do.

---

## Indexes on date columns

Date columns index well — they're either fixed-width numerics (most
dialects) or fixed-format strings (SQLite). The defaults from
[INDEXES.md](./INDEXES.md) apply:

```ts
const Order = model('orders', {
  id:       f.id(),
  placedAt: f.dateTime(),
}, {
  indexes: [
    { name: 'orders_placed_at_idx', fields: ['placedAt'] },
  ],
});
```

B-tree indexes work for range scans (`gte`, `lte`, sorted reads). On
Postgres, BRIN is the alternative for very large time-series tables
where the column is correlated with insertion order — the index is
*tiny* (kilobytes for billion-row tables) but only useful for wide
range scans:

```ts
const Audit = model('audit', {
  id:    f.id(),
  ts:    f.dateTime().default('now'),
  event: f.string(),
}, {
  indexes: [
    {
      name: 'audit_ts_brin',
      fields: ['ts'],
      method: 'brin',                // PG-only — gracefully falls back on other dialects
    },
  ],
});
```

The `method` knob is defined in [INDEXES.md](./INDEXES.md#method) —
forge passes it through to PG and ignores it on dialects that don't
support BRIN. For non-time-series workloads (random reads, point
lookups by date), B-tree wins; BRIN only pays for itself when reads
scan thousands of rows by date.

Composite indexes on `(date_col, other_col)` are the standard fix for
"give me the recent activity for user X" type queries:

```ts
indexes: [
  { name: 'orders_user_placed', fields: ['customerId', 'placedAt'] },
]
```

The order matters: equality on `customerId` first, then range on
`placedAt`. PG / MySQL / SQLite all walk a composite B-tree in order.

---

## Date arithmetic — intervals, date_trunc, age

forge doesn't ship a typed date-arithmetic layer — these are DB-side
operations, dialect-specific. The escape hatch is
[`db.$queryRaw`](./RAW-SQL.md):

```ts
// Postgres / DuckDB — interval arithmetic + truncation
const buckets = await db.$queryRaw<{ bucket: Date; n: number }[]>`
  SELECT date_trunc('day', placed_at AT TIME ZONE 'UTC') AS bucket,
         COUNT(*)::int AS n
    FROM orders
   WHERE placed_at >= now() - interval '7 days'
   GROUP BY bucket
   ORDER BY bucket
`;
```

`AT TIME ZONE 'UTC'` makes the truncation explicit — without it, the
truncation runs in the session's tz, which depends on the connection.

Per-dialect cheat sheet for the three common operations:

| Operation | Postgres / DuckDB | MySQL | SQLite | MSSQL | Mongo |
|---|---|---|---|---|---|
| Subtract days | `now() - interval '30 days'` | `DATE_SUB(NOW(), INTERVAL 30 DAY)` | `datetime('now', '-30 days')` | `DATEADD(day, -30, SYSDATETIMEOFFSET())` | `$dateSubtract` |
| Truncate to day | `date_trunc('day', col)` | `DATE_FORMAT(col, '%Y-%m-%d')` | `strftime('%Y-%m-%d', col)` | `FORMAT(col, 'yyyy-MM-dd')` | `$dateTrunc` |
| Days between | `EXTRACT(DAY FROM (a - b))` | `TIMESTAMPDIFF(DAY, b, a)` | `julianday(a) - julianday(b)` | `DATEDIFF(day, b, a)` | `$dateDiff` |

The shape that survives all six is "JS-side computation of the cutoff,
DB-side range query":

```ts
// Cross-dialect — no DB-side date arithmetic
const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
const recent = await db.order.findMany({ where: { placedAt: { gte: cutoff } } });
```

Reach for `$queryRaw` only when you need a grouping or aggregation that
JS-side computation can't do efficiently (millions of rows, want
DB-side `GROUP BY date_trunc`).

---

## Temporal API (TC39) and userland libraries

JavaScript's date story is improving. The TC39 Temporal proposal —
stage 3 at the time of writing — adds:

* `Temporal.Instant` — a UTC instant with nanosecond precision. Like
  `Date` but with explicit "this is an instant, not a wall-clock"
  semantics.
* `Temporal.ZonedDateTime` — wall-clock + zone, the right primitive for
  [Pattern 2](#pattern-2--calendar-event-wall-clock--tz).
* `Temporal.PlainDate` — a date with no time and no zone, the right
  primitive for [Pattern 3](#pattern-3--plain-date-no-time-at-all).
* `Temporal.PlainTime` — a time-of-day with no date and no zone,
  [Pattern 4](#pattern-4--plain-time-time-of-day-no-date).
* `Temporal.Duration` — an explicit interval (4 days 3 hours), the
  right primitive for date arithmetic.

Browser / Node support is partial; the polyfill is `@js-temporal/polyfill`.
forge does *not* currently take `Temporal.Instant` on the input side —
`f.dateTime()` accepts `Date` or ISO string only. The bridge at the
boundary:

```ts
import { Temporal } from '@js-temporal/polyfill';

const instant = Temporal.Now.instant();
const asDate = new Date(instant.epochMilliseconds);   // ms-precise round-trip

await db.event.create({ data: { ts: asDate } });

const row = await db.event.findFirst({ where: { id } });
const back = Temporal.Instant.fromEpochMilliseconds(row!.ts.getTime());
```

The sub-millisecond precision is lost in the bridge — JS `Date` is
ms-precise. When `Temporal` lands natively and forge takes it as a
first-class field type, the sub-ms gap closes. Until then, treat
`Temporal` as a *view* layer over the same `Date` that lives on `Row`.

**Userland libraries today:** **Luxon** (~70KB, immutable, the
reference for tz-aware math); **day.js** (~7KB, Moment-API style,
`timezone` plugin for zones); **date-fns / date-fns-tz** (function-style,
tree-shakeable); **Moment** (legacy, mutable, large — don't reach for
in new code). forge bundles none of them; the schema surface is `Date`
and ISO strings, and the library choice is yours.

---

## Worked examples

### (a) Order timestamp — UTC-stored, rendered per viewer

```ts
const Order = model('orders', {
  id:         f.id(),
  customerId: f.objectId(),
  placedAt:   f.dateTime().default('now'),
  shippedAt:  f.dateTime().optional(),
}, {
  indexes: [
    { name: 'orders_placed_at_idx', fields: ['placedAt'] },
  ],
});

// Write — defaults populated by the DB / wrapper
await db.order.create({ data: { customerId } });

// Read for an API response — ISO-8601 on the wire
const order = await db.order.findUnique({ where: { id } });
return {
  id: order!.id,
  placedAt: order!.placedAt.toISOString(),         // '2026-06-24T15:30:00.000Z'
  shippedAt: order!.shippedAt?.toISOString() ?? null,
};

// Render — at the view, with the viewer's zone
function renderOrder(o: { placedAt: string }, viewer: { tz: string }) {
  return new Intl.DateTimeFormat('en-GB', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: viewer.tz,
  }).format(new Date(o.placedAt));
}
```

### (b) Calendar event — local time + tz separately

```ts
import { DateTime } from 'luxon';

const Meeting = model('meetings', {
  id:           f.id(),
  ownerId:      f.objectId(),
  title:        f.string(),
  startLocal:   f.string(),
  startTz:      f.string(),
  startInstant: f.dateTime().optional(),
  durationMin:  f.int(),
}, {
  indexes: [
    { name: 'meetings_start_instant', fields: ['startInstant'] },
    { name: 'meetings_owner_start', fields: ['ownerId', 'startInstant'] },
  ],
});

function instantOf(local: string, tz: string): Date {
  const dt = DateTime.fromISO(local, { zone: tz });
  if (!dt.isValid) throw new Error(`invalid local time: ${local} ${tz} (${dt.invalidReason})`);
  return dt.toUTC().toJSDate();
}

await db.meeting.create({
  data: {
    ownerId,
    title: 'Q3 review',
    startLocal: '2026-09-14T14:00:00',
    startTz: 'Europe/London',
    startInstant: instantOf('2026-09-14T14:00:00', 'Europe/London'),
    durationMin: 60,
  },
});

// "Coming up in the next 24h for this user" — range on the instant
const horizon = new Date(Date.now() + 24 * 60 * 60 * 1000);
const upcoming = await db.meeting.findMany({
  where: {
    ownerId,
    startInstant: { gte: new Date(), lt: horizon },
  },
  orderBy: { startInstant: 'asc' },
});

// Render in the meeting's own zone (the source of truth)
const display = upcoming.map((m) => ({
  title: m.title,
  when: DateTime.fromISO(m.startLocal, { zone: m.startTz })
    .toFormat("ccc d LLL yyyy, HH:mm 'ZZZZ'"),  // Sat 14 Sep 2026, 14:00 BST
}));
```

### (c) Date range query — day bucket without overlap

```ts
function dayBoundsUtc(y: number, m: number, d: number) {
  const start = new Date(Date.UTC(y, m - 1, d));
  const end   = new Date(Date.UTC(y, m - 1, d + 1));   // next-day midnight UTC
  return { start, end };
}

const { start, end } = dayBoundsUtc(2026, 6, 24);

const ordersToday = await db.order.findMany({
  where: {
    placedAt: { gte: start, lt: end },        // [start, end) — no overlap, no gap
  },
});

// Variant — day bucket in a non-UTC zone. Build the boundaries with the
// zone-aware library, then convert to UTC instants for the query.
import { DateTime } from 'luxon';

function dayBoundsInZone(y: number, m: number, d: number, zone: string) {
  const start = DateTime.fromObject({ year: y, month: m, day: d }, { zone }).toUTC().toJSDate();
  const end   = DateTime.fromObject({ year: y, month: m, day: d + 1 }, { zone }).toUTC().toJSDate();
  return { start, end };
}

const { start: s, end: e } = dayBoundsInZone(2026, 6, 24, 'Africa/Lagos');
await db.order.findMany({ where: { placedAt: { gte: s, lt: e } } });
```

### (d) Per-tenant business-day calendar

Each tenant defines its own working days and public holidays. "Next
business day from X" is a per-tenant lookup.

```ts
const Tenant = model('tenants', {
  id:           f.id(),
  name:         f.string(),
  defaultTz:    f.string(),              // 'Africa/Lagos', 'Europe/London', …
  workingDays:  f.intArray(),            // [1, 2, 3, 4, 5] = Mon–Fri
});

const Holiday = model('holidays', {
  id:       f.id(),
  tenantId: f.objectId(),
  date:     f.string(),                  // 'YYYY-MM-DD' — plain date pattern
  name:     f.string(),
}, {
  uniques: [['tenantId', 'date']],
  indexes: [{ name: 'holidays_tenant_date', fields: ['tenantId', 'date'] }],
});

import { DateTime } from 'luxon';

async function nextBusinessDay(tenantId: string, from: Date) {
  const tenant = await db.tenant.findUnique({ where: { id: tenantId } });
  if (!tenant) throw new Error('unknown tenant');
  const wd = new Set(tenant.workingDays);

  let cursor = DateTime.fromJSDate(from, { zone: tenant.defaultTz }).startOf('day');
  for (let i = 0; i < 30; i++) {
    cursor = cursor.plus({ days: 1 });
    if (!wd.has(cursor.weekday)) continue;       // 1 = Mon, 7 = Sun
    const dateStr = cursor.toFormat('yyyy-MM-dd');
    const hit = await db.holiday.findFirst({ where: { tenantId, date: dateStr } });
    if (hit) continue;
    return { date: dateStr, instant: cursor.toUTC().toJSDate() };
  }
  throw new Error('no business day in next 30');
}
```

`date` is a string (Pattern 3 — calendar date, no tz), `instant` is a
`Date` (Pattern 1 — the moment that date starts in the tenant's zone).
Each column carries the type that matches its meaning.

---

## Common bugs

A short list of the date bugs that recur often enough to call out
explicitly. Each one collapses if you keep [the three problems](#the-three-date-problems)
in mind and pick the matching pattern.

* **"Birthday shifted by one day for users in California."** Storing a
  birthday as `f.dateTime()` and writing `new Date('1990-04-15')`. The
  parse interprets the bare date as UTC midnight; a viewer west of UTC
  reads it as the previous day. Fix: [Pattern 3](#pattern-3--plain-date-no-time-at-all)
  (store as string).
* **"The meeting moved an hour when DST changed."** Storing the meeting
  as a UTC instant computed once at create time. The instant stays
  fixed; the wall-clock shifts. Fix:
  [Pattern 2](#pattern-2--calendar-event-wall-clock--tz) (store local + tz,
  recompute instant on demand).
* **"Two records have the same `createdAt` but I need a strict order."**
  SQLite `CURRENT_TIMESTAMP` is 1-second precision. Multi-row writes
  inside one tick all share a timestamp. Fix: fill app-side with
  `new Date()` (ms precision) and/or add a monotonic sequence column.
* **"`BETWEEN` is double-counting rows at midnight."** `BETWEEN` is
  inclusive on both ends, so two adjacent day buckets both include the
  boundary instant. Fix: half-open `gte: dayStart, lt: nextDayStart`.
* **"`new Date(isoString)` returned `Invalid Date`."** The ISO string is
  missing the `T` separator, or has a stray space, or uses
  `YYYY/MM/DD`. Fix: validate with `z.string().datetime()` at the API
  boundary; only then construct the `Date`.
* **"Day-bucket aggregation is one hour off after 30 March."** Running
  `date_trunc('day', col)` on a column without `AT TIME ZONE`. The
  truncation runs in the session's zone, which is BST in late March.
  Fix: `date_trunc('day', col AT TIME ZONE 'UTC')` — or do the bucket
  computation app-side.
* **"`getDay()` returned the wrong weekday."** Local-zone reads on a
  `Date` whose UTC value is near midnight. Mondays in London become
  Sundays in Lagos when the timestamp lands between 23:00 and 24:00 UTC
  on a Sunday. Fix: use `getUTCDay()` if you stored a UTC instant; use
  the zoned wall-clock if you stored Pattern 2.
* **"`updatedAt` didn't change on this update."** A direct
  `db.$queryRaw` `UPDATE` bypasses the wrapper, which is where the
  `updatedAt` bump lives. Fix: use `db.<model>.update(...)`, or set
  `updatedAt = NOW()` explicitly in the raw SQL.

---

## Where to go next

* **[MODEL.md — Boolean and dateTime](./MODEL.md#boolean-and-datetime)** —
  the `f.dateTime()` builder in context with every other field type.
* **[TYPES.md — Row<typeof Model>](./TYPES.md#rowtypeof-model)** — what
  `Row` resolves to for a `Date` column, plus how `Create` and `Update`
  differ.
* **[RUNTIME-VALIDATION.md](./RUNTIME-VALIDATION.md)** — zod transforms
  that turn ISO strings into `Date` at API boundaries.
* **[JSON-PATH.md](./JSON-PATH.md)** — querying ISO-8601 date strings
  inside JSON columns.
* **[POSTGRES.md](./POSTGRES.md)**, **[MYSQL.md](./MYSQL.md)**,
  **[SQLITE.md](./SQLITE.md)**, **[DUCKDB.md](./DUCKDB.md)**,
  **[MSSQL.md](./MSSQL.md)**, **[MONGO.md](./MONGO.md)** —
  per-dialect timestamp behaviour.
* **[INDEXES.md](./INDEXES.md)** — BRIN, B-tree, composite indexes on
  date columns.
* **[RAW-SQL.md](./RAW-SQL.md)** — the escape hatch for dialect-specific
  date arithmetic.
