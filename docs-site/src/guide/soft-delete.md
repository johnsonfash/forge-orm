---
title: "Soft delete"
---

## Soft delete

Mark a date column `.softDeleteAt()`. Reads then automatically skip rows where
that column is set, and you get a dedicated verb to set it, an inverse to clear
it, and the `_withDeleted` escape hatch to read past the filter.

`delete()` / `deleteMany()` are **always hard deletes** — they remove the row,
exactly like Prisma, regardless of whether the model has a soft-delete column.
The recoverable path is explicit:

```ts
const Account = model('accounts', { id: f.id(), deleted_at: f.dateTime().softDeleteAt() });

// Soft delete — sets deleted_at; the row stays but is hidden from reads.
await db.account.softDelete({ where: { id: 'a1' } });
await db.account.softDeleteMany({ where: { tenantId: 't9' } });

// Reads skip soft-deleted rows by default; opt back in with _withDeleted.
await db.account.findMany();                                   // excludes a1
await db.account.findMany({ where: { _withDeleted: true } });  // includes a1

// Restore — clears deleted_at, row is active again.
await db.account.restore({ where: { id: 'a1' } });
await db.account.restoreMany({ where: { tenantId: 't9' } });

// Hard delete — permanently removes the row (and runs cascades). No going back.
await db.account.delete({ where: { id: 'a1' } });
await db.account.deleteMany({ where: { tenantId: 't9' } });
```

`softDelete`, `softDeleteMany`, `restore`, and `restoreMany` throw if the model
has no `.softDeleteAt()` column — use `delete` for a hard delete in that case.

> **Upgrading from v1.x?** In v1, `delete()` / `deleteMany()` *silently
> soft-deleted* on models with a `.softDeleteAt()` column. **v2 makes `delete()`
> always hard.** Search your codebase for `delete(` / `deleteMany(` calls on
> soft-delete models and switch the ones that expected recoverable behavior to
> `softDelete()` / `softDeleteMany()`. See the [CHANGELOG](/reference/changelog) for
> the full migration note. This is a runtime semantic change — it will not show
> up as a type error.

See more — **[docs/SOFT-DELETE.md](/reference/soft-delete)** for partial-filter uniques that ignore soft-deleted rows, cascade restore semantics, retention-purge cron, FTS / vector / search-index interaction, GDPR caveats (soft-delete is not erasure), and 3 worked patterns.

---
