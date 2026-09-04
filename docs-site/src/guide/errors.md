---
title: "Errors"
---

## Errors

Constraint and connection failures come back as a `DbKnownError` with a stable
code, so you can branch on the cause regardless of which database you are on.

```ts
import { DbKnownError } from 'forge-orm';

try {
  await db.user.create({ data: { email: 'taken@x.co', name: 'A' } });
} catch (e) {
  if (e instanceof DbKnownError && e.code === 'P2002') {
    // unique constraint violation (here, the email already exists)
  }
}
```

The codes follow Prisma's familiar set (`P2002` unique, `P2003` foreign key,
`P2004` constraint, and so on).

See more — **[docs/ERRORS.md](/reference/errors)** for the full error taxonomy, per-dialect code mapping (PG 23505 / MySQL 1062 / Mongo E11000 / MSSQL 2601), retry classes, exponential backoff with jitter, the AsyncLocalStorage retry pattern, and Sentry / Bugsnag wiring.

---
