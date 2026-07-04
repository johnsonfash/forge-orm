// Executor — takes an IRNode, runs it, returns rows / count / {docs,count}.
//
// One free function per IR kind: executeSelect / Count / Insert / Update /
// Delete / GroupBy. Each opens the minimum-scope IDB txn needed. Writes go
// through readwrite txns; reads through readonly. Cursor sort + limit +
// offset live here; index-selection lives in planner.ts.
//
// The Adapter class in adapter.ts wraps these with emitter.track(...) so
// listeners see per-query timing / row counts / errors — parity with the SQL
// adapters. Schema access uses the module-level proxy from schema/active.ts
// (same trick sqlite/execute.ts uses) so cascade + hydration read the active
// consumer schema without threading it through every call.
//
// Transaction awkwardness: IDB txns auto-commit on task idle, so we must
// NOT `await` a non-IDB promise between IDB requests inside one txn. Each
// executor opens its own short-lived txn — a shared-txn story is deferred
// until $transaction gets real semantics.

import type {
  CountNode, DeleteNode, GroupByNode, InsertNode, SelectNode, UpdateNode,
  ProjectionPlan, WhereLeaf, WhereTree,
} from '../../ir/types';
import type { ModelDef } from '../../schema/types';
import { getActiveSchema, type SchemaShape } from '../../schema/active';
import type { ExecOpts } from '../types';
import { planSelect, primaryKeyField } from './planner';
import { cursorScan } from './cursor-scan';
import { hydrate, applyRelationCounts } from './hydration';
import { coerceInbound, stampUpdatedAt } from './coerce';
import { vectorDistance, type VectorMetric } from './vector';
import { haversineMeters, pointInMultiPolygon, type MultiPolygon, type Point } from './geo';
import { searchByTokens, tokensForRow } from './fts';
import { notFound, withIdbErrors } from './errors';

export interface IdbExecOpts extends ExecOpts {
  // Reserved for a future shared-txn story; today the executor opens
  // per-op txns internally.
  txn?: IDBTransaction;
}

// ─── SELECT ───────────────────────────────────────────────────────────────

export async function executeSelect(
  db: IDBDatabase,
  node: SelectNode,
  model: ModelDef<any>,
  _opts: IdbExecOpts = {},
  schemaOverride?: SchemaShape,
): Promise<any[]> {
  return withIdbErrors(async () => {
    const schema = schemaOverride ?? getActiveSchema();
    const storeName = model.collection;

    // FTS gate — a `search` leaf restricts the id set BEFORE cursor scan.
    const searchLeaf = findLeaf(node.where, 'search');
    let idFilter: Set<IDBValidKey> | null = null;
    if (searchLeaf) {
      idFilter = await searchByTokens(db, storeName, searchLeaf.field, String(searchLeaf.value));
      if (idFilter.size === 0) return [];
    }

    // Geo/vector post-filter and free-form ordering.
    const nearLeaf = findLeaf(node.where, 'near');
    const nearOrder = node.orderBy?.find((o) => o.nearTo);

    // Plan the range scan against the where tree stripped of post-filter ops.
    const plan = planSelect(model, stripPostFilterOps(node.where), node.orderBy);
    // Defer slicing whenever we still owe post-sort work (geo/vector nearTo)
    // or the caller supplied a cursor — cursor semantics need the full ordered
    // stream to locate the anchor row.
    const deferSlice = !!nearOrder || (!!node.cursor && Object.keys(node.cursor.fields).length > 0);
    let rows: Record<string, unknown>[] = await cursorScan(db, {
      storeName,
      plan,
      limit: deferSlice ? undefined : node.limit,
      offset: deferSlice ? undefined : node.offset,
    });

    if (idFilter) rows = rows.filter((r) => idFilter!.has(r[primaryKeyField(model)] as IDBValidKey));

    // Geo `near` filter (post-filter — no index in v0).
    if (nearLeaf) {
      const fieldDef = model.fields[nearLeaf.field] as { kind?: string; vector?: { metric?: string } } | undefined;
      if (fieldDef?.kind === 'geoPoint') {
        const { lng, lat, withinMeters } = nearLeaf.value as { lng: number; lat: number; withinMeters?: number };
        rows = rows.filter((r) => {
          const p = r[nearLeaf.field] as Point | undefined;
          if (!p) return false;
          const d = haversineMeters({ lng, lat }, p);
          (r as Record<string, unknown>)._distanceMeters = d;
          return withinMeters === undefined || d <= withinMeters;
        });
      }
      if (fieldDef?.kind === 'vector') {
        const { vector: v, withinDistance } = nearLeaf.value as { vector: number[]; withinDistance?: number };
        const metric = (fieldDef.vector?.metric ?? 'cosine') as VectorMetric;
        rows = rows.filter((r) => {
          const rv = r[nearLeaf.field] as number[] | undefined;
          if (!rv) return false;
          const d = vectorDistance(rv, v, metric);
          (r as Record<string, unknown>)._distance = d;
          return withinDistance === undefined || d <= withinDistance;
        });
      }
    }

    // withinPolygon
    const polyLeaf = findLeaf(node.where, 'withinPolygon');
    if (polyLeaf) {
      const mp = (polyLeaf.value as { multiPolygon: MultiPolygon }).multiPolygon;
      rows = rows.filter((r) => {
        const p = r[polyLeaf.field] as Point | undefined;
        if (!p) return false;
        return pointInMultiPolygon(mp, p);
      });
    }

    // OrderBy nearTo — sort by _distance / _distanceMeters after post-filter.
    if (nearOrder?.nearTo) {
      const nt = nearOrder.nearTo as { lng?: number; lat?: number; vector?: number[] };
      const isVector = !!nt.vector;
      const key = isVector ? '_distance' : '_distanceMeters';
      if (isVector) {
        const fieldDef = model.fields[nearOrder.field] as { vector?: { metric?: string } } | undefined;
        const metric = (fieldDef?.vector?.metric ?? 'cosine') as VectorMetric;
        for (const r of rows) {
          const rv = r[nearOrder.field] as number[] | undefined;
          (r as Record<string, unknown>)._distance = rv ? vectorDistance(rv, nt.vector!, metric) : Infinity;
        }
      } else {
        for (const r of rows) {
          const p = r[nearOrder.field] as Point | undefined;
          (r as Record<string, unknown>)._distanceMeters = p
            ? haversineMeters({ lng: nt.lng!, lat: nt.lat! }, p) : Infinity;
        }
      }
      rows.sort((a, b) => ((a as Record<string, unknown>)[key] as number) - ((b as Record<string, unknown>)[key] as number));
      if (nearOrder.direction === 'desc') rows.reverse();
      if (node.offset) rows = rows.slice(node.offset);
      if (node.limit) rows = rows.slice(0, node.limit);
    } else if (node.orderBy && node.orderBy.length > 0 && !plan.orderByFree) {
      rows = [...rows].sort((a, b) => {
        for (const o of node.orderBy!) {
          const av = a[o.field], bv = b[o.field];
          const c = jsCompare(av, bv);
          if (c !== 0) return o.direction === 'desc' ? -c : c;
        }
        return 0;
      });
      if (node.offset) rows = rows.slice(node.offset);
      if (node.limit) rows = rows.slice(0, node.limit);
    }

    // Cursor pagination — drop rows up to and including the cursor row.
    // Cursor uses the first orderBy field to define ordering; consumers who
    // need composite cursors flatten into synthetic keys upstream (matches
    // forge's IR contract). Applied BEFORE limit/offset so the "next page"
    // gets the requested slice size.
    if (node.cursor && Object.keys(node.cursor.fields).length > 0) {
      const [firstField] = Object.keys(node.cursor.fields);
      const cursorValue = node.cursor.fields[firstField];
      let cutIdx = -1;
      for (let i = 0; i < rows.length; i++) {
        if (jsCompare(rows[i][firstField], cursorValue) === 0) { cutIdx = i; break; }
      }
      if (cutIdx >= 0) rows = rows.slice(cutIdx + 1);
      if (node.offset) rows = rows.slice(node.offset);
      if (node.limit !== undefined) rows = rows.slice(0, node.limit);
    }

    // Distinct.
    if (node.distinct?.length) {
      const seen = new Set<string>();
      rows = rows.filter((r) => {
        const key = JSON.stringify(node.distinct!.map((f) => r[f] ?? null));
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    }

    // Cardinality — findFirst / findUnique clamp to one.
    if (node.cardinality === 'one') rows = rows.slice(0, 1);

    // Hydrate relations declared on the SelectNode.
    if (node.hydration?.length) rows = await hydrate(db, schema, node.model, rows, node.hydration);
    if (node.projection?.counts?.length) await applyRelationCounts(db, schema, node.model, rows, node.projection.counts);

    // Apply select/omit projection.
    if (node.projection) rows = rows.map((r) => project(r, node.projection!, node.hydration));

    return rows;
  });
}

function project(
  row: Record<string, unknown>,
  plan: ProjectionPlan,
  hydration: SelectNode['hydration'],
): Record<string, unknown> {
  if (plan.exclusive) {
    const out: Record<string, unknown> = {};
    for (const f of plan.fields) out[f] = row[f];
    for (const rel of hydration ?? []) out[rel.name] = row[rel.name];
    if (plan.counts.length && row._count !== undefined) out._count = row._count;
    return out;
  }
  if (plan.omit && plan.omit.length) {
    const out = { ...row };
    for (const f of plan.omit) delete out[f];
    return out;
  }
  return row;
}

function jsCompare(a: unknown, b: unknown): number {
  if (a == null && b == null) return 0;
  if (a == null) return -1;
  if (b == null) return 1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  if (a instanceof Date && b instanceof Date) return a.getTime() - b.getTime();
  return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
}

function findLeaf(w: WhereTree | undefined, op: string): WhereLeaf | undefined {
  if (!w) return undefined;
  if (w.kind === 'leaf' && w.op === op) return w;
  if (w.kind === 'and' || w.kind === 'or') {
    for (const c of w.children) {
      const f = findLeaf(c, op);
      if (f) return f;
    }
  }
  if (w.kind === 'not') return findLeaf(w.child, op);
  return undefined;
}

function stripPostFilterOps(w: WhereTree | undefined): WhereTree | undefined {
  const STRIP = new Set(['search', 'near', 'withinPolygon']);
  const walk = (n: WhereTree | undefined): WhereTree | undefined => {
    if (!n) return n;
    if (n.kind === 'leaf') return STRIP.has(n.op) ? undefined : n;
    if (n.kind === 'and' || n.kind === 'or') {
      const c = n.children.map(walk).filter(Boolean) as WhereTree[];
      if (c.length === 0) return undefined;
      if (c.length === 1) return c[0];
      return { ...n, children: c };
    }
    if (n.kind === 'not') {
      const inner = walk(n.child);
      return inner ? { kind: 'not', child: inner } : undefined;
    }
    return n;
  };
  return walk(w);
}

// ─── COUNT ────────────────────────────────────────────────────────────────

export async function executeCount(
  db: IDBDatabase,
  node: CountNode,
  model: ModelDef<any>,
  _opts: IdbExecOpts = {},
): Promise<number> {
  return withIdbErrors(async () => {
    if (!node.where && !node.distinct) {
      const tx = db.transaction(model.collection, 'readonly');
      return await new Promise<number>((resolve, reject) => {
        const req = tx.objectStore(model.collection).count();
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    }
    const plan = planSelect(model, node.where);
    const rows = await cursorScan(db, { storeName: model.collection, plan });
    if (!node.distinct) return rows.length;
    const seen = new Set<string>();
    for (const r of rows) {
      seen.add(JSON.stringify(node.distinct!.map((f) => r[f] ?? null)));
    }
    return seen.size;
  });
}

// ─── INSERT ───────────────────────────────────────────────────────────────

export async function executeInsert(
  db: IDBDatabase,
  node: InsertNode,
  model: ModelDef<any>,
  _opts: IdbExecOpts = {},
): Promise<{ docs: any[]; count: number }> {
  return withIdbErrors(async () => {
    const pk = primaryKeyField(model);
    const searchable = Object.entries(model.fields)
      .filter(([, f]) => (f as { searchable?: boolean }).searchable)
      .map(([n]) => n);
    const tx = db.transaction(model.collection, 'readwrite');
    const store = tx.objectStore(model.collection);
    const inserted: Record<string, unknown>[] = [];

    for (const raw of node.rows) {
      const row = coerceInbound(model, raw, { forCreate: true });
      if (row[pk] === undefined || row[pk] === null) {
        row[pk] = crypto.randomUUID();
      }
      Object.assign(row, tokensForRow(row, searchable));
      await new Promise<void>((resolve, reject) => {
        const req = node.skipDuplicates ? store.put(row) : store.add(row);
        req.onsuccess = () => { inserted.push(row); resolve(); };
        req.onerror = () => {
          if (node.skipDuplicates && req.error?.name === 'ConstraintError') {
            resolve();
          } else reject(req.error);
        };
      });
    }
    return { docs: inserted, count: inserted.length };
  });
}

// ─── UPDATE ───────────────────────────────────────────────────────────────

export async function executeUpdate(
  db: IDBDatabase,
  node: UpdateNode,
  model: ModelDef<any>,
  opts: IdbExecOpts = {},
): Promise<{ doc?: any; count: number }> {
  return withIdbErrors(async () => {
    const searchable = Object.entries(model.fields)
      .filter(([, f]) => (f as { searchable?: boolean }).searchable)
      .map(([n]) => n);

    // Upsert path.
    if (node.upsertCreate) {
      const found = await executeSelect(db, {
        kind: 'select', model: node.model, where: node.where, cardinality: 'one',
      }, model, opts);
      if (found.length === 0) {
        const created = await executeInsert(db, {
          kind: 'insert', model: node.model, rows: [node.upsertCreate],
        }, model, opts);
        return { doc: created.docs[0], count: created.count };
      }
      // Fall through to normal update.
    }

    const matches = await executeSelect(db, {
      kind: 'select', model: node.model, where: node.where,
      cardinality: node.many ? 'many' : 'one',
    }, model, opts);
    if (matches.length === 0) {
      if (node.many) return { count: 0 };
      throw notFound(model.collection, node.where);
    }

    const tx = db.transaction(model.collection, 'readwrite');
    const store = tx.objectStore(model.collection);
    const out: Record<string, unknown>[] = [];
    for (const r of matches) {
      let patch: Record<string, unknown> = { ...r };
      if (node.set) Object.assign(patch, node.set);
      if (node.increment) for (const [f, v] of Object.entries(node.increment)) patch[f] = ((patch[f] as number) ?? 0) + v;
      if (node.multiply) for (const [f, v] of Object.entries(node.multiply)) patch[f] = ((patch[f] as number) ?? 0) * v;
      if (node.push) for (const [f, vs] of Object.entries(node.push)) {
        const arr = Array.isArray(patch[f]) ? [...(patch[f] as unknown[])] : [];
        const values = Array.isArray(vs) ? (vs as unknown[]) : [vs];
        arr.push(...values);
        patch[f] = arr;
      }
      if (node.unset) for (const f of node.unset) delete patch[f];

      patch = stampUpdatedAt(model, patch);
      Object.assign(patch, tokensForRow(patch, searchable));

      await new Promise<void>((resolve, reject) => {
        const req = store.put(patch);
        req.onsuccess = () => { out.push(patch); resolve(); };
        req.onerror = () => reject(req.error);
      });
    }
    if (node.many) return { count: out.length };
    return { doc: out[0], count: out.length };
  });
}

// ─── DELETE ───────────────────────────────────────────────────────────────

export async function executeDelete(
  db: IDBDatabase,
  node: DeleteNode,
  model: ModelDef<any>,
  opts: IdbExecOpts = {},
  schemaOverride?: SchemaShape,
): Promise<{ doc?: any; count: number }> {
  return withIdbErrors(async () => {
    const pk = primaryKeyField(model);
    const matches = await executeSelect(db, {
      kind: 'select', model: node.model, where: node.where,
      cardinality: node.many ? 'many' : 'one',
    }, model, opts, schemaOverride);
    if (matches.length === 0) {
      if (node.many) return { count: 0 };
      throw notFound(model.collection, node.where);
    }
    const tx = db.transaction(model.collection, 'readwrite');
    const store = tx.objectStore(model.collection);
    for (const r of matches) {
      await new Promise<void>((resolve, reject) => {
        const req = store.delete(r[pk] as IDBValidKey);
        req.onsuccess = () => resolve();
        req.onerror = () => reject(req.error);
      });
    }
    if (node.many) return { count: matches.length };
    return { doc: matches[0], count: matches.length };
  });
}

// ─── GROUP BY ─────────────────────────────────────────────────────────────

export async function executeGroupBy(
  db: IDBDatabase,
  node: GroupByNode,
  model: ModelDef<any>,
  _opts: IdbExecOpts = {},
): Promise<any[]> {
  return withIdbErrors(async () => {
    const plan = planSelect(model, node.where);
    const rows = await cursorScan(db, { storeName: model.collection, plan });

    const groups = new Map<string, { keys: Record<string, unknown>; rows: Record<string, unknown>[] }>();
    for (const r of rows) {
      const key: Record<string, unknown> = {};
      for (const f of node.by) key[f] = r[f];
      const k = JSON.stringify(node.by.map((f) => r[f] ?? null));
      const g = groups.get(k) ?? { keys: key, rows: [] };
      g.rows.push(r);
      groups.set(k, g);
    }

    const out: Record<string, unknown>[] = [];
    for (const g of groups.values()) {
      const bucket: Record<string, unknown> = { ...g.keys };
      if (node._count) {
        const c: Record<string, number> = {};
        if (node._count._all) c._all = g.rows.length;
        for (const [f, want] of Object.entries(node._count)) {
          if (f === '_all' || !want) continue;
          c[f] = g.rows.filter((r) => r[f] != null).length;
        }
        bucket._count = c;
      }
      if (node._sum) bucket._sum = mapAgg(g.rows, node._sum, (nums) => nums.reduce((a, b) => a + b, 0));
      if (node._avg) bucket._avg = mapAgg(g.rows, node._avg, (nums) => nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : 0);
      if (node._min) bucket._min = mapAgg(g.rows, node._min, (nums) => nums.length ? Math.min(...nums) : null);
      if (node._max) bucket._max = mapAgg(g.rows, node._max, (nums) => nums.length ? Math.max(...nums) : null);
      out.push(bucket);
    }

    if (node.orderBy && node.orderBy.length) {
      out.sort((a, b) => {
        for (const o of node.orderBy!) {
          const av = a[o.field], bv = b[o.field];
          const c = jsCompare(av, bv);
          if (c !== 0) return o.direction === 'desc' ? -c : c;
        }
        return 0;
      });
    }
    if (node.offset) out.splice(0, node.offset);
    if (node.limit !== undefined) out.length = Math.min(out.length, node.limit);
    return out;
  });
}

function mapAgg(
  rows: Record<string, unknown>[],
  fields: Record<string, boolean>,
  fn: (nums: number[]) => number | null,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [f, want] of Object.entries(fields)) {
    if (!want) continue;
    const nums = rows.map((r) => r[f]).filter((v) => typeof v === 'number') as number[];
    out[f] = fn(nums);
  }
  return out;
}
