import type { ModelDef } from '../../schema/types';
import type { WhereTree, WhereOp } from '../types';
import { isColRef, colRefField } from '../../col';

// When provided, buildWhereTree resolves `rel.target` and recurses with the
// target model so deep relation filters build a full tree. When omitted,
// relation filters recurse against the parent (works for single-level filters).
export type SchemaContext = Record<string, ModelDef<any>>;

// Build a dialect-agnostic WhereTree from a Prisma-shape where object. Value
// coercion (string id → ObjectId, ISO → Date) happens at compile time, not here.

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

// Ops with a portable field-to-field meaning (Mongo `$expr`, SQL `a <op> b`).
const COL_REF_OPS: ReadonlySet<WhereOp> = new Set<WhereOp>([
  'eq', 'ne', 'lt', 'lte', 'gt', 'gte',
]);

// Resolve a `col()` reference. Requiring a declared scalar field gives a clear
// error on typos and closes the only identifier-injection surface (the value
// becomes a SQL identifier / Mongo `$field` path downstream).
function resolveColRef(model: ModelDef<any>, op: WhereOp, ref: unknown): string {
  if (!COL_REF_OPS.has(op)) {
    throw new Error(
      `[forge] col() can only be used with equals/not/lt/lte/gt/gte ` +
        `(got operator '${op}' on '${model.collection}').`,
    );
  }
  const field = colRefField(ref as any);
  const fieldDef = model.fields?.[field];
  if (!fieldDef) {
    throw new Error(
      `[forge] col('${field}') references a field that does not exist on ` +
        `'${model.collection}'.`,
    );
  }
  if ((fieldDef as any).kind === 'relation') {
    throw new Error(
      `[forge] col('${field}') must reference a scalar field, not a relation, ` +
        `on '${model.collection}'.`,
    );
  }
  return field;
}

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

    const rel = relations[key];
    if (rel && value && typeof value === 'object') {
      const targetModel = schema?.[rel.target] ?? model;
      for (const mode of ['is', 'isNot', 'some', 'every', 'none'] as const) {
        if (mode in value) {
          const nested = buildWhereTree(targetModel, value[mode], schema) ?? null;
          children.push({ kind: 'relation', relation: key, mode, nested });
        }
      }
      continue;
    }

    // Bare col() form `{ field: col('other') }` must be checked before the
    // operator-object branch: the marker is an object whose Symbol key is
    // invisible to Object.keys, so it would otherwise parse to an empty filter.
    if (isColRef(value)) {
      children.push({
        kind: 'leaf',
        field: key,
        op: 'eq',
        value: undefined,
        rhsField: resolveColRef(model, 'eq', value),
      });
    } else if (value && typeof value === 'object' && !Array.isArray(value) && !isDate(value)) {
      const insensitive = value.mode === 'insensitive';
      for (const op of Object.keys(value)) {
        if (op === 'mode') continue;
        const irOp = SCALAR_OPS[op];
        if (!irOp) continue;
        const operand = value[op];
        if (isColRef(operand)) {
          children.push({
            kind: 'leaf',
            field: key,
            op: irOp,
            value: undefined,
            rhsField: resolveColRef(model, irOp, operand),
          });
          continue;
        }
        children.push({
          kind: 'leaf',
          field: key,
          op: irOp,
          value: operand,
          caseInsensitive: insensitive || undefined,
        });
      }
    } else {
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
