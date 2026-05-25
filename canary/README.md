# Forge canary

A real HTTP service that uses **forge as its only data layer**, plus a
concurrent load generator — so you can watch how forge behaves under sustained,
real-network traffic before trusting it more widely.

## Safety model

The canary runs against an **isolated throwaway Postgres database** it creates
on boot and drops on shutdown. It never touches a production database, so a
forge bug here cannot corrupt real data. To canary *literal* production traffic,
shadow/mirror requests at your proxy into this service (read-only) — that's an
infra step on top of this, intentionally not wired by default.

## Run

```bash
# terminal 1 — start the service (creates + seeds + later drops an isolated DB)
npm run forge:canary

# terminal 2 — drive load, then Ctrl-C the service when done
CONCURRENCY=64 DURATION_MS=30000 npm run forge:canary:load
```

Env: `CANARY_PORT` (8787), `CANARY_SEED_USERS` (200), `CANARY_SEED_POSTS` (600),
`CONCURRENCY` (64), `DURATION_MS` (30000). Service exposes `/health` and
`/metrics` (forge's own `$on('query'/'error')` view: query count, avg/max ms,
slow-query count, errors, rss memory).

The workload is read-heavy (~80/20), mixing point lookups, filtered+ordered
lists, full-text search, relation hydration, inserts, a `findManyStream` (large
result), and a `$transaction` (insert + increment).

## Findings (first run — Postgres, M-series Mac, localhost)

| Concurrency | Throughput | p50 | p95 | p99 | Error rate |
|---|---|---|---|---|---|
| 64  | **2,714 req/s** | 18 ms | 38 ms | 209 ms | 0.03% |
| 100 | 1,246 req/s | 55 ms | 117 ms | 859 ms | 0.08% |

**What held up well:**
- ~2,700 req/s of mixed real traffic at concurrency 64 with p95 = 38 ms and a
  0.03% error rate. forge's per-query overhead (avg ~11 ms here, dominated by
  the actual PG round-trip) was not the bottleneck.
- **No memory leak** — RSS rose to ~268 MB under heavy concurrent load then
  fell back to ~64 MB once idle. Connections + timers cleaned up; the process
  stayed healthy across 138k queries and shut down cleanly with no orphaned DBs.

**Two genuine findings the canary surfaced:**

1. **Connection-pool ceiling (capacity, not a bug).** forge's PG adapter opens a
   pool of `max: 50`. At concurrency 100 — beyond the pool — throughput *fell*
   (1,246 vs 2,714 req/s) and p99 latency jumped to ~860 ms as requests queued
   for connections. **Tune the pool to your real concurrency**; past it you hit a
   latency cliff (normal pool behavior, but the canary makes the ceiling concrete).

2. **Catching a constraint error *inside* a `$transaction` is a Postgres footgun.**
   The `/like` endpoint did `tx.like.create(...).catch(() => {})` then
   `tx.post.update(...)`. On a duplicate (composite-unique) like, Postgres aborts
   the whole transaction — so the swallowed error doesn't let you continue; the
   next statement fails with *"current transaction is aborted"*. This hit ~1.6%
   of `/like` calls (random duplicate likes). **forge behaves correctly**: it
   maps the violation to `P2002` and rolls the transaction back cleanly (verified:
   no partial write, no corruption). The fix is in *user code* — don't swallow a
   constraint error mid-transaction; check-then-write, use `upsert`, or let the
   transaction fail and retry. Documented so forge users don't get bitten.

**Caveat:** these are localhost numbers — real network latency dominates in a
real deployment, and forge's overhead becomes proportionally smaller. The point
of the canary isn't the absolute throughput, it's that **forge stayed correct,
leak-free, and stable under sustained concurrent load**, and that the only rough
edges were a (normal) pool ceiling and a Postgres usage gotcha — not forge bugs.
