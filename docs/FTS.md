# Full-text search — deep dive

The README chapter **[Full-text search](../README.md#full-text-search)**
covers the surface API: mark a column `.searchable()`, query it with
`where: { col: { search: 'query' } }`, and forge emits the right index
for whichever of the six databases you're on. This doc is the long-form
companion. It walks each dialect's FTS engine, the exact SQL or stage
the `search` operator becomes, what's lost in translation, how to read
the underlying ranking score, where to drop to `$queryRaw`, how to
combine FTS with vector search via RRF, and how to keep an index
healthy across millions of writes.

If you haven't read the README chapter yet, start there — this doc
assumes you know the call shape and the dialect matrix.

## Contents

* [The `.searchable()` decoration](#the-searchable-decoration)
* [The `search` operator — per-dialect translation](#the-search-operator--per-dialect-translation)
* [Query syntax per dialect](#query-syntax-per-dialect)
* [Languages and analyzers](#languages-and-analyzers)
* [Ranking and scoring](#ranking-and-scoring)
* [Multi-column FTS](#multi-column-fts)
* [Stop words and customization](#stop-words-and-customization)
* [Searchable + soft-delete](#searchable--soft-delete)
* [Searchable embeds and JSON](#searchable-embeds-and-json)
* [Hybrid search (BM25 + vector)](#hybrid-search-bm25--vector)
* [Incremental indexing and rebuilds](#incremental-indexing-and-rebuilds)
* [Highlighting](#highlighting)
* [Performance and when to switch engines](#performance-and-when-to-switch-engines)
* [Six worked patterns](#six-worked-patterns)
* [Common bugs](#common-bugs)

---

## The `.searchable()` decoration

`f.text().searchable()` (also valid on `f.string()`) marks a field as
participating in the dialect's full-text engine. The marker is read at
table-create time by `forge push` and at runtime by `db.$migrate()` on
the browser adapter. Nothing about the column's logical type changes —
it's still a `text` / `varchar` / `TEXT` column on the base table.

```ts
const Post = model('posts', {
  id:    f.id(),
  title: f.string().searchable(),
  body:  f.text().searchable(),
  org_id: f.string(),
});
```

What forge emits when the table is created:

| Dialect  | Emitted FTS object                                                              |
|----------|----------------------------------------------------------------------------------|
| Postgres | `CREATE INDEX … ON posts USING gin(to_tsvector('simple', "title"))` (one per searchable column) |
| MySQL    | `ALTER TABLE posts ADD FULLTEXT "ft_posts_title" (\`title\`)` (one per searchable column) |
| SQLite   | One shared `posts_fts` virtual table — `CREATE VIRTUAL TABLE posts_fts USING fts5(title, body, content=posts, content_rowid='rowid')` + 3 triggers (`AFTER INSERT`, `AFTER UPDATE`, `AFTER DELETE`) that keep the shadow in sync |
| DuckDB   | `PRAGMA create_fts_index('posts', 'id', 'title', 'body')` (uses the `fts` extension; one call per table covers every searchable column) |
| Mongo    | `db.posts.createIndex({ title: 'text', body: 'text' })` — Mongo only allows one text index per collection so all searchable fields share it |
| MSSQL    | No DDL emitted. SQL Server's full-text engine needs a catalog created out-of-band; the `searchable` marker is preserved on the schema so doctor + introspect can see it. At query time `searchClause` falls back to `LIKE '%q%'` so portability holds — see the MSSQL section below |

The Postgres index name follows the pattern
`forge_<table>_fts_<column>`. MySQL uses `ft_<table>_<column>`. SQLite
fixes the shadow name at `<table>_fts`. The names are stable so you can
introspect, drop, or rewrite outside forge without breaking the runtime.

### Where the SQLite shadow table lives

SQLite is the only dialect that physically duplicates the data — the
FTS5 virtual table stores its own tokenized index alongside the base
table. Forge sets `content=posts` and `content_rowid='rowid'`, which
turns FTS5 into a "contentless" index against the base rowid. Storage
overhead is one tokenized copy of the searchable columns, not two full
copies. The three triggers fire on every base-table write, so the
shadow stays consistent without a rebuild step.

```sql
-- What forge actually emits on push, with comments stripped:
CREATE VIRTUAL TABLE IF NOT EXISTS "posts_fts" USING fts5(
  "title", "body", content="posts", content_rowid='rowid'
);
CREATE TRIGGER IF NOT EXISTS "posts_ai" AFTER INSERT ON "posts" BEGIN
  INSERT INTO "posts_fts"(rowid, "title", "body")
    VALUES (new.rowid, new."title", new."body");
END;
CREATE TRIGGER IF NOT EXISTS "posts_ad" AFTER DELETE ON "posts" BEGIN
  INSERT INTO "posts_fts"("posts_fts", rowid, "title", "body")
    VALUES('delete', old.rowid, old."title", old."body");
END;
CREATE TRIGGER IF NOT EXISTS "posts_au" AFTER UPDATE ON "posts" BEGIN
  INSERT INTO "posts_fts"("posts_fts", rowid, "title", "body")
    VALUES('delete', old.rowid, old."title", old."body");
  INSERT INTO "posts_fts"(rowid, "title", "body")
    VALUES (new.rowid, new."title", new."body");
END;
```

The trigger pattern is the FTS5 "delete-then-insert" idiom from the
SQLite docs. It survives partial updates that don't touch a searchable
column because the trigger fires on any UPDATE — small overhead, but
the index never drifts.

---

## The `search` operator — per-dialect translation

The portable form is `where: { col: { search: 'query' } }`. Forge
routes it through `dialect.searchClause()`, which has the contract:

> Given a quoted column reference and a bound parameter, return a SQL
> boolean expression that is `TRUE` iff the row matches the query
> string under the dialect's full-text rules.

The dialects implement it like this:

| Dialect  | Generated expression |
|----------|----------------------|
| Postgres | `to_tsvector('simple', "title") @@ plainto_tsquery('simple', $1)` |
| MySQL    | `` MATCH(`title`) AGAINST (? IN NATURAL LANGUAGE MODE) `` |
| SQLite   | `"posts".rowid IN (SELECT rowid FROM "posts_fts" WHERE "posts_fts" MATCH ?)` |
| DuckDB   | `"title" ILIKE '%' || ? || '%'` — the DuckDB FTS extension is opt-in; the portable clause stays case-insensitive without it |
| Mongo    | `{ $text: { $search: 'query' } }` — promoted to top level of the filter, not nested under the field key |
| MSSQL    | `"title" LIKE '%' + @p1 + '%'` — fallback; rewrite to `CONTAINS("title", @p1)` in raw if you've installed and configured the SQL Server Full-Text Search component |

A few things to notice:

- **The translation is per column.** Combining multiple searchable
  columns into one query is dialect-specific — see
  [Multi-column FTS](#multi-column-fts).
- **Postgres uses `plainto_tsquery` by default** (every word ANDed,
  punctuation stripped). For phrase / boolean / negation syntax you
  drop to raw with `websearch_to_tsquery`, which is what the
  [Hybrid search](#hybrid-search-bm25--vector) and ranking examples
  below do. The default keeps the portable operator safe — strings
  with stray quotes or backslashes never throw.
- **MySQL natural-language mode** silently drops queries that match
  more than 50% of rows (the "common-word threshold"). On small dev
  databases your search returns zero hits even though the data
  obviously matches. Boolean mode bypasses the threshold — pass
  `IN BOOLEAN MODE` via raw if your dev corpus is too small.
- **SQLite's subquery form** means the search clause composes
  cleanly with `org_id = ?`, `deleted_at IS NULL`, `take`, `orderBy`
  and all the rest. The query planner picks the FTS5 path when the
  rowid IN list is selective.
- **Mongo's `$text`** is collection-wide, not per-field. Forge
  promotes the operator to the top of the filter when it sees a
  `search` leaf; if you put `search` on two different fields in the
  same query the second wins (Mongo doesn't allow two `$text`
  operators in one query).

---

## Query syntax per dialect

The portable `search: 'query string'` form delivers the raw text to
the engine. The engine then parses it according to its own grammar.
Forge does not normalize across grammars — that's deliberate: stripping
characters to satisfy the weakest engine would silently degrade search
on the others.

| Feature           | Postgres (`plainto_tsquery`) | Postgres (`websearch_to_tsquery`) | MySQL (NL) | MySQL (Boolean) | SQLite FTS5 | Mongo `$text` |
|-------------------|------------------------------|------------------------------------|------------|------------------|-------------|---------------|
| Word AND          | implicit (all words)         | implicit                           | implicit   | implicit         | implicit    | implicit      |
| Phrase ("a b")    | no                           | yes — `"a b"`                      | no         | yes — `"a b"`    | yes — `"a b"`| yes — `"a b"` |
| Prefix (`stem*`)  | no                           | no                                 | no         | yes — `stem*`    | yes — `stem*`| no            |
| Negation (`-foo`) | no                           | yes — `-foo`                       | no         | yes — `-foo`     | yes — `NOT foo` | yes — `-foo` |
| OR (`a OR b`)     | no                           | yes — `or`                         | no         | no               | yes — `OR`  | yes (whitespace = OR) |

The portable `search:` operator uses the safe parser on each engine
(`plainto_tsquery` on PG, natural-language on MySQL, FTS5's standard
parser on SQLite, `$text` on Mongo). When you want phrase / prefix /
boolean behavior, drop to raw on PG and MySQL; SQLite and Mongo
already parse those forms through the portable operator.

```ts
// PG: phrase + negation. Drop to raw for websearch_to_tsquery.
const rows = await db.$queryRaw<{ id: string }[]>`
  SELECT id FROM posts
  WHERE to_tsvector('english', body)
        @@ websearch_to_tsquery('english', ${`"database wrapper" -prisma`})
`;

// MySQL: prefix match needs boolean mode.
const rows = await db.$queryRaw<{ id: string }[]>`
  SELECT id FROM posts
  WHERE MATCH(body) AGAINST(${'data*'} IN BOOLEAN MODE)
`;
```

---

## Languages and analyzers

Tokenization, stemming, and stop-word handling are the part of FTS
that's least portable. Forge defaults to the most permissive
configuration so the operator works without setup; you opt in to a
specific language by passing it through raw or by configuring the
index out-of-band.

### Postgres

The default index is over `to_tsvector('simple', col)`. `simple`
splits on whitespace and lowercases, but does no stemming —
`databases` and `database` are different tokens. To switch language,
declare the searchable field with a custom `expression:` index:

```ts
const Post = model('posts', {
  id:    f.id(),
  body:  f.text().searchable(),
}, {
  indexes: [
    {
      // English stemming. Snowball-based; 'databases' → 'databas'.
      name:       'idx_posts_body_en',
      method:     'gin',
      expression: `to_tsvector('english', body)`,
    },
  ],
});
```

Then query with the matching configuration:

```ts
const rows = await db.$queryRaw<{ id: string }[]>`
  SELECT id FROM posts
  WHERE to_tsvector('english', body) @@ plainto_tsquery('english', ${q})
`;
```

Built-in configs: `simple`, `english`, `french`, `german`, `spanish`,
`italian`, `portuguese`, `dutch`, `swedish`, `russian`, plus the rest
of the Snowball list. For CJK, install `zhparser` (Postgres extension)
and use `'chinese'`. For Arabic and Hebrew, install `pg_trgm` and
combine with a trigram index — Snowball doesn't cover them well.

### MySQL

InnoDB FULLTEXT defaults to a built-in parser that handles
whitespace-delimited languages reasonably. CJK and other scripts that
don't whitespace-delimit need the **ngram** parser:

```ts
const Post = model('posts', {
  id:   f.id(),
  body: f.text().searchable(),
}, {
  indexes: [
    {
      name:   'ft_posts_body_ngram',
      method: 'fulltext',
      keys:   { body: 1 },
      parser: 'ngram',     // or 'mecab' for Japanese
    },
  ],
});
```

`ngram_token_size` (server variable, default `2`) controls n-gram
width. `2` matches CJK convention; `1` makes single-character queries
hit, at the cost of much larger indexes. Set it server-wide before
loading data — changing it requires a rebuild.

### SQLite

FTS5 ships three tokenizers: `unicode61` (default — Unicode-aware
case folding + accent stripping), `porter` (English Porter stemmer
layered over `unicode61`), and `trigram` (every 3-character slice).
Pick at index-create time via the `tokenize=` argument. Forge's
default is `unicode61`. Override with a raw index alongside the
auto-emitted shadow:

```sql
-- Created out of band; forge keeps its shadow and you maintain this one.
CREATE VIRTUAL TABLE posts_fts_porter USING fts5(
  title, body,
  content='posts', content_rowid='rowid',
  tokenize='porter unicode61 remove_diacritics 2'
);
```

`trigram` is the answer to "search-as-you-type with prefixes shorter
than 3 chars" — see [pattern (a)](#a-search-as-you-type-with-prefix-matching).

### Mongo

`text` indexes take a `default_language` (defaults to `english`) and
an optional per-document `language` override (Mongo reads a `language`
field on each doc). Supported languages cover the Snowball set. CJK is
not natively supported — switch to Atlas Search for production CJK
workloads.

```ts
// Mixed-language storefront: per-doc language override.
const Listing = model('listings', {
  id:       f.id(),
  title:    f.string().searchable(),
  body:     f.text().searchable(),
  language: f.string(),   // 'english' | 'french' | ...
});

// On push, forge creates the text index. Mongo reads listing.language
// on each doc and applies the right stemmer.
```

### Worked: English + Yoruba in the same column

Yoruba uses Latin script with tone-marked vowels (à, á, ẹ, ọ).
Stemmers don't exist for it on any of the dialects, so the only
real choices are "tokenize whitespace + match exactly" (PG `simple`,
SQLite `unicode61 remove_diacritics 0`) or "fold diacritics and
match loosely" (`unicode61 remove_diacritics 1`).

For a bilingual product catalog where the customer might type
`bata` or `bàtà`, the loose form wins:

```ts
// SQLite — fold diacritics so `bata` matches `bàtà`.
await db.$executeRaw`
  CREATE VIRTUAL TABLE products_fts USING fts5(
    title, body,
    content='products', content_rowid='rowid',
    tokenize='unicode61 remove_diacritics 1'
  )
`;

// PG equivalent — unaccent + simple.
// CREATE EXTENSION unaccent;
// CREATE INDEX idx_products_body_unac ON products
//   USING gin(to_tsvector('simple', unaccent(body)));
```

The trade-off: diacritic-folding loses meaning in French and Vietnamese
where accents distinguish words. Pick per-corpus, not globally.

---

## Ranking and scoring

The portable `search` operator returns rows matched, not ranked.
Ranking is engine-specific enough that forge doesn't try to expose it
through the typed API — drop to `$queryRaw` and let the dialect score.

### Postgres — `ts_rank` / `ts_rank_cd`

`ts_rank` gives a 0-1 cosine-like score weighted by lexeme frequency;
`ts_rank_cd` is the "cover-density" variant that rewards term
proximity in the document.

```ts
const ranked = await db.$queryRaw<{ id: string; title: string; rank: number }[]>`
  SELECT
    id,
    title,
    ts_rank_cd(to_tsvector('english', body), websearch_to_tsquery('english', ${q})) AS rank
  FROM posts
  WHERE to_tsvector('english', body) @@ websearch_to_tsquery('english', ${q})
    AND org_id = ${orgId}
  ORDER BY rank DESC
  LIMIT 20
`;
```

Tip: the `to_tsvector` call in `ts_rank_cd` is re-running tokenization
on every match. Materialize a `tsvector` generated column to avoid it:

```sql
ALTER TABLE posts ADD COLUMN body_tsv tsvector
  GENERATED ALWAYS AS (to_tsvector('english', body)) STORED;
CREATE INDEX idx_posts_body_tsv ON posts USING gin(body_tsv);
```

Then `ts_rank_cd(body_tsv, …)` reads the precomputed column.

### SQLite — `bm25(<table>_fts)`

FTS5 exposes BM25 as a built-in ranking function. Lower scores mean
better matches in FTS5's convention — sort ascending.

```ts
const ranked = await db.$queryRaw<{ id: string; title: string; rank: number }[]>`
  SELECT p.id, p.title, bm25(posts_fts) AS rank
  FROM posts_fts
  JOIN posts p ON p.rowid = posts_fts.rowid
  WHERE posts_fts MATCH ${q}
    AND p.org_id = ${orgId}
  ORDER BY rank
  LIMIT 20
`;
```

`bm25()` accepts per-column weights as positional args:
`bm25(posts_fts, 10.0, 1.0)` weights the first FTS5 column (title)
ten times the second (body).

### MySQL — `MATCH … AGAINST` returns the score

The same `MATCH(col) AGAINST(?)` expression is a numeric in the
SELECT list. Reuse it for ordering — MySQL is smart enough to compute
the score once.

```ts
const ranked = await db.$queryRaw<{ id: string; title: string; rank: number }[]>`
  SELECT id, title, MATCH(body) AGAINST(${q}) AS rank
  FROM posts
  WHERE MATCH(body) AGAINST(${q})
    AND org_id = ${orgId}
  ORDER BY rank DESC
  LIMIT 20
`;
```

Boolean mode returns scores too, but the formula differs (it's a sum
of operator weights, not BM25). Don't mix modes in the same query.

### Mongo — `$meta: 'textScore'`

Mongo computes a TF-IDF-ish score on every `$text` match. Pull it via
the `$meta` projection and sort by it.

```ts
// $queryRaw for Mongo is an aggregation pipeline — pass it through
// the adapter's runCommand for now (db.$queryRaw on Mongo is the SQL
// shim and won't accept this shape).
const ranked = await db.posts.collection!.find(
  { $text: { $search: q }, org_id: orgId },
  { projection: { score: { $meta: 'textScore' }, title: 1 } },
).sort({ score: { $meta: 'textScore' } }).limit(20).toArray();
```

The `score` value is non-portable; it's only ever useful for sorting
within one query, not for thresholding ("> 0.5 is relevant").

### DuckDB and MSSQL

DuckDB's `fts` extension exposes `match_bm25(score)` after you call
`PRAGMA create_fts_index(...)`. MSSQL with the FTS component exposes
`CONTAINSTABLE(table, col, q)` which returns a `RANK` column — same
pattern as the others.

---

## Multi-column FTS

The decoration is per-field. How forge composes a query that searches
across more than one searchable column is dialect-specific.

| Dialect  | Multi-column behaviour |
|----------|------------------------|
| Postgres | Each searchable column gets its own GIN index. The portable `search:` only hits one column at a time. For composite search use a generated `tsvector` over `title \|\| ' ' \|\| body`. |
| MySQL    | The portable `search:` hits the per-column FULLTEXT. For composite, declare a composite FULLTEXT: `method: 'fulltext'`, `keys: { title: 1, body: 1 }` — then `MATCH(title, body) AGAINST(?)`. |
| SQLite   | All `.searchable()` columns on the same table share one FTS5 shadow. `MATCH ?` against the shadow searches every column. To target one column: `MATCH 'title: alice'`. |
| Mongo    | All `.searchable()` columns share one text index. `$text` searches every indexed field. Per-field weights via `weights: { title: 10, body: 1 }` on the index. |

The composite-`tsvector` PG pattern, expanded:

```ts
const Post = model('posts', {
  id:     f.id(),
  title:  f.string(),                  // not .searchable() — covered by composite
  body:   f.text(),
  tags:   f.json<string[]>(),
}, {
  indexes: [
    {
      name:       'idx_posts_search',
      method:     'gin',
      expression: `to_tsvector(
        'english',
        coalesce(title, '') || ' ' || coalesce(body, '') || ' ' ||
        coalesce((SELECT string_agg(value, ' ') FROM jsonb_array_elements_text(tags)), '')
      )`,
    },
  ],
});
```

Then query via raw — there's no way to express the composite vector
through the portable `search:` operator on PG:

```ts
const hits = await db.$queryRaw<{ id: string }[]>`
  SELECT id FROM posts
  WHERE to_tsvector(
    'english',
    coalesce(title, '') || ' ' || coalesce(body, '') || ' ' ||
    coalesce((SELECT string_agg(value, ' ') FROM jsonb_array_elements_text(tags)), '')
  ) @@ plainto_tsquery('english', ${q})
`;
```

The MySQL composite-FULLTEXT lets you keep the typed query path:

```ts
const Post = model('posts', {
  id:    f.id(),
  title: f.string().searchable(),
  body:  f.text().searchable(),
}, {
  indexes: [
    { name: 'ft_posts_title_body', method: 'fulltext', keys: { title: 1, body: 1 } },
  ],
});
```

SQLite is the cleanest: declare `.searchable()` on every column you
care about, and the auto-emitted shadow covers all of them in one
index. The query `where: { title: { search: q } }` is equivalent to
`where: { body: { search: q } }` because both translate to a
`MATCH` against the shared shadow.

---

## Stop words and customization

Stop-word handling defines what counts as a "word worth indexing"
versus noise. The defaults are language-aware and almost always too
aggressive for technical content.

| Dialect  | Default stop-word handling | How to change it |
|----------|----------------------------|------------------|
| Postgres | Per-language dictionary; `english` strips `a`, `the`, `is`, ~127 words. `simple` strips none. | `CREATE TEXT SEARCH DICTIONARY` + `ALTER TEXT SEARCH CONFIGURATION`. Out-of-band. |
| MySQL    | Built-in 36-word list (InnoDB). | Set `innodb_ft_server_stopword_table` to a table you populate; restart needed. |
| SQLite   | `unicode61` strips none; `porter` strips none. FTS5 has no built-in stop list. | Strip at write time, or use a custom tokenizer. |
| Mongo    | Per-language list, hidden. | Use `none` as language to disable, or strip at write. |

The "drop stop words" hurts when:

- **Technical search** — terms like "I/O", "if", "as", "do" are
  meaningful in code search. Use `simple` (PG), an empty stopword
  table (MySQL), or `unicode61` without a stemmer (SQLite).
- **Short queries** — "the doors" parsed under `english` becomes
  `door`, losing distinction from "doors". For exact-product-name
  search, switch to `simple`.
- **Single-character languages** — Chinese, Japanese, Korean. The
  default tokenizers won't split usefully. See `ngram` (MySQL) and
  the language section above.

When in doubt, switch to `simple` (PG) / no stopwords (MySQL) /
`unicode61` (SQLite). The cost of recall lost to over-aggressive
stopping is much worse than the cost of slightly larger indexes.

---

## Searchable + soft-delete

`f.text().searchable()` on a model with `softDelete: 'deleted_at'`
creates a problem: the FTS index keeps tokenizing rows that should be
hidden. The fix is a partial-filter index excluding the soft-deleted
rows.

### Postgres

```ts
const Post = model('posts', {
  id:         f.id(),
  body:       f.text(),
  deleted_at: f.dateTime().nullable(),
}, {
  softDelete: { field: 'deleted_at' },
  indexes: [
    {
      name:       'idx_posts_body_live',
      method:     'gin',
      expression: `to_tsvector('english', body)`,
      where:      `deleted_at IS NULL`,
    },
  ],
});
```

Forge's read path adds `deleted_at IS NULL` automatically when
`softDelete` is set, so the partial-filter and the runtime filter line
up. The index is roughly half the size of an unfiltered one on a
typical 30%-deleted archive table.

### MySQL

MySQL's FULLTEXT doesn't accept a `WHERE` clause on the index. The
workaround is to maintain a `live_body` generated column that is
`NULL` when deleted and a copy of `body` when live, then index
`live_body`:

```sql
ALTER TABLE posts ADD COLUMN live_body text
  GENERATED ALWAYS AS (CASE WHEN deleted_at IS NULL THEN body END) VIRTUAL;
ALTER TABLE posts ADD FULLTEXT (live_body);
```

### SQLite

The auto-trigger emits writes for every row. The cleanest fix is a
soft-delete-aware trigger — replace the default `AFTER UPDATE` trigger
with one that deletes from the shadow when `deleted_at` becomes
non-null:

```sql
DROP TRIGGER posts_au;
CREATE TRIGGER posts_au AFTER UPDATE ON posts BEGIN
  INSERT INTO posts_fts(posts_fts, rowid, body) VALUES('delete', old.rowid, old.body);
  INSERT INTO posts_fts(rowid, body)
    SELECT new.rowid, new.body WHERE new.deleted_at IS NULL;
END;
```

### Mongo

Text indexes don't take partial-filter expressions directly the way
b-tree indexes do — but `createIndex` accepts `partialFilterExpression`
on text indexes since 4.4:

```ts
await db.posts.collection!.createIndex(
  { body: 'text' },
  { partialFilterExpression: { deleted_at: null } },
);
```

Forge doesn't emit this from the schema yet — add it once at push
time outside the wrapper.

---

## Searchable embeds and JSON

Searchable fields on `f.embed()` / `f.embedMany()` / `f.json()`
columns are limited by what each dialect can tokenize through a JSON
extract.

### Postgres

`to_tsvector` accepts text — extract first, vectorize after.

```sql
CREATE INDEX idx_orders_addr_search ON orders USING gin(
  to_tsvector('english',
    coalesce(addr->>'street', '') || ' ' ||
    coalesce(addr->>'city', '') || ' ' ||
    coalesce(addr->>'country', ''))
);
```

For arrays, use `jsonb_path_query_array` to collect every match
into one text blob:

```sql
CREATE INDEX idx_posts_tags_search ON posts USING gin(
  to_tsvector('simple',
    (SELECT string_agg(value, ' ')
     FROM jsonb_array_elements_text(tags)))
);
```

### MySQL

JSON + FULLTEXT only works through a generated column. The generated
column is a scalar `text`, so you can stack a `FULLTEXT` index on it.

```sql
ALTER TABLE orders
  ADD COLUMN addr_search text GENERATED ALWAYS AS (
    concat_ws(' ',
      JSON_UNQUOTE(JSON_EXTRACT(addr, '$.street')),
      JSON_UNQUOTE(JSON_EXTRACT(addr, '$.city')),
      JSON_UNQUOTE(JSON_EXTRACT(addr, '$.country')))
  ) STORED;
ALTER TABLE orders ADD FULLTEXT (addr_search);
```

### SQLite

FTS5 stores text as-is. Extract at write time into a regular text
column you mark `.searchable()`:

```ts
const Order = model('orders', {
  id:          f.id(),
  addr:        f.embed({ street: f.string(), city: f.string(), country: f.string() }),
  addr_search: f.text().searchable(),    // derived; populate in beforeWrite hook
});

db.$events.on('beforeWrite', ({ model, data }) => {
  if (model !== 'orders' || !data.addr) return;
  data.addr_search = [data.addr.street, data.addr.city, data.addr.country]
    .filter(Boolean).join(' ');
});
```

### Mongo

Mongo's text index accepts a wildcard form that searches every string
field in the document:

```ts
await db.orders.collection!.createIndex({ '$**': 'text' });
```

Slower and indexes more than you want — useful for low-volume
admin search, less so for hot paths.

---

## Hybrid search (BM25 + vector)

Pure BM25 misses paraphrase ("reverse a payment" vs "refund a
charge"). Pure vector misses exact-match queries (model numbers,
acronyms, error codes). Hybrid search runs both, then merges with
Reciprocal Rank Fusion.

The full pipeline — both lanes, RRF merge, dedup, hydration — is in
[VECTOR.md → Hybrid search](./VECTOR.md#hybrid-search--bm25--vector-with-rrf).
What follows is the FTS half in isolation, ready to feed into RRF.

```ts
// PG lexical lane. Returns ranked ids only — keep the payload light
// so the RRF merge is fast.
async function lexical(query: string, orgId: string, take = 50) {
  return db.$queryRaw<{ id: string; rank: number }[]>`
    SELECT id, ts_rank_cd(to_tsvector('english', body),
                          websearch_to_tsquery('english', ${query})) AS rank
    FROM posts
    WHERE to_tsvector('english', body) @@ websearch_to_tsquery('english', ${query})
      AND org_id = ${orgId}
      AND deleted_at IS NULL
    ORDER BY rank DESC
    LIMIT ${take}
  `;
}
```

`websearch_to_tsquery` is the right parser here — it handles phrases
in quotes, `-negation`, and `or` naturally, which is what real users
type into search boxes.

SQLite + sqlite-vec:

```ts
async function lexicalSqlite(query: string, orgId: string, take = 50) {
  return db.$queryRaw<{ id: string; rank: number }[]>`
    SELECT p.id, bm25(posts_fts) AS rank
    FROM posts_fts
    JOIN posts p ON p.rowid = posts_fts.rowid
    WHERE posts_fts MATCH ${query}
      AND p.org_id = ${orgId}
      AND p.deleted_at IS NULL
    ORDER BY rank
    LIMIT ${take}
  `;
}
```

The semantic lane and the RRF merge are in
[VECTOR.md → Hybrid search](./VECTOR.md#hybrid-search--bm25--vector-with-rrf).

---

## Incremental indexing and rebuilds

Every dialect maintains its FTS index automatically as rows change.
The rebuild patterns are for when configuration changes (new language,
new stopword list, new tokenizer) and the existing index is stale.

| Dialect  | Auto-maintained on write? | Rebuild command |
|----------|---------------------------|-----------------|
| Postgres | Yes — the GIN index updates inline on INSERT / UPDATE / DELETE. With a generated `tsvector` column, the column itself recomputes. | `REINDEX INDEX idx_posts_body_en;` (online with `CONCURRENTLY`) |
| MySQL    | Yes — FULLTEXT updates on commit. Bulk writes can batch into the "FTS auxiliary tables" and flush via `OPTIMIZE TABLE`. | `OPTIMIZE TABLE posts;` (rebuilds the FT auxiliary tables) |
| SQLite   | Yes — the three triggers fire on every write. | `INSERT INTO posts_fts(posts_fts) VALUES('rebuild');` — the FTS5 'rebuild' command. |
| DuckDB   | No — `PRAGMA create_fts_index` is a snapshot. Re-run after bulk loads. | `PRAGMA drop_fts_index('posts'); PRAGMA create_fts_index('posts', 'id', 'title', 'body');` |
| Mongo    | Yes — text index updates on write. | `db.posts.reIndex()` (locks the collection — use `dropIndex` + `createIndex` for hot rebuilds). |
| MSSQL    | No (manual catalog). | Per FTS catalog: `ALTER FULLTEXT CATALOG <cat> REBUILD`. |

The MySQL OPTIMIZE pattern matters more than it looks: heavy bulk
inserts accumulate in the auxiliary "INSERT" table and don't show up
in queries until either a `OPTIMIZE TABLE` runs or the auxiliary
table fills past `innodb_ft_total_cache_size` and flushes. Schedule
an OPTIMIZE after large imports.

---

## Highlighting

Returning marked-up snippets ("...the **database wrapper** was...")
is a per-dialect feature. Forge doesn't wrap it — drop to raw.

### Postgres — `ts_headline`

```ts
const rows = await db.$queryRaw<{ id: string; snippet: string }[]>`
  SELECT
    id,
    ts_headline(
      'english',
      body,
      websearch_to_tsquery('english', ${q}),
      'StartSel=<mark>, StopSel=</mark>, MaxFragments=2, MinWords=15, MaxWords=35'
    ) AS snippet
  FROM posts
  WHERE to_tsvector('english', body) @@ websearch_to_tsquery('english', ${q})
  LIMIT 20
`;
```

`ts_headline` is expensive — it re-tokenizes the document for every
result. Cap with `LIMIT` before, never after.

### SQLite — `snippet()` / `highlight()`

```ts
const rows = await db.$queryRaw<{ id: string; snippet: string }[]>`
  SELECT
    p.id,
    snippet(posts_fts, 1, '<mark>', '</mark>', '…', 32) AS snippet
  FROM posts_fts
  JOIN posts p ON p.rowid = posts_fts.rowid
  WHERE posts_fts MATCH ${q}
  LIMIT 20
`;
```

`snippet(fts_table, col_index, open_tag, close_tag, ellipsis,
max_tokens)` — the second arg is the FTS5 column index (0-based),
or `-1` to pick the best match across columns.

### MySQL — no native; post-process

MySQL has no built-in highlight function. Pull the body and wrap on
the client:

```ts
function highlight(body: string, terms: string[]) {
  const re = new RegExp(`(${terms.map(escapeRe).join('|')})`, 'gi');
  return body.replace(re, '<mark>$1</mark>');
}
```

### Mongo — manual

Same shape as MySQL: pull the body, post-process. Mongo's `$text`
exposes no highlight in the wire protocol.

---

## Performance and when to switch engines

Rough numbers from public benchmarks against a 1M-row text corpus
with ~300 tokens per row. Treat as orientation, not promises.

| Engine | Index size vs base | Write tput overhead | Median query latency | Best fit |
|--------|-------------------|---------------------|----------------------|----------|
| PG GIN tsvector | 20-40% | 15-30% slower writes | 5-30 ms | Default for most apps. Already on Postgres → free. |
| PG GIN + generated tsvector column | 40-60% | 20-40% slower writes | 2-10 ms | Apps doing heavy ranking + highlight. Ranking gets ~3× cheaper. |
| MySQL FULLTEXT | 15-30% | 10-20% slower writes | 8-40 ms | Default for InnoDB apps. Auxiliary-table flush behavior bites bulk loaders. |
| SQLite FTS5 (unicode61) | 50-80% | 20-40% slower writes | 1-5 ms (under 1M rows) | The default for embedded / browser / single-tenant apps. |
| SQLite FTS5 (trigram) | 200-400% | 40-60% slower writes | 3-10 ms | Search-as-you-type with 1-2 char prefixes. |
| Mongo text | 10-25% | 10-20% slower writes | 10-50 ms | Mongo-native apps under ~10M docs. Above that, Atlas Search. |
| DuckDB fts | 25-45% | re-index on bulk | 3-15 ms | Analytics / OLAP corpora. Not great for live writes. |

The "switch to a dedicated search engine" decision points:

- **Corpus over ~10M documents** — every dialect's FTS slows down,
  but the dedicated engines (Meilisearch, Typesense, Elasticsearch)
  have inverted-index optimizations the general-purpose ones don't.
- **Multi-tenant with per-tenant ranking models** — none of the
  built-in FTS engines support tenant-specific stopword lists or
  ranking weights. Dedicated engines do.
- **Faceted search at speed** — Postgres can do facets with
  aggregations, but a dedicated engine returns 1M-row facet counts in
  single-digit ms.
- **Typo tolerance** — Meilisearch / Typesense have it built in.
  Postgres needs `pg_trgm` + raw SQL; SQLite needs `trigram`
  tokenizer + custom logic.

If you don't hit those, stay in-database. The data-locality win
(joining FTS results to other tables in one query) is large.

---

## Six worked patterns

### (a) Search-as-you-type with prefix matching

The user types `dat`. You want every row whose searchable text
contains a word starting with `dat`.

**SQLite — FTS5 prefix syntax** works for prefixes ≥ 3 chars:

```ts
const q = userInput;
const rows = await db.$queryRaw<{ id: string; title: string }[]>`
  SELECT p.id, p.title
  FROM posts_fts
  JOIN posts p ON p.rowid = posts_fts.rowid
  WHERE posts_fts MATCH ${q + '*'}    -- the * is FTS5's prefix marker
  LIMIT 10
`;
```

For 1-2 char prefixes, FTS5 falls over (the prefix is below the token
size). Two options:

- Create a trigram-tokenized FTS5 alongside the default:

  ```sql
  CREATE VIRTUAL TABLE posts_fts_tri USING fts5(
    title, body, content='posts', content_rowid='rowid',
    tokenize='trigram remove_diacritics 1'
  );
  ```

  Then route prefixes < 3 chars to `posts_fts_tri` with a `LIKE 'da%'`
  fallback for the 1-char case.

- Or short-circuit in app code: for prefixes < 3 chars, use forge's
  `contains` operator. It compiles to `LIKE '%dat%'` which is
  cheap-enough on the same column for low-cardinality inputs.

  ```ts
  const rows = q.length >= 3
    ? await db.posts.findMany({ where: { title: { search: `${q}*` } }, take: 10 })
    : await db.posts.findMany({ where: { title: { startsWith: q } }, take: 10 });
  ```

### (b) Multi-language product catalog (PG tsvector per language + fallback chain)

Store a `language` column per row. Build one searchable index per
language plus a `simple`-language fallback for queries that don't
specify.

```ts
const Product = model('products', {
  id:       f.id(),
  language: f.string(),       // 'english' | 'french' | 'yoruba'
  title:    f.string(),
  body:     f.text(),
}, {
  indexes: [
    { name: 'idx_prod_en', method: 'gin',
      expression: `to_tsvector('english', title || ' ' || body)`,
      where: `language = 'english'` },
    { name: 'idx_prod_fr', method: 'gin',
      expression: `to_tsvector('french',  title || ' ' || body)`,
      where: `language = 'french'`  },
    { name: 'idx_prod_simple', method: 'gin',
      expression: `to_tsvector('simple',  unaccent(title || ' ' || body))` },
  ],
});
```

The fallback `simple` index handles Yoruba (no Snowball stemmer) and
mixed-language queries. The partial-filter language indexes give
proper stemming for the languages you know.

### (c) Email search across subject + body + sender.name + sender.email

```ts
const Email = model('emails', {
  id:      f.id(),
  org_id:  f.string(),
  subject: f.string(),
  body:    f.text(),
  sender:  f.embed({ name: f.string(), email: f.string() }),
});
```

PG: composite generated tsvector over all four sources.

```sql
ALTER TABLE emails ADD COLUMN search_tsv tsvector
  GENERATED ALWAYS AS (
    setweight(to_tsvector('english', coalesce(subject, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(body, '')), 'B') ||
    setweight(to_tsvector('simple',  coalesce(sender->>'name', '')), 'C') ||
    setweight(to_tsvector('simple',  coalesce(sender->>'email', '')), 'D')
  ) STORED;
CREATE INDEX idx_emails_search ON emails USING gin(search_tsv);
```

`setweight` lets ranking weight subject hits above body hits above
sender hits — `ts_rank_cd(search_tsv, q, 32)` applies the weights.

```ts
const hits = await db.$queryRaw<{ id: string; rank: number }[]>`
  SELECT id, ts_rank_cd(search_tsv, websearch_to_tsquery('english', ${q}), 32) AS rank
  FROM emails
  WHERE search_tsv @@ websearch_to_tsquery('english', ${q})
    AND org_id = ${orgId}
  ORDER BY rank DESC
  LIMIT 50
`;
```

### (d) Search within a tenant — combining FTS with `org_id = ?`

The query planner needs to pick "filter by tenant first, then FTS" or
"FTS first, then filter by tenant" depending on which is more
selective. On PG the planner usually gets it right. On SQLite, the
FTS5 subquery is opaque to the planner — wrap it carefully:

```ts
// Good — FTS5 first (highly selective), then the org filter.
const rows = await db.posts.findMany({
  where: {
    org_id: orgId,
    body:   { search: q },
  },
  take: 20,
});

// Compiles to:
//   SELECT … FROM "posts" WHERE
//     "posts".rowid IN (SELECT rowid FROM "posts_fts" WHERE "posts_fts" MATCH ?)
//     AND "org_id" = ?
//   LIMIT 20
```

The order in the WHERE clause is `(FTS5 rowid IN ...) AND org_id = ?`
— SQLite evaluates the FTS5 subquery once and intersects with the
b-tree lookup for `org_id`. If you instead route the query as
`org_id = ? AND search`, SQLite has to scan the org-filtered rows
against the FTS shadow row-by-row, which is much slower at scale.
Forge's planner picks the right order automatically.

### (e) Hybrid: FTS top-K + vector top-K → RRF merge → final top-10

The complete worked example lives at
[VECTOR.md → Hybrid search](./VECTOR.md#hybrid-search--bm25--vector-with-rrf).
This pattern is short because the FTS half is one of the snippets
already shown — what's interesting is the RRF merge.

```ts
async function search(q: string, orgId: string) {
  const lex = await lexical(q, orgId, 50);                  // FTS top-50
  const sem = await semantic(q, orgId, 50);                 // pgvector top-50

  const k = 60;
  const score = new Map<string, number>();
  lex.forEach((r, i) => score.set(r.id, (score.get(r.id) ?? 0) + 1 / (k + i)));
  sem.forEach((r, i) => score.set(r.id, (score.get(r.id) ?? 0) + 1 / (k + i)));

  const ids = [...score.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([id]) => id);
  const rows = await db.posts.findMany({ where: { id: { in: ids } } });
  return ids.map((id) => rows.find((r) => r.id === id)!).filter(Boolean);
}
```

### (f) Highlight matched terms in results UI

Use `ts_headline` (PG) / `snippet` (SQLite) at query time; render the
returned HTML in the client. The two functions emit safe markup, but
treat output as untrusted and run it through DOMPurify before
inserting — the source `body` column is whatever user-submitted text
landed in the row.

```tsx
function ResultCard({ row }: { row: { id: string; snippet: string } }) {
  const safe = useMemo(() => DOMPurify.sanitize(row.snippet), [row.snippet]);
  return <article dangerouslySetInnerHTML={{ __html: safe }} />;
}
```

For Mongo and MySQL where there's no native highlight, the same
client-side highlight regex is fine — split the query into terms,
wrap each match in `<mark>`. Skip terms shorter than 3 chars to avoid
matching common letter combinations.

---

## Common bugs

**Case sensitivity differs across dialects.** PG `to_tsvector` is
case-insensitive in every config. SQLite `unicode61` is too. MySQL
FULLTEXT is by default. But your `LIKE` fallback on MSSQL / DuckDB is
collation-dependent — `LIKE '%Foo%'` may or may not match `foo`
depending on the column collation. Set collation explicitly on the
table.

**Accent folding differs.** SQLite `unicode61 remove_diacritics 0`
treats `café` and `cafe` as different tokens; `remove_diacritics 1`
folds them. PG `simple` doesn't fold; `english` does (after
unaccent). MySQL FULLTEXT depends on collation. If your users expect
"naive" to match "naïve", set `remove_diacritics 1` on SQLite and
install `unaccent` on PG.

**`*` vs `:` in FTS5 prefix syntax.** SQLite FTS5 takes `data*`
(prefix) and `title: data` (column-scoped). `:` without a known column
name is a parse error, not a match — `where: { body: { search: 'a:b' } }`
throws on SQLite. Strip `:` from user input, or escape it.

**MySQL FULLTEXT 50% threshold.** Natural-language mode returns zero
rows if the term appears in more than half the rows. On dev databases
with a handful of rows, *everything* matches more than 50% of rows, so
search "returns nothing". Switch to boolean mode for dev seeds, or
seed enough rows that real queries fall under the threshold.

**Mongo `$text` is collection-wide.** Two `search` operators in the
same query don't AND — the second silently overwrites the first. The
SQL dialects compose `AND`-style. Test cross-dialect queries against
real data, not just type-check.

**`websearch_to_tsquery` vs `plainto_tsquery`.** The first parses
quotes and `-`; the second strips them. If you switch parsers without
re-indexing, scoring shifts — `ts_rank_cd` reads off the `tsvector`,
which doesn't care, but ordering between two runs of the same query
under the two parsers won't match.

**SQLite FTS5 `MATCH` against the wrong column name.** The portable
`search` operator routes via `<table>.rowid IN (... <table>_fts MATCH
...)`. If you rename a `.searchable()` column without re-running
push, the shadow keeps the old column name and the trigger writes
into a column FTS5 has never heard of. Drop and recreate the shadow:

```sql
DROP TABLE posts_fts;
-- Re-run forge push, or:
INSERT INTO posts_fts(posts_fts) VALUES('rebuild');
```

**Generated `tsvector` columns and `pg_dump`.** A `STORED` generated
column exports its value; a `VIRTUAL` one does not. After a restore,
the index is empty until the next write touches each row. Use
`STORED` for production tsvector columns, or run `REINDEX` after
restore.

---

The README's **[Full-text search](../README.md#full-text-search)**
chapter remains the surface map; this file is the long form. The
companion docs are **[VECTOR.md](./VECTOR.md)** for vector and hybrid
search, **[JSON-PATH.md](./JSON-PATH.md)** for indexing JSON columns
under the same operators, and **[GEO.md](./GEO.md)** for the geo
operators that compose with `search` in location-aware queries.
