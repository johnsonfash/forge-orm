// App-side onDelete for dialects whose database cannot run it: Mongo has no
// foreign keys at all, and DuckDB refuses ON DELETE CASCADE / SET NULL. The
// wrapper calls this before deleting the parent rows, so children go first
// (leaves before parents) and the walk runs on the caller's session, which is
// a transaction whenever the database has one.
//
// The relation map is read from the schema that is active when the delete
// runs. Building it once at module load (the old Mongo walker did) froze it to
// the bundled sample schema, so a consumer's own models never cascaded.

import type { Adapter } from '../adapters/types';
import type { ModelDef, RelationDef } from '../schema/types';
import { buildCount, buildDelete, buildSelect, buildUpdate } from '../ir/build';
import { DbKnownError } from '../adapters/mongo/errors';

type Models = Record<string, ModelDef<any>>;

interface ChildRel {
  childKey: string;
  child: ModelDef<any>;
  rel: RelationDef;
  action: 'Cascade' | 'SetNull' | 'Restrict';
}

const relCache = new WeakMap<object, Map<string, ChildRel[]>>();

function childRelations(models: Models, parentKey: string): ChildRel[] {
  const keyObj = models as object;
  let byParent = relCache.get(keyObj);
  if (!byParent) {
    byParent = new Map();
    for (const [childKey, child] of Object.entries(models)) {
      const rels = (child?.relations?.() ?? {}) as Record<string, RelationDef>;
      for (const rel of Object.values(rels)) {
        if (rel.kind !== 'one' || rel.inverse) continue;
        const action = rel.onDelete;
        if (action !== 'Cascade' && action !== 'SetNull' && action !== 'Restrict') continue;
        const list = byParent.get(rel.target) ?? [];
        list.push({ childKey, child, rel, action });
        byParent.set(rel.target, list);
      }
    }
    relCache.set(keyObj, byParent);
  }
  return byParent.get(parentKey) ?? [];
}

/** True when deleting rows of `modelKey` has any onDelete work to do. */
export function hasCascadeWork(models: Models, modelKey: string): boolean {
  return childRelations(models, modelKey).length > 0;
}

/**
 * One probe per child relation of `modelKey`, in the walker's order: "does
 * any row of this child point at the rows being deleted". Fed to an adapter's
 * `selectWithChildPresence`, and its answer back to `applyCascades`.
 */
export function cascadeProbes(models: Models, modelKey: string): Array<{ collection: string; on: string; refs: string }> {
  return childRelations(models, modelKey).map((c) => ({ collection: c.child.collection, on: c.rel.on, refs: c.rel.refs }));
}

/** The parent columns the walker reads off each row about to be deleted. */
export function cascadeKeyFields(models: Models, modelKey: string, model: ModelDef<any>): string[] {
  const out = new Set<string>([pkField(model)]);
  for (const c of childRelations(models, modelKey)) out.add(c.rel.refs);
  return [...out];
}

function pkField(model: ModelDef<any>): string {
  for (const [name, fd] of Object.entries(model.fields)) if ((fd as any).kind === 'id') return name;
  return 'id';
}

interface WalkCtx {
  adapter: Adapter;
  session: unknown;
  models: Models;
  visited: Set<string>;
}

/**
 * Apply every onDelete action that points at `rows` of `modelKey`, recursing
 * into cascaded children. Does not delete `rows` themselves.
 */
export async function applyCascades(
  adapter: Adapter,
  session: unknown,
  models: Models,
  modelKey: string,
  model: ModelDef<any>,
  rows: Record<string, unknown>[],
  /** Per child relation (cascadeProbes order): false = no child row, skip it. */
  present?: boolean[],
): Promise<void> {
  const ctx: WalkCtx = { adapter, session, models, visited: new Set() };
  for (const r of rows) ctx.visited.add(`${modelKey}:${String(r[pkField(model)])}`);
  await walk(ctx, modelKey, rows, present);
}

async function walk(ctx: WalkCtx, parentKey: string, rows: Record<string, unknown>[], present?: boolean[]): Promise<void> {
  if (rows.length === 0) return;
  const all = childRelations(ctx.models, parentKey);
  const rels = present ? all.filter((_, i) => present[i] !== false) : all;
  if (rels.length === 0) return;
  const opts = { session: ctx.session };

  const whereFor = (c: ChildRel) => {
    const keys = distinct(rows.map((r) => r[c.rel.refs]));
    return keys.length ? { [c.rel.on]: { in: keys } } : undefined;
  };

  // Every Restrict is checked before anything is written, so a blocked delete
  // leaves the tree untouched even where there is no transaction to roll back.
  for (const c of rels) {
    if (c.action !== 'Restrict') continue;
    const where = whereFor(c);
    if (!where) continue;
    const n = await ctx.adapter.executeCount(buildCount(c.childKey, c.child, { where }, ctx.models as any), c.child, opts);
    if (n > 0) {
      throw new DbKnownError(
        'P2003',
        `Foreign key constraint failed: ${n} '${c.child.collection}' row(s) reference the '${parentKey}' ` +
        `being deleted through '${c.rel.on}' (onDelete: Restrict).`,
        { modelName: c.child.collection, field_name: c.rel.on },
      );
    }
  }

  for (const c of rels) {
    if (c.action === 'Restrict') continue;
    const where = whereFor(c);
    if (!where) continue;
    if (c.action === 'SetNull') {
      const node = buildUpdate(c.childKey, c.child, { where, data: { [c.rel.on]: null }, many: true }, ctx.models as any);
      await ctx.adapter.executeUpdate(node, c.child, opts);
      continue;
    }
    // Cascade. Children that are themselves parents are read first so the
    // walk can descend; a leaf table is deleted in one statement.
    if (hasCascadeWork(ctx.models, c.childKey)) {
      const fields = cascadeKeyFields(ctx.models, c.childKey, c.child);
      const select = Object.fromEntries(fields.map((f) => [f, true]));
      const kids = await ctx.adapter.executeSelect(
        buildSelect(c.childKey, c.child, { where, select }, 'many', ctx.models as any), c.child, opts,
      );
      if (kids.length === 0) continue;
      const pk = pkField(c.child);
      const fresh = (kids as Record<string, unknown>[]).filter((k) => {
        const id = `${c.childKey}:${String(k[pk])}`;
        if (ctx.visited.has(id)) return false;
        ctx.visited.add(id);
        return true;
      });
      await walk(ctx, c.childKey, fresh);
    }
    await ctx.adapter.executeDelete(
      buildDelete(c.childKey, c.child, { where, many: true }, ctx.models as any), c.child, opts,
    );
  }
}

function distinct(vals: unknown[]): unknown[] {
  const seen = new Set<string>();
  const out: unknown[] = [];
  for (const v of vals) {
    if (v == null) continue;
    const k = typeof v === 'object' ? String(v) : `${typeof v}:${String(v)}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(v);
  }
  return out;
}
