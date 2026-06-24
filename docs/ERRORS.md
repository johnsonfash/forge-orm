# Errors

The error taxonomy forge-orm throws, per-dialect error-code mapping, retry classes, catch idioms, and patterns for wiring errors into Sentry / Bugsnag / your HTTP layer.

The [Errors](../README.md#errors) section in the README is the two-paragraph
summary: every dialect's constraint and connection failures come back as a
`DbKnownError` with a stable `code`, so application code can branch on the
cause without caring which database is on the other end. This doc is the full
reference for everything sitting behind that summary — every error class forge
exports, the SQLSTATE / errno / message-pattern → P-code mapping table per
dialect, which codes are safe to retry, the backoff pattern, the catch idioms
that don't accidentally swallow programmer errors, the `error` event and how
to wire it into Sentry / Bugsnag / Rollbar without leaking PII, and the
worked patterns that show up most often in production code.

Everything below assumes 2.5.x. The relevant implementation files are:

* `src/adapters/mongo/errors.ts` — `DbKnownError` itself, the `notFoundError`
  helper, and the Mongo `rethrowMongoError` mapper.
* `src/adapters/postgres/errors.ts` — Postgres SQLSTATE → P-code map.
* `src/adapters/mysql/errors.ts` — MySQL `errno` → P-code map.
* `src/adapters/sqlite/errors.ts` — SQLite string-code → P-code map.
* `src/adapters/duckdb/errors.ts` — DuckDB `errorType` + message-pattern map.
* `src/adapters/mssql/errors.ts` — MSSQL `number` → P-code map.
* `src/adapters/missing-driver.ts` — `ForgeMissingDriverError`, thrown when a
  driver package isn't installed for the dialect the URL implies.

## Contents

* [The taxonomy](#the-taxonomy)
* [The `DbKnownError` shape](#the-dbknownerror-shape)
* [Per-dialect P-code map](#per-dialect-p-code-map)
* [Catch idioms](#catch-idioms)
* [Retry classes — transient vs permanent](#retry-classes--transient-vs-permanent)
* [Exponential backoff with jitter](#exponential-backoff-with-jitter)
* [`$transaction` + retry](#transaction--retry)
* [Idempotency-Key interaction](#idempotency-key-interaction)
* [The `error` event](#the-error-event)
* [Wrapping and re-throwing](#wrapping-and-re-throwing)
* [`ForgeMissingDriverError`](#forgemissingdrivererror)
* [CLI exit codes](#cli-exit-codes)
* [Sentry, Bugsnag, Rollbar](#sentry-bugsnag-rollbar)
* [Browser / sqlite-wasm errors](#browser--sqlite-wasm-errors)
* [Worked examples](#worked-examples)
* [Cross-references](#cross-references)

---

## The taxonomy

forge-orm exposes exactly three exported error types. Everything else that
crosses the public API is either a plain `Error` (programmer mistakes — wrong
adapter, raw command on a SQL adapter, etc.) or the underlying driver error
passed through unchanged.

| Class                       | Source                                    | Exported from   | When it fires |
|-----------------------------|-------------------------------------------|-----------------|----------------|
| `DbKnownError`              | `src/adapters/mongo/errors.ts`            | `forge-orm`     | Every dialect-mapped DB failure (constraint, deadlock, not-found, connection). |
| `ForgeMissingDriverError`   | `src/adapters/missing-driver.ts`          | `forge-orm`     | An adapter is asked to connect but its underlying `npm` driver isn't installed. |
| Plain `Error`               | various                                   | n/a             | Misuse of the API at the call site — `$runCommandRaw` on Postgres, `scheduleRefresh` with a bad duration, `tx` API called on a closed connection. |

Everything else — `SqliteError`, `pg`'s `DatabaseError`, `mysql2`'s
`QueryError`, `MongoServerError`, `MssqlError`, DuckDB's `DuckDBError` — is
wrapped into a `DbKnownError` *only* when the underlying error has a code
forge has a mapping for. If the code is unrecognised, forge re-throws it
untouched. That keeps the surface narrow: catch `DbKnownError` for the cases
you've planned for, let the long tail bubble.

There is no `forge.ValidationError`. forge does not validate inputs at the
type level beyond what TypeScript gives you. The "validation" here is the
database telling you a `NOT NULL` column got a null, or a `CHECK` constraint
failed — and those come back as `DbKnownError` with `code: 'P2011'` or
`code: 'P2004'` respectively, mapped from whatever SQLSTATE the dialect
emitted.

There is no separate `ConnectionError` class, either. Connection failures
come back as `DbKnownError` with `code: 'P1001'`. The discriminant is the
code, not the class.

---

## The `DbKnownError` shape

The whole class is twenty lines (`src/adapters/mongo/errors.ts`):

```ts
export class DbKnownError extends Error {
  code: string;
  meta?: Record<string, any>;
  constructor(code: string, message: string, meta?: Record<string, any>) {
    super(message);
    this.name = 'DbKnownError';
    this.code = code;
    this.meta = meta;
  }
}
```

Three fields you can rely on.

* **`error.code`** — a stable string. The codes follow Prisma's familiar set
  (`P2002` unique, `P2003` foreign key, `P2004` check, `P2011` not-null,
  `P2034` retryable, …) so existing `try { … } catch (e) { if (e.code === 'P2002') … }`
  blocks keep working across adapters. The full table is in
  [Per-dialect P-code map](#per-dialect-p-code-map). The codes are the
  contract — branch on `code`, never on `message`.
* **`error.message`** — the human description. Always includes the underlying
  constraint name or column when the driver surfaced it. Use it for logging,
  not for branching.
* **`error.meta`** — a dialect-specific bag of extra context. Most callers
  ignore it; the routes that *do* care about specifics — "which constraint
  failed" — read it. The fields are:

| `meta` key      | Set by                  | What it carries                                                       |
|-----------------|-------------------------|-----------------------------------------------------------------------|
| `modelName`     | Mongo, PG (when known)  | The model / table the failure was against.                            |
| `target`        | Mongo, PG               | `string[]` — the constraint / index name that fired, when known.      |
| `field_name`    | PG                      | The column name when PG reports it on the original error.             |
| `detail`        | PG, MySQL, SQLite, DuckDB, MSSQL | The driver's raw `detail` / `sqlMessage` / `message`.        |
| `sqlstate`      | PG                      | The original SQLSTATE.                                                |
| `errno`         | MySQL                   | The numeric `errno`.                                                  |
| `sqlState`      | MySQL                   | The SQL state string from `mysql2`.                                   |
| `sqliteCode`    | SQLite                  | The original `SQLITE_*` string code (with the `_<sub>` suffix kept). |
| `number`        | MSSQL                   | The original `mssql` numeric `number`.                                |
| `cause`         | `notFoundError`         | The `where` clause that produced the `P2025`.                         |

There is no `error.cause` populated by forge. The underlying driver error is
*not* hung off `.cause` — the adapter maps the relevant fields into `meta`
and discards the original. If you need the raw driver error, the `error`
event ([below](#the-error-event)) sees the unwrapped version before the
adapter wraps it. That's deliberate: it keeps log output tight (no nested
stack-of-an-error-that-was-already-translated) at the cost of one extra hop
when you really do need the original.

`error.name` is always `'DbKnownError'`. `instanceof DbKnownError` works
correctly even across module boundaries because the class is exported from
the root `forge-orm` entry point — there's exactly one constructor.

---

## Per-dialect P-code map

The forge codes are the discriminant. The dialect's native code is
informational (it shows up in `meta`). The mapping is one-way:
driver code → `DbKnownError.code`.

### Unique-constraint family — `P2002`

| Dialect    | Native code                                      | Source         |
|------------|--------------------------------------------------|----------------|
| Postgres   | SQLSTATE `23505` (`unique_violation`)            | `errors.ts:29` |
| MySQL      | `errno` 1062 (`ER_DUP_ENTRY`)                    | `errors.ts:18` |
| SQLite     | `SQLITE_CONSTRAINT_UNIQUE`, `SQLITE_CONSTRAINT_PRIMARYKEY` | `errors.ts:14` |
| DuckDB     | `errorType: 'Constraint'` + message `/duplicate key|UNIQUE constraint|Primary key conflict/i` | `errors.ts:27` |
| MSSQL      | `number` 2627 or 2601                            | `errors.ts:17` |
| Mongo      | server code 11000 (string `'11000'`)             | `errors.ts:25` |

### Foreign-key family — `P2003`

| Dialect    | Native code                                      |
|------------|--------------------------------------------------|
| Postgres   | SQLSTATE `23503` (`foreign_key_violation`)       |
| MySQL      | `errno` 1452 (`ER_NO_REFERENCED_ROW_2`), 1451 (`ER_ROW_IS_REFERENCED_2`) |
| SQLite     | `SQLITE_CONSTRAINT_FOREIGNKEY`                   |
| DuckDB     | message `/foreign key/i`                         |
| MSSQL      | `number` 547                                     |
| Mongo      | n/a — Mongo has no FK constraints                |

### Check-constraint family — `P2004`

| Dialect    | Native code                                      |
|------------|--------------------------------------------------|
| Postgres   | SQLSTATE `23514` (`check_violation`)             |
| MySQL      | `errno` 3819 (`ER_CHECK_CONSTRAINT_VIOLATED`)    |
| SQLite     | `SQLITE_CONSTRAINT_CHECK`, `SQLITE_CONSTRAINT_TRIGGER` |
| DuckDB     | message `/CHECK constraint/i`                    |
| MSSQL      | (historical: 547 — no separate code)             |

### Not-null family — `P2011`

| Dialect    | Native code                                      |
|------------|--------------------------------------------------|
| Postgres   | SQLSTATE `23502` (`not_null_violation`)          |
| MySQL      | `errno` 1048 (`ER_BAD_NULL_ERROR`)               |
| SQLite     | `SQLITE_CONSTRAINT_NOTNULL`                      |
| DuckDB     | message `/NOT NULL/i`                            |
| MSSQL      | `number` 515                                     |

### Not-found — `P2025`

Fired by the `*OrThrow` methods (`findFirstOrThrow`, `findUniqueOrThrow`,
`updateOrThrow`, `deleteOrThrow`) and by `delete` / `update` when the `where`
matches zero rows. Not a database-level code — synthesised by the wrapper in
`src/adapters/mongo/errors.ts:35` and `src/builder/collection.ts`.

```ts
// notFoundError(model, where)
new DbKnownError('P2025', `No ${model} found matching the given criteria`, {
  modelName: model,
  cause: where,
});
```

### Schema / catalog — `P2021`, `P2022`

* `P2021` — table / collection does not exist.
* `P2022` — column / field does not exist.

| Dialect    | Native code (table)               | Native code (column)              |
|------------|------------------------------------|------------------------------------|
| Postgres   | SQLSTATE `42P01`                   | SQLSTATE `42703` (also `42P02`)    |
| MySQL      | `errno` 1146 (`ER_NO_SUCH_TABLE`)  | `errno` 1054 (`ER_BAD_FIELD_ERROR`)|
| SQLite     | `SQLITE_ERROR` (text match)        | `SQLITE_ERROR` (text match)        |
| DuckDB     | `errorType: 'Catalog'` + msg        | `errorType: 'Catalog'` + msg        |
| MSSQL      | `number` 208                       | `number` 207                       |

These almost always mean a schema drift you haven't pushed — run
`forge diff` (see [docs/DIFF.md](DIFF.md)) and `forge push` (see
[docs/PUSH.md](PUSH.md)).

### Retryable family — `P2034`

| Dialect    | Native code                                      | Cause                 |
|------------|--------------------------------------------------|-----------------------|
| Postgres   | SQLSTATE `40001`                                 | Serialization failure |
| Postgres   | SQLSTATE `40P01`                                 | Deadlock              |
| MySQL      | `errno` 1213 (`ER_LOCK_DEADLOCK`)                | Deadlock              |
| MySQL      | `errno` 1205 (`ER_LOCK_WAIT_TIMEOUT`)            | Lock wait timeout     |
| SQLite     | `SQLITE_BUSY`                                    | Database busy         |
| SQLite     | `SQLITE_LOCKED`                                  | Database locked       |
| MSSQL      | `number` 1205                                    | Deadlock victim       |

`P2034` is the universal "retry the whole transaction" signal — see
[Retry classes](#retry-classes--transient-vs-permanent) and
[`$transaction` + retry](#transaction--retry).

### Query cancelled — `P2024`

| Dialect    | Native code                                      |
|------------|--------------------------------------------------|
| Postgres   | SQLSTATE `57014`                                 |
| MySQL      | `errno` 1317                                     |

Usually a statement-timeout server-side, or your application timing out the
query and `pg_cancel_backend`-ing it. Not retryable on its own — the
underlying query took too long for a reason.

### Conversion — `P2007`

DuckDB-only at present. Fires on `errorType: 'Conversion'` — a type cast
failed, e.g. inserting `'abc'` into an `INTEGER` column. The same situation
on Postgres / MySQL raises an SQLSTATE in the `22xxx` family that forge does
not currently map (the underlying error passes through).

### Generic SQL error — `P2010`

SQLite-only fallback for `SQLITE_ERROR` that doesn't match a more specific
mapping (typically a parse error). On other dialects, parse errors pass
through unwrapped.

### Connection — `P1001`

| Dialect    | Native code                                      |
|------------|--------------------------------------------------|
| Postgres   | SQLSTATE `08000`, `08006`                        |
| MySQL      | `errno` 2002 (refused), 2003 (no host), 2006 (server gone away) |
| SQLite     | `SQLITE_IOERR`, `SQLITE_CANTOPEN`                |

### Auth — `P1010`

| Dialect    | Native code                                      |
|------------|--------------------------------------------------|
| Postgres   | SQLSTATE `28P01`, `28000`                        |
| MySQL      | `errno` 1045 (`ER_ACCESS_DENIED_ERROR`)          |
| MSSQL      | `number` 18456                                   |

---

## Catch idioms

The three idioms, in order of preference.

**`instanceof DbKnownError` + `code` switch.** The full pattern, for routes
that need to branch:

```ts
import { DbKnownError } from 'forge-orm';

try {
  await db.user.create({ data: { email, name } });
} catch (e) {
  if (e instanceof DbKnownError) {
    switch (e.code) {
      case 'P2002':  return res.status(409).json({ error: 'email_taken' });
      case 'P2003':  return res.status(400).json({ error: 'bad_reference' });
      case 'P2034':  return res.status(503).json({ error: 'retry' });
      case 'P1001':  return res.status(503).json({ error: 'db_unreachable' });
      default:       throw e;   // unknown forge code — let the global handler log it
    }
  }
  throw e;
}
```

The `instanceof` guard is what TypeScript needs to narrow to `DbKnownError`
(and so the `e.code` access type-checks against the literal codes). Skip the
guard and `e.code` is `unknown` — type-correct but you're branching on a
maybe-undefined.

**`code`-only check, no `instanceof`.** When you're sure a `DbKnownError` is
the only shape you'd ever see at this site:

```ts
try {
  await db.user.create({ data: { email, name } });
} catch (e: any) {
  if (e?.code === 'P2002') return res.status(409).end();
  throw e;
}
```

Faster to type, type-unsafe at the catch site. Fine for ad-hoc scripts;
discouraged in long-lived application code because a regression elsewhere
can have you swallowing a non-forge error that happens to expose a `.code`
property (Node fs errors, for example, have `code: 'ENOENT'`).

**Narrowing on `instanceof` alone.** When the code-discriminant doesn't
matter — you want the same handling for every dialect-level DB failure:

```ts
try {
  await db.user.create({ data: { email, name } });
} catch (e) {
  if (e instanceof DbKnownError) {
    return res.status(400).json({ error: 'db', message: e.message });
  }
  throw e;
}
```

This is the right pattern for "wrap any forge error as a 4xx/5xx, log it,
move on" — typically inside an HTTP middleware that runs after the route
handlers.

A note on `default: throw e`. **Never silently catch and discard an unknown
`DbKnownError.code`.** A forge minor release can add a new code (e.g. a new
retryable family in a future version). A route that branches on `P2002` and
silently 500s on everything else means a new code falls through invisibly.
Always re-throw codes you don't handle so they hit the global handler with a
full stack and log line.

---

## Retry classes — transient vs permanent

Every code maps to one of three classes.

| Class       | Codes                                       | Action                      |
|-------------|---------------------------------------------|-----------------------------|
| Transient   | `P2034`, `P1001` (sometimes), `P2024` (sometimes) | Retry the whole operation. |
| Permanent   | `P2002`, `P2003`, `P2004`, `P2011`, `P2025` | Don't retry. Surface to the caller. |
| Programmer  | `P2007`, `P2010`, `P2021`, `P2022`          | Don't retry. Fix the code or push the schema. |

**Transient — retry.** `P2034` (deadlock / serialization failure / SQLite
busy) is the canonical case. The DB asked you to retry because two
transactions conflicted; one of them lost. The next attempt won't see the
same conflict. The pattern is in
[`$transaction` + retry](#transaction--retry).

`P1001` (connection lost) is more nuanced. If the connection died mid-query,
the driver can't tell you whether the statement was applied — a `COMMIT` on
the way back when the network drops is the classic case. Retrying a SELECT
is safe; retrying an INSERT can produce duplicates. Pair retry with an
idempotency key — see [Idempotency-Key
interaction](#idempotency-key-interaction).

`P2024` (cancelled) is sometimes transient — a one-off timeout on an
overloaded shard. But it's also the signal that the query is too slow for
the configured statement-timeout, which retrying won't fix. Default: don't
retry. Pick the explicit retry on a per-route basis when the upstream
timeout is the bottleneck.

**Permanent — don't retry.** A unique violation will happen again on the
next attempt with the same input. A foreign-key violation means the parent
row doesn't exist. A check-constraint failure means the input doesn't
satisfy the constraint. Retrying these is just wasting another round-trip.
Surface them to the caller (HTTP 409 / 400 / 422 as appropriate).

The one exception is `P2002` *as a race condition* — two requests trying to
create the same row, one wins, the other loses. The right answer is usually
`upsert` (which forge implements atomically — see
[docs/MUTATIONS.md#upsert](MUTATIONS.md#upsert)), not retry. See
[Worked example: unique-violation as upsert race](#b-unique-violation-as-upsert-race).

**Programmer — don't retry.** `P2021` (table not found) and `P2022` (column
not found) mean the schema in the DB doesn't match the schema your app was
compiled against. Retrying isn't going to make the table appear. Run
`forge diff` (see [docs/DIFF.md](DIFF.md)) and push the schema. `P2007`
(conversion) and `P2010` (SQL error) usually mean a malformed input the
type system didn't catch — fix at the call site.

A compact classifier:

```ts
import { DbKnownError } from 'forge-orm';

export function isRetryable(err: unknown): boolean {
  return err instanceof DbKnownError && err.code === 'P2034';
}

export function isProgrammerError(err: unknown): boolean {
  return err instanceof DbKnownError
    && (err.code === 'P2021' || err.code === 'P2022' || err.code === 'P2010');
}
```

`isRetryable` is intentionally narrow. Broadening it (to include `P1001` or
`P2024`) is a decision per call site — the pattern in
[`$transaction` + retry](#transaction--retry) takes an optional predicate so
you can pass a wider one when you know the operation is idempotent.

---

## Exponential backoff with jitter

The retry shape every forge user converges on:

```ts
import { DbKnownError } from 'forge-orm';

export async function withBackoff<T>(
  op: () => Promise<T>,
  opts: {
    attempts?: number;
    baseMs?: number;
    isRetryable?: (err: unknown) => boolean;
  } = {},
): Promise<T> {
  const { attempts = 5, baseMs = 25, isRetryable = defaultRetryable } = opts;
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await op();
    } catch (err) {
      lastErr = err;
      if (!isRetryable(err) || i === attempts - 1) throw err;

      // Exponential — 25, 50, 100, 200, 400ms — with up to 50% jitter on top.
      const ceil = baseMs * 2 ** i;
      const jitter = Math.floor(Math.random() * ceil * 0.5);
      await new Promise(r => setTimeout(r, ceil + jitter));
    }
  }
  throw lastErr;
}

function defaultRetryable(err: unknown): boolean {
  return err instanceof DbKnownError && err.code === 'P2034';
}
```

Three rules baked in.

**Bound the attempts.** Five is a reasonable default; ten is a code smell.
If you're seeing more than three retries on a hot path, the right answer is
usually to redesign the contention (queue, partition, denormalise) — not to
retry harder. See [docs/TRANSACTIONS.md#deadlock-and-serialization-failure-retry](TRANSACTIONS.md#deadlock-and-serialization-failure-retry).

**Back off with jitter.** Linear backoff causes thundering herds.
Exponential without jitter still herds on the long retries. The 0–50%
random additive on top breaks the synchronisation.

**Re-throw on the last attempt.** The `i === attempts - 1` guard avoids the
"retry, then sleep, then return `lastErr` from the loop" double-delay
pattern. If we've burned our budget, throw immediately.

For `P1001` (connection lost), pair backoff with an idempotency check
([Idempotency-Key interaction](#idempotency-key-interaction)) — otherwise
the retry can double-write.

---

## `$transaction` + retry

Transient errors inside a `$transaction` callback have one rule: **re-enter
`db.$transaction`, don't reuse the `tx`**. The session is already
ROLLBACK'd and released; the proxy is dead.

```ts
import { DbKnownError } from 'forge-orm';

export async function withTxRetry<T>(
  body: (tx: any) => Promise<T>,
  opts: { attempts?: number; baseMs?: number } = {},
): Promise<T> {
  const { attempts = 5, baseMs = 25 } = opts;
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await db.$transaction(body);
    } catch (err) {
      lastErr = err;
      const retryable = err instanceof DbKnownError && err.code === 'P2034';
      if (!retryable) throw err;
      const ceil = baseMs * 2 ** i;
      const jitter = Math.floor(Math.random() * ceil * 0.5);
      await new Promise(r => setTimeout(r, ceil + jitter));
    }
  }
  throw lastErr;
}

await withTxRetry(async (tx) => {
  const acct = await tx.account.findFirst({ where: { id: acctId } });
  if (!acct || acct.balance < amount) throw new Error('insufficient');
  await tx.account.update({
    where: { id: acctId },
    data: { balance: { decrement: amount } },
  });
  await tx.ledger.create({ data: { acct: acctId, amount: -amount } });
});
```

This is the same pattern that lives in
[docs/TRANSACTIONS.md#deadlock-and-serialization-failure-retry](TRANSACTIONS.md#deadlock-and-serialization-failure-retry)
— here we make it the canonical retry harness for any tx body.

Mongo handles `P2034` transparently via `withTransaction` and forge never
surfaces it on Mongo. SQL adapters do not. The pattern above is required on
Postgres, MySQL, SQLite, DuckDB, and MSSQL.

A common bug: building the `body` function inside the loop closure and
mutating shared state across attempts. The body must be idempotent in
inputs — every attempt sees the same starting state. Read what you need
outside the tx, capture in `const`, and run the body against those captures:

```ts
const acctId = req.body.from;
const amount = req.body.amount;
await withTxRetry(async (tx) => {
  // acctId and amount are stable across all attempts.
  const acct = await tx.account.findFirst({ where: { id: acctId } });
  // …
});
```

`AsyncLocalStorage` works the same way — store the request-scoped
correlation id outside the tx, read it inside. Each attempt picks up the
same store value because the outer async context is preserved across the
retry loop.

---

## Idempotency-Key interaction

Retrying a write that the network dropped mid-flight risks duplicating it.
The HTTP `Idempotency-Key` pattern is what stops that. See
[docs/MUTATIONS.md#idempotency](MUTATIONS.md#idempotency) for the full
shape; the relevant interaction with the retry harness is:

```ts
async function createOrderWithIdem(body: OrderInput, idemKey: string) {
  return withBackoff(
    async () => {
      // upsert keyed on the idempotency key — atomically either creates the
      // order or returns the existing one.
      return db.order.upsert({
        where: { idempotency_key: idemKey },
        create: { ...body, idempotency_key: idemKey },
        update: {},   // already exists → no-op, return the existing row.
      });
    },
    { isRetryable: (err) =>
        (err instanceof DbKnownError && err.code === 'P2034') ||
        (err instanceof DbKnownError && err.code === 'P1001'),
    },
  );
}
```

Two things to notice.

* **The idempotency check is at the *database* level**, via a unique index
  on `idempotency_key`. If two retries race past the network and both make
  it to the DB, the second one collapses into a `P2002` that `upsert`
  handles atomically.
* **Broader retryable predicate.** Because the write is idempotency-keyed,
  retrying on `P1001` (connection lost — write may or may not have applied)
  is safe. The DB-side unique index turns a duplicate into a no-op.

Without the idempotency key, broadening the retry predicate beyond `P2034`
is unsafe — you can't tell a "didn't apply" from an "applied but the ACK
got lost", and retrying either way means double-writes.

---

## The `error` event

Every adapter emits an `ErrorEvent` on the same emitter that fires
`QueryEvent` — see [docs/EVENTS.md#the-errorevent-shape](EVENTS.md#the-errorevent-shape):

```ts
export interface ErrorEvent {
  adapter: 'mongo' | 'postgres' | 'mysql' | 'sqlite';
  model: string;
  op: string;
  sql: string;
  params: unknown[] | Record<string, unknown>;
  error: Error;
  duration_ms: number;
}
```

The `error` field is the **raw driver error**, before forge's wrapper has
mapped it to a `DbKnownError`. That's the right place to capture original
SQLSTATE / `errno` / `MongoServerError` if you want to log it. The mapped
form is what the caller catches; the unmapped form is what the subscriber
sees.

Wire it at boot:

```ts
db.$on('error', (e) => {
  log.error({
    adapter: e.adapter,
    model:   e.model,
    op:      e.op,
    sql:     e.sql.slice(0, 500),     // truncate
    duration_ms: e.duration_ms,
    err: { name: e.error.name, message: e.error.message },
  }, 'forge_error');
});
```

A single query either fires `query` or `error`, never both. Subscribers run
in the order they were registered. Listener errors are swallowed so
observability never breaks the query path — see
[docs/EVENTS.md#subscription-pattern](EVENTS.md#subscription-pattern).

Do not throw from the listener — if the sink is unhealthy, swallow:

```ts
db.$on('error', async (e) => {
  try { await sentryCapture(e); }
  catch { /* observability must not break the app */ }
});
```

The wrapper layer always runs *after* the listener — the caller still gets
the `DbKnownError`-mapped throw. The listener is purely observational.

---

## Wrapping and re-throwing

When forge wraps a driver error, it throws a *new* `DbKnownError` and the
original is gone from the stack. There is no `.cause` set on the wrapped
error — the relevant fields from the original are pulled into `meta`
(`sqlstate`, `errno`, `detail`, `target`, etc.) and the original is
discarded.

If you need the original for an upstream sink — Sentry, your audit log —
capture it inside the `error` event listener, before the wrapper layer runs.
That's the only place the unwrapped form is visible.

When *you* wrap a `DbKnownError` to attach HTTP context, keep the original
on `.cause` so the downstream handler can still inspect it:

```ts
class HttpError extends Error {
  constructor(public status: number, message: string, options?: { cause?: unknown }) {
    super(message, options);   // ES2022 — sets .cause
    this.name = 'HttpError';
  }
}

try {
  await db.user.create({ data });
} catch (e) {
  if (e instanceof DbKnownError && e.code === 'P2002') {
    throw new HttpError(409, 'email already in use', { cause: e });
  }
  throw e;
}
```

Now an error handler downstream that walks `.cause` chains will still find
the `DbKnownError` with the original `meta`.

`Error.cause` was standardised in ES2022 and works in every supported Node
and browser target. If you target ES2021 or earlier, attach the cause as a
plain property:

```ts
class HttpError extends Error {
  cause?: unknown;
  constructor(public status: number, message: string, cause?: unknown) {
    super(message);
    this.cause = cause;
  }
}
```

---

## `ForgeMissingDriverError`

Thrown by the adapter at `connect()` time when the underlying driver package
isn't installed for the dialect the URL implies (`src/adapters/missing-driver.ts`).
The message is actionable on purpose:

```
[forge] postgres adapter needs the 'pg' driver, but it's not installed.
  Detected:    DATABASE_URL=postgres://user:****@host/db  (inferred adapter: postgres)
  Install:     npm install pg
  Or override: createDb({ type: 'mongo' | 'postgres' | 'mysql' | 'sqlite' | 'duckdb' | 'mssql', url: '...' })
```

The URL is redacted (`user:****@host`) before printing so credentials don't
end up in `stderr`. The class has three readable fields:

```ts
class ForgeMissingDriverError extends Error {
  readonly code = 'FORGE_MISSING_DRIVER' as const;
  readonly kind: AdapterKind;
  readonly pkg: string;
  readonly originalUrl?: string;
}
```

Catch it explicitly if you want to install the package on the fly (rarely
useful in production):

```ts
import { ForgeMissingDriverError } from 'forge-orm';

try {
  const db = await createDb({ url: process.env.DATABASE_URL!, schema });
} catch (e) {
  if (e instanceof ForgeMissingDriverError) {
    console.error(`Run: npm install ${e.pkg}`);
    process.exit(1);
  }
  throw e;
}
```

`code` is a string literal, not a `P-`-prefixed forge code. That's because
this error fires *before* any adapter has connected to a database — it's a
boot-time failure, not a runtime DB failure. The catch site usually wants to
exit, not retry. See [docs/DRIVERS.md](DRIVERS.md) for the full per-dialect
driver-install matrix.

---

## CLI exit codes

`forge` and its subcommands use a four-value exit-code convention. The
canonical reference is [docs/CLI.md#exit-codes](CLI.md#exit-codes); the
mapping back to error classes is:

| Exit | Where                       | Caused by                                                                 |
|------|-----------------------------|---------------------------------------------------------------------------|
| 0    | all                         | Success. `diff` without `--check` exits 0 even when drift is detected.    |
| 1    | all                         | Pre-flight failure: `DATABASE_URL` unset, unknown URL prefix, schema-resolution failure, adapter doesn't implement the verb. Effectively `Error`-or-equivalent. |
| 2    | `push`, `push --enable-extensions`, `diff apply` | At least one DDL statement failed during apply. Equivalent to a `DbKnownError` at the runtime layer — the per-statement failure list is printed before exit. |
| 3    | `diff --check`              | Drift detected. No exception was thrown — this is the "schema and DB are out of sync" signal for CI gating. |

CI scripts should gate on the specific exit code, not "non-zero" — a `diff
--check` job that fails on 1 (DB unreachable) is a different alert than one
that fails on 3 (PR adds drift). The CLI doc has the full GitHub-Actions
example.

If a forge subcommand throws an unmapped `DbKnownError` (rare — usually a
driver-level error the runtime mapper doesn't have a code for), the
top-level `main().catch(err => { console.error(err); process.exit(1) })`
prints it and exits 1. The `code` and `meta` are visible in the stderr
output, so log aggregators pick them up.

---

## Sentry, Bugsnag, Rollbar

The pattern for any error-reporting SaaS is the same: capture the
`ErrorEvent` (not the wrapped `DbKnownError`), attach forge-level context as
tags, redact PII from `params` and `sql`, send.

### Sentry

```ts
import * as Sentry from '@sentry/node';

db.$on('error', (e) => {
  Sentry.captureException(e.error, (scope) => {
    scope.setTags({
      'forge.adapter': e.adapter,
      'forge.model':   e.model,
      'forge.op':      e.op,
    });
    scope.setContext('forge_query', {
      sql:         e.sql.slice(0, 500),
      duration_ms: e.duration_ms,
    });
    // Don't attach params by default — they often contain user data.
    return scope;
  });
});
```

### Bugsnag

```ts
import Bugsnag from '@bugsnag/js';

db.$on('error', (e) => {
  Bugsnag.notify(e.error, (event) => {
    event.context = `forge.${e.adapter}.${e.op}`;
    event.addMetadata('forge', {
      model:       e.model,
      sql:         e.sql.slice(0, 500),
      duration_ms: e.duration_ms,
    });
  });
});
```

### Rollbar

```ts
import Rollbar from 'rollbar';

db.$on('error', (e) => {
  rollbar.error(e.error, {
    adapter: e.adapter,
    model:   e.model,
    op:      e.op,
    sql:     e.sql.slice(0, 500),
    duration_ms: e.duration_ms,
  });
});
```

### PII redaction

Three rules.

* **`params` is opaque.** Don't ship it to a third-party error SaaS. Even
  on a "non-PII" model, parameter arrays carry whatever the query was
  filtering on — emails, ids, addresses, tokens. The `sql` text without
  params is safe; with params it isn't.
* **Truncate `sql`.** Production statements with large `IN` lists or
  embedded literals can be tens of kilobytes. Sentry truncates at 8KB
  silently; better to slice at 500-2000 yourself so the truncation point
  is deterministic.
* **Set `scope.setUser` deliberately.** Most teams populate Sentry's
  `user` block from the request context — that gives you the *application*
  user. Don't accidentally also populate it from `params[0]` because you
  saw a user id there.

The `error` event is the right cut point because it sees the unwrapped
driver error — preserving the original stack for the SaaS. The
`DbKnownError` you'd catch in a route handler has lost that stack to the
wrapper.

---

## Browser / sqlite-wasm errors

The browser adapter (`wasmSqliteDriver`, OPFS, sqlite-wasm) reports errors
through the same SQLite mapping table — see [docs/BROWSER.md](BROWSER.md)
for the full deployment story. Two browser-specific surfaces to know:

* **`SQLITE_BUSY` is much more likely.** In Node the `better-sqlite3`
  driver serialises through the binding; in the browser worker, writers
  from a second tab or a service worker can produce `SQLITE_BUSY` against
  the same OPFS file. Forge maps both `SQLITE_BUSY` and `SQLITE_LOCKED` to
  `P2034`, so the standard retry pattern works — but a long retry loop is
  more user-visible in the browser. Cap attempts at 3 with a 50ms base.

* **OPFS unavailable errors throw plain `Error`.** Worker startup throws
  `'[forge:wasm] opfs-sahpool VFS unavailable in this build'` or
  `'[forge:wasm] OPFS VFS unavailable — browser needs OPFS sync handles'`
  when the browser doesn't expose the OPFS APIs the worker needs (Firefox
  versions before OPFS-with-sync-handles, Safari with strict isolation
  off). These are *not* `DbKnownError` — they fire at `createDb` time
  before any query has run. Catch them and fall back to an in-memory DB
  or a server round-trip.

```ts
import { createDb } from 'forge-orm';

let db;
try {
  db = await createDb({ url: 'opfs:/app.db', schema });
} catch (e: any) {
  if (typeof e?.message === 'string' && e.message.includes('OPFS')) {
    console.warn('OPFS unavailable — falling back to memory DB');
    db = await createDb({ url: ':memory:', schema });
  } else {
    throw e;
  }
}
```

The browser worker also throws `'[forge:wasm] driver closed'` on calls
against a worker that was already terminated — usually a hot-reload
artefact in dev. Recreate the `db` on `vite:hot-update` and the error goes
away.

---

## Worked examples

### A. Retry transient errors with backoff

The straight pattern, applied to a single statement that you know is
idempotent in inputs:

```ts
import { DbKnownError } from 'forge-orm';

async function getActiveUsers() {
  return withBackoff(
    () => db.user.findMany({ where: { active: true }, take: 100 }),
    { attempts: 5, baseMs: 25 },
  );
}
```

The default `isRetryable` predicate matches only `P2034`. Reads never
produce `P2034` on their own, so this is effectively a no-op — until a hot
table starts producing read-side serialization failures under SERIALIZABLE.
At that point the retry harness already in place absorbs them.

When the statement *isn't* idempotent — a `create`, `update`, `delete` —
either wrap it in a `$transaction` (so the `P2034` you'd retry is the
whole tx) or pair it with an idempotency key as in
[Idempotency-Key interaction](#idempotency-key-interaction). Don't retry a
bare write on transient errors without one of those guards.

### B. Unique-violation as upsert race

Two concurrent requests trying to create the same record. The naive
"find then create" branch:

```ts
// Don't do this — racey.
let user = await db.user.findFirst({ where: { email } });
if (!user) user = await db.user.create({ data: { email, name } });
```

Between the `findFirst` and the `create`, another request can win. Result:
the second call's `create` throws `P2002`.

The right shape is `upsert`, which forge implements atomically:

```ts
const user = await db.user.upsert({
  where: { email },
  create: { email, name },
  update: {},        // already exists → no-op, return the existing row.
});
```

`upsert` compiles to a single round-trip on every adapter (see
[docs/MUTATIONS.md#upsert](MUTATIONS.md#upsert)) — `INSERT … ON CONFLICT DO
UPDATE` on Postgres / SQLite, `INSERT … ON DUPLICATE KEY UPDATE` on MySQL,
`MERGE` on MSSQL, `$setOnInsert` on Mongo — and the contention is handled
DB-side.

If you've inherited a code path that *does* the find-then-create branch and
can't refactor it right away, the local mitigation is to catch the
`P2002` race and read-back the winner:

```ts
async function ensureUser(email: string, name: string) {
  let user = await db.user.findFirst({ where: { email } });
  if (user) return user;
  try {
    return await db.user.create({ data: { email, name } });
  } catch (e) {
    if (e instanceof DbKnownError && e.code === 'P2002') {
      // Lost the race — read back what the winner wrote.
      const existing = await db.user.findFirst({ where: { email } });
      if (existing) return existing;
    }
    throw e;
  }
}
```

This works, but it's strictly slower than `upsert` (two round-trips on
contention, three in the race-loser path) and harder to reason about. Use
it as a stop-gap; replace with `upsert` when you can.

### C. HTTP error middleware mapping

The boundary that turns any forge error into the right HTTP status. Drop
this in at the bottom of your route stack:

```ts
import { DbKnownError } from 'forge-orm';

export function forgeErrorHandler(err: unknown, _req: Request, res: Response, next: NextFunction) {
  if (!(err instanceof DbKnownError)) return next(err);

  switch (err.code) {
    case 'P2002': return res.status(409).json({
      error: 'conflict',
      target: err.meta?.target,
      message: 'Record already exists.',
    });
    case 'P2003': return res.status(400).json({
      error: 'bad_reference',
      message: 'Referenced record does not exist.',
    });
    case 'P2004': return res.status(422).json({
      error: 'constraint',
      message: err.message,
    });
    case 'P2011': return res.status(422).json({
      error: 'missing_field',
      field: err.meta?.field_name,
    });
    case 'P2025': return res.status(404).json({
      error: 'not_found',
      message: err.message,
    });
    case 'P2034': return res.status(503).json({
      error: 'retry_later',
      retry_after_ms: 100,
    });
    case 'P1001': return res.status(503).json({
      error: 'db_unreachable',
    });
    case 'P1010': return res.status(500).json({
      error: 'db_auth',
    });
    case 'P2024': return res.status(504).json({
      error: 'timeout',
    });
    case 'P2021':
    case 'P2022': return res.status(500).json({
      error: 'schema_drift',
      message: 'Service schema is out of sync — please retry shortly.',
    });
    default: return next(err);    // unknown code — let the global handler log it
  }
}
```

Three things this gets right.

* **`default: next(err)`.** New codes hit the global handler with full
  stack, not a silent 500. A regression that introduces an unmapped code
  is loud.
* **Status codes are the right granularity.** 409 for unique-violation, 422
  for constraint, 503 for retryable / unreachable, 504 for timeout.
  A blanket `400` for everything in the constraint family papers over a
  real difference the caller can act on.
* **`err.meta` carries the field-level detail.** A 422 with no body is
  useless; `err.meta.target` (the constraint name) or `err.meta.field_name`
  (the column on `P2011`) tells the client which input failed.

If you also wire the `error` event to your APM (see
[Sentry / Bugsnag / Rollbar](#sentry-bugsnag-rollbar)), the middleware
above is the *only* place HTTP status mapping lives — the APM gets the raw
driver error with full stack; the client gets the right HTTP code. Don't
duplicate logging between the middleware and the listener; the listener
covers it.

---

## Cross-references

* [docs/MUTATIONS.md](MUTATIONS.md) — the `upsert` shape that turns
  `P2002` races into one round-trip; `Idempotency-Key` HTTP pattern.
* [docs/TRANSACTIONS.md](TRANSACTIONS.md) — `$transaction` semantics,
  `P2034` retry, deadlock vs serialization-failure, isolation levels.
* [docs/EVENTS.md](EVENTS.md) — the `error` event in full, the
  `ErrorEvent` shape, listener ordering and cost model.
* [docs/LOGGING.md](LOGGING.md) — pino / Winston wiring for the `query`
  and `error` events, slow-query thresholds, redaction.
* [docs/CLI.md](CLI.md) — every subcommand and its exit code, schema
  discovery cascade, environment variables.
* [docs/BROWSER.md](BROWSER.md) — sqlite-wasm + OPFS deployment, worker
  startup errors, `SQLITE_BUSY` behaviour with multi-tab writers.
* [docs/DRIVERS.md](DRIVERS.md) — per-dialect driver install matrix and
  `ForgeMissingDriverError` boot-time check.
* [docs/DIFF.md](DIFF.md), [docs/PUSH.md](PUSH.md) — `P2021` / `P2022`
  resolution: detect drift, push schema.
