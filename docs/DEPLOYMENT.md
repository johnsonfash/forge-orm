# Deployment

forge-orm owns three deployment-time concerns: applying schema changes (push), gating against drift (diff), and gating against missing capabilities (doctor). Everything else — your app, your secrets, your platform — is yours. This page covers the patterns that compose these primitives into safe production rollouts.

Companion to [MIGRATIONS.md](./MIGRATIONS.md) (the deep reference for every CLI command), [ROLLBACK.md](./ROLLBACK.md) (the inverse path), [DOCTOR.md](./DOCTOR.md) (capability gate), and [BACKEND.md](./BACKEND.md) (server-side wiring, pool sizing, replicas). This file sits on top of all four: it doesn't redocument the commands, it shows how to sequence them on real platforms without taking the database down.

## Contents

* [The deployment surface forge owns](#the-deployment-surface-forge-owns)
* [One schema, many stages](#one-schema-many-stages)
* [Pre-deploy checklist](#pre-deploy-checklist)
* [Zero-downtime change patterns](#zero-downtime-change-patterns)
  * [Additive-only first](#additive-only-first)
  * [Backfill before flip](#backfill-before-flip)
  * [Online index creation](#online-index-creation)
* [Blue/green database](#bluegreen-database)
* [Rolling restart pattern](#rolling-restart-pattern)
* [Containerised deploys](#containerised-deploys)
* [Serverless deploys (Lambda, Workers, Vercel)](#serverless-deploys-lambda-workers-vercel)
* [Secret rotation](#secret-rotation)
* [Connection pool sizing per replica](#connection-pool-sizing-per-replica)
* [Multi-region deploys](#multi-region-deploys)
* [Observability hooks at deploy time](#observability-hooks-at-deploy-time)
* [Rollback path](#rollback-path)
* [Worked example — Vercel + Neon](#worked-example--vercel--neon)
* [Worked example — Fly.io + Postgres](#worked-example--flyio--postgres)
* [Worked example — AWS ECS + RDS](#worked-example--aws-ecs--rds)

---

## The deployment surface forge owns

There are only three CLI commands that touch the live database at deploy time, plus one runtime primitive for environments without a CLI:

| Surface | What it does | When it runs |
|---|---|---|
| `forge push` | Idempotent additive sync — schema → live DB. Creates new tables, columns, indexes, constraints. Never drops. | Pre-deploy, deploy step, or app start. |
| `forge diff --check` | Read-only drift gate. Exits 3 if the live DB differs from the schema. | CI on every PR; CD as a pre-deploy guard. |
| `forge doctor` | Capability gate. Checks driver versions, schema lint, live DB extension availability. | Once per environment; in CI for new deploys. |
| `db.$migrate()` | Runtime equivalent of `forge push` for the browser / mobile / Tauri. | At app boot when there is no CLI. |

The boundary is sharp. forge does not:

* Build your container.
* Push code to your hosting platform.
* Manage your secrets store.
* Run your data backfills.
* Decide when to flip a feature flag.

It owns the schema's state and the gate that says "the database matches what the code expects". Everything in this document is patterns for plugging those three commands into a wider deploy pipeline without inventing new forge concepts.

The corollary: every recommendation here works the same on Vercel, Fly.io, AWS ECS, Kubernetes, bare metal, or a single VPS. The CI step that runs `forge push` doesn't care where the next step deploys the app. Pick the worked example that matches your platform and translate the others if you switch.

---

## One schema, many stages

forge does not ship a stages config. The pattern is plain `DATABASE_URL` per stage, loaded from your platform's secret store, and the same `src/schema.ts` is pushed against all of them.

```
src/schema.ts                  ← the only schema file in version control
.env.local                     ← local dev URL (gitignored)
secrets in CI per environment  ← STAGING_DATABASE_URL, PROD_DATABASE_URL
```

The CLI reads `DATABASE_URL` from the process environment. There is no `--url` flag (deliberately — it would let a stray copy-paste push prod's schema into staging). Switch stages by exporting a different `DATABASE_URL`:

```sh
DATABASE_URL=$LOCAL_URL    npx forge push       # local
DATABASE_URL=$STAGING_URL  npx forge push       # staging
DATABASE_URL=$PROD_URL     npx forge push       # prod
```

In CI, the URL lives in a protected environment (GitHub Actions `environment:`, Vercel project env vars, Fly secrets) and the job's container picks it up at start.

### Why the same schema file

The "production schema" is whatever's at the deployed Git SHA. The "staging schema" is whatever's at the same SHA (or the PR's SHA). They diverge only when a deploy has landed on one stage but not the other — at which point `forge diff --check` against the trailing stage fires.

This is the property that makes the push model work: there is one source of truth (the schema file) and one verification path (the diff). You don't reconcile a `prod-schema.sql` against a `staging-schema.sql` — you reconcile both stages against the schema file at HEAD.

### What goes in `.env` and what doesn't

* `DATABASE_URL` — per stage, secret. Never committed.
* `FORGE_DIFF_IGNORE` — per stage, sometimes. Engine-managed tables (Atlas, Hasura, Supabase) differ per environment; bake the regex into the stage's env var so every `forge diff` job picks it up automatically. See [MIGRATIONS.md](./MIGRATIONS.md#--ignore-patterns).
* `FORGE_SCHEMA_PATH` — only when the schema lives somewhere the [resolution cascade](../README.md#pointing-the-cli-at-your-schema) can't find it (monorepo subpackage running from the repo root).

Everything else — pool sizes, replica URLs, observability sinks — is app-side config and lives wherever your app reads config from.

### Secret storage per stage

| Platform | Where it lives | How forge reads it |
|---|---|---|
| GitHub Actions | Repo / org secrets, scoped to `environment:` | Injected into the job's env |
| Vercel | Project env vars, scoped to preview/prod | `process.env.DATABASE_URL` at build/run |
| Fly.io | `fly secrets set DATABASE_URL=…` | Injected at VM start |
| AWS ECS | Secrets Manager → task definition `secrets:` block | Loaded by ECS agent into the container's env |
| Kubernetes | `Secret` → pod `envFrom.secretRef` | Standard env var in the container |
| Doppler / Infisical / 1Password Connect | Sidecar injects at boot | Same env var the rest of the app reads |

The rule across all of them: the secret is set once per stage, in the platform's native secret store, and rotated through the platform's rotation API (covered in [Secret rotation](#secret-rotation)). forge has no opinion on which store you use.

---

## Pre-deploy checklist

Run these three before any production push. They're cheap, fast, and catch the failure modes that turn into 3 AM pages.

### 1. `forge diff --check`

```sh
DATABASE_URL=$STAGING_URL npx forge diff --check
DATABASE_URL=$PROD_URL    npx forge diff --check
```

Exit 0 means the live database already matches the schema you're about to deploy — `forge push` will be a no-op. Exit 3 means there's drift; read the report and decide:

* **Drift the diff would resolve with `forge push`** (missing tables/columns/indexes) → expected; the next step in your CD will apply it.
* **Drift the diff would resolve with `forge diff apply`** (extra columns, extra tables) → block the deploy. Review what's about to be dropped before you let CI do it. See [MIGRATIONS.md](./MIGRATIONS.md#forge-diff-apply).
* **Engine-managed objects** (Atlas, Hasura, Supabase auth schema) → add to `FORGE_DIFF_IGNORE` and re-run. See [MIGRATIONS.md](./MIGRATIONS.md#--ignore-patterns).

Pin the diff job's failure condition on `exit_code == 3` so "couldn't reach the DB" (exit 1) doesn't get mistaken for drift.

### 2. `forge doctor`

```sh
DATABASE_URL=$PROD_URL npx forge doctor
```

Doctor probes whether the driver is installed, whether `DATABASE_URL` parses, whether the schema lints, and whether the live DB has the extensions the schema needs (PostGIS, pgvector, pg_trgm, btree_gin). The "Action items" section at the end is copy-pasteable — if it says `npm install pg`, your CI doesn't have the driver; if it says `CREATE EXTENSION postgis;`, the push will fail until the role with `CREATE EXTENSION` rights runs that statement.

Run doctor against staging *and* prod separately, especially the first time you deploy a feature that needs a new capability. Staging may have PostGIS because someone hand-installed it; prod often doesn't.

See [DOCTOR.md](./DOCTOR.md) for the full surface.

### 3. Tests green

This is yours, not forge's. The pattern that pairs cleanly with push-style migrations:

* Unit tests run against `sqlite::memory:` via `db.$migrate()` — fast, no external service.
* Integration tests run against a real Postgres via testcontainers — catches dialect divergence (`ON CONFLICT`, JSON path syntax, partial indexes).
* A smoke test against staging after `forge push` runs.

The smoke test is what catches "the schema applied but the new endpoint 500s because a query doesn't compile". `forge push` doesn't validate query shapes against the new schema; only your tests do.

### Putting it together

```yaml
# .github/workflows/deploy.yml (excerpt)
- name: forge doctor
  run: npx forge doctor

- name: forge diff --check (staging)
  run: DATABASE_URL=${{ secrets.STAGING_DATABASE_URL }} npx forge diff --check
  continue-on-error: true   # surface but don't block — staging is allowed to drift mid-deploy

- name: Tests
  run: npm test

- name: forge push (staging)
  run: DATABASE_URL=${{ secrets.STAGING_DATABASE_URL }} npx forge push

- name: Smoke (staging)
  run: npm run smoke -- --base-url=$STAGING_APP_URL

- name: forge diff --check (prod)
  run: DATABASE_URL=${{ secrets.PROD_DATABASE_URL }} npx forge diff --check
  # exit 3 here means prod is behind — that's the deploy's job

- name: forge push (prod)
  run: DATABASE_URL=${{ secrets.PROD_DATABASE_URL }} npx forge push

- name: Deploy app
  run: ./scripts/deploy.sh
```

The order matters: schema before code. New columns must exist before the new container starts reading them. The next section covers when "schema before code" isn't enough, and you need the four-step blue/green pattern.

---

## Zero-downtime change patterns

The three classes of schema change, in order of how much care they need.

### Additive-only first

Adding a nullable column, adding a new table, adding a new index — these are safe to push at any time. Old app instances ignore the new shape; new app instances use it. The push is online on every dialect.

```ts
const Users = model('users', {
  id:               f.id(),
  email:            f.string().unique(),
  email_verified_at: f.dateTime().optional(),   // nullable — old rows pass
});
```

`forge push` emits `ALTER TABLE users ADD COLUMN email_verified_at TIMESTAMPTZ NULL` (or the dialect equivalent). The deploy ordering is:

1. `forge push` adds the column. Old app keeps running; column is empty.
2. New app deploys. Old pods drain, new pods start reading/writing the column.

If you can't tolerate a column being nullable forever — say, you want NOT NULL — the path is the [backfill-before-flip](#backfill-before-flip) pattern, not a single-step push.

### Backfill before flip

When a new column has to be NOT NULL with a meaningful value, the rollout takes four deploys:

1. **Add nullable** (`forge push`). New column is added. App ignores it.
2. **Deploy code that dual-writes** the new column on every create/update. Reads still come from the old column.
3. **Backfill** existing rows. Run a one-off `scripts/migrate/<date>-backfill.ts` — see [MIGRATIONS.md](./MIGRATIONS.md#data-migration-vs-ddl-migration). The pattern:
   ```ts
   await db.user
     .findManyStream({ where: { handle: null }, select: { id: true, username: true }, batchSize: 1000 })
     .forEach(async (batch) => {
       await db.$transaction(async (tx) => {
         for (const u of batch) {
           await tx.user.update({ where: { id: u.id }, data: { handle: u.username } });
         }
       });
     });
   ```
4. **Flip reads to the new column** + tighten the constraint. Update the schema to mark the column required + unique, deploy, then `forge push` adds the constraint.
5. **Drop the old column** via `forge diff apply` once every replica is on the new code path.

The principle: at every deploy boundary, both the old and new app code work against the current DB shape. No request sees a transient state where the column it expects doesn't exist or has a different name.

This is the same pattern as Stripe's column-additive migrations and GitHub's `gh-ost` workflow; it's not forge-specific. forge's contribution is that the diff between each step is small enough to review.

For the full schema-level walkthrough, see [Blue/green schema rollouts](./MIGRATIONS.md#bluegreen-schema-rollouts).

### Online index creation

Indexes block writes by default on most dialects. For tables larger than a few million rows, the locking is unacceptable. Each dialect has its own escape hatch:

**Postgres — `CREATE INDEX CONCURRENTLY`.** Builds the index without holding a write lock on the table. Takes longer; can fail and leave an `INVALID` index that needs cleanup. forge doesn't emit `CONCURRENTLY` from `forge push` because it can't run inside a transaction (Postgres restriction). Emit it yourself:

```ts
// scripts/migrate/20260624-add-events-idx.ts
import { createDb, raw } from 'forge-orm';
import { schema } from '../../src/schema';

const db = await createDb({ url: process.env.DATABASE_URL!, schema });
await db.$executeRaw(raw`CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_events_created_at ON events (created_at DESC)`);
await db.$disconnect();
```

Then add the matching `indexes: [...]` entry to the schema, run `forge push` — the diff sees the index already exists, skips it. The schema and the DB end up aligned, and the create happened online.

**MySQL 8 — `ALGORITHM=INPLACE, LOCK=NONE`.** Online DDL for most index types. forge's emitted `CREATE INDEX` is blocking by default; same escape hatch — emit it manually:

```ts
await db.$executeRaw(raw`
  ALTER TABLE events
  ADD INDEX idx_events_created_at (created_at),
  ALGORITHM=INPLACE, LOCK=NONE
`);
```

For older MySQL or schema changes that aren't INPLACE-compatible (some column-type changes, FULLTEXT on InnoDB before 5.6), `pt-online-schema-change` from Percona Toolkit copies the table in chunks behind a trigger. Treat that as out-of-band: run `pt-osc`, then re-run `forge push` to verify the diff is clean.

**SQLite.** Indexes lock the database file briefly. Acceptable for any practical table size. Skip the escape hatch.

**Mongo — `background: true` is the historical flag** (removed in 4.2 — index builds are now non-blocking on the primary by default). `db.collection.createIndex` runs against secondaries via the oplog. forge emits `createIndex` from `forge push`; on modern Mongo this is already online.

**MSSQL — `WITH (ONLINE = ON)`.** Same shape as MySQL — issue raw DDL with the flag, then `forge push` reconciles.

The pattern across all dialects: when a `forge push` would block writes for too long, issue the raw DDL yourself with the dialect's online-DDL flag, then let `forge push` see the index as already-present.

---

## Blue/green database

For changes too risky for in-place migration — a column type change on a 100M-row table, a sharding rework, an engine version upgrade — the safer path is a full database swap.

The shape:

1. **Clone prod to a new database (green).** Use the platform's snapshot/restore (RDS snapshot → restore, Fly's `fork`, Neon's branch, Atlas `mongorestore`).
2. **Apply the new schema to green.** Run `npx forge push` (and `forge diff apply` if you need destructive ops) against green's URL. Take as long as you want; green isn't serving traffic.
3. **Sync delta.** Set up logical replication from blue → green (PG `pg_logical`, MySQL binlog, Mongo change streams) and let it catch up. Track lag until it's under a few seconds.
4. **Cutover.** Stop app writes briefly (10-30 seconds), wait for replication lag to hit zero, point the app's `DATABASE_URL` at green, restart.
5. **Verify** with `forge diff --check` against the new URL. Run smoke tests. Watch error rate.
6. **Decommission blue** once green is proven over a few hours/days.

forge's role is small: it runs `push` and `diff` against whichever URL you point it at. The platform-specific tooling does the actual cloning and replication. The verification is forge: `forge diff --check` against green before the cutover guarantees the schema is what the new code expects.

When this is worth the operational cost:

* The change can't be expressed as a sequence of backward-compatible deploys (rare; usually it's a major engine upgrade).
* The downtime budget for in-place ALTER is zero, and even online-DDL flags take too long on the row count.
* You need to fall back fast — blue is still running, point `DATABASE_URL` back at it and the rollback is instant.

When it isn't:

* The change is additive. Just `forge push`.
* The change is a rename or a backfilled NOT NULL. Use the four-step pattern in [Backfill before flip](#backfill-before-flip).
* The team doesn't have a tested replication setup. Setting one up under pressure is worse than a planned maintenance window.

---

## Rolling restart pattern

In a Kubernetes rolling deploy, Fly.io rolling update, or ECS deployment, two versions of the app run side-by-side for the duration of the rollout — typically 1-10 minutes. Both versions must read and write the same database without producing errors.

The rule: **schema changes must precede or follow code changes by one release.**

| Direction | Sequence |
|---|---|
| Adding a column | `forge push` first, then deploy code that reads/writes it. |
| Dropping a column | Deploy code that stops reading/writing it first, then `forge diff apply` drops it. |
| Renaming a column | Four-step pattern. Never single-deploy. |
| Adding an index | `forge push` any time. Both versions tolerate. |
| Dropping an index | `forge diff apply` any time. Both versions tolerate (queries get slower without it; correctness is preserved). |
| Adding a NOT NULL constraint | `forge push` only after a backfill *and* a deploy that stops writing nulls. |
| Widening a type (varchar(50) → text) | `forge push` any time. Old code still writes valid values. |
| Narrowing a type | Code change first (stop writing oversize values), then `forge push`. |

The version overlap is the gotcha. If a deploy pipeline does:

```
1. forge push                  ← adds NOT NULL on column X
2. Deploy v2 code              ← writes column X correctly
3. v1 pods drain over 5 minutes
```

…then for those 5 minutes, v1 pods are still trying to write rows without column X, which fails the NOT NULL check. The fix is reversing the dependency:

```
1. forge push                  ← adds nullable column X
2. Deploy v2 code              ← writes column X
3. Wait for v1 to fully drain
4. Backfill any v1-written rows missing X
5. forge push                  ← tighten to NOT NULL
```

Five steps instead of three, but no v1 pod ever fails to write. This is the same logic as the four-step rename — at every deploy boundary, both the old and new app code work against the current DB shape.

---

## Containerised deploys

Three options for where `forge push` runs in a containerised pipeline. Pick by your platform's primitives.

### (a) Push as an init container

In Kubernetes:

```yaml
spec:
  template:
    spec:
      initContainers:
      - name: forge-push
        image: ghcr.io/org/myapp:${SHA}
        command: ['npx', 'forge', 'push']
        env:
        - name: DATABASE_URL
          valueFrom: { secretKeyRef: { name: db, key: url } }
      containers:
      - name: app
        image: ghcr.io/org/myapp:${SHA}
        # ...
```

Runs once per pod start, but `forge push` is idempotent and additive — re-running is a no-op (`applied 0, skipped 47`). The init container blocks the main container until the push completes; if the push fails, the pod doesn't come up, and the rollout halts on the rolling update's progress deadline.

The downside: every pod in the new replica set tries to push. They serialise on the PG advisory lock (`pg_advisory_xact_lock(0x6f6f7267, 0x65000001)`) or MySQL's `GET_LOCK('forge_migrate', 60)` — but you're spending N round-trips for one logical operation.

### (b) Push as a separate job

Run the push as a one-shot before the rolling update starts:

```yaml
apiVersion: batch/v1
kind: Job
metadata: { name: forge-push-${SHA} }
spec:
  template:
    spec:
      restartPolicy: Never
      containers:
      - name: forge-push
        image: ghcr.io/org/myapp:${SHA}
        command: ['npx', 'forge', 'push']
        env:
        - name: DATABASE_URL
          valueFrom: { secretKeyRef: { name: db, key: url } }
```

CD pipeline:

```sh
kubectl apply -f forge-push-job.yaml
kubectl wait --for=condition=complete --timeout=10m job/forge-push-${SHA}
kubectl rollout restart deployment/app
```

One push per release, clean separation. The rolling update only kicks off after the job completes successfully. This is the recommended shape for anything more than a single-pod deploy.

### (c) Push at app startup, with leader election

For platforms without first-class jobs (or for simplicity), let one pod run the push, the others wait. The advisory lock handles serialisation:

```ts
// src/boot.ts
import { db } from './db';

if (process.env.RUN_MIGRATIONS === 'true') {
  await db.$ping();
  // forge push is idempotent — even if multiple pods try, only one wins the lock.
  // The losers see an in-sync DB and exit cleanly. We invoke the same code as
  // the CLI by spawning a child process, or import the push entrypoint directly:
  const { runPush } = await import('forge-orm/scripts/push-core');
  await runPush({ schema: (await import('./schema')).default, url: process.env.DATABASE_URL! });
}
await startHttpServer();
```

Gate `RUN_MIGRATIONS=true` on a single deployment (e.g. a `migrations` deployment with `replicas: 1`) or on a single pod via Kubernetes' `podAffinity` + a deterministic ordinal. The advisory lock means two concurrent pushes are correct anyway, just wasteful.

---

## Serverless deploys (Lambda, Workers, Vercel)

Serverless changes two things about deployment.

### Schema apply runs in CI, not at runtime

A Lambda function can't shell out to `npx forge push`. A Vercel Edge Function can't, either. The schema apply has to happen before the function is invoked, which means it runs in CI:

```yaml
# Vercel build step → runs in their build environment, not in the Function
"buildCommand": "npx forge diff --check && next build"
```

```yaml
# GitHub Actions, before the Vercel deploy
- run: DATABASE_URL=$PROD_URL npx forge push
- run: vercel deploy --prod --token=$VERCEL_TOKEN
```

Run `forge push` in the GitHub Action that triggers the Vercel deploy, before Vercel's build runs. Use the platform's preview URL machinery to get a per-PR database (Neon branches, Vercel Postgres branches, PlanetScale dev branches) and run `forge push` against the preview DB on each PR.

### Warm pool considerations

Lambda execution contexts are reused — a function instance that started two minutes ago may still serve requests until the runtime evicts it. If you push a schema change that the new code expects and the old context is still warm, that context still has the old code. There's no way to invalidate it; you wait for natural rollover.

This is the same problem as the rolling restart, except the "rolling" can take 5-15 minutes on Lambda depending on traffic and provisioned concurrency. The principle holds: **schema changes must be backward-compatible with the previous deploy**. A NOT NULL added in the new deploy will break warm Lambdas from the previous deploy.

### Connection-pool sizing on serverless

One Lambda instance = one connection. Hundreds of instances = hundreds of connections. The DB's `max_connections` is the bottleneck. Two approaches:

* **PgBouncer in transaction mode** in front of Postgres. Lambda instances dial PgBouncer; PgBouncer multiplexes their queries across a small pool against the DB. Use `?prepare=false` on the connection string — prepared statements break transaction-mode pooling. Neon ships PgBouncer in the "pooler" endpoint; use it.
* **AWS RDS Proxy** does the same job for RDS-hosted Postgres / MySQL, with IAM integration.
* **Neon's serverless driver** (`@neondatabase/serverless`) uses Neon's HTTP/WS connection layer — no pooler needed, but it's Neon-specific. forge supports it via the `pgDriver` shim around a `Pool`-shaped object.

See [BACKEND.md](./BACKEND.md#connection-pooling-and-lifecycle) for the pool sizing math.

### Cold start and `createDb`

`createDb` is async — it dials the connection on first call. On a cold-started Lambda, that adds 50-200ms to the first request. The mitigation is **module-scope `createDb`**:

```ts
// db.ts
import { createDb } from 'forge-orm';
import { schema } from './schema';

export const dbPromise = createDb({ url: process.env.DATABASE_URL!, schema });
```

```ts
// handler.ts
import { dbPromise } from './db';
export async function handler(req, res) {
  const db = await dbPromise;
  // ...
}
```

The promise is created during init (which Lambda lets you do before the first request handler runs), so the actual `await` is a no-op on warm requests. Pair with PgBouncer / RDS Proxy so the per-instance "connection" is to the pooler, not directly to the DB.

---

## Secret rotation

The DB password rotation patterns. Pick by whether your platform supports IAM-token authentication.

### Static password rotation, no downtime

Most managed DBs (Postgres, MySQL, Mongo) support having two valid passwords briefly during rotation:

1. **Add a new password** (or a second user with the new password). On RDS, `ALTER USER … WITH PASSWORD …` immediately; on a managed Mongo, create a second user.
2. **Update the secret store** with the new password.
3. **Trigger a rolling restart.** New pods pick up the new password; old pods keep using the old one until they exit.
4. **Remove the old password** once every pod has cycled.

This is platform-specific in the details. The forge-side observation: a forge `db` handle opened with the old password keeps working until the underlying pool is closed. New pods get a fresh handle with the new password. No code change required — the `DATABASE_URL` is read from `process.env` at module load time, not per-request.

### IAM-token authentication

AWS RDS, Aurora, and CloudSQL all support short-lived IAM tokens instead of static passwords. The token expires every 15 minutes; the driver refreshes it from the IAM API.

```ts
import { Signer } from '@aws-sdk/rds-signer';
import { Pool } from 'pg';
import { createDb, pgDriver } from 'forge-orm';

const signer = new Signer({ hostname: 'mydb.cluster-xyz.us-east-1.rds.amazonaws.com', port: 5432, username: 'app' });

const pool = new Pool({
  host: 'mydb.cluster-xyz.us-east-1.rds.amazonaws.com',
  port: 5432,
  user: 'app',
  database: 'app',
  ssl: { rejectUnauthorized: false },
  password: async () => signer.getAuthToken(),    // pg supports async password
});
const db = await createDb({ driver: pgDriver(pool), schema });
```

`pg`'s async `password:` callback is called on every new connection, so the pool naturally picks up rotated tokens. forge sees only the `pgDriver(pool)` — it doesn't know or care about IAM.

For the `forge push` step in CI, use the AWS SDK to mint a token at the start of the job and pass it as `DATABASE_URL=postgres://app:${TOKEN}@…`. The token outlives the job (15 minutes is plenty); refreshing mid-job is unnecessary.

### Mongo connection-string rotation

Mongo's `mongodb+srv://` URLs have the credentials embedded. The pattern is the same as static-password rotation, but the `MongoClient` doesn't support per-connection password callbacks. A rotation is `mongo client.close()` + reopen — which means a rolling restart, no different from rotating `DATABASE_URL`.

---

## Connection pool sizing per replica

Detailed in [BACKEND.md](./BACKEND.md#connection-pooling-and-lifecycle); the deploy-time concern is fleet-wide. If you have 4 app replicas with `max: 10` each, that's 40 connections to the DB. Add a worker fleet of 4 with `max: 8` each, that's 32 more. Your Postgres `max_connections` is 100 by default — 72 used, 28 remaining for ad-hoc / migrations / monitoring.

Sizing rules of thumb:

| Component | Pool size | Notes |
|---|---|---|
| API replicas | `vCPUs × 2` per process | 4 cores → 8 connections |
| BullMQ workers | `concurrency` value | Worker concurrency caps active queries |
| Cron / one-off jobs | 2-4 | Short-lived; don't hoard |
| Migrations (`forge push`) | 1 | One connection, brief |
| Monitoring sidecars | 1-2 | Datadog, Prometheus exporters |

**Postgres ceiling:** Aurora Serverless v2 scales `max_connections` with ACU; managed RDS PG defaults to 100 but supports up to ~8000 on the larger instance classes. Neon's free tier caps at ~50 connections to the direct endpoint and ~10,000 through the pooler. Track the watermark with `SELECT count(*) FROM pg_stat_activity`.

**MySQL ceiling:** Managed RDS MySQL defaults to a formula based on instance memory — typically 90-200 on small instances. PlanetScale routes everything through Vitess; effective max is per-shard.

**Mongo ceiling:** Atlas tiers cap cluster-wide connections (M0 = 500, M10 = 1500, …). Per-driver `maxPoolSize` is your share.

When a replica restarts, its old pool is gone but new connections need to dial. On Postgres with PgBouncer, this is invisible; on direct connections, watch for `too many connections` errors during simultaneous restarts. Stagger replica restarts in your rolling update (set `maxSurge: 1` in Kubernetes; Fly's `max_unavailable: 1`).

---

## Multi-region deploys

Two shapes, picked by your consistency budget.

### Primary + read replicas

One write primary; N read replicas, one per region. forge handles this as two `db` instances with a router:

```ts
const primary = await createDb({ url: process.env.PRIMARY_URL!,  schema });
const replica = await createDb({ url: process.env.REPLICA_URL!,  schema });

export const pick = (intent: 'read' | 'write') => intent === 'read' ? replica : primary;
```

Detailed pattern in [BACKEND.md](./BACKEND.md#read-replicas-and-split-routing). The deployment concerns:

* **`forge push` runs against the primary.** Never against a replica — replicas are read-only and the push will fail on the first DDL. Pin the CI step's `DATABASE_URL` to the primary's URL.
* **Replication lag is real.** After a write completes on primary, the replica may not see it for 50ms-2s (sync replicas) or longer (async). A read-after-write must route to primary for at least one lag window. Patterns:
  * Request-scoped flag: if the request wrote, all subsequent reads in that request go to primary.
  * Time-based: a per-user "wrote-recently" timestamp in Redis, checked before each read.
  * Sticky routing: load-balance writes and follow-up reads to the same region's primary for N seconds.
* **Schema migrations replicate too.** `ALTER TABLE` on the primary replicates as DDL to the replicas. No second `forge push` needed against the replicas.

### Multi-primary (Aurora Global, Mongo geosharding)

Multi-region writes. Reach for this only when you've measured that primary-bound latency is your bottleneck. The push surface:

* **Aurora Global Database** has one write primary; the secondary regions accept writes after a failover. `forge push` against the primary; reads in the secondary region see the schema once replication catches up.
* **Mongo geo-sharded clusters** apply DDL (index creation) to all shards. `forge push` runs once, against the mongos router; the cluster fans out.
* **Vitess (PlanetScale)** has per-shard schema. `forge push` works as long as the URL points to the unsharded keyspace; for sharded keyspaces, use PlanetScale's deploy-request workflow instead.

Strong consistency for cross-region reads is a database-level decision; forge doesn't expose it. If your use case needs read-your-writes across regions, route all reads to the write region or use a CRDT-style store (which forge doesn't currently support).

---

## Observability hooks at deploy time

forge emits `query` and `error` events; piping them to a deploy-aware logger lets you tell "the new deploy made queries slower" apart from "the new deploy crashed".

The two hooks that matter at deploy time:

**Deploy version tag.** Tag every span / log line with the deploy's Git SHA so traces during the rollout window are separable.

```ts
import { wireOtel } from 'forge-orm';
import { db } from './db';

const DEPLOY_SHA = process.env.DEPLOY_SHA ?? 'unknown';

const off = wireOtel(db, {
  tracer: trace.getTracer('forge'),
  attributes: { 'deploy.sha': DEPLOY_SHA, 'deploy.region': process.env.REGION! },
});
```

**Post-deploy drift metric.** After `forge push`, run `forge diff --json` and push the item count to your metrics sink. If it isn't 0 within a few minutes, the push didn't fully apply.

```ts
import { execSync } from 'node:child_process';

const report = JSON.parse(execSync('npx forge diff --json').toString());
await metrics.gauge('forge.drift.items', report.items.length, { dialect: report.dialect, sha: process.env.DEPLOY_SHA });

if (!report.inSync) {
  console.error('Post-deploy drift', report.items);
  process.exit(1);
}
```

See [BACKEND.md](./BACKEND.md#observability) for the full event subscription pattern, and [MIGRATIONS.md](./MIGRATIONS.md#ci-workflows) for the CI snippet that wires the drift metric.

---

## Rollback path

The full rollback surface is in [ROLLBACK.md](./ROLLBACK.md). The deploy-time summary:

* **For app code:** roll the deployment back to the previous container image. Standard Kubernetes / ECS / Fly / Vercel mechanism. forge has nothing to do.
* **For schema:** `npx forge rollback` runs the down block of the most-recently-applied `forge diff apply` migration. Reliable on Postgres / DuckDB / MSSQL (transactional DDL), best-effort on MySQL / SQLite (DDL implicitly commits — see [MIGRATIONS.md](./MIGRATIONS.md#per-dialect-rollback-fidelity)).
* **For data:** forge does not snapshot data on DROP. If a column was dropped, the data is gone. Restore from a backup.

The deployment principle: **never let "rollback" depend on "first un-doing the schema change"**. Use the four-step pattern so the previous code version still works against the new schema. Rolling back the code is instant; rolling back the schema is at best slow and at worst impossible.

When a rollback is *only* about the schema (the code's already on the new shape but the new shape was wrong):

```sh
DATABASE_URL=$PROD_URL npx forge rollback
DATABASE_URL=$PROD_URL npx forge diff --check     # verify
```

If the rollback was a DROP COLUMN being undone, you got the column shape back but the data is gone. Restore from backup if you need it.

---

## Worked example — Vercel + Neon

The smallest production setup: Next.js on Vercel, Postgres on Neon, schema apply in CI.

### One-time setup

1. **Neon project.** Create a project; note the main branch's `DATABASE_URL` and the pooled URL (`-pooler` hostname).
2. **Vercel project env vars:**
   * `DATABASE_URL` = Neon pooled URL (for runtime — Vercel functions need pooling).
   * `MIGRATIONS_DATABASE_URL` = Neon direct URL (for CI's `forge push` — direct connection avoids pooler latency on DDL).
3. **Preview branches:** Enable Neon's GitHub integration. Each PR gets a database branch automatically; the URL is in `process.env.DATABASE_URL` during preview builds.

### `package.json`

```json
{
  "scripts": {
    "build": "forge push && next build",
    "diff": "forge diff --check"
  }
}
```

`forge push` runs as part of `vercel build`. On a preview deploy, it pushes to the per-PR branch (auto-created by Neon's integration). On a prod deploy, it pushes to the prod branch.

### GitHub Action — pre-merge gate

```yaml
# .github/workflows/schema-gate.yml
name: Schema gate
on: [pull_request]

jobs:
  drift:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20 }
      - run: npm ci
      - name: Doctor
        env: { DATABASE_URL: ${{ secrets.PROD_READONLY_URL }} }
        run: npx forge doctor
      - name: Diff against prod
        env: { DATABASE_URL: ${{ secrets.PROD_READONLY_URL }} }
        run: npx forge diff --json | tee diff.json
      - name: Comment on PR
        if: always()
        uses: actions/github-script@v7
        with:
          script: |
            const fs = require('fs');
            const r = JSON.parse(fs.readFileSync('diff.json', 'utf8'));
            const sigil = r.inSync ? 'no drift' : `${r.items.length} item(s)`;
            const body = `**Prod schema diff** — ${sigil}\n\n\`\`\`json\n${JSON.stringify(r, null, 2)}\n\`\`\``;
            github.rest.issues.createComment({
              owner: context.repo.owner, repo: context.repo.repo,
              issue_number: context.payload.pull_request.number, body,
            });
```

`PROD_READONLY_URL` is a Neon role with `SELECT` on `pg_catalog`, nothing more. The diff job needs introspection, not writes.

### Connection on Vercel Functions

```ts
// lib/db.ts
import { neon } from '@neondatabase/serverless';
import { createDb } from 'forge-orm';
import { schema } from './schema';

const sql = neon(process.env.DATABASE_URL!);
export const dbPromise = createDb({ schema, driver: { kind: 'postgres', query: (q) => sql(q.sql, q.params) } });

// app/api/users/route.ts
import { dbPromise } from '@/lib/db';
export async function GET() {
  const db = await dbPromise;
  return Response.json(await db.user.findMany());
}
```

The `@neondatabase/serverless` driver uses HTTP, not WebSockets — works in Edge Functions, no connection pool to size. forge sees a query interface; it doesn't care that the transport is HTTP.

### Cutover sequence

1. PR opens. Neon branches the DB. Schema gate runs `forge diff` against prod (read-only).
2. PR merges. Vercel build runs `forge push` against the prod URL.
3. New deployment goes live. Old deployment drains.
4. Post-deploy: a scheduled GitHub Action runs `forge diff --check` against prod; alerts on non-zero.

Rollback: Vercel "promote previous deployment" reverts the code. The schema isn't reverted automatically — that's `npx forge rollback`, which you only need if the schema push itself was wrong.

---

## Worked example — Fly.io + Postgres

Fly's machine-based deployment with Fly Postgres.

### One-time setup

```sh
fly postgres create --name myapp-db --region iad
fly postgres attach --app myapp myapp-db
# Sets DATABASE_URL secret automatically. Fly Postgres includes a built-in PgBouncer.
```

### `fly.toml`

```toml
app = "myapp"

[deploy]
  # Runs after the new image builds, before traffic shifts.
  release_command = "npx forge push"

[[services]]
  protocol = "tcp"
  internal_port = 3000
  # ...

[[services.http_checks]]
  path = "/healthz"
```

`release_command` runs once per deploy in a one-shot machine that has full access to the app's secrets. If `forge push` exits non-zero, the deploy halts. This is the cleanest pattern across all platforms — one push per release, separate from app start.

### App start

```ts
// src/server.ts
import { createDb } from 'forge-orm';
import { schema } from './schema';

const db = await createDb({ url: process.env.DATABASE_URL!, schema });

// Standard hyper-express / Fastify setup. No forge push at startup — that's the release_command's job.
```

### Smoke + drift after deploy

```sh
# .github/workflows/deploy.yml (excerpt)
- run: flyctl deploy --remote-only
- run: npm run smoke -- --base-url=https://myapp.fly.dev
- run: |
    DATABASE_URL=$(flyctl ssh console -C "echo \$DATABASE_URL" -a myapp) \
    npx forge diff --check
```

The `flyctl ssh console -C` invocation exposes the in-machine `DATABASE_URL` to the CI runner for the drift check. Alternatively, expose a read-only URL through a Fly secret and use that.

### Rolling restart specifics

Fly's rolling update default is `max_unavailable = 0.33` — at most a third of machines unavailable at a time. For a 3-machine app, that's one machine at a time. The window where v1 and v2 run side-by-side is the per-machine startup time (typically 10-30s) × the number of machines being cycled.

The principle applies: the schema change must be backward-compatible with v1 for that window. If you can't make it backward-compatible, use the four-step pattern.

### Multi-region

Fly Postgres supports read replicas in other regions. Replicas connect via `flyio://` URLs that route reads to the nearest replica and writes to the primary automatically — no router code needed.

```ts
const db = await createDb({ url: process.env.DATABASE_URL!, schema });
// Writes go to primary via the proxy; reads stick to the local region's replica.
```

`forge push` against the primary's direct URL — never the proxied URL, which would round-trip writes across the Atlantic.

---

## Worked example — AWS ECS + RDS

Classic AWS setup: ECS Fargate behind an ALB, RDS Postgres, secrets in Secrets Manager.

### One-time setup

1. RDS PG instance, multi-AZ, in a VPC.
2. Secrets Manager secret `myapp/db-url` containing the connection string.
3. RDS Proxy in front of the DB for connection pooling.
4. ECS task definition reads the secret via the `secrets:` block.
5. Separate ECS task definition for migrations — same image, `command: ["npx", "forge", "push"]`.

### CodeBuild / GitHub Action

```yaml
# buildspec.yml or .github/workflows/deploy.yml
phases:
  build:
    commands:
      - npm ci && npm test && npm run build
      - docker build -t $ECR_URI:$SHA .
      - docker push $ECR_URI:$SHA
  post_build:
    commands:
      # Run forge push as a one-off ECS task. Blocks until complete.
      - |
        TASK_ARN=$(aws ecs run-task \
          --cluster myapp \
          --task-definition forge-push \
          --launch-type FARGATE \
          --network-configuration "awsvpcConfiguration={subnets=[$SUBNET],securityGroups=[$SG],assignPublicIp=DISABLED}" \
          --overrides '{"containerOverrides":[{"name":"forge","image":"'$ECR_URI:$SHA'"}]}' \
          --query 'tasks[0].taskArn' --output text)
        aws ecs wait tasks-stopped --cluster myapp --tasks $TASK_ARN
        EXIT=$(aws ecs describe-tasks --cluster myapp --tasks $TASK_ARN --query 'tasks[0].containers[0].exitCode' --output text)
        [ "$EXIT" = "0" ] || exit 1

      # Push complete — now update the app service to the new image.
      - aws ecs update-service --cluster myapp --service api --force-new-deployment
      - aws ecs wait services-stable --cluster myapp --services api
```

The migrations task uses the same image as the app — `forge push` is part of the production bundle. The cluster runs it once per deploy. The app service only restarts after the push completes successfully.

### Connection via RDS Proxy

```ts
import { Pool } from 'pg';
import { createDb, pgDriver } from 'forge-orm';
import { schema } from './schema';

const pool = new Pool({
  host: process.env.RDS_PROXY_HOST,                  // proxy endpoint, not the DB
  port: 5432,
  user: process.env.DB_USER,
  database: process.env.DB_NAME,
  password: async () => generateIAMToken(),         // IAM-token auth, refreshed per connection
  ssl: { rejectUnauthorized: true, ca: AWS_RDS_CA },
  max: 10,
  idleTimeoutMillis: 30_000,
});

export const db = await createDb({ schema, driver: pgDriver(pool) });
```

RDS Proxy multiplexes the 10 pool slots across many more underlying DB connections. The Fargate task can scale to dozens of replicas without hitting RDS's `max_connections` ceiling.

### Schema apply via the proxy

`forge push` through RDS Proxy works *except* for the advisory-lock pattern (proxies may route subsequent statements to different DB connections, breaking session-scoped locks). Run the migrations task against the **direct** RDS endpoint, not the proxy:

```yaml
# Task definition for forge-push specifically:
environment:
  - name: DATABASE_URL
    value: postgres://app:${PASSWORD}@${RDS_ENDPOINT}:5432/app   # not the proxy
```

The app uses the proxy; the migrations task uses the direct endpoint. This is the only place in the deploy where the URL differs.

### Rolling update

ECS rolling updates default to `maximumPercent: 200, minimumHealthyPercent: 100` — doubles the task count, drains the old tasks. Same v1/v2 overlap as Kubernetes. Same rule: schema changes must be backward-compatible with v1.

### Rollback

```sh
# Code rollback
aws ecs update-service --cluster myapp --service api --task-definition api:${PREVIOUS_REVISION}

# Schema rollback (rare; only if the migration itself was wrong)
aws ecs run-task --cluster myapp --task-definition forge-rollback
```

The `forge-rollback` task is the same image, different command: `npx forge rollback`. Use when the prior `forge diff apply` was a mistake; not needed when `forge push` was the migration (push is additive, leave it).

---

## Cross-references

* [MIGRATIONS.md](./MIGRATIONS.md) — every CLI command's deep reference, drift rules, per-dialect emit table, blue/green schema pattern, monorepo workflows.
* [ROLLBACK.md](./ROLLBACK.md) — `forge rollback` semantics, per-dialect fidelity, recovery from destructive operations.
* [DOCTOR.md](./DOCTOR.md) — capability probe, extension detection, what each line of the doctor report means.
* [BACKEND.md](./BACKEND.md) — server framework wiring, pool sizing, replica routing, observability, health probes.
* [DRIVERS.md](./DRIVERS.md) — driver-specific connection-string flags and pooling notes.
* [CLI.md](./CLI.md) — flag reference for every CLI command.
