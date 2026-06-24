# Encryption

Three layers — at-rest, in-transit, in-use (field-level) — and the choices each one carries: TDE vs app-layer, deterministic vs randomized, KMS-backed key management, and the per-dialect quirks (Mongo CSFLE, MSSQL Always Encrypted, SQLCipher). This page documents the patterns that compose with forge-orm.

forge-orm itself never reads or writes keys. The library serializes whatever value you pass into a column; if that value is a ciphertext, forge stores ciphertext. The TLS connection is the driver's. The TDE is the database's. The field-level envelope is yours. Everything on this page is glue that sits *around* forge, not inside it — which is why the same field-level pattern works identically across Postgres, Mongo, SQLite-on-mobile, and DuckDB.

Companion to **[SECURITY.md](./SECURITY.md)** (auth, RBAC, injection, secrets), **[BACKEND.md](./BACKEND.md)** (connection wiring, pooling, observability), and **[BACKUP-RESTORE.md](./BACKUP-RESTORE.md)** (where encrypted backups live). If you're picking encryption for a regulated product (HIPAA, PCI, GDPR), read [Compliance — what each standard actually requires](#compliance--what-each-standard-actually-requires) first; the answer changes which of the three layers you can stop at.

## Contents

* [The three layers](#the-three-layers)
* [At-rest — per-dialect options](#at-rest--per-dialect-options)
  * [Postgres](#postgres)
  * [MySQL / MariaDB](#mysql--mariadb)
  * [SQLite](#sqlite)
  * [DuckDB](#duckdb)
  * [MongoDB](#mongodb)
  * [MSSQL](#mssql)
* [In-transit — TLS to the database](#in-transit--tls-to-the-database)
* [Field-level encryption — when at-rest isn't enough](#field-level-encryption--when-at-rest-isnt-enough)
* [Algorithm choice — AEAD or it didn't happen](#algorithm-choice--aead-or-it-didnt-happen)
* [Deterministic vs randomized](#deterministic-vs-randomized)
* [Encrypted indexes and searchable encryption](#encrypted-indexes-and-searchable-encryption)
* [Key management — KMS, envelope, rotation](#key-management--kms-envelope-rotation)
* [Browser and mobile](#browser-and-mobile)
* [SQLCipher specifics](#sqlcipher-specifics)
* [Performance cost — measured overhead](#performance-cost--measured-overhead)
* [Backup encryption](#backup-encryption)
* [Compliance — what each standard actually requires](#compliance--what-each-standard-actually-requires)
* [Worked examples](#worked-examples)
* [Cross-references](#cross-references)

---

## The three layers

| Layer | What it protects against | What it does not protect against |
|---|---|---|
| **At-rest** | Stolen disk, stolen backup tape, decommissioned drive resold without wiping, cloud volume snapshot leaked. | Anyone with a live DB connection — the engine decrypts on read, so a compromised app credential reads cleartext. |
| **In-transit** | Network sniffing, on-path attackers, ISP visibility into queries. | A compromised TLS endpoint, an intermediary you trusted (a proxy you forgot you deployed), a misconfigured `sslmode=require` that accepts any cert. |
| **In-use (field-level)** | A compromised DBA, a stolen DB credential, a SQL injection that exfiltrates a table, a logs-and-metrics pipeline that captured row values. | An attacker with the encryption key. Field-level encryption is a key-management problem with a cryptographic veneer. |

You stack these by threat model, not by checklist. A consumer SaaS storing email addresses needs at-rest and in-transit; field-level on email is theatre. A health platform storing diagnoses needs all three, and the field-level layer's key has to be inaccessible to the app process at rest (KMS-wrapped, fetched per request, never logged). A retail site storing PANs needs to *not store PANs* — tokenize at the gateway, store the token, skip the encryption question entirely.

The rule of thumb: at-rest is a compliance baseline (every regulated standard requires it; cloud-managed DBs give you it for free), in-transit is non-negotiable (you turn it on by setting `sslmode` correctly), and field-level is a deliberate decision per column. The mistake is the inverse: field-level on every column "to be safe", which destroys queryability without changing the threat model.

---

## At-rest — per-dialect options

At-rest encryption is a property of the disk or the engine. forge sees none of it — `SELECT email FROM users` returns the same plaintext bytes whether the storage layer is encrypted or not. The choice is operational: which key store, which rotation cadence, which performance cost.

### Postgres

Postgres has no native TDE in the open-source distribution. Three production patterns:

* **Filesystem encryption (LUKS / dm-crypt on Linux, BitLocker on Windows, FileVault on macOS)** — encrypts the data directory, the WAL, the temp files. The key lives in the TPM or in `/etc/crypttab` (sealed). Adds a single-digit-percent CPU cost. The default for self-hosted Postgres on Linux.
* **Cloud-managed TDE** — RDS, Aurora, Cloud SQL, Azure Database for PostgreSQL all encrypt the underlying storage with AES-256, keyed by the cloud KMS. Toggle at create time; on RDS it can't be turned on after the fact (snapshot-restore-into-encrypted is the workaround). The cloud KMS rotation is annual by default and transparent — the engine never sees the keystream.
* **`pgcrypto` per column** — Postgres ships an `EXTENSION pgcrypto` with `pgp_sym_encrypt(value, key)` and `pgp_pub_encrypt(value, pubkey)`. This is *not* TDE; it's field-level encryption that happens server-side. The key is passed in the SQL query, which means it appears in pg_stat_statements unless you scrub it. Avoid unless you have a strong reason — app-side libsodium is safer.

The cloud-managed option is the default for any new Postgres deployment. RDS-encrypted snapshots can be copied across regions; the destination uses a different KMS key, which makes cross-region restore a permissions exercise rather than a crypto one.

```sh
# Self-hosted Postgres on LUKS — sealing key in the TPM
cryptsetup luksFormat /dev/nvme1n1
cryptsetup luksOpen /dev/nvme1n1 pgdata --key-file /etc/luks/pg.key
mkfs.ext4 /dev/mapper/pgdata
mount /dev/mapper/pgdata /var/lib/postgresql
```

### MySQL / MariaDB

MySQL has native InnoDB tablespace encryption. The keyring sits in a plugin (file-based, AWS KMS, HashiCorp Vault), and the master key wraps per-tablespace keys.

```sql
-- Per-table at create time
CREATE TABLE patients (id BIGINT PRIMARY KEY, mrn VARCHAR(64)) ENCRYPTION = 'Y';

-- Or system-wide
SET PERSIST default_table_encryption = ON;
SET PERSIST innodb_redo_log_encrypt = ON;
SET PERSIST innodb_undo_log_encrypt = ON;
SET PERSIST binlog_encryption = ON;
```

The keyring plugin choice matters. `keyring_file` puts the master key on disk next to the data files — fine for development, useless for production (the threat model "stolen disk" doesn't go away if the key is on the same disk). Production uses `keyring_aws` or `keyring_okv` (Oracle Key Vault) or HashiCorp Vault's KMIP integration. Cloud-managed RDS MySQL skips the keyring entirely; the storage layer is encrypted underneath InnoDB, transparent to the engine.

Rotation: `ALTER INSTANCE ROTATE INNODB MASTER KEY;` re-encrypts the per-tablespace keys with a new master. The tablespaces themselves are not re-encrypted (that would be terabytes of rewrite). The threat model the rotation closes is "the previous master key leaked"; the tablespace keys still in use are protected by the new wrap.

### SQLite

SQLite ships with no encryption. The standard answer is **SQLCipher** — a fork that transparently encrypts every page with AES-256-CBC plus HMAC-SHA-512 page authentication. The key is supplied via `PRAGMA key = '…';` immediately after open and before any other statement. See [SQLCipher specifics](#sqlcipher-specifics) and the dedicated **[SQLCIPHER.md](./SQLCIPHER.md)** page.

```ts
import { createDb, f, model } from 'forge-orm';

const db = await createDb({
  url: 'sqlite:./encrypted.db',
  driver: 'better-sqlite3', // SQLCipher build
  onConnect: async (raw) => {
    raw.pragma(`key = '${process.env.SQLCIPHER_KEY!}'`);
    raw.pragma('cipher_compatibility = 4');
  },
  schema: { /* … */ },
});
```

For litestream-backed SQLite, the streamed WAL goes to S3 — turn on bucket-level SSE (`AES256` or `aws:kms`) so the streamed copy is also encrypted at rest. The SQLCipher key never leaves the application; the S3-side key is a separate concern that lives in the cloud KMS.

For sqlite-wasm in the browser, SQLCipher's browser build is large (~3 MB) and a serious dependency. Field-level encryption on the sensitive columns is usually a better trade than full-DB encryption — see [Browser and mobile](#browser-and-mobile).

### DuckDB

DuckDB exposes file-level encryption via `ATTACH '…' AS db (ENCRYPTION_KEY '…');` for newer versions. The key wraps AES-256-GCM page encryption. For older versions, file-system-level encryption (LUKS, BitLocker) is the answer.

```sql
ATTACH 'analytics.duckdb' AS analytics (ENCRYPTION_KEY 'base64-32-bytes');
```

DuckDB is usually a downstream analytical mirror of an OLTP source — the canonical pattern is "encrypt at the source, treat the DuckDB as a transient cache". If the DuckDB file lives on a server with full-disk encryption, you've inherited the protection without a per-file key to manage.

### MongoDB

Mongo has native encryption at rest on Atlas, on Enterprise on-prem (via KMIP), and on MongoDB Community (via the WiredTiger storage engine's `encryption: { enabled: true, kmip: { … } }` config). All three encrypt the data files, indexes, and journal with AES-256-CBC; the keystore is KMIP-managed.

The bigger Mongo story is **CSFLE — Client-Side Field-Level Encryption** — and Queryable Encryption, the next-gen version that supports equality and range queries on encrypted fields. Both move the encryption boundary inside the driver: the database sees ciphertext, the application sees plaintext, the encryption keys live in a KMS the database can't reach. This is the cleanest field-level story of any dialect.

```ts
import { MongoClient, ClientEncryption } from 'mongodb';

const keyVaultNamespace = 'encryption.__keyVault';
const kmsProviders = {
  aws: { accessKeyId: process.env.AWS_KEY!, secretAccessKey: process.env.AWS_SECRET! },
};

const client = new MongoClient(process.env.MONGO_URL!, {
  autoEncryption: {
    keyVaultNamespace,
    kmsProviders,
    schemaMap: {
      'app.patients': {
        bsonType: 'object',
        properties: {
          ssn: {
            encrypt: {
              bsonType: 'string',
              algorithm: 'AEAD_AES_256_CBC_HMAC_SHA_512-Deterministic',
              keyId: [/* UUID */],
            },
          },
        },
      },
    },
  },
});
```

forge's Mongo adapter wires through the underlying `MongoClient`, so the `autoEncryption` block above is the integration point. See [Worked example (b): Mongo CSFLE](#b-mongo-csfle-end-to-end).

### MSSQL

MSSQL has two distinct encryption features that solve different problems.

* **TDE (Transparent Data Encryption)** — file-level, transparent to queries. Encrypts the data files, transaction log, and backups with a database encryption key (DEK), which is itself encrypted by a server-level certificate or asymmetric key (EKM with HSM / Azure Key Vault).

  ```sql
  CREATE MASTER KEY ENCRYPTION BY PASSWORD = '…';
  CREATE CERTIFICATE TDECert WITH SUBJECT = 'TDE';
  USE [app];
  CREATE DATABASE ENCRYPTION KEY WITH ALGORITHM = AES_256 ENCRYPTION BY SERVER CERTIFICATE TDECert;
  ALTER DATABASE [app] SET ENCRYPTION ON;
  ```

* **Always Encrypted** — column-level, client-driven. The driver encrypts and decrypts on the client side using a column encryption key (CEK), which is wrapped by a column master key (CMK) the DB never sees. The DBA can't read the column. With Always Encrypted with Secure Enclaves, equality and range queries work inside an attested enclave on the server; without enclaves, only equality on deterministic-encrypted columns works.

  ```sql
  CREATE COLUMN MASTER KEY MyCMK WITH (
    KEY_STORE_PROVIDER_NAME = 'AZURE_KEY_VAULT',
    KEY_PATH = 'https://my-vault.vault.azure.net/keys/CMK1/abc123'
  );
  CREATE COLUMN ENCRYPTION KEY MyCEK WITH VALUES (
    COLUMN_MASTER_KEY = MyCMK,
    ALGORITHM = 'RSA_OAEP',
    ENCRYPTED_VALUE = 0x01…
  );

  CREATE TABLE patients (
    id BIGINT PRIMARY KEY,
    ssn CHAR(11) COLLATE Latin1_General_BIN2 ENCRYPTED WITH (
      COLUMN_ENCRYPTION_KEY = MyCEK,
      ENCRYPTION_TYPE = DETERMINISTIC,
      ALGORITHM = 'AEAD_AES_256_CBC_HMAC_SHA_256'
    )
  );
  ```

TDE is the default for any new MSSQL deployment. Always Encrypted is for a specific subset of columns (SSN, financial accounts) where the DBA threat is real and the queryability cost is acceptable.

---

## In-transit — TLS to the database

Every supported driver ships a TLS option. The hard part is not turning TLS on — it's configuring certificate verification correctly so a man-in-the-middle proxy can't impersonate the server.

| Dialect | "On" but unsafe | Safe |
|---|---|---|
| Postgres | `sslmode=require` (accepts any cert) | `sslmode=verify-full` + `sslrootcert=…` |
| MySQL | `ssl-mode=PREFERRED` (no verification) | `ssl-mode=VERIFY_IDENTITY` + `ssl-ca=…` |
| MongoDB | `tls=true` | `tls=true&tlsCAFile=…&tlsAllowInvalidHostnames=false` |
| MSSQL | `Encrypt=true;TrustServerCertificate=true` | `Encrypt=strict;TrustServerCertificate=false;HostNameInCertificate=…` |
| SQLite | (local — N/A) | n/a |
| DuckDB | (local — N/A) | n/a (HTTP-attached extensions inherit fetch TLS) |

forge passes the connection URL straight through to the driver. The right shape is:

```ts
import { createDb } from 'forge-orm';
import { readFileSync } from 'node:fs';

const db = await createDb({
  url: 'postgres://app:…@db.internal:5432/app?sslmode=verify-full',
  driver: 'pg',
  ssl: {
    ca: readFileSync('/etc/ssl/certs/db-ca.pem', 'utf-8'),
    rejectUnauthorized: true,
  },
  schema: { /* … */ },
});
```

The `sslmode=require` antipattern shows up in tutorials because it's the line that makes the connection "work over TLS". It accepts any certificate, including one served by an attacker on the same network. Anyone hand-rolling a Postgres connection on a cloud VPC should treat `sslmode=require` as a bug and reach for `verify-full` plus the CA bundle from the cloud provider (`rds-combined-ca-bundle.pem`, Cloud SQL's instance certificate, etc.).

For mTLS (mutual TLS — the client also presents a certificate), pass `cert` and `key` alongside `ca`. This is the pattern for service-mesh-fronted databases (Istio, Linkerd, Consul Connect) and for HSM-backed client certificates in regulated industries.

```ts
ssl: {
  ca: readFileSync('/etc/ssl/db-ca.pem'),
  cert: readFileSync('/etc/ssl/client.pem'),
  key: readFileSync('/etc/ssl/client.key'),
  rejectUnauthorized: true,
}
```

A common gotcha on PaaS deployments (Vercel, Fly, Railway) is that the CA bundle isn't available at runtime. Bake it into the build, or use the cloud DB's "use system CA" mode (Cloud SQL Auth Proxy, RDS IAM auth) so the platform handles cert distribution.

---

## Field-level encryption — when at-rest isn't enough

At-rest encryption protects against threats that handle disks. Field-level encryption protects against threats that handle live queries. The threat models are disjoint, and the costs are too — at-rest is free (it's the engine), field-level costs queryability, performance, and ongoing key management.

You reach for field-level when one of these is true:

* **Compliance requires it specifically.** PCI-DSS 3.4 requires PAN to be rendered unreadable. HIPAA's "addressable" encryption specification means "if you don't do it, you document why". GDPR's Article 32 names pseudonymisation, which field-level encryption implements.
* **The DB credential is shared more broadly than the data should be.** A BI team that needs read access for analytics but should not see SSNs.
* **A breach of the DB through SQL injection or credential theft would still leak cleartext.** At-rest stops decommissioned-drive theft; it does not stop `SELECT * FROM patients` through a leaked role.
* **Backups are stored somewhere with a different blast radius than the live DB.** A backup vault on a third-party object store, copied to a partner for DR, snapshotted to a different cloud.

The pattern is always the same: the application encrypts before insert and decrypts after select, using a key that lives in a KMS the database can't reach. forge stays out — the encrypted blob is just `Buffer` (or `string`, base64-encoded) in your schema.

```ts
import { f, model } from 'forge-orm';

export const Patient = model('patients', {
  id: f.id(),
  email: f.string(),
  // The ciphertext column. Never index unless it's deterministic — see below.
  ssn_ciphertext: f.bytes().nullable(),
  // A search blind index if you need lookups — see Encrypted indexes.
  ssn_blind_index: f.string().nullable().index(),
});
```

The encrypt-on-write / decrypt-on-read wrapping is a thin layer that doesn't belong in the schema; it belongs in a service or repository module:

```ts
import { seal, open } from './crypto'; // libsodium wrapper

export const patientRepo = {
  async create(scopedDb, input: { email: string; ssn: string }) {
    const ssn_ciphertext = await seal(input.ssn, 'patient.ssn');
    const ssn_blind_index = await blindIndex(input.ssn);
    return scopedDb.Patient.create({ email: input.email, ssn_ciphertext, ssn_blind_index });
  },

  async findBySsn(scopedDb, ssn: string) {
    const bi = await blindIndex(ssn);
    const row = await scopedDb.Patient.findFirst({ where: { ssn_blind_index: bi } });
    if (!row) return null;
    return { ...row, ssn: await open(row.ssn_ciphertext!, 'patient.ssn') };
  },
};
```

The `seal` and `open` calls are where the KMS-backed envelope lives. See [Key management](#key-management--kms-envelope-rotation) for the wrap/unwrap pattern.

---

## Algorithm choice — AEAD or it didn't happen

Use **AEAD** (Authenticated Encryption with Associated Data). Two production-grade choices in 2026:

* **AES-256-GCM** — the standard. Hardware-accelerated on every modern CPU (AES-NI). Available in `node:crypto`, in WebCrypto, in libsodium-wrapped form, in every language's standard library.
* **ChaCha20-Poly1305** — the alternative when AES-NI isn't available (some ARM cores, browsers without WebCrypto). Slightly faster on those targets, identical security guarantees.

Both are 256-bit AEAD ciphers with a 96- or 192-bit nonce, a 128-bit authentication tag, and the option to bind associated data (column name, row id, tenant id) that authenticated but not encrypted.

**Never use:**

* **AES-CBC without HMAC** — malleable; an attacker can flip bits in the ciphertext to produce different (but valid) plaintext on decrypt.
* **AES-ECB** — every block of the same plaintext produces the same ciphertext. The "Tux ECB penguin" is real and embarrassing.
* **RC4, DES, 3DES** — broken.
* **Roll-your-own combinations** — "encrypt-then-MAC with CBC-HMAC" is correct in principle but every implementation has a side-channel-prone subtlety. Use the AEAD construction the standard library provides.

The shape of the AEAD call:

```ts
import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';

export async function aeadEncrypt(key: Buffer, plaintext: Buffer, aad: Buffer): Promise<Buffer> {
  const nonce = randomBytes(12); // 96-bit GCM nonce, fresh per encryption
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag(); // 128-bit tag
  // Self-describing envelope: nonce ‖ tag ‖ ciphertext
  return Buffer.concat([nonce, tag, ciphertext]);
}

export async function aeadDecrypt(key: Buffer, envelope: Buffer, aad: Buffer): Promise<Buffer> {
  const nonce = envelope.subarray(0, 12);
  const tag = envelope.subarray(12, 28);
  const ciphertext = envelope.subarray(28);
  const decipher = createDecipheriv('aes-256-gcm', key, nonce);
  decipher.setAAD(aad);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}
```

The **AAD** carries the column identity and the row id. Binding the column name prevents an attacker from copying a ciphertext from `addresses.home_zip` into `patients.ssn` and getting it decrypted with the SSN key. Binding the row id prevents replay across rows.

The **nonce** must never repeat under the same key. 12 random bytes per encryption gives you 2^48 encryptions before collision becomes a concern — far beyond any realistic workload. If you're encrypting more than 2^32 values per key (a few billion), rotate the key, or switch to a deterministic nonce (counter), or use XChaCha20-Poly1305 (192-bit nonce, designed for unbounded random nonces).

libsodium wraps this with a friendlier API:

```ts
import sodium from 'libsodium-wrappers-sumo';
await sodium.ready;

const envelope = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
  plaintext,
  aad,
  null,
  sodium.randombytes_buf(sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES),
  key,
);
```

Use libsodium if you're already on it; use `node:crypto` if you want to stay zero-dep. Both produce ciphertext you can store in a `f.bytes()` column.

---

## Deterministic vs randomized

A randomized encryption gives a different ciphertext every time you encrypt the same plaintext — fresh nonce, fresh authentication tag. A deterministic encryption produces the same ciphertext for the same plaintext, which lets you do exact-match queries (`WHERE ssn_ciphertext = ?`) but leaks equality.

| | Deterministic | Randomized |
|---|---|---|
| Same plaintext → | Same ciphertext | Different ciphertext |
| Equality search | Yes | No |
| Frequency analysis | Leaks (you can see "SSN X appears 7 times") | None |
| Compliance posture | "Encrypted with caveats" | "Encrypted" |
| Index works | Yes | Only over a separate blind index |
| Default choice | Use only when you must search | Use everywhere else |

Deterministic encryption is what makes MSSQL Always Encrypted and Mongo CSFLE able to do equality matching against an encrypted column. Both engines use AEAD constructions in deterministic mode (`AEAD_AES_256_CBC_HMAC_SHA_256-Deterministic`), where the nonce is derived from a separate key plus the plaintext, not from randomness. The construction is sound — it doesn't leak the key — but it does leak which rows have equal values, which is enough for frequency analysis on low-entropy fields (state codes, blood types, gender).

The pragmatic split:

* **Randomized** for high-entropy fields (long-form notes, medical records, full addresses) where you never query the value directly.
* **Deterministic** for low-entropy lookup fields where you need exact-match (SSN-to-find-patient, email-to-find-user).
* **Blind index over randomized** for lookup fields where you want stronger leakage protection than deterministic gives. See [Encrypted indexes](#encrypted-indexes-and-searchable-encryption).

The blind-index pattern is the safest middle ground for app-layer encryption — randomized ciphertext for the data, HMAC-based blind index for the lookup, the index column scrubbed of entropy by truncation so it can collide intentionally and resist frequency attacks.

---

## Encrypted indexes and searchable encryption

Encrypted fields don't sort, don't range-query, and don't do `LIKE`. What works:

* **Exact-match via deterministic encryption.** Works in MSSQL Always Encrypted, Mongo CSFLE, and any app-layer scheme where you re-derive the same ciphertext for the lookup. Leakage: equality patterns.
* **Exact-match via blind index.** The app stores `HMAC(key, normalised(plaintext))` in a sibling column. Equality on the HMAC gives you exact-match lookup; the HMAC reveals nothing about the underlying value without the key. Truncate the HMAC to ~8 bytes so multiple plaintexts collide and frequency analysis is degraded.
* **Range query via order-preserving encryption (OPE).** Cryptographically dubious; leaks the order of plaintexts. Avoid unless your only alternative is decrypt-then-filter at the application.
* **Range and equality via Mongo Queryable Encryption.** A newer scheme that uses an indexed encrypted structure to support both equality and range queries without revealing them to the server. Requires the MongoDB 7.0+ driver and a separate encrypted state collection.
* **Substring search via fully homomorphic encryption (FHE).** Practical only for tiny workloads. Skip.

The blind-index pattern is the workhorse for forge-orm apps. The shape:

```ts
import { createHmac } from 'node:crypto';

export function blindIndex(key: Buffer, plaintext: string, truncBytes = 8): string {
  // Normalise: lowercase, strip spaces, NFC for unicode. Match this exactly at write and read.
  const normalised = plaintext.normalize('NFC').toLowerCase().replace(/\s+/g, '');
  const mac = createHmac('sha256', key).update(normalised).digest();
  return mac.subarray(0, truncBytes).toString('hex');
}
```

In the schema, the blind-index column is just a `f.string().index()`:

```ts
export const User = model('users', {
  id: f.id(),
  email_ciphertext: f.bytes(),
  email_blind_index: f.string().index(),
  created_at: f.timestamp().defaultNow(),
});
```

Lookups:

```ts
const bi = blindIndex(emailKey, 'alice@example.com');
const row = await db.User.findFirst({ where: { email_blind_index: bi } });
const email = await aeadDecrypt(emailKey, row.email_ciphertext, Buffer.from(`user.email:${row.id}`));
```

The **truncation** is doing real work here. A full 32-byte HMAC is a unique identifier — an attacker who builds a dictionary of `HMAC(known_email)` values can confirm membership. An 8-byte truncated HMAC collides every ~4 billion values, which sounds rare but is enough to make the dictionary attack ambiguous. The trade-off: the lookup returns "candidates" (a small handful of rows on a normal table), and the app decrypts each to find the real match. For tables with millions of rows this is fine; for billions it's not, and you raise the truncation to 12 or 16 bytes.

CipherSweet (https://github.com/paragonie/ciphersweet) packages this pattern with deterministic-or-blind variants and "compound indexes" (HMAC of multiple normalised fields). The Mongo CSFLE story replaces it. For Postgres/MySQL/SQLite there's no library that's right for forge — the 30 lines above are usually sufficient, and the explicitness is a feature.

---

## Key management — KMS, envelope, rotation

The cryptographic primitives are the easy part. The hard part is where the keys live and how they rotate.

The **never** list:

* Hardcoded keys in source.
* Keys in `.env` files committed to the repo.
* Keys in environment variables that survive process restart and live on the file system in `/proc/<pid>/environ`.
* Keys in a database column ("encrypt-keys-with-keys" without a root of trust).
* Keys that don't rotate.

The shape that works in production is **envelope encryption with a KMS root**:

1. A long-lived **master key** (KEK — key encryption key) lives in AWS KMS / Google Cloud KMS / Azure Key Vault / HashiCorp Vault. It never leaves the KMS; the app calls `Encrypt` / `Decrypt` over the network.
2. The app generates **data keys** (DEKs) — random 32-byte values — for actual encryption work. Each DEK is used to encrypt one column (or one row, or one tenant; the granularity is a choice).
3. The app calls KMS to **wrap** each DEK with the KEK. The wrapped DEK is stored next to the ciphertext (in a separate `keys` table, or in the same envelope as the ciphertext, depending on rotation strategy).
4. On read, the app fetches the wrapped DEK, calls KMS to **unwrap** it, uses the DEK to decrypt the value, and discards the DEK.

The advantages:

* The master key never sits in app memory; KMS does the wrap/unwrap server-side.
* Rotating the master key in KMS re-wraps the DEKs without re-encrypting the data. This is a metadata operation on the keys table — fast.
* Rotating the DEKs is a per-column or per-row re-encryption — slow, but you don't do it often.
* KMS access is auditable. Every unwrap call appears in CloudTrail / Cloud Audit Logs.

The AWS KMS version with the `@aws-sdk/client-kms`:

```ts
import { KMSClient, GenerateDataKeyCommand, DecryptCommand } from '@aws-sdk/client-kms';

const kms = new KMSClient({ region: 'us-east-1' });

export async function generateDek(): Promise<{ plaintext: Buffer; wrapped: Buffer }> {
  const out = await kms.send(new GenerateDataKeyCommand({
    KeyId: process.env.KMS_KEY_ID!,
    KeySpec: 'AES_256',
  }));
  return {
    plaintext: Buffer.from(out.Plaintext!),
    wrapped: Buffer.from(out.CiphertextBlob!),
  };
}

export async function unwrapDek(wrapped: Buffer): Promise<Buffer> {
  const out = await kms.send(new DecryptCommand({
    KeyId: process.env.KMS_KEY_ID!,
    CiphertextBlob: wrapped,
  }));
  return Buffer.from(out.Plaintext!);
}
```

In practice, you cache the unwrapped DEK in memory for a short window (60 seconds is a reasonable default) so a burst of requests against the same tenant doesn't melt KMS quota. The cache must be in-process, never on disk, and must clear on shutdown.

```ts
import { LRUCache } from 'lru-cache';

const dekCache = new LRUCache<string, Buffer>({ max: 1000, ttl: 60_000 });

export async function getDek(wrapped: Buffer): Promise<Buffer> {
  const key = wrapped.toString('base64');
  let dek = dekCache.get(key);
  if (!dek) {
    dek = await unwrapDek(wrapped);
    dekCache.set(key, dek);
  }
  return dek;
}
```

### Rotation — re-encrypt in place

The two rotations are different problems:

* **KEK rotation** — handled inside KMS. AWS KMS supports automatic annual rotation of the underlying key material; the key ID doesn't change, and old ciphertext still decrypts (KMS keeps the previous material for un-rotation). Turn it on, walk away.
* **DEK rotation** — the slow one. The DEK encrypts the actual rows; rotating it means re-encrypting every affected row. The pattern:

```ts
// scripts/rotate-dek.ts
import { db } from '../src/db';
import { generateDek, unwrapDek, aeadEncrypt, aeadDecrypt } from '../src/crypto';

const { plaintext: newDek, wrapped: newWrapped } = await generateDek();

for await (const batch of db.User.findManyStream({ batchSize: 1000 })) {
  await db.$transaction(async (tx) => {
    for (const row of batch) {
      const oldDek = await unwrapDek(row.email_dek_wrapped);
      const email = await aeadDecrypt(oldDek, row.email_ciphertext, Buffer.from(`user.email:${row.id}`));
      const newCiphertext = await aeadEncrypt(newDek, email, Buffer.from(`user.email:${row.id}`));
      await tx.User.update({
        where: { id: row.id },
        data: { email_ciphertext: newCiphertext, email_dek_wrapped: newWrapped },
      });
    }
  });
}
```

This is a long-running job. Run it as a background worker with throttling, journal progress to a `rotation_state` table so it resumes after a crash, and keep the old wrapped DEK accessible for a grace window so a half-rotated table still reads correctly. The dual-DEK window (old and new both valid for decrypt, new only for encrypt) is the standard pattern.

---

## Browser and mobile

The threat model in the browser and on the device is different from the server. The OS already provides a per-app sandbox; the threat is "another app on the same device" or "the user's device is stolen and unlocked".

* **Browser (sqlite-wasm + OPFS)** — OPFS is sandboxed per origin. Other origins can't read your DB. The threats left are physical access to an unlocked machine and malicious extensions running in the same origin. Field-level encryption with WebCrypto + a key derived from the user's session token is a reasonable middle ground; SQLCipher in the browser is heavy (the wasm bundle adds ~3 MB) and rarely justified.
* **Tauri (desktop)** — `tauri-plugin-stronghold` and `tauri-plugin-keyring` give you OS-keychain-backed secrets. Use them to hold a key that opens a SQLCipher-encrypted SQLite. The OS keychain prompts on first use; subsequent access is gated by the OS lock.
* **Capacitor / Expo (mobile)** — `@capacitor/preferences` (encrypted via iOS Keychain / Android Keystore), `expo-secure-store`, or `react-native-keychain`. Same pattern — a key in secure storage opens the encrypted DB.
* **iOS data-at-rest** — iOS encrypts the file system with the device passcode-derived class key. When the device is unlocked, the app's "Data Protection: Complete Until First User Authentication" files are accessible. SQLCipher on top buys you "the file is encrypted even when the device is unlocked", which matters for keychain-style threats.
* **Android data-at-rest** — Android's File-Based Encryption uses a key derived from user credentials. The same defence-in-depth argument for SQLCipher applies.

The forge-side recipe for Capacitor + SQLCipher:

```ts
import { CapacitorSQLite } from '@capacitor-community/sqlite';
import { SecureStoragePlugin } from 'capacitor-secure-storage-plugin';

const { value: key } = await SecureStoragePlugin.get({ key: 'db_key' });
const sqlite = new CapacitorSQLite();
await sqlite.openDatabase({ database: 'app', encrypted: true, mode: 'secret', /* … */ });

const db = await createDb({
  driver: 'capacitor-sqlite',
  schema: { /* … */ },
  // forge sees a standard SQLite handle; encryption is below the driver
});
```

For an Expo + react-native-quick-sqlite setup, the same shape applies; the key comes from `expo-secure-store`. See **[MOBILE.md](./MOBILE.md)** for the full mobile wiring and **[BROWSER.md](./BROWSER.md)** for the in-browser sqlite-wasm version.

---

## SQLCipher specifics

SQLCipher is the default for full-database SQLite encryption. The page-level mechanics:

* Every 4 KB page is encrypted with AES-256-CBC and authenticated with HMAC-SHA-512 (or HMAC-SHA-1 on the v3-compat builds — avoid).
* The first page contains the salt for PBKDF2 key derivation. The user-supplied passphrase is run through PBKDF2 (256,000 iterations by default in v4) to produce the actual page key.
* `PRAGMA key = '…';` must be the first statement after open. Any other statement first triggers `SQLITE_NOTADB`.
* `PRAGMA rekey = '…';` re-encrypts every page with the new key. The operation is single-threaded and rewrites the whole file; plan for downtime proportional to DB size.

The forge driver hookup:

```ts
import Database from 'better-sqlite3-multiple-ciphers'; // SQLCipher-compatible build
import { createDb } from 'forge-orm';

const raw = new Database('./encrypted.db');
raw.pragma(`key = '${process.env.SQLCIPHER_KEY!}'`);
raw.pragma('cipher_compatibility = 4');
raw.pragma('kdf_iter = 256000'); // matches SQLCipher v4 default

const db = await createDb({
  driver: { kind: 'better-sqlite3', client: raw },
  schema: { /* … */ },
});
```

Key derivation: don't put a raw passphrase in `PRAGMA key`. Derive a 32-byte key from the user's passphrase with Argon2id (`argon2` npm package), or fetch a pre-derived key from the OS keychain. The PBKDF2 step inside SQLCipher is fine, but the input to that step should already be high-entropy.

The dedicated **[SQLCIPHER.md](./SQLCIPHER.md)** page covers the build flags, the wasm story, the rekey procedure, and the litestream-on-SQLCipher caveat (litestream sees encrypted pages — the streamed copy is automatically at-rest-encrypted, but the bucket-level SSE is still a good idea for defense in depth).

---

## Performance cost — measured overhead

Numbers are workload-dependent; these are typical ranges from production deployments running forge-orm.

| Layer | Overhead | Where it shows up |
|---|---|---|
| Filesystem-level (LUKS, RDS storage) | 2–5% CPU on writes, < 1% on reads | Disk-bound writes |
| InnoDB tablespace encryption (MySQL) | 3–7% on write-heavy workloads | INSERT throughput, redo-log flush |
| MSSQL TDE | 3–8% on mixed workload | Buffer pool churn, log writer |
| SQLCipher (4 KB page, AES-256-CBC + HMAC-SHA-512) | 10–25% on read-heavy, 15–40% on write-heavy | Every page read/write does AES + HMAC |
| Mongo CSFLE (deterministic) | 5–15% | Driver-side encrypt/decrypt + extra round trip for keys on cold cache |
| App-layer AES-256-GCM (Node) | ~1 µs per 100-byte field | Negligible at app level; adds bytes to the row (28-byte envelope overhead) |
| KMS unwrap (cold) | 5–20 ms per call | First request per DEK; cache to amortise |
| KMS unwrap (warm, cached) | ~10 µs | In-memory LRU |

The pattern: cloud-managed at-rest is free, in-transit TLS is free (already in the connection), app-layer AEAD is free, and the costs that show up in profiles are SQLCipher on heavy-read mobile workloads, KMS quota on burst traffic, and the row-bloat from blind-index columns on large tables.

The SQLCipher cost is real on mobile. On a Pixel 6 reading a 500 MB encrypted SQLite, full-table scans run at ~120 MB/s vs 200 MB/s unencrypted. Most apps don't notice; analytics-heavy mobile apps do, and the workaround is usually "decrypt one table at a time, batched, off the UI thread".

The KMS cost shows up at quota boundaries. AWS KMS defaults to 5,500 cryptographic operations per second per region. A single-tenant DB doing one unwrap per request hits this at ~5k RPS. The DEK cache above is the fix; the cache hit rate at 60-second TTL on a per-tenant DEK is usually 99%+, putting the effective KMS load at the rotation cadence.

---

## Backup encryption

Backups are where at-rest encryption matters most — they live on storage you don't always control, often for years, often replicated to other regions. The four patterns:

* **Encrypted source → encrypted backup.** A `pg_basebackup` of a LUKS-encrypted volume produces an encrypted file artefact (the WAL segments are encrypted in the same way). The backup is opaque without the LUKS key. Operationally the simplest.
* **Plaintext source → encrypted-during-export backup.** `pg_dump | gpg --encrypt --recipient backup-key | aws s3 cp -` is the canonical pattern. The plaintext dump never touches disk; the GPG envelope is the only artefact stored.
* **Cloud-managed encrypted backups.** RDS snapshot encryption, Cloud SQL automated backups, Atlas backups — all keyed by the cloud KMS, all transparent. The backup file you can never see in plaintext.
* **Bucket-level SSE.** S3 `aws:kms` server-side encryption on the bucket. Defense in depth on top of whatever envelope the backup tool used. Always on for production buckets.

See **[BACKUP-RESTORE.md § Encrypted backups](./BACKUP-RESTORE.md#encrypted-backups)** for the full procedure including the restore-side decryption path. The gist: the encryption key for the backup must be in a separate KMS key from the production DB's key, with a separate access policy. A breach that exfiltrates the production key shouldn't also decrypt every backup.

---

## Compliance — what each standard actually requires

The cheat sheet — read the standard itself for the binding text.

| Standard | At-rest | In-transit | Field-level | Notes |
|---|---|---|---|---|
| HIPAA | "Addressable" — document why if not | Required for ePHI over open networks | Strongly implied for PHI columns | "Addressable" doesn't mean optional; it means "implement it or document the alternative". Auditors expect at-rest. |
| PCI-DSS 4.0 | Required for cardholder data | TLS 1.2+ with strong ciphers | Required for PAN (3.4) | PAN tokenization at the gateway is the recommended path. If you store PANs, you're in PCI scope; if you tokenize, you're not. |
| GDPR | "State of the art" — at-rest is baseline | Required | Pseudonymisation (Article 32) is field-level encryption | Pseudonymisation is recommended, not required, but reduces breach-notification obligations. |
| SOX | Encryption of financial data at rest | Required for financial data over networks | Recommended for SSN, salary, etc. | SOX is more about controls and audit trail (see [AUDIT-LOG.md](./AUDIT-LOG.md)) than crypto specifics. |
| FedRAMP | FIPS 140-2/3 validated modules | FIPS 140-2/3 validated TLS | Required for CUI | FIPS validation eliminates most JavaScript-side crypto — use OS-provided libraries. |
| CCPA / CPRA | Encryption is a safe harbour for breach notification | Required | Reduces notification obligation | Same shape as GDPR — encryption isn't required but its absence triggers more onerous obligations. |
| ISO 27001 | Required by Annex A.10 | Required by Annex A.13 | Recommended | A control framework, not a crypto spec — pairs with whatever you implement. |

The unsexy reality: every regulated industry expects at-rest as a baseline, every standard expects TLS in-transit with proper validation, and field-level is a "show your work" exercise where you document the threat model and the decision. None of the standards mandate a specific algorithm; they mandate "industry-standard" or "FIPS-validated", which AES-256-GCM cleanly satisfies.

The compliance interaction with key management is where audits actually go: who can access the key, how is access logged, how is the key rotated, how is a former employee's access revoked. The cryptographic primitives all pass; the operational keymanagement is what auditors find when they look.

---

## Worked examples

### (a) AES-GCM SSN column on Postgres

Schema:

```ts
import { f, model } from 'forge-orm';

export const Patient = model('patients', {
  id: f.id(),
  mrn: f.string().unique(),
  name: f.string(),
  ssn_ciphertext: f.bytes().nullable(),
  ssn_blind_index: f.string().nullable().index(),
  ssn_dek_wrapped: f.bytes().nullable(),
  created_at: f.timestamp().defaultNow(),
});
```

Crypto layer:

```ts
// src/crypto/patient-ssn.ts
import { KMSClient, GenerateDataKeyCommand, DecryptCommand } from '@aws-sdk/client-kms';
import { randomBytes, createCipheriv, createDecipheriv, createHmac } from 'node:crypto';

const kms = new KMSClient({ region: process.env.AWS_REGION! });
const KMS_KEY_ID = process.env.KMS_PATIENT_KEY_ID!;
const BLIND_INDEX_KEY = Buffer.from(process.env.BLIND_INDEX_KEY!, 'base64');

export async function encryptSsn(rowId: string, ssn: string) {
  const { Plaintext, CiphertextBlob } = await kms.send(new GenerateDataKeyCommand({
    KeyId: KMS_KEY_ID,
    KeySpec: 'AES_256',
  }));
  const dek = Buffer.from(Plaintext!);
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', dek, nonce);
  cipher.setAAD(Buffer.from(`patient.ssn:${rowId}`));
  const ct = Buffer.concat([cipher.update(ssn, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    ssn_ciphertext: Buffer.concat([nonce, tag, ct]),
    ssn_dek_wrapped: Buffer.from(CiphertextBlob!),
    ssn_blind_index: blindIndex(ssn),
  };
}

export async function decryptSsn(rowId: string, ciphertext: Buffer, wrapped: Buffer) {
  const { Plaintext } = await kms.send(new DecryptCommand({
    KeyId: KMS_KEY_ID,
    CiphertextBlob: wrapped,
  }));
  const dek = Buffer.from(Plaintext!);
  const nonce = ciphertext.subarray(0, 12);
  const tag = ciphertext.subarray(12, 28);
  const ct = ciphertext.subarray(28);
  const decipher = createDecipheriv('aes-256-gcm', dek, nonce);
  decipher.setAAD(Buffer.from(`patient.ssn:${rowId}`));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}

function blindIndex(ssn: string): string {
  const normalised = ssn.replace(/\D/g, ''); // strip dashes/spaces
  return createHmac('sha256', BLIND_INDEX_KEY).update(normalised).digest().subarray(0, 8).toString('hex');
}
```

Repo:

```ts
// src/repos/patient.repo.ts
import { db } from '../db';
import { encryptSsn, decryptSsn, blindIndex } from '../crypto/patient-ssn';

export const patientRepo = {
  async create(input: { mrn: string; name: string; ssn: string }) {
    return db.$transaction(async (tx) => {
      // create first to get the id
      const row = await tx.Patient.create({ mrn: input.mrn, name: input.name });
      const enc = await encryptSsn(row.id, input.ssn);
      await tx.Patient.update({ where: { id: row.id }, data: enc });
      return row.id;
    });
  },

  async findBySsn(ssn: string) {
    const bi = blindIndex(ssn);
    const candidates = await db.Patient.findMany({ where: { ssn_blind_index: bi } });
    for (const c of candidates) {
      const actual = await decryptSsn(c.id, c.ssn_ciphertext!, c.ssn_dek_wrapped!);
      if (actual === ssn.replace(/\D/g, '')) return c;
    }
    return null;
  },
};
```

The structure: ciphertext + wrapped DEK live together on the row, blind index lives in a separate indexed column, decrypt requires a KMS round trip (cache the DEK if you do a lot of decrypts in the same request). `findBySsn` returns "candidates" because the blind index is truncated; the decrypt-and-compare loop disambiguates.

### (b) Mongo CSFLE end-to-end

Schema map — declares which fields are encrypted, with which key, in which mode:

```ts
// src/mongo-encryption.ts
import { MongoClient, Binary } from 'mongodb';

const keyVaultNamespace = 'encryption.__keyVault';
const kmsProviders = {
  aws: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
  },
};
const masterKey = {
  region: process.env.AWS_REGION!,
  key: process.env.KMS_KEY_ARN!,
};

// One-time: create a CMK and a DEK in the key vault.
// (Run from a setup script; the DEK UUID goes in env.)
// const { ClientEncryption } = await import('mongodb');
// const enc = new ClientEncryption(client, { keyVaultNamespace, kmsProviders });
// const keyId = await enc.createDataKey('aws', { masterKey, keyAltNames: ['patient.ssn'] });

export function makeEncryptedClient() {
  const dekUuid = process.env.MONGO_DEK_UUID!; // base64 UUID
  return new MongoClient(process.env.MONGO_URL!, {
    autoEncryption: {
      keyVaultNamespace,
      kmsProviders,
      schemaMap: {
        'app.patients': {
          bsonType: 'object',
          properties: {
            ssn: {
              encrypt: {
                bsonType: 'string',
                algorithm: 'AEAD_AES_256_CBC_HMAC_SHA_512-Deterministic',
                keyId: [new Binary(Buffer.from(dekUuid, 'base64'), Binary.SUBTYPE_UUID)],
              },
            },
            notes: {
              encrypt: {
                bsonType: 'string',
                algorithm: 'AEAD_AES_256_CBC_HMAC_SHA_512-Random',
                keyId: [new Binary(Buffer.from(dekUuid, 'base64'), Binary.SUBTYPE_UUID)],
              },
            },
          },
        },
      },
    },
  });
}
```

forge wiring:

```ts
import { createDb, f, model } from 'forge-orm';
import { makeEncryptedClient } from './mongo-encryption';

const Patient = model('patients', {
  id: f.id(),
  mrn: f.string().unique(),
  name: f.string(),
  ssn: f.string(),    // CSFLE driver encrypts before write
  notes: f.string(),  // ditto, randomized
});

const client = makeEncryptedClient();
await client.connect();

export const db = await createDb({
  driver: { kind: 'mongo', client },
  schema: { patient: Patient },
});

// Application code sees plaintext. Mongo storage sees ciphertext.
await db.Patient.create({ mrn: 'M-001', name: 'Alice', ssn: '123-45-6789', notes: 'Sensitive notes.' });
const found = await db.Patient.findFirst({ where: { ssn: '123-45-6789' } }); // exact-match works on deterministic
```

The deterministic `ssn` field is queryable; the randomized `notes` field isn't. Both are unreadable to anyone with the Mongo cluster but no KMS access.

### (c) SQLCipher for a Capacitor mobile app

```ts
// src/db.mobile.ts
import { CapacitorSQLite, SQLiteConnection } from '@capacitor-community/sqlite';
import { SecureStoragePlugin } from 'capacitor-secure-storage-plugin';
import { createDb, f, model } from 'forge-orm';

const sqlite = new SQLiteConnection(CapacitorSQLite);

async function getOrCreateDbKey(): Promise<string> {
  try {
    const { value } = await SecureStoragePlugin.get({ key: 'db_key' });
    return value;
  } catch {
    // First launch — derive from a server-issued bootstrap secret or generate locally.
    const fresh = crypto.getRandomValues(new Uint8Array(32));
    const b64 = btoa(String.fromCharCode(...fresh));
    await SecureStoragePlugin.set({ key: 'db_key', value: b64 });
    return b64;
  }
}

export async function openDb() {
  const key = await getOrCreateDbKey();
  await sqlite.setEncryptionSecret(key);
  const conn = await sqlite.createConnection('app', true, 'secret', 1, false);
  await conn.open();

  return createDb({
    driver: { kind: 'capacitor-sqlite', conn },
    schema: { /* … */ },
  });
}
```

The key flow: first launch generates a 32-byte random key, stores it in the OS keychain (iOS Keychain / Android Keystore), and uses it as the SQLCipher passphrase. Subsequent launches read the key from the keychain. Logout-on-device wipes the keychain entry; the encrypted DB file becomes unrecoverable.

### (d) DEK rotation against a live Postgres deployment

```ts
// scripts/rotate-patient-ssn-dek.ts
import { db } from '../src/db';
import { KMSClient, GenerateDataKeyCommand, DecryptCommand } from '@aws-sdk/client-kms';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const kms = new KMSClient({ region: process.env.AWS_REGION! });
const NEW_KMS_KEY_ID = process.env.NEW_KMS_KEY_ID!;

async function rotate() {
  const { Plaintext, CiphertextBlob } = await kms.send(new GenerateDataKeyCommand({
    KeyId: NEW_KMS_KEY_ID,
    KeySpec: 'AES_256',
  }));
  const newDek = Buffer.from(Plaintext!);
  const newWrapped = Buffer.from(CiphertextBlob!);

  let cursor: string | null = null;
  let done = 0;
  while (true) {
    const page = await db.Patient.findMany({
      where: { ssn_ciphertext: { not: null }, ...(cursor && { id: { gt: cursor } }) },
      orderBy: { id: 'asc' },
      take: 500,
    });
    if (page.length === 0) break;

    await db.$transaction(async (tx) => {
      for (const row of page) {
        // Decrypt with old DEK (already wrapped on the row)
        const { Plaintext: oldDekBytes } = await kms.send(new DecryptCommand({
          CiphertextBlob: row.ssn_dek_wrapped!,
        }));
        const oldDek = Buffer.from(oldDekBytes!);

        const nonce = row.ssn_ciphertext!.subarray(0, 12);
        const tag = row.ssn_ciphertext!.subarray(12, 28);
        const ct = row.ssn_ciphertext!.subarray(28);
        const dec = createDecipheriv('aes-256-gcm', oldDek, nonce);
        dec.setAAD(Buffer.from(`patient.ssn:${row.id}`));
        dec.setAuthTag(tag);
        const plain = Buffer.concat([dec.update(ct), dec.final()]);

        // Re-encrypt with new DEK
        const newNonce = randomBytes(12);
        const enc = createCipheriv('aes-256-gcm', newDek, newNonce);
        enc.setAAD(Buffer.from(`patient.ssn:${row.id}`));
        const newCt = Buffer.concat([enc.update(plain), enc.final()]);
        const newTag = enc.getAuthTag();

        await tx.Patient.update({
          where: { id: row.id },
          data: {
            ssn_ciphertext: Buffer.concat([newNonce, newTag, newCt]),
            ssn_dek_wrapped: newWrapped,
          },
        });
      }
    });

    cursor = page[page.length - 1].id;
    done += page.length;
    console.log(`Rotated ${done} rows; cursor=${cursor}`);
  }
}

rotate().catch((e) => { console.error(e); process.exit(1); });
```

Run this as a background job during quiet hours. Throttle if you're paying for KMS by the request — every row is one `Decrypt` call. The dual-window approach (keep both old and new DEKs valid for `decrypt`, only new for `encrypt`, until rotation completes) lets the app keep serving while rotation runs; the rotation script is the only writer that flips the wrapped-DEK column.

---

## Cross-references

* **[SECURITY.md](./SECURITY.md)** — authentication, RBAC, secret management, SQL injection defences. Encryption assumes the rest of this is right; without it the field-level layer is locked but the front door is open.
* **[SQLCIPHER.md](./SQLCIPHER.md)** — build flags, wasm packaging, key derivation, `rekey` procedure. The deep-dive on the SQLite encryption layer this page summarises.
* **[BACKUP-RESTORE.md](./BACKUP-RESTORE.md)** — encrypted backups, KMS-keyed snapshots, off-site replication. The backup-side of "encrypted at rest" — a backup without encryption defeats the live DB's encryption.
* **[AUDIT-LOG.md](./AUDIT-LOG.md)** — who decrypted what when. KMS access logs sit alongside application audit logs; both are required for HIPAA / SOX / PCI evidence.
* **[BACKEND.md](./BACKEND.md)** — TLS in the connection URL, mTLS client certificates, KMS client lifecycle. The wiring layer where in-transit encryption is configured.
* **[MOBILE.md](./MOBILE.md)** — SecureStore / Keychain / Keystore, SQLCipher on Capacitor and Expo, key bootstrap on first launch.
* **[BROWSER.md](./BROWSER.md)** — sqlite-wasm + OPFS, WebCrypto field-level encryption, the trade-off against bundling SQLCipher in the browser.
* **[DRIVERS.md](./DRIVERS.md)** — adapter-level connection options, including TLS and SSL config per dialect.
* **[MONGO.md](./MONGO.md)** — Mongo adapter specifics; CSFLE and Queryable Encryption wiring.
* **[MSSQL.md](./MSSQL.md)** — MSSQL adapter specifics; TDE and Always Encrypted configuration.
