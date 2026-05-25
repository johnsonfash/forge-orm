import { Filter } from 'mongodb';
import { ModelDef } from '../../../schema/types';
import { appKeyToDbKey, coerceFieldValue, getFieldDef } from '../coerce';

// ============================================================================
// Prisma `where` → Mongo Filter.
//
// Supported (matching Prisma's MongoDB connector surface):
//   • Bare equality:                { x: 1 }
//   • Logical:                      { AND, OR, NOT }
//   • Scalar operators:             equals, not, in, notIn, lt, lte, gt, gte
//   • String operators:             contains, startsWith, endsWith,
//                                   mode: 'insensitive' (regex-escaped)
//   • Array operators:              has, hasSome, hasEvery, isEmpty
//   • Relation filters (one):       { rel: { is: { ... } } / isNot }
//                                   (one-side relations are followed by FK
//                                   lookup at the call site, not here — for
//                                   v1 we do not translate to Mongo $lookup
//                                   filters; the codebase doesn't use them.)
//
// Every leaf value is coerced via the field's schema (string id → ObjectId,
// string date → Date, etc.). Regex metacharacters are escaped on the input
// to avoid injection.
// ============================================================================

const ESCAPE_REGEX = /[.*+?^${}()|[\]\\]/g;
const escapeRegex = (s: string) => s.replace(ESCAPE_REGEX, '\\$&');

const SCALAR_OPS: Record<string, string> = {
  equals: '$eq',
  not: '$ne',
  in: '$in',
  notIn: '$nin',
  lt: '$lt',
  lte: '$lte',
  gt: '$gt',
  gte: '$gte',
};

export function translateWhere(model: ModelDef<any>, where: any): Filter<any> {
  if (!where || typeof where !== 'object') return {};
  const filter: any = {};
  const ands: any[] = [];

  for (const key of Object.keys(where)) {
    const value = where[key];
    if (value === undefined) continue;

    if (key === 'AND') {
      const arr = Array.isArray(value) ? value : [value];
      ands.push({ $and: arr.map((v) => translateWhere(model, v)) });
      continue;
    }
    if (key === 'OR') {
      const arr = Array.isArray(value) ? value : [value];
      filter.$or = arr.map((v) => translateWhere(model, v));
      continue;
    }
    if (key === 'NOT') {
      const arr = Array.isArray(value) ? value : [value];
      filter.$nor = arr.map((v) => translateWhere(model, v));
      continue;
    }

    const dbKey = appKeyToDbKey(key);
    const def = getFieldDef(model, key);

    // Bare equality (incl. null) — coerce and assign.
    if (
      value === null ||
      typeof value !== 'object' ||
      value instanceof Date ||
      Array.isArray(value)
    ) {
      filter[dbKey] = coerceFieldValue(def, value);
      continue;
    }

    // Operator object: { equals, not, in, ..., contains, mode, has, ... }
    const opNode = translateOperatorObject(value, def);
    if (Object.keys(opNode).length > 0) {
      filter[dbKey] = opNode;
    }
  }

  if (ands.length === 0) return filter;
  if (Object.keys(filter).length === 0) {
    return ands.length === 1 ? ands[0] : { $and: ands };
  }
  return { $and: [filter, ...ands] };
}

function translateOperatorObject(value: any, def: any): any {
  const out: any = {};
  const insensitive = value.mode === 'insensitive';

  for (const op of Object.keys(value)) {
    if (op === 'mode') continue;
    const v = (value as any)[op];

    // Scalar comparison operators
    if (SCALAR_OPS[op]) {
      const mongoOp = SCALAR_OPS[op];
      if (Array.isArray(v)) {
        out[mongoOp] = v.map((x) => coerceFieldValue(def, x));
      } else {
        out[mongoOp] = coerceFieldValue(def, v);
      }
      continue;
    }

    // String operators
    if (op === 'contains') {
      out.$regex = escapeRegex(String(v));
      if (insensitive) out.$options = 'i';
      continue;
    }
    if (op === 'startsWith') {
      out.$regex = '^' + escapeRegex(String(v));
      if (insensitive) out.$options = 'i';
      continue;
    }
    if (op === 'endsWith') {
      out.$regex = escapeRegex(String(v)) + '$';
      if (insensitive) out.$options = 'i';
      continue;
    }

    // Array operators
    if (op === 'has') {
      // { tags: { has: 'x' } } — Mongo array containment is plain equality.
      out.$elemMatch = { $eq: coerceFieldValue(def, v) };
      continue;
    }

    // Embedded-list filters — Prisma's `some` / `every` / `none` semantics
    // for filtering documents by sub-shapes inside an array of composite
    // (embedMany) fields. Maps to Mongo's $elemMatch with appropriate
    // negation. Field-level ObjectId/Date coercion uses the embed's own
    // schema (def.embedOf()) so filter values like { user_profile_id: '<hex>' }
    // are coerced to ObjectId before being sent to Mongo.
    if (op === 'some') {
      out.$elemMatch = translateEmbedSubFilter(v, def);
      continue;
    }
    if (op === 'every') {
      // Prisma `every`: true iff every element matches. Mongo encoding:
      // there's NO element that doesn't match.
      out.$not = { $elemMatch: { $nor: [translateEmbedSubFilter(v, def)] } };
      continue;
    }
    if (op === 'none') {
      out.$not = { $elemMatch: translateEmbedSubFilter(v, def) };
      continue;
    }
    if (op === 'hasSome') {
      out.$in = (Array.isArray(v) ? v : [v]).map((x) => coerceFieldValue(def, x));
      continue;
    }
    if (op === 'hasEvery') {
      out.$all = (Array.isArray(v) ? v : [v]).map((x) => coerceFieldValue(def, x));
      continue;
    }
    if (op === 'isEmpty') {
      out.$size = v ? 0 : { $gt: 0 };
      continue;
    }

    // Pass-through for raw Mongo operators ($exists, $regex, etc.)
    if (op.startsWith('$')) {
      out[op] = coerceFieldValue(def, v);
      continue;
    }
  }

  return out;
}

// Translate an embed-list sub-filter (the body of `some` / `every` / `none`).
// Plain scalar equalities are coerced via the embed's per-field schema so
// ObjectId-typed fields like `user_profile_id` get string→ObjectId conversion.
// Operator objects (e.g. `is_read: { equals: false }`) recurse through the
// scalar operator path with the matched embed field's def for context.
function translateEmbedSubFilter(value: any, parentDef: any): any {
  if (!value || typeof value !== 'object') return value;
  const embed = parentDef?.embedOf?.();
  const out: any = {};
  for (const k of Object.keys(value)) {
    const v = value[k];
    const subDef = embed?.fields?.[k];
    if (
      v !== null &&
      typeof v === 'object' &&
      !(v instanceof Date) &&
      !Array.isArray(v)
    ) {
      // Operator object on an embed field — translate via the same scalar
      // path so { is_read: { equals: false } } etc. work consistently.
      const opNode = translateOperatorObject(v, subDef);
      if (Object.keys(opNode).length > 0) out[k] = opNode;
      continue;
    }
    out[k] = coerceFieldValue(subDef, v);
  }
  return out;
}
