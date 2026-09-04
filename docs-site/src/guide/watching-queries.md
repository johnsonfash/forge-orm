---
title: "Watching queries"
---

## Watching queries

Subscribe to every query for logging or metrics. The callback receives the
database, model, operation, SQL, parameters, duration, and row count. There is
no cost when nothing is subscribed.

```ts
const off = db.$on('query', (e) => {
  if (e.duration_ms > 100) console.warn('slow query', e.sql, e.params);
});
db.$on('error', (e) => console.error(e.op, 'failed', e.error.message));
// off();  // stop listening
```

See more — **[docs/EVENTS.md](/reference/events)** for the full `QueryEvent` shape with `semanticOp`, custom sinks, sampling and privacy. **[docs/LOGGING.md](/reference/logging)** for Pino/Winston wiring, redaction, request correlation. **[docs/TRACING.md](/reference/tracing)** for OpenTelemetry spans and W3C traceparent propagation. **[docs/METRICS.md](/reference/metrics)** for Prometheus histograms with cardinality discipline. **[docs/WATCH.md](/reference/watch)** for Mongo change streams, Postgres LISTEN/NOTIFY, MySQL binlog tailing, and the WebSocket fan-out bridge for realtime UIs.

---
