# Streaming large result sets

`findManyStream` (and its per-driver equivalents) gives you an AsyncIterable over a query result without buffering the whole set in memory. This page documents what streaming actually looks like under each driver — pg cursors, mysql2 streaming, better-sqlite3 iteration, Mongo cursors, DuckDB Arrow — plus backpressure, pooling caveats, and HTTP-streaming response patterns.

The README chapter [Reading data](../README.md#reading-data) covers `findMany`
and the pagination knobs. [Queries deep-dive](./QUERIES.md#findmanystream--cursor-backed-streaming)
has the one-paragraph summary. This is the long form.

## Contents

* [When you actually need streaming](#when-you-actually-need-streaming)
* [`findManyStream` — the API surface](#findmanystream--the-api-surface)
* [Per-driver internals](#per-driver-internals)
  * [Postgres — `pg` server-side cursor](#postgres--pg-server-side-cursor)
  * [Postgres — `postgres.js` (porsager)](#postgres--postgresjs-porsager)
  * [MySQL — `mysql2.stream()`](#mysql--mysql2stream)
  * [MySQL — `mariadb` and PlanetScale serverless](#mysql--mariadb-and-planetscale-serverless)
  * [SQLite — `better-sqlite3.iterate()`](#sqlite--better-sqlite3iterate)
  * [SQLite — libsql / Turso](#sqlite--libsql--turso)
  * [Mongo — `cursor.stream()`](#mongo--cursorstream)
  * [DuckDB and MSSQL — chunked fallback](#duckdb-and-mssql--chunked-fallback)
* [Memory profile per driver](#memory-profile-per-driver)
* [Batching vs streaming — picking a chunk size](#batching-vs-streaming--picking-a-chunk-size)
* [Backpressure](#backpressure)
* [HTTP streaming response patterns](#http-streaming-response-patterns)
  * [hyper-express](#hyper-express)
  * [Express](#express)
  * [Next.js Route Handler](#nextjs-route-handler)
* [CSV export](#csv-export)
* [NDJSON streaming](#ndjson-streaming)
* [Pause, resume, abort](#pause-resume-abort)
* [Transactions and streaming](#transactions-and-streaming)
* [Pooling caveats](#pooling-caveats)
* [Errors mid-stream](#errors-mid-stream)
* [Worked example A — million-row CSV export](#worked-example-a--million-row-csv-export)
* [Worked example B — Postgres → DuckDB → Parquet ETL](#worked-example-b--postgres--duckdb--parquet-etl)
* [Worked example C — Mongo change-stream subscription](#worked-example-c--mongo-change-stream-subscription)
* [Cross-references](#cross-references)

---

## When you actually need streaming

`findMany` builds a single `T[]` array in memory. During the call,
heap holds the driver row buffer (native shape per driver), the
decoded row buffer (post-`decodeRow`), and per-row V8 overhead
(hidden-class tags, deduped strings, Date allocation per timestamp,
BigInt boxing). A 1 KB row weighs 4–6 KB once V8 finishes
allocating; a one-million-row `findMany` lands at 4–6 GB before the
handler returns — enough to OOM a 4 GB container, a Lambda env, or
a Workers isolate without ever issuing a slow query.

Streaming is the right answer when the result set does not fit in
heap (CSV/Parquet exports, full-table re-indexes, bulk migrations);
when the consumer is back-pressured externally (slow client
download, S3 multipart upload, Kafka producer with a bounded
queue); when you want TTFB to land before the query finishes; or
when you are piping into another engine (PG → DuckDB → Parquet,
Mongo → S3).

Streaming is the wrong answer when the result fits in memory and
you need it sorted or aggregated by the consumer — let the database
materialise it once via `findMany`. It is also wrong when you need
`include`-style relation preloading: `findManyStream` does not
batched-hydrate relations across the stream (see below).

## `findManyStream` — the API surface

```ts
async *findManyStream<A extends {
  where?: WhereInput<F>;
  orderBy?: OrderByInput<F> | OrderByInput<F>[];
  chunkSize?: number;
}>(args: A = {} as A): AsyncIterable<ResolvedRow<F>>
```

It is an async generator. Call it inside a `for await` loop, an
async iterator helper, or pipe it through `Readable.from(iter)` to
get a Node stream.

```ts
for await (const order of db.order.findManyStream({
  where:   { created_at: { gte: yearStart } },
  orderBy: { id: 'asc' },
})) {
  await processOne(order);
}
```

The signature is deliberately narrower than `findMany`:

| Argument | Streamable? | Why |
|---|---|---|
| `where` | yes | translates straight to the underlying SELECT |
| `orderBy` | yes | required if you care about row order; the cursor reads in heap/insertion order otherwise |
| `chunkSize` | yes | only used by the OFFSET/LIMIT fallback (DuckDB, MSSQL) — adapters with a native cursor ignore it |
| `select` | no | not exposed on the stream signature; rows come back as full leaf rows |
| `include` | **no** | batched relation hydration would need to buffer the whole stream — defeats the point |
| `take` / `skip` / `cursor` (pagination) | no | the stream already runs to the end of the query; cap it by the `where` instead |

Where it diverges from `findMany`:

* the return type is `AsyncIterable<ResolvedRow<F>>`, not `Promise<Row[]>`;
* it never resolves to a single array — the only way to "drain" it is to
  iterate it;
* it does not run query-level relation hydration; if you need
  `include`-style children, batch the stream into chunks of N and call
  `findMany({ where: { id: { in: ids } }, include: { … } })` per chunk;
* it does not run the `applyProjectionAndHydration` pass — only the
  per-row `decodeRow` (so timestamps still become `Date`, JSON still
  decodes, but no relation join happens).

Internally, `findManyStream` in `src/builder/collection.ts` prefers
adapter-native streaming via `streamSelect`, and falls back to an
OFFSET/LIMIT loop when the adapter does not implement it:

```ts
async *findManyStream(args): AsyncIterable<ResolvedRow<F>> {
  if (typeof (this.adapter as any).streamSelect === 'function') {
    const node = buildSelect(/* … */);
    const iter = this.adapter.streamSelect(node, this.model, { session: this._session });
    for await (const row of iter) yield row as ResolvedRow<F>;
    return;
  }
  const chunkSize = args.chunkSize ?? 1000;
  let offset = 0;
  while (true) {
    const batch = await this._find({ ...args, take: chunkSize, skip: offset }, undefined);
    if (!Array.isArray(batch) || batch.length === 0) return;
    for (const row of batch) yield row as ResolvedRow<F>;
    if (batch.length < chunkSize) return;
    offset += batch.length;
  }
}
```

The adapter contract is one optional method, `streamSelect?(node,
model, opts?): AsyncIterable<any>`. Adapters that implement it own
the cursor mechanics. Adapters that don't get the OFFSET/LIMIT
fallback for free — same call shape, worse guarantees (concurrent
inserts during the stream can shift the window).

## Per-driver internals

### Postgres — `pg` server-side cursor

The `pg` driver opens a transaction, declares a server-side cursor,
and `FETCH`es 200 rows at a time:

```ts
// src/adapters/postgres/driver.ts (pgDriver)
stream: async function* (sql, params) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const name = `forge_stream_${(_cursorSeq++).toString(36)}`;
    await client.query(`DECLARE ${name} CURSOR FOR ${sql}`, params);
    for (;;) {
      const { rows } = await client.query(`FETCH 200 FROM ${name}`);
      if (rows.length === 0) break;
      for (const r of rows) yield r;
      if (rows.length < 200) break;
    }
    await client.query(`CLOSE ${name}`);
    await client.query('COMMIT');
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* swallow */ }
    throw err;
  } finally {
    client.release();
  }
}
```

Notes that matter in production. The cursor name uses a
process-monotonic counter (`Date.now()` would collide on concurrent
streams sharing a connection). The `BEGIN`/`COMMIT` wrap is
mandatory because PG closes a non-`WITH HOLD` cursor at
transaction end — without it, the cursor is invalid on the second
`FETCH`. The fetch window is fixed at 200 rows and is not a public
knob today; wrap the driver and adjust the constant if you need it
different. One streaming call holds *one* pool connection from
`BEGIN` to `COMMIT` — see [Pooling caveats](#pooling-caveats).

### Postgres — `postgres.js` (porsager)

`postgres.js` does not implement `stream` in forge today
(`postgresJsDriver` ships `query` + `transaction` + `close` only).
`findManyStream` on a db built with `postgresJsDriver` falls through
to a single `query` followed by per-row yields — the iterator shape
is preserved but memory is not capped. Two workarounds: (1) build a
parallel `pgDriver(new pg.Pool(…))` for export handlers and keep
`postgres.js` for normal traffic — forge supports multiple driver
instances against the same schema; (2) drop to
`sql.unsafe(text).cursor(200)` — porsager's native cursor API — by
reaching for the driver via `db.$driver.unsafe`, skipping forge for
that one query.

### MySQL — `mysql2.stream()`

`mysql2` exposes a Readable stream on every query. The driver
wraps it as an async generator (`src/adapters/mysql/driver.ts`):

```ts
stream: async function* (sql, params) {
  const conn = await pool.getConnection();
  try {
    const raw = (conn as any).connection ?? conn;
    const s: any = raw.query({ sql, values: params }).stream({ highWaterMark: 200 });
    for await (const row of s) yield row;
  } finally {
    if (typeof (conn as any).release === 'function') (conn as any).release();
  }
}
```

The `highWaterMark` of 200 is mysql2's row-level backpressure knob,
not a byte count — the driver pauses reading from the socket
whenever 200 rows are buffered upstream of the consumer. A slow
consumer holds the connection, same way a PG cursor does. There is
no implicit transaction here; MySQL streams without `BEGIN`.
Concurrent writes during the stream are visible (or not) per the
session's isolation level — `REPEATABLE READ` on InnoDB gives a
consistent read view without needing the wrap.

### MySQL — `mariadb` and PlanetScale serverless

Neither `mariadbDriver` nor `planetscaleDriver` implements `stream`.
mariadb supports streaming via `queryStream`, but it isn't wired up
in forge today. PlanetScale's HTTP transport fundamentally cannot
stream — every query is a request/response pair — so
`findManyStream` on PlanetScale falls back to OFFSET/LIMIT chunking.
For mariadb, build a parallel `mysql2` driver for export handlers
or drop to `pool.queryStream()` directly.

### SQLite — `better-sqlite3.iterate()`

`better-sqlite3` is synchronous, and its prepared statement carries
a native `iterate()` that returns row-by-row:

```ts
// src/adapters/sqlite/driver.ts (betterSqlite3Driver)
iterate: (sql, params) => db.prepare(sql).iterate(...params)
```

The SQLite adapter wraps it on demand:

```ts
async *streamSelect(node, model): AsyncIterable<any> {
  const a = compileSelect(node, model);
  if (this.db.iterate) {
    for await (const row of this.db.iterate(a.sql, a.params))
      yield decodeRow(model, row);
  } else {
    const rows = await this.db.all(a.sql, a.params);
    for (const row of rows) yield decodeRow(model, row);
  }
}
```

This is the cheapest streaming path forge ships. `better-sqlite3`
holds the row pointer inside the sqlite3 statement and decodes a
single row per `.next()` call — one V8/native boundary crossing per
row, no transaction, no pool, no FETCH round-trip. A 500-million-row
export on local disk holds ~1 KB of resident memory beyond the
decoded row.

Caveats: `better-sqlite3` blocks the event loop while the iterator
is active — use `setImmediate(resolve)` between batches if you need
to interleave HTTP work on the same process. A SQLite write
mid-stream blocks until the statement closes (the read holds a
shared lock), so long streams + heavy writes cause writer
starvation. Plan around it (reader-only WAL connection, or chunk
the export).

### SQLite — libsql / Turso

`libsqlDriver` (`@libsql/client`) does not expose a row-at-a-time
cursor — the HTTP/websocket protocol returns the full result set per
`execute()`. forge's `iterate` is absent on libsql; `streamSelect`
falls through to a single `all()` followed by per-row yields. The
iterator shape works but does **not** cap memory — the full result
still lands in heap. For real streaming on Turso: use the batch API
and page via keyset pagination on the primary key (one round-trip
per page), or run the export from a co-located node with a
`better-sqlite3` driver against an embedded replica
(`@libsql/client/sync`).

### Mongo — `cursor.stream()`

The Mongo adapter calls `coll.find(filter, options).stream()` and
decodes each row through `decodeRow`:

```ts
// src/adapters/mongo/adapter.ts
async *streamSelect(node, model, opts): AsyncIterable<any> {
  const a = compileSelect(node, model);
  const coll = dbClient.db.collection(model.collection);
  const cursor = coll.find(a.args.filter, {
    ...a.args.options,
    session: this.mongoOpts(opts).session,
  });
  for await (const raw of cursor.stream()) {
    yield decodeRow(model, raw);
  }
}
```

Under the hood: one pool connection held for the cursor's lifetime;
`OP_GET_MORE` requests in batches of `batchSize` (default ~101 first
batch, 16 MB subsequent — set `batchSize` on the find options to
bound it); the cursor is closed when the iterator drains, errors
out, or the consumer calls `.return()` (which the `for await` loop
does on early `break`). Mongo cursors honour `session`, so a
`findManyStream` inside `db.$transaction(async (tx) => …)` runs
against the same logical session — replica set / mongos required
as usual.

### DuckDB and MSSQL — chunked fallback

Neither adapter exposes `streamSelect` in forge today. Both rely on
the builder-level fallback: a loop of `take` + `skip` chunks. The
iterator shape is preserved but it inherits OFFSET/LIMIT's failure
modes — concurrent inserts can shift the window (rows skipped or
duplicated), and the cost of `OFFSET N` grows linearly on most
engines. On DuckDB the per-chunk overhead is also high (round-trip
+ plan + scan) relative to a single materialised query. A better
path for DuckDB exports is `$queryRaw` with `COPY (…) TO STDOUT
(FORMAT PARQUET)` and pipe the binary stream — see [worked example B](#worked-example-b--postgres--duckdb--parquet-etl).

## Memory profile per driver

What is actually resident in V8 heap at any moment during a stream:

| Driver | Held in heap | Held server-side |
|---|---|---|
| Postgres (`pg`) | current row + fetch window (200 rows) | the cursor's portal (negligible) |
| Postgres (`postgres.js`) | **full result** (no cursor today) | none |
| MySQL (`mysql2`) | current row + `highWaterMark` (200 rows) | the open query buffer |
| MariaDB / PlanetScale | **full result** (no cursor today) | none |
| SQLite (`better-sqlite3`) | current row | the open prepared statement (negligible) |
| SQLite (libsql) | **full result** (no cursor) | none |
| Mongo | current row + batch (`batchSize` docs, default ~101) | the cursor's BSON buffer |
| DuckDB / MSSQL | `chunkSize` rows (default 1000) | none |

"Current row" is one decoded JS object plus the driver's
connection buffer (TLS frame, TCP receive). For 1 KB rows that is
tens of KB resident, flat. If the table says "**full result**"
for your driver, the iterator API is preserved but memory is not
capped — switch to a streaming-capable driver, or page manually
with keyset pagination.

## Batching vs streaming — picking a chunk size

The fallback path takes `chunkSize`. Native streams take it
implicitly via the fetch window. Either way the trade-off is the
same.

| Chunk size | Benefit | Cost |
|---|---|---|
| small (10–100) | low memory; consumer feels responsive; lower latency to first byte | more round-trips; per-round-trip overhead dominates on slow networks |
| medium (200–2000) | the sweet spot for most ETL / CSV exports | none of the extremes |
| large (5000+) | minimises round-trips; best end-to-end throughput on a fast pipe | larger heap residency; longer pause before the consumer sees the next row |

Numbers to anchor against: `PG FETCH 200` is forge's hardcoded
window — on a local network with 1 KB rows it sustains ~50–80k
rows/sec; cross-region you want it bigger. mysql2's `highWaterMark`
200 has the same shape. better-sqlite3 `iterate` has no chunk
concept — one native call per row, ~200–400k rows/sec on a warm
cache. Mongo's `batchSize` defaults to ~101 / 16 MB; set it
explicitly (`find().batchSize(1000)`) for predictable memory on
1 KB BSON rows.

## Backpressure

Async iterables compose with backpressure for free: the producer
does not advance until the consumer's `for await` body awaits and
resolves. End-to-end, a 50 ms upload in the body keeps the forge
generator from yielding, which keeps the adapter from calling
`cursor.next()`, which lets mysql2/pg stop reading the socket once
`highWaterMark` is full — the TCP window closes and the server
stops sending rows. The whole pipe goes quiet: no growing buffer,
no OOM. The cost is that the connection is *held* for the slow
path's duration — see [Pooling caveats](#pooling-caveats).

Three patterns that *break* backpressure. Buffering inside the
consumer (`for await (…) { queue.push(row) }` with unbounded
`queue`) just shifts the buffer; use a bounded queue or process
inline. Fan-out without await (`for await (…) { void process(row) }`)
cuts the loop — the generator runs flat-out and `process` calls
pile up on the microtask queue; use `await` or wrap in a `p-limit`
bounded concurrency primitive. And don't eagerly `.toArray()` — if
you wanted an array you wanted `findMany`.

## HTTP streaming response patterns

The shape is the same across frameworks: open the response, write a
header, then push chunks as the stream yields. Don't `await` the
whole stream and then write — that buffers the result and OOMs.

### hyper-express

```ts
// src/routes/export.ts
import { db } from '../db';

export const exportOrdersCsv = async (req: any, res: any) => {
  res.header('Content-Type', 'text/csv; charset=utf-8');
  res.header('Content-Disposition', 'attachment; filename="orders.csv"');
  res.write('id,created_at,total\n');

  for await (const order of db.order.findManyStream({
    where:   { created_at: { gte: req.query.since } },
    orderBy: { id: 'asc' },
  })) {
    const ok = res.write(
      `${order.id},${order.created_at.toISOString()},${order.total}\n`,
    );
    if (!ok) {
      // hyper-express returns false when the backpressure buffer is full;
      // wait for it to drain.
      await new Promise((resolve) => res.once('drain', resolve));
    }
  }

  res.end();
};
```

`hyper-express` (via uWebSockets) writes synchronously into a kernel
buffer until full, then returns `false`. The `drain` wait above is
how you give the kernel time to flush. Without it, the server
queues unboundedly and runs out of memory anyway — defeating the
point.

### Express

Same shape — `res.write` returns `false` when the internal
`Writable` buffer is over `highWaterMark` (default 16 KB), wait for
`drain`. The only thing worth noting beyond the hyper-express
example: if the database errors after headers are flushed, you
cannot set status 500. End the body, log, and rely on the consumer
parsing a truncated trailer (see [Errors mid-stream](#errors-mid-stream)).

### Next.js Route Handler

App Router supports `ReadableStream` directly. Adapt the async
iterator with a `ReadableStream` (Node 20+ has
`ReadableStream.from`, but the polyfill below works everywhere):

```ts
// app/api/orders.csv/route.ts
import { db } from '@/lib/db';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const iter = db.order.findManyStream({ orderBy: { id: 'asc' } });

  const stream = new ReadableStream({
    async start(ctrl) {
      const enc = new TextEncoder();
      ctrl.enqueue(enc.encode('id,created_at,total\n'));
      try {
        for await (const o of iter) {
          ctrl.enqueue(enc.encode(
            `${o.id},${o.created_at.toISOString()},${o.total}\n`,
          ));
        }
        ctrl.close();
      } catch (err) {
        ctrl.error(err);
      }
    },
    async cancel() {
      // Browser closed the tab / aborted; clean up the iterator so the
      // driver releases its connection.
      if ((iter as any).return) await (iter as any).return();
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': 'attachment; filename="orders.csv"',
    },
  });
}
```

`runtime: 'nodejs'` is required — the Edge runtime cannot host a
`pg` connection. `dynamic: 'force-dynamic'` opts out of Next's
static optimisation for this route.

## CSV export

CSV is the canonical streaming consumer. The wire format is
trivial, the bytes-per-row are usually below the rows-per-second
budget, and the consumer (a browser download) genuinely cannot
absorb a 4 GB array.

A safe escape helper (RFC 4180-ish):

```ts
function csvField(v: unknown): string {
  if (v == null) return '';
  if (v instanceof Date) return v.toISOString();
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  if (s.includes(',') || s.includes('"') || s.includes('\n') || s.includes('\r')) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function csvRow(values: unknown[]): string {
  return values.map(csvField).join(',') + '\n';
}
```

End-to-end with hyper-express:

```ts
app.get('/exports/orders.csv', async (req, res) => {
  res.header('Content-Type', 'text/csv; charset=utf-8');
  res.header('Content-Disposition', 'attachment; filename="orders.csv"');

  const cols = ['id', 'customer_id', 'created_at', 'total', 'status'] as const;
  res.write(cols.join(',') + '\n');

  let written = 0;
  try {
    for await (const o of db.order.findManyStream({
      where:   { created_at: { gte: new Date(req.query.since as string) } },
      orderBy: { id: 'asc' },
    })) {
      const line = csvRow(cols.map((c) => (o as any)[c]));
      if (!res.write(line)) {
        await new Promise((resolve) => res.once('drain', resolve));
      }
      written++;
    }
  } finally {
    res.end();
    console.log(`csv export complete: ${written} rows`);
  }
});
```

The `finally` matters — if the client aborts halfway through, the
generator throws (its `return()` is called by the runtime). Closing
the response from `finally` releases the kernel buffer; closing the
generator (which the `for await` does automatically on early exit)
releases the database connection.

## NDJSON streaming

NDJSON is the same shape, with `JSON.stringify` per row and a
newline. Easier to consume from a JS client because
`response.body.pipeThrough(new TextDecoderStream()).pipeThrough(splitLines)`
is one line.

```ts
app.get('/exports/orders.ndjson', async (req, res) => {
  res.header('Content-Type', 'application/x-ndjson; charset=utf-8');

  try {
    for await (const o of db.order.findManyStream({
      orderBy: { id: 'asc' },
    })) {
      const line = JSON.stringify(o) + '\n';
      if (!res.write(line)) {
        await new Promise((resolve) => res.once('drain', resolve));
      }
    }
  } finally {
    res.end();
  }
});
```

On the consumer side, `response.body.getReader()` plus a buffered
line-splitter on `\n` gives you one parsed object per line. If you
control both ends, NDJSON wins. CSV is for everyone else's
spreadsheet.

## Pause, resume, abort

The async iterator carries a `return()` method. The runtime calls
it on `break`, `throw`, `await iter.return()`, or stream
destruction (Express `res.on('close')`, fetch
`AbortController.abort()`). When called, the generator's `finally`
block runs: PG rolls back the streaming transaction and releases
the connection; MySQL drains/destroys the mysql2 stream and
releases the connection; SQLite (better-sqlite3) closes the
prepared statement iterator; Mongo closes the cursor
(`OP_KILL_CURSORS`). Abort handling is *automatic* if you wire it
at the iterator level:

```ts
async function streamWithAbort(req, res, iter) {
  // When the client closes the socket, end the iterator so the driver
  // releases its connection / cursor / transaction.
  req.on('close', () => {
    if ((iter as any).return) (iter as any).return();
  });

  for await (const row of iter) {
    if (!res.write(row + '\n')) {
      await new Promise((r) => res.once('drain', r));
    }
  }
}
```

With an `AbortController`, the pattern is the same — the
`AbortSignal`'s `abort` event closes the iterator. forge does not
take a signal directly today; do the wiring at the loop:

```ts
const ac = new AbortController();
const iter = db.order.findManyStream({ orderBy: { id: 'asc' } });

ac.signal.addEventListener('abort', () => {
  if ((iter as any).return) (iter as any).return();
});

try {
  for await (const order of iter) {
    if (ac.signal.aborted) break;
    await process(order);
  }
} catch (err) {
  if (err.name !== 'AbortError') throw err;
}
```

There is no "pause" primitive distinct from "stop awaiting." To
pause for ten seconds and resume, await for ten seconds in the loop
body — the driver idles for the duration. The connection stays
held, though, which is the next section.

## Transactions and streaming

The Postgres cursor is inherently transactional — the `pg` driver
opens its own `BEGIN`/`COMMIT` around the stream. Two consequences:
you cannot nest a `findManyStream` inside another `db.$transaction`
on `pg` and have them share a transaction (the inner stream opens
a *different* connection with its own BEGIN; the outer
transaction's uncommitted writes are not visible to the stream).
And if the consumer takes a long time, the BEGIN sits idle and
shows up as `idle in transaction` in `pg_stat_activity` — some
managed Postgres deployments kill sessions via
`idle_in_transaction_session_timeout`. Bump the timeout for the
export user or chunk the export.

MySQL streams without an implicit transaction. The session-level
isolation default (`REPEATABLE READ`) gives a consistent view for
the cursor's lifetime. For a stricter snapshot, wrap the stream in
`db.$transaction` — mysql2's pool returns the same connection for
both, and the stream runs against it:

```ts
await db.$transaction(async (tx) => {
  await tx.audit_log.create({ data: { kind: 'export_start' } });
  for await (const row of tx.order.findManyStream({ orderBy: { id: 'asc' } })) {
    await processOne(row);
  }
  await tx.audit_log.create({ data: { kind: 'export_done' } });
});
```

Mongo `$transaction` requires a replica set / mongos. When wrapped,
the stream's cursor inherits the session, so multi-document reads
are isolated.

SQLite (better-sqlite3) treats the iterator as part of whatever
transaction is currently open on the connection. A long stream
holds a shared lock; concurrent writers wait. Long exports + an
active web tier ⇒ write starvation, as covered above.

## Pooling caveats

Streaming holds a connection for the iterator's lifetime — the most
surprising property of `findManyStream` in production. A pool of 10
and 10 concurrent CSV downloads blocks every other request needing
a connection until one of the downloads finishes. A slow client
(1 MB/s on a 1 GB CSV ≈ 17 minutes) keeps the connection held that
long. On a `pg` stream, the held connection is also `idle in
transaction`, counting against `max_connections` and
`idle_in_transaction_session_timeout`.

When streaming is a real workload, the recipe is: (1) run exports
on a dedicated read pool — a second `db` against a read replica (or
a separate pool against the primary), sized to the
concurrent-export count, with a short `acquireTimeout` for fast
rejection; (2) cap concurrent exports at the application layer with
a semaphore (`p-limit`, `async-sema`, Redis token bucket); (3) push
non-interactive exports through a job queue (BullMQ writes the row
stream to S3, emails the link); (4) for slow client downloads,
write the export to S3 *first* and serve via CDN — the pool only
feels the export runtime, not the client download.

See [POOLING](./POOLING.md#sizing--the-formula-and-the-floor) for
the sizing formula. Rule of thumb: streaming workloads add
`(concurrent_streams × avg_stream_duration_seconds)` to effective
pool occupancy.

## Errors mid-stream

If the database errors after the first row has shipped, the HTTP
status is already committed — there is no way to flip it to 500.
The recovery options are: end the body abruptly (the client sees a
truncated CSV/NDJSON — line-oriented formats surface this by the
last line being partial, binary formats just look corrupt); write a
trailer (`JSON.stringify({ _error: err.message }) + '\n'` as the
last NDJSON line, the client parses for `_error`); or write to S3
with an `EXPORT.OK` marker file written *after* the stream
completes cleanly, the reader consults the marker.

The forge generator propagates the error through the `for await`
loop, so wrapping the loop in `try`/`finally` is enough to
guarantee cleanup:

```ts
try {
  for await (const row of db.order.findManyStream({ … })) {
    await write(row);
  }
} catch (err) {
  // The cursor / transaction is already cleaned up by the generator's
  // own finally (driver-level). We just log and rethrow.
  console.error('export failed mid-stream', err);
  throw err;
} finally {
  await flush();
}
```

Partial-result handling on the *consumer* side is a separate
problem. If the export is "all of last month's orders," a partial
stream is worse than no stream because the consumer might double-pay
on missing rows. Always pair a streaming write with a transactional
"export marker" so the consumer can tell complete from partial.

## Worked example A — million-row CSV export

Goal: stream a year of orders (~5 M rows) as a CSV download, with
backpressure, abort handling, and a bounded export pool.

```ts
// src/db-export.ts
// A dedicated read-only pool for exports — sized to the concurrent
// exports we can tolerate, with short queue.
import { createDb, pgDriver } from 'forge-orm';
import { Pool } from 'pg';
import { schema } from './schema';

const exportPool = new Pool({
  connectionString: process.env.DATABASE_READ_URL!,
  max: 4,
  idleTimeoutMillis: 60_000,
  // Short — when the pool is full, reject rather than queue.
  connectionTimeoutMillis: 2_000,
  // Long — exports are slow.
  statement_timeout: 30 * 60_000,
});

export const dbExport = await createDb({ driver: pgDriver(exportPool), schema });
```

```ts
// src/routes/orders-export.ts
import { Router } from 'express';
import { dbExport } from '../db-export';
import { Sema } from 'async-sema';

// Cap concurrent exports across the process to the export pool size.
const sema = new Sema(4);

export const ordersExport = Router();

function csvField(v: unknown): string {
  if (v == null) return '';
  if (v instanceof Date) return v.toISOString();
  const s = typeof v === 'string' ? v : String(v);
  return /[,"\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

ordersExport.get('/exports/orders.csv', async (req, res, next) => {
  let acquired = false;
  let iter: AsyncIterator<any> | undefined;
  let n = 0;

  try {
    await sema.acquire();
    acquired = true;

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="orders.csv"');
    res.write('id,customer_id,created_at,total,status\n');

    const since = new Date(String(req.query.since ?? '2025-01-01'));

    const stream = dbExport.order.findManyStream({
      where:   { created_at: { gte: since } },
      orderBy: { id: 'asc' },
    });
    iter = stream[Symbol.asyncIterator]();

    // Wire client abort → close iterator → release pool connection.
    req.on('close', () => {
      if (iter?.return) iter.return(undefined as any);
    });

    while (true) {
      const { done, value } = await iter.next();
      if (done) break;

      const line = [
        csvField(value.id),
        csvField(value.customer_id),
        csvField(value.created_at),
        csvField(value.total),
        csvField(value.status),
      ].join(',') + '\n';

      if (!res.write(line)) {
        await new Promise<void>((r) => res.once('drain', r));
      }
      n++;
    }

    res.end();
    console.log(`orders.csv export: ${n} rows`);
  } catch (err) {
    // Headers may be flushed. End the body and let the client see truncation.
    res.end();
    next(err);
  } finally {
    if (iter?.return) await iter.return(undefined as any).catch(() => {});
    if (acquired) sema.release();
  }
});
```

Defends against OOM (`findManyStream` + `res.write` + drain wait
caps memory at the pg fetch window plus the kernel send buffer);
connection exhaustion (the export pool is separate from the request
pool and the semaphore enforces the cap before opening the cursor);
client aborts (`req.on('close')` calls `iter.return()`, the
generator's `finally` rolls back the transaction and releases the
connection); and slow-client tarpitting (backpressure idles the
cursor; the short `connectionTimeoutMillis` rejects the next
exporter fast).

## Worked example B — Postgres → DuckDB → Parquet ETL

Read from a Postgres table, transform per row, write a Parquet file
via DuckDB. The shape is: stream the source via the pg cursor,
batched-insert into a DuckDB staging table, then `COPY` to Parquet
using DuckDB's native columnar writer.

```ts
// src/jobs/export-parquet.ts
import { dbExport } from '../db-export';
import { dbDuck } from '../db-duck'; // forge db backed by DuckDB
import { Sql } from 'forge-orm';

export async function exportOrdersToParquet(outputPath: string) {
  await dbDuck.$executeRaw(Sql`
    CREATE OR REPLACE TABLE _stage_orders (
      id VARCHAR, created TIMESTAMP, total DECIMAL(18,2), bucket VARCHAR
    )
  `);

  // Stream PG → batched INSERT into DuckDB.
  let buf: Array<[string, Date, number, string]> = [];
  const FLUSH_AT = 5_000;

  const flush = async () => {
    if (!buf.length) return;
    const values = buf.map((_, i) => {
      const o = i * 4;
      return `($${o + 1}, $${o + 2}, $${o + 3}, $${o + 4})`;
    }).join(', ');
    await dbDuck.$executeRaw(Sql.raw(
      `INSERT INTO _stage_orders VALUES ${values}`,
      buf.flat(),
    ));
    buf = [];
  };

  for await (const o of dbExport.order.findManyStream({
    where:   { created_at: { gte: new Date('2025-01-01') } },
    orderBy: { id: 'asc' },
  })) {
    buf.push([o.id, o.created_at, Number(o.total), bucketize(o.total)]);
    if (buf.length >= FLUSH_AT) await flush();
  }
  await flush();

  await dbDuck.$executeRaw(Sql.raw(
    `COPY _stage_orders TO '${outputPath}' (FORMAT PARQUET, COMPRESSION ZSTD)`,
  ));
  await dbDuck.$executeRaw(Sql`DROP TABLE _stage_orders`);
}
```

Upstream stream caps memory via the `pg` cursor; the per-row
transform runs in the loop; DuckDB inserts in batches so planner
overhead doesn't dominate; the final `COPY` runs DuckDB's
native Parquet encoder. Run it under a BullMQ worker so pool
occupancy is bounded by worker concurrency, not request traffic.

## Worked example C — Mongo change-stream subscription

`findManyStream` is a *snapshot* read — it streams the current
state of a query and finishes. Mongo's `coll.watch()` is the
complementary primitive: a tailing cursor over the oplog that
yields change events as they arrive. Pair the two for "load the
backlog, then subscribe":

```ts
// src/jobs/sync-orders.ts
import { db } from '../db';
import type { ChangeStreamDocument } from 'mongodb';

export async function syncOrders(downstream: (o: any) => Promise<void>) {
  const startedAt = new Date();

  // Phase 1 — backlog. Stream every existing order through.
  for await (const o of db.order.findManyStream({ orderBy: { id: 'asc' } })) {
    await downstream(o);
  }

  // Phase 2 — tail. Drop to the raw driver; change streams aren't
  // exposed on forge today.
  const native = (db as any).$driver.db.collection('order');
  const cs = native.watch(
    [{ $match: { 'fullDocument.created_at': { $gte: startedAt } } }],
    { fullDocument: 'updateLookup' },
  );

  for await (const ev of cs as AsyncIterable<ChangeStreamDocument>) {
    if (ev.operationType === 'insert' || ev.operationType === 'update') {
      await downstream(ev.fullDocument);
    }
  }
}
```

The backlog stream and the tail share the same forge schema and
the same Mongo pool but hold *different* connections (one per
cursor). `updateLookup` makes `fullDocument` populated on updates
so both paths feed the same downstream function. A real
implementation persists the change-stream resume token between
runs so a restart doesn't replay the entire oplog — that is a
Mongo driver concern, not a forge one.

## Cross-references

* [QUERIES](./QUERIES.md#findmanystream--cursor-backed-streaming) — the one-paragraph summary that pointed you here.
* [BACKEND](./BACKEND.md) — request lifecycle, transaction wrapping, graceful shutdown.
* [POOLING](./POOLING.md#sizing--the-formula-and-the-floor) — connection sizing including the streaming term.
* [EVENTS](./EVENTS.md) — `QueryEvent` instrumentation; streams emit one start/end pair per query.
* [TRANSACTIONS](./TRANSACTIONS.md) — interactions between `$transaction` and `findManyStream`.
* [RAW-SQL](./RAW-SQL.md) — when you want to drop to `$queryRaw` for streaming (PG `COPY TO STDOUT`, DuckDB `COPY … TO 'file' (FORMAT PARQUET)`).
* [BACKUP-RESTORE](./BACKUP-RESTORE.md) — large data movement using the same primitives.
* [MONGO](./MONGO.md) — Mongo cursor and `$transaction` constraints.
* [DUCKDB](./DUCKDB.md) — chunked fallback note and the `COPY … FORMAT PARQUET` pattern.
