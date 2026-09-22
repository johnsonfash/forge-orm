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

If the callback throws, nothing is saved.

**Code called from inside the callback is in the transaction too**, even when
it never sees `tx`. The session rides on `AsyncLocalStorage`, per adapter, so a
repository layer that closes over the root `db` joins the transaction instead of
escaping it:

```ts
await db.$transaction(async () => {
  await stockRepo.record(orgId, movement);    // these use the plain `db`,
  await itemRepo.incrementStock(orgId, sku);  // and are both in the transaction
});
```

That is Node only — there is no async context in the browser, where the
IndexedDB adapter has no interactive transaction to join anyway. Before 2.19.0
neither leg was in the transaction and a throw rolled back nothing, so if you
threaded `tx` through every function to work around that, you can stop.

You can also pass an **array of functions**, which run in order inside one
transaction:

```ts
await db.$transaction([
  () => db.account.update({ where: { id: from }, data: { bal: { decrement: n } } }),
  () => db.account.update({ where: { id: to },   data: { bal: { increment: n } } }),
]);
```

**Behaviour change in 2.19.0:** that array used to hold already-running
promises and was a `Promise.all` with no transaction around it. Promises are now
refused with an error showing both working forms. Add `() =>` to each element —
and note that every call site you have to change was not atomic before.

On Mongo, transactions need a replica set (a single-node `mongod` cannot run
them), which is the same requirement Prisma has. Each `createDb()` owns its own
Mongo connection as of 2.19.0, so two handles mean two databases and
`$disconnect()` on one leaves the other usable.

**One thing to watch on Postgres:** do not catch a constraint error inside a
transaction and keep going. Postgres marks the whole transaction as failed after
any error, so the next statement fails with "current transaction is aborted."
forge rolls the transaction back cleanly and reports the original error, but the
catch-and-continue pattern will not work. Check first, use `upsert`, or let the
transaction fail and retry it.

**DuckDB** doesn't support `SAVEPOINT`, so nested transactions degrade to a
single outer one. Migration batches that abort can't partially recover.

See more — **[docs/TRANSACTIONS.md](/reference/transactions)** for the ambient session and its rules, callback vs array semantics, per-dialect BEGIN/COMMIT mechanics, savepoint behaviour, isolation levels, deadlock retry, Mongo replica-set rules, the request-scoped HTTP pattern, and five worked patterns.

---
