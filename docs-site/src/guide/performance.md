---
title: "Performance"
---

## Performance

forge adds a thin layer over the driver. In a local micro-benchmark of simple
operations (find, count, update), its per-call overhead measured similar to,
and often lower than, Prisma and Drizzle, with no separate engine process to
start.

Read that for what it is: a small synthetic test on localhost. The differences
are fractions of a millisecond and disappear next to real network latency and
query complexity. It says nothing about complex joins, correctness, or
maturity. The point is only that the convenience does not cost you measurable
performance. Run `forge:bench` and `forge:bench:compare` to see for yourself.

See more — **[docs/BENCHMARKS.md](/reference/benchmarks)** for the bench methodology, every shipped scenario, Prisma/Drizzle compare mode, profiling with clinic.js/0x, microbench traps (JIT warmup, GC pauses), and CI regression gating. **[docs/POOLING.md](/reference/pooling)** for connection-pool sizing per dialect and the per-runtime constraints (Lambda, Workers, Bun, pgbouncer). **[docs/CACHING.md](/reference/caching)** for DataLoader / Redis cache-aside / CDN patterns. **[docs/N-PLUS-ONE.md](/reference/n-plus-one)** for `include` vs DataLoader and how to detect query explosions via the event hook.

---
