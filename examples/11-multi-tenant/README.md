# 11 · Multi-tenant (row-level scoping)

[![Open in StackBlitz](https://developer.stackblitz.com/img/open_in_stackblitz.svg)](https://stackblitz.com/github/johnsonfash/forge-orm-examples/tree/main/11-multi-tenant)

Soft-multitenant pattern. Every row carries an `orgId`; a `scoped(orgId)` wrapper auto-injects the filter so app code can't leak across tenants.

For hard isolation, use Postgres RLS — see `18-postgres-rls-auth`.
