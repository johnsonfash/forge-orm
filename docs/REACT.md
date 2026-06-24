# React integration patterns

Companion to the **[Browser chapter](../README.md#browser-sqlite-wasm--opfs)** in
the README. This file is the deep-dive on React patterns — hooks, TanStack
Query / SWR integration, Suspense, server components, optimistic updates,
realtime sync, code-splitting, and testing. It assumes you have already wired
forge into a project using one of the recipes in
[BROWSER-FRAMEWORKS.md](./BROWSER-FRAMEWORKS.md#react--vite).

The install + bundler config is in **[BROWSER-FRAMEWORKS.md](./BROWSER-FRAMEWORKS.md)**.
The wasm mechanics — OPFS URL schemes, the worker file, `$migrate()`,
`browserDoctor()`, multi-tab safety — are in **[BROWSER.md](./BROWSER.md)**.
This doc covers what to build on top.

## Contents

- [Where forge runs in a React app](#where-forge-runs-in-a-react-app)
- [Hooks vs context vs singleton — sharing the `db` handle](#hooks-vs-context-vs-singleton--sharing-the-db-handle)
- [`useDb()` — the recommended hook shape](#usedb--the-recommended-hook-shape)
- [TanStack Query (React Query)](#tanstack-query-react-query)
- [SWR — the lighter alternative](#swr--the-lighter-alternative)
- [Suspense and `use()` (React 19)](#suspense-and-use-react-19)
- [Server components (Next.js App Router)](#server-components-nextjs-app-router)
- [Streaming with Suspense](#streaming-with-suspense)
- [Optimistic UI — three variants](#optimistic-ui--three-variants)
- [Error boundaries and retry](#error-boundaries-and-retry)
- [Form integration — react-hook-form + zod](#form-integration--react-hook-form--zod)
- [Realtime sync over websockets](#realtime-sync-over-websockets)
- [`BroadcastChannel` cross-tab invalidation](#broadcastchannel-cross-tab-invalidation)
- [Code-splitting the wasm worker](#code-splitting-the-wasm-worker)
- [Testing React components that use forge](#testing-react-components-that-use-forge)
- [Performance](#performance)
- [Six worked patterns](#six-worked-patterns)
- [Common bugs](#common-bugs)

---

## Where forge runs in a React app

A React app can talk to forge in two places, and they are not interchangeable.

| Where | Driver | Use it for |
|---|---|---|
| Browser, inside `'use client'` components | `wasmSqliteDriver` (SQLite over OPFS) | Offline-first, local cache, "works on the plane" UI, search-as-you-type over a local mirror |
| Server (Node, Bun, Deno, Edge runtime with a Postgres HTTP driver) — server components, server actions, route handlers, loaders | `pg`, `mysql2`, `better-sqlite3`, `mongodb`, `@duckdb/node-api`, `mssql`, or any `postgresJsDriver` / `libsqlDriver` wrapper | The main app database. Multi-user data, anything you can't put on the client, analytics |

The decision matrix:

| Question | Answer |
|---|---|
| Does the user own the data and want it offline? | Browser. `wasmSqliteDriver`, persisted on OPFS. See [BROWSER.md](./BROWSER.md). |
| Is it shared across users / devices? | Server. Postgres / Mongo / MySQL through a Node driver. |
| Both — local cache backed by a remote source of truth? | Both. Server is the source of truth; the browser DB is a derived cache you keep in sync (see [Realtime sync](#realtime-sync-over-websockets)). |
| Is the runtime an edge function (Cloudflare Workers, Vercel Edge)? | Pick a wire-compatible driver (`postgresJsDriver` over Neon's HTTP proxy, `libsqlDriver` over Turso). Plain `pg` won't fit. |

Calling `wasmSqliteDriver` from a server component crashes — there is no
`FileSystemSyncAccessHandle` outside a Web Worker, and the worker file
itself only resolves inside a browser bundle. Calling `pg` from a `'use client'`
component leaks credentials into the client bundle and fails to import (`fs`,
`net`, `tls` are absent). The boundary matters — every section below is
explicit about which side it runs on.

## Hooks vs context vs singleton — sharing the `db` handle

The forge `db` handle is a long-lived object: one Worker, one DB connection
per origin. Three patterns share it across components, and they trade off
along the same three axes — boilerplate, testability, and multi-DB support.

### Pattern A — Module singleton (recommended for 90% of apps)

```ts
// src/db/index.ts
import { createDb, wasmSqliteDriver, type ForgeDb } from 'forge-orm';
import { schema } from './schema';

let dbPromise: Promise<ForgeDb<typeof schema>> | null = null;

export function getDb() {
  if (dbPromise) return dbPromise;
  const worker = new Worker(
    new URL('forge-orm/wasm/worker', import.meta.url),
    { type: 'module' },
  );
  dbPromise = createDb({
    schema,
    driver: wasmSqliteDriver({ worker, url: 'opfs-sahpool:///app.sqlite' }),
  });
  return dbPromise;
}
```

A lazy singleton — the Worker is constructed once on first `getDb()`, then
reused everywhere. Components `await getDb()` once and cache the result in
local state, or call it inside a `useQuery`. No provider tree, no context
plumbing.

Pros: zero boilerplate, the smallest possible bundle, the simplest mental
model. Cons: hard to swap for tests (you need to mock the module), and there
is no way to run two databases side by side.

### Pattern B — Context provider

```tsx
// src/db/DbProvider.tsx
'use client';
import { createContext, useContext, useEffect, useState } from 'react';
import type { ForgeDb } from 'forge-orm';
import { getDb } from './index';
import type { schema } from './schema';

type DB = ForgeDb<typeof schema>;
const DbContext = createContext<DB | null>(null);

export function DbProvider({ children }: { children: React.ReactNode }) {
  const [db, setDb] = useState<DB | null>(null);
  useEffect(() => { getDb().then(setDb); }, []);
  if (!db) return <p>Loading database…</p>;
  return <DbContext.Provider value={db}>{children}</DbContext.Provider>;
}

export function useDb(): DB {
  const ctx = useContext(DbContext);
  if (!ctx) throw new Error('useDb() called outside <DbProvider>');
  return ctx;
}
```

Pros: dependency injection by construction — tests pass a different `DB`
through the same context. Multi-DB apps wrap separate providers (e.g. a
local-cache DB and a remote-mirror DB).

Cons: components below the provider can't render until the DB resolves, so
you end up with a single "Loading database…" gate at the root. Workable, but
worse for code-splitting — every route waits on the same promise.

### Pattern C — Per-hook construction

Don't. Every render that calls `createDb` constructs a new Worker, then
discards it on the next render — leaks until the page closes, and the new
Worker can't see writes the old Worker made. If you find yourself doing
this, hoist to Pattern A.

### Recommendation

Default to Pattern A. Switch to Pattern B when:

- The app talks to two forge DBs (e.g. local OPFS for offline + Postgres
  over HTTP for the catalogue), and components want to pick which one they
  use without an `if`.
- Tests need to inject a `:memory:` DB without import-mocking. Wrapping the
  test render in `<DbProvider value={testDb}>` is cleaner than `vi.mock('./db')`.
- The app uses React Server Components and the client tree wants a
  type-narrowed handle that knows nothing about the server driver.

## `useDb()` — the recommended hook shape

Whichever pattern you pick, expose a single `useDb()` that returns a
type-narrowed handle. The narrowed type is what gives every downstream
query autocompletion on model names + field names.

```ts
// src/db/useDb.ts (singleton variant)
'use client';
import { useEffect, useState } from 'react';
import type { ForgeDb } from 'forge-orm';
import { getDb } from './index';
import type { schema } from './schema';

export type DB = ForgeDb<typeof schema>;

export function useDb(): DB | null {
  const [db, setDb] = useState<DB | null>(null);
  useEffect(() => {
    let cancelled = false;
    getDb().then((d) => { if (!cancelled) setDb(d); });
    return () => { cancelled = true; };
  }, []);
  return db;
}
```

Two things the shape gives you:

1. `DB | null` — components handle the `null` state explicitly. Strict-mode
   double-mount is safe because the singleton de-dupes.
2. `ForgeDb<typeof schema>` — every `db.customer.findMany(...)` autocompletes
   field names, return types, and `where` operators. No `any` anywhere.

### SSR-safe access

In any SSR-capable framework (Next.js, Remix, Astro) the same component code
runs once on the server during the initial render. `wasmSqliteDriver` can't
load there. Two safe shapes:

```ts
// Approach 1 — `'use client'` boundary at the file level (Next.js App Router)
'use client';
// useDb only ever runs in the browser. The compiler ensures the file is
// excluded from the server bundle.
```

```ts
// Approach 2 — runtime guard (Remix, Astro, anywhere with an island)
export function useDb(): DB | null {
  const [db, setDb] = useState<DB | null>(null);
  useEffect(() => {
    if (typeof window === 'undefined') return;
    let cancelled = false;
    getDb().then((d) => { if (!cancelled) setDb(d); });
    return () => { cancelled = true; };
  }, []);
  return db;
}
```

The `useEffect` only runs in the browser, but the `typeof window` guard
prevents accidents in dev tools or test runners that pre-render JSX without
running effects.

## TanStack Query (React Query)

TanStack Query is the easiest fit for forge. Forge calls return promises,
TanStack Query wraps promises in a cache + invalidator + retry layer. The
two combine into the pattern most production apps use.

### Query-key factory (org-scoped)

Keys must include the orgId (or tenantId, user id — whatever scopes the
data). A flat string key collides across tenants the first time you switch
accounts in dev:

```ts
// src/db/keys.ts
export const qk = {
  customer: {
    all:  (orgId: string) => [orgId, 'customer'] as const,
    list: (orgId: string, filter?: { search?: string }) =>
      [orgId, 'customer', 'list', filter ?? {}] as const,
    one:  (orgId: string, id: string) => [orgId, 'customer', 'one', id] as const,
  },
  order: {
    all:  (orgId: string) => [orgId, 'order'] as const,
    list: (orgId: string, filter?: { status?: string }) =>
      [orgId, 'order', 'list', filter ?? {}] as const,
    one:  (orgId: string, id: string) => [orgId, 'order', 'one', id] as const,
  },
} as const;
```

Three reasons this shape pays off:

- `qk.customer.all(orgId)` is the prefix for every customer-shaped key.
  `queryClient.invalidateQueries({ queryKey: qk.customer.all(orgId) })`
  invalidates lists *and* individual fetches in one call.
- The orgId leads, so account switches don't need an explicit reset — the
  cache simply doesn't match.
- Filters are part of the key, so `useCustomers({ search: 'ali' })` and
  `useCustomers({ search: 'bob' })` cache independently.

### Per-model hooks

```ts
// src/db/hooks/customer.ts
'use client';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { getDb } from '../index';
import { qk } from '../keys';
import type { Row, InferCreate, InferUpdate } from 'forge-orm';
import { Customer } from '../schema';

type CustomerRow    = Row<typeof Customer>;
type CustomerCreate = InferCreate<typeof Customer>;
type CustomerUpdate = InferUpdate<typeof Customer>;

export function useCustomers(orgId: string, filter?: { search?: string }) {
  return useQuery({
    queryKey: qk.customer.list(orgId, filter),
    queryFn: async () => {
      const db = await getDb();
      return db.customer.findMany({
        where: filter?.search
          ? { name: { contains: filter.search, mode: 'insensitive' } }
          : undefined,
        orderBy: { created_at: 'desc' },
        take: 50,
      });
    },
    staleTime: 30_000,
  });
}

export function useCustomer(orgId: string, id: string | undefined) {
  return useQuery({
    queryKey: id ? qk.customer.one(orgId, id) : ['__noop__'],
    queryFn: async () => {
      const db = await getDb();
      return db.customer.findUnique({ where: { id: id! } });
    },
    enabled: Boolean(id),
  });
}

export function useUpsertCustomer(orgId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: CustomerCreate & { id?: string }) => {
      const db = await getDb();
      return db.customer.upsert({
        where: { email: input.email },
        create: input,
        update: { name: input.name, phone: input.phone },
      });
    },
    onMutate: async (input) => {
      // Optimistic update — apply locally before the server (or local DB)
      // responds. Snapshot for rollback.
      await qc.cancelQueries({ queryKey: qk.customer.all(orgId) });
      const prev = qc.getQueriesData<CustomerRow[]>({
        queryKey: qk.customer.list(orgId),
      });
      qc.setQueriesData<CustomerRow[]>(
        { queryKey: qk.customer.list(orgId) },
        (old = []) => {
          const idx = old.findIndex((c) => c.email === input.email);
          const next: CustomerRow = {
            id: input.id ?? `tmp-${crypto.randomUUID()}`,
            created_at: new Date(),
            updated_at: new Date(),
            ...input,
          } as CustomerRow;
          if (idx >= 0) return [...old.slice(0, idx), next, ...old.slice(idx + 1)];
          return [next, ...old];
        },
      );
      return { prev };
    },
    onError: (_err, _input, ctx) => {
      // Rollback every snapshot we took.
      ctx?.prev.forEach(([key, data]) => qc.setQueryData(key, data));
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: qk.customer.all(orgId) });
    },
  });
}

export function useDeleteCustomer(orgId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const db = await getDb();
      await db.customer.delete({ where: { id } });
    },
    onMutate: async (id) => {
      await qc.cancelQueries({ queryKey: qk.customer.all(orgId) });
      const prev = qc.getQueriesData<CustomerRow[]>({
        queryKey: qk.customer.list(orgId),
      });
      qc.setQueriesData<CustomerRow[]>(
        { queryKey: qk.customer.list(orgId) },
        (old = []) => old.filter((c) => c.id !== id),
      );
      return { prev };
    },
    onError: (_e, _id, ctx) => ctx?.prev.forEach(([k, d]) => qc.setQueryData(k, d)),
    onSettled: () => qc.invalidateQueries({ queryKey: qk.customer.all(orgId) }),
  });
}
```

The component is short:

```tsx
'use client';
import { useCustomers, useUpsertCustomer } from '@/db/hooks/customer';

export function CustomersScreen({ orgId }: { orgId: string }) {
  const customers = useCustomers(orgId);
  const upsert    = useUpsertCustomer(orgId);

  if (customers.isPending) return <p>Loading…</p>;
  if (customers.error)     return <p>Error: {String(customers.error)}</p>;

  return (
    <ul>
      {customers.data.map((c) => <li key={c.id}>{c.name}</li>)}
      <li>
        <button onClick={() => upsert.mutate({ name: 'Ada', email: 'ada@x.co' })}>
          Add Ada
        </button>
      </li>
    </ul>
  );
}
```

### A few notes on the pattern

- `staleTime: 30_000` means the cache stays fresh for 30 seconds — switching
  tabs back inside that window doesn't refetch. Crank it up for read-mostly
  data; drop it to `0` for "always refetch" screens.
- `onMutate` returns a `prev` snapshot used by `onError` for rollback.
  Without that, an error leaves the optimistic row in the UI forever.
- `onSettled` always invalidates — success *and* failure — so the final
  on-screen state matches the DB even if the optimistic guess was wrong.
- `enabled: Boolean(id)` is the standard way to avoid running the query
  before the parameter is known. The dummy `['__noop__']` key keeps the
  type checker happy.

## SWR — the lighter alternative

SWR ships smaller (~5 KB gz vs ~13 KB) and has a tighter API. For
read-heavy apps with simple mutations it's a better fit:

```ts
// src/db/hooks/customer-swr.ts
'use client';
import useSWR, { mutate } from 'swr';
import useSWRMutation from 'swr/mutation';
import { getDb } from '../index';
import type { Row, InferCreate } from 'forge-orm';
import { Customer } from '../schema';

type CustomerRow = Row<typeof Customer>;

export function useCustomers(orgId: string, search?: string) {
  return useSWR<CustomerRow[]>(
    [orgId, 'customer', { search }],
    async () => {
      const db = await getDb();
      return db.customer.findMany({
        where: search ? { name: { contains: search } } : undefined,
        orderBy: { created_at: 'desc' },
        take: 50,
      });
    },
    { dedupingInterval: 30_000 },
  );
}

export function useUpsertCustomer(orgId: string) {
  return useSWRMutation(
    [orgId, 'customer'],
    async (_key, { arg }: { arg: InferCreate<typeof Customer> }) => {
      const db = await getDb();
      return db.customer.upsert({
        where: { email: arg.email },
        create: arg,
        update: { name: arg.name, phone: arg.phone },
      });
    },
    {
      onSuccess: () => mutate((key) => Array.isArray(key) && key[0] === orgId && key[1] === 'customer'),
    },
  );
}
```

### Pick SWR when

- The app is read-mostly. SWR's stale-while-revalidate model is built for
  this; no `staleTime` tuning needed.
- Bundle size matters (marketing site, embeddable widget).
- You don't need mutation queues, retry-on-reconnect with backoff, or
  paused/resumed background fetching — SWR can be coaxed into all of these,
  but TanStack Query has them by default.

### Stay on TanStack Query when

- You need a real offline mutation queue (`onlineManager` + `mutationCache`
  resumes on reconnect).
- You want `useSuspenseQuery` first-class.
- You're already using its devtools — they're significantly more developed
  than SWR's.

Both libraries integrate with forge the same way: `queryFn`/fetcher calls
`await getDb()` and returns the forge result. No adapter layer in between.

## Suspense and `use()` (React 19)

React 19's `use()` lets a component unwrap a promise inside Suspense. Forge
calls return plain promises, so they compose directly:

```tsx
'use client';
import { use, Suspense } from 'react';
import { getDb } from '@/db';

function CustomerList() {
  const db = use(getDb());                              // suspends until DB is ready
  const customers = use(db.customer.findMany({ take: 50 })); // suspends until query resolves
  return <ul>{customers.map((c) => <li key={c.id}>{c.name}</li>)}</ul>;
}

export default function Page() {
  return (
    <Suspense fallback={<p>Loading customers…</p>}>
      <CustomerList />
    </Suspense>
  );
}
```

Two gotchas:

1. `use()` requires a *stable* promise reference across renders. If you
   inline `use(db.customer.findMany({...}))`, every render constructs a new
   promise — Suspense never resolves. Cache the promise:

   ```tsx
   const promiseRef = useRef<Promise<CustomerRow[]> | null>(null);
   if (!promiseRef.current) promiseRef.current = db.customer.findMany({ take: 50 });
   const customers = use(promiseRef.current);
   ```

   In practice you almost always combine `use()` with `useSuspenseQuery`
   from TanStack Query, which handles promise caching for you.

2. `Suspense` only catches *async* suspension. A thrown render-time error
   needs an `ErrorBoundary` — see [Error boundaries](#error-boundaries-and-retry).

### `startTransition` for non-blocking updates

When a filter change should *not* show the spinner — search-as-you-type,
filter chips, tab switches — wrap the state update in `startTransition`:

```tsx
import { useState, useTransition } from 'react';

function CustomerSearch() {
  const [search, setSearch] = useState('');
  const [isPending, startTransition] = useTransition();
  // ... fetch using `search`

  return (
    <input
      onChange={(e) => {
        const v = e.target.value;
        startTransition(() => setSearch(v));
      }}
      style={{ opacity: isPending ? 0.6 : 1 }}
    />
  );
}
```

The current (stale) results stay rendered while the new query loads. No
spinner flash; the input dims slightly to signal work in flight.

## Server components (Next.js App Router)

Next.js App Router gives forge three places to live on the server:

| Where | Shape | When |
|---|---|---|
| **Server component** (the default in `/app`) | `async function Page() { const data = await db.x.findMany(...); return <ul>...</ul>; }` | Read-only initial render. Streams HTML. |
| **Server action** (`'use server'` function) | Called from a form `action={fn}` or `useFormState`. Returns serialisable data. | Mutations. Auto-revalidates the page. |
| **Route handler** (`/app/api/.../route.ts`) | Returns a `Response`. Used by client-side `fetch` and third parties. | Public JSON APIs, webhooks, edge endpoints. |

### A server component reading Postgres

```ts
// app/db/server.ts
import 'server-only';
import { createDb } from 'forge-orm';
import { schema } from './schema';

let dbPromise: ReturnType<typeof createDb<typeof schema>> | null = null;
export function getServerDb() {
  if (!dbPromise) dbPromise = createDb({ url: process.env.DATABASE_URL!, schema });
  return dbPromise;
}
```

```tsx
// app/customers/page.tsx
import { getServerDb } from '@/app/db/server';

export default async function CustomersPage() {
  const db = await getServerDb();
  const rows = await db.customer.findMany({ take: 50, orderBy: { created_at: 'desc' } });
  return (
    <ul>
      {rows.map((c) => <li key={c.id}>{c.name}</li>)}
    </ul>
  );
}
```

The `import 'server-only'` directive (or marking the file `.server.ts`)
makes the Next compiler error out if a client component imports the module.
That's the cheap defence against leaking the Postgres URL into the browser
bundle.

### A server action for the mutation

```tsx
// app/customers/actions.ts
'use server';
import { revalidatePath } from 'next/cache';
import { getServerDb } from '@/app/db/server';

export async function createCustomer(formData: FormData) {
  const db = await getServerDb();
  await db.customer.create({
    data: {
      name:  String(formData.get('name')),
      email: String(formData.get('email')),
    },
  });
  revalidatePath('/customers');
}
```

```tsx
// app/customers/CreateForm.tsx
import { createCustomer } from './actions';

export function CreateForm() {
  return (
    <form action={createCustomer}>
      <input name="name" required />
      <input name="email" type="email" required />
      <button>Add</button>
    </form>
  );
}
```

No client JS for the form. `revalidatePath` invalidates the server
component cache; the next render fetches fresh data.

### When the browser DB wins instead

Server reads are the right call for:

- Multi-user, multi-tenant data backed by a real RDBMS.
- Analytics, large joins, anything PG can do in 50 ms that a wasm SQLite
  would do in 5 s.
- Pages with no offline requirement.

Browser reads (wasm SQLite over OPFS) win when:

- The data is local-first by design (Tauri, offline POS, field-engineer
  app).
- The roundtrip cost is the bottleneck (every keypress in a fuzzy search
  over 10k local records).
- The app must work without network.

Many apps want both — the [Realtime sync](#realtime-sync-over-websockets)
section covers the hybrid shape.

## Streaming with Suspense

`db.x.findManyStream(...)` returns an async iterator instead of a single
array (see the [Streaming large results](../README.md#streaming-large-results)
section of the README). In a server component, you bridge the iterator to
React's streaming SSR with chunked Suspense:

```tsx
// app/reports/page.tsx
import { Suspense } from 'react';
import { getServerDb } from '@/app/db/server';

async function FirstPage() {
  const db = await getServerDb();
  const iter = db.event.findManyStream({ orderBy: { ts: 'desc' }, batchSize: 200 });
  const out: React.ReactNode[] = [];
  let count = 0;
  for await (const row of iter) {
    out.push(<tr key={row.id}><td>{row.ts.toISOString()}</td><td>{row.kind}</td></tr>);
    if (++count >= 200) break;
  }
  return <>{out}</>;
}

async function RestOfRows() {
  // Second Suspense boundary streams in after FirstPage flushes.
  const db = await getServerDb();
  const iter = db.event.findManyStream({ orderBy: { ts: 'desc' }, batchSize: 500, skip: 200 });
  const out: React.ReactNode[] = [];
  for await (const row of iter) {
    out.push(<tr key={row.id}><td>{row.ts.toISOString()}</td><td>{row.kind}</td></tr>);
  }
  return <>{out}</>;
}

export default function Page() {
  return (
    <table>
      <tbody>
        <Suspense fallback={<tr><td>Loading…</td></tr>}>
          <FirstPage />
        </Suspense>
        <Suspense fallback={<tr><td>Loading more…</td></tr>}>
          <RestOfRows />
        </Suspense>
      </tbody>
    </table>
  );
}
```

The browser sees the first 200 rows as soon as they render — Next streams
the HTML out, then flushes the remaining rows when `RestOfRows` resolves.
The user can scroll the first batch while the rest is still loading.

## Optimistic UI — three variants

Three patterns ship with different latency / correctness trade-offs. Pick by
how much you trust the optimistic guess.

### (a) Immediate update, rollback on error

The default. Apply the change locally, send to the server, roll back if the
server rejects. Already shown above in [TanStack Query](#tanstack-query-react-query):
`onMutate` snapshots, `onError` restores.

Use it when the server almost always accepts. Constraint violations and
network errors are visible as a UI flicker — that's acceptable.

### (b) Apply only after ack, but stale-while-revalidate

Don't touch the UI until the server confirms. Show the existing (stale)
list during the call:

```ts
export function useCreateCustomerSafe(orgId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: InferCreate<typeof Customer>) => {
      const db = await getDb();
      return db.customer.create({ data: input });
    },
    onSuccess: (row) => {
      // Cheap merge: append the new row instead of refetching the full list.
      qc.setQueriesData<CustomerRow[]>(
        { queryKey: qk.customer.list(orgId) },
        (old = []) => [row, ...old],
      );
    },
    onSettled: () => qc.invalidateQueries({ queryKey: qk.customer.all(orgId) }),
  });
}
```

Use it for mutations whose outcome the client can't predict (server-assigned
ids, server-side validation that filters input).

### (c) CRDT-style merge for offline-first

Writes happen against the local DB first, get a temporary id, and reconcile
when the server replies. The `id` rewrite is the only awkward part:

```ts
export function useCreateCustomerOffline(orgId: string) {
  return useMutation({
    mutationFn: async (input: InferCreate<typeof Customer>) => {
      const db = await getDb();
      // 1. Insert locally with a UUID — works offline.
      const local = await db.customer.create({
        data: { ...input, id: crypto.randomUUID() },
      });
      // 2. Enqueue for sync (see Realtime sync). The sync layer will
      //    replace `local.id` with the server's id on first success.
      await enqueueOutbox({ op: 'create', model: 'customer', row: local });
      return local;
    },
    // No invalidation — the local write is the source of truth until
    // sync completes.
  });
}
```

See [Realtime sync](#realtime-sync-over-websockets) for the outbox shape and
the id-rewrite step.

## Error boundaries and retry

Wrap any subtree that calls forge in an error boundary. TanStack Query
re-throws errors into render when `throwOnError: true`, so a single boundary
catches every shape of failure:

```tsx
'use client';
import { Component, type ReactNode } from 'react';

export class DbErrorBoundary extends Component<
  { children: ReactNode; fallback: (err: Error, retry: () => void) => ReactNode },
  { err: Error | null }
> {
  state = { err: null };
  static getDerivedStateFromError(err: Error) { return { err }; }
  render() {
    if (this.state.err) return this.props.fallback(this.state.err, () => this.setState({ err: null }));
    return this.props.children;
  }
}
```

```tsx
<DbErrorBoundary
  fallback={(err, retry) => (
    <div>
      <p>Something went wrong: {err.message}</p>
      <button onClick={retry}>Retry</button>
    </div>
  )}
>
  <CustomersScreen orgId={orgId} />
</DbErrorBoundary>
```

### Transient vs permanent

The retry button is only useful for *transient* errors. Distinguish:

- **Transient** — network blip, optimistic concurrency conflict (`If-Match`
  precondition failed), Worker not yet booted. Retry once or twice with
  backoff.
- **Permanent** — unique constraint violation, validation rejection, the
  user is not authorized. No amount of retry helps; show a useful message.

Forge throws typed errors from `forge-orm` — `UniqueConstraintError`,
`ValidationError`, `NotFoundError`. Branch on those:

```ts
import { UniqueConstraintError } from 'forge-orm';

try {
  await db.customer.create({ data: input });
} catch (err) {
  if (err instanceof UniqueConstraintError && err.column === 'email') {
    setFormError('email', 'That email is already taken');
    return;
  }
  throw err; // let the boundary handle it
}
```

### Idempotency-Key for retries

Server-side mutations exposed through a server action or route handler
should accept an `Idempotency-Key` header (or argument). Generate one per
mutation attempt on the client, send it on every retry. The server checks
it against a short-lived store before performing the write.

```ts
const idempotencyKey = useRef(crypto.randomUUID());
const upsert = useMutation({
  mutationFn: async (input) => {
    return fetch('/api/customers', {
      method: 'POST',
      headers: { 'Idempotency-Key': idempotencyKey.current },
      body: JSON.stringify(input),
    });
  },
});
```

This makes retry safe — a duplicate POST is dropped on the server. Without
it, the second POST creates a duplicate row.

## Form integration — react-hook-form + zod

The chain is: form values → zod schema → `InferCreate<typeof Model>` →
`db.x.create({ data })`. The zod schema validates *before* forge sees the
data, and the inferred type lines up with `InferCreate` so the call type-checks.

```tsx
'use client';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import type { InferCreate } from 'forge-orm';
import { Customer } from '@/db/schema';
import { useUpsertCustomer } from '@/db/hooks/customer';

const formSchema = z.object({
  name:  z.string().min(1).max(120),
  email: z.string().email(),
  phone: z.string().optional(),
}) satisfies z.ZodType<Omit<InferCreate<typeof Customer>, 'id' | 'created_at' | 'updated_at'>>;

type FormValues = z.infer<typeof formSchema>;

export function CustomerForm({ orgId }: { orgId: string }) {
  const { register, handleSubmit, formState: { errors, isSubmitting } } =
    useForm<FormValues>({ resolver: zodResolver(formSchema) });
  const upsert = useUpsertCustomer(orgId);

  return (
    <form
      onSubmit={handleSubmit(async (values) => {
        await upsert.mutateAsync(values);
      })}
    >
      <input {...register('name')}  placeholder="Name" />
      {errors.name  && <small>{errors.name.message}</small>}
      <input {...register('email')} placeholder="Email" />
      {errors.email && <small>{errors.email.message}</small>}
      <input {...register('phone')} placeholder="Phone (optional)" />
      <button disabled={isSubmitting}>Save</button>
    </form>
  );
}
```

The `satisfies` clause is the load-bearing line. If you rename a field on
`Customer` and forget to update the form, the file won't compile.

### Partial updates

`InferUpdate<typeof Customer>` makes every field optional. Build the form
schema from that:

```ts
const updateSchema = z.object({
  name:  z.string().min(1).max(120).optional(),
  email: z.string().email().optional(),
  phone: z.string().optional(),
}) satisfies z.ZodType<Omit<InferUpdate<typeof Customer>, 'id' | 'created_at' | 'updated_at'>>;
```

Then the mutation passes only the dirty fields to `db.customer.update`:

```ts
import { formState } from 'react-hook-form';
const dirty = Object.fromEntries(
  Object.entries(values).filter(([k]) => formState.dirtyFields[k]),
);
await db.customer.update({ where: { id }, data: dirty });
```

## Realtime sync over websockets

The pattern shared by every offline-first app: the browser is the source of
truth for the user's local view; the server is the source of truth for
everyone else's view; a websocket keeps them in sync.

```ts
// src/sync/ws.ts
import { getDb } from '@/db';
import { queryClient } from '@/query-client';
import { qk } from '@/db/keys';

type ServerEvent =
  | { kind: 'customer.upserted'; orgId: string; row: CustomerRow }
  | { kind: 'customer.deleted';  orgId: string; id: string };

export function startSync(orgId: string, token: string) {
  const ws = new WebSocket(`wss://api.example.com/v1/stream?org=${orgId}&t=${token}`);
  ws.onmessage = async (ev) => {
    const msg = JSON.parse(ev.data) as ServerEvent;
    const db = await getDb();
    switch (msg.kind) {
      case 'customer.upserted':
        await db.customer.upsert({
          where:  { id: msg.row.id },
          create: msg.row,
          update: msg.row,
        });
        queryClient.invalidateQueries({ queryKey: qk.customer.all(orgId) });
        break;
      case 'customer.deleted':
        await db.customer.delete({ where: { id: msg.id } });
        queryClient.invalidateQueries({ queryKey: qk.customer.all(orgId) });
        break;
    }
  };
  return () => ws.close();
}
```

### The outbox — writes happen offline, sync when online

```ts
// src/sync/outbox.ts
import { getDb } from '@/db';

type OutboxOp =
  | { id: string; op: 'create'; model: 'customer'; row: CustomerRow }
  | { id: string; op: 'update'; model: 'customer'; rowId: string; patch: Partial<CustomerRow> }
  | { id: string; op: 'delete'; model: 'customer'; rowId: string };

export async function enqueueOutbox(op: Omit<OutboxOp, 'id'>) {
  const db = await getDb();
  await db.outbox.create({ data: { id: crypto.randomUUID(), ...op, status: 'pending' } });
  void drainOutbox();
}

export async function drainOutbox() {
  if (!navigator.onLine) return;
  const db = await getDb();
  const pending = await db.outbox.findMany({
    where: { status: 'pending' },
    orderBy: { created_at: 'asc' },
    take: 50,
  });
  for (const op of pending) {
    try {
      const res = await fetch(`/api/sync/${op.model}`, {
        method: 'POST',
        headers: { 'Idempotency-Key': op.id },
        body: JSON.stringify(op),
      });
      if (!res.ok) throw new Error(`${res.status}`);
      const { id: serverId } = await res.json();
      // Rewrite the local id to the server-assigned id (for `create` ops).
      if (op.op === 'create' && serverId !== op.row.id) {
        await db.customer.update({ where: { id: op.row.id }, data: { id: serverId } });
      }
      await db.outbox.update({ where: { id: op.id }, data: { status: 'done' } });
    } catch {
      // Stay pending; try again on next `online` event.
      break;
    }
  }
}

addEventListener('online',  drainOutbox);
```

The outbox table sits in the local OPFS DB, so a power loss between
"local write" and "server ack" doesn't lose the operation. On reconnect,
`drainOutbox` walks pending ops in order; the `Idempotency-Key` (the op's
own id) prevents duplicates if a retry beats the server's first reply.

## `BroadcastChannel` cross-tab invalidation

Two tabs of the same app share the OPFS DB (`opfs-sahpool:` is multi-tab
safe — see [BROWSER.md](./BROWSER.md#multi-tab-safety)) but TanStack Query
caches are *per-tab*. A write in tab A doesn't invalidate tab B's cache by
itself. `BroadcastChannel` bridges the gap:

```ts
// src/sync/cross-tab.ts
import { queryClient } from '@/query-client';
import { qk } from '@/db/keys';

const bc = new BroadcastChannel('forge-app');

type Msg = { kind: 'invalidate'; orgId: string; model: 'customer' | 'order' };

export function broadcastInvalidate(orgId: string, model: Msg['model']) {
  bc.postMessage({ kind: 'invalidate', orgId, model } satisfies Msg);
}

bc.onmessage = (ev) => {
  const msg = ev.data as Msg;
  if (msg.kind === 'invalidate') {
    const factory = qk[msg.model];
    queryClient.invalidateQueries({ queryKey: factory.all(msg.orgId) });
  }
};
```

Wire `broadcastInvalidate(orgId, 'customer')` into the mutation's
`onSuccess`:

```ts
useMutation({
  mutationFn: ...,
  onSuccess: () => {
    qc.invalidateQueries({ queryKey: qk.customer.all(orgId) });
    broadcastInvalidate(orgId, 'customer');
  },
});
```

Now two tabs of the same app stay in sync without a server roundtrip — the
DB write happens once in the shared OPFS file; both tabs invalidate their
caches and refetch from local.

## Code-splitting the wasm worker

The sqlite-wasm bundle is ~1 MB gzipped. A marketing page that doesn't
touch the DB shouldn't pay that cost. Two techniques.

### Route-level code split

In a router that uses dynamic imports (Vite + React Router, Next App
Router, etc.), put DB access behind a lazy route:

```ts
// router.tsx
import { lazy } from 'react';
const CustomersScreen = lazy(() => import('./CustomersScreen'));
```

`CustomersScreen` imports `getDb`. The wasm chunk is part of that bundle —
the marketing page (a sibling route that doesn't import `getDb`) ships
without it.

### Conditional `getDb()`

Even within a single-page app, a `getDb()` call inside a `useEffect` causes
the wasm chunk to download only when the effect runs. For pages that mostly
serve cached data from an API, you can prefer the network and only fall
through to local DB on offline:

```ts
useEffect(() => {
  let cancelled = false;
  fetch('/api/customers')
    .then((r) => r.json())
    .then((rows) => !cancelled && setRows(rows))
    .catch(async () => {
      // Network failed — pay the wasm cost only now.
      const db = await getDb();
      const local = await db.customer.findMany({ take: 50 });
      if (!cancelled) setRows(local);
    });
  return () => { cancelled = true; };
}, []);
```

### Measure with `--analyze`

Run `npm run build -- --analyze` (Vite) or `next build --profile` (Next)
and check that the wasm chunk is in its own bundle file, lazy-loaded. A
top-level `import { getDb } from '@/db'` in a layout file defeats the
splitting — anything above the lazy boundary eagerly pulls the chunk in.

## Testing React components that use forge

The standard kit: Vitest + Testing Library + an in-memory SQLite DB. The
in-memory driver runs in Node — no wasm worker needed in tests.

### `vitest.setup.ts`

```ts
import { createDb, sqliteDriver } from 'forge-orm';
import { schema } from '@/db/schema';

export async function makeTestDb() {
  const db = await createDb({
    url: ':memory:',
    schema,
    driver: sqliteDriver({ /* better-sqlite3 in-memory */ }),
  });
  await db.$migrate();
  return db;
}
```

### Per-test transaction with rollback

Resetting the DB between tests can be slow. Wrap each test in a transaction
and roll it back:

```ts
import { beforeEach, afterEach, test, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { DbProvider } from '@/db/DbProvider';
import { makeTestDb } from './setup';
import { CustomersScreen } from '@/screens/CustomersScreen';

let db: Awaited<ReturnType<typeof makeTestDb>>;
let tx: any;

beforeEach(async () => {
  db = await makeTestDb();
  // Begin a tx; commit/rollback happens in afterEach.
  await db.$executeRaw`BEGIN`;
});
afterEach(async () => {
  await db.$executeRaw`ROLLBACK`;
  await db.$disconnect();
});

test('renders customers', async () => {
  await db.customer.create({ data: { name: 'Ada', email: 'ada@x.co' } });
  render(
    <DbProvider value={db}>
      <CustomersScreen orgId="org-1" />
    </DbProvider>,
  );
  expect(await screen.findByText('Ada')).toBeInTheDocument();
});
```

### Mocking `db` via context override

If you're using Pattern B (context), the test override is a single prop:

```tsx
render(<DbProvider value={db}><Subject /></DbProvider>);
```

If you're using Pattern A (singleton), use Vitest's `vi.mock`:

```ts
vi.mock('@/db', () => ({ getDb: async () => testDb }));
```

Pattern B is the easier shape to test — context override is mechanical;
module mocking has a hoisting trap and confuses HMR.

### Snapshot `db.$diff()` against the schema

A subtle test that catches schema drift across the suite — the test DB
should match the production schema. Add a sanity check:

```ts
test('no drift between schema and DB', async () => {
  const report = await db.$diff();
  expect(report.inSync).toBe(true);
  expect(report.items).toEqual([]);
});
```

When a developer changes a model but forgets to update `$migrate` or a
migration, this test flags it before the change reaches CI.

## Performance

### Select only what you render

```ts
// Bad — loads every column, including the 50 KB `notes` blob, for the
// list view.
db.customer.findMany({ orderBy: { name: 'asc' }, take: 50 });

// Better — list only needs id + name + email.
db.customer.findMany({
  select: { id: true, name: true, email: true },
  orderBy: { name: 'asc' },
  take: 50,
});
```

The wasm path serialises every selected field across the worker
boundary. Halving the payload halves the time spent in `postMessage`.

### Cursor pagination, not offset

`take` + `skip` walks the offset every time. For large lists, switch to
cursor pagination — see
[Sorting and pagination](../README.md#sorting-and-pagination) in the README.

```ts
// First page
const first = await db.event.findMany({ take: 50, orderBy: { id: 'desc' } });
// Next page — passes the last id as a cursor
const next = await db.event.findMany({
  take: 50,
  orderBy: { id: 'desc' },
  cursor: { id: first[first.length - 1].id },
  skip: 1, // skip the cursor row itself
});
```

### Windowed lists for huge result sets

`react-window` (or `@tanstack/react-virtual`) renders only the visible rows.
Combine with cursor pagination for a "swipe through 100k rows" UX:

```tsx
import { FixedSizeList } from 'react-window';
// ... fetch rows in batches of 200 via `useInfiniteQuery`
<FixedSizeList height={600} itemCount={rows.length} itemSize={40} width="100%">
  {({ index, style }) => <div style={style}>{rows[index].name}</div>}
</FixedSizeList>
```

### Memo the db handle

`getDb()` returns the same singleton, but referencing it through `useDb()`
still gives a new closure each render. Memoise any callback that wraps it:

```ts
const onSave = useCallback(async (input: ...) => {
  const db = await getDb();
  await db.customer.upsert({ ... });
}, []);
```

Without `useCallback`, child components that take `onSave` as a prop
re-render every time the parent does.

## Six worked patterns

### (a) TanStack Query + forge — full CRUD for `Customer`

Shown above end-to-end in [TanStack Query](#tanstack-query-react-query):
`useCustomers`, `useCustomer`, `useUpsertCustomer`, `useDeleteCustomer`,
the key factory, and a calling component. Drop those four hooks into any
new model — the shape never changes.

### (b) Offline-first POS that queues writes locally

```tsx
'use client';
import { useMutation } from '@tanstack/react-query';
import { getDb } from '@/db';
import { enqueueOutbox } from '@/sync/outbox';

export function useSell() {
  return useMutation({
    mutationFn: async (sale: {
      items: { sku: string; qty: number; unit_cents: number }[];
      tendered_cents: number;
    }) => {
      const db = await getDb();
      // Local write — the receipt prints from this.
      const receipt = await db.sale.create({
        data: {
          id: crypto.randomUUID(),
          ...sale,
          total_cents: sale.items.reduce((s, i) => s + i.qty * i.unit_cents, 0),
        },
      });
      // Enqueue for server sync. Drains automatically on reconnect.
      await enqueueOutbox({ op: 'create', model: 'sale', row: receipt });
      return receipt;
    },
  });
}
```

The cashier never waits on the network — the local DB is the source of
truth for the till; sync to head office happens in the background.

### (c) Realtime collab dashboard with WS + optimistic updates

```tsx
'use client';
import { useEffect } from 'react';
import { startSync } from '@/sync/ws';
import { useUpsertCustomer } from '@/db/hooks/customer';

export function CollabDashboard({ orgId, token }: { orgId: string; token: string }) {
  useEffect(() => startSync(orgId, token), [orgId, token]);
  const upsert = useUpsertCustomer(orgId);
  // ... renders the customer list with the existing `useCustomers` hook.
  // Optimistic onMutate above gives instant feedback;
  // WS pushes from other collaborators land via `startSync`.
  return <CustomersScreen orgId={orgId} />;
}
```

Each user's mutation: optimistic in their own UI, broadcast via WS to
every other collaborator, who apply it to their local DB. Local DB +
TanStack Query stay consistent.

### (d) Server-component analytics page (Next.js) reading PG

```tsx
// app/dashboard/page.tsx
import { getServerDb } from '@/app/db/server';

export const revalidate = 60; // ISR — regenerate at most every 60s.

export default async function Dashboard() {
  const db = await getServerDb();
  const [totals, byRegion] = await Promise.all([
    db.order.aggregate({ _sum: { total_cents: true }, _count: true }),
    db.order.groupBy({
      by: ['region'],
      _sum: { total_cents: true },
      _count: true,
      orderBy: { _sum: { total_cents: 'desc' } },
    }),
  ]);
  return (
    <main>
      <h1>Last quarter</h1>
      <p>{totals._count} orders, ${totals._sum.total_cents! / 100}</p>
      <table>
        {byRegion.map((r) => (
          <tr key={r.region}>
            <td>{r.region}</td>
            <td>{r._count}</td>
            <td>${r._sum.total_cents! / 100}</td>
          </tr>
        ))}
      </table>
    </main>
  );
}
```

Runs on the server, hits PG once per minute, streams HTML to the client.
No client-side JS for the page; no API endpoint to write.

### (e) Form wizard with multi-step validation + final atomic upsert

```tsx
'use client';
import { useState } from 'react';
import { z } from 'zod';
import { getDb } from '@/db';

const step1 = z.object({ name: z.string().min(1), email: z.string().email() });
const step2 = z.object({ phone: z.string().optional() });
const step3 = z.object({ address: z.string().min(1) });

type Draft = z.infer<typeof step1> & z.infer<typeof step2> & z.infer<typeof step3>;

export function CustomerWizard() {
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [draft, setDraft] = useState<Partial<Draft>>({});

  async function submit() {
    const final = { ...step1.parse(draft), ...step2.parse(draft), ...step3.parse(draft) };
    const db = await getDb();
    // One atomic upsert — no partial state if a constraint fires.
    await db.customer.upsert({
      where:  { email: final.email },
      create: final,
      update: { name: final.name, phone: final.phone, address: final.address },
    });
  }

  // ... render the current step, advance on Next, call submit on the last step.
  return null;
}
```

Each step validates a slice of the draft locally; the final submit is one
forge `upsert` so the DB never sees a half-applied wizard.

### (f) Search-as-you-type with debounce + cursor pagination

```tsx
'use client';
import { useState, useDeferredValue, useTransition } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import { getDb } from '@/db';

export function CustomerSearch({ orgId }: { orgId: string }) {
  const [raw, setRaw] = useState('');
  const search = useDeferredValue(raw);   // debounce via React's deferred values
  const [isPending, startTransition] = useTransition();

  const q = useInfiniteQuery({
    queryKey: [orgId, 'customer', 'search', search],
    initialPageParam: undefined as string | undefined,
    queryFn: async ({ pageParam }) => {
      const db = await getDb();
      const rows = await db.customer.findMany({
        where: search ? { name: { contains: search, mode: 'insensitive' } } : undefined,
        orderBy: { id: 'asc' },
        take: 50,
        ...(pageParam ? { cursor: { id: pageParam }, skip: 1 } : {}),
      });
      return { rows, nextCursor: rows.length === 50 ? rows[49].id : undefined };
    },
    getNextPageParam: (p) => p.nextCursor,
  });

  return (
    <div>
      <input
        value={raw}
        onChange={(e) => startTransition(() => setRaw(e.target.value))}
        style={{ opacity: isPending ? 0.6 : 1 }}
      />
      {q.data?.pages.flatMap((p) => p.rows).map((c) => <div key={c.id}>{c.name}</div>)}
      {q.hasNextPage && <button onClick={() => q.fetchNextPage()}>More</button>}
    </div>
  );
}
```

`useDeferredValue` delays the search update; `startTransition` keeps the
input snappy; cursor pagination keeps each page cheap even if 100k
customers match.

## Common bugs

### Calling forge in a server component when the driver is wasm

```ts
// app/customers/page.tsx  ← server component
import { getDb } from '@/db'; // wraps wasmSqliteDriver
export default async function Page() {
  const db = await getDb(); // crash: `Worker is not defined`
}
```

The wasm driver requires a browser. Either move the read to a `'use client'`
component, or split the module: one file for the wasm `getDb`, another for
the server `getServerDb` that uses a Node driver, and import the right one
per surface.

### Re-creating the db handle on every render

```tsx
function Bad() {
  const db = createDb({ ... }); // new Worker on every render
  // ...
}
```

Always hoist `createDb` outside the component, or behind `getDb()` as
shown. The lazy singleton pattern is the cheapest fix.

### TanStack Query key collisions across orgs

```ts
// Wrong — every org shares the same cache entry, switching accounts
// briefly shows the previous org's data.
useQuery({ queryKey: ['customers'], queryFn: () => ... });

// Right — orgId leads the key.
useQuery({ queryKey: [orgId, 'customer', 'list'], queryFn: () => ... });
```

The org-scoped key factory in [TanStack Query](#tanstack-query-react-query)
solves this once across every model — use it from day one rather than
retrofitting later.

### `findUnique` returns null and the UI crashes

```ts
// Wrong — assumes non-null.
const c = await db.customer.findUnique({ where: { id } });
return <h1>{c.name}</h1>; // TypeError when c is null
```

`findUnique` is `T | null`. Handle the null branch:

```tsx
const { data: customer, isPending } = useCustomer(orgId, id);
if (isPending) return <p>Loading…</p>;
if (!customer) return <p>Not found</p>;
return <h1>{customer.name}</h1>;
```

If "missing means error" is the right semantic, use `findUniqueOrThrow`
instead — it surfaces a `NotFoundError` the boundary can catch.

### Forgetting `useCallback` around the db handle

Inline mutations re-create on every render and break referential equality
for memoised children. Wrap any callback that closes over a forge call in
`useCallback`, as covered in [Performance](#performance).

### Suspense fallback flashes on every keystroke

A `useSuspenseQuery` whose key includes the search term re-suspends on
every keystroke. Wrap the state update in `startTransition` (see
[Suspense and `use()`](#suspense-and-use-react-19)) so the previous results
stay rendered while the new query loads.

### `BroadcastChannel` echo loop

Listening to your own `BroadcastChannel.postMessage` calls invalidates the
sender too. Two tabs ping-pong if the invalidation triggers another write.
Skip the echo by tagging messages with a per-tab id:

```ts
const tabId = crypto.randomUUID();
bc.postMessage({ ...msg, from: tabId });
bc.onmessage = (ev) => {
  if (ev.data.from === tabId) return; // ignore own messages
  // ...
};
```

---

See also:

- [BROWSER.md](./BROWSER.md) — the wasm adapter, OPFS, `$migrate`,
  `browserDoctor`, multi-tab safety.
- [BROWSER-FRAMEWORKS.md](./BROWSER-FRAMEWORKS.md) — install + bundler
  config for React + Vite, Next.js, Vue, Nuxt, SvelteKit, Angular,
  SolidStart, Astro, Remix.
- [BACKEND.md](./BACKEND.md) — server-side patterns (hyper-express,
  Fastify, NestJS, Bun + Hono, pools, transactions, BullMQ, multi-tenant,
  observability).
- [MOBILE.md](./MOBILE.md) — React Native (`op-sqlite`, `expo-sqlite`),
  Capacitor, Tauri, SQLCipher, background sync.
