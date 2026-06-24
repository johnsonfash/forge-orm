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
      // Geo near — user shape `{ location: { near: { lng, lat, withinMeters } } }`.
      // Recognise and translate before the SCALAR_OPS loop so an unknown op
      // ('near') doesn't get silently dropped.
      if ('near' in value && value.near && typeof value.near === 'object') {
        const fdef = (model.fields as any)?.[key];
        // Vector near: { embedding: { near: { vector: number[], withinDistance?: number } } }
        if (fdef?.kind === 'vector') {
          const n = value.near as { vector?: number[]; withinDistance?: number };
          if (!Array.isArray(n.vector) || n.vector.length === 0) {
            throw new Error(
              `[forge] where.${key}.near.vector must be a non-empty number[].`,
            );
          }
          if (fdef.vector?.dims && n.vector.length !== fdef.vector.dims) {
            throw new Error(
              `[forge] where.${key}.near.vector length ${n.vector.length} ` +
              `does not match the column dims ${fdef.vector.dims}.`,
            );
          }
          children.push({
            kind: 'leaf',
            field: key,
            op: 'near',
            value: { vector: n.vector, withinDistance: n.withinDistance },
          });
          continue;
        }
        // Geo near: { location: { near: { lng, lat, withinMeters? } } }
        const n = value.near as { lng?: number; lat?: number; withinMeters?: number };
        if (typeof n.lng !== 'number' || typeof n.lat !== 'number') {
          throw new Error(
            `[forge] where.${key}.near requires numeric { lng, lat } for geo OR { vector: [...] } for vector fields.`,
          );
        }
        children.push({
          kind: 'leaf',
          field: key,
          op: 'near',
          value: { lng: n.lng, lat: n.lat, withinMeters: n.withinMeters },
        });
        continue;
      }
      // JSON path query — { meta: { path: 'profile.age', gte: 18 } } OR
      // { meta: { path: ['profile', 'age'], gte: 18 } }. Works on json /
      // embed / embedMany columns; emits a dialect-native path read +
      // comparison. The sub-op is whichever scalar op the user pairs with
      // the `path` key — eq is the default when only path is set.
      if ('path' in value && (typeof value.path === 'string' || Array.isArray(value.path))) {
        const fdef = model.fields?.[key];
        if (!fdef || !['json', 'embed', 'embedMany', 'stringArray', 'intArray'].includes((fdef as any).kind)) {
          throw new Error(
            `[forge] where.${key}.path can only be used on json / embed / array fields. ` +
            `'${key}' is kind=${(fdef as any)?.kind ?? 'unknown'}.`,
          );
        }
        const pathArr: string[] = typeof value.path === 'string'
          ? parseJsonPath(value.path)
          : value.path.map(String);
        type JsonSubOp = 'eq' | 'ne' | 'lt' | 'lte' | 'gt' | 'gte' | 'contains' | 'in' | 'has';
        let subOp: JsonSubOp = 'eq';
        let subValue: any = null;
        const subOpKeys: JsonSubOp[] = ['eq', 'ne', 'lt', 'lte', 'gt', 'gte', 'contains', 'in', 'has'];
        for (const k of subOpKeys) {
          if (k in value) {
            subOp = k;
            subValue = (value as any)[k];
            break;
          }
        }
        children.push({
          kind: 'leaf',
          field: key,
          op: 'jsonPath',
          value: subValue,
          jsonPath: { path: pathArr, subOp },
        });
        continue;
      }
      // Geo polygon containment — { col: { withinPolygon: [{lng,lat}, …] } }.
      if ('withinPolygon' in value && Array.isArray(value.withinPolygon)) {
        const ring = value.withinPolygon as Array<{ lng?: number; lat?: number }>;
        if (ring.length < 3) {
          throw new Error(
            `[forge] where.${key}.withinPolygon needs at least 3 vertices.`,
          );
        }
        for (const v of ring) {
          if (typeof v?.lng !== 'number' || typeof v?.lat !== 'number') {
            throw new Error(
              `[forge] where.${key}.withinPolygon vertex requires numeric { lng, lat }.`,
            );
          }
        }
        // Auto-close: the spec wants the first vertex repeated at the end.
        const closed = ring[0].lng === ring[ring.length - 1].lng && ring[0].lat === ring[ring.length - 1].lat
          ? ring
          : [...ring, ring[0]];
        children.push({
          kind: 'leaf',
          field: key,
          op: 'withinPolygon',
          value: { polygon: closed.map((v) => ({ lng: v.lng!, lat: v.lat! })) },
        });
        continue;
      }
      for (const op of Object.keys(value)) {
        if (op === 'mode') continue;
        if (op === 'near') continue; // handled above
        if (op === 'withinPolygon') continue; // handled above
        if (op === 'path') continue; // handled above (jsonPath)
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

// Parse a dotted/indexed JSON path: 'profile.address[0].city' →
// ['profile', 'address', '0', 'city']. Array indexes become numeric strings
// so the per-dialect compiler can emit native indexing syntax.
function parseJsonPath(s: string): string[] {
  const out: string[] = [];
  const tokens = s.split('.');
  for (const t of tokens) {
    // Split `addresses[0]` into 'addresses' and '0'.
    const match = t.match(/^([^[\]]+)((?:\[\d+\])*)$/);
    if (!match) {
      throw new Error(`[forge] invalid JSON path segment: '${t}' in '${s}'`);
    }
    if (match[1]) out.push(match[1]);
    if (match[2]) {
      const idxs = match[2].match(/\[(\d+)\]/g) ?? [];
      for (const idx of idxs) out.push(idx.slice(1, -1));
    }
  }
  return out;
}
