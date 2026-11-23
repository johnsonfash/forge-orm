import type { ModelDef } from '../../schema/types';

// Dialects whose driver hands a JSON column back as text (DuckDB's node API,
// tedious on SQL Server) parse it here, so f.json() reads as the object it
// was written as on every dialect. The field list is worked out once per
// model.

const plans = new WeakMap<object, string[]>();
const plansWithArrays = new WeakMap<object, string[]>();

function jsonFields(model: ModelDef<any>, arrays: boolean): string[] {
  const cache = arrays ? plansWithArrays : plans;
  let plan = cache.get(model);
  if (plan) return plan;
  plan = [];
  for (const [name, f] of Object.entries(model.fields ?? {})) {
    const def = f as { kind?: string; geo?: { fallback?: boolean } };
    if (def.kind === 'json' || def.kind === 'embed' || def.kind === 'embedMany') plan.push(name);
    else if (def.kind === 'geoPoint' && def.geo?.fallback) plan.push(name);
    else if (arrays && (def.kind === 'stringArray' || def.kind === 'intArray')) plan.push(name);
  }
  cache.set(model, plan);
  return plan;
}

function parse(v: string): unknown {
  try { return JSON.parse(v); } catch { return v; }
}

/**
 * Parses JSON-typed columns that arrived as strings, in place. `arrays` also
 * covers f.stringArray() / f.intArray(), for a dialect that stores those as
 * JSON text (SQL Server has no array type).
 */
export function decodeJsonColumns<T extends Record<string, unknown>>(
  model: ModelDef<any> | undefined, rows: T[], opts: { arrays?: boolean } = {},
): T[] {
  if (!model || rows.length === 0) return rows;
  const fields = jsonFields(model, !!opts.arrays);
  if (fields.length === 0) return rows;
  for (const r of rows) {
    if (!r || typeof r !== 'object') continue;
    for (const f of fields) {
      const v = r[f];
      if (typeof v === 'string') (r as Record<string, unknown>)[f] = parse(v);
    }
  }
  return rows;
}
