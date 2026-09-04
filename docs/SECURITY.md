# Security

The security surface forge-orm owns: parameterized queries, raw-SQL safety rules, row-level security composition, field-level encryption, audit logging, and the compliance patterns (GDPR, HIPAA, PCI) that touch the data layer. This page documents what forge guarantees by construction, what it leaves to you, and the patterns that catch the common mistakes.

It is the companion read to [RAW-SQL.md](./RAW-SQL.md) (which covers the template-tag rules in detail), [MULTI-TENANT.md](./MULTI-TENANT.md) (where the row-level security pattern lives in its long form), and [AUDIT-LOG.md](./AUDIT-LOG.md) (the compliance log built on top of the event channel). Where a topic has its own deep-dive, this page summarises the security-relevant slice and links across; where it doesn't, the full pattern lives here.

## Contents

- [The security surface forge owns](#the-security-surface-forge-owns)
- [Raw SQL safety](#raw-sql-safety)
- [SQL injection auditing — the CI rule](#sql-injection-auditing--the-ci-rule)
- [Row-level security (Postgres)](#row-level-security-postgres)
- [Column masking — view-based + event-hook redaction](#column-masking--view-based--event-hook-redaction)
- [Field-level encryption](#field-level-encryption)
- [Encrypted at rest](#encrypted-at-rest)
- [Encrypted in transit](#encrypted-in-transit)
- [Database user permissions](#database-user-permissions)
- [Audit logging](#audit-logging)
- [PII handling](#pii-handling)
- [GDPR](#gdpr)
- [PCI-DSS](#pci-dss)
- [HIPAA](#hipaa)
- [SSRF and file inclusion via stored data](#ssrf-and-file-inclusion-via-stored-data)
- [Common vulnerabilities](#common-vulnerabilities)
- [Browser context — CSP, Trusted Types, isolation](#browser-context--csp-trusted-types-isolation)
- [Worked examples](#worked-examples)
- [Cross-references](#cross-references)

---

## The security surface forge owns

Three things forge guarantees by construction, and three things it deliberately doesn't.

**What forge guarantees.**

1. **Every typed query is fully parameterised.** `findMany`, `findFirst`, `create`, `update`, `delete`, `upsert`, `aggregate`, `groupBy` — the whole typed surface — emits SQL where every user-controllable value travels in the driver's params array, never spliced into the SQL string. The compiler in `src/raw-sql.ts` is the only path that produces a parameter; the typed planners feed it the same way `$queryRaw` does. There is no public API on a typed call that string-concatenates a value into SQL.
2. **The `forgeSql` template tag follows the same rule.** Anything inside `${…}` that is a value gets bound; anything that is a pre-built `SqlFragment` gets inlined as SQL. The renumbering across nested fragments (covered in [RAW-SQL.md](./RAW-SQL.md#composing-sqlfragments)) means there is no way for a parameter from one fragment to escape into another's SQL surface.
3. **The Mongo channel is BSON, not strings.** `db.<model>.find`, `aggregate`, and `$runCommandRaw` all build BSON documents and ship them through the driver. There is no SQL injection equivalent on Mongo because there is no SQL; what there *is* is operator injection (a user-supplied `{ $ne: null }`), and the typed surface refuses to accept operator objects from untyped input. See [MONGO.md](./MONGO.md#operator-injection) when this file lands.

**What forge does not guarantee.**

1. **Application-layer authorisation.** forge does not know who is asking for the row. The query that returns it doesn't carry an actor. If your handler returns rows without checking the caller has permission to see them, the database obediently hands them over.
2. **Tenant isolation when you bypass the typed surface.** A raw SQL query that forgets to filter by `tenant_id` will cheerfully read across tenants. The [Multi-tenant chapter](./MULTI-TENANT.md) covers the wrapper patterns and the Postgres RLS belt-and-braces; the security note here is that *raw SQL is opt-out of every safety net the typed surface builds for you*.
3. **Transport and at-rest encryption.** That's the driver's and the database operator's job — TLS config on the connection string, FDE on the disk, KMS for the keys. forge sits on top.

The rest of this document is the operational shape of those three guarantees and the patterns that backfill the three non-guarantees.

---

## Raw SQL safety

The single mental model: **values become `$1` / `?`, identifiers become inline SQL, and there is no third option**. Anything you want to splice into the SQL string itself must travel through `forgeSql.raw(…)` or a pre-built `SqlFragment`, and `forgeSql.raw` is reserved for compile-time constants.

```ts
import { forgeSql } from 'forge-orm';

// SAFE — `email` is a value; the compiler binds it as a parameter.
await db.$queryRaw`SELECT * FROM users WHERE email = ${email}`;
// Postgres: SELECT * FROM users WHERE email = $1   params: [email]

// SAFE — `tableName` comes from a whitelist of pre-built fragments.
const TABLES = {
  users:   forgeSql.raw('"users"'),
  orders:  forgeSql.raw('"orders"'),
} as const;
const table = TABLES[req.query.table] ?? TABLES.users;
await db.$queryRaw`SELECT * FROM ${table} WHERE org_id = ${orgId}`;

// UNSAFE — string concatenation. Even if `column` looks like an identifier,
// the user controls it. There is no parameterised "identifier" placeholder
// in any SQL dialect; you must inline-or-whitelist.
const column = req.query.sort;
await db.$queryRaw(forgeSql.raw(`SELECT * FROM users ORDER BY ${column}`));
// → ORDER BY name; DROP TABLE users; --  ← compiles literally
```

The third example is the only way to write SQL injection through forge's surface in 2.5.x. It requires actively reaching for `forgeSql.raw` and feeding it a string built from user input. The compiler emits no warning, because by the time the call reaches it the SQL is already a single literal — there is nothing to parameterise.

The defensive code review rule: **`forgeSql.raw` may only be called with a string literal that contains no template expressions**. If a `forgeSql.raw(…)` call has a backtick template, a `+` concatenation, or a variable inside its argument, it is a bug; treat it as a finding until the variable is proven to come from a static whitelist.

Identifier vs value placement and the full reasoning are in [RAW-SQL.md → Identifier vs value interpolation](./RAW-SQL.md#identifier-vs-value-interpolation). The four worked patterns there (dynamic ORDER BY, dynamic WHERE, IN-list, search) are all expressed in the safe shape; copy from there rather than from memory.

### Second-order injection — data stored safely then read unsafely

Parameterised writes don't protect you from a later raw-SQL read that splices the stored value into SQL.

```ts
// Write — safe. The raw HTML in `bio` is bound as a parameter.
await db.user.update({ where: { id }, data: { bio: untrustedHtml } });

// Read — unsafe, even though the write was safe.
const search = req.query.q;             // user input
const row = await db.user.findFirst({ where: { id } });
await db.$queryRaw(forgeSql.raw(`SELECT * FROM posts WHERE bio LIKE '%${row.bio}%'`));
//                                                                    ^^^^^^^^^^
//   row.bio came from the database, but its content originated as user input.
//   Splicing it into raw SQL re-introduces injection by a longer path.
```

The rule generalises: **any value that ever passed through user input must travel as a bound parameter every time it touches SQL, not just on the first read**. There is no "now it's clean because it lived in the database for a while". The compiler's safety covers the first write; the safety holds across reads only if you keep using bound parameters.

---

## SQL injection auditing — the CI rule

forge ships no `$queryRawUnsafe` method. The unsafe shape — if it exists in a codebase — looks like one of these:

1. ``forgeSql.raw(`…${variable}…`)`` — template-string argument to `raw`.
2. `forgeSql.raw('…' + variable + '…')` — string concatenation into `raw`.
3. `await db.$queryRaw(forgeSql.raw(buildQuery(req.body)))` — `raw` fed by a helper that itself concatenates.
4. Any custom helper that wraps `forgeSql.raw` and accepts non-literal arguments.

The CI rule is one grep, run as a pre-merge check:

```sh
# Fail the build if forgeSql.raw appears with a template-string or concatenated argument.
rg -n --pcre2 \
  'forgeSql\.raw\(\s*(`[^`]*\$\{|[^)]*\+\s*)' \
  src/ \
  && { echo "Unsafe forgeSql.raw usage found"; exit 1; } \
  || echo "ok"
```

The first alternation catches template-string arguments (``forgeSql.raw(`...${x}...`)``); the second catches concatenation (`forgeSql.raw('SELECT ' + col + ...)`). Both shapes are the only way to introduce SQL injection through forge.

The grep produces false positives if you legitimately build static SQL with a constant template — e.g. ``forgeSql.raw(`SET search_path = ${SCHEMA_NAME}`)`` where `SCHEMA_NAME` is a module-level `const`. The pragmatic move is to keep that constant pre-computed: ``const SET_PATH = forgeSql.raw(`SET search_path = "${SCHEMA_NAME}"`)`` at module init, then reference `SET_PATH` from the call site. The grep then passes and the runtime value is identical.

For a GitHub Actions workflow:

```yaml
# .github/workflows/security.yml
name: security
on: [pull_request]
jobs:
  forge-raw-audit:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Audit forgeSql.raw usage
        run: |
          if rg -n --pcre2 'forgeSql\.raw\(\s*(`[^`]*\$\{|[^)]*\+\s*)' src/; then
            echo "::error::Unsafe forgeSql.raw call found. See docs/SECURITY.md."
            exit 1
          fi
```

The second audit worth running is for direct driver bypass — code that reaches around forge and into `pg.Pool.query`, `mysql2.execute`, etc., using string concatenation. That isn't a forge issue per se, but a code review of a forge-managed database should still catch it:

```sh
rg -n --pcre2 \
  '\.(query|execute)\(\s*`[^`]*\$\{|\.(query|execute)\(\s*[^)]*\+\s*' \
  src/ \
  && exit 1 || echo "ok"
```

Combined with TypeScript's no-`any` on the driver type, these two greps cover the realistic injection surface. The Mongo BSON channel is structurally immune to the same class of bug, so it needs no equivalent.

---

## Row-level security (Postgres)

Postgres' Row Level Security (RLS) is the belt to the application wrapper's braces. The application filters by `tenant_id` because it's fast and it's where the typed surface lives; RLS enforces the same filter at the SQL layer so a forgotten `WHERE` clause — including one in raw SQL — returns zero rows instead of leaking. forge composes with RLS without needing a forge-aware policy.

### Enabling RLS on a forge-managed table

`forge push` does not emit RLS policies. They're orthogonal to the schema and they live in a one-off SQL file that you apply once per environment:

```sql
-- migrations/0001_rls.sql — apply once, idempotent.
ALTER TABLE orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE orders FORCE ROW LEVEL SECURITY;     -- applies to the table owner too

DROP POLICY IF EXISTS orders_tenant_isolation ON orders;
CREATE POLICY orders_tenant_isolation ON orders
  USING       (tenant_id = current_setting('forge.actor_tenant', true)::text)
  WITH CHECK  (tenant_id = current_setting('forge.actor_tenant', true)::text);
```

`USING` filters reads; `WITH CHECK` validates writes. Both are gated on a per-transaction setting (`forge.actor_tenant`) that the application sets at the top of every request-scoped transaction. The `, true` argument to `current_setting` returns NULL if the setting is unset instead of throwing — useful so an unprivileged role still sees the policy reject rather than the connection error out.

### Setting `SET LOCAL` per transaction

`SET LOCAL` lives only for the surrounding transaction, which is exactly what you want: the setting auto-clears at commit/rollback, so a checked-out connection returned to PgBouncer never carries the previous request's tenant into the next.

```ts
// src/middleware/rls.ts
import type { ForgeDb } from 'forge-orm';

export async function withTenantTx<T>(
  db: ForgeDb,
  actor: { tenant_id: string; user_id: string },
  fn: (tx: ForgeDb) => Promise<T>,
): Promise<T> {
  return db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('forge.actor_tenant', ${actor.tenant_id}, true)`;
    await tx.$executeRaw`SELECT set_config('forge.actor_user',   ${actor.user_id},   true)`;
    return fn(tx);
  });
}
```

`set_config('name', value, true)` is the function form of `SET LOCAL name = value` and it accepts a bound parameter. The naked `SET LOCAL forge.actor_tenant = ${value}` form doesn't accept parameters — the parser treats the setting value as a literal — so reach for `set_config` whenever the value is user-controllable. (It is.)

The route wires the wrapper like a normal request-scoped tx:

```ts
app.post('/orders', async (req, res) => {
  const order = await withTenantTx(db, req.actor, (tx) =>
    tx.order.create({ data: { total: req.body.total } }),
  );
  // RLS enforced the tenant_id at the WITH CHECK clause.
  res.json(order);
});
```

If the application code forgot to put `tenant_id` in `data`, the `WITH CHECK` clause rejects the INSERT with `new row violates row-level security policy`. The application-layer wrapper (covered in [MULTI-TENANT.md → `scopedDb`](./MULTI-TENANT.md#scopeddb--the-wrapper-pattern)) still runs in the same transaction, so the database's rejection surfaces as a typed error.

### RLS and PgBouncer transaction mode

`SET LOCAL` is transaction-scoped, so it composes correctly with PgBouncer in transaction-pooling mode. Session-pooling mode is fine too. The combination to avoid is **session-pooling mode plus session-level `SET`** — the setting leaks across requests sharing the session. Use `SET LOCAL` inside a transaction every time and the question goes away.

The further read is [MULTI-TENANT.md → Row-level security (Postgres)](./MULTI-TENANT.md#row-level-security-postgres), which covers the four-policy pattern (separate SELECT / INSERT / UPDATE / DELETE) for the systems where one symmetric policy isn't expressive enough.

---

## Column masking — view-based + event-hook redaction

There are two reliable shapes for hiding sensitive columns from a query: the database view a restricted role reads, and the application-layer hook that redacts on the way out. They're complementary, and most production systems run both.

### Database view + restricted role

The cleanest shape for cross-team isolation: the application role reads from a view, not from the table; the view omits or masks the sensitive columns. forge doesn't care that `users` is actually a view — it introspects the column set from `information_schema.columns`, which exposes views identically to tables.

```sql
CREATE VIEW users_masked AS
SELECT
  id,
  email,
  CASE
    WHEN current_setting('forge.actor_role', true) = 'support'
    THEN substring(ssn, 1, 3) || '-**-****'
    ELSE NULL
  END AS ssn,
  created_at
FROM users;

GRANT SELECT ON users_masked TO app_role;
REVOKE ALL  ON users          FROM app_role;
```

You then declare the forge model against the view name. The view is read-only by default; writes need to land on `users` directly, which the application role can't do without a separate privilege bump. A typical setup grants the writer role to a narrow service ("user-admin-service") while every other service reads the view.

### Application-layer redaction via `$on('query')`

For columns the application reads but should not log, the event channel covered in [EVENTS.md](./EVENTS.md) is the right hook. The handler fires after the call resolves with the result attached, so you can redact-on-return without blocking the query.

```ts
import { db } from './db';

const PII_COLUMNS = new Set(['ssn', 'dob', 'tax_id', 'passport_no']);

db.$on('query', (e) => {
  if (!e.result || !Array.isArray(e.result)) return;
  for (const row of e.result) {
    for (const col of Object.keys(row)) {
      if (PII_COLUMNS.has(col) && row[col] != null) {
        // The application still sees the value — but the event payload doesn't.
        row[col] = '[redacted]';
      }
    }
  }
});
```

The handler mutates `e.result` in place; the original row already left the call site, so this only affects what downstream subscribers (logs, tracing, metrics) see. The further nuance is in [LOGGING.md](./LOGGING.md#redacting-pii-from-query-events) — log shippers tend to capture the SQL too, and the `$1, $2, …` placeholders mean PII in `e.params` needs the same redaction by column position.

---

## Field-level encryption

When the database operator is in the threat model — a managed-DB provider, a shared cluster — at-rest encryption (covered below) isn't enough. The data still appears in plaintext to the database engine, and any operator with `SELECT` privilege can read it. Field-level encryption shifts the trust boundary: the application encrypts on write, decrypts on read, and the database stores ciphertext.

The forge composition shape: declare the column as `f.binary()` (or `f.string()` for base64), put encrypt/decrypt in a small repository wrapper, and never reach for raw SQL on the encrypted column unless you've wrapped the query side too.

### AES-GCM with a derived key per record

The reference shape uses libsodium's `crypto_secretbox` or Web Crypto's `AES-GCM`. Both produce a `(nonce, ciphertext+tag)` blob; you store the blob as `BYTEA` (Postgres), `VARBINARY` (MySQL/MSSQL), or `BLOB` (SQLite). The key lives in your KMS — AWS KMS, GCP KMS, HashiCorp Vault, or a self-hosted age key. The data-encryption key (DEK) is derived per-record from a key-encryption key (KEK):

```ts
// src/crypto/aead.ts
import { webcrypto as crypto } from 'node:crypto';

const KEK = Buffer.from(process.env.FORGE_KEK_BASE64!, 'base64');     // 32 bytes
if (KEK.length !== 32) throw new Error('KEK must be 32 bytes');

const subtle = crypto.subtle;

async function deriveDek(salt: Uint8Array): Promise<CryptoKey> {
  const kek = await subtle.importKey('raw', KEK, 'HKDF', false, ['deriveKey']);
  return subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt, info: new TextEncoder().encode('forge-pii-v1') },
    kek,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

export async function encryptField(plain: string): Promise<Buffer> {
  const salt   = crypto.getRandomValues(new Uint8Array(16));
  const nonce  = crypto.getRandomValues(new Uint8Array(12));
  const dek    = await deriveDek(salt);
  const cipher = await subtle.encrypt({ name: 'AES-GCM', iv: nonce }, dek,
    new TextEncoder().encode(plain));
  // Layout: [version(1)][salt(16)][nonce(12)][ciphertext+tag(N)]
  return Buffer.concat([Buffer.from([1]), salt, nonce, Buffer.from(cipher)]);
}

export async function decryptField(blob: Buffer): Promise<string> {
  if (blob[0] !== 1) throw new Error('unknown ciphertext version');
  const salt       = blob.subarray(1, 17);
  const nonce      = blob.subarray(17, 29);
  const ciphertext = blob.subarray(29);
  const dek    = await deriveDek(salt);
  const plain  = await subtle.decrypt({ name: 'AES-GCM', iv: nonce }, dek, ciphertext);
  return new TextDecoder().decode(plain);
}
```

The version byte is the path to rotation — when you swap the KEK or the HKDF info string, bump the version and keep the old branch in `decryptField` for the rolling-rekey window. Lose the version byte and rotation costs you a full backfill.

### Repository wrapper around an encrypted column

The model declares the column as `f.binary()`. The repository wraps `findFirst` and `create`/`update` so the rest of the application sees plaintext.

```ts
const User = model('users', {
  id:        f.id(),
  email:     f.string().unique(),
  ssn_enc:   f.binary(),                       // ciphertext blob
  ssn_hash:  f.string().nullable(),            // HMAC for equality lookup, see below
});

export const userRepo = {
  async findById(id: string) {
    const row = await db.user.findFirst({ where: { id } });
    if (!row) return null;
    return { ...row, ssn: await decryptField(row.ssn_enc) };
  },

  async create(data: { email: string; ssn: string }) {
    const ssn_enc  = await encryptField(data.ssn);
    const ssn_hash = await hmacSsn(data.ssn);    // for equality lookups
    return db.user.create({ data: { email: data.email, ssn_enc, ssn_hash } });
  },
};
```

### Equality lookup on an encrypted column

AES-GCM is randomised — the same plaintext encrypts to a different ciphertext every time. You cannot `WHERE ssn_enc = ?` on a ciphertext column. The standard shape is a **deterministic HMAC** stored alongside:

```ts
import { createHmac } from 'node:crypto';
const HMAC_KEY = Buffer.from(process.env.FORGE_HMAC_KEY_BASE64!, 'base64');

export function hmacSsn(ssn: string): string {
  return createHmac('sha256', HMAC_KEY).update(ssn).digest('base64url');
}

// Lookup:
const row = await db.user.findFirst({ where: { ssn_hash: hmacSsn(req.body.ssn) } });
```

The HMAC leaks **equality** (two records with the same SSN have the same hash) but nothing else. That's the trade — without it, every SSN lookup becomes a full scan. The HMAC key is a separate KMS-stored secret from the AES KEK; if one leaks the other still protects the plaintext.

### Range / prefix queries

There is no clean shape. The honest options are: don't (if `ssn` is only ever an exact lookup, range queries don't appear in the requirement set); encrypted-domain search via an external service (Vault's transit engine, CipherSweet for application-layer "blind index"); or tokenisation, where the sensitive value is replaced with a token, range-queried in the application database, and resolved via a vault on demand. The last shape is the PCI pattern for PAN.

### Key management

The three secrets — KEK, HMAC key, vault token — live nowhere near the database connection string. The minimum-viable shape is environment variables sourced from a secret manager (AWS Secrets Manager, GCP Secret Manager, Vault) at boot, never written to disk. The compliance-grade shape is a hardware HSM behind a KMS API, with the application calling `Encrypt` / `Decrypt` for every field operation. The boundary trade is throughput — KMS API calls are 5-50 ms each, application-side AES-GCM is < 100 µs — so most teams cache a decrypted DEK in memory and call KMS only on rotation.

The repository wrapper above does the in-memory shape; for the KMS shape, replace `deriveDek` with a memoised call to `kms.decrypt({ ciphertext: row.dek_blob })` and store the wrapped DEK per row.

---

## Encrypted at rest

Disk encryption is the database operator's responsibility, not forge's. The shapes are well-trodden — see [ENCRYPTION.md](./ENCRYPTION.md) for the full matrix once that file lands; the security-relevant slice:

* **Native, transparent.** Postgres' `pgcrypto` columns, MySQL InnoDB encrypted tablespaces, MSSQL TDE, SQLite SEE / SQLCipher. The database engine encrypts before the page hits disk; queries operate on plaintext. Protects against disk theft and backup leakage; does not protect against an operator with `SELECT` privilege. This is the default for managed-DB providers (RDS, Cloud SQL, Atlas).
* **Filesystem, transparent.** LUKS on Linux, BitLocker on Windows, FileVault on macOS. Same threat model as native encryption.
* **Application layer.** The field-level pattern above. Protects against the operator and the backup; requires the application to manage keys.

For most teams the answer is "native encryption is on by default at the provider, plus application-layer encryption on the small set of columns where the operator is in the threat model". Don't stop at native — a database support engineer with the right ticket is one query away from any unencrypted column.

The browser SQLite case (covered in [BROWSER.md](./BROWSER.md#encryption-at-rest)) inverts the question: the user **is** the operator. There, the right shape is per-user passphrase deriving a SQLCipher key, plus a forge-side hook that re-derives on each session.

---

## Encrypted in transit

The driver does this, and forge passes through whatever the driver gives you. The two settings that matter live on the connection string.

**Postgres.**

```
postgres://user:pw@host:5432/db?sslmode=require
postgres://user:pw@host:5432/db?sslmode=verify-full   # validates CN/SAN
```

`sslmode=require` opens a TLS connection but accepts any certificate; `verify-full` validates the certificate chain *and* the hostname. Production is always `verify-full`. Managed providers (RDS, Cloud SQL, Supabase) publish a CA bundle; point `sslrootcert=/path/to/rds-ca.pem` at it.

**MySQL.**

```ts
import mysql from 'mysql2/promise';
import { readFileSync } from 'node:fs';

const pool = mysql.createPool({
  uri: process.env.DATABASE_URL,
  ssl: { ca: readFileSync('/etc/ssl/rds-ca.pem'), rejectUnauthorized: true },
});
```

**MSSQL.**

```ts
import sql from 'mssql';
const pool = await sql.connect({
  server: 'sqlsrv', database: 'app',
  options: { encrypt: true, trustServerCertificate: false },
  authentication: { type: 'default', options: { userName: 'app', password: process.env.PW } },
});
```

`encrypt: true` is on by default on `mssql` 9+; `trustServerCertificate: false` is what makes it non-bypassable. Set both explicitly.

**MongoDB.** Atlas connection strings enable TLS by default. For self-hosted, pass `tls=true&tlsCAFile=/path/to/ca.pem`. Mongo's wire protocol re-uses the TLS session for the lifetime of the socket, so connection-pool sizing dominates the TLS handshake cost.

### Mutual TLS — client certificates

For database connections that cross a public network or a regulated boundary, the application authenticates to the database with a client certificate. Postgres and MySQL both support this — pass `ssl: { ca, cert, key, rejectUnauthorized: true }` to the pool. The cert/key live on a tmpfs mount populated by your secret manager at boot. The cert's CN encodes the service identity (`forge-api-prod`), and the database's `pg_hba.conf` permits only specific CNs onto specific roles. This composes with IAM auth (below) — the cert proves the host; the IAM token proves the role.

### IAM authentication

AWS RDS, Google Cloud SQL, and Azure Database all offer IAM-token-based auth in place of a password. The application requests a short-lived token (15-min lifetime on RDS), uses it as the password, and rotates by re-requesting. Forge sits above the driver, so the integration lives in your pool's `password` provider — `new Pool({ password: () => signer.getAuthToken() })` with `@aws-sdk/rds-signer` — not in forge itself. `pg.Pool` accepts an async `password` provider; the token gets minted lazily per checkout. The full AUTH composition — IAM auth, mTLS, RLS-via-tx-setting layered together — lives in [AUTH.md](./AUTH.md) once that file ships; the security-relevant note is that all three compose without forge knowing.

---

## Database user permissions

The application role is not the schema owner. Three roles, three jobs.

| Role           | What it can do                                    | What it can't                              |
|----------------|---------------------------------------------------|--------------------------------------------|
| `forge_owner`  | DDL: `CREATE`, `ALTER`, `DROP`. Owns every table. | Read or write application rows.            |
| `forge_writer` | `SELECT`, `INSERT`, `UPDATE`, `DELETE` on app tables. | Any DDL. Anything on system tables.      |
| `forge_reader` | `SELECT` on app tables and views.                 | Writes. Any DDL.                           |

`forge push` runs as `forge_owner`. The HTTP API runs as `forge_writer`. Analytics queries and the read replica run as `forge_reader`. The compromise from a bad SQL injection in the API surface is bounded by `forge_writer`'s permissions — destructive but recoverable. A compromise of the analytics query path is read-only.

The Postgres setup, idempotent and applied once per environment:

```sql
-- Run as a superuser, once per environment.
CREATE ROLE forge_owner  LOGIN PASSWORD :owner_pw;
CREATE ROLE forge_writer LOGIN PASSWORD :writer_pw;
CREATE ROLE forge_reader LOGIN PASSWORD :reader_pw;

-- Owner owns the schema and every object inside it.
ALTER DATABASE app OWNER TO forge_owner;
GRANT CONNECT ON DATABASE app TO forge_writer, forge_reader;
GRANT USAGE   ON SCHEMA public TO forge_writer, forge_reader;

-- Default privs for future tables created by the owner.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  FOR ROLE forge_owner
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO forge_writer;

ALTER DEFAULT PRIVILEGES IN SCHEMA public
  FOR ROLE forge_owner
  GRANT SELECT ON TABLES TO forge_reader;

ALTER DEFAULT PRIVILEGES IN SCHEMA public
  FOR ROLE forge_owner
  GRANT USAGE, SELECT ON SEQUENCES TO forge_writer;
```

The `DEFAULT PRIVILEGES` clauses are the load-bearing piece. Without them, every `forge push` that creates a table requires a follow-up `GRANT` for the writer/reader roles, and a single forgotten grant produces "permission denied for relation X" at the next deploy. The `FOR ROLE forge_owner` clause is essential — defaults apply only to objects created by that role.

The `DATABASE_URL` for the API points at `forge_writer`. The CI's `DATABASE_URL` for `forge push` points at `forge_owner`. A grep for `forge_owner` outside the migrations runner is a CI finding.

### MySQL and MSSQL

Same shape, different syntax. MySQL: `GRANT SELECT, INSERT, UPDATE, DELETE ON app.* TO 'forge_writer'@'%';`. MSSQL: separate logins per role, mapped to a database user with `db_datareader` / `db_datawriter` / `db_owner` membership. The browser SQLite case has no concept of roles — the database **is** the user — so this section doesn't apply; see [BROWSER.md → File-system permissions](./BROWSER.md#file-system-permissions) for the analog.

### Mongo

Mongo's role model is finer-grained but the principle is the same — a custom role with `find`/`insert`/`update`/`remove` on `{ db: 'app', collection: '' }` rather than the built-in `read` (which includes meta operations the application doesn't need). Atlas' UI exposes the same vocabulary.

---

## Audit logging

The full pattern lives in [AUDIT-LOG.md](./AUDIT-LOG.md). The security-shaped requirements are:

1. **Every state change is captured.** Use the `$on('query')` event channel (covered in [EVENTS.md](./EVENTS.md)) and gate on `e.semanticOp` matching `INSERT|UPDATE|DELETE|UPSERT`. The trigger-based alternative in [AUDIT-LOG.md → Trigger-based audit](./AUDIT-LOG.md#trigger-based-audit) is the right choice when application-bypass paths exist (raw SQL, DBA queries) and you need the log to capture them.
2. **The actor is captured.** Either via `AsyncLocalStorage` set in middleware (the application-side shape) or via `SET LOCAL forge.actor_user = ${userId}` inside the request tx (the database-side shape that pairs with RLS). The second composes with trigger-based audit because the trigger can read `current_setting('forge.actor_user', true)`.
3. **The log is immutable to the application.** `forge_writer` has `INSERT` on `audit_log` but no `UPDATE` or `DELETE`. The owner role has full access for retention rolloff. A row inserted by a compromised API cannot be edited back out by the same path.
4. **Reads are logged for HIPAA-class workloads.** The default is to log writes; HIPAA requires logging reads of PHI too. The `$on('query')` listener captures every read; the gate is whether the model contains PHI columns.

The tamper-resistance shape — hash chains across rows — is in [AUDIT-LOG.md → Tamper-resistance — hash chains](./AUDIT-LOG.md#tamper-resistance--hash-chains).

---

## PII handling

PII appears in three places forge touches: the columns themselves, the SQL parameters in query events, and the rows returned to subscribers. Treat each separately.

**Columns.** Inventory which columns are PII (`email`, `phone`, `dob`, `ssn`, `name`, `address`, `ip`). Map each to a handling class:

| Class | Examples              | Storage                | Logs       | Dev/staging copy |
|-------|-----------------------|------------------------|------------|------------------|
| Low   | `email`, `name`       | plaintext              | redacted   | unmasked         |
| Med   | `phone`, `dob`, `ip`  | plaintext              | redacted   | hash or shuffle  |
| High  | `ssn`, `tax_id`, `passport` | encrypted (field-level) | never logged | synthetic       |

**SQL parameters in events.** The `$on('query')` event ships `e.params`, which contains every bound value — including PII. Redact by column position:

```ts
db.$on('query', (e) => {
  if (e.model === 'user' && e.semanticOp === 'INSERT') {
    // e.params positions match the column order of the INSERT;
    // forge's planner is deterministic, so position 2 is `ssn` for this insert.
    e.params = e.params.map((v, i) => (i === 2 ? '[redacted]' : v));
  }
});
```

For variable-shape inserts (`upsert` with `omit`), the position isn't stable. The pragmatic move is to redact **every** parameter for models with any high-class PII, accepting the loss of debuggability in exchange:

```ts
const PII_MODELS = new Set(['user', 'patient', 'employee']);
db.$on('query', (e) => {
  if (PII_MODELS.has(e.model ?? '')) e.params = e.params.map(() => '[redacted]');
});
```

**Rows returned.** The column-masking section above covers the application-layer redaction; the view-based pattern is the right shape for cross-team isolation.

**Dev/staging copies.** Never restore production into staging without masking. The shape depends on dialect; for Postgres, `pg_dump` plus a SQL post-process script that `UPDATE`s PII columns with `md5(original)` or a faker output is the standard pattern. For the field-encrypted columns, the staging KEK is a different secret from prod — restoring the prod ciphertext to staging produces unusable data, which is the point.

---

## GDPR

Three articles touch the data layer directly: Article 17 (right to erasure), Article 20 (right to data portability), and Article 32 (security of processing — encryption and audit). The first two are forge-shaped; the third is the rest of this document.

### Soft-delete is not erasure

`f.id()` plus the soft-delete pattern in [SOFT-DELETE.md](./SOFT-DELETE.md) marks a row as inactive — `deleted_at IS NOT NULL` — but the data stays in the table. Under GDPR Article 17, that is **not** erasure. The data is still processed, still backed up, still accessible to anyone with `SELECT` on the table. A right-to-erasure request requires a hard delete, or an anonymisation that destroys the identifying fields.

The pattern that satisfies both the audit requirement (keep the *fact* that a user existed) and the erasure requirement (destroy the *content*) is **tombstoning**:

```ts
export async function eraseUser(db: ForgeDb, userId: string) {
  await db.$transaction(async (tx) => {
    // Capture the erasure for the audit log BEFORE the data is gone.
    await tx.auditLog.create({
      data: {
        actor_id: 'system',
        action:   'gdpr.erasure',
        model:    'user',
        entity_id: userId,
        at: new Date(),
      },
    });
    // Overwrite identifying fields; keep the foreign-key target alive.
    await tx.user.update({
      where: { id: userId },
      data: {
        email:   `erased+${userId}@invalid.example`,
        name:    'erased',
        phone:   null,
        ssn_enc: null,
        ssn_hash: null,
        erased_at: new Date(),
      },
    });
    // Hard-delete the dependent rows where erasure is required.
    await tx.session.deleteMany({ where: { user_id: userId } });
    await tx.consentLog.deleteMany({ where: { user_id: userId } });
  });
}
```

The user row stays — orders, audit rows, and any other historic record still link to it — but the identifying content is overwritten. This is the shape regulators accept: the *processing* of personal data has stopped, even though the foreign-key target is still there.

Backups are the harder problem. GDPR allows the data to live in backups until the backup is rotated out (so long as a restore would re-apply the erasure list). The operational shape is an "erasure ledger" — a table the restore process consults — and a documented backup retention period (60-90 days for most teams).

### Right to data portability — export

Article 20 requires a machine-readable export of the user's data on request. `findManyStream` (covered in [STREAMING.md](./STREAMING.md)) is the right shape because exports can be large:

```ts
export async function* exportUser(db: ForgeDb, userId: string) {
  yield { type: 'user',    data: await db.user.findFirst({ where: { id: userId } }) };
  for await (const order of db.order.findManyStream({ where: { user_id: userId } })) {
    yield { type: 'order',   data: order };
  }
  for await (const log of db.auditLog.findManyStream({
    where: { entity_id: userId, model: 'user' },
  })) {
    yield { type: 'auditLog', data: log };
  }
}
```

The handler streams JSON-lines to the response. The export goes through the same RLS-scoped tx as everything else, so a user requesting their own data sees exactly the rows the application would normally let them see.

### Lawful basis and consent

The data layer is not the right place to enforce lawful basis — that's the application's job — but the audit log captures it. Every `consentLog` row records the consent's basis, version, and timestamp; every PII write that depends on consent emits an audit row referencing the consent ID. The compliance audit becomes a query.

---

## PCI-DSS

The PCI Data Security Standard separates "primary account number" (PAN), "card verification value" (CVV/CVC), and "cardholder name". The forge-relevant rules:

1. **Never store CVV.** Not in plaintext, not encrypted, not for 30 minutes, not in logs. There is no compliant shape for storing it. The CVV is captured by the front-end, sent to the payment processor, and discarded in the same request. If the codebase has a `cvv` column or a log line referencing the CVV parameter, the audit is over.
2. **Tokenise the PAN.** The PAN goes to the processor (Stripe, Adyen, Braintree); the processor returns a token (`tok_…`, `pm_…`); the token is what the database stores. Forge's job is just `f.string()` for the token column.
3. **Last-four and BIN are not PAN.** They're metadata you can store in plaintext. Useful for the "Visa ending 4242" UI without triggering PCI scope.
4. **Tokens are not bearer credentials.** The processor's token is tied to the merchant account; an attacker with the token but without the merchant API key can do nothing useful with it. That's why the trade is acceptable.

The PCI-scoped data minimisation principle composes with field-level encryption: the small set of legacy systems where the PAN must transit your infrastructure (settlement processors, legacy gateways) hold the PAN in an encrypted column with a per-PAN DEK, accessed only by a tightly-scoped service. Every other system in your fleet sees only the token. Forge sits on top of both.

**Key rotation.** PCI requires rotation at least annually, plus on personnel changes. The version-byte pattern from the field-level encryption section above is the operational shape — rotate the KEK, bump the version, run a backfill that decrypts under v1 and re-encrypts under v2, then delete the v1 KEK. The backfill streams via `findManyStream` (covered in [STREAMING.md](./STREAMING.md)) to avoid loading the whole table.

---

## HIPAA

The HIPAA Security Rule mandates two things forge composes with directly: encryption at rest of PHI (45 CFR 164.312(a)(2)(iv)) and audit logging of every PHI access (164.312(b)).

1. **Encryption at rest is mandatory** for HIPAA-covered data. Native at-rest encryption (RDS encryption, Cloud SQL CMEK, MongoDB Atlas at-rest encryption) is the table-stakes layer. Field-level encryption (the pattern above) on the highest-sensitivity columns — diagnosis codes, mental-health notes, substance-abuse records covered by 42 CFR Part 2 — is the additional layer.
2. **Audit every read.** Most audit-log shapes capture writes by default. HIPAA requires reads of PHI to be logged too. The `$on('query')` listener fires on `SELECT` as well as on writes; gate on `e.semanticOp === 'SELECT'` and `e.model` being a PHI-bearing model, then write the access record. Bulk reads (`findMany` returning 10k rows) become 10k audit rows under a strict reading; the pragmatic shape is one row per call with `result_count`, capturing the *fact* of the read and the row count.
3. **Minimum necessary.** The view-based column masking pattern above is the operational shape for "the support tier sees the last four of the SSN; the clinician sees the full SSN". The role gate lives in `current_setting('forge.actor_role')`, set per-tx alongside `forge.actor_user`.
4. **Business Associate Agreements.** Every vendor in the path needs a BAA — the database provider (AWS, GCP, Atlas all sign them), the logging provider, the error tracker. forge itself processes nothing — it's a library — but the destinations the `$on('query')` listener ships to (Datadog, Sentry, Splunk) are BAAs you need to sign separately.

The retention requirement is six years from creation or last effective date. The audit-log retention policy lives in cold storage (S3 + Glacier, GCS Coldline, Azure Archive); the hot table holds 90 days. The rolloff job is a `findManyStream` of expired rows to a JSONL file in object storage, followed by a partition drop on the audit table.

---

## SSRF and file inclusion via stored data

forge stores URLs, file paths, and geo-coordinates as values. They become attack surface the moment another component reads them and acts on them — fetching the URL, opening the path, plotting the coordinate. The validation has to happen at the boundary, not in the database.

The classic shapes:

1. **Stored URL → server-side fetch.** A user-uploaded `webhook_url` saved to `org.webhook_url`, then fetched by a worker. Without validation, the URL can be `http://169.254.169.254/latest/meta-data/` (AWS metadata) or `http://localhost:6379/` (internal Redis). The fix is zod (or any validation library) at write time, plus an outbound-firewall allowlist on the worker. forge passes the URL through unchanged; the validation is the application's job.
2. **Stored file path → fopen/include.** A user-supplied `template_path` saved as `f.string()`, later read and used as an argument to `fs.readFile` or a templating engine. Path traversal (`../../etc/passwd`) is the canonical issue. Same answer — validate at write, sandbox at read.
3. **Geo-coordinates → map render.** Less dangerous, but a `lat = 'javascript:alert(1)'` value in a JSON column reaches the front-end if the front-end trusts the column type. forge's `f.geoPoint` validates at the type layer; user-supplied geo data going through `f.json` does not. Validate.

The zod pattern at the boundary:

```ts
import { z } from 'zod';

const WebhookUrl = z.string().url().refine(
  (u) => {
    const url = new URL(u);
    if (!['http:', 'https:'].includes(url.protocol)) return false;
    if (PRIVATE_HOSTS.test(url.hostname)) return false;        // 10.x, 192.168.x, 127.x, ::1, etc.
    if (url.hostname === '169.254.169.254') return false;       // cloud metadata
    return true;
  },
  { message: 'URL must be a public http(s) URL' },
);

router.post('/orgs/:id/webhook', async (req, res) => {
  const url = WebhookUrl.parse(req.body.url);                   // throws → 422
  await db.org.update({ where: { id: req.params.id }, data: { webhook_url: url } });
  res.json({ ok: true });
});
```

The `f.json()` column is the catch-all where validation often gets skipped. Every `f.json()` field should have a zod schema parsed at write time; the schema doubles as the runtime type narrowing.

---

## Common vulnerabilities

The class-by-class checklist for forge-shaped systems. Each is preventable by construction; each appears in the wild.

### Second-order SQL injection

Covered above. The defence: every value that originated as user input travels as a bound parameter, every time it touches SQL. The grep rule catches the construction; code review catches the data-flow.

### Prototype pollution via dynamic `where` clauses

```ts
// BUG — Object.assign over an unrelated object's keys lands them in `where`.
const where = Object.assign({}, req.body);
await db.user.findMany({ where });
```

If `req.body` contains `__proto__: { isAdmin: true }`, depending on downstream code this may or may not leak — but the issue is **forge does not strip prototype keys from its filter input**. The defence is zod (or any validation library) constructed with `.strict()` so unknown keys are rejected at the boundary:

```ts
const Filter = z.object({
  email: z.string().optional(),
  name:  z.string().optional(),
}).strict();
await db.user.findMany({ where: Filter.parse(req.body) });
```

Use of `Object.create(null)` for filter constructions is a safer default; `{}` inherits from `Object.prototype`, which is the attack surface.

### Mass assignment

```ts
// BUG — every column of `req.body` lands in the `create` data, including `is_admin`.
await db.user.create({ data: req.body });
```

forge does not strip "system" columns from input. The defence is zod with explicit field allowlists, or a per-route `pick` helper:

```ts
const CreateUser = z.object({ email: z.string().email(), name: z.string() }).strict();
await db.user.create({ data: CreateUser.parse(req.body) });
```

`.strict()` is doing the load-bearing work here too. Without it, an extra field is silently accepted, the database errors out on the unknown column, and the bug appears as "users can't sign up".

### `IN`-list explosion

`db.user.findMany({ where: { id: { in: hugeArray } } })` is parameterised — there is no injection — but a 100k-element array generates a 100k-placeholder query that exceeds the driver's parameter limit (Postgres ~65k, MySQL 65k, SQLite default 32k). The user-controllable input is the array length; the failure mode is a 500 error.

Defence: cap array length at the validation boundary (`z.array(z.string()).max(1000)`), then page the lookup if larger.

### Timing attacks on equality checks

If your code is `if (user.api_key === req.headers['x-api-key'])`, the comparison short-circuits at the first mismatched byte and leaks information about the prefix. Use `crypto.timingSafeEqual` for any secret-comparison path:

```ts
import { timingSafeEqual } from 'node:crypto';
function constantTimeEq(a: string, b: string): boolean {
  const ab = Buffer.from(a), bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}
```

forge has no opinion on this — the secret comparison happens above the data layer — but the typical pattern of "load the user by token, compare in JS" has the timing-leak shape if not written carefully.

### Logging secrets

The `$on('query')` event ships `e.params`. If the params contain a password hash, an API key, a JWT, or a payment token, they end up in your log shipper. The redaction pattern in the PII section covers this; the rule is "if a model column holds a secret, the `$on('query')` redaction handler covers it by default, not as an afterthought".

---

## Browser context — CSP, Trusted Types, isolation

The browser SQLite path (covered in [BROWSER.md](./BROWSER.md)) puts the database in the user's tab. Two security-shaped surfaces appear that don't exist server-side.

**Content Security Policy.** sqlite-wasm loads a `.wasm` file at runtime. The CSP must permit `wasm-unsafe-eval` (or, on stricter setups, allow the specific origin and SRI hash). A typical production CSP:

```
Content-Security-Policy:
  default-src 'self';
  script-src 'self' 'wasm-unsafe-eval';
  worker-src 'self' blob:;
  connect-src 'self';
```

The `worker-src 'self' blob:` clause is required because forge runs the SQLite engine in a Web Worker, and the worker is loaded via `new Worker(new URL(...), { type: 'module' })`. The `wasm-unsafe-eval` directive is the modern replacement for `unsafe-eval` and is scoped to WebAssembly only.

**Trusted Types.** If the host page enables Trusted Types via `require-trusted-types-for 'script'`, every string-to-script path needs a trusted-type policy. forge's worker boot fetches the wasm via `fetch()` (not `eval`), so it doesn't trigger Trusted Types directly. The path that does is `forgeSql.raw(...)` — but `raw` only lands in a SQL string passed to a Worker, never in DOM script. Trusted Types and forge compose without issue.

**SharedArrayBuffer / OPFS isolation.** The OPFS-SAH-Pool driver (covered in [BROWSER.md](./BROWSER.md#opfs-sahpool-driver)) uses `SharedArrayBuffer` for cross-thread coordination. `SharedArrayBuffer` requires the page to be cross-origin isolated:

```
Cross-Origin-Embedder-Policy: require-corp
Cross-Origin-Opener-Policy:   same-origin
```

Without both headers, the OPFS-SAH-Pool driver falls back to a slower message-passing path. From a security standpoint, cross-origin isolation is the desired state regardless — it disables Spectre-class attacks across origins — so the security and performance answers align.

---

## Worked examples

### A — RLS-isolated tenant queries

Goal: any forgotten `tenant_id` filter (typed or raw) returns zero rows instead of leaking.

```ts
// src/db.ts
import { createDb, f, model } from 'forge-orm';
const Order = model('orders', {
  id:        f.id(),
  tenant_id: f.string(),
  user_id:   f.string(),
  total:     f.float(),
});
export const db = await createDb({
  url: process.env.DATABASE_URL!,
  schema: { order: Order },
});
```

```sql
-- migrations/0001_rls.sql — applied once via psql or a one-off forge $executeRaw.
ALTER TABLE orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE orders FORCE  ROW LEVEL SECURITY;
CREATE POLICY orders_iso ON orders
  USING       (tenant_id = current_setting('forge.actor_tenant', true)::text)
  WITH CHECK  (tenant_id = current_setting('forge.actor_tenant', true)::text);
```

```ts
// src/middleware/tx.ts
import { AsyncLocalStorage } from 'node:async_hooks';
import { db } from '../db';

const txStore = new AsyncLocalStorage<typeof db>();
export const scoped = () => txStore.getStore() ?? db;

export async function withRlsTx(actor: { tenant_id: string; user_id: string }, fn: () => Promise<unknown>) {
  return db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('forge.actor_tenant', ${actor.tenant_id}, true)`;
    await tx.$executeRaw`SELECT set_config('forge.actor_user',   ${actor.user_id},   true)`;
    return new Promise<unknown>((resolve, reject) => {
      txStore.run(tx, () => fn().then(resolve, reject));
    });
  });
}
```

```ts
// src/routes/orders.ts — the wrapper hides the typed surface behind a tenant-aware shape.
app.get('/orders', async (req, res) => {
  await withRlsTx(req.actor, async () => {
    // No explicit tenant_id filter. RLS adds it.
    const orders = await scoped().order.findMany();
    res.json(orders);
  });
});

app.post('/orders', async (req, res) => {
  await withRlsTx(req.actor, async () => {
    // The WITH CHECK clause rejects rows whose tenant_id doesn't match the setting.
    const order = await scoped().order.create({
      data: { tenant_id: req.actor.tenant_id, user_id: req.actor.user_id, total: req.body.total },
    });
    res.json(order);
  });
});
```

If a future handler forgets to wrap the call in `withRlsTx`, the query runs without a setting, `current_setting('forge.actor_tenant', true)` returns NULL, the policy evaluates to FALSE, and the query returns zero rows. That's the safety: the data is invisible, not exposed.

### B — Field-encrypted SSN column with HMAC lookup

```ts
// src/schema.ts
import { f, model } from 'forge-orm';
export const User = model('users', {
  id:        f.id(),
  email:     f.string().unique(),
  ssn_enc:   f.binary(),
  ssn_hash:  f.string().nullable(),
  created_at: f.timestamp().default(() => new Date()),
}, {
  indexes: [{ keys: { ssn_hash: 1 }, name: 'idx_users_ssn_hash' }],
});
```

```ts
// src/crypto/aead.ts  — same as the field-level encryption section.
import { webcrypto as crypto } from 'node:crypto';
import { createHmac } from 'node:crypto';

const KEK      = Buffer.from(process.env.FORGE_KEK_B64!,  'base64');
const HMAC_KEY = Buffer.from(process.env.FORGE_HMAC_B64!, 'base64');

export async function encryptSsn(ssn: string): Promise<Buffer> { /* … see above … */ }
export async function decryptSsn(blob: Buffer): Promise<string> { /* … see above … */ }
export function hmacSsn(ssn: string): string {
  return createHmac('sha256', HMAC_KEY).update(ssn).digest('base64url');
}
```

```ts
// src/repos/user.ts
import { db } from '../db';
import { encryptSsn, decryptSsn, hmacSsn } from '../crypto/aead';

export const userRepo = {
  async create(data: { email: string; ssn: string }) {
    const ssn_enc  = await encryptSsn(data.ssn);
    const ssn_hash = hmacSsn(data.ssn);
    return db.user.create({ data: { email: data.email, ssn_enc, ssn_hash } });
  },

  async findById(id: string) {
    const row = await db.user.findFirst({ where: { id } });
    if (!row) return null;
    return { ...row, ssn: await decryptSsn(row.ssn_enc), ssn_enc: undefined };
  },

  async findBySsn(ssn: string) {
    const row = await db.user.findFirst({ where: { ssn_hash: hmacSsn(ssn) } });
    if (!row) return null;
    return { ...row, ssn, ssn_enc: undefined };
  },
};
```

The repository is the only place that touches `ssn_enc` and `ssn_hash`. Every other call site sees the plaintext shape. A `db.user.findMany()` from elsewhere returns rows with the ciphertext columns; the typed surface is honest about the storage shape, and the wrapper is the contract.

### C — Audit-trail webhook on every mutation

```ts
// src/audit/wire.ts
import { db } from '../db';
import { Queue } from 'bullmq';

const auditQueue = new Queue('audit', { connection: { url: process.env.REDIS_URL! } });

db.$on('query', (e) => {
  if (e.error) return;                                 // failures go to $on('error')
  if (!['INSERT', 'UPDATE', 'DELETE', 'UPSERT'].includes(e.semanticOp ?? '')) return;

  // Don't await — the listener chain is synchronous.
  auditQueue.add('audit', {
    at:     new Date().toISOString(),
    model:  e.model,
    op:     e.semanticOp,
    rows:   e.rowCount,
    actor:  asyncLocalActor.getStore()?.user_id,        // from middleware
    tenant: asyncLocalActor.getStore()?.tenant_id,
    sql:    typeof e.sql === 'string' ? e.sql.slice(0, 500) : undefined,
  }, {
    // Idempotency in case a retried job double-fires.
    jobId: `${e.model}:${e.semanticOp}:${e.startedAt}`,
    removeOnComplete: { age: 86_400, count: 100_000 },
  }).catch((err) => console.error('audit enqueue failed', err));
});
```

```ts
// src/audit/worker.ts
import { Worker } from 'bullmq';
import { createDb } from 'forge-orm';
import { auditSchema } from '../schema';

const auditDb = await createDb({ url: process.env.AUDIT_DATABASE_URL!, schema: auditSchema });

new Worker('audit', async (job) => {
  await auditDb.auditLog.create({ data: job.data });
  if (process.env.AUDIT_WEBHOOK_URL) {
    await fetch(process.env.AUDIT_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(job.data),
    });
  }
}, { connection: { url: process.env.REDIS_URL! }, concurrency: 8 });
```

Three design choices to call out:

1. **The audit DB is a separate URL.** Compromise of the API role does not give the attacker write access to the audit log; the audit worker's role has `INSERT` but no `UPDATE` / `DELETE`.
2. **The queue is the durability boundary.** If the worker crashes mid-batch, BullMQ re-delivers; the `jobId` makes the redelivery idempotent.
3. **The listener does not `await`.** `$on('query')` listeners run synchronously between queries; an awaited listener stalls the next query's listener chain. Push to a queue, return immediately.

The downstream shapes — hash-chained audit rows, SIEM forwarding, retention rolloff — are in [AUDIT-LOG.md](./AUDIT-LOG.md).

---

## Cross-references

- [RAW-SQL.md](./RAW-SQL.md) — the template-tag rules, identifier vs value placement, the six worked patterns, the safety rules in full.
- [MULTI-TENANT.md](./MULTI-TENANT.md) — the four shapes, RLS in long form, schema-per-tenant migrations.
- [ENCRYPTION.md](./ENCRYPTION.md) — at-rest matrix per dialect, browser SQLCipher, KMS integration. (When this file lands.)
- [AUTH.md](./AUTH.md) — IAM auth, mTLS, OIDC for managed databases, RBAC composition. (When this file lands.)
- [AUDIT-LOG.md](./AUDIT-LOG.md) — three audit-log shapes, trigger-based audit, hash chains, retention.
- [SOFT-DELETE.md](./SOFT-DELETE.md) — soft-delete semantics, why it isn't GDPR erasure, restore patterns.
- [EVENTS.md](./EVENTS.md) — the `$on('query')` field reference that powers redaction and audit hooks.
- [LOGGING.md](./LOGGING.md) — pino + structured logging, slow-query log, redacting PII from log shippers.
- [BROWSER.md](./BROWSER.md) — sqlite-wasm CSP requirements, OPFS isolation, per-user passphrase patterns.
- [BACKEND.md](./BACKEND.md) — request-scoped transactions, the wrapper shape that hosts `withRlsTx`.
- [MIGRATIONS.md](./MIGRATIONS.md) — applying the RLS migration alongside `forge push`, the role split for CI vs runtime.
