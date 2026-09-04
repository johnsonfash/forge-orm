---
title: "Transactions"
---

## Transactions

Run several writes so they all commit together or all roll back.

```ts
await db.$transaction(async (tx) => {
  const user = await tx.user.create({ data: { email: 'a@x.co', name: 'A' } });
  await tx.post.create({ data: { author_id: user.id, title: 'Hi' } });
});
```

If the callback throws, nothing is saved. You can also pass an array of queries
to run together: `await db.$transaction([db.user.findMany(), db.post.count()])`.

On Mongo, transactions need a replica set (a single-node `mongod` cannot run
them), which is the same requirement Prisma has.

**One thing to watch on Postgres:** do not catch a constraint error inside a
transaction and keep going. Postgres marks the whole transaction as failed after
any error, so the next statement fails with "current transaction is aborted."
forge rolls the transaction back cleanly and reports the original error, but the
catch-and-continue pattern will not work. Check first, use `upsert`, or let the
transaction fail and retry it.

**DuckDB** doesn't support `SAVEPOINT`, so nested transactions degrade to a
single outer one. Migration batches that abort can't partially recover.

See more — **[docs/TRANSACTIONS.md](/reference/transactions)** for callback vs array semantics, per-dialect BEGIN/COMMIT mechanics, savepoint behaviour, isolation levels, deadlock retry, Mongo replica-set rules, AsyncLocalStorage HTTP pattern, and five worked patterns.

---
