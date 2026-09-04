# 14 · Transactions

[![Open in StackBlitz](https://developer.stackblitz.com/img/open_in_stackblitz.svg)](https://stackblitz.com/github/johnsonfash/forge-orm-examples/tree/main/14-transactions)

`db.$transaction(async (tx) => …)`. Throws → rollback. Nested calls map to savepoints.
