# 15 · Migrations + drift detection

[![Open in StackBlitz](https://developer.stackblitz.com/img/open_in_stackblitz.svg)](https://stackblitz.com/github/johnsonfash/forge-orm-examples/tree/main/15-migrations-drift)

`db.$migrate()` is the runtime migrator — safe to call on every boot. `db.$diff()` reports what's drifted between the schema and what's running. Show it in an admin panel.
