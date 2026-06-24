# Mobile + cross-platform persistence

forge ships SQLite drivers (`expoSqliteDriver`, `opSqliteDriver`,
`libsqlDriver`, `betterSqlite3Driver`, `wasmSqliteDriver`) and the same
`SqliteDriver` port is open for anything else that can run SQL. The
[README's pluggable drivers section](../README.md#pluggable-drivers) names
each factory; the [browser-frameworks recipes](./BROWSER-FRAMEWORKS.md)
cover Vite / Next / Vue / Svelte / Angular and a brief
[React Native + op-sqlite](./BROWSER-FRAMEWORKS.md#react-native--op-sqlite-bonus)
and [Tauri + better-sqlite3](./BROWSER-FRAMEWORKS.md#tauri-desktop--better-sqlite3)
example.

This doc goes deeper on what those two short sections skip: how to pick
a driver across the full mobile matrix (bare RN, Expo managed, Expo bare,
Capacitor, Tauri webview, Tauri sidecar, Ionic), how to ship SQLCipher
without losing the typed API, how to sync to a server, what to do in a
background task, and a per-tool migration cookbook from Watermelon /
Realm / Drizzle / Prisma.

## Contents

* [Driver picker — one table per platform](#driver-picker--one-table-per-platform)
* [op-sqlite end-to-end (bare React Native)](#op-sqlite-end-to-end-bare-react-native)
* [Expo managed end-to-end](#expo-managed-end-to-end)
* [Capacitor + capacitor-community/sqlite](#capacitor--capacitor-communitysqlite)
* [Tauri — webview vs sidecar](#tauri--webview-vs-sidecar)
* [Encryption / SQLCipher](#encryption--sqlcipher)
* [Sync to a server — three patterns](#sync-to-a-server--three-patterns)
* [Background tasks](#background-tasks)
* [App size, WAL, and `PRAGMA` defaults](#app-size-wal-and-pragma-defaults)
* [Testing](#testing)
* [Migrating an existing app](#migrating-an-existing-app)

---

## Driver picker — one table per platform

| Platform | Recommended driver | Sync hooks | FTS5 | Encryption | Extensions (R-Tree, vec, geo) |
|---|---|---|---|---|---|
| RN bare (iOS + Android) | `opSqliteDriver` | `db.reactiveExecute()` | yes (default build) | op-sqlite-cipher fork | R-Tree default; vec via custom build |
| Expo managed | `expoSqliteDriver` | `addDatabaseChangeListener` | yes (SDK 51+) | no (drop to bare for SQLCipher) | no (managed build is stock) |
| Expo bare (prebuild) | `opSqliteDriver` | same as RN bare | yes | yes (custom build) | yes (custom build) |
| Capacitor (iOS + Android) | thin wrapper around `@capacitor-community/sqlite` | `addListener('sqliteDatabaseChange')` | yes | built-in (SQLCipher) | R-Tree on iOS by default; Android needs flag |
| Ionic (Capacitor stack) | same as Capacitor | same | same | same | same |
| Ionic (Cordova stack) | thin wrapper around `cordova-sqlite-storage` | manual triggers | yes | `cordova-sqlite-evcore-extbuild-free` only | R-Tree only on evcore build |
| Tauri 2 webview | `wasmSqliteDriver` + OPFS | `BroadcastChannel` | yes | wasm has no SQLCipher — use Tauri sidecar instead | sqlite-vec + R-Tree via [`worker-pro`](../README.md#custom-wasm-build-vec0--r-tree) |
| Tauri 2 Rust sidecar | `betterSqlite3Driver` (Node sidecar) OR custom `SqliteDriver` over `tauri-plugin-sql` IPC | Tauri events | yes | better-sqlite3 + sqlcipher build OR `tauri-plugin-sql-sqlcipher` fork | full native — anything sqlite3 ships |
| libsql / Turso (any platform with `fetch`) | `libsqlDriver` | server-side | yes | server-side | server-side |

A few rules of thumb:

- **op-sqlite is faster than expo-sqlite for write-heavy workloads** (it
  uses JSI directly, no async bridge per row). Pick it whenever you can
  prebuild — i.e., any time you don't strictly need the managed workflow.
- **FTS5, R-Tree, sqlite-vec** are build-time. The stock Apple `libsqlite3`
  has FTS5 + R-Tree but not vec. Op-sqlite and expo-sqlite both ship their
  own sqlite (not the system one) so what's in their build is what you get.
  See the per-driver notes below for how to enable a non-default extension.
- **Encryption** splits the matrix in two: Capacitor's plugin ships
  SQLCipher and exposes `setEncryptionSecret` directly; everywhere else you
  bring your own SQLCipher build (or ship the user's data unencrypted, behind
  a file-system permission boundary).
- **`f.geoPoint({ fallback: true })`** — when the on-device sqlite lacks
  SpatiaLite (the default on every mobile build), set `fallback: true`. The
  column is stored as `{lng, lat}` JSON and the adapter post-filters via
  Haversine. See [Fallback mode](../README.md#fallback-mode-no-extension).
- **`f.vector(N)` on device** — only with a custom op-sqlite or wasm build
  that links sqlite-vec. The README has the worker-pro build instructions
  for wasm; for op-sqlite, follow op-sqlite's custom-compilation guide and
  add `sqlite-vec` to the source list.

---

## op-sqlite end-to-end (bare React Native)

The README mentions op-sqlite in passing. Here is the full path from a
fresh `npx react-native init` to a forge db that survives reload.

**1. Install + autolink**

```sh
npm install forge-orm @op-engineering/op-sqlite
cd ios && pod install && cd ..
```

Op-sqlite's podspec opts into FTS5, R-Tree, JSON1, and the math functions
by default. The pod install step is what compiles its bundled sqlite — if
you skip it after a Node-side `npm install`, the JS bridge will resolve but
calls will throw `OPSQLite is not registered`.

**2. Android — no Gradle change**

Op-sqlite ships an `android/build.gradle` that autolinking picks up. The
only Gradle-side gotcha is that 16 KB page support landed in
`@op-engineering/op-sqlite@10.x` — if you target Android 15 large-page
devices, pin at least that version.

**3. Reanimated interactions**

If your app already uses `react-native-reanimated`, op-sqlite's worklet
hooks (`useReactiveQuery`) require Reanimated 3.7+. Older versions
silently no-op the subscription. forge doesn't use the worklet hooks
directly (it talks to `db.execute`, the standard JSI surface), so a missing
Reanimated only affects code you write on top of the raw driver — not
forge itself.

**4. File path strategy**

```ts
import { open as openSqlite, IOS_LIBRARY_PATH, ANDROID_DATABASE_PATH } from '@op-engineering/op-sqlite';
import { Platform } from 'react-native';
import { createDb, opSqliteDriver } from 'forge-orm';
import { schema } from './db/schema';

// iOS: Library/ (NOT Documents/). Documents/ shows up in Files app + iCloud
// backup by default; Library/ is hidden + still backed up.
// Android: the app's no-backup files dir, scoped storage friendly.
const location = Platform.select({
  ios: IOS_LIBRARY_PATH,
  android: ANDROID_DATABASE_PATH,
});

const native = openSqlite({ name: 'app.sqlite', location });

export const db = await createDb({ schema, driver: opSqliteDriver(native) });
await db.$migrate();
```

Why not `Documents/`? On iOS, files in `Documents/` are exposed via the
Files app and uploaded to iCloud unless excluded. A 200 MB local-first
cache there is both a UX leak and a backup-quota burn. `Library/` is the
canonical home for app-managed sqlite. On Android, `ANDROID_DATABASE_PATH`
resolves to the app's internal storage, which is automatically excluded
from auto-backup unless you opt in via `android:fullBackupContent`.

For a true cache (regenerate-on-loss is fine), use op-sqlite's
`IOS_CACHES_PATH` / Android `getCacheDir()`. The OS may evict the file
under storage pressure — wrap `$migrate()` in a try / catch and recreate.

**5. Schema bootstrap + hot-reload survival**

Metro's fast-refresh re-runs your module, which would otherwise re-open
the connection on every save. Memoise:

```ts
// db/index.ts
let dbPromise: ReturnType<typeof open> | null = null;

function open() {
  const native = openSqlite({ name: 'app.sqlite', location: IOS_LIBRARY_PATH });
  return createDb({ schema, driver: opSqliteDriver(native) });
}

export function getDb() {
  if (!dbPromise) dbPromise = open();
  return dbPromise;
}

export async function bootDb() {
  const db = await getDb();
  await db.$migrate();
  return db;
}
```

The module-scope `dbPromise` survives fast-refresh because Metro preserves
module instances unless you change the file that defines them.
`db.$migrate()` is idempotent (see
[`db.$migrate()`](../README.md#dbmigrate--runtime-ddl-apply)) — re-running
on every fast-refresh costs a single `sqlite_master` scan.

**6. Debugging via `adb` and `xcrun simctl`**

```sh
# Android — pull the live sqlite to your machine and open it
adb shell "run-as com.acme.app cat databases/app.sqlite" > app.sqlite
sqlite3 app.sqlite "SELECT name FROM sqlite_master WHERE type='table';"

# iOS simulator — files live under the app container
xcrun simctl get_app_container booted com.acme.app data
# => /Users/you/Library/Developer/CoreSimulator/Devices/.../data
cd "$(xcrun simctl get_app_container booted com.acme.app data)"
sqlite3 Library/app.sqlite ".schema"
```

For an iOS device (not simulator), use Xcode → Devices and Simulators →
Download Container. The sqlite is at the same path inside the container.

For ongoing inspection without disconnecting:

```ts
// In a debug-only screen
const report = await db.$diff();      // is the live schema matching the source-of-truth?
const doc    = await db.$doctor();    // FTS5 / R-Tree / vec — what's actually compiled in?
```

`$diff` is identical to the CLI `forge diff` — same drift detection, same
ignore spec — and matters most on device because over-the-air updates can
ship a JS bundle whose schema runs ahead of the binary's bundled sqlite
features.

---

## Expo managed end-to-end

The driver factory `expoSqliteDriver(db)` wraps a database opened by
`expo-sqlite@^15` (SDK 51+). The async API is what forge talks to.

**1. Install + prebuild prerequisites**

```sh
npx create-expo-app my-app
cd my-app
npx expo install expo-sqlite
npm install forge-orm
```

Expo managed has no prebuild — you stay on the prebuilt `Expo Go` shell
during dev, or use a custom dev client for native modules. `expo-sqlite`
ships with Expo Go, so forge works the same in Expo Go as in a dev client.
If you later move to Expo bare via `npx expo prebuild`, swap to op-sqlite
for the perf gain; the forge schema, models, and queries don't change.

**2. The `useSQLiteContext` interop**

`expo-sqlite` ships a React provider, `SQLiteProvider`, that opens the
database during render and exposes it via `useSQLiteContext()`. forge sits
above this:

```tsx
import { SQLiteProvider, useSQLiteContext } from 'expo-sqlite';
import { createDb, expoSqliteDriver, type ForgeDb } from 'forge-orm';
import { schema } from './db/schema';
import { createContext, useContext, useEffect, useState } from 'react';

const DbContext = createContext<ForgeDb<typeof schema> | null>(null);

function DbBridge({ children }: { children: React.ReactNode }) {
  const native = useSQLiteContext();
  const [db, setDb] = useState<ForgeDb<typeof schema> | null>(null);
  useEffect(() => {
    let alive = true;
    (async () => {
      const forge = await createDb({ schema, driver: expoSqliteDriver(native) });
      await forge.$migrate();
      if (alive) setDb(forge);
    })();
    return () => { alive = false; };
  }, [native]);
  return <DbContext.Provider value={db}>{children}</DbContext.Provider>;
}

export function DbProvider({ children }: { children: React.ReactNode }) {
  return (
    <SQLiteProvider databaseName="app.db">
      <DbBridge>{children}</DbBridge>
    </SQLiteProvider>
  );
}

export function useDb() {
  const ctx = useContext(DbContext);
  if (!ctx) throw new Error('useDb() outside DbProvider');
  return ctx;
}
```

`SQLiteProvider` handles the open / close lifecycle (including
`onAppStateChange` semantics — closing on background, reopening on
foreground), so we let it own the underlying handle and only wrap it for
forge. The `DbBridge` indirection is what waits for `$migrate` before
exposing the typed handle, so the first `useDb()` call is never against an
empty schema.

**3. EAS Build config gotchas**

- The default `expo-sqlite` build for iOS uses the system `libsqlite3`,
  which means FTS5 and R-Tree are available but the sqlite version is
  whatever Apple ships. For an EAS Build that pins a specific sqlite, use
  the `expo-sqlite/next` config plugin's `useSQLCipher` / `customBuildFlags`
  options (SDK 52+).
- Android EAS Build defaults to bundling a fresh sqlite per arch. App size
  goes up ~1.2 MB per ABI; if you split APKs by ABI you don't notice, but
  the universal APK does grow.
- `eas-build-pre-install` is the hook where you'd patch `package.json` to
  reroute `expo-sqlite` to a fork — useful for one-off SQLCipher builds.

**4. Backups via `expo-file-system`**

```ts
import * as FileSystem from 'expo-file-system';

export async function exportDb(): Promise<string> {
  // Force a checkpoint so the WAL is folded into the main file before copying.
  await db.$executeRaw`PRAGMA wal_checkpoint(FULL)`;
  const src = `${FileSystem.documentDirectory}SQLite/app.db`;
  const dst = `${FileSystem.cacheDirectory}backup-${Date.now()}.sqlite`;
  await FileSystem.copyAsync({ from: src, to: dst });
  return dst;     // hand to expo-sharing or upload to the server
}
```

`expo-sqlite` puts the live db under `documentDirectory/SQLite/`. A
checkpoint before copy means the backup is a single self-contained file
(no `.sqlite-wal` companion). On restore, copy back, drop the in-memory
handle, and re-`createDb`.

---

## Capacitor + capacitor-community/sqlite

Capacitor's official sqlite plugin is `@capacitor-community/sqlite`. It
exposes `query`, `run`, `execute`, `executeSet`, plus encryption and
biometric unlock. forge doesn't ship a built-in driver for it — but the
`SqliteDriver` port is small (5 methods), so a wrapper is ~30 lines.

```ts
// db/capacitor-driver.ts
import { CapacitorSQLite, SQLiteConnection, type SQLiteDBConnection } from '@capacitor-community/sqlite';
import type { SqliteDriver } from 'forge-orm';

export async function openCapacitorDb(opts: {
  database: string;
  encrypted?: boolean;
  passphrase?: string;
}): Promise<{ driver: SqliteDriver; conn: SQLiteDBConnection }> {
  const sqlite = new SQLiteConnection(CapacitorSQLite);
  if (opts.encrypted && opts.passphrase) {
    await sqlite.setEncryptionSecret(opts.passphrase);
  }
  const conn = await sqlite.createConnection(
    opts.database,
    opts.encrypted ?? false,
    opts.encrypted ? 'secret' : 'no-encryption',
    1,
    false,
  );
  await conn.open();

  const driver: SqliteDriver = {
    kind: 'sqlite',
    all: async (sql, params) => {
      const r = await conn.query(sql, params as any[]);
      return r.values ?? [];
    },
    get: async (sql, params) => {
      const r = await conn.query(sql, params as any[]);
      return r.values?.[0];
    },
    run: async (sql, params) => {
      const r = await conn.run(sql, params as any[], false);
      return { changes: r.changes?.changes ?? 0, lastInsertRowid: r.changes?.lastId };
    },
    exec: async (sql) => { await conn.execute(sql, false); },
    close: async () => { await conn.close(); await sqlite.closeConnection(opts.database, false); },
  };
  return { driver, conn };
}
```

Then:

```ts
import { createDb } from 'forge-orm';
import { openCapacitorDb } from './capacitor-driver';
import { schema } from './schema';

const { driver } = await openCapacitorDb({
  database: 'app',
  encrypted: true,
  passphrase: await derivePassphrase(),
});

export const db = await createDb({ schema, driver });
await db.$migrate();
```

**Why pass `false` to `transaction` args?** The plugin offers an
optimisation that wraps each call in a transaction. forge already wraps
multi-statement work via `db.$transaction` — letting the plugin add its
own outer transaction would force a savepoint, which the plugin
historically doesn't model well. Passing `false` keeps a single
transaction layer.

**iOS biometric unlock pattern**

```ts
await sqlite.setEncryptionSecret(passphrase);   // sets the SQLCipher key
await sqlite.setBiometricAuth(true, 'Unlock my data', 'Cancel');
```

The plugin holds the secret in the iOS Keychain with
`kSecAttrAccessibleWhenUnlockedThisDeviceOnly` and gates retrieval on
`LAContext.evaluatePolicy`. The first `conn.open()` after a cold boot
triggers Face ID / Touch ID. Failed unlock throws on `open()` and forge
surfaces it as a normal driver error — the model code never sees the
unlocked / locked transition.

**Android scoped storage (Android 10+)**

The plugin writes to the app's internal storage by default
(`/data/data/com.app/databases/`), which is already scoped. The only
catch: on `targetSdk >= 33`, the auto-backup default also captures the
database. If the user restores on a new device, an encrypted DB without
the Keychain entry is unrecoverable. Either turn off auto-backup for
`databases/` via `<full-backup-content>` rules, or re-derive the passphrase
deterministically from a server-issued recovery token.

---

## Tauri — webview vs sidecar

Tauri ships a webview (WKWebView on macOS / iOS, WebView2 on Windows,
WebKitGTK on Linux) and a Rust binary. SQLite can live in either.

### When the webview wins

- The data is small (≲ 100 MB) and queries are interactive — OPFS is fast
  enough.
- You're already running the wasm build for a web build target — Tauri
  inherits the work for free.
- You want a single code path for web + desktop, including the same
  `db.$migrate()` and `db.$doctor()` calls.

```ts
// src/db.ts — identical to the Vite recipe in BROWSER-FRAMEWORKS.md
import { createDb, wasmSqliteDriver } from 'forge-orm';
import { schema } from './schema';

const worker = new Worker(new URL('forge-orm/wasm/worker', import.meta.url), { type: 'module' });
export const db = await createDb({
  schema,
  driver: wasmSqliteDriver({ worker, url: 'opfs-sahpool:///app.sqlite' }),
});
await db.$migrate();
```

OPFS persistence under WKWebView writes inside the app's sandbox at
`~/Library/WebKit/<bundle-id>/WebsiteData/Default/OriginPrivateFileSystem/`
on macOS. Tauri 2 adds `WebviewWindow.dataStoreIdentifier` so multiple
windows can share an OPFS namespace explicitly.

### When the sidecar wins

- The data is large (> 100 MB), heavy reads, or you need extensions OPFS
  can't ship (SpatiaLite, sqlite-vec compiled native, SQLCipher, custom
  FTS tokenisers).
- You need filesystem-level backup tools to operate on the file (a `.bak`
  task in CI, rsync-friendly).
- You want to keep the webview minimal — no COOP/COEP, no SAB.

**Node sidecar (simplest):** ship a Node binary alongside the Tauri
build, run forge with `better-sqlite3` in it, expose a small JSON-RPC
surface that the webview calls via `tauri.invoke`.

```ts
// sidecar/index.ts — runs in the Node sidecar
import { createDb, betterSqlite3Driver } from 'forge-orm';
import Database from 'better-sqlite3';
import { schema } from './schema';
import path from 'node:path';

const dbFile = path.join(process.env.TAURI_APP_LOCAL_DATA_DIR!, 'app.sqlite');
const native = new Database(dbFile);
native.pragma('journal_mode = WAL');
native.pragma('synchronous = NORMAL');

export const db = await createDb({ schema, driver: betterSqlite3Driver(native) });
await db.$migrate();

// JSON-RPC loop (Tauri's stdin sidecar API)
process.stdin.on('data', async (buf) => {
  const { id, method, params } = JSON.parse(buf.toString());
  try {
    const result = await dispatch(method, params);
    process.stdout.write(JSON.stringify({ id, result }) + '\n');
  } catch (e: any) {
    process.stdout.write(JSON.stringify({ id, error: e.message }) + '\n');
  }
});
```

**Rust sidecar (tighter):** use `tauri-plugin-sql` and adapt a thin
`SqliteDriver` over `invoke`:

```ts
// src/db/tauri-driver.ts
import Database from '@tauri-apps/plugin-sql';
import type { SqliteDriver } from 'forge-orm';

export async function tauriSqlDriver(connection: string): Promise<SqliteDriver> {
  const handle = await Database.load(connection);  // e.g. 'sqlite:app.sqlite'
  return {
    kind: 'sqlite',
    all:   async (sql, params) => handle.select<any[]>(sql, params as any[]),
    get:   async (sql, params) => (await handle.select<any[]>(sql, params as any[]))[0],
    run:   async (sql, params) => {
      const r = await handle.execute(sql, params as any[]);
      return { changes: r.rowsAffected, lastInsertRowid: r.lastInsertId };
    },
    exec:  async (sql) => { await handle.execute(sql, []); },
    close: async () => { await handle.close(); },
  };
}
```

```ts
import { createDb } from 'forge-orm';
import { tauriSqlDriver } from './tauri-driver';
import { schema } from './schema';

export const db = await createDb({
  schema,
  driver: await tauriSqlDriver('sqlite:app.sqlite'),
});
await db.$migrate();
```

`tauri-plugin-sql` resolves `sqlite:app.sqlite` against
`$APPDATA/<bundle-id>/`. On macOS that's
`~/Library/Application Support/<bundle-id>/app.sqlite`. Configure via
`tauri.conf.json`'s `plugins.sql.preload` if you want the plugin to open
the connection at app start instead of on first invoke.

### Tauri 1 vs Tauri 2 differences

- Tauri 1 uses the v1 plugin (`tauri-plugin-sql-api`); the JS import is
  `import Database from 'tauri-plugin-sql-api'`. The shape is the same —
  the wrapper above ports across with the import line changed.
- Tauri 2 split plugins into capability scopes. Add `"sql:default"` (or a
  per-DB scope like `"sql:allow-load"`) to your
  `src-tauri/capabilities/main.json` or the call will reject at runtime.
- Tauri 2's mobile targets (iOS / Android) inherit the Rust sidecar option
  but not the Node one (Node binaries don't ship to mobile). On mobile,
  the webview-wasm path is the simplest portable option; for native perf
  on Tauri 2 mobile, use `tauri-plugin-sql` (which links against the system
  sqlite on iOS and Android NDK sqlite).

---

## Encryption / SQLCipher

forge doesn't ship encryption itself — it inherits whatever the driver
sees. SQLCipher works across `better-sqlite3-multiple-ciphers`,
`op-sqlite-cipher`, `expo-sqlite` (with a `useSQLCipher` config plugin or
a custom build), and `@capacitor-community/sqlite` (built-in).

**Issuing `PRAGMA key` through forge's raw escape hatch:**

```ts
// Right after open(), before any other statement.
await db.$executeRaw`PRAGMA key = ${passphrase}`;
// Optional: rekey
await db.$executeRaw`PRAGMA rekey = ${newPassphrase}`;
```

`PRAGMA key` must be the first statement on a connection — if you've
already queried `sqlite_master` (which `$migrate` does), the cipher refuses
to bind. So issue the pragma immediately after the driver opens, before
`createDb` (or rather, before its first call). The cleanest pattern is to
do it in the driver factory:

```ts
async function openEncrypted(passphrase: string) {
  const native = openSqlite({ name: 'app.sqlite', location: IOS_LIBRARY_PATH, encryptionKey: passphrase });
  // op-sqlite-cipher: pass encryptionKey here, plugin issues PRAGMA key under the hood.
  return createDb({ schema, driver: opSqliteDriver(native) });
}
```

If your driver doesn't accept a key in the open call, intercept the
driver in a small wrapper:

```ts
function withPragmaKey(base: SqliteDriver, passphrase: string): SqliteDriver {
  let opened = false;
  const ensureKey = async () => {
    if (!opened) {
      await base.exec(`PRAGMA key = '${passphrase.replace(/'/g, "''")}'`);
      opened = true;
    }
  };
  return {
    ...base,
    all:  async (s, p) => { await ensureKey(); return base.all(s, p); },
    get:  async (s, p) => { await ensureKey(); return base.get(s, p); },
    run:  async (s, p) => { await ensureKey(); return base.run(s, p); },
    exec: async (s)    => { await ensureKey(); return base.exec(s); },
  };
}
```

**Key derivation patterns**

1. **User passphrase + KDF.** Run PBKDF2 / Argon2 over the user's
   passphrase + a stored salt. Cheap on attacker (lots of iterations) and
   exactly as fast as you need on the device (tune iterations to the
   slowest target — ~300 ms is a reasonable budget on a 5-year-old phone).
2. **Random key + secure enclave.** Generate a 32-byte random key on first
   run, store it in iOS Keychain (`kSecAttrAccessibleWhenUnlockedThisDeviceOnly`)
   or Android Keystore (`KeyGenParameterSpec` with
   `setUserAuthenticationRequired(true)`), retrieve on each app start.
   This is what the Capacitor plugin's biometric unlock does internally.
3. **Server-issued.** Fetch the key from your backend at sign-in, never
   persist it on device, re-fetch on each cold start. Stronger against
   device compromise; harder to do offline-first.

On iOS, `expo-secure-store` + `WHEN_UNLOCKED_THIS_DEVICE_ONLY` is the
managed-workflow equivalent of Keychain.

---

## Sync to a server — three patterns

forge is local-first by default — there's no built-in sync. Pick a
pattern based on how much offline mutation matters.

### Pattern A — pull-on-foreground

Cheapest: never mutate on device, only read. The server is canonical;
the device caches.

```ts
// On every foreground transition:
import { AppState } from 'react-native';
AppState.addEventListener('change', async (s) => {
  if (s === 'active') await syncFromServer();
});

async function syncFromServer() {
  const cursor = await db.meta.findUnique({ where: { key: 'lastSyncAt' } });
  const since = cursor?.value ?? '1970-01-01';
  let next: string | null = since;
  while (next) {
    const page: { items: Customer[]; nextCursor: string | null; serverNow: string } =
      await fetch(`/api/customers?since=${next}&limit=500`).then((r) => r.json());
    await db.$transaction(async (tx) => {
      for (const item of page.items) {
        // upsert is atomic on every dialect (forge 2.5)
        await tx.customer.upsert({
          where:  { id: item.id },
          create: item,
          update: item,
        });
      }
    });
    next = page.nextCursor;
    await db.meta.upsert({
      where: { key: 'lastSyncAt' }, create: { key: 'lastSyncAt', value: page.serverNow }, update: { value: page.serverNow },
    });
  }
}
```

Use `page.serverNow` as the cursor, not the device clock — clock skew
across devices is the most common source of "missed an update" bugs.
Paginate by 200–1000 items per request; the upsert loop in a single
transaction is what makes it cheap (`PRAGMA synchronous=NORMAL` + one
WAL fsync, regardless of page size).

### Pattern B — push-on-mutate via a queue table

The device writes locally and replays to the server. forge stores the
queue as a normal model — no special API.

```ts
const Outbox = model('outbox', {
  id:         f.id(),
  op:         f.string(),                       // 'create' | 'update' | 'delete'
  table:      f.string(),
  payload:    f.json(),
  created_at: f.dateTime().default('now'),
  attempts:   f.int().default(0),
  next_try:   f.dateTime().default('now'),
}, {
  indexes: [{ keys: { next_try: 1 } }],
});

async function mutateCustomer(input: { id: string; name: string }) {
  await db.$transaction(async (tx) => {
    await tx.customer.upsert({ where: { id: input.id }, create: input, update: input });
    await tx.outbox.create({ data: { op: 'upsert', table: 'customers', payload: input } });
  });
}

async function flushOutbox() {
  for (;;) {
    const due = await db.outbox.findMany({ where: { next_try: { lte: new Date() } }, take: 50, orderBy: { id: 'asc' } });
    if (!due.length) return;
    for (const row of due) {
      try {
        await fetch(`/api/${row.table}`, { method: 'POST', body: JSON.stringify(row.payload) }).then((r) => {
          if (!r.ok) throw new Error(`${r.status}`);
        });
        await db.outbox.delete({ where: { id: row.id } });
      } catch {
        const backoff = Math.min(60_000, 1000 * 2 ** row.attempts);
        await db.outbox.update({
          where: { id: row.id },
          data:  { attempts: { increment: 1 }, next_try: new Date(Date.now() + backoff) },
        });
      }
    }
  }
}
```

The local upsert + outbox insert happen atomically inside one
transaction — if the app crashes between them, neither survives, so the
device's view of "what I've told the server" never diverges from what's
in the outbox. Backoff is exponential, capped at 60 s.

### Pattern C — CRDT-shaped sync (Yjs / Automerge)

For collaborative-edit shapes, the merged state lives in a CRDT and forge
stores it as a JSON blob plus indexed metadata for cheap lookups:

```ts
const Doc = model('docs', {
  id:         f.id(),
  title:      f.string(),                       // mirror of CRDT title — denormalised for lookup
  updated_at: f.dateTime().default('now').updatedAt(),
  state:      f.json(),                         // Yjs Y.encodeStateAsUpdate(ydoc), base64
  vector:     f.json(),                         // Y.encodeStateVector — what we have
});

async function applyRemoteUpdate(docId: string, update: Uint8Array) {
  const ydoc = await loadInto(docId);
  Y.applyUpdate(ydoc, update);
  await db.doc.update({
    where: { id: docId },
    data: {
      title:  ydoc.getText('title').toString(),
      state:  Buffer.from(Y.encodeStateAsUpdate(ydoc)).toString('base64'),
      vector: Buffer.from(Y.encodeStateVector(ydoc)).toString('base64'),
    },
  });
}
```

Two queries the device does often:

```ts
// "What's my state vector?" — for asking the server for missing updates
const { vector } = await db.doc.findUniqueOrThrow({ where: { id }, select: { vector: true } });

// "Give me the recently-touched docs for the inbox" — uses the denormalised columns
await db.doc.findMany({ orderBy: { updated_at: 'desc' }, take: 25, select: { id: true, title: true, updated_at: true } });
```

The denormalised `title` + `updated_at` are what makes inbox / list views
cheap — querying inside the JSON `state` blob on every render is what
kills Yjs apps. Update them inside the same `db.doc.update` that writes
the new state, never out-of-band.

---

## Background tasks

Mobile OSs let the app wake briefly when it's not foregrounded. Each
wakeup has a CPU + wall-clock budget — iOS BGAppRefresh is ~30 s, Android
WorkManager is typically ~10 minutes but with battery/network gating.
Open + close the DB cleanly each time, coalesce writes into one
transaction, return quickly.

**Expo background-fetch:**

```ts
import * as TaskManager from 'expo-task-manager';
import * as BackgroundFetch from 'expo-background-fetch';

const TASK = 'forge-sync';

TaskManager.defineTask(TASK, async () => {
  const db = await bootDb();                   // memoised; idempotent $migrate
  try {
    await db.$transaction(async (tx) => {
      const fresh = await fetchSinceCursor();
      for (const row of fresh.items) await tx.customer.upsert({ where: { id: row.id }, create: row, update: row });
    });
    return BackgroundFetch.BackgroundFetchResult.NewData;
  } catch {
    return BackgroundFetch.BackgroundFetchResult.Failed;
  }
  // No close — the next foreground will reuse the same handle.
});

await BackgroundFetch.registerTaskAsync(TASK, { minimumInterval: 15 * 60, stopOnTerminate: false, startOnBoot: true });
```

iOS budgets the call by wall clock — a single transaction with N upserts
is the safest shape. If you split into N transactions, each fsync costs
~3 ms on a modern phone and you can burn the budget on syncs alone.

**iOS BGAppRefreshTask (bare RN):**

```swift
// AppDelegate.swift
BGTaskScheduler.shared.register(forTaskWithIdentifier: "com.acme.app.refresh", using: nil) { task in
  let bg = task as! BGAppRefreshTask
  RNBackgroundFetch.shared().performFetch(with: { result in
    bg.setTaskCompleted(success: result == .newData)
  })
}
```

Bridge through `react-native-background-fetch` to surface to the same JS
task definition.

**Android WorkManager:**

`react-native-background-fetch` registers a periodic WorkRequest with
constraints (battery not low, network connected). When the worker fires,
the JS engine spins up, runs the same task, returns. forge holds its
state in the JS bundle — no native-side connection lives across wakeups.

---

## App size, WAL, and `PRAGMA` defaults

**Bundle impact.** forge is ~80 KB minified (no driver). The drivers carry
the weight:

| Driver | Approximate RN bundle adds |
|---|---|
| op-sqlite | ~600 KB JS + ~3–4 MB native (per arch) |
| expo-sqlite | ~150 KB JS + ~1.2 MB native (per arch) |
| capacitor-sqlite | ~300 KB JS + ~4 MB native (universal) |
| wasm (Tauri webview) | ~1.2 MB wasm + ~80 KB JS |

For Expo managed, the native is bundled by EAS during build — your over-
the-air JS bundle doesn't grow. For bare RN, ABI splits keep per-APK size
down.

**WAL file location.** The `.sqlite-wal` and `.sqlite-shm` companions live
next to the main file. On iOS, all three need to share the same
file-protection class — if you set the main file to
`NSFileProtectionComplete`, the WAL writes during background can fail
silently. Use `NSFileProtectionCompleteUntilFirstUserAuthentication` if
you need to write while the phone is locked (which background tasks
require).

**`journal_mode=WAL` vs `DELETE`.** WAL is the default on op-sqlite,
expo-sqlite (since SDK 51), better-sqlite3. It's the right default on
mobile: reads don't block writes, the WAL file is append-only (kind to
flash), and checkpoints fold the WAL back into the main file on a
schedule. The only case to switch back to `DELETE` is iCloud sync of the
sqlite file — iCloud's diff algorithm handles a single file far better
than three. Run:

```ts
await db.$executeRaw`PRAGMA journal_mode = DELETE`;
```

once, then back-up via the file-system. This is only worth it for the
small-DB iCloud-sync use case; otherwise stay on WAL.

**`PRAGMA synchronous=NORMAL` as the mobile default.** `FULL` is the
default; `NORMAL` is 2–4× faster on mobile flash with the only durability
trade-off being "a crash within a few milliseconds of commit could lose
the last transaction." WAL + NORMAL is the standard mobile config:

```ts
await db.$executeRaw`PRAGMA synchronous = NORMAL`;
await db.$executeRaw`PRAGMA temp_store = MEMORY`;
await db.$executeRaw`PRAGMA mmap_size = 67108864`;   // 64 MB, see below
```

`mmap_size=64MB` lets sqlite read pages without a syscall — a large win on
read-heavy workloads, costs ~64 MB of address space (not RAM — the OS
pages in on demand).

---

## Testing

**Detox + in-memory sqlite.** For end-to-end on a simulator, point forge
at `:memory:` for the test build (op-sqlite + expo-sqlite both accept it):

```ts
const native = openSqlite({ name: __DEV__ && process.env.E2E ? ':memory:' : 'app.sqlite' });
```

Each Detox launch starts with a clean DB; `$migrate` runs in <100 ms
because there's no on-disk state to read. Detox's `device.launchApp({
newInstance: true })` gives a fresh process per spec.

**Jest mocking via `wasmSqliteDriver` in jsdom.** Unit tests for code
that's tightly coupled to forge are easiest when the test runs the actual
sqlite — no mocks, real queries, real diffs. The wasm driver runs in
jsdom because the worker can be polyfilled:

```ts
// jest.setup.ts
import { Worker } from 'node:worker_threads';
(globalThis as any).Worker = Worker;

// in your test
import { createDb, wasmSqliteDriver } from 'forge-orm';
const worker = new Worker(new URL('forge-orm/wasm/worker', import.meta.url), { type: 'module' });
const db = await createDb({
  schema,
  driver: wasmSqliteDriver({ worker, url: ':memory:' }),
});
await db.$migrate();
```

Tests now run against real SQLite with FTS5, the same `$migrate`, the
same `db.$diff` — there's no driver-mock divergence to chase.

**Schema-drift snapshot per release.** Add a unit test that snapshots
`db.$diff()`:

```ts
test('schema matches the source-of-truth', async () => {
  const drift = await db.$diff();
  expect(drift.inSync).toBe(true);
  expect(drift.items).toEqual([]);
});
```

On a release branch, this catches the case where someone added a field to
a model but didn't run `$migrate` in the new build — a common cause of
"works on simulator, crashes on TestFlight." Snapshot the
`adapter.introspect()` shape next to the test for a per-release record:

```ts
expect(await db.$introspect()).toMatchSnapshot('release-2.5.0-schema');
```

---

## Migrating an existing app

A paragraph each for the four most common starting points.

**From WatermelonDB.** Watermelon's `Database`, `Collection`, `Model` map
to forge's `db`, `db.<modelKey>`, `model(...)`. The biggest semantic
shift: Watermelon's `@field` decorators describe a record class; forge's
`f.string()` etc. describe a column. Map Watermelon's `@field('name')` to
`name: f.string()` in the forge model, the `@date('created_at')` to
`f.dateTime()`, `@relation('users', 'user_id')` to a `rel.one` in the
`.relate(() => ({ ... }))` block. Watermelon's `database.action(() =>
record.update(...))` becomes `db.$transaction(async (tx) =>
tx.thing.update({ where: { id }, data }))`. The on-disk format is
compatible (both use SQLite); a one-off `forge push` against the
existing file lines up the columns forge expects, then you can drop
Watermelon's sync engine in favour of one of the patterns above.

**From Realm.** Realm's object schema is similar to forge's model
shape — `name: 'string'` becomes `name: f.string()`, `email:
{ type: 'string', indexed: true }` becomes `email: f.string()` plus an
`indexes` entry, `links: 'Person[]'` becomes a `rel.many`. The hard part
is Realm's auto-update notifications — there's no direct forge
equivalent. Replace `realm.objects('Person').addListener(...)` with
either a manual refetch on mutation (the React Query pattern in the
[Next.js section](./BROWSER-FRAMEWORKS.md#nextjs-app-router)) or driver-level
change hooks (op-sqlite's `db.reactiveExecute`). Data migration: export
Realm to JSON, run a one-off forge script that upserts each row. Realm's
binary format is not sqlite-compatible, so there's no in-place migration.

**From Drizzle.** Drizzle on RN normally runs `drizzle-orm/expo-sqlite`
or `drizzle-orm/op-sqlite`. forge runs `expoSqliteDriver(SQLite.openDatabaseSync(...))`
or `opSqliteDriver(open({...}))` against the same underlying connection,
so you can run both in parallel during a migration. Schema rename:
`sqliteTable('users', { email: text('email') })` becomes
`model('users', { email: f.string() })`. Drizzle's `db.select().from(users).where(...)`
becomes `db.user.findMany({ where: ... })`. Drizzle migrations
(`drizzle-kit generate`) and `forge push` / `forge diff` cover the same
ground — drop drizzle-kit's `meta/_journal.json` once you've moved the
schema source-of-truth into forge models.

**From Prisma.** Prisma has no first-class RN driver — most apps using
"Prisma" on mobile are really running Prisma server-side and shipping
data through an API. If you're moving to local-first, model conversion is
nearly mechanical: forge intentionally mirrors Prisma's API.
`db.user.findMany({ where: { email: { contains: '@' } } })` is identical;
`db.user.upsert({ where, create, update })` is identical;
`db.$transaction` is identical. The schema is what changes — Prisma's
`schema.prisma` becomes TypeScript `model(...)` calls. The
[direct-from-model inference](../README.md#direct-from-model-inference-infer)
section in the README shows how `InferRow<typeof User>` replaces Prisma's
generated `User` type. Once the models compile, the queries usually run
without further edits.

---

Back to the [README index](../README.md#contents) or the framework-by-
framework [browser recipes](./BROWSER-FRAMEWORKS.md).
