import type { ModelDef } from '../../schema/types';
import type { WhereTree, WhereOp } from '../types';

// Optional schema map for relation recursion. When provided, buildWhereTree
// resolves `rel.target` and recurses with the target model so deep relation
// where (`posts: { some: { author: { is: { ... } } } }`) builds a full tree.
// When omitted (back-compat with Wave 1a call sites), relation filters are
// captured but their `nested` tree is built against the parent model — which
// works for single-level relation filters and degrades gracefully for deeper
// ones.
export type SchemaContext = Record<string, ModelDef<any>>;

// Build a WhereTree from a Prisma-shape where object.
//
// Rules:
//   • Bare equality `{ field: value }` → leaf `eq`
//   • Operator object `{ field: { equals, lt, gte, in, ... } }` → leaf per op
//   • String mode `{ field: { contains: 'x', mode: 'insensitive' } }` → caseInsensitive flag
//   • Array ops `{ tags: { has, hasSome, hasEvery, isEmpty } }` → leaf
//   • Logical `AND/OR/NOT` → child trees
//   • Relation `{ profile: { is: {...} } | isNot | some | every | none }` → relation node
//
// The IR is dialect-agnostic; per-adapter compilers apply field-name mapping
// (e.g. `id` → `_id` for Mongo, `id` → `"users"."id"` for SQL).
//
// Coercion (string id → ObjectId, ISO → Date) happens at compile time, NOT
// here. The IR carries values verbatim so a SQL adapter can keep them as-is.

const SCALAR_OPS: Record<string, WhereOp> = {
  equals: 'eq',
  not: 'ne',
  in: 'in',
  notIn: 'nin',
  lt: 'lt',
  lte: 'lte',
  gt: 'gt',
  gte: 'gte',
  contains: 'contains',
  startsWith: 'startsWith',
  endsWith: 'endsWith',
  has: 'has',
  hasSome: 'hasSome',
  hasEvery: 'hasEvery',
  isEmpty: 'isEmpty',
  search: 'search',
};

export function buildWhereTree(
  model: ModelDef<any>,
  where: any,
  schema?: SchemaContext,
): WhereTree | undefined {
  if (!where || typeof where !== 'object') return undefined;

  const children: WhereTree[] = [];
  const relations = model.relations();

  for (const key of Object.keys(where)) {
    const value = where[key];
    if (value === undefined) continue;

    // ─── Logical ───────────────────────────────────────────────
    if (key === 'AND') {
      const arr = Array.isArray(value) ? value : [value];
      const inner = arr.map((v) => buildWhereTree(model, v, schema)).filter(notUndef);
      if (inner.length) children.push({ kind: 'and', children: inner });
      continue;
    }
    if (key === 'OR') {
      const arr = Array.isArray(value) ? value : [value];
      const inner = arr.map((v) => buildWhereTree(model, v, schema)).filter(notUndef);
      if (inner.length) children.push({ kind: 'or', children: inner });
      continue;
    }
    if (key === 'NOT') {
      const arr = Array.isArray(value) ? value : [value];
      const inner = arr.map((v) => buildWhereTree(model, v, schema)).filter(notUndef);
      if (inner.length === 1) children.push({ kind: 'not', child: inner[0] });
      else if (inner.length > 1) children.push({ kind: 'not', child: { kind: 'and', children: inner } });
      continue;
    }

    // ─── Relation filter ───────────────────────────────────────
    const rel = relations[key];
    if (rel && value && typeof value === 'object') {
      // Resolve the target model when a schema is supplied so nested filters
      // descend correctly. Otherwise recurse against the parent (Wave 1a
      // shape — works for single-level filters).
      const targetModel = schema?.[rel.target] ?? model;
      for (const mode of ['is', 'isNot', 'some', 'every', 'none'] as const) {
        if (mode in value) {
          const nested = buildWhereTree(targetModel, value[mode], schema) ?? null;
          children.push({ kind: 'relation', relation: key, mode, nested });
        }
      }
      continue;
    }

    // ─── Field condition ───────────────────────────────────────
    if (value && typeof value === 'object' && !Array.isArray(value) && !isDate(value)) {
      // Operator object form: { field: { equals, gte, contains, ... } }
      const insensitive = value.mode === 'insensitive';
      for (const op of Object.keys(value)) {
        if (op === 'mode') continue;
        const irOp = SCALAR_OPS[op];
        if (!irOp) continue;
        children.push({
          kind: 'leaf',
          field: key,
          op: irOp,
          value: value[op],
          caseInsensitive: insensitive || undefined,
        });
      }
    } else {
      // Bare equality form: { field: value }
      children.push({ kind: 'leaf', field: key, op: 'eq', value });
    }
  }

  if (children.length === 0) return undefined;
  if (children.length === 1) return children[0];
  return { kind: 'and', children };
}

function notUndef<T>(v: T | undefined): v is T {
  return v !== undefined;
}

function isDate(v: any): boolean {
  return v instanceof Date;
}
