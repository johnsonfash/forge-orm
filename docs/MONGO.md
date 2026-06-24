# MongoDB

forge-orm's Mongo adapter maps the same IR (models, fields, indexes, relations) onto collections, documents, and the aggregation pipeline. This page documents what that mapping looks like in practice, plus Mongo-specific surfaces (change streams, Atlas Search, vector, transactions, sharding) and the operational concerns that touch the forge layer.

If you have not read the surface tour, start with
[`DRIVERS`](./DRIVERS.md#mongodriver) for the driver port shape and the
[Reading data](../README.md#reading-data) chapter for the call vocabulary
shared with every other adapter.

## Contents

* [Mongo as a dialect](#mongo-as-a-dialect)
* [Driver — the `mongodb` peer dep](#driver--the-mongodb-peer-dep)
* [Relational to document mapping](#relational-to-document-mapping)
* [Schema validation — `$jsonSchema`](#schema-validation--jsonschema)
* [Index types forge emits](#index-types-forge-emits)
* [Atlas-specific features](#atlas-specific-features)
* [The aggregation pipeline](#the-aggregation-pipeline)
* [Transactions](#transactions)
* [Change streams](#change-streams)
* [Read concerns and write concerns](#read-concerns-and-write-concerns)
* [Sharding](#sharding)
* [Connection pool](#connection-pool)
* [BSON types — round-trip with forge](#bson-types--round-trip-with-forge)
* [Common errors](#common-errors)
* [Three worked examples](#three-worked-examples)
* [Where to look in the source](#where-to-look-in-the-source)

---

## Mongo as a dialect

There is no SQL dialect for Mongo. The adapter still goes through the
same IR every other adapter uses — `SelectNode`, `InsertNode`,
`UpdateNode`, `DeleteNode`, `CountNode`, `GroupByNode`. Compilation
emits a `MongoArtifact` (`src/compile.ts`) instead of a SQL string:

```ts
interface MongoArtifact {
  kind: 'mongo';
  collection: string;
  op: 'find' | 'findOne' | 'insertOne' | 'insertMany' |
      'updateMany' | 'findOneAndUpdate' | 'deleteMany' |
      'findOneAndDelete' | 'aggregate' | 'countDocuments';
  args: { filter?: any; options?: any; document?: any; documents?: any[];
          update?: any; pipeline?: any[] };
  hydration?: RelationPlan[];
}
```

That artifact is what the executor passes to the driver. The kind-level
contract is identical to every other adapter (same wrapper API, same
event payloads, same error envelope), and the only place the IR has to
fork is when a feature has no direct Mongo analog — for instance,
`where: { posts: { some: {...} } }` (relation predicate) compiles to a
`{}` match on Mongo today (see [Aggregation pipeline](#the-aggregation-pipeline)).

The adapter's [`capabilities`](./DRIVERS.md#adapter-capabilities) flags
state where the dialect line is drawn:

```ts
// src/adapters/mongo/adapter.ts
const CAPS: AdapterCapabilities = {
  nativeCascades: false,                 // emulated by the JS cascade walker
  nativeUpsert: true,                    // findOneAndUpdate({ upsert: true })
  nullsOrdering: false,                  // Mongo $sort orders by BSON type
  jsonPath: true,                        // dotted keys are native
  transactionsRequireReplicaSet: true,   // mongod --replSet rs0 or mongos
};
```

The model declaration site does not branch on dialect. The schema you
write for Postgres works on Mongo subject to: no `bigserial` ids, no
expression indexes (`idx.expression`), and the per-feature footnotes
below.

---

## Driver — the `mongodb` peer dep

The driver is the official `mongodb` npm package, declared as an
**optional peer dep** so SQL-only installs do not pay the cost of
pulling it. Every Mongo file goes through a lazy accessor in
`src/adapters/mongo/bson.ts`:

```ts
let _m: typeof import('mongodb') | undefined;
export function mongo() {
  if (!_m) {
    try { _m = require('mongodb'); }
    catch {
      throw new Error(
        "[forge] the 'mongodb' driver is required for Mongo operations " +
        'but is not installed.\n  Install:  npm install mongodb',
      );
    }
  }
  return _m!;
}
```

A top-level `import { ObjectId } from 'mongodb'` would emit a
module-load `require('mongodb')` and crash a Postgres-only consumer at
boot. Anywhere forge needs `ObjectId`, `MongoClient`, or
`ClientSession`, it goes through `mongo()` instead.

The driver shape is the simplest of the six ports — just "bring your
own configured `MongoClient`" (see [DRIVERS](./DRIVERS.md#mongodriver)
for the full interface):

```ts
export interface MongoDriver {
  readonly kind: 'mongo';
  client: any;       // a MongoClient (or a shim that quacks like one)
  dbName?: string;   // defaults to the URI's default DB
}
```

`MongoAdapter.connect(url)` calls `client.connect()` (which is
idempotent on the driver, safe whether the caller already connected) and
caches the `Db` handle. Anything that implements `.db()`,
`.startSession()`, and the standard collection methods qualifies —
DocumentDB, Cosmos (Mongo API), and FerretDB all fit the slot but with
the feature-flag caveats below.

---

## Relational to document mapping

The IR carries a relational shape; Mongo stores documents. The adapter
bridges the two in three places: the field-name remap, the relation
hydrator, and the cascade walker.

### Tables and collections

Every model declares a `collection` name in its `ModelDef`. forge maps
1:1 — `model('users', {...})` becomes `db.users`. View-models compile
to read-only Mongo views via `createCollection(name, { viewOn,
pipeline })`; materialised view-models populate a real collection by
running the pipeline with a trailing `$out`, refreshed on demand via
`db.<model>.refresh()` (`src/adapters/mongo/adapter.ts:refreshView`).

### Ids and the `id` ↔ `_id` rename

App code always reads and writes the field `id`. Mongo stores it as
`_id`. The remap is centralised in `coerce.ts`:

```ts
// src/adapters/mongo/coerce.ts
export function appKeyToDbKey(key: string): string {
  return key === 'id' ? '_id' : key;
}
export function dbKeyToAppKey(key: string): string {
  return key === '_id' ? 'id' : key;
}
```

`f.id()` defaults to `ObjectId` (BSON), `f.id({ type: 'uuid' })`
produces a string UUID, and `f.id({ type: 'bigserial' })` is rejected at
push time — there is no auto-incrementing scalar on Mongo. The default
`autoId` is generated client-side by `applyCreateDefaults`:

```ts
if (def.default.kind === 'autoId') out[name] = new (mongo().ObjectId)();
```

This is the same shape Mongo itself would assign at the server, just
done early enough that `insertOne` and the return-row code path see the
same id without a round trip.

On read, every `ObjectId` is converted back to its 24-char hex string
before app code sees it. This is the rule that lets the rest of the
codebase treat ids as opaque strings.

### Relations via lookup vs. application-side hydration

forge's relations compile to a `RelationPlan` (see
[RELATIONS](./RELATIONS.md)). On Mongo, the executor does *not* emit
`$lookup` for hydration. It runs a separate batched fetch
(`{ <fk>: { $in: refs } }`) per relation level and joins the result
client-side:

```ts
// src/adapters/mongo/execute.ts
const node: SelectNode = {
  ...subNode, kind: 'select', model: rel.target,
  cardinality: 'many',
  where: { kind: 'leaf', field: rel.refs, op: 'in', value: coercedRefs },
};
const found = await executeSelect(node, targetModel, { session });
```

Two reasons for the choice:

1. **`$lookup` is restricted on the protocol-compatible servers.**
   Cosmos rejects it; DocumentDB supports a limited form. The
   batched-fetch path runs everywhere a `find` runs.
2. **Selection / projection / `_count` compose more cleanly.** Each
   relation level is just another `find` with its own `select`,
   `include`, `orderBy`, `limit`. The pipeline form would need a
   sub-pipeline per relation and a final `$project` to peel it apart.

If you need a true server-side join (avoiding the round-trip overhead
on a fan-out of thousands), reach for `db.<model>.aggregate(...)`
directly — that surface is unfiltered and you can write a `$lookup`
stage yourself. See [Aggregation pipeline](#the-aggregation-pipeline).

### Embeds — sub-documents, no serialisation

`f.embed()` and `f.embedMany()` are first-class on Mongo: an embed
becomes a sub-document and `embedMany` becomes a BSON array of
sub-documents. There is no JSON-string serialisation step; the storage
shape matches the in-memory shape.

```ts
const Order = model('orders', {
  id: f.id(),
  customer_id: f.objectId(),
  items: f.embedMany(() => LineItem),
}, { /* ... */ });

// On disk:
// { _id: ObjectId('...'), customer_id: ObjectId('...'),
//   items: [ { sku: 'BOOK-01', qty: 2 }, { sku: 'PEN-04', qty: 1 } ] }
```

Embed access compiles to dotted-key paths (`items.0.sku`) for read and
`$set: { 'items.0.qty': 3 }` for write. Mongo's positional `$` and
`$[]` operators are available via raw `aggregate` — the typed surface
exposes `update` on a parent and `some` on `embedMany` (compiled to
`$elemMatch`). See [`EMBED`](./EMBED.md#mongo-elemmatch-on-embedmany)
for the full surface.

### Cascades, application-side

Mongo has no foreign-key enforcement. `onDelete: 'Cascade'` and
`'SetNull'` are walked in `src/adapters/mongo/cascade.ts`:

```ts
export async function applyCascadesForDelete(parentModel, parentDocs, ctx) {
  const children = findChildRelations(parentModel);
  for (const { childModel, rel } of children) {
    const onDelete = rel.onDelete || 'NoAction';
    if (onDelete === 'NoAction' || onDelete === 'Restrict') continue;
    // ... resolve parent refs, coerce to ObjectId, fetch children, recurse, delete ...
  }
}
```

The walker recurses (Business → videos → likes/comments → replies) with
a visited set guarding pathological loops. Leaves are deleted before
parents so a concurrent reader does not see a dangling FK mid-walk.

`Restrict` is honoured by surfacing the cascade as a no-op — the parent
delete proceeds but children stay. If you want strict enforcement
(refuse the parent delete when any child exists), wrap the call in a
`$transaction` and run a pre-flight `count` on the child collection.

---

## Schema validation — `$jsonSchema`

Mongo 3.6+ supports collection-level JSON Schema validation
(`validator: { $jsonSchema: ... }, validationLevel: 'strict'`).

**forge does not emit `$jsonSchema` validators by default.**

The decision is deliberate. Three reasons:

1. **Two-source-of-truth risk.** The TypeScript model is the schema.
   Emitting `$jsonSchema` on top duplicates that, and the duplication
   drifts the moment someone adds a field in code without re-pushing.
2. **Migration friction.** `validationLevel: 'strict'` rejects writes
   that do not match — including writes from a service running an
   older version of the schema during a rolling deploy. The JS-side
   coercion in `coerce.ts` already does the equivalent shape check
   before the write hits Mongo, so the runtime validation is
   redundant.
3. **Embedded schema is full-featured.** `$jsonSchema` does not cover
   the same surface as forge field defs (no automatic ObjectId casting,
   no `updatedAt` triggers, no defaults). Half-validating is worse than
   not validating.

If you want collection-level validation as a *belt and braces* second
line (mostly to catch writes from another service that bypasses
forge), the supported path is:

```ts
// One-off ops script. Run after forge push.
await db.command({
  collMod: 'orders',
  validator: { $jsonSchema: {
    bsonType: 'object',
    required: ['_id', 'customer_id', 'items'],
    properties: {
      _id: { bsonType: 'objectId' },
      customer_id: { bsonType: 'objectId' },
      items: { bsonType: 'array', minItems: 1 },
    },
  }},
  validationLevel: 'moderate',   // skip the validator on updates that don't touch validated fields
  validationAction: 'warn',      // log-only, never reject
});
```

`validationLevel: 'moderate'` + `validationAction: 'warn'` is the only
setting that survives a rolling deploy without dropping writes. Anything
stricter needs a coordinated stop-the-world migration.

---

## Index types forge emits

forge's [`IndexDef`](./INDEXES.md#1-indexdef-shape) is a single shape
that covers every dialect's index family. The Mongo emitter in
`src/adapters/mongo/scripts/push.ts` maps each field to the matching
`createIndex` call.

| IndexDef field | Mongo emit |
|---|---|
| `keys: { col: 1 }` | `createIndex({ col: 1 })` — ASC b-tree |
| `keys: { col: -1 }` | `createIndex({ col: -1 })` — DESC b-tree |
| `keys: { col: 'text' }` | `createIndex({ col: 'text' })` — text index |
| `keys: { col: '2dsphere' }` | `createIndex({ col: '2dsphere' })` — geo (sphere) |
| `keys: { col: '2d' }` | `createIndex({ col: '2d' })` — legacy planar geo |
| `keys: { col: 'hashed' }` | `createIndex({ col: 'hashed' })` — for shard keys |
| `keys: { '$**': 1 }` | wildcard — needs `wildcardProjection` |
| `unique: true` | `{ unique: true }` |
| `sparse: true` | `{ sparse: true }` (implicit on `.unique()` of optional field) |
| `expireAfterSeconds: 86400` | TTL — Mongo expires docs after N seconds past the indexed `Date` |
| `partialFilterExpression: {...}` | `{ partialFilterExpression: {...} }` |
| `where: {...}` (object) | aliased to `partialFilterExpression` |
| `where: '...'` (string) | SQL-only — skipped on Mongo |
| `collation: { locale, strength }` | `{ collation: {...} }` |
| `wildcardProjection: {...}` | `{ wildcardProjection: {...} }` |
| `method: 'spatial'` | resolved to `2dsphere` per key |
| `method: 'fulltext'` | n/a — use `.searchable()` instead |
| `method: 'vector'` | warned + skipped — Atlas Vector Search uses a different API |
| `method: 'gin'` / `'gist'` / `'brin'` / `'hash'` | warned + skipped (SQL-only) |
| `include: [...]` | warned + skipped (SQL-only covering index) |
| `expression: '...'` | warned + skipped (Mongo has no expression indexes) |
| `visible: false` | warned + skipped |

Push is idempotent. `pushAllIndexes` calls `listIndexes()` once per
collection, fingerprints the spec, and only `createIndex`'s the
differences. When the spec drifted (Mongo error 85/86 — "index already
exists with different options"), forge drops and recreates the index
with a `↻` log line:

```
📦 orders
   ⚡ idx_orders_customer_id          (already up-to-date)
   ↻ idx_orders_status_uq            (rebuilt — spec drifted)
   ✓ idx_orders_items_sku_text       (new)
```

The `fingerprint` in `push.ts` preserves byte equality with the
pre-2.2 form, which is why a pure-version-bump push does not
unnecessarily rebuild your indexes.

**Searchable fields collapse into one text index.** Mongo allows
exactly one text index per collection, so every field marked
`.searchable()` lands in a combined `{ a: 'text', b: 'text', ... }`
index named `forge_<collection>_fts`. Per-field weights are set via
`{ weights: { title: 10, body: 1 } }` on the index. See
[FTS](./FTS.md#mongo) for the query side.

---

## Atlas-specific features

MongoDB Atlas exposes several features that are not in the open-source
server.

| Feature | Where forge supports it |
|---|---|
| `$search` (Atlas Search) | Via raw `db.<model>.aggregate([{ $search }, ...])` — no typed surface yet. Index lives in the Atlas Search index API, not `createIndex`. |
| `$vectorSearch` (Atlas Vector Search) | **First-class** — `orderBy: { embedding: { nearTo: { vector: [...] } } }` compiles to a `$vectorSearch` pipeline. See [VECTOR](./VECTOR.md) and the executor at `executeSelectWithVectorSearch`. |
| Atlas Data API | Deprecated by MongoDB in 2024. The pattern still works via a custom HTTP proxy — see [DRIVERS](./DRIVERS.md#d-mongodb-atlas-data-api-http-only-edge). |
| Triggers | Out of scope — Atlas Triggers are a server-side function runtime. Use change streams ([below](#change-streams)) if you need in-process reaction to writes. |
| Charts | Read-only against the collection. Nothing for forge to do. |
| Online Archive | Tier collection writes; reads stay transparent. Push warns if it cannot create an index on the archive tier (you create archive indexes via the Atlas UI). |

### Atlas Search (`$search`)

forge does not yet have a typed surface for `$search`. The Atlas Search
index is created via the Search Index API (`createSearchIndex` in the
driver, or the Atlas UI), and queries go through raw aggregation:

```ts
const hits = await db.posts.aggregate({
  pipeline: [
    { $search: {
        index: 'posts_default',
        compound: {
          must:   [{ text: { query: 'mongodb', path: ['title', 'body'] } }],
          should: [{ text: { query: 'atlas',   path: 'title', score: { boost: { value: 3 } } } }],
        },
    }},
    { $limit: 50 },
    { $project: { title: 1, body: 1, score: { $meta: 'searchScore' } } },
  ],
});
```

The collection wrapper's `aggregate` runs the pipeline through the
driver with extended-JSON coercion (`{$oid}` / `{$date}` markers in
your pipeline are converted to native types — see
`coerceExtendedJSON` in `coerce.ts`).

### Atlas Vector Search (`$vectorSearch`)

This one *is* in the typed surface. A `f.vector(N)` field plus
`orderBy: { embedding: { nearTo: { vector: [...] } } }` on the query
compiles to a `$vectorSearch` stage:

```ts
// src/adapters/mongo/execute.ts
const stage: any = {
  $vectorSearch: {
    index: `${dbField}_vector_index`,
    path: dbField,
    queryVector: v.vector,
    numCandidates: Math.max(limit * 10, 50),
    limit,
  },
};
if (Object.keys(filter).length > 0) stage.$vectorSearch.filter = filter;

const pipeline = [
  stage,
  { $set: { _distance: { $meta: 'vectorSearchScore' } } },
];
```

The search index itself is *not* created by `forge push` — vector
indexes live in the Atlas Search index API
(`createSearchIndex({ mappings: { fields: { embedding: { type: 'knnVector', dimensions, similarity }}}})`).
Push warns and skips when it encounters `method: 'vector'` on Mongo
with a pointer to the Atlas docs. See [VECTOR](./VECTOR.md) for the
full story.

---

## The aggregation pipeline

Several IR shapes compile directly to a pipeline.

| IR | Pipeline emit |
|---|---|
| `groupBy` | `[{$match: filter}, {$group: {...}}, {$match: havingMatch}, {$sort}, {$skip}, {$limit}]` |
| `near` filter combined with `nearTo` orderBy | `[{$geoNear: {...query, key, distanceField, spherical}}, {$skip}, {$limit}, {$project}]` |
| `nearTo` on a vector field | `[{$vectorSearch: {...}}, {$set: {_distance: {$meta}}}, {$project}]` |
| `_count` on hydration | `[{$match: {<fk>: {$in: refs}}}, {$group: {_id: '$<fk>', c: {$sum: 1}}}]` |
| `count({ distinct: [...] })` | `[{$match: filter}, {$group: {_id: <by>}}, {$count: 'n'}]` |
| `db.<model>.aggregate({ pipeline })` | the pipeline you passed, through `coerceExtendedJSON` |

Stage-by-stage notes:

* **`$match`** — both pre-group (in `executeGroupBy`) and post-group
  (`having`). The `where` compiler in `compile-from-ir.ts` is the same
  one `find` uses, so `$expr`, `$and`, `$or`, `$nor`, regex flags, and
  every operator listed in [QUERIES](./QUERIES.md#where-operator-reference-per-dialect)
  translate identically.
* **`$group`** — `_count`, `_sum`, `_avg`, `_min`, `_max` become flat
  aliases (`__agg_count_<field>`, etc.) so the reshaper can rebuild
  the nested `{ _count: { ... }, _sum: { ... } }` payload regardless of
  bucket count. `_count: { _all: true }` is `{ $sum: 1 }`.
* **`$lookup`** — not emitted by the typed surface for hydration (see
  [Relations](#relations-via-lookup-vs-application-side-hydration)).
  Use raw aggregate when you need it.
* **`$facet`** — not emitted; raw aggregate is the path. Useful for
  multi-metric dashboards (see [worked examples](#three-worked-examples)).
* **`$project`** — appended for `select` / `omit` projections. Mongo
  cannot mix `0` and `1` in one `$project` except for `_id: 0`, so the
  compiler picks "all 1s" (exclusive) or "all 0s" (omit-only) — never
  a mix.
* **`$unwind`** — not emitted; raw aggregate. Useful when you need to
  group by an element of an `embedMany` array.

Relation filters (`where: { posts: { some: {...} } }`) currently emit
`{}` (match-all) on Mongo, with a known-gap note in `compileWhereNode`:

```ts
case 'relation':
  // Relation filters in `where` are not yet supported on Mongo (no $lookup);
  // return {} (match-all) rather than erroring. Tracked as a known gap.
  return {};
```

The workaround is a raw `aggregate` with `$lookup` + `$match` on the
joined field — see [Cross-collection joins](#1-atlas-search-hybrid-query)
in the worked examples.

---

## Transactions

`db.$transaction(fn)` opens a `ClientSession` and runs `fn` inside
`session.withTransaction()`. The session is what the IR threads
through `ExecOpts.session` to the executor, so every read and write
inside `fn` participates:

```ts
// src/adapters/mongo/client.ts
async transaction<T>(fn: (session: ClientSession) => Promise<T>): Promise<T> {
  const session = this.client.startSession();
  try {
    let result!: T;
    await session.withTransaction(async () => {
      result = await fn(session);
    });
    return result;
  } finally {
    await session.endSession();
  }
}
```

`withTransaction` is the driver's built-in retry loop — it
automatically retries on `TransientTransactionError` and
`UnknownTransactionCommitResult`. You get that retry for free; the
SQL adapters have to implement it themselves (see
[TRANSACTIONS](./TRANSACTIONS.md#interactive-transactions)).

### Replica set requirement

Multi-document transactions require a replica set or `mongos`. A
default-config single-node `mongod` will reject `startSession` for
transactions with:

```
Transaction numbers are only allowed on a replica set member or mongos
```

`MongoAdapter.capabilities.transactionsRequireReplicaSet = true`
surfaces this in the doctor report. The local-dev path is:

```sh
mongod --replSet rs0 --port 27017 --bind_ip localhost
```

then in the mongo shell once:

```js
rs.initiate();
```

That's a single-node replica set — no extra processes, no
coordination, just the right semantics. The `mongo:6` Docker image in
forge's `integration-mongo.ts` does exactly this.

### Single-document writes are always atomic

You do not need a transaction to atomically update one document.
`updateOne`, `findOneAndUpdate`, `insertOne`, and `deleteOne` either
commit fully or not at all. Reach for `$transaction` only when you
need *cross-document* or *cross-collection* atomicity.

### Compatibility footguns

* **AWS DocumentDB.** Multi-document transactions since 4.0 but with
  operator restrictions (`$lookup`, `$out` are limited inside a tx).
  Test the actual statements forge emits.
* **Azure Cosmos DB (Mongo API).** No multi-document transactions.
  `withTransaction` throws at runtime. Use the native Cosmos SDK if
  you need cross-document atomicity on Cosmos.
* **FerretDB.** Best-effort, version-gated.

The fallback for these targets is to lean on single-document atomicity
plus an outbox collection for fan-out semantics.

See [TRANSACTIONS](./TRANSACTIONS.md#mongo-replica-set-requirement)
for the full discussion including read/write concern composition.

---

## Change streams

Change streams (`collection.watch()`) emit one event per insert,
update, replace, or delete (plus invalidate / rename / drop). The
adapter exposes them through the
[WATCH](./WATCH.md) pattern; the raw surface is:

```ts
const cursor = db.collection('orders').watch([
  { $match: { 'fullDocument.status': 'PAID' } },
], { fullDocument: 'updateLookup' });

for await (const change of cursor) {
  // { operationType: 'insert'|'update'|'replace'|'delete',
  //   fullDocument: {...}, documentKey: { _id }, ns, clusterTime, ... }
}
```

Three things to know:

1. **Replica set or `mongos` required.** Same constraint as
   transactions — change streams use the oplog. Cosmos (Mongo API) and
   FerretDB do *not* support them; DocumentDB does.
2. **`fullDocument: 'updateLookup'`** triggers a separate read of the
   current document on every update event. Without it the change event
   carries only the delta. The lookup is at the cluster's read concern
   (not the change's `clusterTime`), so the document you receive may
   already reflect a later write.
3. **Resume tokens** survive restarts. Persist `change._id` to a
   cursor-state collection and pass `{ resumeAfter: token }` on
   reconnect to pick up exactly where you left off. The oplog rolls,
   so resume tokens have a finite lifetime — keep your watcher within
   the oplog window or you lose events.

forge surfaces watch via the runtime collection wrapper:
`db.orders.watch([pipeline], { fullDocument: 'updateLookup' })` returns
the driver cursor unchanged — no decoding, no projection, no
hydration. If you want forge-shaped documents in the event payload,
run `decodeRow(model, change.fullDocument)` yourself.

---

## Read concerns and write concerns

The four read concerns and their forge-relevant trade-offs:

| Read concern | Reads | Use when |
|---|---|---|
| `local` (default) | last write that reached the queried node | the OLTP default — fast, possibly stale on secondaries |
| `available` | same as `local` on replica sets; ignores orphans on sharded clusters | shard reads where orphans are tolerable |
| `majority` | only writes acknowledged by a majority of the replica set | reads inside a tx; cross-shard consistency |
| `linearizable` | reads serialised through the primary; reflects every preceding write | strictly avoid; expensive |
| `snapshot` | reads from a consistent snapshot at a cluster time | inside transactions on 4.2+ |

Write concerns:

| Write concern | Ack on |
|---|---|
| `{ w: 0 }` | client send (no ack) — never for production data |
| `{ w: 1 }` (default) | primary applied |
| `{ w: 'majority' }` | majority of voting members acked |
| `{ w: 'majority', j: true }` | majority acked AND journaled |
| `{ w: <tag> }` | custom — e.g. one node per datacentre |

forge does not set a read or write concern itself — it uses the
client's defaults. To override, construct the client at the right
level:

```ts
const client = new MongoClient(uri, {
  readConcern: { level: 'majority' },
  writeConcern: { w: 'majority', j: true, wtimeout: 5_000 },
});
export const db = await createDb({ schema, driver: mongoDriver(client) });
```

The transaction's read/write concern comes from
`defaultTransactionOptions` on the client — set it there if you want
transactions to default to `'majority'` while regular reads stay on
`'local'`.

---

## Sharding

Forge does not pick your shard key. The choice belongs in the Mongo
shell at sharding-enable time. The relevant principles:

* **Pick a key that distributes writes evenly.** A monotonically
  increasing key (`createdAt`, `ObjectId`) sends every new write to
  the same chunk — a single hot shard. The default `_id` is monotonic
  enough that a high-write collection should *not* shard on it
  directly; use `{ _id: 'hashed' }` instead.
* **Include the shard key in every targeted query.** A query that
  does not name the shard key fans out to every shard
  (`mongos` scatter-gather). The performance gap is order-of-magnitude
  on a sharded cluster.
* **Compound shard keys.** Tenant + time is the standard pattern —
  `{ tenant_id: 1, created_at: 1 }`. Writes spread across tenants;
  per-tenant queries hit one chunk.

A hashed-id shard key on a collection forge manages:

```js
sh.enableSharding('app');
sh.shardCollection('app.events', { _id: 'hashed' });
```

The `'hashed'` index has to exist before `shardCollection`. Declare it
in the schema:

```ts
const Event = model('events', { /* ... */ }, {
  indexes: [{ keys: { id: 'hashed' } }],
});
```

`forge push` creates the hashed index. Sharding is enabled separately
in your ops scripts — forge does not run `sh.shardCollection` for you,
because the timing (early in the collection's life, before it grows)
is a deployment decision.

Transactions across shards work but cost more (`mongos` coordinates).
Change streams across shards work transparently — `mongos` merges them.

---

## Connection pool

The defaults forge picks when no driver is injected
(`src/adapters/mongo/client.ts`):

```ts
this._client = new (mongo().MongoClient)(uri, {
  maxPoolSize: 50,
  minPoolSize: 5,
  connectTimeoutMS: 10_000,
  serverSelectionTimeoutMS: 10_000,
  retryWrites: true,
  retryReads: true,
});
```

When to override:

* **Higher `maxPoolSize`** for a Node webserver doing fan-out work
  (hydration loads N relations per request) — set it above the request
  concurrency floor or you head-of-line under load.
* **`maxPoolSize: 1`** on edge / Lambda where each invocation is its
  own process and pooling would just queue inside one cold start.
* **`retryWrites: false`** on a sharded write workload that hates
  duplicates — `retryWrites` is safe for idempotent operations
  (insert, update by id) but creates double-writes on non-idempotent
  pipelines. Forge's typed mutations are idempotent; raw aggregate
  pipelines are your responsibility.
* **`socketTimeoutMS`** is *not* set by default. The driver leaves it
  off, which is correct for long-running aggregates and change
  streams. Set it (60_000+) only if you have a known runaway-query
  story to truncate.

Inject your own client when you need any non-default setting — forge
never re-instantiates a client you handed it:

```ts
const client = new MongoClient(uri, {
  maxPoolSize: 200,
  writeConcern: { w: 'majority' },
});
export const db = await createDb({ schema, driver: mongoDriver(client) });
```

Register `db.$disconnect()` from your SIGTERM handler. `close()` is
idempotent on the driver.

---

## BSON types — round-trip with forge

The Mongo wire shape is BSON, not JSON. Five BSON types matter for the
forge round-trip; the rest pass through untouched.

### `ObjectId`

`f.id()` / `f.objectId()`. App-side: a 24-char hex string. DB-side: a
12-byte BSON `ObjectId`. Coercion is in both directions:

```ts
// inbound — app → db
if (typeof v === 'string' && mongo().ObjectId.isValid(v)) {
  return new (mongo().ObjectId)(v);
}

// outbound — db → app
if (value instanceof mongo().ObjectId) return value.toString();
```

Filter values, FK refs, and `$in: [...]` arrays all go through the
coercer (`coerceFieldValue`), so `where: { author_id: 'abc123...' }`
works the same way `where: { author_id: new ObjectId('abc123...') }`
does. The app code does not need to know.

### `Date`

`f.dateTime()`. App-side: a JS `Date` (or an ISO string / epoch number
on input). DB-side: BSON `Date` (UTC, ms precision). The inbound
coercer parses strings and numbers:

```ts
if (typeof v === 'string' || typeof v === 'number') {
  const d = new Date(v);
  return isNaN(d.getTime()) ? v : d;
}
```

Mongo stores ms-precision UTC. Sub-millisecond precision is lost. If
you need ns timestamps, use a `string` field with a normalised ISO
form.

### `Decimal128`

`f.decimal(p, s)`. App-side: a `string` (forge's portable shape).
DB-side: `Decimal128`. The driver handles the conversion on write
when you pass a string that parses; on read forge converts back to
string. Do *not* round-trip through `number` — JavaScript's float
arithmetic loses precision on values past 2^53.

### `Binary`

`f.bytes()`. App-side: a Node `Buffer` or `Uint8Array`. DB-side: BSON
`Binary` (subtype 0 by default). The driver round-trips both
directly. ThumbHash payloads, image blobs, and signed tokens all
fit here.

### `Regex` and `Long`

Neither has a typed field; both pass through. `f.string()` with a
regex stored in it appears as a plain string on read. `Long` (64-bit
ints — useful for legacy data) requires the `bsonRegExp: false,
useBigInt64: true` options on the driver if you want native `bigint`s
on read.

### `BigInt`

Not a BSON type — forge does not auto-convert. Use `Decimal128` for
exact arithmetic or `Long` for 64-bit-int compatibility.

---

## Common errors

| Code / shape | Cause | Where to fix |
|---|---|---|
| `E11000 duplicate key` (code `11000`) | unique index hit | rethrown as `DbKnownError('P2002', ...)` — same shape as the SQL `UniqueViolation` (`src/adapters/mongo/errors.ts`) |
| `Transaction numbers are only allowed on a replica set member or mongos` | `mongod` started without `--replSet` | start as `mongod --replSet rs0` and `rs.initiate()` |
| `TransientTransactionError` (code `251`) | tx aborted, safe to retry | `withTransaction` retries automatically; the typed surface bubbles the final failure |
| `NotPrimary` (code `10107`) | wrote to a stepped-down secondary | client reconnects on its own; the write is retried only if `retryWrites: true` |
| `MongoServerSelectionError` | no node reachable inside `serverSelectionTimeoutMS` | check the URI's replica-set name and TLS settings; forge defaults to 10s |
| `WriteConflict` (code `112`) | optimistic-concurrency conflict inside a tx | retry the whole `$transaction(fn)` — Mongo's tx model is OCC, not pessimistic |
| `IndexOptionsConflict` (codes `85`, `86`) | `createIndex` with a name that exists but with different options | `forge push` detects and rebuilds; if you call `createIndex` yourself, drop first |
| `cannot create unique index over … with shard key` (code `67`) | unique index without prefixing the shard key | include the shard key in the index, or make the index `partialFilterExpression`-scoped |
| `path collision at … with conflicting path` | `$set` and another update operator both target the same field (or one is a prefix of the other) | forge's `compileUpdate` drops the colliding entry from `$setOnInsert`; if you build raw updates, mirror that rule |
| `BSONObj size … is invalid` (`10334`) | a document exceeded the 16 MB limit | move the offending field out — typically an `embedMany` that should be a child collection |
| `Cursor not found` (`43`) | cursor timed out (10 min idle by default) | use `cursor.batchSize` or stream with `{ noCursorTimeout: true }` (and clean up explicitly) |
| `MongoNetworkError: connection X to … closed` | replica-set primary stepped down mid-query | driver retries reads on `retryReads`; idempotent writes on `retryWrites` |

The dup-key rethrow path is the only error forge translates by code.
Everything else surfaces verbatim — the calling code can match on
`err.code` or `err.name` for finer routing.

---

## Three worked examples

### 1. Atlas Search hybrid query

Lexical + vector + filter in one pipeline. Atlas Search defines two
indexes — a "default" text index on `title` / `body`, and a vector
index on `embedding`. The hybrid query runs both through
`$rankFusion` (Atlas-only stage) and applies a price filter:

```ts
const results = await db.products.aggregate({
  pipeline: [
    { $rankFusion: {
        input: {
          pipelines: {
            lexical: [
              { $search: {
                  index: 'products_default',
                  text: { query: req.query.q, path: ['title', 'body'] },
              }},
              { $limit: 100 },
            ],
            semantic: [
              { $vectorSearch: {
                  index: 'embedding_vector_index',
                  path: 'embedding',
                  queryVector: req.query.embedding,
                  numCandidates: 500,
                  limit: 100,
              }},
            ],
          },
        },
        combination: { weights: { lexical: 0.4, semantic: 0.6 } },
    }},
    { $match: { price: { $gte: 10, $lte: 500 } } },
    { $project: {
        title: 1, body: 1, price: 1,
        score: { $meta: 'searchScore' },
    }},
    { $limit: 20 },
  ],
});
```

Two things to note. First, `$rankFusion` is Atlas-only — community
Mongo will error at the server. Second, the filter goes *after* the
two search pipelines, not inside them. Mongo's `$search` and
`$vectorSearch` both accept their own `filter` clause if you want the
filter to apply before scoring (cheaper but only over fields included
in the search index's `filter` mapping).

Pair this with `f.vector(N)` on the `embedding` field and create the
indexes via the Atlas UI — see [VECTOR](./VECTOR.md).

### 2. Change-stream watcher

A worker that reacts to every paid order, dedupes by `_id`, and
survives restarts via resume tokens stored in a `cursor_state`
collection.

```ts
import type { ChangeStreamDocument, ResumeToken } from 'mongodb';
import { dbClient } from 'forge-orm';

const CURSOR_NS = 'cursor_state';
const CURSOR_KEY = 'paid_orders_watcher';

async function loadResume(): Promise<ResumeToken | undefined> {
  const state = await dbClient.db.collection(CURSOR_NS).findOne({ _id: CURSOR_KEY as any });
  return state?.token;
}

async function saveResume(token: ResumeToken) {
  await dbClient.db.collection(CURSOR_NS).updateOne(
    { _id: CURSOR_KEY as any },
    { $set: { token, ts: new Date() } },
    { upsert: true },
  );
}

export async function watchPaidOrders() {
  const resumeAfter = await loadResume();
  const cursor = dbClient.db.collection('orders').watch(
    [{ $match: {
        operationType: { $in: ['insert', 'update'] },
        'fullDocument.status': 'PAID',
    } }],
    { fullDocument: 'updateLookup', ...(resumeAfter ? { resumeAfter } : {}) },
  );

  for await (const change of cursor as AsyncIterable<ChangeStreamDocument>) {
    if (change.operationType !== 'insert' && change.operationType !== 'update') continue;
    const order = (change as any).fullDocument;
    if (!order) continue; // updateLookup races a delete

    try {
      await chargeWebhook(order);
      await saveResume((change as any)._id);
    } catch (err) {
      // Surface but don't save the token — we'll reprocess on restart.
      console.error('[paid_orders_watcher] dispatch failed', err);
      throw err;
    }
  }
}
```

The pattern lives or dies on the resume token. Save it only after the
side effect succeeds — if the worker crashes between the side effect
and the save, the next restart replays the event. That's at-least-once
semantics; the consumer (`chargeWebhook` here) has to be idempotent.

### 3. `$facet` for a multi-metric dashboard

One round trip, four facets — pipeline runs the same `$match` once and
fans out into per-bucket aggregations.

```ts
const dashboard = await db.orders.aggregate({
  pipeline: [
    { $match: {
        org_id: org.id,
        created_at: { $gte: range.from, $lte: range.to },
    }},
    { $facet: {
        // Revenue by day
        revenueByDay: [
          { $group: {
              _id: { $dateTrunc: { date: '$created_at', unit: 'day' } },
              total: { $sum: '$amount' },
              n:     { $sum: 1 },
          }},
          { $sort: { _id: 1 } },
        ],
        // Top customers by revenue
        topCustomers: [
          { $group: { _id: '$customer_id', total: { $sum: '$amount' } } },
          { $sort: { total: -1 } },
          { $limit: 10 },
          { $lookup: {
              from: 'customers', localField: '_id', foreignField: '_id', as: 'customer',
          }},
          { $unwind: '$customer' },
          { $project: { _id: 1, total: 1, customer: { name: 1, email: 1 } } },
        ],
        // Status distribution
        statusDistribution: [
          { $group: { _id: '$status', n: { $sum: 1 } } },
        ],
        // Headline numbers — one row, no further grouping
        headline: [
          { $group: {
              _id: null,
              total:    { $sum: '$amount' },
              orders:   { $sum: 1 },
              uniqueCustomers: { $addToSet: '$customer_id' },
          }},
          { $project: {
              _id: 0, total: 1, orders: 1,
              uniqueCustomers: { $size: '$uniqueCustomers' },
          }},
        ],
    }},
  ],
});

// dashboard is one document:
//   { revenueByDay: [...], topCustomers: [...], statusDistribution: [...], headline: [...] }
```

Why `$facet` over four parallel queries: the `$match` runs once, the
indexes are walked once, and the network round-trip is single. For a
dashboard endpoint hit on every page load, the difference is
measurable.

The `$lookup` inside the `topCustomers` facet is the same case
mentioned under [Relations](#relations-via-lookup-vs-application-side-hydration)
— forge does not emit it from the typed surface, but the raw
aggregate path is unfiltered. Use it when the call site does not
compose well into typed `include`.

---

## Where to look in the source

| Concern | File |
|---|---|
| Adapter wiring + capabilities + doctor | `src/adapters/mongo/adapter.ts` |
| Driver port (`MongoDriver`) | `src/adapters/mongo/driver.ts` |
| MongoClient lifecycle + transactions | `src/adapters/mongo/client.ts` |
| Lazy access to the `mongodb` peer dep | `src/adapters/mongo/bson.ts` |
| IR → driver-call compiler | `src/adapters/mongo/compile-from-ir.ts` |
| Args → IR compile API | `src/adapters/mongo/compile.ts` |
| Inbound / outbound coercion (ObjectId, Date, embeds, defaults, extended-JSON) | `src/adapters/mongo/coerce.ts` |
| `executeSelect` + `$geoNear` + `$vectorSearch` bridges + hydration | `src/adapters/mongo/execute.ts` |
| Cascade walker (`onDelete: Cascade` / `SetNull`) | `src/adapters/mongo/cascade.ts` |
| Error translation (`P2002`, `P2025`) | `src/adapters/mongo/errors.ts` |
| `forge push` — collect specs, fingerprint, ensureIndex | `src/adapters/mongo/scripts/push.ts` |

---

## See also

* [DRIVERS](./DRIVERS.md#mongodriver) — the driver port shape; how
  Cosmos / DocumentDB / FerretDB fit (and where they don't).
* [QUERIES](./QUERIES.md) — operator surface every adapter shares.
  The Mongo per-operator emits in [§99](./QUERIES.md#where-operator-reference-per-dialect).
* [INDEXES](./INDEXES.md) — the full `IndexDef` shape and the per-dialect
  emit matrix that the table in [§5](#index-types-forge-emits) is drawn
  from.
* [EMBED](./EMBED.md#mongo-elemmatch-on-embedmany) — embed surface,
  `$elemMatch`, `$push` / `$pull` paths, embed-vs-child-collection
  decisions.
* [FTS](./FTS.md#mongo) — `$text` queries, weighting, language
  handling, and when to graduate to Atlas Search.
* [VECTOR](./VECTOR.md) — `$vectorSearch` pipeline, Atlas index
  creation, hybrid query patterns.
* [GEO](./GEO.md#mongo-2dsphere-and-the-geonear-rewrite) — 2dsphere,
  `$geoNear` rewrite for cross-field `nearTo`, TTL collections for
  trailing positions.
* [WATCH](./WATCH.md) — change-stream surface, resume tokens, oplog
  window.
* [TRANSACTIONS](./TRANSACTIONS.md#mongo-replica-set-requirement) —
  full transaction discussion, read/write concern composition,
  cross-database limits.
