# Browser worked examples — framework by framework

End-to-end recipes for running forge-orm's wasm sqlite adapter inside the
major frontend frameworks. Each one is production-shaped: install,
bundler config, schema, db singleton, component.

For the underlying mechanics — OPFS URL schemes, the worker, the Vite/Next/Webpack
plugins, `$migrate`, `browserDoctor`, Safari ITP, multi-tab safety, the custom
vec0 + R-Tree build — see the **[Browser (sqlite-wasm + OPFS)](../README.md#browser-sqlite-wasm--opfs)**
chapter in the README.

## Contents

* [React + Vite](#react--vite)
* [Next.js App Router](#nextjs-app-router)
* [Vue 3 + Vite](#vue-3--vite)
* [Nuxt 3](#nuxt-3)
* [SvelteKit](#sveltekit)
* [Angular](#angular)
* [SolidStart](#solidstart)
* [Astro](#astro)
* [Remix](#remix)
* [React Native + op-sqlite (bonus)](#react-native--op-sqlite-bonus)
* [Tauri desktop + better-sqlite3](#tauri-desktop--better-sqlite3)

---

## React + Vite

Production-ready end-to-end. Five files. The same code shape works for
SolidStart, Remix, Astro, Qwik — anywhere Vite is the bundler.

**1. Install**

```sh
npm create vite@latest forge-vite-demo -- --template react-ts
cd forge-vite-demo
npm install
npm install forge-orm @sqlite.org/sqlite-wasm
```

**2. `vite.config.ts`**

```ts
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { forgeWasm } from 'forge-orm/wasm/vite';

export default defineConfig({
  plugins: [react(), forgeWasm()],
});
```

That's the entire Vite-side config. `forgeWasm()` handles the
`optimizeDeps.exclude`, sets `worker.format: 'es'`, and attaches COOP/COEP
headers to the dev server.

**3. `src/db/schema.ts` — your models**

```ts
import { f, model, rel } from 'forge-orm';

export const Customer = model('customers', {
  id:         f.id(),
  name:       f.string(),
  email:      f.string().unique(),
  phone:      f.string().optional(),
  created_at: f.dateTime().default('now'),
  updated_at: f.dateTime().default('now').updatedAt(),
}).relate(() => ({
  orders: rel.many('order', { on: 'customer_id', refs: 'id' }),
}));

export const Order = model('orders', {
  id:          f.id(),
  customer_id: f.objectId(),
  total_cents: f.int().default(0),
  status:      f.string().default('pending'),
  created_at:  f.dateTime().default('now'),
  // Geo for "deliveries near me" demo.
  location:    f.geoPoint({ fallback: true }),
  // FTS for search-as-you-type.
  notes:       f.text().searchable(),
}).relate(() => ({
  customer: rel.one('customer', { on: 'customer_id', refs: 'id', onDelete: 'Cascade' }),
}));

export const schema = { customer: Customer, order: Order } as const;
```

**4. `src/db/index.ts` — one db handle for the whole app**

```ts
import { createDb, wasmSqliteDriver } from 'forge-orm';
import { schema } from './schema';

// Lazy singleton — the worker is constructed once on first use, then reused
// across every component / hook.
let dbPromise: ReturnType<typeof open> | null = null;

function open() {
  const worker = new Worker(
    new URL('forge-orm/wasm/worker', import.meta.url),
    { type: 'module' },
  );
  return createDb({
    schema,
    driver: wasmSqliteDriver({ worker, url: 'opfs-sahpool:///app.sqlite' }),
  });
}

export function getDb() {
  if (!dbPromise) dbPromise = open();
  return dbPromise;
}

// Apply schema DDL once on app boot. Idempotent — re-runs cost ~5 ms after
// the first time (no work, just sqlite_master lookups).
export async function bootDb() {
  const db = await getDb();
  // Best-effort persistent storage — survives Safari ITP 7-day eviction.
  if (navigator.storage?.persist) await navigator.storage.persist();
  const report = await db.$migrate();
  if (report.failures.length) console.error('[db.bootDb] migration failures:', report.failures);
  return db;
}
```

**5. `src/App.tsx` — use it from React**

```tsx
import { useEffect, useState } from 'react';
import { bootDb, getDb } from './db';
import type { Row } from 'forge-orm';
import { Customer } from './db/schema';
type CustomerRow = Row<typeof Customer>;

export default function App() {
  const [ready, setReady] = useState(false);
  const [rows, setRows] = useState<CustomerRow[]>([]);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');

  useEffect(() => { bootDb().then(() => setReady(true)); }, []);
  useEffect(() => { if (ready) refresh(); }, [ready]);

  async function refresh() {
    const db = await getDb();
    setRows(await db.customer.findMany({ orderBy: { created_at: 'desc' }, take: 50 }));
  }

  async function add(e: React.FormEvent) {
    e.preventDefault();
    const db = await getDb();
    // Atomic upsert by email — INSERT ... ON CONFLICT(email) DO UPDATE.
    await db.customer.upsert({
      where: { email },
      create: { name, email },
      update: { name },
    });
    setName(''); setEmail('');
    await refresh();
  }

  if (!ready) return <p>Loading database…</p>;
  return (
    <div style={{ padding: 24, fontFamily: 'system-ui' }}>
      <h1>Customers ({rows.length})</h1>
      <form onSubmit={add} style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name" required />
        <input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="Email" type="email" required />
        <button>Add / Upsert</button>
      </form>
      <ul>
        {rows.map((c) => (
          <li key={c.id}>{c.name} — {c.email}</li>
        ))}
      </ul>
    </div>
  );
}
```

Run `npm run dev`, open `http://localhost:5173`, add a few rows, reload — they're still there. Open DevTools → Application → Storage → Origin Private File System to see the `.sqlite` file Forge wrote.

**Doctor + diff inside the app:**

```tsx
async function showDiagnostics() {
  const db = await getDb();
  const doctor = await db.$doctor();   // BrowserDoctorReport
  console.table(doctor.capabilities);
  const drift = await db.$diff();      // DriftReport
  console.log('schema in sync:', drift.inSync, drift.items);
}
```

**Cross-tab cache invalidation** (when one tab writes, others refetch):

```ts
// In src/db/index.ts, alongside getDb:
const bc = new BroadcastChannel('forge-db');

export async function notifyChange(modelKey: string) {
  bc.postMessage({ kind: 'invalidate', model: modelKey });
}

export function onChange(handler: (modelKey: string) => void) {
  const fn = (ev: MessageEvent) => {
    if (ev.data?.kind === 'invalidate') handler(ev.data.model);
  };
  bc.addEventListener('message', fn);
  return () => bc.removeEventListener('message', fn);
}
```

Wire `notifyChange('customer')` after each mutation, and `onChange((m) => m === 'customer' && refresh())` in the component.

## Next.js App Router

Same idea, Next-shaped. Works in dev (`next dev`) and prod (`next build && next start`).

**1. Install**

```sh
npx create-next-app@latest forge-next-demo --typescript --app
cd forge-next-demo
npm install forge-orm @sqlite.org/sqlite-wasm
```

**2. `next.config.mjs`**

```js
import { withForgeWasm } from 'forge-orm/wasm/next';

/** @type {import('next').NextConfig} */
const config = {
  reactStrictMode: true,
  // ... your existing Next config
};

export default withForgeWasm(config);
```

That enables `asyncWebAssembly` + `topLevelAwait`, adds the `.wasm` asset
rule, emits COOP/COEP headers for every route, and turns on
`experimental.esmExternals: 'loose'`.

> Narrowing COOP/COEP: if your marketing pages embed third-party scripts that
> break under COEP, pass an option:
> `withForgeWasm(config, { coopCoepMatcher: '/app/(.*)' })` — only the
> SQLite-using routes get the headers.

**3. `app/db/schema.ts`** — same shape as the Vite example.

**4. `app/db/client.ts` — client-side singleton**

```ts
'use client';

import { createDb, wasmSqliteDriver } from 'forge-orm';
import { schema } from './schema';

let dbPromise: ReturnType<typeof open> | null = null;

function open() {
  const worker = new Worker(
    new URL('forge-orm/wasm/worker', import.meta.url),
    { type: 'module' },
  );
  return createDb({
    schema,
    driver: wasmSqliteDriver({ worker, url: 'opfs-sahpool:///app.sqlite' }),
  });
}

export function getDb() {
  if (!dbPromise) dbPromise = open();
  return dbPromise;
}

export async function bootDb() {
  const db = await getDb();
  if (typeof navigator !== 'undefined' && navigator.storage?.persist) {
    await navigator.storage.persist();
  }
  await db.$migrate();
  return db;
}
```

Critical: this file MUST be marked `'use client'` and called from a client component. Forge's wasm adapter is browser-only — calling `getDb()` from a server component / route handler will crash since OPFS sync handles don't exist on the server.

**5. `app/db/DbProvider.tsx` — boot once at root**

```tsx
'use client';

import { createContext, useContext, useEffect, useState } from 'react';
import type { ForgeDb } from 'forge-orm';
import { bootDb } from './client';
import type { schema } from './schema';

const DbContext = createContext<ForgeDb<typeof schema> | null>(null);

export function DbProvider({ children }: { children: React.ReactNode }) {
  const [db, setDb] = useState<ForgeDb<typeof schema> | null>(null);
  useEffect(() => { bootDb().then(setDb); }, []);
  if (!db) return <p>Loading database…</p>;
  return <DbContext.Provider value={db}>{children}</DbContext.Provider>;
}

export function useDb() {
  const ctx = useContext(DbContext);
  if (!ctx) throw new Error('useDb() outside <DbProvider>');
  return ctx;
}
```

**6. `app/layout.tsx`**

```tsx
import { DbProvider } from './db/DbProvider';

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <DbProvider>{children}</DbProvider>
      </body>
    </html>
  );
}
```

**7. `app/page.tsx`**

```tsx
'use client';

import { useEffect, useState } from 'react';
import { useDb } from './db/DbProvider';
import type { Row } from 'forge-orm';
import { Customer } from './db/schema';

export default function Page() {
  const db = useDb();
  const [rows, setRows] = useState<Row<typeof Customer>[]>([]);

  useEffect(() => {
    db.customer.findMany({ orderBy: { created_at: 'desc' }, take: 50 }).then(setRows);
  }, [db]);

  return (
    <main style={{ padding: 24 }}>
      <h1>Local-first Customers ({rows.length})</h1>
      <ul>{rows.map((r) => <li key={r.id}>{r.name}</li>)}</ul>
    </main>
  );
}
```

**With TanStack Query (recommended for real apps):**

```tsx
'use client';

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useDb } from './db/DbProvider';

export function useCustomers() {
  const db = useDb();
  return useQuery({
    queryKey: ['customer', 'list'],
    queryFn: () => db.customer.findMany({ orderBy: { created_at: 'desc' } }),
  });
}

export function useUpsertCustomer() {
  const db = useDb();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { name: string; email: string }) =>
      db.customer.upsert({
        where: { email: input.email },
        create: input,
        update: { name: input.name },
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['customer'] }),
  });
}
```

This is the recommended pattern — TanStack Query handles caching, refetching, optimistic updates; Forge handles the persistence layer. Together they give you the same shape as a server-backed React Query app, but everything runs locally.

## Vue 3 + Vite

Same Vite plugin (`forgeWasm()`) — Vue picks it up via the standard
`new Worker(new URL(...))` Vite resolves.

**1. Install**

```sh
npm create vite@latest forge-vue-demo -- --template vue-ts
cd forge-vue-demo
npm install
npm install forge-orm @sqlite.org/sqlite-wasm
```

**2. `vite.config.ts`**

```ts
import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import { forgeWasm } from 'forge-orm/wasm/vite';

export default defineConfig({
  plugins: [vue(), forgeWasm()],
});
```

**3. `src/db/index.ts`** — same singleton + schema files as the React
example, unchanged.

**4. `src/composables/useDb.ts` — composable wrapper**

```ts
import { ref } from 'vue';
import { bootDb, getDb } from '@/db';

const db = ref<Awaited<ReturnType<typeof getDb>> | null>(null);
const ready = ref(false);

bootDb().then((d) => { db.value = d; ready.value = true; });

export function useDb() {
  return { db, ready };
}
```

**5. `src/App.vue`**

```vue
<script setup lang="ts">
import { ref, watch } from 'vue';
import { useDb } from './composables/useDb';
import type { Row } from 'forge-orm';
import { Customer } from './db/schema';

const { db, ready } = useDb();
const rows = ref<Row<typeof Customer>[]>([]);
const form = ref({ name: '', email: '' });

async function refresh() {
  if (!db.value) return;
  rows.value = await db.value.customer.findMany({
    orderBy: { created_at: 'desc' }, take: 50,
  });
}

async function add() {
  if (!db.value) return;
  await db.value.customer.upsert({
    where: { email: form.value.email },
    create: { ...form.value },
    update: { name: form.value.name },
  });
  form.value = { name: '', email: '' };
  await refresh();
}

watch(ready, (r) => { if (r) refresh(); });
</script>

<template>
  <div v-if="!ready">Loading database…</div>
  <div v-else>
    <h1>Customers ({{ rows.length }})</h1>
    <form @submit.prevent="add">
      <input v-model="form.name" placeholder="Name" required />
      <input v-model="form.email" type="email" placeholder="Email" required />
      <button>Add / Upsert</button>
    </form>
    <ul>
      <li v-for="c in rows" :key="c.id">{{ c.name }} — {{ c.email }}</li>
    </ul>
  </div>
</template>
```

**With Pinia (recommended for real apps):**

```ts
// src/stores/customers.ts
import { defineStore } from 'pinia';
import { getDb } from '@/db';

export const useCustomersStore = defineStore('customers', {
  state: () => ({ rows: [] as any[] }),
  actions: {
    async refresh() {
      const db = await getDb();
      this.rows = await db.customer.findMany({ orderBy: { created_at: 'desc' } });
    },
    async upsert(input: { name: string; email: string }) {
      const db = await getDb();
      await db.customer.upsert({ where: { email: input.email }, create: input, update: { name: input.name } });
      await this.refresh();
    },
  },
});
```

## Nuxt 3

Forge is client-only — wrap usage in `<ClientOnly>` or in a client-side
composable. Nuxt's webpack-mode is webpack 5 internally; the `wasm/next`
helper-shape doesn't apply, but the manual config is small.

**1. Install**

```sh
npx nuxi@latest init forge-nuxt-demo
cd forge-nuxt-demo
npm install
npm install forge-orm @sqlite.org/sqlite-wasm
```

**2. `nuxt.config.ts`**

```ts
export default defineNuxtConfig({
  vite: {
    plugins: [
      // Inline the Vite plugin — Nuxt 3 uses Vite for the client bundle.
      // Import dynamically so SSR doesn't pull in the wasm peer dep.
      (await import('forge-orm/wasm/vite')).forgeWasm(),
    ],
  },
  // COOP/COEP — Nuxt server route headers
  routeRules: {
    '/**': {
      headers: {
        'Cross-Origin-Opener-Policy': 'same-origin',
        'Cross-Origin-Embedder-Policy': 'require-corp',
      },
    },
  },
});
```

**3. `composables/useDb.ts` (client-side only)**

```ts
import { createDb, wasmSqliteDriver } from 'forge-orm';
import { schema } from '~/db/schema';

let dbPromise: ReturnType<typeof open> | null = null;

function open() {
  const worker = new Worker(
    new URL('forge-orm/wasm/worker', import.meta.url),
    { type: 'module' },
  );
  return createDb({
    schema,
    driver: wasmSqliteDriver({ worker, url: 'opfs-sahpool:///app.sqlite' }),
  });
}

export function useDb() {
  if (process.server) return null;          // SSR: no DB
  if (!dbPromise) {
    dbPromise = (async () => {
      const db = await open();
      if (navigator.storage?.persist) await navigator.storage.persist();
      await db.$migrate();
      return db;
    })();
  }
  return dbPromise;
}
```

**4. `pages/index.vue`**

```vue
<script setup lang="ts">
import { ref, onMounted } from 'vue';

const rows = ref<any[]>([]);

onMounted(async () => {
  const db = await useDb();
  if (!db) return;
  rows.value = await db.customer.findMany();
});
</script>

<template>
  <ClientOnly>
    <ul>
      <li v-for="c in rows" :key="c.id">{{ c.name }}</li>
    </ul>
    <template #fallback>Loading…</template>
  </ClientOnly>
</template>
```

## SvelteKit

SvelteKit uses Vite under the hood — `forgeWasm()` slots in directly. Key
point: only call forge from client code (browser-only).

**1. Install**

```sh
npm create svelte@latest forge-svelte-demo
cd forge-svelte-demo
npm install
npm install forge-orm @sqlite.org/sqlite-wasm
```

**2. `vite.config.ts`**

```ts
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';
import { forgeWasm } from 'forge-orm/wasm/vite';

export default defineConfig({
  plugins: [sveltekit(), forgeWasm()],
});
```

**3. `src/hooks.server.ts` — COOP/COEP for production**

```ts
import type { Handle } from '@sveltejs/kit';

export const handle: Handle = async ({ event, resolve }) => {
  const response = await resolve(event);
  response.headers.set('Cross-Origin-Opener-Policy', 'same-origin');
  response.headers.set('Cross-Origin-Embedder-Policy', 'require-corp');
  return response;
};
```

**4. `src/lib/db.ts` — client-only singleton**

```ts
import { browser } from '$app/environment';
import { createDb, wasmSqliteDriver } from 'forge-orm';
import { schema } from './schema';

let dbPromise: ReturnType<typeof open> | null = null;

function open() {
  const worker = new Worker(
    new URL('forge-orm/wasm/worker', import.meta.url),
    { type: 'module' },
  );
  return createDb({
    schema,
    driver: wasmSqliteDriver({ worker, url: 'opfs-sahpool:///app.sqlite' }),
  });
}

export async function getDb() {
  if (!browser) throw new Error('forge/wasm is client-only');
  if (!dbPromise) {
    dbPromise = (async () => {
      const db = await open();
      if (navigator.storage?.persist) await navigator.storage.persist();
      await db.$migrate();
      return db;
    })();
  }
  return dbPromise;
}
```

**5. `src/lib/stores/customers.ts` — Svelte store**

```ts
import { writable } from 'svelte/store';
import { getDb } from '$lib/db';

export const customers = writable<any[]>([]);

export async function refreshCustomers() {
  const db = await getDb();
  customers.set(await db.customer.findMany({ orderBy: { created_at: 'desc' } }));
}

export async function upsertCustomer(input: { name: string; email: string }) {
  const db = await getDb();
  await db.customer.upsert({
    where: { email: input.email },
    create: input,
    update: { name: input.name },
  });
  await refreshCustomers();
}
```

**6. `src/routes/+page.svelte`**

```svelte
<script lang="ts">
  import { onMount } from 'svelte';
  import { customers, refreshCustomers, upsertCustomer } from '$lib/stores/customers';

  let name = '';
  let email = '';

  onMount(refreshCustomers);

  async function add() {
    await upsertCustomer({ name, email });
    name = ''; email = '';
  }
</script>

<h1>Customers ({$customers.length})</h1>
<form on:submit|preventDefault={add}>
  <input bind:value={name} placeholder="Name" required />
  <input bind:value={email} type="email" placeholder="Email" required />
  <button>Add / Upsert</button>
</form>
<ul>
  {#each $customers as c (c.id)}
    <li>{c.name} — {c.email}</li>
  {/each}
</ul>
```

## Angular

Angular's bundler is `esbuild` (since v17) — works the same as Vite for
worker resolution. The wasm/webpack plugin applies if you use the legacy
webpack builder.

**1. Install**

```sh
ng new forge-angular-demo --routing --style=css
cd forge-angular-demo
npm install forge-orm @sqlite.org/sqlite-wasm
```

**2. `angular.json` — enable wasm + worker**

Add under `architect.build.options`:

```json
{
  "allowedCommonJsDependencies": ["@sqlite.org/sqlite-wasm"],
  "webWorkerTsConfig": "tsconfig.worker.json"
}
```

For production COOP/COEP, use a custom server (Express / Angular SSR) and
set the headers there — same as the Express snippet in the
[Webpack/CRA setup](../README.md#webpack--cra--rsbuild-setup) section.

**3. `src/app/db.service.ts` — Angular service singleton**

```ts
import { Injectable } from '@angular/core';
import { createDb, wasmSqliteDriver, type ForgeDb } from 'forge-orm';
import { schema } from './schema';

@Injectable({ providedIn: 'root' })
export class DbService {
  private dbPromise: Promise<ForgeDb<typeof schema>> | null = null;

  async getDb() {
    if (!this.dbPromise) this.dbPromise = this.open();
    return this.dbPromise;
  }

  private async open() {
    const worker = new Worker(
      new URL('forge-orm/wasm/worker', import.meta.url),
      { type: 'module' },
    );
    const db = await createDb({
      schema,
      driver: wasmSqliteDriver({ worker, url: 'opfs-sahpool:///app.sqlite' }),
    });
    if (navigator.storage?.persist) await navigator.storage.persist();
    await db.$migrate();
    return db;
  }
}
```

**4. `src/app/app.component.ts`**

```ts
import { Component, OnInit, signal } from '@angular/core';
import { DbService } from './db.service';

@Component({
  selector: 'app-root',
  standalone: true,
  template: `
    <h1>Customers ({{ rows().length }})</h1>
    <form (submit)="add($event)">
      <input [(ngModel)]="name" name="name" placeholder="Name" required />
      <input [(ngModel)]="email" name="email" type="email" placeholder="Email" required />
      <button>Add / Upsert</button>
    </form>
    <ul>
      <li *ngFor="let c of rows()">{{ c.name }} — {{ c.email }}</li>
    </ul>
  `,
})
export class AppComponent implements OnInit {
  rows = signal<any[]>([]);
  name = ''; email = '';
  constructor(private db: DbService) {}

  async ngOnInit() { await this.refresh(); }

  async refresh() {
    const db = await this.db.getDb();
    this.rows.set(await db.customer.findMany({ orderBy: { created_at: 'desc' } }));
  }

  async add(e: Event) {
    e.preventDefault();
    const db = await this.db.getDb();
    await db.customer.upsert({
      where: { email: this.email },
      create: { name: this.name, email: this.email },
      update: { name: this.name },
    });
    this.name = ''; this.email = '';
    await this.refresh();
  }
}
```

## SolidStart

Solid uses Vite — `forgeWasm()` works as-is. Solid's fine-grained
reactivity makes the local-first pattern especially clean.

```ts
// vite.config.ts
import solid from 'solid-start/vite';
import { defineConfig } from 'vite';
import { forgeWasm } from 'forge-orm/wasm/vite';

export default defineConfig({
  plugins: [solid(), forgeWasm()],
});
```

```tsx
// src/db.ts (same singleton shape as React)
import { createDb, wasmSqliteDriver } from 'forge-orm';
import { schema } from './schema';
let dbPromise: ReturnType<typeof open> | null = null;
function open() {
  const worker = new Worker(new URL('forge-orm/wasm/worker', import.meta.url), { type: 'module' });
  return createDb({ schema, driver: wasmSqliteDriver({ worker, url: 'opfs-sahpool:///app.sqlite' }) });
}
export function getDb() {
  if (!dbPromise) dbPromise = open();
  return dbPromise;
}

// src/routes/index.tsx — Solid resource
import { createResource, For } from 'solid-js';
import { getDb } from '~/db';

export default function Home() {
  const [customers] = createResource(async () => {
    const db = await getDb();
    await db.$migrate();
    return db.customer.findMany({ orderBy: { created_at: 'desc' } });
  });
  return (
    <ul>
      <For each={customers()}>{(c) => <li>{c.name}</li>}</For>
    </ul>
  );
}
```

## Astro

Astro's `client:only="react"` (or `vue` / `svelte`) is the right boundary
— forge is browser-only.

```ts
// astro.config.mjs
import { defineConfig } from 'astro/config';
import react from '@astrojs/react';
import { forgeWasm } from 'forge-orm/wasm/vite';

export default defineConfig({
  integrations: [react()],
  vite: { plugins: [forgeWasm()] },
  server: {
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
});
```

```astro
---
// src/pages/index.astro
import CustomerList from '../components/CustomerList';
---
<html>
  <body>
    <CustomerList client:only="react" />
  </body>
</html>
```

Then `src/components/CustomerList.tsx` is identical to the React example.

## Remix

Remix uses Vite (since v2.2) — same `forgeWasm()` plugin.

```ts
// vite.config.ts
import { vitePlugin as remix } from '@remix-run/dev';
import { defineConfig } from 'vite';
import { forgeWasm } from 'forge-orm/wasm/vite';

export default defineConfig({
  plugins: [remix(), forgeWasm()],
});
```

Remix routes can use forge only inside client-side action / loader patterns
via `useEffect` or `useFetcher` calls — the standard `loader` function runs
on the server. Use a `clientLoader` instead:

```tsx
// app/routes/_index.tsx
import { useLoaderData } from '@remix-run/react';
import { getDb } from '~/db';

export async function clientLoader() {
  const db = await getDb();
  await db.$migrate();
  return { rows: await db.customer.findMany({ orderBy: { created_at: 'desc' } }) };
}

export default function Index() {
  const { rows } = useLoaderData<typeof clientLoader>();
  return <ul>{rows.map((c) => <li key={c.id}>{c.name}</li>)}</ul>;
}
```

## React Native + op-sqlite (bonus)

Same forge API, native SQLite via [op-sqlite](https://github.com/op-engineering/op-sqlite). Works on RN (bare or Expo with bare workflow):

```sh
npm install forge-orm @op-engineering/op-sqlite
```

```ts
import { createDb, opSqliteDriver } from 'forge-orm';
import { open as openSqlite } from '@op-engineering/op-sqlite';
import { schema } from './db/schema';

const native = openSqlite({ name: 'app.sqlite' });

export const db = await createDb({
  schema,
  driver: opSqliteDriver(native),
});

// Same $migrate() runs on RN too — the IR + DDL emitter don't care
// whether the SQLite is wasm + OPFS or native + iOS sandbox.
await db.$migrate();
```

For Expo (managed workflow), substitute `expoSqliteDriver(SQLite.openDatabaseSync('app.db'))` from `expo-sqlite`.

## Tauri desktop + better-sqlite3

For desktop apps shipped via Tauri, run SQLite in the Rust backend over [tauri-plugin-sql](https://github.com/tauri-apps/tauri-plugin-sql), OR run forge in the Tauri webview with a custom driver, OR — simplest — run a Node sidecar with `better-sqlite3`:

```ts
import { createDb } from 'forge-orm';
import { schema } from './schema';
import { app } from '@tauri-apps/api';
import path from 'node:path';

const dbPath = path.join(await app.appLocalDataDir(), 'app.sqlite');
export const db = await createDb({
  url: `sqlite:${dbPath}`,
  schema,
});
```

For the wasm-in-webview path, the same Vite/Next setup above works — Tauri's webview is Chromium / WKWebView, both ship OPFS.

---

Back to the [Browser chapter](../README.md#browser-sqlite-wasm--opfs) or the [README index](../README.md#contents).
