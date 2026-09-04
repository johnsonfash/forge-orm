---
title: "Streaming large results"
---

## Streaming large results

To process a large table without loading it all into memory, use
`findManyStream`. It yields rows one at a time using the driver's native cursor.

```ts
for await (const user of db.user.findManyStream({ where: { active: true } })) {
  await sendEmail(user);   // one row in memory at a time
}
```

See more — **[docs/QUERIES.md](/reference/queries#findmanystream)** for `findManyStream` internals per driver and the memory profile.

---
