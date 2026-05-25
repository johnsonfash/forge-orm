import type { ModelDef } from '../../schema/types';
import type { ProjectionPlan, RelationPlan, SelectNode } from '../types';
import type { SchemaContext } from './where';

// Build the projection + relation hydration plan from a caller's `select` /
// `include` / `omit` args. Schema-side names; adapters map to columns/keys.
//
// When `schema` is supplied, nested relation args (`include: { posts: { where:
// {...}, orderBy: {...}, take: 10 } }`) get compiled into a fully-formed
// sub-SelectNode on the RelationPlan, so adapters can recurse cleanly during
// hydration. Without schema, nested args are stashed as `__rawArgs` (Wave 1a
// behaviour kept for back-compat).

export interface BuildProjectionResult {
  projection?: ProjectionPlan;
  hydration?: RelationPlan[];
}

export function buildProjection(
  model: ModelDef<any>,
  args: { select?: any; include?: any; omit?: any },
  schema?: SchemaContext,
): BuildProjectionResult {
  const relations = model.relations();

  // ─── omit path (Prisma 5.13+) ────────────────────────────────
  if (args.omit && !args.select && !args.include) {
    const drop: string[] = [];
    for (const k of Object.keys(args.omit)) {
      if (args.omit[k]) drop.push(k);
    }
    if (drop.length === 0) return {};
    return { projection: { fields: [], omit: drop, counts: [], exclusive: false } };
  }

  // ─── include path (all scalars + listed relations) ───────────
  if (args.include) {
    const hydration: RelationPlan[] = [];
    const counts: string[] = [];
    for (const key of Object.keys(args.include)) {
      const v = args.include[key];
      if (v === false || v == null) continue;
      if (key === '_count') {
        if (v && typeof v === 'object' && v.select) {
          for (const rk of Object.keys(v.select)) if (v.select[rk]) counts.push(rk);
        }
        continue;
      }
      const rel = relations[key];
      if (!rel) continue;
      hydration.push(toRelationPlan(key, rel, v === true ? {} : v, schema));
    }
    const omitFields: string[] | undefined = args.omit
      ? Object.keys(args.omit).filter((k) => args.omit[k])
      : undefined;
    return {
      projection: counts.length || omitFields?.length
        ? { fields: [], omit: omitFields, counts, exclusive: false }
        : undefined,
      hydration: hydration.length ? hydration : undefined,
    };
  }

  // ─── select path (only listed scalars + listed relations) ────
  if (args.select) {
    const fields: string[] = [];
    const hydration: RelationPlan[] = [];
    const counts: string[] = [];
    for (const key of Object.keys(args.select)) {
      const v = args.select[key];
      if (v === false || v == null) continue;
      if (key === '_count') {
        if (v && typeof v === 'object' && v.select) {
          for (const rk of Object.keys(v.select)) if (v.select[rk]) counts.push(rk);
        }
        continue;
      }
      const rel = relations[key];
      if (rel) {
        hydration.push(toRelationPlan(key, rel, v === true ? {} : v, schema));
        continue;
      }
      fields.push(key);
    }
    return {
      projection: { fields, counts, exclusive: true },
      hydration: hydration.length ? hydration : undefined,
    };
  }

  // No select / include / omit — full scalars, no relations.
  return {};
}

function toRelationPlan(
  name: string,
  rel: ReturnType<ModelDef<any>['relations']>[string],
  nestedArgs: any,
  schema?: SchemaContext,
): RelationPlan {
  const plan: RelationPlan = {
    name,
    kind: rel.kind,
    target: rel.target,
    on: rel.on,
    refs: rel.refs,
  };
  if (!nestedArgs) return plan;
  const hasNested =
    nestedArgs.select || nestedArgs.include || nestedArgs.omit
    || nestedArgs.where || nestedArgs.orderBy
    || nestedArgs.take !== undefined || nestedArgs.skip !== undefined
    || nestedArgs.limit !== undefined || nestedArgs.offset !== undefined
    || nestedArgs.distinct;
  if (!hasNested) return plan;

  const targetModel = schema?.[rel.target];
  if (targetModel) {
    // Schema-aware: build a real sub-SelectNode shell for the adapter to use.
    // We can't import buildSelect here without circular deps, so callers in
    // build/index.ts handle the recursion. Stash args verbatim; the orchestrator
    // builds the full node.
    plan.nested = {
      cardinality: rel.kind === 'one' ? 'one' : 'many',
      limit: nestedArgs.take ?? nestedArgs.limit,
      offset: nestedArgs.skip ?? nestedArgs.offset,
      ...({ __rawArgs: nestedArgs, __target: rel.target } as any),
    };
  } else {
    // No schema: stash raw for adapter / Wave 1a back-compat.
    plan.nested = {
      cardinality: rel.kind === 'one' ? 'one' : 'many',
      limit: nestedArgs.take ?? nestedArgs.limit,
      offset: nestedArgs.skip ?? nestedArgs.offset,
      ...({ __rawArgs: nestedArgs } as any),
    };
  }
  return plan;
}
