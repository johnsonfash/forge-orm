# Binary columns — `f.bytes()`

A column that holds raw bytes: a thumbnail, a PDF, an encrypted blob, a
content hash, a signature. New in 2.18.0.

The JS type is `Uint8Array` on the way in and on the way out, because it
is the only binary container that exists unchanged in Node, the browser,
Bun, Deno and a Tauri webview. A Node `Buffer` is a `Uint8Array`
subclass, so server code keeps working with `Buffer` and browser code
keeps working with `Uint8Array`, and neither has to know what the other
does.

```ts
const Asset = model('assets', {
  id:   f.id(),
  name: f.string(),
  body: f.bytes(),                    // no declared ceiling
  etag: f.bytes({ maxBytes: 32 }),    // a hash — 32 bytes, never more
});

await db.asset.create({
  data: { name: 'logo.png', body: await file.arrayBuffer(), etag: sha256 },
});

const asset = await db.asset.findFirstOrThrow({ where: { name: 'logo.png' } });
asset.body.byteLength;                // it is a Uint8Array
```

> **DuckDB before 2.20.4.** `f.bytes()` did not work on DuckDB at all —
> writes threw `Cannot create values of type ANY` (the node bindings accept
> neither a `Uint8Array` nor a `Buffer`, only their own `blobValue()`), and a
> read returned a `DuckDBBlobValue` wrapper rather than bytes. Fixed in both
> directions in 2.20.4, and DuckDB now runs in CI so the path is executed
> rather than assumed.

## Contents

* [Why not a base64 string](#why-not-a-base64-string)
* [Storage per dialect](#storage-per-dialect)
* [`maxBytes`](#maxbytes)
* [What is accepted on write](#what-is-accepted-on-write)
* [The typed-array view trap](#the-typed-array-view-trap)
* [What reads hand back](#what-reads-hand-back)
* [Exported helpers](#exported-helpers)
* [Migration drift](#migration-drift)
* [Writing bytes through `update`](#writing-bytes-through-update)

---

## Why not a base64 string

This is the mistake the field kind exists to stop, so it is worth being
explicit: a base64 or hex **string** handed to an `f.bytes()` column is
refused, with an error that tells you how to decode it.

```
[forge] assets.body is f.bytes() and takes binary — a Uint8Array, Buffer,
ArrayBuffer or typed-array view. Got string.
  A base64 or hex string is not binary: decode it first
  (Buffer.from(s, 'base64'), or Uint8Array.from(atob(s), c => c.charCodeAt(0))
  in the browser).
```

Base64 is 4 bytes of text for every 3 bytes of data. Put it in a `text`
column and every one of those rows costs 33% more storage, 33% more
bandwidth on every read, and 33% more of the page cache — permanently,
and for as long as the table exists. Hex is worse: 100%. Neither is
recoverable later without rewriting the column, and by then there is
usually too much data to rewrite during a deploy window.

So the refusal is deliberate. Decode once, at the boundary where the
string arrives, and store the bytes.

## Storage per dialect

| Dialect   | Column type                                                                 |
|-----------|-----------------------------------------------------------------------------|
| Postgres  | `bytea`                                                                     |
| SQLite    | `BLOB`                                                                      |
| DuckDB    | `BLOB`                                                                      |
| MySQL     | smallest blob class that fits `maxBytes` — see below                        |
| MSSQL     | `VARBINARY(n)` when `maxBytes <= 8000`, otherwise `VARBINARY(MAX)`          |
| Mongo     | BSON `BinData`, subtype 0 (generic binary)                                  |
| IndexedDB | the typed array itself, via structured clone                                |

**MySQL size classes.** MySQL is the one dialect where the declared
ceiling changes the physical type, and it matters: a row's inline
portion is capped at 65,535 bytes, so declaring every blob `LONGBLOB`
costs an off-page pointer read on columns that never needed one.

| `maxBytes`            | Type         |
|-----------------------|--------------|
| `<= 255`              | `TINYBLOB`   |
| `<= 65535`            | `BLOB`       |
| `<= 16777215`         | `MEDIUMBLOB` |
| larger, or undeclared | `LONGBLOB`   |

**MSSQL.** `VARBINARY(MAX)` is stored off-row and cannot be indexed; an
inline `VARBINARY(n)` can. 8000 is the in-row ceiling for the type, so
that is where the switch happens. If you want the etag column indexable
on SQL Server, declare a `maxBytes`.

## `maxBytes`

`f.bytes({ maxBytes: 32 })` declares a ceiling, and the ceiling is
checked at **runtime on every dialect** — not only on the ones whose
column type carries a length.

```
[forge] assets.etag is 48 bytes, over its declared maxBytes of 32.
```

Postgres has one `bytea` with no length. SQLite has one `BLOB`. Mongo's
`BinData` has no declared size at all. If `maxBytes` were left to the
column type, it would be a MySQL-and-MSSQL-only constraint, and the same
write would be accepted by one database and rejected by another — which
is exactly the class of difference this library exists to remove. So
forge checks it itself, before the value reaches the driver.

Two details:

- It counts **bytes**, not elements. A `Float64Array` of 5 elements is 40
  bytes and does not fit `maxBytes: 8`.
- `maxBytes` must be a positive integer, and a bad value throws when the
  model is declared rather than on the first write:
  `f.bytes({ maxBytes: 0 })` and `f.bytes({ maxBytes: 1.5 })` both fail
  at schema definition.

## What is accepted on write

| Input                                          | Accepted | Notes                                                       |
|------------------------------------------------|----------|-------------------------------------------------------------|
| `Uint8Array`                                   | yes      | passed through, no copy                                     |
| Node `Buffer`                                  | yes      | it *is* a `Uint8Array`; passed through                      |
| `ArrayBuffer`                                  | yes      | what `File`/`Blob.arrayBuffer()` and `fetch()` hand back    |
| any other `ArrayBufferView` (`DataView`, `Int16Array`, …) | yes | reinterpreted as its exact byte window                 |
| a base64 / hex string                          | **no**   | throws, with the decode call in the message                 |
| anything else                                  | **no**   | throws, naming the model and field                          |

`ArrayBuffer` is accepted rather than requiring the caller to wrap it,
because that is what the web platform actually hands you — `await
file.arrayBuffer()`, `await res.arrayBuffer()` — and making every call
site write `new Uint8Array(...)` is friction with no upside.

## The typed-array view trap

A typed array is a **view** onto an `ArrayBuffer`, and it can be a view
onto part of one. Forge stores the view's own window — its
`byteOffset` and `byteLength` — not the whole underlying buffer:

```ts
const buf  = new ArrayBuffer(1024);
const view = new Uint8Array(buf, 100, 4);   // 4 bytes, starting at byte 100

await db.asset.create({ data: { name: 'x', etag: view } });
// stores 4 bytes. Not 1024.
```

This is the behaviour you want, and it is the opposite of what a naive
`new Uint8Array(v.buffer)` would do. It also means the trap runs the
other way: if you slice a large buffer with `subarray()` and expect the
whole buffer to be stored, it will not be.

Forge never copies — normalising a view produces another view over the
same memory, and so does handing it to the driver. That is free on the
server's hot path, and it means a view onto reused memory is a hazard:
Node's `Buffer.allocUnsafe` pool and a streaming reader's internal
buffer both get written over. If the bytes you are storing came from a
pool, copy them (`new Uint8Array(view)`) before the `await`.

## What reads hand back

A read always hands back something that **is** a `Uint8Array`, so the
row a server reads has the same usable type as the row the browser
reads. `value instanceof Uint8Array` is true on every dialect.

On Node that value is usually the driver's own `Buffer`, which is a
`Uint8Array` subclass. It is passed through rather than copied:
re-wrapping every blob on every read, only to hide a subclass, would
cost more than it buys. So `Buffer.isBuffer(row.body)` may be true on
the server and is false in the browser. Write code against the
`Uint8Array` surface (`byteLength`, `subarray`, indexing) and it runs in
both places.

The driver wrappers that are unwrapped for you:

| Driver         | Hands back                                    |
|----------------|-----------------------------------------------|
| mongodb        | BSON `Binary`, or `Buffer` with `promoteBuffers` |
| pg             | `Buffer`                                      |
| mysql2         | `Buffer`                                      |
| mssql          | `Buffer`                                      |
| better-sqlite3 | `Buffer`                                      |
| sqlite wasm    | `Uint8Array`                                  |
| duckdb         | `Uint8Array` / `Buffer`                       |

mongodb's `Binary` is recognised by its `_bsontype` marker rather than
an `instanceof`, so a duplicate `bson` module somewhere in the
dependency tree still unwraps correctly.

## Exported helpers

For code that sits at the edge — an upload handler, a driver wrapper,
a test fixture — the normalisation is exported:

```ts
import { toBytes, isBytesInput, fromDriverBytes } from 'forge-orm';
import type { BytesInput } from 'forge-orm';
```

| Export            | Signature                            | Use                                                                    |
|-------------------|--------------------------------------|------------------------------------------------------------------------|
| `BytesInput`      | type                                 | `Uint8Array \| ArrayBuffer \| ArrayBufferView` — the accepted write types |
| `isBytesInput`    | `(v: unknown) => v is BytesInput`    | a type guard, for validating input before you build the `data` object   |
| `toBytes`         | `(v: BytesInput) => Uint8Array`      | normalise to a `Uint8Array` view. No copy when the input already is one |
| `fromDriverBytes` | `(v: unknown) => unknown`            | driver → app: unwraps `Binary`, `ArrayBuffer` and other views          |

## Migration drift

`forge diff` compares a schema field against the column the database
actually has, using coarse categories so the comparison survives
dialect quirks. Before 2.18.0 a bytes column had no category, and the
comparison is skipped whenever either side is uncategorised — so a
`bytea` column that had been changed to `text` outside of forge was
**not reported as drift**. The schema said binary, the database said
text, and `diff` said nothing.

`bytes` is now its own category, and the binary type names are
recognised on the database side: `bytea`, `blob`, `tinyblob`,
`mediumblob`, `longblob`, `varbinary`, `binary`, `image`. So the
mismatch is reported:

```
column 'body': schema=bytes db=text
```

Note the two dialects where column types are never compared at all:
SQLite (its declared types are advisory) and Mongo (schemaless — only
collections and indexes are diffed). That is unchanged.

## Writing bytes through `update`

`create`, `createMany`, `upsert`, `update` and `updateMany` all validate
and prepare an `f.bytes()` value the same way. A plain assignment is
what you want:

```ts
await db.asset.update({
  where: { name: 'logo.png' },
  data:  { body: bytes },
});
```

Two bugs made this not work before the 2.18.0 release, and both are
worth knowing about because they show where the seams are.

**A typed array looked like an operator object.** The update builder
decides between "a value" and "an atomic operator like
`{ increment: 1 }`" by asking whether the object has a key named `set`
— and `Uint8Array.prototype.set` exists, so every bytes value took the
operator branch and the *method* became the column value. The driver
then refused it ("SQLite3 can only bind numbers, strings, bigints,
buffers, and null"). The builder now checks `isBytesInput` first, and
`bytes` joined the scalar kinds so a stray operator object on a bytes
column is refused with a named error rather than written through.

**The update path did not coerce at all.** Per-dialect inbound coercion
ran for `create`, `createMany` and `upsert`'s create block, and never
for `update`. So the explicit `{ set: bytes }` form reached the driver
raw: `maxBytes` was not enforced, and a base64 string was accepted and
stored as text — the exact thing this field kind exists to prevent. The
wrapper now runs the same coercion over an update's `set`.

Mongo is deliberately excluded from that step, because its
`coerceInbound` is the *create* payload builder and would stamp create
defaults onto an update. Mongo gets its coercion from `remapAndCoerce`
on the update compiler instead, so both paths are covered — see
[MONGO](./MONGO.md).

The atomic operators are not coerced on any dialect, and should not be:
`increment` / `multiply` / `divide` / `max` / `min` carry numbers rather
than column values, and `push` / `addToSet` / `pull` carry array
*elements*, which are not the column's own type.

---

## See also

- [MUTATIONS](./MUTATIONS.md) — `create` / `update` / `upsert`
  asymmetry and the atomic operator forms.
- [MODEL](./MODEL.md) — the full field catalogue.
- [MIGRATIONS](./MIGRATIONS.md) — how drift is detected and what
  `forge diff` reports.
- [MONGO](./MONGO.md) — `BinData` and the Mongo update path.
- [ENCRYPTION](./ENCRYPTION.md) — where an encrypted blob belongs.
