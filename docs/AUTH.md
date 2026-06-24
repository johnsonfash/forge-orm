# Database authentication

How forge-orm connects to the database — password-based, IAM-based, certificate-based, SSH-tunneled, VPC-private. This page covers DB-layer auth (not app-user-auth), the credential storage patterns that work, IAM token refresh, and the per-cloud quirks (RDS IAM, Cloud SQL Auth Proxy, Atlas X.509).

It is the companion read to [SECURITY.md](./SECURITY.md) (which covers the application-layer threat model, RLS, and field-level encryption) and [POOLING.md](./POOLING.md) (where the driver wrapper and pool ownership shapes live). The patterns below describe what goes into the connection string, what mints the credential, and how the credential gets rotated without dropping in-flight queries; the application-side authorisation patterns belong on the other side of the boundary.

## Contents

- [Scope — DB auth, not app-user-auth](#scope--db-auth-not-app-user-auth)
- [Password-based authentication](#password-based-authentication)
- [IAM-based authentication](#iam-based-authentication)
- [Client certificate / mTLS](#client-certificate--mtls)
- [SCRAM-SHA-256 (Postgres)](#scram-sha-256-postgres)
- [SSH tunneling](#ssh-tunneling)
- [VPC and private endpoints](#vpc-and-private-endpoints)
- [Least-privilege roles](#least-privilege-roles)
- [Secret storage](#secret-storage)
- [Connection-string injection](#connection-string-injection)
- [Auditing who connected](#auditing-who-connected)
- [MongoDB Atlas specifics](#mongodb-atlas-specifics)
- [MSSQL — SQL Server, Windows, Azure AD](#mssql--sql-server-windows-azure-ad)
- [Browser sqlite-wasm](#browser-sqlite-wasm)
- [Common gotchas](#common-gotchas)
- [Worked examples](#worked-examples)
- [Cross-references](#cross-references)

---

## Scope — DB auth, not app-user-auth

Two different problems share a word, and the shape of the answer is completely different in each.

**Database authentication** is the credential the application process uses to open a socket to the database. It answers "is this process allowed to talk to this database, and as which role?". The credential is held by infrastructure — a connection string in a secret manager, a certificate on a tmpfs mount, an IAM token fetched at connect time. There is no user input in the path; the application never sees a database password from a user, never logs in to the database "as" a user, never passes a user's token through to the database. The DB sees one role per service, regardless of how many end users that service serves.

**Application-user authentication** is what happens at `/v1/auth/login`. A user submits an email and a password (or an OIDC code, or a magic link), the application validates it against a `users` table, mints a session token, and ships it to the client. The database connection used to read that `users` row is opened under the *service's* DB credential, not the user's. Every user of the application shares the same database role — `forge_writer`, in the [SECURITY.md table](./SECURITY.md#database-user-permissions).

This page covers the first. The second is application-shaped — bcrypt, JWT, OIDC, session cookies, refresh-token rotation — and lives in `/v1/auth/*` handlers in your app, not in forge. If you find yourself thinking "the user logs in to the database", the architecture has gone sideways; the canonical fix is one service role per backend service, application-layer auth in front of it.

The boundary matters because it determines where the secret rotates. A database password rotates on an infrastructure cadence (90 days, or on personnel change). A user password rotates on a user cadence (whenever the user clicks "change password"). The two have no shared interface and no shared storage; treating them as the same problem leads to either user passwords in your `pg_hba.conf` or DB passwords in your `users` table, both of which are wrong.

Two patterns blur the boundary. **Per-tenant database roles** — a SaaS where each customer gets a Postgres role that the application impersonates with `SET ROLE` after the connection opens — is still DB auth (the service holds the master credential), gated on the application's actor. It composes with RLS; see [MULTI-TENANT.md](./MULTI-TENANT.md#schema-per-tenant). **End-user IAM** — a desktop app where each user's AWS IAM credential connects directly to RDS — is coherent for analyst tools (Redshift, BigQuery), rare for SaaS, and forge passes the token through unchanged.

---

## Password-based authentication

The default shape across every dialect — a username and password in the connection string, validated by the database against its credential store.

```
postgres://forge_writer:hunter2@db.internal:5432/app?sslmode=verify-full
mysql://forge_writer:hunter2@db.internal:3306/app?ssl-mode=VERIFY_IDENTITY
mongodb://forge_writer:hunter2@cluster.mongodb.net/app?authSource=admin
sqlserver://forge_writer:hunter2@db.internal:1433/app?encrypt=true
```

forge passes the string to the driver verbatim. The driver parses it, splits username/password out of the URL, and ships the password over the TLS-wrapped wire. No credential touches forge itself; the executor only sees a connected driver.

```ts
import { createDb } from 'forge-orm';
import { schema } from './schema';

export const db = await createDb({
  url: process.env.DATABASE_URL!,
  schema,
});
```

When you want to wrap your own pool — the right shape for anything serving real traffic, per [POOLING.md](./POOLING.md#where-the-pool-lives-in-forge) — the password lives in the pool config:

```ts
import { Pool } from 'pg';
import { createDb, pgDriver } from 'forge-orm';

const pool = new Pool({
  host:     process.env.PGHOST,
  port:     Number(process.env.PGPORT ?? 5432),
  user:     process.env.PGUSER,
  password: process.env.PGPASSWORD,
  database: process.env.PGDATABASE,
  ssl:      { rejectUnauthorized: true },
  max:      8,
});

export const db = await createDb({ schema, driver: pgDriver(pool) });
```

### The rotation problem

Passwords are a static credential; rotation requires every process in the fleet to see the new value at roughly the same time. Three shapes work.

**Rolling restart with new password.** Write the new password to the secret manager, redeploy. The old password keeps working until you `ALTER USER … PASSWORD NULL`s it, so there's no gap. The trade is that rotation takes a deploy cycle.

**Dual-credential window.** MySQL via `ALTER USER … IDENTIFIED BY new RETAIN CURRENT PASSWORD`; Postgres by creating a peer role temporarily. Both old and new work during the window. The trade is the bookkeeping — drop the old password explicitly when rotation completes, and a forgotten cleanup means rotation didn't actually happen.

**Read on every connect.** The pool reads from the secret manager on every connection. `pg.Pool` takes `password` as either a string or an async function:

```ts
import { Pool } from 'pg';
import { getSecret } from './secrets';

const pool = new Pool({
  host: 'db.internal',
  user: 'forge_writer',
  password: async () => (await getSecret('forge/db/password')).SecretString,
  max: 8,
});
```

The function is invoked per new connection, not per query. When the secret rotates, in-flight connections keep working with the old password; new connections pick up the new one. The latency hit per new connection (5–50 ms against the secret-manager API) stays off the hot path if you keep the pool warm.

### Password complexity and the URL encoding trap

`user:pass@host` means a password containing `@`, `:`, `/`, `#`, `?`, or `%` has to be URL-encoded. `hunter@2` becomes `hunter%402`; `p/w` becomes `p%2Fw`; a `?` collides with the query-string separator and must be `%3F`. `pg` and `mongodb` are strict; `mysql2` is lenient enough to fail later in confusing ways. Either restrict the generator to alphanumerics (`tr -dc 'A-Za-z0-9' < /dev/urandom | head -c 40`) or always encode before assembling the URL:

```ts
const pw = encodeURIComponent(process.env.DB_PASSWORD!);
const url = `postgres://forge_writer:${pw}@db.internal:5432/app`;
```

This trap is the single most common "the password I just rotated doesn't work" cause. See [Common gotchas](#common-gotchas).

---

## IAM-based authentication

A database password rotates on a 90-day cycle. An IAM token rotates on a 15-minute cycle. The difference is the entire pitch: there is no long-lived secret to leak. The application requests a short-lived token from the cloud provider, uses it as the database password, and re-requests when it expires. If a token is captured, it's useless inside the quarter-hour.

forge does not own this — the token-minting and refresh live in the driver's `password` provider — but the integration shape is the same across providers.

### AWS RDS IAM authentication

RDS (Postgres and MySQL) and Aurora support an IAM auth mode where the password is a signed token good for 15 minutes. The role attached to the EC2 instance / ECS task / Lambda needs `rds-db:connect` on the database resource ARN, and the database role has to be created with `rds_iam` group (Postgres) or `IDENTIFIED WITH AWSAuthenticationPlugin` (MySQL).

```sql
-- Run once as the admin role.
CREATE USER forge_writer;
GRANT rds_iam TO forge_writer;
GRANT CONNECT ON DATABASE app TO forge_writer;
-- Plus the per-table grants from SECURITY.md → Database user permissions.
```

The token-minting shape with `@aws-sdk/rds-signer`:

```ts
import { Pool } from 'pg';
import { Signer } from '@aws-sdk/rds-signer';
import { createDb, pgDriver } from 'forge-orm';

const signer = new Signer({
  region:   process.env.AWS_REGION!,
  hostname: process.env.PGHOST!,
  port:     5432,
  username: 'forge_writer',
});

const pool = new Pool({
  host:     process.env.PGHOST,
  port:     5432,
  user:     'forge_writer',
  database: process.env.PGDATABASE,
  // Per-connection callback. Mints a fresh token on every new connection.
  password: () => signer.getAuthToken(),
  ssl:      { rejectUnauthorized: true, ca: rdsCaBundle },
  max:      8,
  // Keep the pool warm so we don't mint a token per query.
  idleTimeoutMillis: 0,
  min: 4,
});

export const db = await createDb({ schema, driver: pgDriver(pool) });
```

Two shapes to get right. **The token is per-connection, not per-query** — `pg.Pool` calls the `password` provider when it opens a new socket, not on every checkout. A warm connection keeps its original token; the 15-minute TTL applies to *new* connections only, because the database authenticated at handshake time. The failure mode is in [Common gotchas](#common-gotchas). **`min` and `idleTimeoutMillis: 0` are load-bearing** — without them the pool evicts idle connections, mints a fresh token per reconnect, and pays 30–80 ms per cold path.

### Google Cloud SQL Auth Proxy

GCP's shape is different: instead of minting a token in-process, you run the **Cloud SQL Auth Proxy** as a sidecar. The proxy authenticates to Cloud SQL with the service account's IAM credentials, opens an encrypted channel, and exposes the database on a local Unix socket or TCP port. forge connects to the local socket; the proxy handles the IAM dance.

```yaml
# kubernetes deployment.yaml — sidecar pattern.
spec:
  template:
    spec:
      serviceAccountName: forge-api
      containers:
        - name: app
          image: forge-api:latest
          env:
            - name: DATABASE_URL
              value: postgres:///app?host=/cloudsql/proj:region:instance&user=forge_writer
        - name: cloud-sql-proxy
          image: gcr.io/cloud-sql-connectors/cloud-sql-proxy:2.11.0
          args:
            - "--auto-iam-authn"
            - "--unix-socket=/cloudsql"
            - "proj:region:instance"
          volumeMounts:
            - { name: cloudsql, mountPath: /cloudsql }
      volumes:
        - { name: cloudsql, emptyDir: { medium: Memory } }
```

The `--auto-iam-authn` flag tells the proxy to also IAM-authenticate the database user — Cloud SQL's equivalent of `rds_iam`. With it, the application doesn't even need a password; the proxy mints the token on the application's behalf.

The Node-side library `@google-cloud/cloud-sql-connector` skips the sidecar by linking the proxy code into the process:

```ts
import { Connector, IpAddressTypes, AuthTypes } from '@google-cloud/cloud-sql-connector';
import { Pool } from 'pg';
import { createDb, pgDriver } from 'forge-orm';

const connector = new Connector();
const clientOpts = await connector.getOptions({
  instanceConnectionName: 'proj:region:instance',
  ipType: IpAddressTypes.PRIVATE,
  authType: AuthTypes.IAM,
});

const pool = new Pool({
  ...clientOpts,
  user: 'forge-writer@proj.iam',          // GCP-style IAM principal
  database: 'app',
  max: 8,
});

export const db = await createDb({ schema, driver: pgDriver(pool) });
```

The connector handles token refresh internally; the application code doesn't see it.

### Azure AD authentication

Azure Database for PostgreSQL / MySQL / SQL Server accepts an Azure AD access token as the password. The token comes from `@azure/identity` — `DefaultAzureCredential` resolves to the managed identity in production, a developer's `az login` session locally.

```ts
import { Pool } from 'pg';
import { DefaultAzureCredential } from '@azure/identity';
import { createDb, pgDriver } from 'forge-orm';

const credential = new DefaultAzureCredential();
const scope = 'https://ossrdbms-aad.database.windows.net/.default';

const pool = new Pool({
  host:     process.env.PGHOST,
  port:     5432,
  user:     'forge-writer@db-server',
  database: process.env.PGDATABASE,
  password: async () => (await credential.getToken(scope)).token,
  ssl:      { rejectUnauthorized: true },
  max:      8,
});

export const db = await createDb({ schema, driver: pgDriver(pool) });
```

`DefaultAzureCredential` caches the token until 5 minutes before expiry, so the pool's `password` provider is effectively cheap; the actual STS call happens once an hour.

### IAM token TTL — the 15-minute hand-off

The pattern across all three clouds: the token authenticates the handshake, not the session. Once the connection is open, the database's session is alive until the socket closes, regardless of token expiry. This is what makes warm pools tenable — a connection minted at minute 0 keeps serving queries at minute 30, even though the token would have rejected a new handshake at minute 16.

The failure mode is when the connection drops (network blip, server restart, `tcp_keepalive` reaping) and the pool reconnects with a stale cached token. The defence is to fetch the token at handshake time, not at pool construction — which is what the `password: async () => …` shape buys you. Don't cache the token in a module-level variable; let the provider handle caching, and let it re-mint when the previous one is near expiry.

---

## Client certificate / mTLS

When the database connection crosses a network boundary you don't fully trust — a peer VPC, a third-party processor, a regulated zone — the application authenticates to the database with a client certificate in addition to (or instead of) a password. The handshake proves the *machine*; the password proves the *role*. Both rotate; the certificate rotates on the PKI cadence (typically 90 days for automated certificate management, 365 for manual), the password on the secret-manager cadence.

### Generating the certificate chain

The minimum shape: an internal CA, a server certificate signed by it (with the database hostname in the SAN), and a client certificate signed by it (with the service identity in the CN). Most teams use `cert-manager` in Kubernetes, AWS Private CA, or HashiCorp Vault's PKI engine; the standalone form using `openssl`:

```sh
# CA
openssl genrsa -out ca.key 4096
openssl req -x509 -new -nodes -key ca.key -sha256 -days 3650 \
  -subj '/CN=forge-internal-ca' -out ca.pem

# Server certificate
openssl genrsa -out server.key 2048
openssl req -new -key server.key \
  -subj '/CN=db.internal' \
  -addext 'subjectAltName=DNS:db.internal,DNS:db' \
  -out server.csr
openssl x509 -req -in server.csr -CA ca.pem -CAkey ca.key -CAcreateserial \
  -out server.pem -days 365 -sha256 \
  -extfile <(printf 'subjectAltName=DNS:db.internal,DNS:db')

# Client certificate — CN encodes the service identity
openssl genrsa -out forge-api.key 2048
openssl req -new -key forge-api.key \
  -subj '/CN=forge-api-prod' -out forge-api.csr
openssl x509 -req -in forge-api.csr -CA ca.pem -CAkey ca.key -CAcreateserial \
  -out forge-api.pem -days 90 -sha256
```

The database is configured to require the client cert. For Postgres in `pg_hba.conf`:

```
# TYPE  DATABASE  USER          ADDRESS       METHOD       OPTIONS
hostssl app       forge_writer  0.0.0.0/0     cert         clientcert=verify-full map=service_to_role
```

`pg_ident.conf` maps the certificate CN to the role:

```
# MAPNAME           SYSTEM-USERNAME    PG-USERNAME
service_to_role     forge-api-prod     forge_writer
```

The application reads the cert/key from a tmpfs mount populated at boot by the secret manager:

```ts
import { Pool } from 'pg';
import { readFileSync } from 'node:fs';
import { createDb, pgDriver } from 'forge-orm';

const pool = new Pool({
  host:     'db.internal',
  port:     5432,
  user:     'forge_writer',
  database: 'app',
  ssl: {
    ca:                 readFileSync('/etc/ssl/forge/ca.pem'),
    cert:               readFileSync('/etc/ssl/forge/forge-api.pem'),
    key:                readFileSync('/etc/ssl/forge/forge-api.key'),
    rejectUnauthorized: true,
    servername:         'db.internal',                 // SNI for shared listeners
  },
  max: 8,
});

export const db = await createDb({ schema, driver: pgDriver(pool) });
```

### Distributing certificates

Three shapes. **Init container + tmpfs** — the init container fetches the cert and writes it to an `emptyDir` volume backed by tmpfs. The cert is on local memory-backed disk, fine for any threat model short of full memory-dump compromise. **Sidecar with cert renewal** — a sidecar polls the secret manager (or runs `cert-manager`'s renewal client) and rewrites the file when the cert is close to expiry. `pg.Pool` doesn't accept a cert-rotation hook, so the practical shape is to construct a new pool and atomically swap it in:

```ts
import { watch } from 'node:fs';
import { Pool } from 'pg';
import { createDb, pgDriver } from 'forge-orm';

let pool = makePool();
export let db = await createDb({ schema, driver: pgDriver(pool) });

watch('/etc/ssl/forge/forge-api.pem', async () => {
  const oldPool = pool;
  pool = makePool();
  const fresh = await createDb({ schema, driver: pgDriver(pool) });
  // Swap the export. The old db's pool drains as in-flight queries finish.
  Object.assign(db, fresh);
  // Drain the previous pool with a grace period.
  setTimeout(() => oldPool.end().catch(console.error), 30_000);
});
```

The swap pattern is identical to the [SIGTERM drain in POOLING.md](./POOLING.md#connection-lifecycle-and-sigterm-drain) — same shape, different trigger. **In-process renewal via Vault's auto-auth** — Vault Agent watches the certificate, refreshes it, and updates the file; the next pool reconnect picks up the new cert.

### Certificate rotation cadence

90 days for automated systems, 365 for manual. Longer is a target; shorter than 30 days produces too much rotation noise. Cert-manager + Vault PKI is the standard automated shape; AWS Private CA Connector for Kubernetes is the AWS-native equivalent. Both re-sign at 2/3 of the lifetime, leaving a 30-day safety margin.

---

## SCRAM-SHA-256 (Postgres)

The Postgres password authentication has three modes — `password` (plaintext over the wire), `md5` (challenge-response with an MD5-hashed credential), and `scram-sha-256` (SASL/SCRAM with SHA-256). The first is insecure regardless of TLS; the second is deprecated and prone to offline cracking once the on-disk hash leaks; the third is the modern default.

```
# postgresql.conf — Postgres 14+
password_encryption = scram-sha-256
```

```
# pg_hba.conf
hostssl app forge_writer 0.0.0.0/0 scram-sha-256
```

When you `CREATE USER … PASSWORD 'x'`, the password is hashed with SCRAM before being written to `pg_authid.rolpassword`. The credential on disk is a salted, iterated SHA-256 of the password; an attacker who exfiltrates the hash has to do offline work proportional to the iteration count (default 4096, configurable). MD5's hash is unsalted, and an attacker who exfiltrates it can replay it directly to authenticate — the on-disk hash *is* the credential.

**Migrating from md5.** If your database predates Postgres 14, `pg_authid` has md5 hashes for every role. Setting `password_encryption = scram-sha-256` only affects *future* password sets; existing roles keep authenticating with md5 until you `ALTER USER … PASSWORD '…'` to rewrite the hash. The pattern is a one-off script that re-sets every role's password under the new mode, then flips `pg_hba.conf` to `scram-sha-256`.

**Driver support.** All current Node Postgres drivers — `pg`, `postgres.js`, `@neondatabase/serverless` — speak SCRAM-SHA-256 transparently. If you see "SASL authentication failed", the database is offering `password` or `md5` and the driver isn't negotiating down (correctly). Check `pg_hba.conf`.

The same SASL/SCRAM mechanism is used by MongoDB (`SCRAM-SHA-256` is the default for Mongo 4.0+) and MySQL (`caching_sha2_password`). Cross-dialect, the shape is the same: pick the modern hash, configure the server, ensure the driver is current, never accept a downgrade.

---

## SSH tunneling

For databases deliberately not internet-routable — a private VPC, an on-prem cluster, a regulated zone behind a hardened bastion — the application reaches them via an SSH tunnel from a host that *can* reach the database. Older than IAM auth but the right answer for any system without a managed cloud provider.

Two shapes: process-external `ssh -L` (simple, brittle to restarts) and `ssh2` opening the tunnel in-process (robust, brittle to the SSH library's connection lifecycle).

### Process-external — the local-dev shape

```sh
# Open a tunnel from local:5433 to the bastion's view of the database.
ssh -N -L 5433:db.internal:5432 bastion.example.com
```

The application connects to `postgres://forge_writer:pw@localhost:5433/app`. The tunnel is invisible to forge; the driver sees a local socket. Fine for development; for production `ssh -N` doesn't reconnect on its own, and the right shape isn't process-external at all — it's in-process.

### In-process with `tunnel-ssh`

The `tunnel-ssh` library packages the forward-listen-pipe dance — open the SSH connection, forward a local port, expose the resulting `host:port` to the pool. The shape:

```ts
import { createTunnel } from 'tunnel-ssh';
import { Pool } from 'pg';
import { createDb, pgDriver } from 'forge-orm';
import { readFileSync } from 'node:fs';

const [server] = await createTunnel(
  { autoClose: false },
  { port: 0 },                                              // local: random port
  {
    host:       process.env.BASTION_HOST!,
    port:       22,
    username:   'forge-tunnel',
    privateKey: readFileSync('/etc/ssh/forge-tunnel.key'),
    keepaliveInterval: 30_000,
  },
  { dstAddr: 'db.internal', dstPort: 5432 },
);
const { port } = server.address() as { port: number };

const pool = new Pool({
  host: '127.0.0.1', port,
  user: 'forge_writer', password: process.env.PGPASSWORD,
  database: 'app', max: 8,
});

export const db = await createDb({ schema, driver: pgDriver(pool) });
```

The hand-rolled `ssh2.forwardOut` shape works too but requires wrapping the resulting stream as a `net.Socket` server; `tunnel-ssh` exists to spare you that.

### Bastion vs. database authentication — two credentials

The SSH key authenticates to the bastion; the database password authenticates to the database. Different secrets, different rotation cadences, different roles. The bastion's `~/.ssh/authorized_keys` for `forge-tunnel` holds a key whose private half lives in the application's secret manager; the database's `forge_writer` has its own password. Compromise of one doesn't grant the other.

`ssh2`'s default never sends keepalives; on networks with NAT timeouts (cloud NAT gateways drop idle TCP connections after 350 seconds), the tunnel dies silently. Set `keepaliveInterval: 30_000` and `keepaliveCountMax: 3`.

---

## VPC and private endpoints

The non-internet-routable shape: the database listens only on a private subnet, and the application reaches it over a managed peering or private-endpoint connection. There's no SSH tunnel because there's no public path to tunnel from; the network is the boundary.

**AWS VPC peering / Transit Gateway.** Application VPC routes to the database VPC's CIDR; the security group permits the application's. The RDS endpoint resolves to a private IP within the VPC. `DATABASE_URL=postgres://…@<rds-endpoint>.rds.amazonaws.com:5432/app` works as-is.

**AWS PrivateLink (cross-account).** The database account exposes a VPC Endpoint Service; the application account creates an Interface Endpoint that resolves a private DNS name. IAM auth still works.

**GCP Private Service Connect.** PSC endpoint pointing at the Cloud SQL instance; local DNS resolves the instance hostname privately. Cloud SQL Auth Proxy still works on top, and is the more common shape.

**Azure Private Endpoint.** Same shape; Azure Database for PostgreSQL exposes a private endpoint, the VNet resolves it via Azure-provided DNS.

In every case forge doesn't know. The connection string points at a hostname that happens to resolve to a private IP; the driver opens a TCP socket; forge talks to the driver. The security guarantee is the network: no path from the internet to the database, so the password is "second factor" against an attacker who's already inside the VPC.

The mistake to avoid is "private VPC means I can skip TLS". An attacker who compromises one node in the VPC can sniff cleartext traffic between others. `sslmode=verify-full` regardless of network.

---

## Least-privilege roles

This is covered in detail in [SECURITY.md → Database user permissions](./SECURITY.md#database-user-permissions); the auth-shaped summary:

| Role           | Connection string consumer       | Rotation cadence          |
|----------------|----------------------------------|---------------------------|
| `forge_owner`  | CI runner for `forge push`       | Per-developer, on revocation |
| `forge_writer` | The HTTP API process             | Per quarter / per IAM TTL  |
| `forge_reader` | Analytics, read replicas, BI     | Per quarter                |

The auth-relevant point: **each role has its own credential**. No shared `DATABASE_URL` for both the API and the migration runner; the API's `.env` has `forge_writer`'s URL and nothing else. The owner credential lives in the CI's secret store, exposed only to the `migrate` job.

IAM composes — each role gets its own IAM principal, and the `rds-db:connect` policy scopes which roles it can authenticate as. The blast radius of a leaked credential is exactly the role it can connect as.

A per-service role is the right shape past ~3 services. `forge_writer_api`, `forge_writer_worker`, `forge_writer_admin`. The audit log records `current_user`, so per-service attribution comes free on every mutation.

---

## Secret storage

The hierarchy, worst to best:

1. **Hard-coded in source** — never. Found in 12% of breaches.
2. **`.env` file committed to git** — never. The next step on the same path.
3. **`.env` file on disk, in `.gitignore`** — local dev only. Production: no.
4. **Environment variable, set by the process supervisor** — the floor for production. Visible to anything with `/proc/<pid>/environ` access, but invisible to the source code and to crash reports if your error handler is careful.
5. **Secret manager fetched at boot** — AWS Secrets Manager, GCP Secret Manager, Azure Key Vault, HashiCorp Vault, Doppler. The secret never lives on disk; it's read into memory at boot and used to construct the pool. Rotation rewrites the secret without redeploying the application; the `password: async () => …` shape from earlier picks up the new value on the next connect.
6. **Secret manager fetched per-connect** — same shape as 5, but the fetch happens on every new pool connection rather than once at boot. Costs a secret-manager call per connect (5–50 ms); pays off because rotation doesn't require any application-side reconnect logic.

The right answer for most teams is 5, with 6 when the rotation cadence is short (IAM tokens, certificate-based) and 4 acceptable for short-lived development.

### Doppler

`doppler run -- node dist/index.js` fetches the project's secrets and injects them; the application reads `process.env.DATABASE_URL` like normal. Rotation rewrites the value in Doppler; the next deploy picks it up. No in-process refresh.

### HashiCorp Vault

**Static secrets** are KV entries; the application fetches them at boot, same shape as Doppler. **Dynamic secrets** are minted on demand — Vault calls the database's `CREATE USER` API, returns a freshly-minted credential with a TTL (15 minutes to 24 hours), and revokes on TTL expiry.

```ts
import vault from 'node-vault';
import { Pool } from 'pg';
import { createDb, pgDriver } from 'forge-orm';

const client = vault({ endpoint: process.env.VAULT_ADDR!, token: process.env.VAULT_TOKEN! });

async function getCredentials() {
  const r = await client.read('database/creds/forge-writer-role');
  return { username: r.data.username, password: r.data.password };
}

const pool = new Pool({
  host:     process.env.PGHOST,
  database: 'app',
  user:     async () => (await getCredentials()).username,
  password: async () => (await getCredentials()).password,
  max:      8,
});

export const db = await createDb({ schema, driver: pgDriver(pool) });
```

Dynamic secrets are the strongest shape — the credential lives only as long as the lease, and Vault revokes on the database side when it expires. The cost is integration complexity (Vault needs database admin to mint roles) and the failure mode of a Vault outage taking database access down with it. Most teams run static secrets with quarterly rotation; the teams running dynamic are running them as part of a Vault-everywhere posture.

### AWS Secrets Manager

```ts
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { Pool } from 'pg';
import { createDb, pgDriver } from 'forge-orm';

const sm = new SecretsManagerClient({ region: process.env.AWS_REGION });
let cached: { user: string; password: string; ts: number } | null = null;
const TTL_MS = 5 * 60_000;

async function getCreds() {
  if (cached && Date.now() - cached.ts < TTL_MS) return cached;
  const r = await sm.send(new GetSecretValueCommand({ SecretId: 'forge/db/writer' }));
  const parsed = JSON.parse(r.SecretString!);
  cached = { user: parsed.username, password: parsed.password, ts: Date.now() };
  return cached;
}

const pool = new Pool({
  host:     process.env.PGHOST,
  database: 'app',
  user:     async () => (await getCreds()).user,
  password: async () => (await getCreds()).password,
  max:      8,
});
```

Secrets Manager supports auto-rotation via Lambda — every 30/60/90 days, a Lambda re-mints the password, updates the database, and writes the new value to the secret. The application's `password` provider picks it up on the next connect.

### Environment variables — the last-resort shape

When you're shipping into an environment with no secret manager — a customer's air-gapped network, a hobby project on a VPS — env vars are the bottom of acceptable:

```sh
# systemd unit file
[Service]
EnvironmentFile=/etc/forge/api.env
ExecStart=/usr/local/bin/forge-api
```

```
# /etc/forge/api.env — mode 0600, owned by the api user
DATABASE_URL=postgres://forge_writer:hunter2@db.internal:5432/app?sslmode=verify-full
```

Risks: the env file is on disk (mitigate with disk encryption); env vars are visible to `ptrace` (mitigate with user separation); rotation requires `systemctl restart` (mitigate with an LB drain window). Acceptable for small-scale; not past a certain organisational size, at which point you have a secret manager.

---

## Connection-string injection

The credential travels into the application at runtime, never baked into the image. The image is a build artifact distributed across environments; the secret is environment-specific. Mixing them produces images with prod credentials in their config — the leak class that breaches dev environments to harvest prod data.

The cardinal rules:

1. **`DATABASE_URL` is set at deploy time, not build time.** No `--build-arg`; the build doesn't know which environment runs the image. `docker run -e DATABASE_URL=…` (or its k8s/ECS/Cloud Run equivalent) is the only place it's set.
2. **The Dockerfile has no `ENV DATABASE_URL` line.** Even an empty default is a footgun — a future change "for tests" lands in production.
3. **The CI image has no `DATABASE_URL` baked into the artifact.** Tests get a per-job DB and `DATABASE_URL` from the CI secret store.
4. **`docker history --no-trunc forge-api:1.2.3` produces no line referencing a connection string.** If it does, the URL was passed as `--build-arg` or `RUN`-spliced; rebuild without it.

The Kubernetes shape:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata: { name: forge-api }
spec:
  template:
    spec:
      containers:
        - name: api
          image: forge-api:1.2.3
          env:
            - name: DATABASE_URL
              valueFrom:
                secretKeyRef: { name: forge-db-writer, key: url }
            - name: FORGE_KEK_BASE64
              valueFrom:
                secretKeyRef: { name: forge-kek, key: kek }
```

The `Secret` is provisioned by an out-of-band shape — sealed-secrets, external-secrets, Vault sidecar — pulling from the cluster-external secret store. etcd holds it in encrypted form (KMS encryption at rest is the default on GKE/EKS/AKS).

---

## Auditing who connected

forge doesn't see the connection; the database does. Connection logs live in `pg_stat_activity` (Postgres), the audit log (RDS / Cloud SQL `pgaudit`), `performance_schema.threads` (MySQL), and `mongod.log` (Mongo). The forge-relevant note: every connection's `application_name` (Postgres) or `program_name` (MySQL) is settable on the connection string, and forge passes it through.

```ts
import { Pool } from 'pg';
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  application_name: process.env.SERVICE_NAME ?? 'forge-api',
});
```

`pg_stat_activity` then shows `application_name = 'forge-api'` for every connection; the audit log carries it through. Encoding the deploy SHA — `forge-api:1.2.3+abc1234` — lets a forensic query correlate a row mutation with the deploy that did it.

The application-side audit log (per [AUDIT-LOG.md](./AUDIT-LOG.md)) covers *row-level* attribution. The connection-level audit covers *socket-level* attribution: which service authenticated, from which IP, at which TLS version, presenting which certificate. Both are useful; they answer different questions.

For HIPAA, PCI, and SOC 2 with engaged auditors, ship the connection log into the SIEM alongside the application audit log, with the deploy SHA as the join key. A compromised credential is then traceable from "outbound login from suspicious IP" to "rows touched by that session" without piecing it together by hand.

---

## MongoDB Atlas specifics

Atlas supports three authentication mechanisms for production workloads; the connection-string shape differs across them.

### SCRAM-SHA-256 (the default)

```
mongodb+srv://forge_writer:password@cluster.abcde.mongodb.net/app?authSource=admin
```

Credentials are validated against Atlas's internal user store. Rotation rewrites the password in the Atlas UI or via API; the application's secret manager picks it up.

### X.509 client certificates

The mTLS shape for Mongo. Atlas signs client certs against its own CA; you upload the public cert through the UI or API, then connect with the matching private key:

```ts
import { MongoClient } from 'mongodb';
import { createDb, mongoDriver } from 'forge-orm';
import { readFileSync } from 'node:fs';

const client = new MongoClient(
  'mongodb+srv://cluster.abcde.mongodb.net/app',
  {
    authMechanism: 'MONGODB-X509',
    authSource:    '$external',
    tls:           true,
    tlsCertificateKeyFile: '/etc/ssl/forge/mongo-client.pem',
  },
);
await client.connect();

export const db = await createDb({ schema, driver: mongoDriver(client) });
```

The CN becomes the user identity inside Mongo; database-level grants attach to that identity (`db.getSiblingDB('$external').runCommand({ createUser: 'CN=forge-api-prod,O=Forge', roles: […] })`).

### AWS IAM authentication

Atlas integrates with AWS IAM via the `MONGODB-AWS` mechanism. The application uses its IAM role credentials to authenticate to the Mongo cluster:

```ts
const client = new MongoClient(
  'mongodb+srv://cluster.abcde.mongodb.net/app?authSource=$external&authMechanism=MONGODB-AWS',
);
```

The driver uses the AWS SDK credential chain — instance metadata, env vars, profile — to sign the handshake. No password lives in the application's environment. The Mongo user has to be created with `$external` auth; the username is the IAM principal ARN.

### Connection-string special characters

Atlas's `mongodb+srv://` resolver expects the host portion to be a single hostname (the SRV record fans out to cluster nodes). Same URL-encoding rule as everywhere else. A typo in `&tls=true&authSource=admin&retryWrites=true&w=majority` produces a confusing "auth failed" rather than a clean "wrong query string" error.

---

## MSSQL — SQL Server, Windows, Azure AD

SQL Server has three authentication modes; pick one explicitly because the defaults are inconsistent across the `tedious`, `mssql`, and `node-mssql-prisma` clients.

**SQL Server Authentication.** Username/password validated against `sys.sql_logins`. The connection string shape:

```ts
import sql from 'mssql';
const pool = await sql.connect({
  server:   'sqlsrv.internal',
  database: 'app',
  authentication: {
    type: 'default',
    options: { userName: 'forge_writer', password: process.env.MSSQL_PASSWORD },
  },
  options: { encrypt: true, trustServerCertificate: false },
});
```

`encrypt: true` is on by default in `mssql` 9+; `trustServerCertificate: false` is what makes it non-bypassable in production. Set both explicitly.

**Windows Authentication / Integrated Security.** The connection uses the OS-level Kerberos / NTLM identity of the process. Right for on-prem deployments inside an Active Directory; wrong for cloud-native, where containers don't have an AD identity.

```ts
const pool = await sql.connect({
  server: 'sqlsrv.internal',
  database: 'app',
  authentication: { type: 'ntlm', options: { domain: 'CORP', userName: 'svc_forge', password: '…' } },
});
```

The `ntlm` mode passes credentials explicitly; the implicit Kerberos shape requires `tedious-msi-auth` or `kerberos` Node bindings, both of which are operationally heavy. Most cloud deployments shouldn't reach for this.

**Azure AD authentication.** For Azure SQL Database and Azure SQL Managed Instance, AAD-issued tokens are the right shape — same pattern as the Postgres AAD case above:

```ts
import { DefaultAzureCredential } from '@azure/identity';
import sql from 'mssql';

const credential = new DefaultAzureCredential();
const tokenResponse = await credential.getToken('https://database.windows.net/.default');

const pool = await sql.connect({
  server: 'sqlsrv.database.windows.net',
  database: 'app',
  authentication: {
    type: 'azure-active-directory-access-token',
    options: { token: tokenResponse.token },
  },
  options: { encrypt: true },
});
```

The token expires; `mssql`'s pool doesn't auto-refresh. Wrap pool construction in a function that re-mints, and replace the pool when the previous one hits auth failures — the same swap pattern from [Client certificate / mTLS](#client-certificate--mtls).

---

## Browser sqlite-wasm

The browser driver ([BROWSER.md](./BROWSER.md)) has no database authentication. The database is a file on the user's machine — OPFS, IndexedDB, in-memory — and the OS file-system permissions are the access control. forge opens it; there is no credential to present.

A feature, not a gap. Only the user's tab can read its own OPFS storage; there is no network to authenticate against. The auth question reduces to page-load auth — is the user logged into the application that loaded the page — which lives above forge.

The encryption-at-rest question is different ([SECURITY.md → Browser context](./SECURITY.md#browser-context--csp-trusted-types-isolation)). When the user is the operator and the threat is "another user of the same device", derive an SQLCipher key from the user's passphrase and rotate on session changes. Same operational vocabulary, no server to authenticate to.

If you find yourself wanting to "authenticate the browser SQLite database to a server", the architecture has gone sideways. Sync to a server is a separate problem with its own auth (the application's `/v1/auth` session token); the server-side data lives in a server-side database with one of the auth shapes above.

---

## Common gotchas

The footguns that produce "the password I just rotated doesn't work" tickets.

**Password with special characters not URL-encoded.** A password ending in `&` or containing `/` breaks the URL parser silently — the driver reads the password truncated at the offending character, and the database returns "password authentication failed". Fix: universal URL-encoding or alphanumeric-only generation. See [Password complexity and the URL encoding trap](#password-complexity-and-the-url-encoding-trap).

**IAM token expiry mid-connection.** The token authenticates the handshake; once open, the session lives until the socket closes regardless of token expiry. The confusing failure: a morning connection works all day, but a *new* afternoon connection fails because the application cached the token. Fix: `password: async () => signer.getAuthToken()` — let the SDK cache, never cache in a module-level variable.

**Connection pool eviction killing warm IAM connections.** `pg.Pool`'s default `idleTimeoutMillis: 10_000` evicts after 10 s of idle; under bursty IAM traffic every cold path mints a token. Fix: `idleTimeoutMillis: 0` plus a healthy `min`. See [POOLING.md](./POOLING.md#per-runtime-patterns).

**TLS configured on the URL but not the pool.** `?sslmode=require` in the URL plus `ssl: false` in the pool's literal config: the pool wins. The driver opens plaintext, the password goes over the wire in clear, the URL setting is silently ignored. Pick one — and the pool config is the more reliable surface.

**Rotated password, in-flight connections still using old.** Most database engines invalidate the *credential check*, not the *open session*. After `ALTER USER … PASSWORD 'new'`, existing connections keep serving queries; new ones require the new password. If the secret manager still has the old value, new connections fail while old ones succeed — "intermittent auth errors". Fix: rotate the secret *before* changing the database password, then change, then drain old connections.

**`pg_hba.conf` not reloaded.** Doesn't take effect until `SELECT pg_reload_conf()` or a server restart. Connection-string changes that "should work" but don't after a host-based-auth tweak are almost always this.

**Certificate clock skew.** `notBefore` is checked against the database server's wall clock. A freshly-minted cert with `notBefore = now()` fails if the application server's clock is 30 s ahead — the database sees not-yet-valid. Fix: set `notBefore` 5 minutes in the past at signing time. `cert-manager` and Vault PKI default to this; hand-rolled `openssl` doesn't.

**Secret manager rate limits during fleet roll.** A 200-replica fleet booting simultaneously hits AWS Secrets Manager with 200 concurrent reads. The 700/s per-account default is manageable, but a noisy neighbour can throw `ThrottlingException`. Fix: exponential backoff plus a small jitter before the boot fetch.

**Forgotten test credentials in production.** A long-lived test credential against a shared instance is a prod-write leak waiting to happen. Tests should run against per-job ephemeral databases with credentials that don't outlive the job.

---

## Worked examples

### Worked example A — Lambda + RDS Proxy + IAM token

The architecture: AWS Lambda function (Node 20 runtime), RDS Proxy in front of Aurora PostgreSQL, IAM authentication. The Lambda's execution role has `rds-db:connect` on the proxy ARN; no password lives anywhere.

```ts
// src/handler.ts
import { Pool } from 'pg';
import { Signer } from '@aws-sdk/rds-signer';
import { createDb, pgDriver } from 'forge-orm';
import { schema } from './schema';

// Module-scope so the pool survives across warm invocations.
const signer = new Signer({
  region:   process.env.AWS_REGION!,
  hostname: process.env.RDS_PROXY_HOST!,   // proxy hostname, not the cluster
  port:     5432,
  username: 'forge_writer',
});

const pool = new Pool({
  host:     process.env.RDS_PROXY_HOST!,
  port:     5432,
  user:     'forge_writer',
  database: 'app',
  password: () => signer.getAuthToken(),
  ssl: {
    rejectUnauthorized: true,
    // The RDS global CA bundle, distributed with the deploy.
    ca: require('fs').readFileSync(require('path').join(__dirname, 'rds-global-bundle.pem')),
  },
  // Lambda — keep the pool small. RDS Proxy multiplexes across Lambdas.
  max: 1,
  idleTimeoutMillis: 0,
  // Critical: 60-second app_name lets RDS Proxy attribute concurrent invocations.
  application_name: `lambda-${process.env.AWS_LAMBDA_FUNCTION_NAME}`,
});

const db = await createDb({ schema, driver: pgDriver(pool) });

export const handler = async (event: APIGatewayEvent) => {
  const orders = await db.order.findMany({
    where: { user_id: event.requestContext.authorizer.userId },
    take:  20,
  });
  return { statusCode: 200, body: JSON.stringify(orders) };
};
```

Three design choices:

1. **`max: 1`, module-scope pool.** Lambda runs one invocation per container at a time. A pool of size 1 reuses across warm invocations; RDS Proxy multiplexes the physical connection across containers, so the database sees the proxy's pool size, not 1000 connections per concurrent Lambda.
2. **IAM token via the proxy.** The Lambda's execution role mints a token authenticated against the proxy, not the cluster. The proxy holds long-lived database credentials and validates IAM tokens for the Lambdas. Blast radius of a Lambda role compromise is bounded by the proxy's RBAC.
3. **`idleTimeoutMillis: 0`.** The container can live 15+ minutes between invocations. Eviction means re-minting the token and re-handshaking on the next invocation, adding 50–80 ms. Keep the connection warm; let the container's lifecycle reap it.

The IAM policy on the Lambda's execution role:

```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Action": "rds-db:connect",
    "Resource": "arn:aws:rds-db:us-east-1:123456789012:dbuser:prx-abc/forge_writer"
  }]
}
```

### Worked example B — Kubernetes pod + Vault sidecar

The architecture: Kubernetes deployment running an HTTP API, Vault sidecar injecting database credentials via a tmpfs-mounted file, dynamic Postgres credentials with a 1-hour TTL.

```yaml
apiVersion: apps/v1
kind: Deployment
metadata: { name: forge-api }
spec:
  replicas: 4
  template:
    metadata:
      annotations:
        vault.hashicorp.com/agent-inject: 'true'
        vault.hashicorp.com/agent-inject-secret-db: 'database/creds/forge-writer-role'
        vault.hashicorp.com/agent-inject-template-db: |
          {{- with secret "database/creds/forge-writer-role" -}}
          {
            "username": "{{ .Data.username }}",
            "password": "{{ .Data.password }}"
          }
          {{- end -}}
        vault.hashicorp.com/role: 'forge-api'
    spec:
      serviceAccountName: forge-api
      containers:
        - name: api
          image: forge-api:1.2.3
          env:
            - { name: PGHOST,     value: 'db.internal' }
            - { name: PGDATABASE, value: 'app' }
            - { name: VAULT_CREDS_PATH, value: '/vault/secrets/db' }
```

```ts
// src/db.ts
import { Pool } from 'pg';
import { createDb, pgDriver } from 'forge-orm';
import { readFile, watch } from 'node:fs/promises';
import { schema } from './schema';

async function readCreds() {
  const raw = await readFile(process.env.VAULT_CREDS_PATH!, 'utf8');
  return JSON.parse(raw) as { username: string; password: string };
}

const pool = new Pool({
  host:     process.env.PGHOST,
  database: process.env.PGDATABASE,
  user:     async () => (await readCreds()).username,
  password: async () => (await readCreds()).password,
  ssl:      { rejectUnauthorized: true },
  max:      8,
  idleTimeoutMillis: 30_000,
  application_name: `forge-api:${process.env.HOSTNAME}`,
});

export const db = await createDb({ schema, driver: pgDriver(pool) });

// Vault Agent renews the credential at 2/3 of the lease. When it rewrites the
// file, drain the old pool's connections and let new connections pick up the
// new credentials.
(async () => {
  for await (const _evt of (async function* () {
    for await (const evt of watch(process.env.VAULT_CREDS_PATH!)) yield evt;
  })()) {
    // The pool's `user` / `password` providers re-read on next connect;
    // existing connections are still authenticated under the old credentials
    // until they idle out (30s) or are explicitly drained.
    // For most teams the natural idle eviction is enough.
  }
})();
```

The Vault Agent's role maps the Kubernetes service account to a policy authorising reads from `database/creds/forge-writer-role`. Vault calls Postgres's `CREATE USER` API to mint a role with `forge_writer` group membership and a 1-hour TTL. On expiry, Vault calls `DROP USER`; existing connections see "FATAL: role does not exist" and reconnect with new credentials.

Three moving parts (Vault, Vault Agent, Postgres) all have to be healthy. Most teams running this shape are running Vault everywhere; the rest run static secrets from Vault's KV engine, treating Vault as a more-rigorous Secrets Manager.

### Worked example C — Mongo Atlas + X.509

The architecture: a long-running Node service connecting to MongoDB Atlas with X.509 client certificates. The certs are issued by Atlas's CA; the service identity is encoded in the CN.

```ts
// src/db.ts
import { MongoClient } from 'mongodb';
import { createDb, mongoDriver } from 'forge-orm';
import { schema } from './schema';

const client = new MongoClient(
  // The SRV connection string. No password — auth is X.509.
  process.env.MONGO_URL!,
  {
    authMechanism: 'MONGODB-X509',
    authSource:    '$external',
    tls:           true,
    // The cert and key are concatenated into a single PEM file by the secret manager.
    tlsCertificateKeyFile: '/etc/ssl/forge/mongo-client.pem',
    // Atlas's CA is trusted automatically; this is only needed for self-hosted Mongo.
    // tlsCAFile: '/etc/ssl/forge/mongo-ca.pem',
    minPoolSize:    4,
    maxPoolSize:    16,
    maxIdleTimeMS:  60_000,
    serverSelectionTimeoutMS: 5_000,
    appName: `forge-api:${process.env.HOSTNAME}`,
  },
);

await client.connect();

export const db = await createDb({ schema, driver: mongoDriver(client) });
```

Atlas-side setup:

1. **Create the X.509 user.** "Database Access" → "Add New Database User" → "Authentication Method: X.509" → CN: forge-api-prod. Grant the role.
2. **Generate the client certificate.** Atlas's managed CA, or an externally-signed cert. "Network Access" → "X.509 Certificates" → "Generate Certificate"; the resulting PEM is the concatenated cert+key.
3. **Distribute the PEM.** Lives in the secret store; the deploy pipeline mounts it at `/etc/ssl/forge/mongo-client.pem` with mode 0400.
4. **Atlas network access.** Application's IP CIDR, or PrivateLink endpoint.

Rotation: Atlas-managed certs are good for 1 year; rotate at 9 months. Mint the new cert, distribute to the secret manager, drain old connections at the next deploy. No in-process renewal — Atlas connections are long-lived and cert auth is at handshake.

X.509 composes with field-level encryption ([SECURITY.md → Field-level encryption](./SECURITY.md#field-level-encryption)) without conflict: the certificate authenticates the connection; the KEK encrypts the data; both rotate independently.

---

## Cross-references

- [SECURITY.md](./SECURITY.md) — the application-side threat model, RLS, field-level encryption, audit logging. The companion read for "what to do with the connection once you've authenticated it".
- [ENCRYPTION.md](./ENCRYPTION.md) — at-rest and in-transit encryption per dialect. Auth and encryption compose; this file covers who you are, that one covers what's protected.
- [POOLING.md](./POOLING.md) — the driver-wrapper shape that hosts the `password` provider, per-runtime sizing, the SIGTERM drain pattern that's reused here for cert rotation.
- [DRIVERS.md](./DRIVERS.md) — the driver port that forge talks to, the two-call shape (URL vs driver), per-dialect driver options.
- [AUDIT-LOG.md](./AUDIT-LOG.md) — the row-level audit log built on `$on('query')`. Composes with the connection-level audit covered here.
- [DEPLOYMENT.md](./DEPLOYMENT.md) — the deploy-pipeline shape that injects `DATABASE_URL` at runtime, the secret-manager integration points, the rolling-restart pattern for password rotation.
- [MULTI-TENANT.md](./MULTI-TENANT.md) — the per-tenant role shape that composes with `SET ROLE` after the connection opens.
- [BROWSER.md](./BROWSER.md) — the browser sqlite-wasm path, where DB auth doesn't apply and the file-system permission model takes over.
