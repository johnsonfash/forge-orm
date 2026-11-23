import type { ModelDef } from '../../schema/types';

// A 64-bit integer column comes back from most drivers as something other
// than what forge's types promise. node-postgres, postgres.js and tedious
// return int8 / BIGINT as a STRING; the mariadb connector and DuckDB return a
// JS bigint; better-sqlite3 and mysql2 return a number. forge says a
// `f.id({ type: 'bigserial' })` is a `number` and an `f.bigint()` is a
// `bigint`, so each row is brought into line here, by field — the driver's
// own parsers are left alone, because they decide COUNT(*) and every raw
// query the application writes too.
//
// A bigserial id past Number.MAX_SAFE_INTEGER cannot be a `number` without
// being rounded to a different id, so that is an error rather than a guess.

type Plan = Array<[field: string, to: 'number' | 'bigint']>;
const plans = new WeakMap<object, Plan>();

function planFor(model: ModelDef<any>): Plan {
  let plan = plans.get(model);
  if (plan) return plan;
  plan = [];
  for (const [name, f] of Object.entries(model.fields ?? {})) {
    const def = f as { kind?: string; idType?: string };
    if (def.kind === 'id' && def.idType === 'bigserial') plan.push([name, 'number']);
    else if (def.kind === 'bigint') plan.push([name, 'bigint']);
  }
  plans.set(model, plan);
  return plan;
}

function toNumber(model: ModelDef<any>, field: string, v: unknown): unknown {
  if (typeof v === 'number') return v;
  if (typeof v !== 'string' && typeof v !== 'bigint') return v;
  const n = Number(v);
  if (!Number.isSafeInteger(n)) {
    throw new Error(
      `[forge] ${model.collection}.${field} is ${String(v)}, past Number.MAX_SAFE_INTEGER, ` +
        `and a bigserial id is typed as a number: it would be rounded to a different id. ` +
        `Declare the column with f.bigint() to read it as a bigint.`,
    );
  }
  return n;
}

function toBigint(model: ModelDef<any>, field: string, v: unknown): unknown {
  if (typeof v === 'bigint') return v;
  if (typeof v === 'string' && /^-?\d+$/.test(v)) return BigInt(v);
  if (typeof v === 'number' && Number.isInteger(v)) {
    if (!Number.isSafeInteger(v)) {
      throw new Error(
        `[forge] ${model.collection}.${field} came back from the driver as the number ${v}, ` +
          `which is past Number.MAX_SAFE_INTEGER and so already rounded. Configure the ` +
          `driver to return big integers as strings or bigints (mysql2: supportBigNumbers ` +
          `and bigNumberStrings; better-sqlite3: safeIntegers).`,
      );
    }
    return BigInt(v);
  }
  return v;
}

/** The row with its bigserial ids as numbers and f.bigint() fields as bigints. */
export function decodeWideIntegers<T extends Record<string, unknown> | null | undefined>(
  model: ModelDef<any> | undefined,
  row: T,
): T {
  if (!model || !row || typeof row !== 'object') return row;
  const plan = planFor(model);
  if (plan.length === 0) return row;
  let out: Record<string, unknown> | null = null;
  for (const [field, to] of plan) {
    if (!(field in row)) continue;
    const v = (row as Record<string, unknown>)[field];
    if (v == null) continue;
    const next = to === 'number' ? toNumber(model, field, v) : toBigint(model, field, v);
    if (next !== v) {
      out ??= { ...(row as Record<string, unknown>) };
      out[field] = next;
    }
  }
  return (out ?? row) as T;
}

export function decodeWideIntegerRows<T extends Record<string, unknown>>(model: ModelDef<any> | undefined, rows: T[]): T[] {
  if (!model || rows.length === 0 || planFor(model).length === 0) return rows;
  return rows.map((r) => decodeWideIntegers(model, r));
}
