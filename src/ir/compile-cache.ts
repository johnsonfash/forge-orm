// Compiled SQL, cached per query shape.
//
// A query run twice with the same structure and different values compiles to
// the same SQL text; only the parameters change. This cache keys a compiled
// statement on the IR node with its values taken out, and on a repeat shape
// skips the compiler and fills the parameters in from the new values.
//
// How a parameter maps to a value is LEARNED, not assumed. The second time a
// shape is seen it is compiled three times: with the real values and with two
// sets of probe values (distinct, odd-looking stand-ins of the same kind).
// Every parameter must then be either
//   - the same in all three compiles (a constant: a boolean the dialect turned
//     into 1, a soft-delete NULL...),
//   - exactly the probe value that went in (passed through), or
//   - JSON.stringify / toISOString of it (MySQL's and SQLite's own coercions),
// and the SQL text must be identical in all three. Anything else (a LIKE
// pattern built around a value, a value the compiler read to pick a
// different SQL form) marks the shape as never cached, and it compiles as it
// always did. The learned mapping is then checked against the real compile's
// own parameters before it is trusted.
//
// What decides SQL text and is therefore part of the key, never a slot:
// booleans, null and undefined, empty strings, zero, NaN / Infinity, the
// sign and integer-ness of numbers, array lengths, take / skip, every
// operator, field, relation and option. Values that are not plain data (a
// Buffer, a class instance, a null marker) bypass the cache entirely.

import type { SQLArtifact } from '../compile';
import { getActiveSchema } from '../schema/active';
import { isForgeNullMarker } from '../null-markers';

type Compile<N> = (node: N, model?: any, dialect?: any) => SQLArtifact;

const enum State { Seen, Ready, Never }
const enum Xf { Id, Json, Iso }

interface Slot { c: boolean; v: unknown; i: number; x: Xf }
interface Entry { s: State; seq: number[]; sql?: string; slots?: Slot[]; extra?: Record<string, unknown> }

let enabled = !/^(0|off|false)$/i.test(
  (typeof process !== 'undefined' && process.env?.FORGE_COMPILE_CACHE) || '',
);
let maxShapes = 1000;
// Longer `in` lists still compile correctly; they just do not get a cache
// entry per length.
const MAX_ARRAY = 1000;

const caches: Array<Map<number, Entry>> = [];

/**
 * Turn the per-shape SQL cache on or off, or change how many shapes each
 * statement kind keeps (least recently used are dropped). On by default; the
 * `FORGE_COMPILE_CACHE=off` environment variable turns it off at start-up.
 */
export function configureCompileCache(opts: { enabled?: boolean; maxShapes?: number }): void {
  if (opts.enabled != null) enabled = opts.enabled;
  if (opts.maxShapes != null) maxShapes = Math.max(0, Math.floor(opts.maxShapes));
  for (const c of caches) { if (!enabled || c.size > maxShapes) c.clear(); }
}

/** Entries currently held, per statement kind (for tests and diagnostics). */
export function compileCacheStats(): { shapes: number; ready: number; never: number } {
  let shapes = 0, ready = 0, never = 0;
  for (const c of caches) for (const e of c.values()) {
    shapes++;
    if (e.s === State.Ready) ready++;
    else if (e.s === State.Never) never++;
  }
  return { shapes, ready, never };
}

let ids = new WeakMap<object, number>();
let nextId = 1;
function idOf(o: object): number {
  let n = ids.get(o);
  if (n === undefined) { n = nextId++; ids.set(o, n); }
  return n;
}

// ─── signature ──────────────────────────────────────────────────────────────
//
// The shape is written as a sequence of numbers: tags, interned strings and
// the numbers that are structure. It is hashed for the lookup and compared in
// full on a hit, so two shapes can never share an entry. (Building a string
// key instead cost more than compiling a simple query.)

class Bypass extends Error {}
const BYPASS = new Bypass();

// The keys of an UpdateNode / InsertNode whose own values are data.
const DATA_MAPS = new Set(['set', 'upsertCreate', 'increment', 'multiply', 'divide', 'max', 'min', 'push', 'addToSet', 'pull']);

const enum Tk {
  Open = -1, Close = -2, Arr = -3, Str = -4, Num = -5, True = -6, False = -7, Null = -8, Undef = -9,
  Big = -10, Date = -11, Rows = -13, Data = -14, Cursor = -15,
  VStr = -20, VInt = -21, VNegInt = -22, VFloat = -23, VNegFloat = -24, VBig = -25, VNegBig = -26,
  VDate = -27, VArr = -28, VObj = -29, VMarker = -30, VEmpty = -31,
}

// Strings in structure (field names, operators, keys) map to small integers.
// User strings can reach structure (a JSON path, an orderBy field), so the
// table is bounded: past the limit it starts again, and with it every cache.
let interned = new Map<string, number>();
const MAX_INTERNED = 50_000;
function sid(s: string): number {
  let n = interned.get(s);
  if (n === undefined) {
    if (interned.size >= MAX_INTERNED) { interned = new Map(); for (const c of caches) c.clear(); }
    n = interned.size + 1;
    interned.set(s, n);
  }
  return n;
}

let seq: number[] = [];
let vals: unknown[] = [];

// Every entry of the sequence is a 32-bit integer (cheap to hash and compare):
// a small non-negative integer stands for itself, anything else is interned.
function num(v: number): number {
  return (v | 0) === v && v >= 0 && v < 0x40000000 ? v + 0x40000000 : sid('n' + v);
}

function isPlain(o: object): boolean {
  const p = Object.getPrototypeOf(o);
  return p === Object.prototype || p === null;
}

// A literal: everything about it is structure.
function lit(v: unknown): void {
  switch (typeof v) {
    case 'string': seq.push(Tk.Str, sid(v)); return;
    case 'number': seq.push(Tk.Num, num(v)); return;
    case 'boolean': seq.push(v ? Tk.True : Tk.False); return;
    case 'undefined': seq.push(Tk.Undef); return;
    case 'bigint': seq.push(Tk.Big, sid(String(v))); return;
    case 'object':
      if (v === null) { seq.push(Tk.Null); return; }
      if (Array.isArray(v)) {
        seq.push(Tk.Arr, v.length);
        for (let i = 0; i < v.length; i++) lit(v[i]);
        return;
      }
      if (v instanceof Date) { seq.push(Tk.Date, num(v.getTime())); return; }
      if (!isPlain(v)) throw BYPASS;
      obj(v as Record<string, unknown>);
      return;
    default:
      throw BYPASS;
  }
}

// An undefined property is left out: the compilers read IR properties, they
// never ask whether one is present.
function obj(o: Record<string, unknown>): void {
  seq.push(Tk.Open);
  const leaf = o.kind === 'leaf';
  for (const k in o) {
    const v = o[k];
    if (v === undefined) continue;
    seq.push(sid(k));
    if (leaf && k === 'value') val(v);
    else if (k === 'cursor' && typeof v === 'object' && v !== null && (v as any).fields) { seq.push(Tk.Cursor); dataMap((v as any).fields); }
    else lit(v);
  }
  seq.push(Tk.Close);
}

// A map of column to value (a row, a SET). Every key counts, undefined ones
// too: the compilers take the column list from Object.keys.
function dataMap(m: unknown): void {
  if (!m || typeof m !== 'object' || Array.isArray(m) || !isPlain(m)) { lit(m); return; }
  seq.push(Tk.Data);
  for (const k in m as any) { seq.push(sid(k)); val((m as any)[k]); }
  seq.push(Tk.Close);
}

// A value: what decides SQL text is structure; the value itself becomes a slot.
function val(v: unknown): void {
  switch (typeof v) {
    case 'string':
      if (v === '') { seq.push(Tk.VEmpty); return; }
      seq.push(Tk.VStr); vals.push(v); return;
    case 'number':
      if (v === 0 || !Number.isSafeInteger(v) && (!Number.isFinite(v) || Number.isInteger(v))) {
        seq.push(Tk.Num, Object.is(v, -0) ? sid('-0') : num(v)); return;
      }
      seq.push(Number.isInteger(v) ? (v > 0 ? Tk.VInt : Tk.VNegInt) : (v > 0 ? Tk.VFloat : Tk.VNegFloat));
      vals.push(v); return;
    case 'bigint':
      if (v === 0n) { seq.push(Tk.Big, 0); return; }
      seq.push(v > 0n ? Tk.VBig : Tk.VNegBig); vals.push(v); return;
    case 'boolean': seq.push(v ? Tk.True : Tk.False); return;
    case 'undefined': seq.push(Tk.Undef); return;
    case 'object': {
      if (v === null) { seq.push(Tk.Null); return; }
      if (v instanceof Date) {
        if (Number.isNaN(v.getTime())) { seq.push(Tk.Date, sid('NaN')); return; }
        seq.push(Tk.VDate); vals.push(v); return;
      }
      if (Array.isArray(v)) {
        if (v.length > MAX_ARRAY) throw BYPASS;
        seq.push(Tk.VArr, v.length);
        vals.push(v);
        for (let i = 0; i < v.length; i++) val(v[i]);
        return;
      }
      if (!isPlain(v)) throw BYPASS;
      if (isForgeNullMarker(v)) { seq.push(Tk.VMarker, sid((v as any).__forge)); return; }
      // Plain JSON data: its keys are structure, its leaves values.
      seq.push(Tk.VObj);
      vals.push(v);
      for (const k in v as any) { seq.push(sid(k)); val((v as any)[k]); }
      seq.push(Tk.Close);
      return;
    }
    default:
      throw BYPASS;
  }
}

function signature(node: any, head: number[]): void {
  seq = head;
  vals = [];
  for (const k in node) {
    const v = node[k];
    if (v === undefined) continue;
    seq.push(sid(k));
    if (k === 'rows' && Array.isArray(v)) {
      seq.push(Tk.Rows, v.length);
      for (let i = 0; i < v.length; i++) dataMap(v[i]);
    } else if (DATA_MAPS.has(k)) dataMap(v);
    else lit(v);
  }
}

function hashOf(s: number[]): number {
  let h = 0x811c9dc5 | 0;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s[i], 16777619);
  return h >>> 0;
}

function sameSeq(a: number[], b: number[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// ─── probes ─────────────────────────────────────────────────────────────────

// A probe value of the same kind as `v`, distinct for every slot and between
// the two probe sets. Strings carry case, spaces, quotes and LIKE wildcards,
// so any transformation of a string (trimming, lowering, escaping) shows up.
function probeFor(v: unknown, slot: number, set: 0 | 1): unknown {
  switch (typeof v) {
    case 'string': return ` Fp%_\\'"é${set ? 'Q' : 'Z'}${slot}x `;
    case 'number': {
      const base = Number.isInteger(v) ? 1_000_003 + slot * 4 + set * 2 : 0.5 + slot * 4 + set * 2;
      return v < 0 ? -base : base;
    }
    case 'bigint': { const b = BigInt(1_000_003 + slot * 4 + set * 2); return v < 0n ? -b : b; }
    case 'object':
      if (v instanceof Date) return new Date(978_307_200_000 + slot * 4_000 + set * 2_000 + 7);
      return null; // arrays and objects are rebuilt from their element probes
  }
  return v;
}

// Rebuild `v` with every value replaced by its probe, in the same order the
// signature collected them.
function substitute(v: unknown, probes: unknown[], cur: { i: number }, set: 0 | 1, isVal: boolean): unknown {
  if (isVal) {
    switch (typeof v) {
      case 'string': if (v === '') return v; break;
      case 'number': if (v === 0 || !Number.isSafeInteger(v) && (!Number.isFinite(v) || Number.isInteger(v))) return v; break;
      case 'bigint': if (v === 0n) return v; break;
      case 'object': {
        if (v === null) return v;
        if (v instanceof Date) { if (Number.isNaN(v.getTime())) return v; break; }
        if (Array.isArray(v)) {
          const out: unknown[] = [];
          probes[cur.i++] = out;
          for (const e of v) out.push(substitute(e, probes, cur, set, true));
          return out;
        }
        if (isForgeNullMarker(v)) return v;
        // Two keys in reverse alphabetical order: a serialiser that sorts keys
        // or reads a known field produces something JSON.stringify does not.
        const out: Record<string, unknown> = { '\u0001zprobe': set, '\u0001aprobe': cur.i };
        probes[cur.i++] = out;
        for (const k in v as any) out[k] = substitute((v as any)[k], probes, cur, set, true);
        return out;
      }
      default: return v;
    }
    const p = probeFor(v, cur.i, set);
    probes[cur.i++] = p;
    return p;
  }
  if (v === null || typeof v !== 'object' || v instanceof Date) return v;
  if (Array.isArray(v)) return v.map((e) => substitute(e, probes, cur, set, false));
  const leaf = (v as any).kind === 'leaf';
  const out: Record<string, unknown> = {};
  for (const k in v as any) {
    const x = (v as any)[k];
    if (leaf && k === 'value') out[k] = substitute(x, probes, cur, set, true);
    else if (k === 'cursor' && x && typeof x === 'object' && x.fields) out[k] = { ...x, fields: subMap(x.fields, probes, cur, set) };
    else out[k] = substitute(x, probes, cur, set, false);
  }
  return out;
}

function subMap(m: any, probes: unknown[], cur: { i: number }, set: 0 | 1): unknown {
  if (!m || typeof m !== 'object' || Array.isArray(m)) return m;
  const out: Record<string, unknown> = {};
  for (const k in m) out[k] = substitute(m[k], probes, cur, set, true);
  return out;
}

function probeNode(node: any, set: 0 | 1, n: number): { node: any; probes: unknown[] } {
  const probes = new Array<unknown>(n);
  const cur = { i: 0 };
  const out: Record<string, unknown> = {};
  for (const k in node) {
    const v = node[k];
    if (k === 'rows' && Array.isArray(v)) out[k] = v.map((r) => subMap(r, probes, cur, set));
    else if (DATA_MAPS.has(k)) out[k] = subMap(v, probes, cur, set);
    else out[k] = substitute(v, probes, cur, set, false);
  }
  return { node: out, probes };
}

// ─── learning ───────────────────────────────────────────────────────────────

function xform(x: Xf, v: unknown): unknown {
  return x === Xf.Id ? v : x === Xf.Json ? JSON.stringify(v) : (v as Date).toISOString();
}

function learn<N>(compile: Compile<N>, node: N, model: any, dialect: any, real: SQLArtifact, values: unknown[]): Entry {
  const n = values.length;
  const never: Entry = { s: State.Never, seq: [] };
  if (real.steps) return never;
  let a: SQLArtifact, b: SQLArtifact, pa: { node: any; probes: unknown[] }, pb: { node: any; probes: unknown[] };
  try {
    pa = probeNode(node, 0, n);
    pb = probeNode(node, 1, n);
    a = compile(pa.node, model, dialect);
    b = compile(pb.node, model, dialect);
  } catch { return never; }
  if (a.sql !== real.sql || b.sql !== real.sql) return never;
  const np = real.params.length;
  if (a.params.length !== np || b.params.length !== np) return never;
  // Probe values are unique, so a parameter finds its slot by lookup.
  const byValue = new Map<unknown, number>();
  for (let j = 0; j < n; j++) byValue.set(pa.probes[j], j);
  let byText: Map<string, [number, Xf]> | undefined;
  const textual = (): Map<string, [number, Xf]> => {
    if (byText) return byText;
    byText = new Map();
    for (let j = 0; j < n; j++) {
      const q = pa.probes[j];
      if (q instanceof Date) byText.set(q.toISOString(), [j, Xf.Iso]);
      const js = JSON.stringify(q);
      if (js !== undefined && !byText.has(js)) byText.set(js, [j, Xf.Json]);
    }
    return byText;
  };
  const slots: Slot[] = [];
  for (let i = 0; i < np; i++) {
    const r = real.params[i], x = a.params[i], y = b.params[i];
    if (Object.is(r, x) && Object.is(r, y)) {
      if (r !== null && typeof r === 'object') return never;
      slots.push({ c: true, v: r, i: 0, x: Xf.Id });
      continue;
    }
    const j = byValue.get(x);
    if (j !== undefined && y === pb.probes[j]) { slots.push({ c: false, v: undefined, i: j, x: Xf.Id }); continue; }
    if (typeof x === 'string' && typeof y === 'string') {
      const hit = textual().get(x);
      if (hit && y === xform(hit[1], pb.probes[hit[0]])) { slots.push({ c: false, v: undefined, i: hit[0], x: hit[1] }); continue; }
    }
    return never;
  }
  // The mapping must reproduce the real compile's own parameters.
  const rebuilt = bind(slots, values);
  for (let i = 0; i < np; i++) {
    const r = real.params[i], q = rebuilt[i];
    if (!Object.is(r, q) && !(typeof r === 'string' && r === q)) return never;
  }
  const extra: Record<string, unknown> = {};
  for (const k in real) if (k !== 'sql' && k !== 'params') extra[k] = (real as any)[k];
  return { s: State.Ready, seq: [], sql: real.sql, slots, extra };
}

function bind(slots: Slot[], values: unknown[]): unknown[] {
  const out = new Array<unknown>(slots.length);
  for (let i = 0; i < slots.length; i++) {
    const s = slots[i];
    out[i] = s.c ? s.v : xform(s.x, values[s.i]);
  }
  return out;
}

/**
 * Wrap a dialect's compile function with the per-shape cache. `tag` names the
 * dialect and statement kind; each wrapped function keeps its own entries.
 */
export function shapeCached<N extends { kind: string; model: string }>(
  tag: string,
  compile: Compile<N>,
  worth: (node: N) => boolean = () => true,
): Compile<N> {
  const cache = new Map<number, Entry>();
  caches.push(cache);
  const tagId = sid(tag);
  return (node: N, model?: any, dialect?: any): SQLArtifact => {
    if (!enabled || maxShapes === 0 || !worth(node)) return compile(node, model, dialect);
    let active: object | undefined;
    try { active = getActiveSchema(); } catch { /* no schema: the compile below reports it */ }
    const head = [tagId, model ? idOf(model) : 0, dialect ? idOf(dialect) : 0, active ? idOf(active) : 0];
    try { signature(node, head); } catch (e) { if (e === BYPASS) return compile(node, model, dialect); throw e; }
    const shape = seq, values = vals;
    const h = hashOf(shape);
    const e = cache.get(h);
    if (e !== undefined && sameSeq(e.seq, shape)) {
      if (e.s === State.Ready) {
        cache.delete(h); cache.set(h, e);
        const out: any = { ...e.extra, sql: e.sql, params: bind(e.slots!, values) };
        return out;
      }
      if (e.s === State.Never) return compile(node, model, dialect);
      const real = compile(node, model, dialect);
      const learned = learn(compile, node, model, dialect, real, values);
      learned.seq = shape;
      cache.set(h, learned);
      return real;
    }
    const real = compile(node, model, dialect);
    // A hash shared by two shapes keeps whichever came first.
    if (e === undefined) {
      cache.set(h, { s: State.Seen, seq: shape });
      if (cache.size > maxShapes) cache.delete(cache.keys().next().value as number);
    }
    return real;
  };
}

/**
 * Which statements are worth a lookup. Reading a node's shape costs about as
 * much as compiling a plain SELECT or COUNT, so those compile every time; a
 * SELECT that builds relation subqueries, and every write, is cheaper to look
 * up than to compile (measured with a stub driver, bench/micro/stub-overhead.ts).
 * `inlineIncludes`: the dialect compiles includes into the parent's SQL
 * (Postgres); elsewhere each level is its own statement, so the parent's
 * include tree is only walked, never compiled.
 */
export function worthCaching(node: any, inlineIncludes = false): boolean {
  // A bulk insert is rarely repeated row for row, and its shape is as long as its data.
  if (node.kind === 'insert') return node.rows.length <= 50;
  if (node.kind === 'select') {
    return !!(node.projection?.counts?.length
      || (inlineIncludes && node.hydration?.some((r: { json?: boolean }) => r.json !== false)));
  }
  return node.kind !== 'count' && node.kind !== 'delete';
}

export const worthCachingInline = (node: any): boolean => worthCaching(node, true);

/** Test hook: forget every entry and every identity. */
export function resetCompileCache(): void {
  for (const c of caches) c.clear();
  ids = new WeakMap();
}
export function __lastShape(): number[] { return seq; }
