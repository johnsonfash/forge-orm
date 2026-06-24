# scripts/

## `driver-smoke.mjs`

Throwaway smoke test for every driver forge-orm supports. Creates a fresh
tmpdir, `npm install`s the driver packages and the testcontainers helpers,
runs a minimal `connect → SELECT 1 → close` for each, then tears the tmpdir
and any running containers down.

Tests the **driver packages themselves**, independent of forge-orm — so you
can confirm a Node upgrade, an OS update, or a published forge-orm release
won't break against the underlying clients.

### Run

```bash
npm run smoke:drivers              # everything
npm run smoke:drivers -- --only=pg # filter by substring(s)
npm run smoke:drivers -- --keep    # don't delete the tmpdir on exit
npm run smoke:drivers -- --verbose # surface `npm install` output
```

### Coverage

| Group | Drivers | Needs |
|---|---|---|
| Embedded (no server) | `better-sqlite3`, `@libsql/client`, `@duckdb/node-api` | Nothing |
| Server (Testcontainers) | `pg`, `postgres` (porsager), `mysql2`, `mariadb`, `mongodb`, `mssql` | Docker running |
| Install-only (RN) | `expo-sqlite`, `@op-engineering/op-sqlite` | Nothing (just verifies install resolves; exec needs an iOS/Android runtime) |
| Skipped without creds | `@planetscale/database` | `PLANETSCALE_URL` env var |

### Output

```
forge-orm driver smoke — Node v22.x / darwin-arm64
Tempdir: /tmp/forge-drvchk-XXXX
Installing 14 packages (…)
Starting 4 servers: pg, mysql, mongo, mssql…
  ✓ pg container ready (1.42s)
  ✓ mysql container ready (5.10s)
  ✓ mongo container ready (4.30s)
  ✓ mssql container ready (38.20s)
Running driver tests…

Embedded (no server):
  ✓ better-sqlite3                12.4.0       8ms
  ✓ @libsql/client                0.14.0      45ms
  ✓ @duckdb/node-api              1.3.0      210ms

Server (Testcontainers):
  ✓ pg                            8.13.0      1.20s
  ✓ postgres (porsager)           3.4.4       1.10s
  ✓ mysql2                        3.11.0      2.30s
  ✓ mariadb                       3.4.0       2.50s
  ✓ mongodb                       6.11.0      1.80s
  ✓ mssql                         11.0.0      3.40s

Install-only (RN):
  ✓ expo-sqlite                   15.0.0           (install resolves; exec needs RN runtime)
  ✓ @op-engineering/op-sqlite     14.0.0           (install resolves; exec needs RN runtime)

Skipped:
  · @planetscale/database         -                (no credentials)

Result: 11 ok · 0 fail · 1 skipped
```

### Common failures + fixes

| Symptom | Likely cause | Fix |
|---|---|---|
| `mssql container failed: getaddrinfo ENOTFOUND` | Docker not running | Start Docker Desktop / Colima / Podman |
| `mssql container failed: timeout` on first run | First-pull pulling 1.3 GB image | Wait + retry. Subsequent runs use the cache |
| `mssql container failed: container exit 1` | ARM Mac running x86 image under emulation | Script auto-swaps to `azure-sql-edge` on `arch === 'arm64'` — if you set `MSSQL_IMAGE` manually, drop it |
| `expo-sqlite ✗ Cannot find module 'expo-modules-core'` | RN module loading at top level in Node | Already handled — script only calls `req.resolve()` (resolution check), not exec |
| `mysql2 connect ECONNREFUSED` while container reported ready | Container reports "started" before `mysqld` is accepting auth | Already handled — `MySqlContainer` waits for the readiness log line |
| `npm install` slow | First run downloads ~250 MB of native bindings | One-time. Subsequent runs hit npm cache |

### First-run cost

Cold (no Docker images cached, no npm cache):
- Image pulls: PG 80 MB · MySQL 200 MB · Mongo 200 MB · MSSQL 1.3 GB
- `npm install`: ~250 MB of driver bytes (better-sqlite3, duckdb, op-sqlite are native, take ~30s each to compile/download)
- Total: 3–6 minutes

Warm (everything cached):
- Containers spawn in 2–10s each
- Tests run in ~5s total
- Total: ~15s

### What this script does NOT cover

- The forge-orm code that wraps each driver. That's what `forge:integration:*` is for.
- React Native exec paths. `expo-sqlite` / `op-sqlite` need a real RN runtime (Detox + EAS Build, or manual smoke on a simulator).
- Authentication edge cases (Kerberos for MSSQL, IAM auth for managed PG, etc.) — the smoke test uses simple username/password.
