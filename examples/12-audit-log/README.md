# 12 · Audit log via mutation events

[![Open in StackBlitz](https://developer.stackblitz.com/img/open_in_stackblitz.svg)](https://stackblitz.com/github/johnsonfash/forge-orm-examples/tree/main/12-audit-log)

`db.$events.on("mutation", …)` fires on every create/update/delete. Persist them as audit rows for compliance, undo, or change feeds.
