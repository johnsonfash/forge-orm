# Doctor

`forge doctor` (CLI) and `db.$doctor()` / `browserDoctor()` (runtime) are live capability probes. They connect to the actual database and report what features are present, what's missing, and what to do about each gap.

Companion to the README's **[Doctor](../README.md#doctor)** note and the [MIGRATIONS](./MIGRATIONS.md#forge-doctor) deep-dive's `forge doctor` section. That section is the one-paragraph tour; this file is the full reference: every probe per dialect, the `DoctorReport` shape, fix recipes for each failure mode, and how to wire doctor into CI and production readiness probes.

The browser-side equivalent — `browserDoctor()` for the wasm adapter — is the same idea adapted for a Web Worker and OPFS instead of a Postgres pool. The runtime `$doctor()` dispatches to the right implementation based on the active adapter.

## Contents

* [What doctor does](#what-doctor-does)
* [CLI — `forge doctor`](#cli--forge-doctor)
* [Runtime — `db.$doctor()`](#runtime--dbdoctor)
* [Runtime — `browserDoctor()`](#runtime--browserdoctor)
* [The `DoctorReport` shape](#the-doctorreport-shape)
* [The `BrowserDoctorReport` shape](#the-browserdoctorreport-shape)
* [Per-dialect probe table](#per-dialect-probe-table)
* [Browser-specific probes](#browser-specific-probes)
* [Schema lint pass](#schema-lint-pass)
* [Fix recipes — failure → command](#fix-recipes--failure--command)
* [CI gating pattern](#ci-gating-pattern)
* [Production health checks](#production-health-checks)
* [Cross-reference](#cross-reference)

---

## What doctor does

Doctor is a four-pass probe. Each pass is independent and survives the failures of the others — a broken connection doesn't suppress the driver inventory, an unloadable extension doesn't suppress the schema lint.

1. **Driver inventory** — for every supported adapter (`mongo`, `postgres`, `mysql`, `sqlite`, `duckdb`, `mssql`), checks whether the npm peer driver is installed and reports its version. Read off `package.json` via the `isDriverInstalled()` helper in `src/adapters/missing-driver.ts`.
2. **`DATABASE_URL` shape check** — redacts the password, detects which adapter the URL prefix implies (`postgres:` / `mysql:` / `sqlite:` / `duckdb:` / `mssql:` / `mongodb:`), and confirms the matching driver is present. If the prefix is unknown, prints the workaround: pass `type` explicitly to `createDb({ type, url })`.
3. **Schema lint** — if a schema is reachable via the [resolution cascade](../README.md#pointing-the-cli-at-your-schema), walks every model's indexes and flags impossible combinations: Mongo-only fields on a SQL adapter, SQL-only fields on Mongo, method mismatches like `method: 'spatial'` on Postgres, `parser` set on a non-FULLTEXT index, unnamed indexes that'll diff harder.
4. **Live capability probe** — connects to the database (best-effort; failures are reported, not raised) and runs the dialect-specific probes documented in [the per-dialect table](#per-dialect-probe-table) — extension presence on Postgres, version compatibility on MySQL, `mod_spatialite` loadability on SQLite, the spatial extension on DuckDB, GEOGRAPHY built-in confirmation on MSSQL, replica-set status on Mongo.

The probe does **not** write. It runs `SELECT`, `SHOW`, catalog reads, and (on SQLite) extension-load attempts. A read-only `DATABASE_URL` is sufficient for every probe — wire that for production doctor runs.

The output ends with a section of action items: which drivers to `npm install`, which extensions to `CREATE EXTENSION`, which database upgrades to plan. Everything is copy-pasteable.

---

## CLI — `forge doctor`

```sh
npx forge doctor                              # standard run
npx forge doctor --schema=./src/schema.ts     # explicit schema path
FORGE_SCHEMA_PATH=./src/schema.ts npx forge doctor
```

`DATABASE_URL` is read from `.env` (via `dotenv`) or the environment. There is no `--url` flag — point a different URL at the binary if you need to target another database (`DATABASE_URL=postgres://staging:… npx forge doctor`).

### Schema resolution

Same cascade as `forge push` (covered in the README):

* `--schema=<path>` — explicit
* `FORGE_SCHEMA_PATH=<path>` — env var
* `package.json` `"forge": { "schema": "…" }`
* Conventions, from cwd: `src/schema.ts`, `src/schema.js`, `schema.ts`, `schema.js`, `src/core/database/schema.ts`, `src/db/schema.ts`, `src/database/schema.ts`

If no schema is found, the lint pass is silently skipped — doctor stays useful for the pure-environment case ("did I install the right driver?") even before the schema is wired.

### Exit codes

| Exit | Meaning |
|---|---|
| 0 | Doctor ran. Result is in stdout — read it. |
| 1 | Doctor crashed before producing output (bad arguments, schema didn't parse). |

Doctor does **not** exit non-zero on missing extensions, missing drivers, or schema lint warnings. Those are informational — the report itself tells you what's wrong. If you want a hard CI gate on capability gaps, parse the output (see [CI gating](#ci-gating-pattern)).

### Sample output

```
Forge — environment check

  Drivers installed:
    ✓ pg               8.11.3
    ✓ mongodb          6.3.0
    ✗ mysql2           not installed
    ✗ better-sqlite3   not installed
    ✗ @duckdb/node-api not installed
    ✗ mssql            not installed

  DATABASE_URL:
    postgres://app:****@db.example.com:5432/app  →  postgres adapter  (✓ driver installed)

  Schema lint:
    source: ./src/schema.ts
    ⚠ [Place] index 'idx_place_geo' uses method='spatial' — Postgres has no such access method. The push will fail at DB time. Use 'gist' (geometry) or to_tsvector + gin (fulltext).
    · [Article] index over (slug, published_at) has no explicit name. forge generates one (idx_Article_…), but a named index is easier to diff.

  Live capability probe:
    ✓ Postgres 16.1 reachable
    ✓ PostGIS
    ⚠ pg_trgm (trigram search) NOT installed
           Install: CREATE EXTENSION pg_trgm;
    ✓ btree_gin
    ⚠ btree_gist NOT installed
           Install: CREATE EXTENSION btree_gist;
```

Three sigils: `✓` is fine, `⚠` is a gap with a remediation hint, `✗` is "not present" (driver-side or extension-side).

### When to run `doctor`

* **Once after `npm install forge-orm`** to confirm the right driver is in.
* **Before the first `forge push` on a new environment** to know if extensions need installing.
* **When a query fails with a "function does not exist" or "unknown index method" error** to confirm the live DB has the capability the schema expects.
* **In CI**, as a pre-step before `forge diff --check` and `forge push`. Saves you debugging "why does my diff job fail in CI but not locally" — the doctor output points at the missing extension.
* **At app start in development** — running `npm run forge:doctor` after `npm install` catches the "I forgot to install pg" class of error before the app boots.

---

## Runtime — `db.$doctor()`

The runtime equivalent of the CLI. Available on every adapter once `createDb()` has connected:

```ts
import { createDb } from 'forge-orm';
import { schema } from './schema';

const db = await createDb({ url: process.env.DATABASE_URL!, schema });
const report = await db.$doctor();
console.log(report);
```

Signature:

```ts
$doctor(): Promise<DoctorReport | BrowserDoctorReport>;
```

The return type depends on the active adapter:

| Adapter | Returns |
|---|---|
| `mongo`, `postgres`, `mysql`, `duckdb`, `mssql` | `DoctorReport` (plain — see [the shape](#the-doctorreport-shape)) |
| `sqlite` (server, browser, RN) | `BrowserDoctorReport` (rich — see [the rich shape](#the-browserdoctorreport-shape)) |

The split is intentional: every SQLite path runs through the same probe so an Electron app, a React Native build, and the browser wasm bundle all get the same capability table. On the SQL-server and Mongo adapters there's no environment to feature-detect — the report is a snapshot of "what did `createDb` see" — so the lighter `DoctorReport` shape is enough.

### Why `$doctor()` instead of `forge doctor` for in-app probes

* You're rendering an "is the DB ready" page in the app UI — you can't shell out.
* You're a serverless function with no Node binary on disk — `npx` isn't there.
* You're in the browser, mobile, or Electron — there is no CLI.
* You want the report as JSON (`DoctorReport` is a typed object), not stdout — the CLI is human-readable, the runtime returns a parseable struct.

The CLI is for developer workstations and CI; `$doctor()` is for runtime contexts. Both share the same probe code paths.

### Example: render the report in an admin panel

```tsx
function DbHealth() {
  const { data } = useQuery({
    queryKey: ['db', 'health'],
    queryFn: () => db.$doctor(),
    staleTime: 60_000,
  });
  if (!data) return <Spinner />;
  return (
    <dl>
      <dt>Adapter</dt><dd>{data.kind}</dd>
      <dt>Driver</dt><dd>{data.driverPackage} {data.driverVersion ?? '—'}</dd>
      <dt>Native cascades</dt><dd>{String(data.capabilities.nativeCascades)}</dd>
      <dt>Native upsert</dt><dd>{String(data.capabilities.nativeUpsert)}</dd>
      <dt>JSON path</dt><dd>{String(data.capabilities.jsonPath)}</dd>
    </dl>
  );
}
```

The capabilities block is the same one Forge uses internally when deciding whether to route through native upsert vs the compatibility path — so what the panel shows is exactly what query planning sees.

---

## Runtime — `browserDoctor()`

In the browser the wasm adapter exports a standalone `browserDoctor(driver)` you can call before constructing `createDb()`. Useful when you want to feature-detect first and pick a code path.

```ts
import { wasmSqliteDriver, browserDoctor } from 'forge-orm/wasm';

const worker = new Worker(
  new URL('forge-orm/wasm/worker', import.meta.url),
  { type: 'module' },
);
const driver = wasmSqliteDriver({ worker, url: 'opfs-sahpool:///app.sqlite' });

const report = await browserDoctor(driver);
if (!report.environment.opfs) {
  // Bail before opening — show the user "your browser is too old".
  showUpgradeBanner();
  return;
}

const db = await createDb({ schema, driver });
```

The signature:

```ts
function browserDoctor(driver: SqliteDriver): Promise<BrowserDoctorReport>;
```

It accepts the raw driver (not a `db` handle), so it can run before `createDb()` opens the DB and locks the file. Internally it runs:

1. **Environment detect** (synchronous): runtime kind, OPFS availability, sync-handle support, SharedArrayBuffer, persistent-storage status, quota + usage estimate, user-agent string.
2. **SQLite engine probe** (async): `SELECT sqlite_version()`, plus extension probes for `json1`, `fts5`, `rtree`, `sqlite-vec`, and `PRAGMA foreign_keys`.
3. **Capability mapping**: turns each engine probe into a `native` / `fallback` / `unavailable` verdict for the forge feature it backs (`text.searchable()`, `geoPoint near`, `vector near`, etc.).
4. **Notes**: human-readable warnings + remediation hints — what to do if OPFS isn't there, what fallback `f.geoPoint()` will run on, what to swap in.

This is the same code path `db.$doctor()` takes on the sqlite adapter, exposed standalone for the pre-open use case.

### `db.$doctor()` vs `browserDoctor()` — which to call

| Need | Call |
|---|---|
| Probe before opening the DB (decide URL scheme, decide fallback path) | `browserDoctor(driver)` |
| Probe after `createDb()` (rendering a panel, an admin route) | `db.$doctor()` |
| Server-side, every adapter | `db.$doctor()` |
| Inside a Worker, no `db` yet | `browserDoctor(driver)` |

The objects they return are the same shape on sqlite — `db.$doctor()` is the shorter path when you already have a `db` handle.

---

## The `DoctorReport` shape

The plain shape, returned by every non-sqlite adapter (and exported as `import type { DoctorReport } from 'forge-orm'`):

```ts
interface DoctorReport {
  kind: 'mongo' | 'postgres' | 'mysql' | 'sqlite' | 'duckdb' | 'mssql';
  driverPackage: string;          // e.g. 'pg', 'mysql2', 'mongodb'
  driverInstalled: boolean;
  driverVersion?: string;         // from the peer's package.json
  connectionString?: string;      // the URL passed to createDb (redacted by caller before logging)
  capabilities: AdapterCapabilities;
  notes: string[];                // adapter-author notes — surfaces gotchas the API can't make typed
}

interface AdapterCapabilities {
  nativeCascades:                 boolean;  // does the engine enforce ON DELETE / FK natively?
  nativeUpsert:                   boolean;  // ON CONFLICT / ON DUPLICATE KEY / MERGE / findOneAndUpdate({upsert:true})
  nullsOrdering:                  boolean;  // does the dialect support nulls: 'first' | 'last' in ORDER BY?
  jsonPath:                       boolean;  // native JSON path operators (Postgres, MySQL 8, SQLite json1, MSSQL JSON_VALUE)
  transactionsRequireReplicaSet:  boolean;  // Mongo: true. Everyone else: false.
}
```

### What each field means

* `kind` — which adapter ran the probe. Echoes the `type` you passed to `createDb()` (or the one detected from the URL).
* `driverPackage` — the npm package name of the underlying driver. `'(injected driver)'` if you passed your own via `createDb({ driver })`.
* `driverInstalled` — `true` when forge could `require()` the driver. `false` means the package isn't on disk — `npm install <package>` to fix.
* `driverVersion` — pulled from the driver's own `package.json`. `undefined` for injected drivers (forge doesn't know what version your custom port is).
* `connectionString` — the URL Forge connected with. **Already redacted on the CLI; not redacted by the runtime call** — if you log this directly, redact passwords first.
* `capabilities` — five capability flags that change query-planning behaviour. Forge dispatches on these internally; surfacing them in the report lets you reason about why a query took a fallback path.
* `notes` — free-text strings written by the adapter author. Doesn't try to be exhaustive — they're for "things the typed shape can't express", like the Mongo replica-set requirement or the SQLite "the file path is your database".

### What the report does NOT include

The plain `DoctorReport` is intentionally light — it's the same shape on every adapter so cross-adapter code can read it. It does **not** include:

* Live extension presence (only the CLI's live probe does that — too dialect-specific to fit into a uniform shape).
* Schema lint findings (the CLI surfaces these to stdout; not in the report).
* The driver's pool state, open connection count, transaction stats.

For the rich shape with engine introspection, use the sqlite path (which returns `BrowserDoctorReport`) or read the CLI output.

---

## The `BrowserDoctorReport` shape

```ts
interface BrowserDoctorReport {
  // Synchronous — no DB calls. Reflects the runtime the probe ran in.
  environment: {
    runtime:           'browser' | 'worker' | 'node' | 'unknown';
    opfs:              boolean;
    opfsSyncHandles:   boolean;
    sharedArrayBuffer: boolean;
    persistent:        'granted' | 'requestable' | 'unavailable';
    estimatedQuotaMB?: number;
    estimatedUsageMB?: number;
    userAgent?:        string;
  };

  // SQLite engine — needs an open driver. Each flag is the result of a small
  // try-this-query probe; `false` means the extension isn't compiled into this
  // build, not that the DB is broken.
  sqlite: {
    version?:      string;
    json1:         boolean;
    fts5:          boolean;
    rtree:         boolean;
    sqliteVec:     boolean;
    foreignKeys:   boolean;
  };

  // Forge-feature → verdict. The values shape app branching: 'native' is the
  // fast path, 'fallback' works but is slower, 'unavailable' means the feature
  // is dead in this environment.
  capabilities: Record<string, 'native' | 'fallback' | 'unavailable'>;

  // Human-readable warnings + remediation hints. Render these to the user
  // verbatim — they're the doctor's voice.
  notes: string[];
}
```

### `environment` — what's read

| Field | Source | Meaning |
|---|---|---|
| `runtime` | `globalThis` shape | `'browser'` (Window + document), `'worker'` (WorkerGlobalScope), `'node'` (process.versions.node), `'unknown'` otherwise |
| `opfs` | `navigator.storage.getDirectory` | OPFS available — file-backed persistence is possible |
| `opfsSyncHandles` | `opfs && runtime === 'worker'` | Sync access handles work — only inside a Worker. The sqlite-wasm SAH-pool VFS requires this. |
| `sharedArrayBuffer` | `typeof SharedArrayBuffer !== 'undefined'` | Needed for the threaded wasm build; harmless to lack on the stock build |
| `persistent` | `navigator.storage.persisted()` | `'granted'` if the user already opted in, `'requestable'` if `persist()` would be possible, `'unavailable'` otherwise |
| `estimatedQuotaMB` | `navigator.storage.estimate().quota` | How much disk this origin can use |
| `estimatedUsageMB` | `navigator.storage.estimate().usage` | How much it's used right now |
| `userAgent` | `navigator.userAgent` | For triage logs |

### `sqlite` — how each flag is probed

Each probe is a try-catch wrapping a small query. If the query throws, the flag is `false`:

| Field | Probe |
|---|---|
| `version` | `SELECT sqlite_version() AS v` |
| `json1` | `SELECT json('{}') AS j` — fails on builds without json1 |
| `fts5` | `CREATE VIRTUAL TABLE __forge_doctor_fts USING fts5(x)` then `DROP TABLE` |
| `rtree` | `CREATE VIRTUAL TABLE __forge_doctor_rt USING rtree(id, minX, maxX, minY, maxY)` then `DROP TABLE` |
| `sqliteVec` | `SELECT vec_version() AS v` — only present when sqlite-vec is loaded |
| `foreignKeys` | `PRAGMA foreign_keys` returns 1 |

The CREATE/DROP probes for FTS5 and R-Tree leave no residue — table names start with `__forge_doctor_` and are dropped before the probe returns. Run them as often as you like.

### `capabilities` — the verdict table

The forge feature names match the user-facing API surface. The map is built from the sqlite flags above:

| Feature | `native` when | `fallback` when | `unavailable` when |
|---|---|---|---|
| `softDelete` | always | — | — |
| `unique` | always | — | — |
| `partialFilterIndex` | always | — | — |
| `relationsAndJoins` | always | — | — |
| `aggregations` | always | — | — |
| `transactions` | always | — | — |
| `json(path)` | `sqlite.json1` | — | `!sqlite.json1` |
| `text.searchable() / FTS5` | `sqlite.fts5` | `!sqlite.fts5` (LIKE prefilter) | — |
| `geoPoint near / withinPolygon` | `sqlite.rtree` | `!sqlite.rtree` (bbox + Haversine in JS) | — |
| `vector near / nearTo` | `sqlite.sqliteVec` | `!sqlite.sqliteVec` (brute-force cosine in JS) | — |
| `persistent OPFS storage` | `environment.opfs` | — | `!environment.opfs` |
| `multi-tab safe` | always (SAH pool default) | — | — |

`native` is the fast path. `fallback` works but routes through JS for the heavy lifting — fine to ~50k rows, past that build the pro wasm bundle ([BROWSER.md](./BROWSER.md#custom-wasm-build-vec0--r-tree)). `unavailable` means the feature won't work in this environment at all — render a banner, disable the route, or wipe the offline cache.

---

## Per-dialect probe table

What the CLI's live capability probe runs against each adapter. The runtime probe paths share these same checks via the adapter's `doctor()` method (plus, for sqlite, the rich `browserDoctor` checks above).

### Postgres

| Probe | How | Failure mode |
|---|---|---|
| Connect | `new pg.Client({ connectionString })` then `.connect()` | Auth, network, SSL handshake |
| Version | `SHOW server_version` | — (logged, not gated) |
| PostGIS | `SELECT extname FROM pg_extension WHERE extname='postgis'` | `f.geoPoint()` falls back to JSON storage + Haversine |
| pg_trgm | `extname='pg_trgm'` | `.searchable()` with the trigram opclass won't index |
| btree_gin | `extname='btree_gin'` | Composite GIN indexes mixing scalar + array won't build |
| btree_gist | `extname='btree_gist'` | Composite GiST indexes mixing scalar + spatial won't build |

The full version string is informational — Forge supports Postgres 12+ and doesn't gate on minor version. PostGIS is the headline check: missing PostGIS is the single most-common reason a `forge push` against a schema with `f.geoPoint()` fails at DDL time.

### MySQL

| Probe | How | Failure mode |
|---|---|---|
| Connect | `mysql2.createConnection(url)` | Auth, network |
| Version | `SELECT VERSION() AS v` | Doctor warns if < 8.0 |
| Spatial (SRID-aware) | `version >= 8.0` | Older MySQL has spatial types but not SRID-aware; `POINT NOT NULL SRID 4326` won't parse |

MySQL has no "extensions installed" catalog the way Postgres does — geo is built-in (since 5.7) and full-text is built-in (FULLTEXT indexes ship with the engine). The version gate is what matters: MySQL 8 unlocks SRID-aware spatial + invisible indexes + expression indexes. MariaDB is reported as 10.x or 11.x and treated as MySQL 8+ for SRID purposes.

### SQLite

| Probe | How | Failure mode |
|---|---|---|
| Connect | `new Database(path)` (better-sqlite3) | File missing, file locked |
| SpatiaLite | `db.loadExtension('mod_spatialite')` | Doctor reports load error; geo falls back to JSON + Haversine |

SQLite is the most environment-sensitive of the bunch. `mod_spatialite` doesn't ship with `better-sqlite3` — it has to be installed at the OS level (`brew install libspatialite` on macOS, `apt install libsqlite3-mod-spatialite` on Debian). If it's not there, the doctor's load attempt throws and the report includes both the install command for your OS and the `f.geoPoint({ fallback: true })` escape hatch.

The browser sqlite path runs the richer `browserDoctor` probe (see [the rich shape](#the-browserdoctorreport-shape)).

### DuckDB

| Probe | How | Failure mode |
|---|---|---|
| Connect | `DuckDBInstance.create(path || ':memory:')` | Missing file, version skew |
| Spatial | `INSTALL spatial; LOAD spatial` then read `duckdb_extensions()` | Network error during INSTALL; doctor reports the error verbatim |

DuckDB's extension model is unique: extensions are downloaded on-demand from a public registry. The `INSTALL spatial` call hits the registry the first time and caches locally afterwards. If the runner has no network, the install fails — the doctor surfaces this so you can pre-warm the cache or build with the bundled extensions.

### MSSQL

| Probe | How | Failure mode |
|---|---|---|
| Connect | `mssql.connect(url)` | Auth, TLS, network |
| Version | `SELECT @@VERSION AS v` | — (logged, not gated) |
| GEOGRAPHY built-in | always | — (T-SQL `GEOGRAPHY` is a built-in type since SQL Server 2008) |

MSSQL has the simplest probe of the SQL family — `GEOGRAPHY` is built-in (no extension to install), full-text uses catalogs (out-of-band setup), and there's no equivalent of `pg_extension`. The doctor confirms the connection and surfaces the version string for triage.

### Mongo

| Probe | How | Failure mode |
|---|---|---|
| Connect | `new MongoClient(url)` then `.connect()` | Auth, network, TLS |
| Version | `db().admin().command({ buildInfo: 1 })` | — (logged) |
| 2dsphere built-in | always | — (Mongo has had 2dsphere indexes since 2.4) |

Mongo's doctor is the lightest — there's no DDL, no extensions, no version-gated geo. The probe confirms reachability and surfaces the build info. The one gotcha it doesn't probe is "is this a replica set?" — `$transaction` requires one, and a standalone mongod throws on `startSession()`. If your schema uses transactions, run a quick `db.admin().command({ replSetGetStatus: 1 })` in your app's smoke tests; the doctor flags it as a note but doesn't probe.

---

## Browser-specific probes

The browser doctor extends the SQLite probe set with the environment side of the report. Each row here is a synchronous feature-detect or a navigator API call.

| Probe | Surface | What forge does with it |
|---|---|---|
| `globalThis.Window + document` | `environment.runtime = 'browser'` | Refuses to open OPFS (sync handles need a Worker) |
| `globalThis.WorkerGlobalScope` | `environment.runtime = 'worker'` | OPFS sync handles available |
| `navigator.storage.getDirectory` | `environment.opfs = true` | OPFS persistence is possible; if false, `opfs:` / `opfs-sahpool:` URLs degrade to `:memory:` |
| `opfs && runtime === 'worker'` | `environment.opfsSyncHandles = true` | The SAH pool VFS will work |
| `typeof SharedArrayBuffer` | `environment.sharedArrayBuffer` | Threaded wasm builds need this + COOP/COEP headers |
| `navigator.storage.persisted()` | `'granted' / 'requestable' / 'unavailable'` | App boot prompt: call `navigator.storage.persist()` if `'requestable'` |
| `navigator.storage.estimate()` | `estimatedQuotaMB`, `estimatedUsageMB` | Show in admin panel; warn when usage > 80% of quota |
| `navigator.userAgent` | `userAgent` | Triage logs |

The Safari ITP 7-day eviction (see [BROWSER.md](./BROWSER.md#persistent-storage-and-the-safari-7-day-eviction)) is the failure mode the `persistent` field is most useful for. Two patterns in app code:

```ts
// Pattern 1 — probe-then-prompt at boot.
const report = await browserDoctor(driver);
if (report.environment.persistent === 'requestable') {
  const granted = await navigator.storage.persist();
  if (!granted) {
    showBanner('Your data may be wiped after 7 days of inactivity. Add to Home Screen to keep it.');
  }
}

// Pattern 2 — render an "is my data safe?" panel.
function StoragePanel({ report }: { report: BrowserDoctorReport }) {
  const { persistent, estimatedUsageMB, estimatedQuotaMB } = report.environment;
  return (
    <Card>
      <Row>Storage: {persistent === 'granted' ? 'persistent' : 'evictable'}</Row>
      <Row>Used: {estimatedUsageMB ?? '?'} MB / {estimatedQuotaMB ?? '?'} MB</Row>
      {persistent === 'requestable' && (
        <Button onClick={() => navigator.storage.persist()}>Make persistent</Button>
      )}
    </Card>
  );
}
```

---

## Schema lint pass

The lint pass runs against the active schema (resolved via the [cascade](../README.md#pointing-the-cli-at-your-schema)). It only checks indexes — that's where the dialect mismatches show up most often.

| Finding | Severity | Detection |
|---|---|---|
| Mongo-only field on a SQL adapter | `warn` | `collation`, `wildcardProjection`, or a key value of `'2dsphere'` / `'2d'` / `'hashed'` declared on an index, and the adapter isn't `mongo` |
| SQL-only field on Mongo | `warn` | `method`, `include`, `expression`, `where: string`, `visible: false`, or `parser` declared, and the adapter is `mongo` |
| `method: 'spatial'` on Postgres | `warn` | Postgres uses `gist` (geometry) or `to_tsvector + gin` (fulltext). The named method doesn't exist. |
| `method: 'fulltext'` on Postgres | `warn` | Same — Postgres fulltext is `to_tsvector + gin`. |
| `method: 'gin'/'gist'/'brin'/'hash'` on MySQL | `warn` | MySQL has no such access methods. |
| `parser` set on a non-FULLTEXT index | `warn` | Parser only applies to FULLTEXT indexes; on others it's silently ignored at push, which is worse than crashing. |
| `method: 'gin'` without `expression` | `info` | Just a reminder: GIN needs the right opclass installed (`pg_trgm` for trigram, `btree_gin` for scalar mixed). |
| `method: 'brin'` | `info` | BRIN only helps when the column has high physical-order correlation. Tip, not warning. |
| Unnamed index | `info` | Forge generates a name like `idx_<model>_<col>`, but a named index reads cleaner in diffs. |

The lint pass walks every model's `indexes` array. Findings carry the model name and index name, so the report points you straight at the source line.

A clean lint pass prints `✓ no issues`. A dirty pass prints one line per finding, sorted by model name.

---

## Fix recipes — failure → command

The doctor's output is engineered to be copy-pasteable. This table maps each common failure to the shell command (or the `db.$executeRaw` call) that fixes it.

### Driver-side

| Doctor said | Fix |
|---|---|
| `✗ pg                not installed` | `npm install pg` |
| `✗ mysql2            not installed` | `npm install mysql2` |
| `✗ better-sqlite3    not installed` | `npm install better-sqlite3` (Node) — for browsers use `forge-orm/wasm` instead |
| `✗ @duckdb/node-api  not installed` | `npm install @duckdb/node-api` |
| `✗ mssql             not installed` | `npm install mssql` |
| `✗ mongodb           not installed` | `npm install mongodb` |
| `DATABASE_URL: → unknown prefix` | Pass `type` explicitly: `createDb({ type: 'postgres', url })` |
| `driverInstalled: false` in runtime report | Same install commands as above, then restart the process |

### Postgres extensions

| Doctor said | Fix (run once as a Postgres superuser) |
|---|---|
| `⚠ PostGIS NOT installed` | `CREATE EXTENSION postgis;` |
| `⚠ pg_trgm (trigram search) NOT installed` | `CREATE EXTENSION pg_trgm;` |
| `⚠ btree_gin NOT installed` | `CREATE EXTENSION btree_gin;` |
| `⚠ btree_gist NOT installed` | `CREATE EXTENSION btree_gist;` |
| All of the above in one go | `forge push --enable-extensions` — the push will emit `CREATE EXTENSION IF NOT EXISTS` for whatever the schema needs, provided the role has `CREATEROLE` or superuser |

On managed Postgres (RDS, Cloud SQL, Supabase, Neon), `CREATE EXTENSION` typically requires the `rds_superuser` / `cloudsqlsuperuser` / dashboard "extensions" toggle. The doctor surfaces the missing extension; the platform's docs cover the privilege side.

### MySQL versions

| Doctor said | Fix |
|---|---|
| `⚠ MySQL < 8.0 detected` | Upgrade to MySQL 8.0+ (or MariaDB 10.5+) before declaring `f.geoPoint()`. For 5.7 the schema needs `POINT NOT NULL` without the `SRID 4326` clause — Forge does not auto-downgrade. |

### SQLite extensions

| Doctor said | Fix |
|---|---|
| `⚠ SpatiaLite NOT loaded` (macOS) | `brew install libspatialite` |
| `⚠ SpatiaLite NOT loaded` (Debian/Ubuntu) | `sudo apt install libsqlite3-mod-spatialite` |
| `⚠ SpatiaLite NOT loaded` (Alpine) | `apk add libspatialite` |
| `⚠ SpatiaLite NOT loaded` (Windows) | Download `mod_spatialite-NG-win-amd64.7z` from gaia-gis.it, put the DLL on PATH |
| Don't want to install SpatiaLite at all | Use `f.geoPoint({ fallback: true })` for JSON storage + Haversine post-filter |

### DuckDB extensions

| Doctor said | Fix |
|---|---|
| `⚠ DuckDB spatial extension not loaded` (offline runner) | Pre-warm the extension cache: `duckdb -c "INSTALL spatial; LOAD spatial"` once on a network-capable machine, then commit `~/.duckdb/extensions/` to the runner image |
| `⚠ DuckDB spatial extension unavailable: ...` | Check `https://extensions.duckdb.org` — the version of `@duckdb/node-api` you have determines which extension binaries are compatible. Upgrade the driver if the registry can't serve a match. |

### Browser environment

| Doctor said | Fix |
|---|---|
| `environment.opfs: false` | Browser is too old — Chrome 109+, Edge 109+, Safari 16.4+, Firefox 111+. Until then, `:memory:` fallback. |
| `environment.opfsSyncHandles: false` (and `runtime: 'browser'`) | Move DB calls inside a Worker. The forge worker file at `forge-orm/wasm/worker` does this for you. |
| `environment.persistent: 'requestable'` | `await navigator.storage.persist()` at app boot |
| `environment.persistent: 'unavailable'` | The browser doesn't support `navigator.storage.persist()`. Data lives at the browser's discretion — Safari ITP wipes after 7 days; Chrome only on disk pressure. Treat as cache, not source of truth. |
| `sqlite.fts5: false` | Rare on stock sqlite-wasm (FTS5 is included). If you see it, your bundler shimmed in a different sqlite build — pin `@sqlite.org/sqlite-wasm`. |
| `sqlite.rtree: false` | Stock sqlite-wasm doesn't ship R-Tree. Build the pro bundle ([BROWSER.md](./BROWSER.md#custom-wasm-build-vec0--r-tree)) or accept the Haversine fallback. |
| `sqlite.sqliteVec: false` | Same — pro wasm bundle ships sqlite-vec; stock doesn't. |
| `sqlite.foreignKeys: false` | `PRAGMA foreign_keys = ON` after `connect()` — forge's wasm driver does this automatically; if you see `false`, you bypassed it with a raw connection. |

---

## CI gating pattern

The CLI's exit code doesn't change for missing extensions — that's by design (it's a probe, not a gate). For CI you parse the output. Two approaches.

### (a) Bash + grep — quick gate

```yaml
# .github/workflows/forge-doctor.yml
name: Forge doctor
on: [pull_request]
jobs:
  doctor:
    runs-on: ubuntu-latest
    services:
      postgres:
        image: postgis/postgis:16-3.4
        env: { POSTGRES_PASSWORD: postgres }
        ports: ['5432:5432']
        options: --health-cmd pg_isready
    env:
      DATABASE_URL: postgres://postgres:postgres@localhost:5432/postgres
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20 }
      - run: npm ci
      - name: Pre-create extensions the schema declares
        run: |
          psql "$DATABASE_URL" -c "CREATE EXTENSION IF NOT EXISTS postgis;"
          psql "$DATABASE_URL" -c "CREATE EXTENSION IF NOT EXISTS pg_trgm;"
      - name: Run forge doctor
        id: doctor
        run: npx forge doctor | tee doctor.txt
      - name: Fail on missing extensions or drivers
        run: |
          if grep -qE '⚠.*NOT installed|⚠.*NOT loaded|✗ .* not installed' doctor.txt; then
            echo "::error::forge doctor reports unsupported capabilities"
            cat doctor.txt
            exit 1
          fi
```

The image is `postgis/postgis:16-3.4` (not stock `postgres:16`) so PostGIS is built in. The pre-step `CREATE EXTENSION` calls take care of the rest. The grep is loose on purpose — any `⚠ … NOT …` triggers the failure.

### (b) Programmatic — use `$doctor()` in a small Node script

When you want structured pass/fail instead of grepping:

```ts
// scripts/ci-doctor-gate.ts
import { createDb } from 'forge-orm';
import { schema } from '../src/schema';

const required = new Set(['nativeUpsert', 'jsonPath']);

const db = await createDb({ url: process.env.DATABASE_URL!, schema });
const report = await db.$doctor();

const missing: string[] = [];
for (const cap of required) {
  if (!(report.capabilities as Record<string, boolean>)[cap]) missing.push(cap);
}

if (missing.length > 0) {
  console.error(`Required capabilities missing on ${report.kind}:`, missing.join(', '));
  console.error('Driver:', report.driverPackage, report.driverVersion ?? '?');
  console.error('Notes:', report.notes.join('\n  '));
  process.exit(1);
}

await db.$disconnect();
console.log(`forge doctor: ${report.kind} OK`);
```

Run as `node --loader ts-node/esm scripts/ci-doctor-gate.ts` in the CI step.

### (c) Browser — gate the `npm test` step

For a browser sqlite-wasm app, run the doctor inside a Playwright test:

```ts
// e2e/doctor.spec.ts
import { test, expect } from '@playwright/test';

test('browser doctor reports native FTS5 + persistent storage', async ({ page }) => {
  await page.goto('http://localhost:5173');
  const report = await page.evaluate(async () => {
    const { wasmSqliteDriver, browserDoctor } = await import('forge-orm/wasm');
    const worker = new Worker(new URL('forge-orm/wasm/worker', import.meta.url), { type: 'module' });
    const driver = wasmSqliteDriver({ worker });
    return browserDoctor(driver);
  });

  expect(report.sqlite.fts5).toBe(true);
  expect(report.environment.opfs).toBe(true);
  expect(report.capabilities['text.searchable() / FTS5']).toBe('native');
});
```

This catches "the pro wasm bundle stopped being deployed" before users hit it.

---

## Production health checks

`$doctor()` is cheap enough to run on a liveness/readiness probe. Roughly: a connection check + a few `SELECT 1`-ish queries. Sub-100 ms on a warm pool.

### Kubernetes readiness probe — Node service

```ts
// src/health.ts
import { Router } from 'express';
import { db } from './db';

const router = Router();

router.get('/healthz/ready', async (_req, res) => {
  try {
    const report = await db.$doctor();
    if (!report.driverInstalled) return res.status(503).json({ ready: false, reason: 'driver missing' });
    return res.json({ ready: true, kind: report.kind, driver: report.driverVersion });
  } catch (err) {
    return res.status(503).json({ ready: false, reason: (err as Error).message });
  }
});

export { router as healthRouter };
```

```yaml
# k8s/deployment.yaml — readinessProbe block
readinessProbe:
  httpGet:
    path: /healthz/ready
    port: 3000
  initialDelaySeconds: 5
  periodSeconds: 10
  timeoutSeconds: 3
  failureThreshold: 3
```

The probe wraps `$doctor()` in a try-catch so a broken driver call → 503, the pod stays out of rotation until it can reach the DB. `driverInstalled: false` would only fire on a misbuilt image — but if it does, returning 503 keeps the pod out of the load balancer instead of accepting traffic the DB layer can't serve.

### Vercel/Netlify function — periodic capability snapshot

```ts
// api/cron/db-health.ts — runs every 15 minutes via vercel.json cron
import { createDb } from 'forge-orm';
import { schema } from '@/src/schema';

export const config = { runtime: 'nodejs' };

export default async function handler() {
  const db = await createDb({ url: process.env.DATABASE_URL!, schema });
  const report = await db.$doctor();
  await db.$disconnect();

  // Ship to your observability backend.
  await fetch(`${process.env.METRICS_URL}/forge-doctor`, {
    method: 'POST',
    body: JSON.stringify({
      kind: report.kind,
      driver: report.driverPackage,
      version: report.driverVersion,
      caps: report.capabilities,
      ts: Date.now(),
    }),
  });

  return new Response('ok');
}
```

Surface `caps.nativeUpsert` / `caps.jsonPath` as gauges in Grafana — a drop from 1 → 0 means somebody switched the adapter (e.g. failover to a read replica that's a different engine).

### Browser — at-boot probe

```ts
// src/lib/db-boot.ts
import { createDb } from 'forge-orm';
import { wasmSqliteDriver, browserDoctor } from 'forge-orm/wasm';
import { schema } from './schema';

export async function bootDb() {
  const worker = new Worker(
    new URL('forge-orm/wasm/worker', import.meta.url),
    { type: 'module' },
  );
  const driver = wasmSqliteDriver({ worker, url: 'opfs-sahpool:///app.sqlite' });

  // Probe before opening so we can fall back to :memory: gracefully.
  const probe = await browserDoctor(driver);
  if (!probe.environment.opfs) {
    console.warn('OPFS unavailable — using :memory:. Data will not persist.');
    return createDb({ schema, driver: wasmSqliteDriver({ worker, url: ':memory:' }) });
  }

  const db = await createDb({ schema, driver });
  await db.$migrate();             // see MIGRATIONS.md#runtime-migrate--diff--when-to-use-which

  // Surface to app state.
  globalThis.__forgeReport = await db.$doctor();
  return db;
}
```

Pair this with the React Query `db-health` query in [the runtime example](#runtime--dbdoctor) so the admin panel renders the current state.

---

## Cross-reference

* **[MIGRATIONS.md](./MIGRATIONS.md)** — `forge push`, `forge diff`, `forge rollback`, the migration model, runtime `$migrate()` + `$diff()`. Doctor is a sibling probe; the migration commands are what you run after doctor says "you're ready".
* **[BROWSER.md](./BROWSER.md)** — sqlite-wasm + OPFS reference. `browserDoctor()` shape is duplicated here in DOCTOR.md; the persistent-storage / Safari ITP / multi-tab safety reference lives in BROWSER.md.
* **[GEO.md](./GEO.md)** — `f.geoPoint()` per-dialect details. Read this if doctor flagged a missing PostGIS / SpatiaLite / DuckDB spatial extension — it spells out which feature is unavailable.
* **[VECTOR.md](./VECTOR.md)** — `f.vector()` and per-dialect drivers. If doctor reports `sqliteVec: false`, this is where the fallback path is documented.
* **[FTS.md](./FTS.md)** — `.searchable()` per-dialect. If doctor reports `fts5: false` or warns about a missing FULLTEXT setup, this explains what the fallback does.
* **[DRIVERS.md](./DRIVERS.md)** — adapter / driver matrix. Cross-check what `report.driverPackage` means and which custom drivers can be injected via `createDb({ driver })`.
* **README's [Doctor](../README.md#doctor) note** — one-paragraph entry point. This file is the deep reference.

Back to the [README index](../README.md#contents).
