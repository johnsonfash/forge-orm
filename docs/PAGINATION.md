# Pagination

The four shapes — offset, cursor/keyset, numbered pages, infinite-scroll — their performance characteristics, and what forge-orm exposes for each. Cursor pagination is the right default for almost everything; this page also covers total-count strategies, Relay/REST response shapes, and per-dialect behavior under load.

[Queries deep-dive](./QUERIES.md#pagination--offset-vs-cursor) sketches
the cursor API in two paragraphs. This doc is the full reference: every
shape with its failure mode, the per-dialect emit forge actually
produces, how cursors interact with sort keys / filters / soft-delete,
and the response envelopes you wrap them in at the HTTP and GraphQL
boundaries.

## Contents

* [The four shapes — at a glance](#the-four-shapes--at-a-glance)
* [Offset (`take` + `skip`) — and why it stops scaling](#offset-take--skip--and-why-it-stops-scaling)
* [Cursor — forge's `cursor` + `take`](#cursor--forges-cursor--take)
* [Keyset — the raw SQL form](#keyset--the-raw-sql-form)
* [Numbered pages — when you actually need them](#numbered-pages--when-you-actually-need-them)
* [Total count strategies](#total-count-strategies)
* [Bidirectional cursors — `take: -N`](#bidirectional-cursors--take--n)
* [Sort + cursor — stable keys and tie-breakers](#sort--cursor--stable-keys-and-tie-breakers)
* [`cursorAll` vs `cursorSnapshot` — consistency under writes](#cursorall-vs-cursorsnapshot--consistency-under-writes)
* [GraphQL Relay connection mapping](#graphql-relay-connection-mapping)
* [REST response shapes — body, headers, Link](#rest-response-shapes--body-headers-link)
* [Infinite-scroll UX with TanStack Query](#infinite-scroll-ux-with-tanstack-query)
* [Pagination + filters — invalidation and filter-hashed cursors](#pagination--filters--invalidation-and-filter-hashed-cursors)
* [Pagination + soft-delete](#pagination--soft-delete)
* [Per-dialect pagination](#per-dialect-pagination)
* [Three worked examples](#three-worked-examples)
* [Common bugs](#common-bugs)
* [See also](#see-also)

---

## The four shapes — at a glance

| Shape | API surface | Cost on page N | Stable under writes | Random access | Best for |
|---|---|---|---|---|---|
| Offset | `take` + `skip` | `O(N × pageSize)` | No | Yes | Stable historical data, admin reports |
| Cursor (keyset) | `cursor` + `take` | `O(pageSize)` | Yes | No | Feeds, infinite scroll, realtime lists |
| Numbered pages | `take` + `skip` + `count` | Offset cost **plus** `COUNT(*)` | No | Yes — jump-to-page | Small admin tables (< ~100k rows) |
| Infinite-scroll / load-more | Cursor under a UI veneer | `O(pageSize)` per `fetchNextPage` | Yes | No | Mobile feeds, search results |

"Best default" is cursor. The rest are special cases.

The performance gap is not theoretical. On Postgres the planner reads
and discards every skipped row before returning the first row of the
page — `OFFSET 10000 LIMIT 20` reads 10020 rows. The same query under a
keyset cursor reads 20 rows. By page 500 the offset form is 500× slower
than the cursor form on the same index, and the difference is
wall-clock time the user is staring at.

---

## Offset (`take` + `skip`) — and why it stops scaling

The classic form. `LIMIT` + `OFFSET` plus an `ORDER BY` to make the
boundaries deterministic.

```ts
await db.post.findMany({
  where:   { status: 'PUBLISHED' },
  orderBy: { created_at: 'desc' },
  take:    20,
  skip:    40,                         // page 3 of 20-row pages
});
```

Per-dialect emit:

| Dialect | Emit |
|---|---|
| Postgres | `... ORDER BY "created_at" DESC LIMIT 20 OFFSET 40` |
| MySQL | `` ... ORDER BY `created_at` DESC LIMIT 20 OFFSET 40 `` |
| SQLite | `... ORDER BY "created_at" DESC LIMIT 20 OFFSET 40` |
| DuckDB | `... ORDER BY "created_at" DESC LIMIT 20 OFFSET 40` |
| MSSQL | `... ORDER BY "created_at" DESC OFFSET 40 ROWS FETCH NEXT 20 ROWS ONLY` |
| Mongo | `.find(filter).sort([['created_at', -1]]).skip(40).limit(20)` |

Two distinct failure modes. **Cost scales with `OFFSET`** — every
engine implements OFFSET as "read the first N rows from the ordered
result and throw them away". Two thousand reads per page is fine;
twenty thousand is the whole latency budget. On a 100k-row table users
will hit pages where the response takes seconds. **Non-stable under
concurrent writes** — offset addresses rows by position, not identity.
A new row arriving between page loads bumps every offset by one and the
user sees the last row of page 2 again at the top of page 3. Or a row
gets skipped entirely.

Use offset when the result set is stable for the session (admin reports
against historical data), the dataset is small enough that `OFFSET
1000` is not a latency problem, you need jump-to-page and the cost is
acceptable, or duplicates and skips are acceptable (audit logs the
user is scrolling, not selecting). For anything else, reach for cursor.

---

## Cursor — forge's `cursor` + `take`

Cursor pagination addresses the boundary by **row identity**, not
position. The next page is "rows whose ordered key is after this row's
ordered key", which compiles to an index range scan — sargable on every
dialect.

```ts
const page1 = await db.post.findMany({
  where: { status: 'PUBLISHED' }, orderBy: { id: 'asc' }, take: 20,
});
const page2 = await db.post.findMany({
  where: { status: 'PUBLISHED' }, orderBy: { id: 'asc' }, take: 20,
  cursor: { id: page1.at(-1)!.id }, skip: 1,    // skip the cursor row itself
});
```

The IR emits a half-open inequality on the cursor key. On PG with
`orderBy: { id: 'asc' }`:

```sql
SELECT … FROM "post"
WHERE "status" = $1 AND "id" > $2
ORDER BY "id" ASC LIMIT 20;
```

That `"id" > $2` is sargable on the primary key index. The page is
`O(pageSize)` regardless of how deep the user has scrolled — no skipped
rows, no boundary drift under writes, no `COUNT(*)` round-trip.

`cursor` accepts a unique-by selector — `{ id }`, anything declared
`.unique()`, or a compound-unique key. Forge validates this at build
time the same way `findUnique` does; passing a non-unique field throws.

`skip: 1` is the usual partner. Forge uses the inclusive form under the
hood (so you can resume from a cursor that no longer exists) and
`skip: 1` peels the duplicate off when you have the cursor row in
hand.

The trade-off is no random access — no "page 47" because there is no
notion of position. The UI either pages forward / back from a known
cursor, or it gives up the requirement.

---

## Keyset — the raw SQL form

"Cursor pagination" and "keyset pagination" are the same idea — the
forge `cursor` API is a typed wrapper on the keyset technique. When you
drop to `$queryRaw` (recursive CTEs, window functions), the pattern is:

```sql
-- pageSize = 20, lastSeen = (createdAt, id) of the previous page's last row
SELECT id, title, created_at
FROM post
WHERE status = $1
  AND (created_at, id) < ($lastCreatedAt, $lastId)
ORDER BY created_at DESC, id DESC
LIMIT 20;
```

The composite tuple `(created_at, id)` is the keyset; the comparison is
the boundary. The trailing `id` is the tie-breaker — `created_at` alone
is not unique, so without `id` the page boundary is ambiguous when two
posts share a timestamp.

Per-dialect emit of the tuple form:

| Dialect | Emit |
|---|---|
| Postgres | `("created_at", "id") < ($1, $2)` — true row-value compare |
| SQLite | `("created_at", "id") < (?, ?)` — supported since 3.15 |
| DuckDB | `("created_at", "id") < ($1, $2)` |
| MySQL | `("created_at", "id") < (?, ?)` — supported since 5.7 |
| MSSQL | Not supported. Expanded to `("created_at" < @p1 OR ("created_at" = @p1 AND "id" < @p2))` |
| Mongo | Not supported. Expanded to `{ $or: [{ created_at: { $lt: a } }, { $and: [{ created_at: a }, { id: { $lt: b } }] }] }` |

The expanded form is more verbose but the planner sees the same range
scan on every dialect — **provided** you have a compound index on
`(created_at, id)`. Without it the OR-of-AND form falls back to a
sequential scan and the page-N pattern is as slow as offset. See
[INDEXES](./INDEXES.md#2-plain-b-tree) for the declaration:

```ts
const post = f.model('post', { /* … */ }, {
  indexes: [{ fields: ['created_at', 'id'] }],
});
```

Leading column matches the leading `orderBy` key. Putting `id` first
would not help — the range scan needs `created_at` first to be
selective.

---

## Numbered pages — when you actually need them

Some surfaces genuinely require numbered pagination — admin tables
where "page 47 of 312" is a legitimate affordance, exports where the
user needs a deterministic position.

```ts
const PAGE_SIZE = 25;

async function adminUsersPage(pageNum: number) {
  const [rows, total] = await Promise.all([
    db.user.findMany({
      orderBy: { created_at: 'desc' },
      take:    PAGE_SIZE,
      skip:    (pageNum - 1) * PAGE_SIZE,
    }),
    db.user.count(),
  ]);

  return {
    rows,
    pageInfo: {
      page:        pageNum,
      pageSize:    PAGE_SIZE,
      totalRows:   total,
      totalPages:  Math.ceil(total / PAGE_SIZE),
      hasPrevPage: pageNum > 1,
      hasNextPage: pageNum * PAGE_SIZE < total,
    },
  };
}
```

Works when:

- The total is small enough that `OFFSET` stays sub-millisecond
  (rule of thumb: under 50k rows, or under 5k with a heavy projection).
- The user genuinely needs to know how many pages there are.
- Drift between page loads is acceptable.

Past those limits, switch to cursor and drop the page numbers.

---

## Total count strategies

The `COUNT(*)` query that fills the "of ???" half of "page 47 of ???"
is its own performance story. Four strategies, in order of preference.

**1. Exact count via `db.x.count()`.**

```ts
const total = await db.user.count({ where: { active: true } });
```

PG / MySQL / SQLite / DuckDB / MSSQL emit `SELECT COUNT(*) FROM "user" WHERE …`.
Mongo uses `countDocuments`. Cost scales with the result set; on a 10M
row table the count itself is the slow request. Always run `count` and
`findMany` in parallel — most ORMs serialise them and double latency:

```ts
const [rows, total] = await Promise.all([
  db.user.findMany({ where, take: 25, skip: page * 25 }),
  db.user.count({ where }),
]);
```

**2. Estimated count from `pg_class.reltuples` (Postgres).** For
unfiltered or very common-filter counts on huge tables, the planner
estimate is the difference between "loads in 2 ms" and "loads in 800
ms".

```ts
const [{ estimate }] = await db.$queryRaw<{ estimate: number }[]>`
  SELECT reltuples::bigint AS estimate
  FROM pg_class WHERE relname = 'user';
`;
```

Updated by autovacuum + `ANALYZE`; wrong by up to a few percent on a
busy table. For "about 12,000 users" precision is more than enough.

DuckDB exposes `duckdb_tables`; MySQL has
`INFORMATION_SCHEMA.TABLES.TABLE_ROWS` (also estimated); SQLite has no
equivalent. For *filtered* PG estimates wrap the query in
`EXPLAIN (FORMAT JSON)` and read the `Plan Rows` field — the trick
GitLab and Discourse use for huge filtered counts.

**3. Cached count.** For totals that change slowly relative to the read
rate, cache and invalidate on writes. For tenanted counts, hook into
model events ([EVENTS](./EVENTS.md)) and increment / decrement:

```ts
db.$on('user.created',     ({ org_id }) => cache.incr(`count:user:${org_id}`));
db.$on('user.softDeleted', ({ org_id }) => cache.decr(`count:user:${org_id}`));
```

The cached value drifts under cache-miss scenarios — refresh on a
schedule to bound the drift. Billing surfaces should always do the
live count.

**4. The "is there a next page?" shortcut.** Cursor pages do not need a
total — `hasNextPage` only needs to know whether *any* row exists
beyond the current page. Read one extra row past the page size:

```ts
const PAGE_SIZE = 20;
const rows = await db.post.findMany({
  where,
  orderBy: { id: 'asc' },
  take:    PAGE_SIZE + 1,              // ask for one extra
  ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
});

const hasNextPage = rows.length > PAGE_SIZE;
const visible     = rows.slice(0, PAGE_SIZE);
const nextCursor  = hasNextPage ? visible[PAGE_SIZE - 1].id : null;
```

That extra row is one index read; `COUNT(*)` over the same filter is
potentially every index read.

---

## Bidirectional cursors — `take: -N`

`take` accepts a negative value. The result is the previous page
relative to the cursor — same boundary, opposite direction. The
compiler flips the predicate (`< $cursor`), flips the `ORDER BY`, and
re-reverses the result array so the caller sees rows in the original
sort order.

```ts
await db.post.findMany({
  orderBy: { id: 'asc' },
  take:    -20,
  cursor:  { id: lastSeenId },
  skip:    1,
});
```

For a feed with up and down arrows, carry two cursors —
`firstCursor` and `lastCursor`. "Next page" is
`cursor: { id: lastCursor }, skip: 1, take: PAGE_SIZE + 1`; "previous"
is `cursor: { id: firstCursor }, skip: 1, take: -(PAGE_SIZE + 1)`.
`hasNextPage` and `hasPrevPage` come from the extra-row trick in both
directions.

Mongo does not support negative `take` natively — the adapter reverses
the sort and re-reverses the result in code. Cost on a covered sort is
identical, but the cursor stage reads in the opposite direction.

---

## Sort + cursor — stable keys and tie-breakers

The single most common cursor bug is "the sort key is not unique and
the cursor is not stable". A cursor on `created_at` alone duplicates or
skips rows whenever two rows share a timestamp — and on a busy table
they will.

**The rule.** The cursor key must be unique. If the visible sort key is
not unique, pair it with a unique tie-breaker (almost always `id`) and
use a **single-column** cursor on `id` with a **multi-column**
`orderBy`:

```ts
await db.post.findMany({
  orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
  take:    20,
  cursor:  { id: lastSeenId },
  skip:    1,
});
```

Forge translates this on PG/SQLite/DuckDB/MySQL to the tuple form;
on MSSQL/Mongo to the expanded OR-of-AND form. Either way the compound
index on `(created_at, id)` makes the range scan covered.

**Compound cursor.** When the unique key is itself compound —
`(user_id, video_id)` on a `watched` table — pass the whole key:

```ts
await db.watched.findMany({
  orderBy: [{ watched_at: 'desc' }, { user_id: 'asc' }, { video_id: 'asc' }],
  take:    50,
  cursor:  { user_id_video_id: { user_id: 'u1', video_id: 'v9' } },
  skip:    1,
});
```

The compound-unique selector must match a `unique` constraint declared
on the model — same rule as `findUnique`.

**Sorting on a relation field.** `orderBy: { author: { name: 'asc' } }`
is documented at the README surface but the IR builder silently drops
it today (same gap as in
[QUERIES](./QUERIES.md#orderby--single-multi-relation-_count-nulls)).
Denormalise the sort key onto the row or fall back to `$queryRaw`.

---

## `cursorAll` vs `cursorSnapshot` — consistency under writes

Cursor pagination is stable under writes for the **boundary**. The
question is what guarantee you want for the rows *between* boundaries.

**`cursorAll` — see writes as they happen.** The default. Each page is
a fresh `findMany` against current data. Rows inserted between page 1
and page 2 will appear on subsequent visits to page 1, but not
retroactively on page 2. Use for feeds, search, anything where
freshness is the desired behaviour.

**`cursorSnapshot` — fix the result set at session start.** Some
surfaces (data exports, paginated batch jobs, "back" navigation on
search results) want the page set fixed at the moment the first page
is fetched. Capture a timestamp on first request, round-trip it through
each subsequent page (in the URL, query params, or cursor blob), and
apply it as a filter:

```ts
const snapshotAt = new Date();
const where = { created_at: { lte: snapshotAt } };

const p1 = await db.post.findMany({ where, orderBy, take: 20 });
const p2 = await db.post.findMany({
  where, orderBy, take: 20,
  cursor: { id: p1.at(-1)!.id }, skip: 1,
});
```

The `created_at <= snapshotAt` filter freezes the result set against
inserts. For delete stability, soft delete is the answer (see
[Pagination + soft-delete](#pagination--soft-delete)). Hard-deleted
rows simply disappear and there is no per-row way to keep them in a
snapshot. Forge does not expose a built-in `cursorSnapshot` mode — it
is a pattern over `findMany`, not a separate call.

---

## GraphQL Relay connection mapping

The Relay cursor connection spec is the canonical GraphQL pagination
shape — `edges { cursor node }`, `pageInfo { hasNextPage hasPreviousPage startCursor endCursor }`,
and the `first / after / last / before` argument quartet. It maps
cleanly onto forge cursors.

```ts
async function postsResolver(_: unknown, args: {
  first?: number; after?:  string;
  last?:  number; before?: string;
}) {
  const PAGE_SIZE = args.first ?? args.last ?? 20;
  const forward   = args.last == null;
  const opaque    = forward ? args.after : args.before;
  const cursor    = opaque ? decodeCursor(opaque) : undefined;

  const rows = await db.post.findMany({
    orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
    take:    forward ? PAGE_SIZE + 1 : -(PAGE_SIZE + 1),
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
  });

  const hasMore = rows.length > PAGE_SIZE;
  const visible = rows.slice(0, PAGE_SIZE);
  return {
    edges: visible.map(p => ({ cursor: encodeCursor(p.id), node: p })),
    pageInfo: {
      hasNextPage:     forward  ? hasMore : Boolean(args.after),
      hasPreviousPage: !forward ? hasMore : Boolean(args.before),
      startCursor: visible.length ? encodeCursor(visible[0].id)        : null,
      endCursor:   visible.length ? encodeCursor(visible.at(-1)!.id)   : null,
    },
  };
}

const encodeCursor = (id: string) => Buffer.from(id).toString('base64');
const decodeCursor = (c:  string) => Buffer.from(c, 'base64').toString();
```

The cursor is an opaque base64 string from the client's perspective —
the Relay convention. If you ever need to switch from `id`-cursor to a
compound `(created_at, id)`-cursor, encode a JSON blob inside the
base64 and clients see the same opaque string. `totalCount` is optional
in the Relay spec; set it only when the UI needs it.

---

## REST response shapes — body, headers, Link

Three patterns are common; pick one and stick to it across the API.

**1. Cursor in the body (recommended default).** Self-describing, no
header inspection, works through proxies that strip headers. Mirrors
the GraphQL connection shape so client code is uniform.

```json
{ "data": [ ... ], "pageInfo": { "hasNextPage": true, "hasPreviousPage": false, "nextCursor": "abc123", "prevCursor": null } }
```

```ts
async function listPosts(req: Request, res: Response) {
  const PAGE_SIZE = 20;
  const after = req.query.after as string | undefined;

  const rows = await db.post.findMany({
    where:   { status: 'PUBLISHED' },
    orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
    take:    PAGE_SIZE + 1,
    ...(after ? { cursor: { id: after }, skip: 1 } : {}),
  });

  const hasNext = rows.length > PAGE_SIZE;
  const visible = rows.slice(0, PAGE_SIZE);

  res.json({
    data: visible,
    pageInfo: {
      hasNextPage: hasNext,
      hasPreviousPage: Boolean(after),
      nextCursor: hasNext ? visible.at(-1)!.id : null,
      prevCursor: after   ? visible[0]?.id     : null,
    },
  });
}
```

**2. `Link` header (RFC 5988, GitHub-style).** `Link: <…?after=abc123>; rel="next", <…?before=xyz789>; rel="prev"`
plus `X-Total-Count: 12483`. HATEOAS — the client follows hrefs without
knowing the cursor format. Downsides: header parsing is annoying, some
proxies strip non-standard headers, many clients ignore Link and read
the body anyway.

**3. Page number in the body (numbered pages).** `{ data, pageInfo: { page, pageSize, totalRows, totalPages } }`.
Only when you really need numbered pages.

**Cursor opacity.** Raw id is simplest but anyone who knows your id
format can synthesise cursors. Base64 JSON is opaque and easy to evolve
(add fields). Signed JWT is tamper-proof — use when the cursor encodes
filter state the client must not modify.

---

## Infinite-scroll UX with TanStack Query

`useInfiniteQuery` from TanStack Query is the canonical client-side
shape. The forge cursor maps to `pageParam`:

```tsx
'use client';
import { useInfiniteQuery } from '@tanstack/react-query';
import { getDb } from '@/db';

export function PostFeed({ orgId }: { orgId: string }) {
  const q = useInfiniteQuery({
    queryKey: [orgId, 'post', 'feed'],
    initialPageParam: undefined as string | undefined,
    queryFn: async ({ pageParam }) => {
      const db = await getDb();
      const rows = await db.post.findMany({
        where:   { org_id: orgId, status: 'PUBLISHED', deleted_at: null },
        orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
        take:    21,                     // 20 + 1 for hasNext
        ...(pageParam ? { cursor: { id: pageParam }, skip: 1 } : {}),
      });
      const hasNext = rows.length > 20;
      const visible = rows.slice(0, 20);
      return { rows: visible, nextCursor: hasNext ? visible[19].id : undefined };
    },
    getNextPageParam: (p) => p.nextCursor,
  });

  return (
    <>
      {q.data?.pages.flatMap(p => p.rows).map(p => <PostCard key={p.id} post={p} />)}
      {q.hasNextPage && (
        <button onClick={() => q.fetchNextPage()} disabled={q.isFetchingNextPage}>
          {q.isFetchingNextPage ? 'Loading…' : 'Load more'}
        </button>
      )}
    </>
  );
}
```

See [React patterns](./REACT.md#search-as-you-type-with-debounce--cursor-pagination)
for the search-as-you-type variant with `useDeferredValue` +
`useTransition`.

For "auto-load on scroll-to-bottom", wire an intersection observer to
`fetchNextPage` and throttle aggressively — without it, fast scrolls
trigger multiple page loads before the first one resolves.

---

## Pagination + filters — invalidation and filter-hashed cursors

Cursors are stable under writes. They are **not** stable under filter
changes — a cursor anchored at row `abc` in the unfiltered list points
nowhere meaningful in the filtered list, because the filtered list may
not contain `abc` at all.

**Reset to head on filter change.** Simplest and almost always right.
When the filter changes, drop the cursor and refetch from the first
page. With TanStack Query, putting the filter in the queryKey does this
for free — changing the filter mounts a fresh query starting at
`initialPageParam: undefined`.

```tsx
const [filter, setFilter] = useState('all');
const q = useInfiniteQuery({
  queryKey: [orgId, 'post', 'feed', filter],   // filter in the key
  // …
});
```

**Filter hash inside the cursor.** When the cursor must round-trip
through stateless URLs (a paginated public list with shareable links),
encode the filter state inside the cursor so the server can reject
mismatched filter + cursor combinations:

```ts
function encodeCursor(rowId: string, filterHash: string) {
  return Buffer.from(JSON.stringify({ id: rowId, f: filterHash })).toString('base64url');
}

function decodeCursor(c: string, expectedFilterHash: string) {
  const { id, f } = JSON.parse(Buffer.from(c, 'base64url').toString());
  if (f !== expectedFilterHash) throw new Error('Filter mismatch — cursor invalid');
  return id;
}
```

The hash is a stable digest of the filter object. The server recomputes
it and rejects mismatched pairs, so a user who keeps a cursor in a
bookmark and changes the filter on the page gets a 400 rather than a
confusing result. For signed cursors, swap the hash for a server-signed
JWT and reject unsigned cursors.

---

## Pagination + soft-delete

Two ways soft-deleted rows interact with cursor pagination.

**The cursor row gets deleted.** Fine — the cursor is the boundary,
not a member of the result. The next page starts at the first row
whose key is strictly greater than the cursor row, independent of
whether the cursor row still exists. Forge's default
`WHERE "deleted_at" IS NULL` filters out deleted rows and the cursor
inequality is applied independently.

**The compound index that backs the cursor should be partial on
`deleted_at IS NULL`** — otherwise the index includes deleted rows,
the scan reads them, and the filter discards them downstream:

```ts
const post = f.model('post', { /* … */ }, {
  indexes: [{ fields: ['created_at', 'id'], where: { deleted_at: null } }],
});
```

See [Soft delete partial-filter indexes](./SOFT-DELETE.md#partial-filter-indexes)
for the per-dialect emit. PG/SQLite/Mongo support partial indexes
natively; MySQL needs the generated-column workaround.

---

## Per-dialect pagination

The pagination predicates and limits compile differently on each
engine. Behaviour is uniform from the caller's perspective; the
wire-level cost and edge cases differ.

**Postgres.** `LIMIT 20 OFFSET 40` for offset; `WHERE "id" > $1 ORDER BY "id" LIMIT 20`
for cursor; row-value tuple `("created_at", "id") < ($1, $2)` for the
compound form. `ROW_NUMBER()` over a window is sometimes proposed as an
offset workaround — it is not faster, the planner still materialises
every row up to the offset.

**MySQL.** Same `LIMIT … OFFSET …` shape. 5.7+ supports row-value
tuples; 5.6 does not and forge expands to the OR-of-AND form. The
deep-offset problem is worse than on PG — InnoDB secondary indexes
carry the primary key as the leaf value, and `OFFSET` over a secondary
index walks both. Switch to cursor sooner.

**SQLite.** Same `LIMIT … OFFSET …` shape. Tuple compare since 3.15
(2016), so every supported runtime including the sqlite-wasm browser
adapter has it. OFFSET on SQLite is cheaper than PG/MySQL (in-process
b-tree walk) but the scan cost is still `O(skip + take)`.

**DuckDB.** DuckDB is a column store; OFFSET on a sorted column is
sub-millisecond even at depth, because the engine seeks into the sorted
chunk directly. Cursor still wins for stable boundaries under writes,
but the deep-offset concern is less severe.

**MSSQL.** `OFFSET 40 ROWS FETCH NEXT 20 ROWS ONLY` — `ORDER BY` is
mandatory; MSSQL refuses without it. Tuple compare is not supported;
forge expands cursors to the OR-of-AND form. The planner handles it
well when the compound index is declared.

**Mongo.** `.find(filter).sort(...).skip(40).limit(20)` for offset;
`{ _id: { $gt: lastId } }` filter for cursor; OR-of-AND expansion for
compound cursor. `.skip()` has the same trap as SQL OFFSET — and slower
per row because of BSON deserialisation. `hint()` is sometimes
necessary to force the index (the planner occasionally picks a covered
sort over the cursor index); the forge adapter accepts a `hint` option
on `findMany`. See [MONGO](./MONGO.md).

---

## Three worked examples

### (a) Timeline cursor with `(created_at, id)`

Forward-paged feed with a non-unique sort key and a unique tie-breaker
— the pattern under almost every "list of recent things".

```ts
async function postTimeline(input: { orgId: string; cursor?: string; limit?: number }) {
  const PAGE_SIZE = input.limit ?? 20;

  const rows = await db.post.findMany({
    where:   { org_id: input.orgId, status: 'PUBLISHED', deleted_at: null },
    orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
    take:    PAGE_SIZE + 1,
    ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
    select: { id: true, title: true, created_at: true, author_id: true },
  });

  const hasNextPage = rows.length > PAGE_SIZE;
  const visible     = rows.slice(0, PAGE_SIZE);
  return {
    data: visible,
    pageInfo: { hasNextPage, nextCursor: hasNextPage ? visible.at(-1)!.id : null },
  };
}
```

Backing index — leading column is the multi-tenant scope, then the
in-filter equality, then the sort tuple:

```ts
const post = f.model('post', { /* … */ }, {
  indexes: [{
    fields: ['org_id', 'status', 'created_at', 'id'],
    where:  { deleted_at: null },
  }],
});
```

PG and SQLite emit a true partial index; MySQL falls back to the
generated-column workaround
([SOFT-DELETE](./SOFT-DELETE.md#partial-filter-indexes)).

### (b) Admin table with numbered pages + count cache

Numbered pagination over a slowly-growing table. Count cached with
event-driven invalidation.

```ts
import { lru } from 'tiny-lru';
const userCountCache = lru<number>(1000, 60_000);

db.$on('user.created',     (u) => userCountCache.set(`count:${u.org_id}`,
  (userCountCache.get(`count:${u.org_id}`) ?? 0) + 1));
db.$on('user.softDeleted', (u) => userCountCache.set(`count:${u.org_id}`,
  Math.max(0, (userCountCache.get(`count:${u.org_id}`) ?? 0) - 1)));

async function adminUsersPage(orgId: string, page: number) {
  const PAGE_SIZE = 25;

  let total = userCountCache.get(`count:${orgId}`);
  if (total == null) {
    total = await db.user.count({ where: { org_id: orgId } });
    userCountCache.set(`count:${orgId}`, total);
  }

  const rows = await db.user.findMany({
    where:   { org_id: orgId },
    orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
    take:    PAGE_SIZE,
    skip:    (page - 1) * PAGE_SIZE,
  });

  return {
    data: rows,
    pageInfo: {
      page, pageSize: PAGE_SIZE,
      totalRows:  total,
      totalPages: Math.ceil(total / PAGE_SIZE),
    },
  };
}
```

For a 50k-user tenant the `OFFSET 1225` on page 50 is sub-millisecond
on PG. Past ~500k rows per tenant, switch to cursor and drop the "page
50" affordance.

### (c) Relay-style GraphQL connection

The resolver from
[GraphQL Relay connection mapping](#graphql-relay-connection-mapping)
extended with multi-tenant scope and soft-delete:

```ts
posts: async (_, args: {
  first?: number; after?:  string;
  last?:  number; before?: string;
  orgId:  string;
}) => {
  const PAGE_SIZE = args.first ?? args.last ?? 20;
  const forward   = args.last == null;
  const opaque    = forward ? args.after : args.before;
  const cursor    = opaque ? decodeCursor(opaque) : undefined;

  const rows = await db.post.findMany({
    where:   { org_id: args.orgId, status: 'PUBLISHED', deleted_at: null },
    orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
    take:    forward ? PAGE_SIZE + 1 : -(PAGE_SIZE + 1),
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
  });

  const hasMore = rows.length > PAGE_SIZE;
  const visible = rows.slice(0, PAGE_SIZE);
  return {
    edges: visible.map(p => ({ cursor: encodeCursor(p.id), node: p })),
    pageInfo: {
      hasNextPage:     forward  ? hasMore : Boolean(args.after),
      hasPreviousPage: !forward ? hasMore : Boolean(args.before),
      startCursor: visible.length ? encodeCursor(visible[0].id)        : null,
      endCursor:   visible.length ? encodeCursor(visible.at(-1)!.id)   : null,
    },
  };
};
```

The cursor is the raw row id, base64-encoded. Swap to a JSON blob if
you need a compound cursor — clients see the same opaque string.

---

## Common bugs

**Cursor on a non-unique column.** `cursor: { created_at: lastSeen }`
on a non-unique `created_at` throws at build time. Fix: sort by
`(created_at, id)`, cursor by `id`.

**`take` + `skip` for "jump to page 1000".** By page 50 the response
triples; by page 1000 it is unusable. There is no fix for jump-to-page
on a large table — accept the cost (small table), denormalise a
`page_number` column at write time (awkward, fragile under deletes), or
drop random-access and switch to cursor.

**Cursor reused after filter change.** A cursor anchored under filter A
points nowhere under filter B. The visible bug is "I changed the filter
and the page is empty or in the wrong order". Either reset to head on
filter change (client-side queryKey trick) or include a filter hash in
the cursor and reject mismatches server-side.

**`count` + `findMany` serialised.** Both queries hit the same pool —
run them concurrently with `Promise.all`. Most ORMs serialise the two
and double the latency by default.

**Mongo `.skip()` at depth.** Reads and discards every skipped
document, slower per row than SQL OFFSET because of BSON
deserialisation. `skip: 10000` on a few-million-doc collection is
hundreds of milliseconds. Cursor is the only workable answer at scale.

**Forgetting `skip: 1` on the cursor row.** Without it, the inclusive
boundary includes the cursor row at the top of the next page and the
user sees a duplicate. Always pair `cursor` with `skip: 1` unless you
specifically want the cursor row included.

**Tuple compare on MSSQL/Mongo without the compound index.** The
expanded OR-of-AND form runs without a compound index, but the planner
falls back to a sequential scan and the page load is `O(n)`. Always
declare the compound index on tables you paginate.

**Offset + soft-delete double-cost.** Without a partial index filtered
on `deleted_at IS NULL`, the engine reads every skipped row including
deleted ones, then filters them out post-scan. Declare the partial
index from [SOFT-DELETE](./SOFT-DELETE.md#partial-filter-indexes) — or
switch to cursor.

---

## See also

- [Queries deep-dive](./QUERIES.md) — `findMany` operator reference,
  `where` / `orderBy` shapes, and the original cursor sketch.
- [React patterns](./REACT.md#search-as-you-type-with-debounce--cursor-pagination)
  — TanStack Query `useInfiniteQuery` with debounced search.
- [Backend patterns](./BACKEND.md) — HTTP envelopes, ETag, idempotency.
- [Indexes](./INDEXES.md#2-plain-b-tree) — compound and partial indexes
  that back stable cursor pagination.
- [Soft delete](./SOFT-DELETE.md#partial-filter-indexes) — partial
  indexes filtered on `deleted_at IS NULL`.
- [Streaming](./STREAMING.md) — `findManyStream` for "paginate forever".
- [Mongo](./MONGO.md) — `hint()` and cursor-stage notes.
- [MSSQL](./MSSQL.md) — `OFFSET FETCH NEXT` and tuple-compare expansion.
