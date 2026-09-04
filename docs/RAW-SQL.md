# Raw SQL deep-dive — `$queryRaw`, `$executeRaw`, `$runCommandRaw`, `forgeSql`, `SqlFragment`

The [Running raw SQL chapter](../README.md#running-raw-sql) in the README
covers the surface — a tagged template, values become bound parameters,
SQL only. This doc is the companion reference for everything sitting
behind that one-paragraph tour: the difference between query and
execute, the `forgeSql` composition kit, identifier vs value
interpolation, per-dialect placeholder normalisation, the Mongo
BSON-command channel, raw inside a transaction, and the dialect-by-dialect
patterns that forge's typed API deliberately doesn't try to express.

Everything below assumes you're on 2.5.x. The two relevant
implementation files are `src/raw-sql.ts` (the `SqlFragment` type and
the dialect-aware compiler) and `src/factory.ts` (the `makeRawCaller`
shim that lets `$queryRaw` accept both tagged-template and
pre-built-fragment call styles).

## Contents

* [`$queryRaw` vs `$executeRaw`](#queryraw-vs-executeraw)
* [The `forgeSql` template tag](#the-forgesql-template-tag)
* [Composing SqlFragments](#composing-sqlfragments)
* [Identifier vs value interpolation](#identifier-vs-value-interpolation)
* [Per-dialect placeholder style](#per-dialect-placeholder-style)
* [`$runCommandRaw` — the Mongo BSON channel](#runcommandraw--the-mongo-bson-channel)
* [Returning shape and row typing](#returning-shape-and-row-typing)
* [Raw inside a `$transaction`](#raw-inside-a-transaction)
* [Postgres patterns](#postgres-patterns)
* [MySQL patterns](#mysql-patterns)
* [SQLite patterns](#sqlite-patterns)
* [DuckDB patterns](#duckdb-patterns)
* [MSSQL patterns](#mssql-patterns)
* [Mongo aggregation pipeline](#mongo-aggregation-pipeline)
* [Safety rules](#safety-rules)
* [Six worked patterns](#six-worked-patterns)
* [Integrating raw with typed reads](#integrating-raw-with-typed-reads)

---

## `$queryRaw` vs `$executeRaw`

Two methods, same call shape, different return type.

```ts
const rows: User[]    = await db.$queryRaw<User>`SELECT * FROM users WHERE id = ${id}`;
const affected: number = await db.$executeRaw`UPDATE users SET active = false WHERE last_seen < ${cutoff}`;
```

* **`$queryRaw<T = any>`** returns `T[]` — the rows the driver hands
  back. Forge does not project, hydrate, or coerce. Whatever the
  database returns is what you get. On Postgres that's a plain JS
  object per row; on MySQL it's the `RowDataPacket[]`; on SQLite it's
  what `better-sqlite3` (or the wasm driver) hands over from `all()`.
* **`$executeRaw`** returns `number` — `rowCount` on Postgres / MSSQL,
  `affectedRows` on MySQL, `changes` on SQLite. Use it for
  `INSERT` / `UPDATE` / `DELETE` / DDL. The number is whatever the
  driver reported; some statements (`CREATE TABLE`, `PRAGMA`) report 0
  even though they succeeded.

Both methods accept two call styles. The internal shim
`makeRawCaller` in `src/factory.ts` detects whether the first argument
is a `TemplateStringsArray` (it has a `.raw` array of strings on it) or
a pre-built `SqlFragment`, and routes accordingly:

```ts
// Tagged-template form — natural at the call site.
await db.$queryRaw`SELECT * FROM users WHERE email = ${email}`;

// Pre-built fragment form — natural when you assembled SQL earlier.
const frag = forgeSql.sql`SELECT * FROM users WHERE email = ${email}`;
await db.$queryRaw(frag);
```

Both paths land in the same compiler. Anything inside `${…}` is bound
as a parameter; nothing is string-spliced into the SQL. That's the
guarantee against SQL injection — even if `email` is the classic
`x'; DROP TABLE users;--`, the compiled SQL is
`SELECT * FROM users WHERE email = $1` and the string lives in the
`params` array.

The Mongo adapter exposes both methods but they always throw:

```
[forge] $queryRaw is SQL-only. For Mongo, use db.<model>.aggregate({ pipeline })
        or db.$runCommandRaw(command) for arbitrary BSON commands.
```

If you want to write code that targets any of the six dialects, route
SQL-shaped work through `$queryRaw` / `$executeRaw` and Mongo-shaped
work through the typed surface plus `$runCommandRaw` — never mix.

---

## The `forgeSql` template tag

`forgeSql` is the composition kit. It exposes four things:

```ts
import { forgeSql } from 'forge-orm';

forgeSql.sql`SELECT * FROM users WHERE id = ${id}`;   // → SqlFragment
forgeSql.raw('CURRENT_TIMESTAMP');                    // → SqlFragment (literal, no escape)
forgeSql.join([a, b, c], ' AND ');                    // → SqlFragment (concatenated)
forgeSql.empty;                                       // → SqlFragment (sentinel)
```

Use `forgeSql.sql` whenever you'd want backticks on `db.$queryRaw` but
the SQL isn't ready to run yet — for example when you're assembling
clauses in one function and passing the fragment to a query in
another. The two examples below are equivalent:

```ts
// Inline.
const rows = await db.$queryRaw`SELECT * FROM users WHERE id = ${id}`;

// Pre-built.
const frag = forgeSql.sql`SELECT * FROM users WHERE id = ${id}`;
const rows = await db.$queryRaw(frag);
```

You'll reach for the pre-built form most often when:

1. The same fragment is used in two queries (a shared `WHERE` clause).
2. You're building the SQL conditionally and want each branch to
   return a fragment.
3. You want to write the fragment to a log, hash it for a cache key,
   or unit-test the compile output.

`forgeSql.raw(s)` is the escape hatch. It emits its argument literally,
with no placeholder, no escaping, nothing. Reserve it for constants
you know at code-write time — column names, type names, the keyword
`DESC`. Never pass user input. There is no way for the compiler to
distinguish a safe literal from an unsafe one once it leaves your
keyboard, so the rule is "constants only."

`forgeSql.empty` is a no-op fragment. Useful when a branch wants to
contribute nothing to a composed query:

```ts
const tail = onlyActive ? forgeSql.sql`AND active = ${true}` : forgeSql.empty;
const rows = await db.$queryRaw`SELECT * FROM users WHERE org_id = ${orgId} ${tail}`;
```

Without the sentinel you'd need a conditional template, which the
TypeScript tagged-template inference doesn't love. With it, the outer
template stays a single shape.

---

## Composing SqlFragments

The composition contract is: anything inside `${…}` that is a
`SqlFragment` gets inlined as SQL with its parameters renumbered into
the outer fragment; anything else gets bound as a parameter.

That's the entire trick. From `src/raw-sql.ts`:

```
function appendFragment(frag, dialect, params, out) {
  out.push(frag.strings[0]);
  for (let i = 0; i < frag.values.length; i++) {
    const v = frag.values[i];
    if (isSqlFragment(v)) {
      appendFragment(v, dialect, params, out);     // recurse, share params
    } else {
      params.push(v);
      out.push(dialect === 'postgres' ? `$${params.length}` : '?');
    }
    out.push(frag.strings[i + 1]);
  }
}
```

Renumbering is what makes nested composition safe. If your inner
fragment binds `$1`, and the outer fragment already bound two
parameters, the inner one's placeholder becomes `$3` in the final SQL
— the inner doesn't have to know its position in advance.

### Worked example — dynamic ORDER BY whitelist

A common case where typed `findMany` doesn't go far enough: the user
asked to sort by a column that lives in a JSON blob, and the direction
comes from a query string. You want safe sorting without exposing
arbitrary column injection.

```ts
import { forgeSql, type SqlFragment } from 'forge-orm';

const SORT_WHITELIST: Record<string, SqlFragment> = {
  'name':       forgeSql.raw('"name"'),
  'created':    forgeSql.raw('"created_at"'),
  'last_seen':  forgeSql.raw("(meta->>'last_seen')::timestamptz"),
};

function buildOrderBy(field: string, dir: 'asc' | 'desc'): SqlFragment {
  const col = SORT_WHITELIST[field] ?? SORT_WHITELIST.name;
  const direction = dir === 'desc' ? forgeSql.raw('DESC') : forgeSql.raw('ASC');
  return forgeSql.sql`ORDER BY ${col} ${direction}`;
}

const orderBy = buildOrderBy(req.query.sort, req.query.dir);
const rows = await db.$queryRaw<User>`
  SELECT * FROM users
  WHERE org_id = ${orgId}
  ${orderBy}
  LIMIT ${pageSize}
`;
```

Two things to call out:

1. The whitelist values are `SqlFragment`s built with `forgeSql.raw`.
   That's why they make it into the SQL as identifiers, not as bound
   parameters. The user's `req.query.sort` is the lookup key for the
   map — it never reaches the SQL itself.
2. The compiled output is the obvious thing: `SELECT * FROM users
   WHERE org_id = $1 ORDER BY "name" DESC LIMIT $2`, with `params =
   [orgId, pageSize]`.

`forgeSql.join` is the variant for variable-length lists:

```ts
const conditions = filters.map((f) => forgeSql.sql`${f.col} = ${f.value}`);
const where = forgeSql.join(conditions, ' AND ');
await db.$queryRaw`SELECT * FROM logs WHERE ${where}`;
```

If `filters` is empty, `join` returns `forgeSql.empty`, so wrap the
caller to defend against an empty `WHERE`:

```ts
const where = conditions.length
  ? forgeSql.sql`WHERE ${forgeSql.join(conditions, ' AND ')}`
  : forgeSql.empty;
await db.$queryRaw`SELECT * FROM logs ${where}`;
```

---

## Identifier vs value interpolation

This is the one rule everyone gets wrong the first time. Forge
parameterises values. It does not parameterise identifiers, because
no SQL dialect supports parameterised table or column names.

```ts
// BUG — column name comes from req.query, gets bound as a STRING.
const col = req.query.sort;
await db.$queryRaw`SELECT * FROM users ORDER BY ${col}`;
// Postgres compiles to: ORDER BY $1, params = ['name']
// Result: "could not identify column $1 in record" or sorts by a constant.
```

The compiler does the safe thing — `${col}` becomes `$1`, and the
literal string `'name'` is passed as a parameter. The database then
either errors out (Postgres won't sort by a parameter binding) or
treats it as a constant expression. Either way the user sees nothing
sensible.

```ts
// FIX — identifier comes from a whitelist of pre-built fragments.
const COLS: Record<string, SqlFragment> = {
  name:    forgeSql.raw('"name"'),
  created: forgeSql.raw('"created_at"'),
};
const col = COLS[req.query.sort] ?? COLS.name;
await db.$queryRaw`SELECT * FROM users ORDER BY ${col}`;
// Compiles to: ORDER BY "name", params = []
```

The structural difference: values get bound, fragments get inlined.
The whitelist makes the lookup safe — even if `req.query.sort` is
`x"; DROP TABLE users; --`, it just falls through to the default.

The other variant is "I know this identifier is a constant at
code-write time, but I need it interpolated." That's
`forgeSql.raw('table_name')`. Same caveat — constants only.

A future version may ship `forgeSql.identifier(name, dialect?)` that
applies the dialect's quoting rules and validates the identifier
shape. Until then, treat any dynamic identifier as
whitelist-or-throw.

---

## Per-dialect placeholder style

Every adapter compiles the same `SqlFragment` through
`compileSqlFragment(frag, dialect)`, with the dialect picked per
adapter. The output uses the placeholder style the underlying driver
expects.

| Adapter   | Placeholder | Compiled from `WHERE a = ${1} AND b = ${2}` |
|-----------|-------------|----------------------------------------------|
| Postgres  | `$1, $2`    | `WHERE a = $1 AND b = $2`                    |
| DuckDB    | `$1, $2`    | `WHERE a = $1 AND b = $2`                    |
| MSSQL     | `$1, $2`    | `WHERE a = $1 AND b = $2`                    |
| MySQL     | `?, ?`      | `WHERE a = ? AND b = ?`                      |
| SQLite    | `?, ?`      | `WHERE a = ? AND b = ?`                      |
| Mongo     | n/a         | throws — use `$runCommandRaw`                |

A few wrinkles worth noting:

* **MSSQL** uses `$1, $2` in compiled SQL because the `mssql` driver
  forge wraps accepts positional parameters via its `Request.query()`
  shim. The `@p1, @p2` style is the on-the-wire form for that driver
  — the wrapper rewrites positional `$N` placeholders into
  `@pN` before sending. If you hand-write SQL that uses `@p1` directly,
  forge won't recognise it as a placeholder and the compiler will
  treat it as literal SQL — you'll see "@p1" reach the database. Stick
  with `${value}` in the tagged template and let forge do the
  conversion.
* **DuckDB** also takes `$1, $2`. It also accepts `?, ?`, but forge
  emits the numbered form for parity with Postgres.
* **MySQL** and **SQLite** use unnamed `?`. Each `${…}` consumes one
  placeholder; renumbering is moot — order in the SQL matches order
  in the params array.

The dialect is picked at the call site by the adapter, not by the
caller. You write the same ``forgeSql.sql`SELECT … = ${x}``` and forge
emits the right form per driver. The two cases where you need to know
the dialect are: (a) DDL, where the syntax differs significantly, and
(b) dialect-specific functions like `ST_DWithin`. Both are handled
below.

---

## `$runCommandRaw` — the Mongo BSON channel

`$runCommandRaw` is the BSON command channel — the Mongo equivalent
of `$queryRaw`. It hands a BSON document straight to
`db.command(...)`, with one pre-pass: extended-JSON coercion.

```ts
const out = await db.$runCommandRaw({
  createIndexes: 'users',
  indexes: [
    {
      key: { email: 1 },
      name: 'email_unique_case_insensitive',
      unique: true,
      collation: { locale: 'en', strength: 2 },
    },
  ],
});
```

Reach for `$runCommandRaw` when:

1. You want a Mongo feature forge doesn't surface yet (collation,
   `expireAfterSeconds`, `partialFilterExpression` shapes the typed
   index DSL doesn't cover, change streams, server administration).
2. You're running `createIndexes` / `dropIndex` / `collMod` ad-hoc
   against an existing collection.
3. You're calling an aggregation pipeline that uses operators outside
   forge's typed pipeline DSL (`$graphLookup`, `$function`,
   `$accumulator`, custom JS).
4. You're testing the shape a Mongo command takes before lifting it
   into a typed call.

The other adapters' `$runCommandRaw` throws:

```
[forge] $runCommandRaw is Mongo-only. Use $queryRaw on SQL adapters.
```

### Extended-JSON coercion

`$runCommandRaw` runs the payload through `coerceExtendedJSON` from
`src/adapters/mongo/coerce.ts` before sending it to the driver. That
matches Prisma's old behaviour and means you can write pipeline
operands using extended-JSON markers:

```ts
await db.$runCommandRaw({
  aggregate: 'orders',
  cursor: {},
  pipeline: [
    { $match: { user_id: { $oid: '64f9e6c2…' } } },     // → ObjectId
    { $match: { placed_at: { $gte: { $date: '2026-01-01T00:00:00Z' } } } }, // → Date
  ],
});
```

The walker is single-key-aware — `{ $oid: 'abc…' }` becomes an
`ObjectId`, `{ $date: '…' }` becomes a `Date`, and Mongo aggregation
operators like `$match` (which always have non-string, multi-key
values) pass through untouched. You can hand it a payload you copied
from a `mongoexport` dump and it'll work.

### Worked example — `createIndexes` with collation

The typed index DSL on Mongo today doesn't expose collation. To create
a case-insensitive unique index on `users.email` you drop down:

```ts
await db.$runCommandRaw({
  createIndexes: 'users',
  indexes: [
    {
      key: { email: 1 },
      name: 'email_ci_unique',
      unique: true,
      collation: { locale: 'en', strength: 2 },  // strength 2 = case-insensitive
    },
  ],
});
```

The same command works for `expireAfterSeconds` TTL indexes, sparse
indexes with non-trivial `partialFilterExpression` operators, and
2dsphereVersion 3 indexes. `forge introspect` will pick up the
resulting index in subsequent `$diff` runs, but won't generate it from
schema until forge's typed API catches up.

---

## Returning shape and row typing

`$queryRaw<T = any>` is generic. The shape you pass is the shape you
get back — forge does no validation:

```ts
type UserRow = { id: string; email: string; active: boolean };
const rows = await db.$queryRaw<UserRow>`SELECT id, email, active FROM users`;
// rows is UserRow[]
```

The driver still returns whatever the database actually sent. Postgres
hands back `boolean` for a `boolean` column; MySQL hands back a
`Buffer` for a `BIT(1)`; SQLite hands back `0` or `1` because it has
no boolean type. The generic only types the value at the language
level — it doesn't insert a runtime coercion step. If the SQL projects
a column that doesn't exist, you'll get `undefined` at runtime even
though TypeScript thinks the field is non-optional.

Two practical guidelines:

1. **Match the shape to the projection.** Define `T` as the column
   list you're actually selecting. `SELECT *` is fine; just type `T`
   as the full row.
2. **Hand-coerce booleans on SQLite.** If you `SELECT active FROM
   users` on SQLite, `active` will be `0 | 1` at runtime. Either map
   it (`r.active === 1`) or `SELECT CASE active WHEN 1 THEN true ELSE
   false END AS active`.

For typed reads through forge's normal API, `Row<typeof Model>` (the
exported helper) gives you the inferred row shape. You can pair that
with `$queryRaw` when the projection matches:

```ts
import type { Row } from 'forge-orm';

const rows = await db.$queryRaw<Row<typeof User>>`SELECT * FROM users WHERE org_id = ${orgId}`;
// rows is the same shape db.user.findMany() returns — except no decoding pass.
```

The decoding pass is the thing to watch. `findMany` runs each row
through the model's `decodeOutbound` step (ObjectId → string, BSON
Date → JS Date, embedded subdocs hydrated). `$queryRaw` does not.
Match the `T` to the raw driver output, not the post-decode shape.

---

## Raw inside a `$transaction`

Calling `$queryRaw` / `$executeRaw` from inside `db.$transaction()`
works. The transaction wrapper rebuilds the proxy with the tx
`session` threaded through:

```ts
await db.$transaction(async (tx) => {
  const [user] = await tx.$queryRaw<{ id: string }>`
    INSERT INTO users (email, name) VALUES (${email}, ${name})
    RETURNING id
  `;
  await tx.$executeRaw`
    INSERT INTO audit_log (action, user_id) VALUES ('signup', ${user.id})
  `;
});
```

The internal route through `src/factory.ts`:

```
// Top-level call — checks out a connection from the pool per query.
key === '$queryRaw' → makeRawCaller((frag) => adapter.$queryRaw(frag));

// Inside the tx callback — pins the connection to the tx session.
key === '$queryRaw' → makeRawCaller((frag) => adapter.$queryRaw(frag, { session }));
```

That `{ session }` is whatever the adapter's `$transaction` impl
yielded — a `PgPoolClient` on Postgres, a `MysqlConnection` on MySQL,
the `SqliteDriver` itself on SQLite, a `mssql.Transaction` on MSSQL,
the `ClientSession` on Mongo. Both `tx.$queryRaw` and the typed
`tx.user.create()` calls share that session, so the writes commit
together.

The mistake to avoid: spinning up `db.$queryRaw` (top-level) inside a
`db.$transaction(...)` callback. That query goes through a different
connection, sees the pre-tx world, and won't see the tx's
uncommitted writes:

```ts
// BUG — db.$queryRaw uses a different connection from the tx.
await db.$transaction(async (tx) => {
  await tx.user.create({ data: { email: 'a@x.co', name: 'A' } });
  const seen = await db.$queryRaw`SELECT * FROM users WHERE email = 'a@x.co'`;
  // ↑ on Postgres, this sees nothing — uncommitted write isn't visible.
});
```

Always use the `tx` handle for everything inside the callback —
including raw.

The Mongo case is a quirk: replica-set transactions are required for
`$runCommandRaw` inside `tx`. Standalone `mongod` doesn't let
`db.command({...}, { session })` participate in a transaction; it'll
either ignore the session or throw `TransactionNotSupported`. Same
caveat the README's [Transactions chapter](../README.md#transactions)
calls out for typed writes.

---

## Postgres patterns

The Postgres adapter uses `pg`'s `Pool`/`PoolClient` (or
`postgres.js` via the pluggable driver), parameter style `$1, $2, $3`,
and gives you the full `RETURNING` / CTE / window machinery.

### Recursive CTE — comment tree

```ts
const tree = await db.$queryRaw<{ id: string; parent_id: string | null; depth: number }>`
  WITH RECURSIVE thread AS (
    SELECT id, parent_id, 0 AS depth
    FROM comments
    WHERE id = ${rootId}
    UNION ALL
    SELECT c.id, c.parent_id, t.depth + 1
    FROM comments c
    JOIN thread t ON c.parent_id = t.id
    WHERE t.depth < 10
  )
  SELECT * FROM thread ORDER BY depth, id
`;
```

The `depth < 10` guard caps the recursion so a cyclical edge doesn't
take down the database — Postgres won't help you here.

### `LATERAL` joins

`LATERAL` lets the right side of a join reference columns from the
left side. Useful for "top-N per group" without window functions:

```ts
const rows = await db.$queryRaw<{ org_id: string; post_id: string; title: string }>`
  SELECT o.id AS org_id, p.id AS post_id, p.title
  FROM orgs o
  LEFT JOIN LATERAL (
    SELECT id, title FROM posts WHERE org_id = o.id ORDER BY created_at DESC LIMIT 3
  ) p ON true
  WHERE o.tier = ${tier}
`;
```

### `WITH … RETURNING`

```ts
const inserted = await db.$queryRaw<{ id: string }>`
  WITH new_user AS (
    INSERT INTO users (email, name) VALUES (${email}, ${name})
    RETURNING id
  )
  INSERT INTO audit_log (action, user_id)
  SELECT 'signup', id FROM new_user
  RETURNING user_id AS id
`;
```

### `COPY FROM STDIN` via `pg-copy-streams`

`$executeRaw` can't stream — it's a single round trip. For bulk CSV
ingest you drop to the underlying driver. Forge exposes the adapter so
you can do that without leaving the connection pool:

```ts
import { from as copyFrom } from 'pg-copy-streams';
import { pipeline } from 'node:stream/promises';
import { createReadStream } from 'node:fs';

await db.$transaction(async (tx) => {
  // The adapter's pg client. Inside a tx this is the PoolClient.
  const client = (db.adapter as any).db;
  const ingest = client.query(copyFrom(`COPY users (email, name) FROM STDIN CSV`));
  await pipeline(createReadStream('users.csv'), ingest);
});
```

That's an escape hatch — it bypasses forge's query lifecycle events
and its error normalisation. Wrap the `pipeline` in a try/catch and
remap `pg` errors to `DbKnownError` yourself if your call site needs
the unified error shape.

### Advisory locks

`pg_try_advisory_xact_lock` returns true if the lock was acquired,
false if someone else holds it. The lock is released automatically at
the end of the transaction:

```ts
await db.$transaction(async (tx) => {
  const [{ got_lock }] = await tx.$queryRaw<{ got_lock: boolean }>`
    SELECT pg_try_advisory_xact_lock(${lockKey}) AS got_lock
  `;
  if (!got_lock) throw new Error('busy');
  // ... critical section ...
});
```

Use the session-scoped variant (`pg_try_advisory_lock`) outside a
transaction; release with `pg_advisory_unlock`. The xact variant is
safer in app code because the rollback path handles cleanup.

---

## MySQL patterns

The MySQL adapter uses `mysql2`'s promise pool, placeholder `?`, and
the usual MySQL surface.

### `INSERT … ON DUPLICATE KEY UPDATE`

Forge's typed `upsert` covers this on every dialect; reach for raw
when you need bulk upsert with one statement:

```ts
const rows = [
  ['a@x.co', 'A', 1],
  ['b@x.co', 'B', 1],
  ['c@x.co', 'C', 2],
];
await db.$executeRaw`
  INSERT INTO users (email, name, version)
  VALUES ${forgeSql.join(rows.map((r) => forgeSql.sql`(${r[0]}, ${r[1]}, ${r[2]})`), ', ')}
  ON DUPLICATE KEY UPDATE
    name = VALUES(name),
    version = VALUES(version)
`;
```

`VALUES(col)` in the `UPDATE` clause refers to the value the row
would have had on insert — that's MySQL-specific, no other dialect
uses it.

### `EXPLAIN ANALYZE`

Wrap any query to get the actual execution plan with timings:

```ts
const plan = await db.$queryRaw<{ EXPLAIN: string }>`
  EXPLAIN ANALYZE
  SELECT * FROM orders WHERE user_id = ${userId} AND placed_at > ${since}
`;
console.log(plan[0].EXPLAIN);
```

Useful when forge's typed query compiles to something subtly slow —
the plan tells you whether the predicate hit the index you expect.

### `FULLTEXT MATCH … AGAINST`

Forge's `searchable()` field type emits the `FULLTEXT` index for you.
For the query, the typed `search` operator does the basic case; raw
gets you boolean mode and the relevance score:

```ts
const rows = await db.$queryRaw<{ id: string; title: string; score: number }>`
  SELECT id, title,
    MATCH(title, body) AGAINST(${query} IN BOOLEAN MODE) AS score
  FROM articles
  WHERE MATCH(title, body) AGAINST(${query} IN BOOLEAN MODE)
  ORDER BY score DESC
  LIMIT 20
`;
```

Boolean mode supports the `+`, `-`, `*`, `"…"` operators. Natural
language mode (the default) ranks by relevance and discards short
words.

### CTEs in MySQL 8+

Same shape as Postgres, same syntax — `WITH RECURSIVE` works as of
MySQL 8.0.

---

## SQLite patterns

The SQLite adapter wraps `better-sqlite3` by default (or wasm /
`libsql` / `node:sqlite` via the pluggable driver). Placeholder `?`.

### `PRAGMA` — connection settings

PRAGMA isn't a typed-API thing. Use `$executeRaw`:

```ts
await db.$executeRaw`PRAGMA journal_mode = WAL`;
await db.$executeRaw`PRAGMA temp_store = MEMORY`;
await db.$executeRaw`PRAGMA synchronous = NORMAL`;
await db.$executeRaw`PRAGMA cache_size = -20000`;  // 20 MB page cache
```

`PRAGMA journal_mode = WAL` is the one that matters most — it turns
on write-ahead logging, which is what makes SQLite usable for
concurrent reader workloads. The pluggable wasm driver picks this up
automatically; the Node driver doesn't.

Some PRAGMAs return rows, not just status. Use `$queryRaw` for those:

```ts
const [{ journal_mode }] = await db.$queryRaw<{ journal_mode: string }>`
  PRAGMA journal_mode
`;
```

### `WITH RECURSIVE`

Same syntax as Postgres / MySQL 8. SQLite's recursive CTE is the
fastest portable way to flatten a hierarchy without N+1:

```ts
const subtree = await db.$queryRaw<{ id: string; parent_id: string | null }>`
  WITH RECURSIVE subtree AS (
    SELECT id, parent_id FROM orgs WHERE id = ${rootId}
    UNION ALL
    SELECT o.id, o.parent_id FROM orgs o
    JOIN subtree s ON o.parent_id = s.id
  )
  SELECT * FROM subtree
`;
```

### `ATTACH DATABASE`

Useful for one-shot data import from another SQLite file:

```ts
await db.$executeRaw`ATTACH DATABASE ${otherDbPath} AS source`;
await db.$executeRaw`
  INSERT INTO users (id, email, name)
  SELECT id, email, name FROM source.users
  WHERE NOT EXISTS (SELECT 1 FROM users u WHERE u.id = source.users.id)
`;
await db.$executeRaw`DETACH DATABASE source`;
```

ATTACH is per-connection; in a pool it'll only stick on the
connection that ran it. The default `better-sqlite3` adapter uses a
single connection, so this works; the wasm worker driver does too.

---

## DuckDB patterns

DuckDB's whole point is doing things SQL doesn't usually do — read
Parquet directly, query S3, compute window aggregates on millions of
rows in-process. Forge's typed surface covers tables; reach for raw
when you want the analytics moves.

### `READ_PARQUET` ingest

```ts
await db.$executeRaw`
  INSERT INTO events (org_id, kind, at)
  SELECT org_id, kind, at
  FROM read_parquet(${`s3://my-bucket/events/2026-06-*.parquet`})
  WHERE at >= ${cutoff}
`;
```

DuckDB infers the schema from the Parquet file. If your destination
table has stricter types (say, `org_id` is `VARCHAR NOT NULL`),
DuckDB will cast at read time or fail loudly.

### `COPY TO` — export to disk

```ts
await db.$executeRaw`
  COPY (SELECT * FROM events WHERE org_id = ${orgId})
  TO ${`/tmp/events-${orgId}.parquet`}
  (FORMAT PARQUET, COMPRESSION ZSTD)
`;
```

You're writing files on the DuckDB process's host. In production
that's the API node, so do this somewhere that won't fill the disk.

### `EXPORT DATABASE`

```ts
await db.$executeRaw`EXPORT DATABASE ${`/tmp/backup`} (FORMAT PARQUET)`;
```

Dumps every table to a directory of Parquet files. Pair with `IMPORT
DATABASE` to round-trip.

### `STRUCT` extraction

DuckDB has typed struct columns. Forge's `f.embed()` maps to a
`STRUCT`; extract individual fields with the dot operator:

```ts
const rows = await db.$queryRaw<{ id: string; lat: number; lng: number }>`
  SELECT id, location.lat AS lat, location.lng AS lng FROM places
`;
```

That works for any `f.embed()` field where you want a flat
projection.

---

## MSSQL patterns

The MSSQL adapter uses the `mssql` package. Forge compiles to `$1, $2`
placeholders and the wrapper rewrites them to the driver's `@pN`
form. As of 2.5.0, `MERGE` is the upsert path — both for the typed
`upsert()` call and as the recommended raw shape.

### `MERGE` — upsert

```ts
await db.$executeRaw`
  MERGE INTO items AS tgt
  USING (VALUES (${sku}, ${name}, ${qty})) AS src(sku, name, qty)
    ON tgt.sku = src.sku
  WHEN MATCHED THEN
    UPDATE SET qty = src.qty
  WHEN NOT MATCHED THEN
    INSERT (sku, name, qty) VALUES (src.sku, src.name, src.qty);
`;
```

The typed `upsert()` emits the same shape — see the
[2.5.0 CHANGELOG entry](../CHANGELOG.md#250--mssql-merge-upsert-mongo-cross-field-nearto-browser-doctordiff-multipolygon--geometrycollection-3d--z-coordinates-non-wgs84-srids).
Use the raw form when you want extra `WHEN MATCHED AND <pred>`
branches or you're merging from a derived table the typed API can't
build.

### `OPENJSON` — destructure a JSON column

```ts
const rows = await db.$queryRaw<{ id: string; tag: string }>`
  SELECT u.id, t.tag
  FROM users u
  CROSS APPLY OPENJSON(u.meta, '$.tags') WITH (tag NVARCHAR(64) '$') t
`;
```

`OPENJSON` is the MSSQL way to turn a JSON array into rows. The `WITH`
clause types each extracted field.

### `FOR JSON PATH` — serialise

```ts
const [{ payload }] = await db.$queryRaw<{ payload: string }>`
  SELECT u.id, u.email, (SELECT p.id, p.title FROM posts p WHERE p.author_id = u.id FOR JSON PATH) AS posts
  FROM users u
  WHERE u.id = ${userId}
  FOR JSON PATH, WITHOUT_ARRAY_WRAPPER
`;
const userWithPosts = JSON.parse(payload);
```

Useful when you want a single round-trip for a nested response and
you don't want to spin up forge's typed `include`.

### Table-valued parameters

MSSQL's TVPs need the driver's `Table` type, which forge's raw
compiler can't construct — TVPs aren't just bound values, they're a
typed BSON-like envelope. For a TVP, drop to the driver:

```ts
const sql = (db.adapter as any).driver.handle();
const table = new sql.Table('UserIdList');
table.columns.add('id', sql.VarChar(40), { nullable: false });
for (const id of ids) table.rows.add(id);

const req = sql.request();
req.input('ids', table);
await req.query(`DELETE FROM users WHERE id IN (SELECT id FROM @ids)`);
```

Same escape-hatch caveat as the `pg-copy-streams` case — you're
bypassing forge's query events and error normalisation.

---

## Mongo aggregation pipeline

For Mongo, raw isn't `$queryRaw`. Two surfaces cover the gap:

1. **`db.<model>.aggregate({ pipeline })`** — the typed wrapper.
   Covers `$match` / `$group` / `$project` / `$sort` / `$limit` /
   `$skip` / `$lookup` / `$unwind` / common accumulators. Returns
   decoded rows.
2. **`db.$runCommandRaw({ aggregate, pipeline, cursor })`** — the
   BSON channel. Use it when the pipeline needs operators the typed
   API doesn't model.

### `$graphLookup` for org hierarchy

`$graphLookup` is the recursive descent that Mongo's typed pipeline
DSL in forge doesn't surface. Drop down:

```ts
const out = await db.$runCommandRaw({
  aggregate: 'orgs',
  cursor: {},
  pipeline: [
    { $match: { _id: { $oid: rootId } } },
    {
      $graphLookup: {
        from: 'orgs',
        startWith: '$_id',
        connectFromField: '_id',
        connectToField: 'parent_id',
        as: 'descendants',
        maxDepth: 10,
        depthField: 'depth',
      },
    },
  ],
});
const descendants = out.cursor.firstBatch[0].descendants;
```

The `{ $oid: rootId }` form gets coerced to an `ObjectId` by the
extended-JSON pre-pass.

### `$function` — server-side JS

For any computation that can't be expressed as Mongo operators:

```ts
await db.$runCommandRaw({
  aggregate: 'orders',
  cursor: {},
  pipeline: [
    {
      $addFields: {
        priceWithTax: {
          $function: {
            body: 'function(p, taxRate) { return Math.round(p * (1 + taxRate) * 100) / 100; }',
            args: ['$price', 0.075],
            lang: 'js',
          },
        },
      },
    },
  ],
});
```

`$function` requires `enableServerSideJS` on the server — Atlas
shared tiers don't expose it. Use sparingly; the JS interpreter is
not fast and not parallelised.

---

## Safety rules

The escape hatch is genuinely escape hatch. The typed API takes care
of identifier quoting, value coercion, dialect-specific operator
shapes, and the four or five other things that make a SQL query
correct. Raw doesn't. The rules below keep it survivable.

1. **Never interpolate untrusted strings as identifiers.** Values are
   parameterised. Identifiers aren't. If the column / table name
   comes from a request, run it through a whitelist that returns a
   `SqlFragment` and use that fragment in the template.
2. **`forgeSql.raw()` is constants-only.** It emits its argument
   literally. Anything you pass that touches user input is a SQL
   injection.
3. **Don't catch errors mid-transaction on Postgres.** Postgres
   marks the whole transaction failed after any error. The next
   statement throws "current transaction is aborted." The
   [Transactions chapter](../README.md#transactions) calls this out
   for typed queries; the same applies to raw.
4. **Check the result size before `.map(...)`.** `$queryRaw` returns
   whatever the database produces. A wrong `WHERE` clause that scans
   the whole table will allocate a JS array for the entire result
   set. Bound your queries with `LIMIT` / `TOP` / `FETCH NEXT N
   ROWS` if there's any chance the bound count is unbounded.
5. **Match the projection to `T`.** `$queryRaw<UserRow>` types the
   return value as `UserRow[]`. If the projection is wrong,
   TypeScript thinks you have a field you don't. Either project
   every column in the type (and `SELECT *`) or list each column
   you select in the SQL.
6. **No `decodeOutbound`.** Raw rows are the driver's output. On
   SQLite, booleans are `0/1`. On MySQL `BIT(1)` is a `Buffer`. On
   Mongo, `ObjectId` round-trips through the BSON BSONType. Hand-coerce
   per dialect, or stick with typed reads when the model's full
   decode is what you want.
7. **Don't leak the driver handle.** The escape-hatch examples that
   reach into `(db.adapter as any).db` work, but they bypass query
   events, error normalisation, and the connection pool's tx
   handle. Treat those as "I know what I'm doing" code paths and
   wrap them in your own error mapping.

---

## Six worked patterns

### (a) Recursive comment tree — Postgres `WITH RECURSIVE`

```ts
type ThreadRow = { id: string; parent_id: string | null; body: string; depth: number };

const thread = await db.$queryRaw<ThreadRow>`
  WITH RECURSIVE thread AS (
    SELECT id, parent_id, body, 0 AS depth
    FROM comments
    WHERE id = ${rootId}
    UNION ALL
    SELECT c.id, c.parent_id, c.body, t.depth + 1
    FROM comments c
    JOIN thread t ON c.parent_id = t.id
    WHERE t.depth < ${maxDepth}
  )
  SELECT id, parent_id, body, depth
  FROM thread
  ORDER BY depth ASC, id ASC
`;
```

`depth < maxDepth` is a guard against cyclic edges, not just a depth
cap. Postgres will recurse forever otherwise. Set `maxDepth` to a
hard limit (10–20) even if your data model says cycles are
impossible.

### (b) Top N per group — window function

```ts
type Row = { user_id: string; post_id: string; title: string; r: number };

const top = await db.$queryRaw<Row>`
  WITH ranked AS (
    SELECT
      author_id AS user_id,
      id AS post_id,
      title,
      RANK() OVER (PARTITION BY author_id ORDER BY views DESC) AS r
    FROM posts
    WHERE org_id = ${orgId}
  )
  SELECT user_id, post_id, title, r FROM ranked WHERE r <= ${perUser}
`;
```

`RANK()` ties go to the next gap (1, 2, 2, 4). Use `ROW_NUMBER()` if
you want a strict top-N regardless of ties. Works on Postgres,
MySQL 8+, MSSQL, SQLite 3.25+, DuckDB.

### (c) Bulk update from CSV — Postgres `COPY FROM STDIN`

```ts
import { from as copyFrom } from 'pg-copy-streams';
import { pipeline } from 'node:stream/promises';
import { createReadStream } from 'node:fs';

await db.$transaction(async (tx) => {
  // Stage rows into a TEMP table.
  await tx.$executeRaw`CREATE TEMP TABLE _stage (sku text PRIMARY KEY, qty int) ON COMMIT DROP`;

  const pgClient = (db.adapter as any).db;          // PoolClient on this tx.
  const ingest = pgClient.query(copyFrom(`COPY _stage (sku, qty) FROM STDIN CSV`));
  await pipeline(createReadStream(csvPath), ingest);

  // Merge into the real table.
  await tx.$executeRaw`
    UPDATE inventory i SET qty = s.qty
    FROM _stage s WHERE i.sku = s.sku
  `;
});
```

The whole thing is one transaction — if the COPY fails or the merge
errors, neither side commits. The `_stage` table is dropped on
commit.

### (d) MySQL FULLTEXT with relevance score

```ts
type Hit = { id: string; title: string; score: number };

const hits = await db.$queryRaw<Hit>`
  SELECT id, title,
    MATCH(title, body) AGAINST(${query} IN BOOLEAN MODE) AS score
  FROM articles
  WHERE org_id = ${orgId}
    AND MATCH(title, body) AGAINST(${query} IN BOOLEAN MODE)
  ORDER BY score DESC
  LIMIT ${pageSize}
`;
```

Pair with forge's `f.text().searchable()` on the schema side — that's
what emits the `FULLTEXT(title, body)` index in the first place.

### (e) DuckDB Parquet ingest

```ts
const inserted = await db.$executeRaw`
  INSERT INTO events (org_id, kind, at, payload)
  SELECT
    org_id,
    kind,
    at,
    payload
  FROM read_parquet(${`s3://logs-prod/events/${day}/*.parquet`})
  WHERE at >= ${cutoff}
    AND org_id = ${orgId}
`;
// inserted is the row count.
```

DuckDB will push the predicate down into the Parquet read where it
can — column min/max statistics in the Parquet footer let it skip
files entirely. For S3, set `httpfs` credentials via
``db.$executeRaw`SET s3_region = 'us-east-1'``` first.

### (f) Mongo `$graphLookup` — org hierarchy traversal

```ts
const out = await db.$runCommandRaw({
  aggregate: 'orgs',
  cursor: {},
  pipeline: [
    { $match: { _id: { $oid: rootOrgId } } },
    {
      $graphLookup: {
        from: 'orgs',
        startWith: '$_id',
        connectFromField: '_id',
        connectToField: 'parent_id',
        as: 'descendants',
        maxDepth: 10,
        depthField: 'depth',
      },
    },
    { $project: { _id: 0, descendants: 1 } },
  ],
});

const descendants: { _id: any; depth: number; name: string }[] =
  out.cursor.firstBatch[0]?.descendants ?? [];
```

The `cursor: {}` is required — it tells Mongo to return a cursor
rather than a single result document. Pull the first batch from
`out.cursor.firstBatch`; for large result sets, iterate the cursor
ID with `getMore` commands.

---

## Integrating raw with typed reads

Three integration shapes worth a mention.

### 1. Raw read, typed write

Drop to raw for the query (`WITH RECURSIVE`, window function,
something forge's `findMany` doesn't cover), keep the writes typed.
This is the common case. The typed write does default coercion,
runs query events, and gets normalised errors — none of which `$queryRaw`
does for you.

```ts
const ids = await db.$queryRaw<{ id: string }>`
  WITH stale AS (
    SELECT id FROM tokens WHERE last_used < ${cutoff} ORDER BY last_used LIMIT 1000
  )
  SELECT id FROM stale
`;
await db.token.deleteMany({ where: { id: { in: ids.map((r) => r.id) } } });
```

### 2. Typed read, raw write

The other way round when the query is shaped like a typed
`findMany` but the write needs SQL that doesn't fit the API. For
example, an `UPDATE … FROM` join on Postgres:

```ts
const users = await db.user.findMany({ where: { org_id: orgId, churned: false } });
await db.$executeRaw`
  UPDATE users u
  SET active = false
  FROM (VALUES ${forgeSql.join(users.map((u) => forgeSql.sql`(${u.id})`), ', ')}) AS s(id)
  WHERE u.id = s.id
`;
```

### 3. Same row shape both sides

When the raw query projects the full row, you can borrow the typed
shape:

```ts
import type { Row } from 'forge-orm';

const users = await db.$queryRaw<Row<typeof User>>`
  SELECT * FROM users WHERE org_id = ${orgId} AND last_seen > ${since}
`;
// users is the same shape db.user.findMany(...) returns — minus the decode pass.
```

The catch is the decode pass. `findMany` runs each row through
`decodeOutbound`, which on Mongo turns `ObjectId` into `string` and
on every dialect hydrates `f.embed()` subdocs. `$queryRaw` skips
that. If your model has embedded structs or `ObjectId` columns, the
runtime shape is the driver's, not the post-decode shape, and the
type assertion will lie. Either keep raw away from those models, or
hand-decode the rows on the way out.

---

The escape hatch is small on purpose. Most app SQL fits inside
forge's typed surface; the rest fits inside one of the patterns
above. If you're reaching for raw on every query, that's usually a
signal that the typed API is missing something — file it as an
issue with the SQL you'd want forge to emit, and the typed surface
grows that way.
