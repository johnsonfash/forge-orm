# 02 · Offline-first with sync outbox

[![Open in StackBlitz](https://developer.stackblitz.com/img/open_in_stackblitz.svg)](https://stackblitz.com/github/johnsonfash/forge-orm-examples/tree/main/02-sqlite-browser-offline-first)

Local-first pattern: writes hit OPFS sqlite immediately (optimistic UI), and a separate `outbox` table queues the same op for later server sync. A background drainer pushes when the browser is online.

This is the same shape Dallio uses for its offline POS.
