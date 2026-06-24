# Backup and restore

forge-orm doesn't ship backup tools — you use the native facility of whichever database you connect to. This page collects the patterns that work for each dialect, plus the operational rules (restore drills, schema-mismatch handling, encrypted off-site copies) that turn raw backup files into a working disaster-recovery story.

Companion to **[MIGRATIONS.md](./MIGRATIONS.md)** (how the schema gets to the DB in the first place) and **[ROLLBACK.md](./ROLLBACK.md)** (how to undo a recent schema apply). Backup is the floor under both of those — when a rollback can't recover the data, when a schema apply corrupted a table you didn't notice for a week, the restore path is what's left. If you're reading this in an incident, jump to [Restore drill — a script you can lift](#restore-drill--a-script-you-can-lift) and come back for the rest.

## Contents

* [Why forge stays out of backup](#why-forge-stays-out-of-backup)
* [Backup formats — logical vs physical](#backup-formats--logical-vs-physical)
* [Per-dialect backup primitives](#per-dialect-backup-primitives)
  * [Postgres](#postgres)
  * [MySQL / MariaDB](#mysql--mariadb)
  * [SQLite](#sqlite)
  * [DuckDB](#duckdb)
  * [MSSQL](#mssql)
  * [MongoDB](#mongodb)
* [PITR — point-in-time recovery per dialect](#pitr--point-in-time-recovery-per-dialect)
* [Schema-only vs data-only vs full](#schema-only-vs-data-only-vs-full)
* [Restore + schema mismatch](#restore--schema-mismatch)
* [Encrypted backups](#encrypted-backups)
* [Cloud-managed backup — what it covers and what it doesn't](#cloud-managed-backup--what-it-covers-and-what-it-doesnt)
* [Backup in CI — nightly cron and retention](#backup-in-ci--nightly-cron-and-retention)
* [SQLite streaming with litestream](#sqlite-streaming-with-litestream)
* [Multi-region disaster recovery](#multi-region-disaster-recovery)
* [Browser and mobile — there is no OPFS backup](#browser-and-mobile--there-is-no-opfs-backup)
* [Worked examples](#worked-examples)
* [Restore drill — a script you can lift](#restore-drill--a-script-you-can-lift)
* [Cross-references](#cross-references)

---

## Why forge stays out of backup

Backup is a database-engine concern, not an ORM concern. Postgres has `pg_dump`, `pg_basebackup`, and write-ahead-log archiving. SQLite has `.backup`, `VACUUM INTO`, and the file copy with the `-wal` and `-shm` siblings. Mongo has `mongodump` and replica-set snapshots. Each of those is tuned to its engine's storage layout, locking model, and on-disk format. An ORM that wrapped them would be one of two things — a thin shell that just shells out (no value over running the tool directly), or a thick re-implementation that gets the corner cases wrong (worse than the native tool).

So forge does the same thing here that it does for connection pooling, query planning, and replication topology: it gets out of the way. The schema you push with `forge push` lives in the database; the database's own backup primitives are what brings it back. forge's job is to make sure the *shape* of the data is reproducible from your TypeScript schema, which means a restored backup can always be brought forward to the current schema with one more `forge push`. That property — restore the data, then push the shape — is the only forge-specific thing on this page. Everything else is dialect-native.

What this means in practice:

* **You don't run a forge subcommand to take a backup.** You run `pg_dump`, `mysqldump`, `mongodump`, `sqlite3 .backup`, `EXPORT DATABASE`, `BACKUP DATABASE`. Those tools ship with the database client and know how to coordinate with the live server.
* **You run `forge push` after restore**, against the restored database, to align its schema with HEAD. If the backup is from a week ago and the schema's moved on, the restore brings the old shape back and `forge push` brings it forward. This is the only piece of the workflow that's forge-shaped.
* **You can use `forge diff` as a verification step** after restore to confirm the restored DB matches HEAD. `forge diff --check` exit 0 means the restore landed clean and there's nothing left to apply; exit 3 means the restore is older than HEAD and `forge push` will bring it forward. See [Restore + schema mismatch](#restore--schema-mismatch).

---

## Backup formats — logical vs physical

Every dialect supports at least one of two backup shapes. The choice drives restore time, portability, and what you can recover from.

| Format | What it is | When it wins | What it loses |
|---|---|---|---|
| **Logical** | A SQL or JSON stream that re-creates the schema and inserts the rows. `pg_dump` (default), `mysqldump`, `mongodump`, DuckDB's `EXPORT DATABASE`. | Portable across engine versions and sometimes across engines. Easy to grep, diff, partial-restore one table. Encrypts well as a stream. | Slow to restore on large DBs — each `INSERT` is parsed, planned, and written. No PITR (you get the moment the dump started, no later). |
| **Physical** | A byte-level copy of the data files. `pg_basebackup`, MariaBackup, SQLite file copy, MSSQL native backup, Mongo replica-set snapshot. | Fast to restore (just put the files in place and start the engine). Carries indexes, statistics, and bloat exactly as they were. Pairs with WAL/binlog for PITR. | Engine-version-specific (Postgres 14 base backup won't open under PG 16 without `pg_upgrade`). Encryption requires the engine's at-rest support or filesystem-level. |

The default operating posture for most teams is **logical backup nightly + WAL/binlog continuous archiving for PITR**. The nightly logical dump is your portable, encrypted-off-site, "I can untar this on a laptop" artefact. The WAL archive is what lets you replay forward from the nightly to within seconds of an incident. The two together are what every cloud-managed backup product is also doing under the hood.

---

## Per-dialect backup primitives

### Postgres

* **`pg_dump`** — logical, per-database. Streams SQL (or `-Fc` custom format) to stdout. Doesn't block writers; uses a serializable snapshot. The default for nightly backups.
* **`pg_dumpall`** — logical, cluster-wide. Use when you need roles, tablespaces, and every database in one file. Most app deployments use `pg_dump` of the one app database instead.
* **`pg_basebackup`** — physical, cluster-wide. Streams the data directory and the WAL needed to be consistent. Pair with continuous WAL archiving for PITR.
* **WAL archiving** — `archive_mode = on`, `archive_command = 'cp %p /archive/%f'` (or `pgbackrest`, `wal-g`, `barman`). Each WAL segment is shipped as it fills; restore replays them in order.
* **PITR** — base backup + WAL segments + a `recovery_target_time = '2026-06-24 14:32:00'` setting in `recovery.signal`. Postgres replays WAL up to that timestamp, then stops.

Choose by RPO:

| RPO target | What to run |
|---|---|
| 24 hours | `pg_dump` nightly to S3, no WAL archive. |
| 1 hour | `pg_dump` nightly + WAL archive every 5 minutes. |
| 1 minute | `pg_basebackup` weekly + continuous WAL archive (`pgbackrest --archive-async`). |
| Seconds | A streaming standby replica with synchronous commit, plus base backup + WAL. |

### MySQL / MariaDB

* **`mysqldump`** — logical, single-threaded. The historical workhorse. Use `--single-transaction --quick --routines --triggers --events` for a consistent snapshot of an InnoDB-only DB without locking writers.
* **`mysqlpump`** — logical, parallel. Faster than `mysqldump` on dumps with many tables. Lacks the same "single-transaction across the whole dump" guarantee — schedule against a read replica or during quiet hours.
* **MariaBackup / Percona XtraBackup** — physical, hot. Copies InnoDB tablespaces while writers continue. Pair with binlog for PITR.
* **Binary log (binlog)** — `log_bin = ON`, `binlog_format = ROW`. Each committed transaction writes a row-based event. `mysqlbinlog --start-datetime=… --stop-datetime=…` replays a range against a restored backup.
* **PITR** — restore the most recent physical backup, then `mysqlbinlog` the binlogs from the backup's binlog position to the target time, piped into `mysql`.

MySQL's gotcha is `--single-transaction`. Without it, `mysqldump` takes a `FLUSH TABLES WITH READ LOCK` that blocks writers. With it, MyISAM tables (still common in legacy schemas) aren't consistent because MyISAM doesn't honour the transaction. Audit for MyISAM before relying on `--single-transaction` — `SELECT table_name FROM information_schema.tables WHERE engine = 'MyISAM'`.

The second MySQL gotcha is `gtid_mode`. Without GTIDs, PITR via binlog requires you to remember the binlog file + position the backup ended at (`mysqldump --master-data=2` writes it as a comment in the dump). With GTIDs, `mysqlbinlog` knows where the dump's GTID set ends and replays the rest cleanly. Turn GTIDs on (`gtid_mode=ON`, `enforce_gtid_consistency=ON`) before you need them; flipping it requires a rolling restart of replicas.

### SQLite

SQLite is a single file (plus `-wal` and `-shm` siblings when WAL mode is on). The backup story has three shapes.

* **`sqlite3 source.db ".backup target.db"`** — the canonical hot backup. Uses the SQLite online backup API: copies pages while writers continue, retrying as needed. The target is a fresh DB file. Restore is a file copy back.
* **`VACUUM INTO 'target.db'`** — runs in a single transaction, produces a defragmented copy. Slightly different from `.backup` — it rebuilds rather than copying pages — so the output is smaller but the source experiences a longer-held read lock. Use for periodic compaction-plus-backup.
* **Cold file copy** — `cp source.db backup.db && cp source.db-wal backup.db-wal && cp source.db-shm backup.db-shm`. **Only safe when no process is writing.** A live copy of a WAL-mode database without the `-wal` and `-shm` files is a partially-written database; opening it loses every transaction since the last checkpoint. If you cold-copy, run `PRAGMA wal_checkpoint(TRUNCATE);` first.
* **`litestream`** — continuous streaming of WAL segments to S3 / B2 / GCS. Sub-second RPO. See [SQLite streaming with litestream](#sqlite-streaming-with-litestream).

For a forge-orm Tauri / Capacitor app with a local SQLite, the realistic backup story is "the data lives on the device, the server is the backup" — see [Browser and mobile — there is no OPFS backup](#browser-and-mobile--there-is-no-opfs-backup). For a server-side SQLite (a small SaaS, an edge function with a sidecar DB), litestream is the answer.

### DuckDB

* **`EXPORT DATABASE 'dir' (FORMAT PARQUET);`** — logical. Writes per-table Parquet files plus a `schema.sql` and a `load.sql`. Portable, columnar-compressed, restorable into a fresh DuckDB with `IMPORT DATABASE 'dir';`. The default for DuckDB backup.
* **`COPY table TO 'file.parquet' (FORMAT PARQUET);`** — per-table. Useful for partial backups or feeding downstream analytics.
* **File copy** — DuckDB's `.duckdb` file is also a single artefact. When the DB is closed (the process has called `db.$disconnect()`), `cp source.duckdb backup.duckdb` is correct. While the DB is open, the file may be mid-write; use `EXPORT DATABASE` instead.
* **No WAL archive, no PITR** — DuckDB is positioned as an analytical engine, not a transactional one. Backups are snapshots. If you need point-in-time, your DuckDB instance is downstream of an OLTP source (Postgres, MySQL) — back the source up, treat the DuckDB as a derived cache.

### MSSQL

* **`BACKUP DATABASE … TO DISK = '…';`** — physical, native. Full, differential, or transaction-log. The full backup is the base, differentials are deltas since the last full, log backups capture every transaction.
* **`RESTORE DATABASE … FROM DISK = '…' WITH NORECOVERY;`** then `RESTORE LOG … WITH STOPAT = '2026-06-24T14:32:00';` — PITR by replaying log backups onto a non-recovered full restore.
* **Log shipping** — automated periodic log backups copied to a standby and restored there. RPO matches the log backup interval (commonly 5 minutes).
* **Always On Availability Groups** — synchronous replication for HA, asynchronous for DR. Not a substitute for backup — covers hardware loss, not "I dropped the wrong table".

The MSSQL backup model is the most complete of any dialect — full + differential + log gives you tight control over restore time and storage cost. The cost is operational complexity: you maintain the chain (a missing differential or log breaks PITR). Use Ola Hallengren's maintenance solution for the cron side; it's the standard.

Sizing for a typical MSSQL deployment:

| Backup type | Cadence | Restore time on 100 GB |
|---|---|---|
| Full | Weekly | 10–30 min depending on storage |
| Differential | Daily | Full + the latest differential, 15–40 min |
| Log | Every 15 min | Full + differential + 0–95 logs, 20 min–2 hr |

The differential cadence is the lever most teams under-tune. Daily differentials keep restore short; less-frequent differentials make the log chain longer and the restore slower. Match cadence to your RTO target, not to disk savings — log storage is much cheaper than recovery time during an incident.

### MongoDB

* **`mongodump`** — logical, per-database or cluster-wide. BSON output, restorable with `mongorestore`. The standard for sub-100GB dumps. Slow for larger; restore takes hours.
* **Replica-set filesystem snapshot** — `db.fsyncLock()`, take an LVM / EBS / ZFS snapshot of the data directory on a secondary, `db.fsyncUnlock()`. Physical, consistent, restorable as a fresh mongod data directory. The standard for >100GB.
* **Oplog tailing** — capture the replica set's oplog continuously (`mongodump --oplog`), then `mongorestore --oplogReplay --oplogLimit '<timestamp>'` for PITR.
* **Atlas / MongoDB Cloud Manager** — managed continuous backup with PITR. The hosted version of "snapshot + oplog".

forge's Mongo adapter doesn't generate DDL (Mongo is schemaless); backups are about preserving collections and indexes. `forge push` after restore re-establishes indexes from the schema, which is faster and more reliable than restoring indexes from the dump.

`mongodump --oplog` is the option most teams miss. Without it, the dump is a snapshot from the moment each collection's dump started — collections dumped later don't see writes that happened during earlier collections' dumps, leading to subtle cross-collection inconsistency on restore. With `--oplog`, the tool also captures the oplog window of the dump, and `mongorestore --oplogReplay` brings every collection forward to a single consistent point.

---

## PITR — point-in-time recovery per dialect

Point-in-time recovery answers "give me the database as it was at 14:32:07 last Tuesday". Some dialects support it natively; some need third-party tooling; some don't support it at all.

| Dialect | Native PITR | RPO floor | What you need |
|---|---|---|---|
| Postgres | Yes | Seconds | Base backup + WAL archive (`pgbackrest`, `wal-g`, `barman`). |
| MySQL | Yes | Seconds | Physical backup (MariaBackup / XtraBackup) + binlog. |
| MSSQL | Yes | Seconds | Full + log backups, replayed with `STOPAT`. |
| MongoDB | Yes | Seconds | Snapshot + oplog. Atlas does this transparently. |
| SQLite | Via litestream | Sub-second | WAL streaming to S3; replay generation by generation. |
| DuckDB | No | N/A | Take periodic exports; PITR belongs upstream. |

PITR isn't free. The WAL / binlog / oplog stream is continuous I/O — sized for steady-state write throughput, which on a busy DB is hundreds of MB/hour. Plan storage: 30 days of WAL at 100 MB/hour is 70 GB. S3 storage is cheap, but the retrieval bandwidth matters in a restore — see [Backup in CI — nightly cron and retention](#backup-in-ci--nightly-cron-and-retention).

The other PITR gotcha is **clock alignment**. A `recovery_target_time` only works if the DB server's clock matched UTC at the moment of the incident. NTP-skewed servers produce PITR targets that miss by the skew. If you're chasing seconds, log every backup's wall-clock-vs-DB-clock delta and use that to correct the target.

A practical PITR drill:

1. Take a base backup at `T0`.
2. Run a known mutation at `T0 + 30m` (insert a row with `id = 'pitr-canary'`).
3. Run a destructive mutation at `T0 + 1h` (drop the canary row).
4. Restore the base backup, replay WAL / binlog / oplog to `T0 + 45m`.
5. Verify `pitr-canary` exists in the restored DB.

If the canary's there, PITR works. If it isn't, either replay didn't reach `T0 + 45m` (check the recovery target settings) or the canary fell outside the replay window (check the archive contents). Run this drill once per quarter against a copy of prod data; it's the cheapest insurance against PITR-shaped incidents.

---

## Schema-only vs data-only vs full

Most logical backup tools support splitting the dump into schema and data. The split matters in three scenarios:

* **Clone for staging** — `--schema-only` (Postgres `-s`, MySQL `--no-data`, Mongo doesn't really do this — use `mongoexport` with empty queries). Recreates an empty DB shaped like prod, ideal for running tests against. forge's alternative is `forge push` against an empty database from the same schema file; the dump version captures vendor-specific objects (custom types, stored procs, materialised views) that the schema declaration doesn't.
* **Refresh data without disturbing schema** — `--data-only`. Used to swap in fresh data from prod into a staging DB that's already been schema-migrated to a newer version. Brittle — if the column set drifted, `--data-only` rows won't load. Prefer the [restore-then-push pattern](#restore--schema-mismatch).
* **Pre-rollback backup** — full, before running `forge diff apply` on a destructive migration. The safety net for "the down block didn't quite undo what the up block did". See ROLLBACK.md's emergency procedures section.

| Flag set | Postgres | MySQL | DuckDB | Mongo |
|---|---|---|---|---|
| Schema only | `pg_dump -s` | `mysqldump --no-data` | `EXPORT DATABASE … (FORMAT PARQUET)` then keep only `schema.sql` | n/a — re-run `forge push` against an empty DB |
| Data only | `pg_dump -a` | `mysqldump --no-create-info` | Per-table `COPY TO` | `mongodump` (collections are data + indexes; no separation) |
| Full | `pg_dump` (default) | `mysqldump` (default) | `EXPORT DATABASE` | `mongodump` |

The forge-specific recommendation: store the schema *as code* (`src/schema.ts` at a Git SHA), not as a SQL dump. The dump version becomes stale the moment the schema changes; the code version is the source of truth `forge push` reads from. Schema-only dumps are useful for debugging or for non-forge tools (BI, schema-comparison) — they aren't your restore path.

---

## Restore + schema mismatch

The single most useful forge-specific property in this whole document: **restore the data, then `forge push` to bring forward**.

The scenario: nightly backup from three days ago. Today's schema has two new columns and a new index. You restore the backup into a fresh DB. The restored DB's tables don't have the new columns.

```sh
# 1. Provision a fresh DB.
createdb -h restored-host restored_db

# 2. Restore the logical backup.
gunzip -c backup-2026-06-21.sql.gz | psql -h restored-host restored_db

# 3. Verify the restore landed clean against the OLD schema.
git checkout 2026-06-21-tag -- src/schema.ts
DATABASE_URL=postgres://…/restored_db npx forge diff --check
# Exit 0 — restore matches the snapshot's schema.

# 4. Bring the schema forward to HEAD.
git checkout HEAD -- src/schema.ts
DATABASE_URL=postgres://…/restored_db npx forge push
# Adds the two new columns and the new index.

# 5. Verify again — should be clean against HEAD now.
DATABASE_URL=postgres://…/restored_db npx forge diff --check
# Exit 0.
```

The same pattern works in any direction. Restoring an old backup into a fresh DB and then pushing HEAD lands the current schema with the old data. New columns are NULL (or take their declared defaults). New non-null columns without defaults will fail the push — fix by adding the default in the schema, or by writing a one-off backfill before pushing.

Two failure modes worth knowing:

* **Schema removed a column the backup had data in** — the restore loads the column; `forge push` doesn't drop it. The schema declares HEAD's shape; the column is "extra in DB" drift. Run `forge diff` to see it. If you want it gone, `forge diff apply` will generate the destructive `ALTER TABLE … DROP COLUMN`. If you want to keep the data for migration, write a one-off transform script first.
* **Schema renamed a column** — push sees it as drop + add (renames look like that to the differ; see MIGRATIONS.md). The restored data sits in the old column name; the schema declares the new one. Push will add the new column empty. You write the rename data step explicitly: `UPDATE table SET new_col = old_col; ALTER TABLE table DROP COLUMN old_col;`. This is one of the cases where push-style ORMs need a hand — and where a Prisma-style numbered migration would have shipped the rename atomically.
* **Schema changed a column type** — `push` doesn't `ALTER TYPE`; that's a `forge diff apply` operation. After restore, the old type sits in the restored DB; `forge diff --check` reports a `columnType` mismatch. You either run `forge diff apply` (which generates the type-change DDL with whatever cast logic the differ can express) or you write the explicit `ALTER TABLE … ALTER COLUMN … TYPE … USING …` yourself for cases the differ can't handle (a string → uuid that needs validation, a timestamp → date that loses precision).
* **Schema gained a non-nullable column without a default** — `forge push` against the restored DB fails. Restored rows can't all gain a value out of thin air. Fix by adding a default in the schema declaration, by writing a one-off backfill script run between restore and push, or by making the column nullable, pushing, backfilling, then tightening to non-null in a follow-up.

---

## Encrypted backups

A backup that isn't encrypted at rest in your off-site store is a one-zero-day-away data breach. Three layers, any one of which is sufficient, all three of which is the recommendation:

* **Engine-level encryption** — Postgres `pg_basebackup` with TDE (12+ with the right build), MySQL with InnoDB encryption keyring, MSSQL TDE. The backup inherits encryption from the data files. Restore needs the keyring.
* **Pipe through a streaming cipher before upload** — `pg_dump … | gpg --encrypt -r ops@team.example | aws s3 cp - s3://backups/db-$(date +%F).sql.gpg`. Independent of engine; one extra step in the restore (`aws s3 cp … | gpg --decrypt | psql …`).
* **Object-store SSE** — S3 / B2 / GCS server-side encryption with a KMS-managed key. Cheap to enable, mandatory baseline. Doesn't protect against an attacker with the same IAM role you use for backups — pair with one of the above.

Key management is the part teams get wrong. The decryption key cannot live in the same blast radius as the backup. If a compromised cloud account holds both the encrypted backup and the KMS key that unlocks it, you have plaintext. Patterns that work:

* **Hardware-backed KMS** with policies that prevent the backup IAM role from also calling `kms:Decrypt`. Restores require a separate role check.
* **Off-cloud keystore** — backup encryption key in 1Password / Vault / a hardware token, the backup script `gpg --encrypt`s with a public key whose private half is offline. Cold but bulletproof for disaster scenarios.
* **Shamir's secret sharing** for the master key. Recovery requires N-of-M operators to combine shards. Operationally heavy; used by compliance-regulated teams.

The litestream story (see [SQLite streaming with litestream](#sqlite-streaming-with-litestream)) bakes in age-encrypted object-store writes. For dump-style backups, the GPG pipe is the simplest credible posture.

A pattern worth knowing: **per-customer encryption for multi-tenant apps**. If a SaaS holds tenant data and one customer demands "delete all my data", the GDPR-friendly answer is encrypted-per-tenant backups where the deletion is "destroy this tenant's key". The backup file lives forever in S3; without the key it's noise. The forge-orm side of this is a hook on the dump pipeline — split rows by tenant, encrypt each tenant's stream with their key, write per-tenant objects. Heavier to implement than per-DB encryption, but the only honest answer when the deletion-of-record requirement runs against the keep-backups-for-7-years requirement.

---

## Cloud-managed backup — what it covers and what it doesn't

Most teams use a managed database (RDS, Aurora, Cloud SQL, Azure SQL, Atlas, Neon, PlanetScale). Each ships an automated backup product. What they cover:

| Service | Default backup | PITR window | What you get |
|---|---|---|---|
| AWS RDS (Postgres/MySQL) | Daily snapshot | 1–35 days | Snapshot + WAL/binlog; restore creates a new instance. |
| AWS Aurora | Continuous | 1–35 days | Sub-second PITR; restore creates a new cluster from a clone. |
| GCP Cloud SQL | Daily | 7 days default | Snapshot + WAL; restore creates a new instance. |
| Azure SQL Database | Continuous | 7–35 days | Native log backup chain; geo-restore to a paired region. |
| MongoDB Atlas | Continuous | 1–7 days (free), longer paid | Snapshot + oplog; restore creates a new cluster. |
| Neon | Branching (CoW) | 7–30 days | Branch from any point in retention; near-instant. |
| PlanetScale | Daily | 30 days | Snapshot per branch; restore via support. |

What they cover well: **disk loss, region loss, accidental table drop within the retention window.** What they don't cover:

* **Logical corruption that took a week to notice.** If retention is 7 days and the bad write happened 8 days ago, the managed backup is gone. Hold your own out-of-cloud copies for incidents you might catch late.
* **Account takeover.** A compromised AWS root can delete every snapshot. Cross-account backup vaults (AWS Backup → separate account) defeat this; many teams skip the step.
* **Provider outage longer than your business tolerates.** RDS in `us-east-1` going down is an industry event, not a recoverable-from-snapshot event, until it comes back. Cross-cloud copies (RDS → S3 → R2 → Backblaze) cost cents per GB and avoid this entirely.
* **Schema correctness across restore.** A managed restore brings the data back at its snapshot time. If the schema has moved on, you still need `forge push` to align. The managed product doesn't know about your TypeScript schema.

The realistic posture for a production team on a managed DB: **lean on the managed backup as the primary recovery path, plus weekly logical dumps to a separate cloud account or provider as the "I'm getting fired if this fails too" backstop.** The weekly dump is small (a few minutes of cron + S3 cents), and it covers every cloud-managed backup failure mode listed above.

---

## Backup in CI — nightly cron and retention

A backup that nobody runs isn't a backup. Wire it to a scheduler — GitHub Actions cron, Vercel Cron, a Kubernetes CronJob, an EventBridge schedule — and verify it runs.

```yaml
# .github/workflows/backup-nightly.yml
name: Nightly Postgres backup
on:
  schedule:
    - cron: '17 3 * * *'   # 03:17 UTC, off-peak, off-the-hour to avoid the herd
  workflow_dispatch:
jobs:
  backup:
    runs-on: ubuntu-latest
    timeout-minutes: 60
    steps:
      - uses: actions/checkout@v4
      - name: Install pg_dump matching prod major
        run: |
          sudo apt-get update
          sudo apt-get install -y postgresql-client-16
      - name: Dump, encrypt, upload
        env:
          DATABASE_URL: ${{ secrets.DATABASE_URL }}
          BACKUP_GPG_PUBKEY: ${{ secrets.BACKUP_GPG_PUBKEY }}
          AWS_ACCESS_KEY_ID: ${{ secrets.BACKUP_AWS_KEY }}
          AWS_SECRET_ACCESS_KEY: ${{ secrets.BACKUP_AWS_SECRET }}
        run: |
          set -euo pipefail
          STAMP=$(date -u +%Y%m%dT%H%M%SZ)
          echo "$BACKUP_GPG_PUBKEY" | gpg --import
          pg_dump --format=custom --compress=9 "$DATABASE_URL" \
            | gpg --encrypt --recipient backup@team.example \
            | aws s3 cp - "s3://app-backups/postgres/$STAMP.dump.gpg"
      - name: Prune retention
        env:
          AWS_ACCESS_KEY_ID: ${{ secrets.BACKUP_AWS_KEY }}
          AWS_SECRET_ACCESS_KEY: ${{ secrets.BACKUP_AWS_SECRET }}
        run: |
          # Keep 7 daily, 4 weekly, 12 monthly — handled by S3 lifecycle, not here.
          aws s3 ls s3://app-backups/postgres/ | head -5
```

Retention is best expressed as an object-store lifecycle rule, not as a script-with-`rm`. A misconfigured retention script can delete every backup in a single bad run; an S3 lifecycle policy applies per-object, can't accidentally delete future objects, and is auditable in the bucket config.

Retention defaults that work for most teams:

* 7 daily backups.
* 4 weekly (last day of the week, kept 4 weeks).
* 12 monthly (first day of the month, kept 1 year).
* 7 yearly (first day of the year, kept 7 years — adjust for compliance).

That's 30 objects steady-state per database, regardless of how long the team has been running. Cheap. The S3 lifecycle rule expresses it directly via `Transition` to Glacier for older tiers and `Expiration` for the oldest.

The other half of CI backup is **verifying the cron actually ran**. A backup-job-never-fires alert is the silent killer. Pattern: every successful upload writes a heartbeat key (`s3://app-backups/heartbeat/postgres`); a separate scheduled probe alerts if the heartbeat is older than 26 hours. Same shape for every dialect.

The third half (the one nobody talks about) is **monitoring the size of the dump**. A backup that suddenly halves in size between two runs is a near-certain signal of partial dump, broken connection, or accidental TRUNCATE in prod. Track size as a metric; alert on day-over-day delta over 20% in either direction. The 20% threshold is loose enough to avoid noise on small DBs and tight enough to catch real problems on growing DBs.

---

## SQLite streaming with litestream

[litestream.io](https://litestream.io) replicates a SQLite database to S3-compatible object storage continuously, by tailing the WAL. It's the backup story for any single-node server-side SQLite — Fly.io apps, edge functions with a sidecar DB, small SaaS that picked SQLite for its operational simplicity.

The forge-orm integration is zero-config — litestream runs as a sidecar process, the forge `db` handle opens the same SQLite file, and litestream's WAL tail is invisible to the application.

```yaml
# litestream.yml
dbs:
  - path: /var/lib/app/app.sqlite
    replicas:
      - type: s3
        bucket: app-litestream
        path: app
        region: us-east-1
        retention: 720h           # 30 days of generation history
        retention-check-interval: 24h
        snapshot-interval: 24h    # full snapshot daily; PITR replays WAL between
        sync-interval: 1s         # WAL frames pushed every second
        encryption-key: ${LITESTREAM_AGE_KEY}   # age encryption at rest
```

```sh
# Restore — straightforward, no app code involved.
litestream restore -o /var/lib/app/app.sqlite \
  -timestamp 2026-06-24T14:32:00Z \
  s3://app-litestream/app
```

The restored file is dropped at the path forge's DB URL points at; restart the app and forge opens it as if nothing happened. Run `forge push` against the restored DB if the schema has moved on (the same pattern as every other dialect — see [Restore + schema mismatch](#restore--schema-mismatch)).

litestream gotchas:

* **It owns the WAL.** Other tools that checkpoint the WAL (a third-party backup script, an over-eager `PRAGMA wal_checkpoint(TRUNCATE)`) can break litestream's generation chain. Don't mix.
* **One writer.** SQLite is already single-writer; litestream assumes the same. Multi-process writers via WAL mode still work, but the litestream sidecar must be on the same host as the writers.
* **Sub-second RPO is sub-second loss potential.** A crash between two `sync-interval` ticks loses up to that interval's worth of writes. Set the interval to your RPO. The default 1s is appropriate for SaaS-grade durability.
* **Restoration is slow on large generations.** A 100 GB DB with 30 days of WAL replays in tens of minutes, not seconds. For databases over ~50 GB consider periodic snapshot rotation (lower `snapshot-interval`) or a different storage engine.

---

## Multi-region disaster recovery

Single-region backups recover from disk loss and human error. Multi-region recovers from "the region is on fire". The shape depends on RPO and RTO targets.

| Strategy | RPO | RTO | Cost | Forge fit |
|---|---|---|---|---|
| Cold backup, cross-region S3 replication | Hours | Hours | $ | Any dialect; `pg_dump | aws s3 cp` to a bucket with cross-region replication. |
| Warm standby, async replica in DR region | Seconds–minutes | Minutes | $$ | Postgres logical replication, MySQL async replication, Mongo replica set across regions. Forge connects via `DATABASE_URL`; failover is a URL change. |
| Hot standby, sync replica in DR region | Zero | Seconds | $$$ | Postgres synchronous_commit, MSSQL Always On synchronous AG, Aurora Global Database. Forge sees one URL behind a managed failover. |
| Active-active, multi-master | Zero | Zero | $$$$ | CockroachDB, YugabyteDB, Spanner. Forge connects via the standard adapter (Postgres-wire for the first two); writes resolve under the engine's consistency model. |

The forge-orm-specific notes:

* **Forge doesn't manage failover.** When the primary URL becomes the standby URL, the application reads the new URL from the environment, restarts, and reconnects. This is the same shape as every other database client.
* **Replicas in `DATABASE_REPLICA_URL`** for read-traffic splitting is documented in [BACKEND.md](./BACKEND.md#read-replicas-and-split-routing). The DR replica is the same shape — point it at a different URL when the primary's gone.
* **Schema convergence in DR** — if the DR region is async, there's a window where the standby is behind the primary. A failover during a deploy (the primary saw the new schema, the standby didn't yet) means the failed-over DR runs against an older schema. The first action on the new primary is `forge push` to align.
* **Backups are still required** alongside replicas. A replica that faithfully copies "I dropped the wrong table" is not a backup; it's a faster copy of the disaster. Replicas cover hardware and region failure; backups cover human and software failure. You need both.

A failover runbook worth keeping next to this doc:

1. Confirm the primary is actually gone — not a flap, not a network partition that resolves in 30s. Spurious failovers cost more than they save.
2. Promote the standby to primary in the engine (`pg_promote()` for Postgres streaming replication; the managed service's failover button for RDS/Aurora/Cloud SQL).
3. Update `DATABASE_URL` in the application environment to point at the new primary.
4. Restart the application; verify it connects.
5. Run `forge diff --check` against the new primary. Exit 0 means schema's clean. Exit 3 means the standby was behind a schema apply — run `forge push` to bring it forward.
6. Repoint replicas / DR standbys at the new primary, or rebuild them if their replication chain broke.
7. Update DNS / load-balancer pointers so external clients reach the new primary.
8. Post-incident: write the timeline. The next failover should be faster.

---

## Browser and mobile — there is no OPFS backup

A forge-orm browser app (sqlite-wasm + OPFS via the worker driver — see [BROWSER.md](./BROWSER.md)) keeps the database in the user's origin storage. A mobile app via Capacitor or tauri-plugin-sql keeps it in the app's sandbox. Neither is backed up by the OS in any way you can rely on.

| Platform | What's there | What backs it up | What doesn't |
|---|---|---|---|
| Browser, OPFS | `/storage/.../OPFS/<origin>/…` | Nothing. Cleared on "clear site data", evicted under storage pressure, gone on profile reset. | iCloud, Chrome sync, browser settings sync. |
| iOS, Capacitor | App container `Documents/` | iCloud Backup *if* the file isn't excluded *and* the user enabled it. | Cellular data, low-storage devices. |
| Android, Capacitor | App private storage | Google's auto-backup *if* `android:allowBackup="true"` and the file's under 25 MB. | Anything larger. |
| Tauri desktop | App data dir | Time Machine, File History, restic, whatever the user runs. | Anything they haven't set up. |

The realistic pattern for any forge-orm device-side DB: **the device is the cache, the server is the source of truth.** Sync writes to a server API; let the server's backup story (which is one of the patterns above) be the data's safety net. If the device's DB is corrupted or wiped, the app re-syncs from the server on next launch.

This is documented in [MOBILE.md](./MOBILE.md#sync-strategies). The backup-side note here is just the inverse: **if you're treating the device DB as authoritative, you have no backup**. Sync is the backup.

---

## Worked examples

### (a) Postgres nightly to S3, encrypted, with restore drill

The CI workflow above ships the dump. The restore drill — which validates the dump is actually restorable — runs weekly.

```yaml
# .github/workflows/backup-restore-drill.yml
name: Restore drill
on:
  schedule:
    - cron: '0 6 * * 1'   # Monday 06:00 UTC
  workflow_dispatch:
jobs:
  drill:
    runs-on: ubuntu-latest
    services:
      postgres:
        image: postgres:16
        env: { POSTGRES_PASSWORD: postgres }
        ports: ['5432:5432']
        options: --health-cmd pg_isready
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20 }
      - run: npm ci

      - name: Pull the most recent backup
        env:
          AWS_ACCESS_KEY_ID: ${{ secrets.BACKUP_AWS_KEY }}
          AWS_SECRET_ACCESS_KEY: ${{ secrets.BACKUP_AWS_SECRET }}
          BACKUP_GPG_PRIVKEY: ${{ secrets.BACKUP_GPG_PRIVKEY }}
        run: |
          set -euo pipefail
          LATEST=$(aws s3 ls s3://app-backups/postgres/ | sort | tail -1 | awk '{print $4}')
          aws s3 cp "s3://app-backups/postgres/$LATEST" "$LATEST"
          echo "$BACKUP_GPG_PRIVKEY" | gpg --import
          gpg --decrypt "$LATEST" > backup.dump

      - name: Restore into the test instance
        env:
          PGPASSWORD: postgres
        run: pg_restore --clean --if-exists -h localhost -U postgres -d postgres backup.dump

      - name: Verify schema matches the SHA the backup was taken at
        env:
          DATABASE_URL: postgres://postgres:postgres@localhost:5432/postgres
        run: |
          # The backup's STAMP encodes the time; the deploy that produced it
          # tagged the schema. Verify the restore is clean against that tag.
          TAG=$(aws s3api head-object --bucket app-backups --key "postgres/$LATEST" --query 'Metadata.git_sha' --output text)
          git checkout "$TAG" -- src/schema.ts
          npx forge diff --check

      - name: Bring forward to HEAD
        env:
          DATABASE_URL: postgres://postgres:postgres@localhost:5432/postgres
        run: |
          git checkout HEAD -- src/schema.ts
          npx forge push
          npx forge diff --check

      - name: Run a smoke query
        env:
          DATABASE_URL: postgres://postgres:postgres@localhost:5432/postgres
        run: npx tsx scripts/smoke-after-restore.ts
```

`scripts/smoke-after-restore.ts` exercises a small read-and-write workload against the restored DB. The point isn't extensive coverage — it's catching "the restore landed but every row's `created_at` is NULL because the column got added after the backup". One small write, one read-back, one consistency check is enough.

### (b) SQLite via litestream, restored on a fresh node

```sh
# Provision a fresh node, install litestream, restore, start app.
curl -sL https://github.com/benbjohnson/litestream/releases/download/v0.3.13/litestream-v0.3.13-linux-amd64.tar.gz \
  | tar -xzC /usr/local/bin

cat > /etc/litestream.yml <<'EOF'
dbs:
  - path: /var/lib/app/app.sqlite
    replicas:
      - type: s3
        bucket: app-litestream
        path: app
        encryption-key: ${LITESTREAM_AGE_KEY}
EOF

# Restore the latest generation.
mkdir -p /var/lib/app
LITESTREAM_AGE_KEY=… litestream restore -o /var/lib/app/app.sqlite \
  s3://app-litestream/app

# Run forge push to align schema with HEAD (the restore is from whenever).
DATABASE_URL=sqlite:///var/lib/app/app.sqlite npx forge push

# Verify.
DATABASE_URL=sqlite:///var/lib/app/app.sqlite npx forge diff --check

# Start litestream + app.
litestream replicate -config /etc/litestream.yml &
node dist/server.js
```

The whole flow is six commands. The forge-shaped piece is two of them: `forge push` after restore, `forge diff --check` to verify. The rest is litestream and the OS.

### (c) Mongo restore drill

```sh
# Pull the most recent dump from Atlas snapshot export, restore, push, verify.
set -euo pipefail

LATEST=$(aws s3 ls s3://app-backups/mongo/ | sort | tail -1 | awk '{print $4}')
aws s3 cp "s3://app-backups/mongo/$LATEST" "$LATEST"
tar -xzf "$LATEST"

# Spin up a throwaway mongod for the restore.
docker run -d --name drill-mongo -p 27017:27017 mongo:7
sleep 5

mongorestore --uri=mongodb://localhost:27017 --drop ./dump/

# Bring indexes forward — forge push is idempotent on Mongo.
DATABASE_URL=mongodb://localhost:27017/app npx forge push

# Verify by listing indexes the schema declares.
DATABASE_URL=mongodb://localhost:27017/app npx forge diff --check

docker rm -f drill-mongo
```

Mongo's variant is the most forge-friendly — there's no DDL to replay, just the data and the indexes. `forge push` is the index-management primitive; it's idempotent against a freshly-restored DB.

---

## Restore drill — a script you can lift

If you take one thing from this page, take this: **a backup you've never restored is a backup you don't have**. The most common failure mode of disaster recovery isn't the backup not existing — it's the restore process not working when it's needed. The corruption was outside the dump's snapshot, the encryption key was rotated, the network egress is rate-limited, the on-call doesn't remember the bucket name. Every quarter at minimum, every month if you can, run the drill.

```sh
#!/usr/bin/env bash
# scripts/restore-drill.sh — usage: ./restore-drill.sh <s3-key>
set -euo pipefail

KEY="${1:?usage: restore-drill.sh <s3-key>}"
DRILL_DB="restore_drill_$(date +%Y%m%d_%H%M%S)"

echo "[1/5] Pull backup $KEY"
aws s3 cp "s3://app-backups/$KEY" /tmp/drill.dump.gpg
gpg --decrypt /tmp/drill.dump.gpg > /tmp/drill.dump

echo "[2/5] Provision target $DRILL_DB"
createdb -h "$DRILL_HOST" "$DRILL_DB"
trap "dropdb -h $DRILL_HOST $DRILL_DB" EXIT

echo "[3/5] Restore"
pg_restore --clean --if-exists -h "$DRILL_HOST" -d "$DRILL_DB" /tmp/drill.dump

echo "[4/5] Bring forward to HEAD"
DATABASE_URL="postgres://$DRILL_HOST/$DRILL_DB" npx forge push
DATABASE_URL="postgres://$DRILL_HOST/$DRILL_DB" npx forge diff --check

echo "[5/5] Smoke test"
DATABASE_URL="postgres://$DRILL_HOST/$DRILL_DB" npx tsx scripts/smoke-after-restore.ts

echo "OK — restore validated for $KEY"
```

Cadence:

* **Weekly** — automated, against the most recent backup, in CI. The workflow above.
* **Monthly** — manual, against a random backup from the prior month. Confirms older backups in the rotation still restore.
* **Quarterly** — a full game-day. Simulate a region outage; restore into a different region or cloud; bring the app up against the restored DB; check observability for a full request flow. This is the drill that catches "the on-call doesn't know what to do", which is the failure mode all the others miss.

The drill output should be an alert-able artefact — a metric (`drill_seconds`, `drill_success`), a heartbeat key, a Slack message. If the drill silently breaks, you're back to "untested backup".

---

## Cross-references

* **[MIGRATIONS.md](./MIGRATIONS.md)** — `forge push`, `forge diff`, drift. The schema-side of the restore + push pattern.
* **[ROLLBACK.md](./ROLLBACK.md)** — `forge rollback`, the snapshot store, blue/green. The fast-undo path that, when it doesn't recover, hands off to this page.
* **[BACKEND.md](./BACKEND.md)** — connection pooling, replicas, health checks. The DR replica URL switch and the health-probe story tie into the multi-region patterns above.
* **[MOBILE.md](./MOBILE.md)** — device-side SQLite, sync strategies. The reason device backups aren't a real thing and what to do instead.
* **[BROWSER.md](./BROWSER.md)** — sqlite-wasm + OPFS, `db.$migrate()`. The browser-side equivalent of the same device-DB constraint.
* **[DRIVERS.md](./DRIVERS.md)** — adapter-level connection details. Useful when wiring a restore-target DB into the same connection shape as prod.
* **[DOCTOR.md](./DOCTOR.md)** — `forge doctor` for post-restore verification beyond `forge diff` (probes extensions, vendor-specific objects).
