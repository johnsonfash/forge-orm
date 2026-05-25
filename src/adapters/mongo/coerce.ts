import type { ObjectId } from 'mongodb';
import { mongo } from './bson';
import { FieldDef, ModelDef } from '../../schema/types';

// ============================================================================
// Coercion: bridges Prisma's app-side shape with Mongo's wire shape.
//
// Inbound  (app → db):  string ids → ObjectId, ISO/string dates → Date,
//                       `id` → `_id`, embedded subdocs recursed, defaults
//                       applied for create.
//
// Outbound (db → app):  ObjectId → string, `_id` → `id`, embedded subdocs
//                       recursed.
//
// The schema (per-model FieldDef map) drives every decision — no global
// hardcoded field-name lists. A typo in a schema field name is a TS error
// at the call site; here we just trust the shape.
// ============================================================================

const idStringToObjectId = (v: any): any => {
  if (v == null) return v;
  if (v instanceof mongo().ObjectId) return v;
  if (typeof v === 'string' && mongo().ObjectId.isValid(v)) return new (mongo().ObjectId)(v);
  return v;
};

const dateInToDate = (v: any): any => {
  if (v == null) return v;
  if (v instanceof Date) return v;
  if (typeof v === 'string' || typeof v === 'number') {
    const d = new Date(v);
    return isNaN(d.getTime()) ? v : d;
  }
  return v;
};

// ─── Inbound: filter/data path ──────────────────────────────────────────────
//
// Walks a value alongside its target FieldDef (when known) and coerces leaf
// scalars. For nested operator objects ($in/$gte/etc.) the same field's
// target type applies to the operator's payload.

export function coerceFieldValue(field: FieldDef | undefined, value: any): any {
  if (value == null || field == null) return value;

  // Operator object — walk its payload but keep the same field context.
  if (
    typeof value === 'object' &&
    !Array.isArray(value) &&
    !(value instanceof Date) &&
    !(value instanceof mongo().ObjectId)
  ) {
    const out: any = {};
    let isOp = false;
    for (const k of Object.keys(value)) {
      if (k.startsWith('$')) {
        isOp = true;
        const sub = value[k];
        if (Array.isArray(sub)) out[k] = sub.map((x) => coerceFieldValue(field, x));
        else out[k] = coerceFieldValue(field, sub);
      } else if (isOp) {
        out[k] = value[k];
      }
    }
    if (isOp) return out;
    // Otherwise let it fall through — could be an embed payload.
  }

  if (Array.isArray(value)) {
    return value.map((v) => coerceFieldValue(field, v));
  }

  switch (field.kind) {
    case 'id':
    case 'objectId':
      return idStringToObjectId(value);
    case 'dateTime':
      return dateInToDate(value);
    case 'embed':
    case 'embedMany': {
      // Recursively coerce embedded fields by their schema.
      const embed = field.embedOf?.();
      if (!embed) return value;
      if (field.kind === 'embedMany' && Array.isArray(value)) {
        return value.map((v) => coerceEmbed(v, embed.fields));
      }
      return coerceEmbed(value, embed.fields);
    }
    default:
      return value;
  }
}

function coerceEmbed(value: any, fields: Record<string, FieldDef>): any {
  if (value == null || typeof value !== 'object') return value;
  const out: any = { ...value };
  for (const k of Object.keys(out)) {
    const f = fields[k];
    if (f) out[k] = coerceFieldValue(f, out[k]);
  }
  return out;
}

// ─── Inbound: top-level helpers ─────────────────────────────────────────────
//
// `id` is the public name of `_id`. Everywhere we accept `id` we also need
// to accept `_id` defensively, but everywhere we *emit* downstream we use
// `_id` because that's the Mongo on-disk name.

export function appKeyToDbKey(key: string): string {
  return key === 'id' ? '_id' : key;
}

export function dbKeyToAppKey(key: string): string {
  return key === '_id' ? 'id' : key;
}

export function getFieldDef(
  model: ModelDef<any>,
  appKey: string,
): FieldDef | undefined {
  if (appKey === '_id') return model.fields['id'];
  return model.fields[appKey];
}

// ─── Defaults & timestamps for create/update ────────────────────────────────

export function applyCreateDefaults(model: ModelDef<any>, data: any): any {
  const out = { ...data };
  const entries = Object.entries(model.fields) as [string, FieldDef][];
  for (const [name, def] of entries) {
    if (out[name] !== undefined) continue;
    if (def.default) {
      if (def.default.kind === 'now') out[name] = new Date();
      else if (def.default.kind === 'autoId') out[name] = new (mongo().ObjectId)();
      else out[name] = def.default.value;
    }
    // else: optional and unset → leave field off the doc (Prisma parity).
  }
  return out;
}

export function applyUpdateTimestamps(model: ModelDef<any>, data: any): any {
  const out = { ...data };
  const entries = Object.entries(model.fields) as [string, FieldDef][];
  for (const [name, def] of entries) {
    if (def.updatedAt && out[name] === undefined) {
      out[name] = new Date();
    }
  }
  return out;
}

// ─── Inbound coercion of a full data payload ────────────────────────────────
//
// Coerces every recognised field to its db-side type and renames `id` → `_id`.

export function coerceCreatePayload(model: ModelDef<any>, data: any): any {
  const withDefaults = applyCreateDefaults(model, data);
  const out: any = {};
  for (const k of Object.keys(withDefaults)) {
    const dbKey = appKeyToDbKey(k);
    const def = getFieldDef(model, k);
    out[dbKey] = coerceFieldValue(def, withDefaults[k]);
  }
  return out;
}

// ─── Outbound: db doc → app row ────────────────────────────────────────────

export function decodeRow(model: ModelDef<any>, doc: any): any {
  if (doc == null) return doc;
  const out: any = {};
  for (const k of Object.keys(doc)) {
    const appKey = dbKeyToAppKey(k);
    const def = getFieldDef(model, appKey);
    out[appKey] = decodeValue(def, doc[k]);
  }
  return out;
}

function decodeValue(field: FieldDef | undefined, value: any): any {
  if (value == null) return value;
  if (value instanceof mongo().ObjectId) return value.toString();
  if (Array.isArray(value)) return value.map((v) => decodeValue(field, v));
  if (field?.kind === 'embed' || field?.kind === 'embedMany') {
    const embed = field.embedOf?.();
    if (!embed) return value;
    if (Array.isArray(value)) {
      return value.map((v) => decodeEmbed(v, embed.fields));
    }
    return decodeEmbed(value, embed.fields);
  }
  // Date stays Date; primitives stay as-is.
  return value;
}

function decodeEmbed(value: any, fields: Record<string, FieldDef>): any {
  if (value == null || typeof value !== 'object') return value;
  const out: any = {};
  for (const k of Object.keys(value)) {
    const def = fields[k];
    out[k] = decodeValue(def, value[k]);
  }
  return out;
}

// ─── Extended-JSON coercion for aggregation pipelines + raw commands ───────
//
// Prisma's `aggregateRaw` and `$runCommandRaw` auto-converted MongoDB
// extended-JSON markers in the call payload — `{ $oid: '...' }` → ObjectId,
// `{ $date: '...' }` → Date. The native MongoDB driver doesn't, so any
// pipeline still using those markers needs a pre-pass.
//
// Walks the value recursively. ObjectIds and Dates are returned untouched.
// Marker objects (single-key `$oid` / `$date` with a string/number value)
// become native types. Mongo aggregation operators (`$match`, `$expr`,
// `$eq`, etc.) start with `$` too but have non-string values and multiple
// nested keys — they're not single-key strings, so they pass through.

export function coerceExtendedJSON<T>(value: T): T {
  if (value == null) return value;
  if (typeof value !== 'object') return value;
  if (value instanceof Date) return value;
  if (
    typeof value === 'object' &&
    (value as any)._bsontype === 'ObjectId'
  ) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(coerceExtendedJSON) as unknown as T;
  }
  const obj: any = value;
  const keys = Object.keys(obj);
  if (keys.length === 1) {
    const k = keys[0];
    if (k === '$oid' && typeof obj.$oid === 'string') {
      // ObjectId is loaded lazily via mongo() so SQL-only installs never need
      // the mongodb driver just to import forge.
      if (mongo().ObjectId.isValid(obj.$oid)) {
        return new (mongo().ObjectId)(obj.$oid) as unknown as T;
      }
    }
    if (k === '$date') {
      const v = obj.$date;
      const d = typeof v === 'string' || typeof v === 'number' ? new Date(v) : v;
      if (d instanceof Date && !isNaN(d.getTime())) return d as unknown as T;
    }
  }
  const out: any = {};
  for (const k of keys) out[k] = coerceExtendedJSON(obj[k]);
  return out;
}
