// Shared plumbing for the deep comparison: types, the round-trip counter,
// value coercion for the correctness check, and timing maths.

export type Dialect = "postgres" | "mysql" | "sqlite" | "mongo" | "duckdb" | "mssql";
export const DIALECTS: Dialect[] = ["postgres", "mysql", "sqlite", "mongo", "duckdb", "mssql"];
export type EngineName = "raw" | "forge" | "prisma" | "drizzle" | "kysely" | "knex";
export const ENGINES: EngineName[] = ["raw", "forge", "prisma", "drizzle", "kysely", "knex"];

// `i` is the iteration index (0 for the correctness run). `n` is the size knob
// a scenario exposes (root rows of an include); the N+1 probe varies it.
export type Op = (i: number, n: number) => Promise<unknown>;

export interface EngineImpl {
  ops: Partial<Record<string, Op>>;
  na?: Partial<Record<string, string>>;
  close(): Promise<void>;
  // Prisma on a driver whose wire calls cannot be intercepted counts through
  // its own query event instead; see instrument.ts.
  countsOwnQueries?: boolean;
}

export interface Sample { median: number; p95: number; mean: number; opsPerSec: number; iters: number }

export function summarize(runs: number[]): Sample {
  const s = [...runs].sort((a, b) => a - b);
  const median = s[Math.floor(s.length / 2)] ?? 0;
  const p95 = s[Math.min(s.length - 1, Math.floor(s.length * 0.95))] ?? 0;
  const mean = s.reduce((a, b) => a + b, 0) / (s.length || 1);
  return { median, p95, mean, opsPerSec: 1000 / (median || Number.EPSILON), iters: s.length };
}

// ─── Round-trip counter ─────────────────────────────────────────────────────
// Every wire call any engine makes lands here (instrument.ts patches the
// drivers). `on` is false while fixtures run, so setup work is never billed.

export const RT = {
  on: false,
  n: 0,
  capture: false,
  log: [] as string[],
  hit(text: unknown) {
    if (!RT.on) return;
    RT.n++;
    if (RT.capture && RT.log.length < 60) RT.log.push(stmtText(text));
  },
};

function stmtText(t: unknown): string {
  if (typeof t === "string") return t.replace(/\s+/g, " ").trim();
  if (t && typeof t === "object") {
    const o = t as any;
    if (typeof o.text === "string") return stmtText(o.text);
    if (typeof o.sql === "string") return stmtText(o.sql);
    try { return JSON.stringify(o).slice(0, 2000); } catch { return String(o); }
  }
  return String(t);
}

export async function counted<T>(fn: () => Promise<T>, capture = false): Promise<{ value: T; rt: number; sql: string[] }> {
  RT.n = 0; RT.log = []; RT.capture = capture; RT.on = true;
  try {
    const value = await fn();
    return { value, rt: RT.n, sql: RT.log };
  } finally {
    RT.on = false; RT.capture = false;
  }
}

export async function uncounted<T>(fn: () => Promise<T>): Promise<T> {
  const was = RT.on;
  RT.on = false;
  try { return await fn(); } finally { RT.on = was; }
}

// ─── Coercion for the correctness check ─────────────────────────────────────
// Each scenario's canon() picks the fields it means and coerces them with
// these, so a 1 from a raw SQLite row and a `true` from an ORM compare equal.

export const C = {
  s: (v: any): string | null => (v == null ? null : String(v)),
  n: (v: any): number | null => (v == null ? null : typeof v === "bigint" ? Number(v) : Number(v)),
  r: (v: any, dp = 4): number | null => (v == null ? null : Math.round(Number(v) * 10 ** dp) / 10 ** dp),
  b: (v: any): boolean | null => (v == null ? null : typeof v === "string" ? v === "1" || v === "true" : !!Number(v)),
  d: (v: any): string | null => {
    if (v == null) return null;
    if (v instanceof Date) return v.toISOString();
    if (typeof v === "number" || typeof v === "bigint") return new Date(Number(v)).toISOString();
    if (typeof v === "object" && typeof v.toString === "function") v = v.toString();
    const s = String(v);
    const iso = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d+)?$/.test(s) ? s.replace(" ", "T") + "Z" : s;
    const t = new Date(iso);
    return isNaN(t.getTime()) ? s : t.toISOString();
  },
  j: (v: any): any => {
    if (v == null) return null;
    if (typeof v === "string") { try { return JSON.parse(v); } catch { return v; } }
    if (typeof v === "object" && !Array.isArray(v) && typeof (v as any).toJSON === "function" && !(v instanceof Date)) return v.toJSON();
    return v;
  },
};

export function stable(v: any): string {
  return JSON.stringify(sortKeys(v)).replace(/x(?:raw|forge|prisma|drizzle|kysely|knex)/g, "xE");
}

function sortKeys(v: any): any {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === "object" && !(v instanceof Date)) {
    const o: any = {};
    for (const k of Object.keys(v).sort()) o[k] = sortKeys(v[k]);
    return o;
  }
  if (typeof v === "bigint") return Number(v);
  return v;
}

// ─── Small helpers shared by engines ────────────────────────────────────────

export function groupInto<P, R>(parents: P[], children: R[], parentKey: (p: P) => any, childKey: (r: R) => any, field: string): P[] {
  const m = new Map<any, R[]>();
  for (const c of children) {
    const k = childKey(c);
    let a = m.get(k);
    if (!a) { a = []; m.set(k, a); }
    a.push(c);
  }
  for (const p of parents) (p as any)[field] = m.get(parentKey(p)) ?? [];
  return parents;
}

export function indexBy<R>(rows: R[], key: (r: R) => any): Map<any, R> {
  const m = new Map<any, R>();
  for (const r of rows) m.set(key(r), r);
  return m;
}

export function haversine(a: { lng: number; lat: number }, b: { lng: number; lat: number }): number {
  const R = 6371008.8, rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad, dLng = (b.lng - a.lng) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

export const now = () => performance.now();
