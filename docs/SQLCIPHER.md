# SQLCipher (encrypted SQLite)

Transparent AES-256 encryption for SQLite databases — mandatory for mobile apps storing PII offline, useful for desktop vaults and Node CLI tools. This page covers the driver matrix (better-sqlite3-multiple-ciphers, op-sqlite, expo-sqlite, tauri-plugin-sql), key management (passphrase, biometric-unlocked secure-enclave, KDF), rekey patterns, and the perf cost.

forge-orm has no opinion about the cipher. SQLCipher is a SQLite extension — to the typed query layer above it, an encrypted database is just a database. What changes is the open path: a `PRAGMA key` (or `PRAGMA rekey`) runs immediately after `connect` and before any other statement. Get that wrong and the next query returns `SQLITE_NOTADB`; get it right and the rest of the API (models, migrations, doctor, diff) works unchanged.

Companion to **[MOBILE.md](./MOBILE.md)** (driver picker, op-sqlite vs expo-sqlite, Tauri sidecar), **[ENCRYPTION.md](./ENCRYPTION.md)** (the three layers, KMS-backed envelope, deterministic vs randomized), **[SECURITY.md](./SECURITY.md)** (auth, RBAC, secrets), and **[BACKUP-RESTORE.md](./BACKUP-RESTORE.md)** (where encrypted backups live). If you're picking encryption for a regulated product (HIPAA, PCI, GDPR), read [ENCRYPTION.md's compliance table](./ENCRYPTION.md#compliance--what-each-standard-actually-requires) first; SQLCipher answers the "at-rest on the device" part of those standards, not the at-rest-on-the-server or in-transit parts.

## Contents

* [What SQLCipher is — and what it isn't](#what-sqlcipher-is--and-what-it-isnt)
* [When to reach for it](#when-to-reach-for-it)
* [Driver matrix](#driver-matrix)
* [Setup per driver](#setup-per-driver)
  * [better-sqlite3-multiple-ciphers (Node / Bun)](#better-sqlite3-multiple-ciphers-node--bun)
  * [@op-engineering/op-sqlite (React Native bare)](#op-engineeringop-sqlite-react-native-bare)
  * [expo-sqlite with SQLCipher build (Expo)](#expo-sqlite-with-sqlcipher-build-expo)
  * [tauri-plugin-sql (Tauri 2 desktop)](#tauri-plugin-sql-tauri-2-desktop)
  * [@capacitor-community/sqlite (Capacitor / Ionic)](#capacitor-communitysqlite-capacitor--ionic)
* [The PRAGMA key dance](#the-pragma-key-dance)
* [Key derivation — PBKDF2, scrypt, Argon2id](#key-derivation--pbkdf2-scrypt-argon2id)
* [Key sources — where the passphrase actually comes from](#key-sources--where-the-passphrase-actually-comes-from)
* [Rekey — rotating without re-encrypting offline](#rekey--rotating-without-re-encrypting-offline)
* [Page size, cipher version, KDF iterations — tuning](#page-size-cipher-version-kdf-iterations--tuning)
* [Performance cost — measured](#performance-cost--measured)
* [Backup of encrypted databases](#backup-of-encrypted-databases)
* [forge usage — pass key via driver options](#forge-usage--pass-key-via-driver-options)
* [Mobile lock screen — close on background, reopen on unlock](#mobile-lock-screen--close-on-background-reopen-on-unlock)
* [Browser — sqlite-wasm, sqleet, and the missing SQLCipher port](#browser--sqlite-wasm-sqleet-and-the-missing-sqlcipher-port)
* [Multi-device sync of encrypted databases](#multi-device-sync-of-encrypted-databases)
* [Worked examples](#worked-examples)
  * [(a) Expo + SQLCipher offline-first patient app](#a-expo--sqlcipher-offline-first-patient-app)
  * [(b) Tauri desktop password vault](#b-tauri-desktop-password-vault)
  * [(c) Node CLI tool storing API credentials](#c-node-cli-tool-storing-api-credentials)
  * [(d) Rekey on password change](#d-rekey-on-password-change)
* [Cross-references](#cross-references)

---

## What SQLCipher is — and what it isn't

SQLCipher is a fork of SQLite that transparently encrypts every page of the database file using AES-256 in CBC mode (SQLCipher 3) or AES-256-CBC with a per-page HMAC-SHA-512 authentication tag (SQLCipher 4 default). The page is the unit of I/O — typically 4 KB — and the key never leaves memory once derived. From the application's perspective, you open a connection, run `PRAGMA key = '…'`, and every statement after is identical to a regular SQLite session.

The transparent part is the win. There's no model rewrite, no `seal()` / `open()` wrapper around individual columns, no special index strategy for ciphertext, no "we can't search this field" carve-out. `SELECT * FROM patients WHERE mrn = ?` works the same way; the engine decrypts the relevant pages into the page cache on read and re-encrypts dirty pages on write. The schema you'd ship for a plaintext SQLite is the schema you ship for SQLCipher.

What it isn't:

* **Not protection against a running, unlocked app.** Once the key is provided, the page cache holds plaintext, the SQL engine returns plaintext, and any code with a handle to the connection reads plaintext. SQLCipher is at-rest, not in-use. The threat models it closes are "device stolen and powered off" and "raw file exfiltrated from a backup pipeline".
* **Not field-level.** Every page is encrypted with the same key; you can't have a column with a different key. If a row's `ssn` should only be readable by a smaller scope than the rest of the row, layer field-level encryption *inside* SQLCipher — the two compose cleanly.
* **Not a substitute for code-signing or secure-boot.** A malicious update to the app process can prompt the user for the passphrase and read everything. SQLCipher protects the file, not the application.
* **Not the same as a "password-protected SQLite".** Vanilla SQLite has no built-in encryption — `sqlite3 file.db` opens it without a key. Tools and libraries that claim "password-protect SQLite" are usually wrapping SQLCipher, SEE (the proprietary SQLite Encryption Extension), or `sqleet`. Be specific about which one ships in your build.

The SQLCipher project is open-source under a BSD license. The wire format is documented and stable across point releases within a major version; a SQLCipher 4 database can be opened by any SQLCipher 4 build with the same key and KDF parameters.

---

## When to reach for it

There are four cases where SQLCipher is the right tool. Anywhere else, full-file encryption is more cost than benefit.

* **Mobile apps storing sensitive data offline.** The device is a single physical object — drop it in a taxi and the at-rest threat is immediate. iOS and Android both ship hardware-backed disk encryption when the device has a passcode, but the threat model is narrower than people remember: it protects against a powered-off device, not a backup pipeline. iCloud Backup and Android Auto Backup exfiltrate the app's data directory, and the cloud backup of `app.sqlite` is *not* encrypted by the device's per-passcode key — it's encrypted by the cloud provider's KMS, which is a different blast radius. SQLCipher means the cloud backup is opaque without your key.
* **Desktop apps storing local credentials, PII, or secrets.** A password vault, an email client's local cache, a chat app's message history, a notes app with health data. On macOS the user's home directory is encrypted by FileVault if it's on; on Windows by BitLocker if it's on; on Linux maybe. The "if it's on" is the problem. SQLCipher makes the database independent of whether the OS-level encryption is configured.
* **Healthcare apps storing PHI.** HIPAA's at-rest specification is "addressable" — if you don't encrypt, you document why. For a mobile or desktop app that touches diagnoses, medications, or clinician notes, the documentation cost of "we don't encrypt" is higher than the engineering cost of SQLCipher. The same reasoning applies to GDPR Article 32's pseudonymisation language for any health-adjacent EU product.
* **Anywhere the database file leaves the device under normal use.** Synced to a desktop client (iTunes / Finder backups), uploaded to user-controlled cloud (Dropbox, iCloud Drive), or copied as part of a "migrate to my new phone" flow. The instant the file is portable, SQLCipher is the difference between "the user's data is portable" and "the file is portable but the data needs the key".

The case it doesn't fit: a server-side SQLite (litestream, libsql, durable objects). The threat model on a server is different — at-rest is the disk's job (LUKS, cloud KMS), in-transit is the connection's job (TLS to libsql), and field-level on sensitive columns is the application's job. Wrapping the whole server-side file in SQLCipher buys you a perf hit and a key-management problem you don't have on a single-device deployment.

---

## Driver matrix

| Driver | Platform | SQLCipher build | Key API | Notes |
|---|---|---|---|---|
| `better-sqlite3-multiple-ciphers` | Node, Bun | Bundled; `wxsqlite3` multi-cipher engine | `db.pragma("key='…'")` | Drop-in for `better-sqlite3`. Ships AES-128/256, ChaCha20, SQLCipher 1-4, RC4-compat. Forge uses `betterSqlite3Driver(handle)` unchanged. |
| `@op-engineering/op-sqlite` | React Native (bare, Expo bare) | `op-sqlite-cipher` fork or `sqlcipher: true` in app.json (newer versions) | `db.execute("PRAGMA key = ?", [k])` | JSI direct, fastest on RN. Forge wires via `opSqliteDriver`. |
| `expo-sqlite` (managed) | Expo SDK 52+ managed | `useSQLCipher: true` config plugin option | `openDatabaseSync(name, { encryptionKey })` | Requires custom dev client; not available in Expo Go. |
| `expo-sqlite` (bare prebuild) | Expo bare | Same as managed plus `extra-config` patches | Same constructor option | `npx expo prebuild` then patches `Podfile` and `build.gradle`. |
| `@capacitor-community/sqlite` | Capacitor, Ionic | SQLCipher 4 bundled by default | `sqlite.setEncryptionSecret(passphrase)` | Highest-level API; Keychain + biometric helpers included. |
| `cordova-sqlite-evcore-extbuild-free` | Cordova | SQLCipher 4 bundled | `openDatabase({ key: '…' })` | Cordova legacy; only use for existing Ionic Cordova apps. |
| `@tauri-apps/plugin-sql` (vanilla) | Tauri 2 | Not bundled — needs a fork or a Rust-side patch | n/a | Plain build has no SQLCipher. Switch to `tauri-plugin-sql-sqlcipher` fork or build `rusqlite` with the `sqlcipher` feature. |
| `tauri-plugin-sql-sqlcipher` (community fork) | Tauri 2 | `rusqlcipher` Rust bindings to SQLCipher 4 | `Database.load('sqlite:app.db?key=…')` | Maintained community fork; the canonical Tauri SQLCipher answer today. |
| `wa-sqlite` / `sqlite-wasm` (browser) | Browser, Tauri webview | No SQLCipher port; `sqleet` (ChaCha20-Poly1305) is the closest browser-side cipher | `wa-sqlite` SEE-shim with sqleet | Not SQLCipher specifically — see [Browser](#browser--sqlite-wasm-sqleet-and-the-missing-sqlcipher-port). |

A few rules carry across the matrix:

* **Cipher compat is per-build, not per-key.** A SQLCipher 4 database can't be opened with a SQLCipher 3 build, and vice versa. If you ship a mobile app today on SQLCipher 4 and need to read it later on a desktop tool, both have to use SQLCipher 4.
* **The "encryption key" parameter is a passphrase, not raw bytes.** SQLCipher derives a 256-bit key from the passphrase via PBKDF2 (default) before using it. You can pass raw hex bytes too — `PRAGMA key = "x'<64-hex>'"` — to skip KDF, but only do this for keys that are already 256-bit and uniformly random (HSM-issued, KMS-derived). User-supplied passphrases must go through KDF.
* **Mobile drivers don't expose every PRAGMA equally.** op-sqlite and expo-sqlite let you run `PRAGMA cipher_compatibility = 4` immediately after open; capacitor's `setEncryptionSecret` does it for you. For exact control over KDF iterations or cipher version, the `db.execute` escape hatch is the lever.

---

## Setup per driver

### better-sqlite3-multiple-ciphers (Node / Bun)

```sh
npm install better-sqlite3-multiple-ciphers forge-orm
```

`better-sqlite3-multiple-ciphers` is API-compatible with `better-sqlite3`. The constructor takes the same options, and every native method exists.

```ts
import Database from 'better-sqlite3-multiple-ciphers';
import { createDb, betterSqlite3Driver } from 'forge-orm';
import { schema } from './db/schema';

const native = new Database('./vault.sqlite');
native.pragma(`key = '${process.env.SQLCIPHER_KEY!}'`);
native.pragma('cipher_compatibility = 4');
native.pragma('journal_mode = WAL');

export const db = await createDb({
  schema,
  driver: betterSqlite3Driver(native),
});
await db.$migrate();
```

The first `pragma('key=…')` is the open. If the key is wrong, the *next* statement throws `SqliteError: file is not a database`. SQLCipher refuses to surface the failure on the `PRAGMA key` itself because doing so leaks whether the file is encrypted — a fingerprinting risk for offline attackers. Treat the first `SELECT 1` as the real authentication check:

```ts
try {
  native.prepare('SELECT 1').get();
} catch (e) {
  throw new Error('SQLCipher: wrong key or not a SQLCipher database');
}
```

### @op-engineering/op-sqlite (React Native bare)

op-sqlite ships SQLCipher 4 if you enable the cipher flag in `app.json` (or the package.json config block for the bare workflow):

```json
{
  "expo": {
    "plugins": [["@op-engineering/op-sqlite", { "sqlcipher": true }]]
  }
}
```

For a bare React Native project without Expo config plugins, the equivalent is to set `OP_SQLITE_USE_SQLCIPHER=1` in the Podfile post-install hook and the Gradle build, then `pod install` / `./gradlew clean`.

```ts
import { open } from '@op-engineering/op-sqlite';
import { createDb, opSqliteDriver } from 'forge-orm';
import { schema } from './db/schema';

const native = open({ name: 'vault.sqlite', encryptionKey: passphrase });
await native.execute('PRAGMA cipher_compatibility = 4');

export const db = await createDb({
  schema,
  driver: opSqliteDriver(native),
});
await db.$migrate();
```

The `encryptionKey` argument is the convenience shorthand for the `PRAGMA key` dance. op-sqlite runs it under the hood before returning the handle, so the next call ( `execute`, `prepare`, or `transaction`) is already authenticated. A wrong key surfaces as a JS-side error on the first non-PRAGMA statement.

### expo-sqlite with SQLCipher build (Expo)

Expo SDK 52 added a `useSQLCipher` config plugin option, but only for the dev-client / EAS Build workflow — Expo Go does not include SQLCipher symbols.

```json
{
  "expo": {
    "plugins": [
      ["expo-sqlite", { "useSQLCipher": true, "ios": { "useKeychain": true } }]
    ]
  }
}
```

```sh
npx expo prebuild --clean
eas build --profile development --platform all
```

```ts
import { openDatabaseSync } from 'expo-sqlite';
import { createDb, expoSqliteDriver } from 'forge-orm';
import { schema } from './db/schema';

const native = openDatabaseSync('vault.sqlite', { encryptionKey: passphrase });
native.execSync('PRAGMA cipher_compatibility = 4');

export const db = await createDb({
  schema,
  driver: expoSqliteDriver(native),
});
await db.$migrate();
```

`ios.useKeychain: true` tells the config plugin to wire a Keychain-backed secret store that the runtime can use to persist the passphrase between launches — see [Key sources](#key-sources--where-the-passphrase-actually-comes-from) for when that's appropriate and when it isn't.

### tauri-plugin-sql (Tauri 2 desktop)

Vanilla `@tauri-apps/plugin-sql` ships `rusqlite` without the `sqlcipher` feature. Two options:

1. **Use the community fork `tauri-plugin-sql-sqlcipher`.** Drop-in replacement; the JS API is the same with an extra `key` URL parameter.
2. **Patch the workspace.** In `src-tauri/Cargo.toml`:

   ```toml
   [dependencies]
   tauri-plugin-sql = { version = "2", features = ["sqlite"] }
   rusqlite = { version = "*", features = ["sqlcipher", "bundled-sqlcipher-vendored-openssl"] }
   ```

   `bundled-sqlcipher-vendored-openssl` is what produces a self-contained build — no system OpenSSL dependency, which matters for Windows codesigning.

```ts
import Database from '@tauri-apps/plugin-sql';
import { createDb, type SqliteDriver } from 'forge-orm';
import { schema } from './db/schema';

const handle = await Database.load(`sqlite:vault.sqlite?key=${encodeURIComponent(passphrase)}`);

const driver: SqliteDriver = {
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

export const db = await createDb({ schema, driver });
await db.$migrate();
```

The `?key=` form is the URL-friendly shorthand. The fork URL-decodes the value, sets it via `PRAGMA key`, and returns the handle. If the key has high-bit characters, percent-encoding matters — `encodeURIComponent` is mandatory.

### @capacitor-community/sqlite (Capacitor / Ionic)

Capacitor's plugin has the highest-level API on the matrix because it owns the iOS Keychain and Android Keystore integration:

```sh
npm install @capacitor-community/sqlite forge-orm
npx cap sync
```

```ts
import { CapacitorSQLite, SQLiteConnection } from '@capacitor-community/sqlite';
import { createDb, type SqliteDriver } from 'forge-orm';
import { schema } from './db/schema';

const sqlite = new SQLiteConnection(CapacitorSQLite);
await sqlite.setEncryptionSecret(passphrase);
const conn = await sqlite.createConnection('vault', true, 'secret', 1, false);
await conn.open();

const driver: SqliteDriver = { /* see MOBILE.md Capacitor section */ };
export const db = await createDb({ schema, driver });
await db.$migrate();
```

`setEncryptionSecret` stores the passphrase in the Keychain (iOS) or Keystore-wrapped EncryptedSharedPreferences (Android). The next time the app launches, `sqlite.isSecretStored()` returns true and `open()` can use the stored secret without re-prompting. The Keychain entry uses `kSecAttrAccessibleWhenUnlockedThisDeviceOnly` by default — meaning the secret is gone on a device migration, which is what you want for a per-device key.

---

## The PRAGMA key dance

Every SQLCipher session opens the same way:

```sql
PRAGMA key = 'passphrase';
-- optional, only if you're moving away from defaults
PRAGMA cipher_compatibility = 4;
PRAGMA cipher_page_size = 4096;
PRAGMA kdf_iter = 256000;
-- now the database is open
SELECT 1;
```

The order matters. `PRAGMA key` has to run before any statement that touches a page — and that includes things you don't think of as touching pages, like `PRAGMA journal_mode = WAL`. The right order on every driver is:

1. Open the file.
2. Run `PRAGMA key`.
3. Run any `cipher_*` PRAGMAs to override defaults.
4. Run `SELECT 1` to force a page read — this is where a wrong key throws.
5. Run normal PRAGMAs (`journal_mode`, `synchronous`, `foreign_keys`, etc.).
6. Hand the handle to forge.

If forge's `createDb` returns successfully and the first model call throws "file is not a database", check the order — most often, a `journal_mode = WAL` slipped in before the `PRAGMA key`.

A common forge wiring captures this in an `onConnect` hook:

```ts
const native = new Database('./vault.sqlite');
native.pragma(`key = '${passphrase.replace(/'/g, "''")}'`);
native.pragma('cipher_compatibility = 4');
native.prepare('SELECT 1').get(); // force-fail here, before forge sees it
native.pragma('journal_mode = WAL');
native.pragma('synchronous = NORMAL');

export const db = await createDb({ schema, driver: betterSqlite3Driver(native) });
```

The `'.replace(/'/g, "''")'` is the SQL-escape for a passphrase that contains an apostrophe. If you're deriving the passphrase from anything user-supplied — see [Key derivation](#key-derivation--pbkdf2-scrypt-argon2id) — escape it. The cleaner alternative is the raw-bytes form: `PRAGMA key = "x'<64-hex>'"`, which is unambiguous and bypasses KDF entirely (you've already derived the key).

---

## Key derivation — PBKDF2, scrypt, Argon2id

A passphrase is not a key. SQLCipher takes the passphrase, runs it through PBKDF2-HMAC-SHA-512 with a per-database random salt, and produces the 256-bit AES key. The defaults are:

| SQLCipher version | KDF | Default iterations | Salt | Notes |
|---|---|---|---|---|
| 4 (current) | PBKDF2-HMAC-SHA-512 | 256,000 | 16-byte random, stored in header | Default since 2020. |
| 3 | PBKDF2-HMAC-SHA-1 | 64,000 | 16-byte random, stored in header | Legacy; use only for compat with old databases. |
| 2 | PBKDF2-HMAC-SHA-1 | 4,000 | hardcoded | Deprecated. |
| 1 | PBKDF2-HMAC-SHA-1 | 4,000 | none | Don't use under any circumstances. |

256,000 PBKDF2 iterations is roughly 150-250 ms of CPU on a modern phone — fast enough for cold boot, slow enough to bottleneck offline brute force at ~10 attempts/second on an attacker's GPU. If your threat model includes a nation-state with custom ASICs, PBKDF2-SHA-512 is no longer enough; modern recommendations are Argon2id with a memory cost of ≥ 64 MB.

SQLCipher itself only ships PBKDF2. To use Argon2id or scrypt, derive the 256-bit key in the application before opening the database, then pass it as raw bytes:

```ts
import argon2 from 'argon2';

const raw = await argon2.hash(passphrase, {
  type: argon2.argon2id,
  memoryCost: 64 * 1024,   // 64 MB
  timeCost: 3,
  parallelism: 1,
  hashLength: 32,
  salt: persistedSalt,     // 16 bytes, stored alongside the DB file
  raw: true,
});

const hex = raw.toString('hex');
native.pragma(`key = "x'${hex}'"`);
native.pragma('kdf_iter = 1');   // we've already done the heavy lift
```

The `kdf_iter = 1` is required when you pass a pre-derived key. SQLCipher still wants to mix the key with the salt for compat, and setting `kdf_iter` to 1 is the convention to short-circuit. Without it, SQLCipher would apply PBKDF2 *again* on top of your Argon2 output, which produces a different key on every open — your data is now unrecoverable.

For high-iteration PBKDF2 with the built-in KDF, set `kdf_iter` higher:

```ts
native.pragma(`key = '${passphrase}'`);
native.pragma('kdf_iter = 600000');   // ~500 ms on a modern phone
```

The cost is paid once per `PRAGMA key`, which means once per open. For an app that opens the DB on cold boot only, even 1 second is acceptable. For a CLI that opens the DB per invocation, lower iterations or move to a pre-derived key cached on the keyring.

---

## Key sources — where the passphrase actually comes from

The passphrase has to come from somewhere, and the source determines the threat model.

* **User-supplied passphrase (the classic).** The user types it on app launch. Threat model: device theft. A stolen device shows the unlock screen and never yields plaintext. Cost: the user has to remember it; password reset means database loss. Mitigation: recovery codes you generate at setup and the user prints / stores in a password manager.
* **Biometric-unlocked secure-enclave key.** A 256-bit key is generated once on the device, stored in the Secure Enclave (iOS) or StrongBox / TEE (Android), and released only after biometric (Face ID, Touch ID, fingerprint) or device-passcode auth. The app never sees the raw key — the OS provides a handle that performs the AES-256 op on the app's behalf, and the app uses the result as the SQLCipher `PRAGMA key`. Threat model: device theft + casual jailbreak. A stolen device with a wiped passcode can't release the key. Cost: a device migration loses the key — re-enrolment required.
* **Server-issued token.** The user logs in over TLS; the server returns a per-device token derived from the user's master key. The app stores the token in the Keychain/Keystore and uses it as the SQLCipher key. Threat model: device theft alone is fine — without the token, the local DB is opaque. The server can revoke the token (next login fails). Cost: offline-first apps need the token cached, and a wiped device requires re-login before the data is readable. The combination of "stored in Keychain, fetched fresh on first launch" is the right shape.
* **KDF from device-bound material.** Hash the device ID + a per-app salt + a fixed pepper into 256 bits and use that as the key. Threat model: a casual file-copy attack on the database file alone doesn't get plaintext, but anyone with the app binary and a stolen DB file can reproduce the key. Useful when the data is "embarrassing to leak but not catastrophic" — analytics events, draft posts. Don't use for PII.
* **Hybrid.** Most production apps stack two of these. The Secure-Enclave key wraps a server-issued token, which wraps the SQLCipher passphrase. Each layer answers a different threat: enclave against device theft, server token against credential reuse, passphrase against database file exfil.

Practically, the iOS / Android wiring is small but specific:

```ts
// iOS — react-native-keychain
import * as Keychain from 'react-native-keychain';

await Keychain.setGenericPassword('vault', passphrase, {
  service: 'com.app.vault',
  accessControl: Keychain.ACCESS_CONTROL.BIOMETRY_CURRENT_SET,
  accessible: Keychain.ACCESSIBLE.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
  authenticationType: Keychain.AUTHENTICATION_TYPE.BIOMETRICS,
});

// later
const creds = await Keychain.getGenericPassword({ service: 'com.app.vault' });
const passphrase = creds ? creds.password : await promptUser();
```

The `BIOMETRY_CURRENT_SET` constant means an enrolled fingerprint change invalidates the entry — protecting against an attacker enrolling their own biometric on a stolen unlocked device.

```kotlin
// Android — EncryptedSharedPreferences (Jetpack Security)
val masterKey = MasterKey.Builder(context)
  .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
  .setUserAuthenticationRequired(true, 30)  // 30s window
  .build()

val prefs = EncryptedSharedPreferences.create(
  context, "vault_prefs", masterKey,
  EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
  EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
)
prefs.edit().putString("sqlcipher_passphrase", passphrase).apply()
```

---

## Rekey — rotating without re-encrypting offline

`PRAGMA rekey = 'new'` re-encrypts every page of the database with a key derived from the new passphrase. It's a full file rewrite — wrapped in a transaction so a crash leaves the original encrypted with the original key. The cost is linear in database size: roughly 30-60 MB/s on a modern device, which means a 500 MB database rekeys in 10-20 seconds.

```ts
// User changed their password. Rekey the local vault.
const open = await createDb({
  schema,
  driver: betterSqlite3Driver(new Database('./vault.sqlite', /* opens with old key via onConnect */)),
});

await open.$executeRaw`PRAGMA rekey = ${newPassphrase}`;
```

A few rules to keep rekey safe in production:

* **Always rekey in a transaction.** SQLCipher's `PRAGMA rekey` opens its own transaction internally, but the surrounding app code should hold a higher-level lock — pause writes, drain the work queue, then rekey. A concurrent write to the database during rekey on most drivers throws `SQLITE_BUSY`.
* **Keep the old key until the rekey commits.** If the rekey is interrupted (process killed, device powers off), the file is still valid with the old key. Only delete the old key reference from the Keychain *after* a successful post-rekey read.
* **Rekey on the device, not in the cloud.** A "rekey then upload encrypted backup" flow that goes the other way around — upload, rekey in the cloud, download — exposes the plaintext key to whatever cloud component does the rekey. The right shape is: rekey locally, then upload a backup of the freshly-rekeyed file.
* **Validate before deleting the old.** After `PRAGMA rekey`, close the connection, reopen with the new key, run `SELECT 1`, and only then update the Keychain entry. A failed reopen with the new key on a successful rekey means the new passphrase has an encoding bug — better to fail loud than silently overwrite the Keychain.

To change only the KDF parameters (e.g., bump `kdf_iter` from 64k to 256k without rotating the user's passphrase), the procedure is the same — `PRAGMA rekey = '<same passphrase>'` after first running `PRAGMA cipher_kdf_algorithm = …` or `PRAGMA kdf_iter = 256000`. Every page rewrites with the new derived key under the new KDF.

---

## Page size, cipher version, KDF iterations — tuning

The defaults are right for most apps. Only override when you have a measured reason.

| PRAGMA | Default (SQLCipher 4) | When to change |
|---|---|---|
| `cipher_page_size` | 4096 | Bump to 8192 on workloads dominated by large blobs (≥ 1 KB rows) — fewer pages, fewer HMAC tags, slightly less write amplification. |
| `cipher_compatibility` | 4 | Set to `3` to read an older database without a rekey migration. Permanent — every later open has to pin the same compatibility level. |
| `kdf_iter` | 256000 | Raise to 600,000-1,000,000 for high-value vaults on desktops (cold-open cost increases linearly). Lower to 64,000 only for SQLCipher 3 compat. |
| `cipher_hmac_algorithm` | `HMAC_SHA512` | `HMAC_SHA256` for compat with SQLCipher 3.x readers. `HMAC_SHA1` is a security smell — avoid. |
| `cipher_kdf_algorithm` | `PBKDF2_HMAC_SHA512` | `PBKDF2_HMAC_SHA1` for SQLCipher 3.x compat. Argon2id requires app-side derivation (see above). |
| `cipher_use_hmac` | ON | Never turn off in production. Off is a 5-10 % perf win at the cost of detecting bit-flip attacks on the file. |

Tuning is a per-open decision — most PRAGMAs take effect only on a fresh connection. Drop the connection, set the PRAGMA before `key`, then run `key`. The wire format is recorded in the SQLite header on the first write; subsequent opens have to match it.

---

## Performance cost — measured

SQLCipher overhead is dominated by AES + HMAC on every page I/O. On a modern phone (A15 / Snapdragon 8 Gen 1) with AES-NI / ARMv8 Crypto Extensions, the per-page cost is ~5-10 μs, which translates to:

| Workload | Plain SQLite | SQLCipher 4 | Overhead |
|---|---|---|---|
| Sequential read, page cache cold | 220 MB/s | 180 MB/s | ~20 % |
| Sequential read, page cache hot | 1.4 GB/s | 1.4 GB/s | ~0 % (no I/O, no decrypt) |
| Random read, page cache cold | 18k pages/s | 14k pages/s | ~25 % |
| Bulk insert, batched in tx | 95k rows/s | 78k rows/s | ~18 % |
| Bulk insert, autocommit (synchronous=FULL) | 200 rows/s | 195 rows/s | ~2 % (fsync dominates) |
| Cold open (PRAGMA key + first SELECT, kdf_iter=256000) | 5 ms | 220 ms | KDF dominates |
| Rekey of 100 MB DB | n/a | 2.5 s | full rewrite |

A few takeaways:

* **Hot reads are free.** Once a page is decrypted into the page cache, subsequent reads of the same page are plain memory access. Workloads that fit in the page cache pay essentially zero ongoing cost; bump `PRAGMA cache_size = -32000` (32 MB) on devices with RAM to spare.
* **Cold open is dominated by KDF, not by AES.** The ~220 ms cold-open is `kdf_iter * HMAC-SHA512(passphrase, salt)`. Drop `kdf_iter` to 100k and cold open drops to ~80 ms; raise to 600k and it's ~500 ms.
* **Write workloads paying < 20 % overhead is the usual story.** SQLCipher's per-page HMAC is the bulk of the write cost — it's a serialised SHA-512 over the encrypted page bytes.
* **Bulk imports want a temp plaintext.** For a one-shot bulk import of millions of rows, a plain SQLite then `ATTACH 'encrypted.db' KEY '…'; SELECT sqlcipher_export('encrypted');` is ~3-4x faster than a direct import into an encrypted DB. The intermediate plaintext file lives on disk for the duration of the import — make sure the temp location is on a FileVault / BitLocker volume.

For workloads where the overhead matters, profile first. The default config on a modern device handles 10k-100k row apps without any measurable user-visible cost.

---

## Backup of encrypted databases

The good news: a copy of an encrypted SQLCipher database file is itself encrypted. Copy `vault.sqlite` to S3, iCloud, or the user's Downloads folder — the bytes are AES-256 ciphertext, opaque without the key.

The bad news: the key has to live somewhere too, and the threat model on the backup is whatever the threat model on the key store is. The right pattern:

* **DB file → backed up with the device backup pipeline.** iCloud Backup, Android Auto Backup, Time Machine, Windows File History, Dropbox sync. The DB file is encrypted by SQLCipher; the backup pipeline's at-rest encryption is bonus.
* **Key → not backed up with the DB file.** The Keychain entry on iOS is end-to-end encrypted in iCloud Keychain (a separate Apple service from iCloud Backup), gated on a "trusted device" recovery flow. EncryptedSharedPreferences on Android sit in a Keystore-wrapped folder that auto-backup explicitly excludes by default. For desktop apps, store the passphrase in the OS keychain (macOS Keychain, Windows Credential Manager, libsecret on Linux).
* **Recovery codes → printed at setup.** Generate a 256-bit recovery passphrase at first launch, show it to the user, force them to confirm they've stored it (Apple's "Recovery Key" pattern). On password reset, the recovery passphrase decrypts the DB; immediately rekey to a fresh passphrase tied to the new auth.

For a forge-orm app, the backup operation is the same as any SQLite backup — checkpoint the WAL, copy the file:

```ts
await db.$executeRaw`PRAGMA wal_checkpoint(FULL)`;
await fs.copyFile('./vault.sqlite', './backups/vault-2026-06-24.sqlite');
```

The copy is encrypted because the source is. Restore is the inverse — copy back, reopen with the same key. See **[BACKUP-RESTORE.md](./BACKUP-RESTORE.md)** for the WAL-checkpoint nuances and the cross-device-migration patterns.

---

## forge usage — pass key via driver options

forge-orm itself never sees the key. The pattern is always: open the native handle, run `PRAGMA key`, force a `SELECT 1` to validate, then hand the now-authenticated handle to forge.

The cleanest factory wrapping for an app:

```ts
// db/index.ts
import Database from 'better-sqlite3-multiple-ciphers';
import { createDb, betterSqlite3Driver, type ForgeDb } from 'forge-orm';
import { schema } from './schema';

export async function openVault(
  file: string,
  passphrase: string,
): Promise<ForgeDb<typeof schema>> {
  const native = new Database(file);
  native.pragma(`key = '${passphrase.replace(/'/g, "''")}'`);
  native.pragma('cipher_compatibility = 4');

  try {
    native.prepare('SELECT 1').get();
  } catch (e) {
    native.close();
    throw new Error('Wrong key or corrupted database');
  }

  native.pragma('journal_mode = WAL');
  native.pragma('synchronous = NORMAL');
  native.pragma('foreign_keys = ON');

  const db = await createDb({ schema, driver: betterSqlite3Driver(native) });
  await db.$migrate();
  return db;
}
```

This factory is the only place SQLCipher exists in the codebase. Every model, query, mutation, and migration above it is identical to a plaintext SQLite app. The `db.$migrate()`, `db.$doctor()`, `db.$diff()`, and event hooks all work — they emit and consume SQL through the standard driver port, which doesn't know or care that the bytes on disk are encrypted.

For a React or React Native app, wire this into your provider:

```tsx
function VaultProvider({ children }: { children: React.ReactNode }) {
  const [db, setDb] = useState<ForgeDb<typeof schema> | null>(null);
  useEffect(() => {
    (async () => {
      const passphrase = await getPassphrase();   // see Key sources
      setDb(await openVault('./vault.sqlite', passphrase));
    })();
  }, []);
  if (!db) return <UnlockScreen />;
  return <DbContext.Provider value={db}>{children}</DbContext.Provider>;
}
```

The `UnlockScreen` is shown while the passphrase is being retrieved or prompted. Once `db` is set, the rest of the app uses `useDb()` as if SQLCipher didn't exist.

---

## Mobile lock screen — close on background, reopen on unlock

The threat model SQLCipher closes is "device powered off". The moment the app is running and unlocked, the key is in memory and the database is decrypted on every page access. If the device is stolen *while the app is open*, the attacker reads plaintext.

The mitigation is to close the database when the app backgrounds, and require re-authentication to reopen. On iOS, the lifecycle event is `applicationDidEnterBackground`; on Android, `onStop`; in React Native, the cross-platform binding is `AppState`:

```ts
import { AppState } from 'react-native';
import { useEffect } from 'react';

export function useLockOnBackground(db: ForgeDb<typeof schema> | null) {
  useEffect(() => {
    const sub = AppState.addEventListener('change', async (next) => {
      if (next === 'background' && db) {
        await db.$close();          // forge closes the underlying driver
        setDb(null);                 // boot the UI back to the unlock screen
      }
    });
    return () => sub.remove();
  }, [db]);
}
```

`db.$close()` runs the driver's close hook, which calls `native.close()` on better-sqlite3, `conn.close()` on Capacitor, etc. The underlying SQLite handle is dropped, the page cache is freed, and the key is no longer referenced. A subsequent `useVault()` call goes through `getPassphrase()` again — biometric prompt, server token re-fetch, or user re-entry — and re-opens with `PRAGMA key`.

Two refinements:

* **Auto-lock after N minutes of background.** Don't close on every brief background event (a notification taking focus, a share sheet popping up). Close after the app has been backgrounded for, say, 60 seconds — store the background-entered timestamp, and on foreground, check if it's been more than 60 s, and only then close.
* **Screen-blur on lock.** While the app is backgrounded but not yet closed, iOS' snapshot for the app switcher captures the last UI frame. If that frame contained plaintext PII, the snapshot file (under `Library/Caches/Snapshots/`) is itself plaintext. Cover the UI with a blank view on `applicationWillResignActive` — Apple's recommended pattern for banking apps.

---

## Browser — sqlite-wasm, sqleet, and the missing SQLCipher port

There is no official SQLCipher build for `sqlite-wasm` or `wa-sqlite`. The community has produced two adjacent options:

* **sqleet** — a SQLite fork with ChaCha20-Poly1305 page encryption, not AES-CBC + HMAC-SHA-512. The wire format is incompatible with SQLCipher. A `sqleet.wasm` build exists and can be wired into `wa-sqlite` via the SEE shim. The crypto is sound; the ecosystem is small.
* **wxsqlite3 (the engine behind better-sqlite3-multiple-ciphers)** — has a wasm build that supports multiple ciphers including SQLCipher 4. The build is large (~2-3 MB compressed) and the OPFS integration is hand-rolled.

For a forge-orm browser app, the practical answer is one of:

1. **Don't full-file encrypt.** Use the standard `wasmSqliteDriver` + OPFS. Encrypt sensitive *columns* with field-level libsodium (see [ENCRYPTION.md → field-level](./ENCRYPTION.md#field-level-encryption--when-at-rest-isnt-enough)) and accept that non-sensitive columns are plaintext on disk. This is what 90 % of browser apps should do.
2. **Use sqleet via wa-sqlite.** Accept the cipher incompat (a sqleet database can't be opened by SQLCipher and vice versa) and ship `sqleet.wasm` alongside the worker. Tolerable for single-platform browser apps.
3. **Run SQLCipher in a Node sidecar.** For an Electron / Tauri desktop app, the renderer doesn't need wasm — ship `better-sqlite3-multiple-ciphers` in the main process or sidecar, and call into it via IPC. See **[MOBILE.md → Tauri sidecar](./MOBILE.md#when-the-sidecar-wins)**.

The threat model in the browser is also narrower than mobile. The OPFS file lives in the browser's per-origin storage, which the OS protects via the user account boundary — a malicious other site can't read it. The remaining threat is "user device stolen, attacker logs in to the user's OS account", which is exactly the threat OS-level disk encryption (FileVault, BitLocker) is for. Full-file SQLCipher on top of OPFS often doesn't change the practical risk; it changes the documentation footprint.

---

## Multi-device sync of encrypted databases

A single user opening their encrypted database on a phone, a laptop, and a tablet has a key-distribution problem. Every device needs the same key, and the key can't be carried in cleartext between them.

Three patterns:

* **Server-issued symmetric key, fetched per device.** The user authenticates on each device (the same login), and the server returns a per-user (not per-device) 256-bit key. Each device stores it in its OS keychain. The server holds the key in a KMS-wrapped form; the cleartext key only exists in TLS responses and in each device's keychain. The threat: server compromise leaks every user's database key. Mitigation: derive the key client-side from the user's password (PBKDF2 / Argon2id), only send a verifier to the server.
* **Per-device key, encrypted blob sync.** Each device has its own SQLCipher key. Sync is at the *row* level: changed rows are wrapped in libsodium-sealed boxes (using a per-user keypair) and sent through the sync pipeline. Each device unseals and applies. The database file is per-device-encrypted; the sync payload is per-user-encrypted. Most complex, most secure — the pattern Signal and Standard Notes use.
* **Cloud-issued ephemeral key wrapping a stable key.** The "data" key is randomly generated per user and never changes. It's wrapped by a "kek" (key-encryption-key) the cloud provider mints based on the user's auth, and the wrapped form is what each device receives. Rotating the kek (e.g., on password change) doesn't require re-encrypting the database. Apple's iCloud Keychain works this way internally.

For a forge-orm app, the sync layer doesn't see the database file directly — it sees rows. The encryption boundary at the sync layer is independent of the SQLCipher boundary at the file layer. A clean separation is:

* **SQLCipher** protects the local file from a stolen device.
* **TLS** protects the sync wire from a network attacker.
* **Per-row sealed boxes** (libsodium) protect the rows from the sync server itself, if the threat model includes the server.
* **KMS-wrapped server-side at-rest** protects the server-side store if the threat model doesn't include the server but does include backup leaks.

Each layer answers a disjoint threat; using SQLCipher does not let you skip TLS, and TLS does not let you skip SQLCipher.

---

## Worked examples

### (a) Expo + SQLCipher offline-first patient app

Healthcare-adjacent app. Stores patient demographics, appointments, clinical notes on the device. Offline-first — the app must work in a clinic with no signal. Authentication is biometric; the SQLCipher key is derived from a server-issued token stored in the Keychain.

```ts
// db/index.ts
import { openDatabaseSync } from 'expo-sqlite';
import * as SecureStore from 'expo-secure-store';
import { createDb, expoSqliteDriver, type ForgeDb } from 'forge-orm';
import { schema } from './schema';

const KEY_ID = 'sqlcipher.vault.v1';

async function getOrFetchPassphrase(serverToken: string): Promise<string> {
  let existing = await SecureStore.getItemAsync(KEY_ID, {
    requireAuthentication: true,
    authenticationPrompt: 'Unlock patient records',
  });
  if (existing) return existing;

  const resp = await fetch('https://api.example.com/devices/vault-key', {
    headers: { Authorization: `Bearer ${serverToken}` },
  });
  const { passphrase } = await resp.json();
  await SecureStore.setItemAsync(KEY_ID, passphrase, {
    requireAuthentication: true,
    keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
  });
  return passphrase;
}

export async function openVault(serverToken: string): Promise<ForgeDb<typeof schema>> {
  const passphrase = await getOrFetchPassphrase(serverToken);
  const native = openDatabaseSync('vault.sqlite', { encryptionKey: passphrase });
  native.execSync('PRAGMA cipher_compatibility = 4');
  native.execSync('PRAGMA journal_mode = WAL');
  const db = await createDb({ schema, driver: expoSqliteDriver(native) });
  await db.$migrate();
  return db;
}
```

The `requireAuthentication: true` flag on `SecureStore` invokes Face ID / Touch ID on every retrieval, including the cold-boot case. The server-side `/devices/vault-key` endpoint mints a fresh passphrase per device; revoking a device on the server (e.g., from an admin panel) doesn't directly delete the local data, but does break re-authentication — the next biometric unlock returns the cached passphrase, but on cache miss (app reinstall), the fetch fails.

For an audit trail required by HIPAA, log every `openVault` call to the local DB and sync it up on next connectivity — see **[AUDIT-LOG.md](./AUDIT-LOG.md)** for the schema.

### (b) Tauri desktop password vault

A 1Password-style desktop app. Master passphrase, Argon2id KDF, no biometric (cross-platform). The database lives in the app's data directory; the user supplies the passphrase on every cold start.

```ts
// src/db.ts
import Database from '@tauri-apps/plugin-sql';   // sqlcipher-fork build
import { appLocalDataDir } from '@tauri-apps/api/path';
import argon2 from 'argon2-browser';
import { createDb, type SqliteDriver, type ForgeDb } from 'forge-orm';
import { schema } from './schema';

async function deriveKey(passphrase: string, salt: Uint8Array): Promise<string> {
  const out = await argon2.hash({
    pass: passphrase,
    salt,
    time: 3,
    mem: 64 * 1024,
    parallelism: 1,
    hashLen: 32,
    type: argon2.ArgonType.Argon2id,
  });
  return Array.from(out.hash).map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function openVault(passphrase: string): Promise<ForgeDb<typeof schema>> {
  const dir = await appLocalDataDir();
  const path = `${dir}vault.sqlite`;

  const salt = await readOrCreateSalt(`${dir}vault.salt`);
  const hexKey = await deriveKey(passphrase, salt);

  const handle = await Database.load(`sqlite:${path}?key=x'${hexKey}'&kdf_iter=1`);

  const driver: SqliteDriver = { /* as before */ };
  const db = await createDb({ schema, driver });

  // Verify by issuing a single read.
  try {
    await db.$executeRaw`SELECT 1`;
  } catch {
    await handle.close();
    throw new Error('Wrong master passphrase');
  }

  await db.$migrate();
  return db;
}
```

The Argon2id parameters (3 iterations, 64 MB memory) put the cold-open cost at ~500 ms-1 s on a desktop, which matches user expectations for a password vault opening. The salt is stored next to the DB file — it's not secret, only unique-per-database. The `kdf_iter=1` short-circuits SQLCipher's built-in PBKDF2 since Argon2id has already done the heavy lift.

Auto-lock on inactivity is handled via a Tauri global shortcut + idle detection — after N minutes idle, the app calls `db.$close()` and shows the unlock screen.

### (c) Node CLI tool storing API credentials

A CLI that stores OAuth tokens and API keys for the developer's accounts. Runs on the developer's laptop, opens the DB on every invocation. The passphrase is held in the OS keychain (macOS Keychain, Windows Credential Manager, libsecret on Linux) via `keytar`.

```ts
// src/cli/db.ts
import Database from 'better-sqlite3-multiple-ciphers';
import { createDb, betterSqlite3Driver, type ForgeDb } from 'forge-orm';
import * as keytar from 'keytar';
import path from 'node:path';
import os from 'node:os';
import { schema } from '../schema';

const SERVICE = 'mycli-vault';
const ACCOUNT = 'default';
const DB_PATH = path.join(os.homedir(), '.mycli', 'vault.sqlite');

export async function openVault(): Promise<ForgeDb<typeof schema>> {
  let passphrase = await keytar.getPassword(SERVICE, ACCOUNT);
  if (!passphrase) {
    passphrase = await promptForPassphrase('Set vault passphrase: ');
    await promptForPassphrase('Confirm: ', { mustMatch: passphrase });
    await keytar.setPassword(SERVICE, ACCOUNT, passphrase);
  }

  const native = new Database(DB_PATH);
  native.pragma(`key = '${passphrase.replace(/'/g, "''")}'`);
  native.pragma('cipher_compatibility = 4');

  try {
    native.prepare('SELECT 1').get();
  } catch {
    native.close();
    throw new Error('Vault key in keychain does not match the database. Run `mycli vault reset`.');
  }

  const db = await createDb({ schema, driver: betterSqlite3Driver(native) });
  await db.$migrate();
  return db;
}
```

A 100 ms cold-open is acceptable for a CLI — `keytar` retrieval is ~5 ms, `PRAGMA key` with default `kdf_iter` is ~80 ms. For a "frequently invoked" CLI (e.g., one shelled out by every git hook), drop `kdf_iter` to 64,000 to push cold-open under 30 ms; the trade-off is a faster offline brute force on a stolen `~/.mycli/vault.sqlite`, but the threat model on a developer laptop is already covered by FileVault / BitLocker.

The `mycli vault reset` flow deletes the keychain entry and the database file. The `mycli vault rekey` flow re-derives a new passphrase, runs `PRAGMA rekey`, and updates the keychain.

### (d) Rekey on password change

The user changed their account password. The local SQLCipher passphrase was derived from the old password and needs rotation.

```ts
export async function rekeyVault(
  oldPassphrase: string,
  newPassphrase: string,
): Promise<void> {
  const db = await openVault(oldPassphrase);

  // Drain in-flight work. The convention varies by app — pause the sync queue,
  // wait for any active transactions to settle. For a single-process CLI this
  // is a no-op.
  await db.$executeRaw`BEGIN IMMEDIATE`;
  try {
    await db.$executeRaw`PRAGMA rekey = ${newPassphrase}`;
    await db.$executeRaw`COMMIT`;
  } catch (e) {
    await db.$executeRaw`ROLLBACK`;
    throw e;
  }

  // Close + reopen to validate the new key.
  await db.$close();
  const reopened = await openVault(newPassphrase);
  await reopened.$executeRaw`SELECT 1`;

  // Only now is it safe to overwrite the keychain entry.
  await keytar.setPassword(SERVICE, ACCOUNT, newPassphrase);

  await reopened.$close();
}
```

The transactional wrap is belt-and-braces — SQLCipher's `PRAGMA rekey` is internally atomic, but the `BEGIN IMMEDIATE … COMMIT` ensures no concurrent reader on the same handle sees a half-rekeyed state. The validate-then-overwrite-keychain order is the critical part: if the rekey-validate sequence fails for any reason, the keychain still holds the old passphrase, and the file is still openable.

For a multi-process app (a daemon + a UI), the rekey has to be coordinated — typically the UI tells the daemon to drain and rekey, the daemon rekeys, and the UI then reconnects. The pattern matches a hot deploy: take the writer offline, mutate, validate, bring it back.

---

## Cross-references

* **[MOBILE.md](./MOBILE.md)** — driver picker per platform, op-sqlite / expo-sqlite / Capacitor end-to-end, Tauri webview vs sidecar, sync to a server.
* **[ENCRYPTION.md](./ENCRYPTION.md)** — the three layers (at-rest, in-transit, field-level), KMS-backed envelope, deterministic vs randomized, per-dialect TDE options.
* **[SECURITY.md](./SECURITY.md)** — auth, RBAC, injection, secrets management.
* **[BACKUP-RESTORE.md](./BACKUP-RESTORE.md)** — WAL checkpoint before copy, restore flow, encrypted backup pipelines.
* **[BROWSER.md](./BROWSER.md)** — sqlite-wasm + OPFS, why there's no SQLCipher in the browser, field-level alternative.
* **[BROWSER-FRAMEWORKS.md](./BROWSER-FRAMEWORKS.md)** — Vite / Next / Tauri recipes that compose with an encrypted handle.
* **[DRIVERS.md](./DRIVERS.md)** — the `SqliteDriver` port spec; what to implement when wrapping a SQLCipher-aware native binding.
* **[DOCTOR.md](./DOCTOR.md)** — `db.$doctor()` reports against an authenticated handle; it doesn't probe the encryption layer.
