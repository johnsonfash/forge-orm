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

// Every key a filter object may legally carry: scalar ops plus the special
// forms handled before the SCALAR_OPS loop.
const KNOWN_FILTER_KEYS: ReadonlySet<string> = new Set([
  ...Object.keys(SCALAR_OPS), 'mode', 'near', 'withinPolygon', 'path',
]);

// Column kinds whose contents can be addressed with a path (dotted key or
// `path` filter). Mirrors the allowlist in the `path` branch below.
const CONTAINER_KINDS: ReadonlySet<string> = new Set([
  'json', 'embed', 'embedMany', 'stringArray', 'intArray',
]);

// Filter-object keys that translate to a jsonPath sub-op (dotted-key form).
const PATH_SUB_OPS: Record<string, 'eq' | 'ne' | 'lt' | 'lte' | 'gt' | 'gte' | 'contains' | 'in' | 'has'> = {
  equals: 'eq',
  not: 'ne',
  lt: 'lt',
  lte: 'lte',
  gt: 'gt',
  gte: 'gte',
  contains: 'contains',
  in: 'in',
  has: 'has',
};

// Small edit-distance for "did you mean" — enough to catch one-or-two-character
// slips without pulling in a dependency.
function editDistance(a: string, b: string): number {
  const m = a.length, n = b.length;
  if (Math.abs(m - n) > 2) return 3;
  const row = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i++) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= n; j++) {
      const tmp = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return row[n];
}

function closestFilterKey(op: string): string | undefined {
  let best: string | undefined;
  let bestD = 3;
  for (const k of KNOWN_FILTER_KEYS) {
    const d = editDistance(op.toLowerCase(), k.toLowerCase());
    if (d < bestD) { bestD = d; best = k; }
  }
  return best;
}

// A filter with an operator forge doesn't know used to be DROPPED silently,
// so the condition vanished and the query matched every row — the worst
// possible failure for a scoping or money filter. Throw instead, with the
// most likely correction first.
function unknownOpError(model: ModelDef<any>, field: string, op: string): Error {
  const bare = op.startsWith('$') ? op.slice(1) : undefined;
  const fdef: any = model.fields?.[field];
  let hint: string;
  if (bare && bare in SCALAR_OPS) {
    hint = `Did you mean '${bare}'? forge uses bare operator names, not Mongo's $-prefixed ones.`;
  } else {
    const close = closestFilterKey(op);
    hint = close ? `Did you mean '${close}'?` : '';
  }
  if (fdef && CONTAINER_KINDS.has(fdef.kind)) {
    hint += `${hint ? ' ' : ''}To filter inside a ${fdef.kind} column use ` +
      `{ ${field}: { path: '<sub.path>', equals: … } }, the dotted form ` +
      `{ '${field}.<sub>': … }, or { ${field}: { equals: <whole value> } } for exact match.`;
  }
  return new Error(
    `[forge] unknown operator '${op}' on '${model.collection}.${field}'. ` +
    `Valid: ${Object.keys(SCALAR_OPS).join(', ')}, mode, near, withinPolygon, path.` +
    (hint ? `\n  ${hint}` : '') +
    `\n  (forge used to drop unknown operators silently, which made the filter match every row.)`,
  );
}

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

    // Dotted path into a container column — `{ 'address.city': 'sf' }` or
    // `{ 'meta.stats.views': { gte: 10 } }`. Translated to the same jsonPath
    // leaf the `path` filter produces, so it compiles on every dialect
    // (Mongo: dot notation; SQL: native JSON path) instead of only working
    // by accident on Mongo. Dotted keys whose head is NOT a declared
    // container column fall through to the legacy leaf below (loose-mode
    // passthrough for raw Mongo shapes).
    if (key.includes('.')) {
      const dot = key.indexOf('.');
      const head = key.slice(0, dot);
      const fdef: any = model.fields?.[head];
      if (fdef && CONTAINER_KINDS.has(fdef.kind)) {
        const path = parseJsonPath(key.slice(dot + 1));
        if (value && typeof value === 'object' && !Array.isArray(value) && !isDate(value)) {
          for (const op of Object.keys(value)) {
            const subOp = PATH_SUB_OPS[op];
            if (!subOp) {
              throw new Error(
                `[forge] unsupported operator '${op}' on path '${key}' ` +
                `('${model.collection}'). Paths support: ${Object.keys(PATH_SUB_OPS).join(', ')}.`,
              );
            }
            children.push({
              kind: 'leaf', field: head, op: 'jsonPath', value: value[op],
              jsonPath: { path, subOp },
            });
          }
        } else {
          children.push({
            kind: 'leaf', field: head, op: 'jsonPath', value,
            jsonPath: { path, subOp: 'eq' },
          });
        }
        continue;
      }
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
      // Geo polygon containment — accepts single-ring, Polygon-with-holes,
      // MultiPolygon, or GeometryCollection. Normalises to a uniform
      // `{ multiPolygon: Polygon[] }` shape where each Polygon is
      // `Ring[]` (outer ring + 0..N holes) and each Ring is `Point[]`.
      if ('withinPolygon' in value && value.withinPolygon != null) {
        const normalised = normaliseWithinPolygon(key, value.withinPolygon);
        children.push({
          kind: 'leaf',
          field: key,
          op: 'withinPolygon',
          value: { multiPolygon: normalised },
        });
        continue;
      }
      buildOperatorLeaves(model, key, value, insensitive, children);
    } else {
      children.push({ kind: 'leaf', field: key, op: 'eq', value });
    }
  }

  if (children.length === 0) return undefined;
  if (children.length === 1) return children[0];
  return { kind: 'and', children };
}

// Turn one filter object (`{ gte: 5, mode: 'insensitive', not: {...} }`) into
// leaves. Shared by the top-level operator branch and nested `not` objects.
function buildOperatorLeaves(
  model: ModelDef<any>,
  field: string,
  obj: Record<string, any>,
  insensitive: boolean,
  children: WhereTree[],
): void {
  for (const op of Object.keys(obj)) {
    if (op === 'mode') continue;
    if (op === 'near') continue; // handled by the caller's earlier branch
    if (op === 'withinPolygon') continue; // handled by the caller's earlier branch
    if (op === 'path') continue; // handled by the caller's earlier branch
    const operand = obj[op];
    if (operand === undefined) continue;

    // Nested filter under `not` — `{ title: { not: { contains: 'x' } } }`.
    // The typed surface has always advertised `not?: T | Filter`, but the
    // object form used to compile to a literal `$ne: { contains: 'x' }`,
    // which matches every row. Build the inner filter and negate it.
    // Container columns (json/embed) keep the literal comparison: there
    // `not: { … }` means "not equal to this exact value", and its keys are
    // data, not operators.
    const fkind = (model.fields?.[field] as any)?.kind;
    if (
      op === 'not' && operand !== null && typeof operand === 'object' &&
      !Array.isArray(operand) && !isDate(operand) && !isColRef(operand) &&
      (operand as any)._bsontype === undefined &&
      !(fkind && CONTAINER_KINDS.has(fkind))
    ) {
      const inner: WhereTree[] = [];
      const innerInsensitive = insensitive || (operand as any).mode === 'insensitive';
      buildOperatorLeaves(model, field, operand, innerInsensitive, inner);
      if (inner.length === 1) children.push({ kind: 'not', child: inner[0] });
      else if (inner.length > 1) children.push({ kind: 'not', child: { kind: 'and', children: inner } });
      continue;
    }

    const irOp = SCALAR_OPS[op];
    if (!irOp) throw unknownOpError(model, field, op);
    if (isColRef(operand)) {
      children.push({
        kind: 'leaf',
        field,
        op: irOp,
        value: undefined,
        rhsField: resolveColRef(model, irOp, operand),
      });
      continue;
    }
    children.push({
      kind: 'leaf',
      field,
      op: irOp,
      value: operand,
      caseInsensitive: insensitive || undefined,
    });
  }
}

function notUndef<T>(v: T | undefined): v is T {
  return v !== undefined;
}

function isDate(v: any): boolean {
  return v instanceof Date;
}

// Normalise every accepted withinPolygon input shape to a uniform
// `Polygon[]` (i.e. MultiPolygon-shaped: array of polygons; each polygon is
// outer-ring + 0..N holes; each ring is a closed Array<{lng,lat}>).
//
//   • Array<{lng,lat}>                            single ring → 1 polygon, 1 ring
//   • { type: 'Polygon', rings: Ring[] }          1 polygon with holes
//   • { type: 'MultiPolygon', polygons: ... }     N polygons
//   • { type: 'GeometryCollection', geometries }  flatten Polygon / MultiPolygon
//
// Throws with a clear message on any shape we can't reach.
type Point = { lng: number; lat: number };
type Ring = Point[];
type Polygon = Ring[];

function normaliseWithinPolygon(key: string, raw: unknown): Polygon[] {
  // Array form — single ring.
  if (Array.isArray(raw)) {
    return [[validateAndCloseRing(key, raw)]];
  }
  if (!raw || typeof raw !== 'object') {
    throw new Error(`[forge] where.${key}.withinPolygon must be a ring, Polygon, MultiPolygon, or GeometryCollection.`);
  }
  const obj = raw as { type?: string; rings?: unknown[]; polygons?: unknown[]; geometries?: unknown[] };
  if (obj.type === 'Polygon') {
    if (!Array.isArray(obj.rings) || obj.rings.length === 0) {
      throw new Error(`[forge] where.${key}.withinPolygon: Polygon needs at least one ring in 'rings'.`);
    }
    return [obj.rings.map((r) => validateAndCloseRing(key, r))];
  }
  if (obj.type === 'MultiPolygon') {
    if (!Array.isArray(obj.polygons) || obj.polygons.length === 0) {
      throw new Error(`[forge] where.${key}.withinPolygon: MultiPolygon needs at least one polygon in 'polygons'.`);
    }
    return obj.polygons.map((p) => {
      if (!Array.isArray(p) || p.length === 0) {
        throw new Error(`[forge] where.${key}.withinPolygon: each MultiPolygon entry needs at least one ring.`);
      }
      return p.map((r) => validateAndCloseRing(key, r));
    });
  }
  if (obj.type === 'GeometryCollection') {
    if (!Array.isArray(obj.geometries) || obj.geometries.length === 0) {
      throw new Error(`[forge] where.${key}.withinPolygon: GeometryCollection needs entries in 'geometries'.`);
    }
    const out: Polygon[] = [];
    for (const g of obj.geometries) {
      out.push(...normaliseWithinPolygon(key, g));
    }
    return out;
  }
  throw new Error(`[forge] where.${key}.withinPolygon: unsupported type '${String(obj.type)}'.`);
}

function validateAndCloseRing(key: string, ring: unknown): Ring {
  if (!Array.isArray(ring) || ring.length < 3) {
    throw new Error(`[forge] where.${key}.withinPolygon: each ring needs at least 3 vertices.`);
  }
  const pts: Point[] = [];
  for (const v of ring as Array<{ lng?: number; lat?: number }>) {
    if (typeof v?.lng !== 'number' || typeof v?.lat !== 'number') {
      throw new Error(`[forge] where.${key}.withinPolygon vertex requires numeric { lng, lat }.`);
    }
    pts.push({ lng: v.lng, lat: v.lat });
  }
  const first = pts[0], last = pts[pts.length - 1];
  if (first.lng !== last.lng || first.lat !== last.lat) pts.push({ lng: first.lng, lat: first.lat });
  return pts;
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
