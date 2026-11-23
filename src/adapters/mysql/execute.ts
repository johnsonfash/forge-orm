import type {
  CountNode,
  DeleteNode,
  GroupByNode,
  InsertNode,
  RelationPlan,
  SelectNode,
  UpdateNode,
} from '../../ir/types';
import type { ModelDef } from '../../schema/types';
import { schema } from '../../schema';
import {
  compileCount,
  compileDelete,
  compileGroupBy,
  compileInsert,
  compileSelect,
  compileUpdate,
} from './compile-from-ir';
import { withMysqlErrors } from './errors';
import { rowDecoder, parseJsonText, type Convert } from '../shared/row-decoder';
import { buildSelect, buildWhereTree } from '../../ir/build';
import { fromDriverBytes } from '../../bytes';
import { hydrateManyRelation, hydrateOneRelation, liftRelationCounts, type WindowedPaging } from '../../ir/hydrate-many';

// MySQL 8 and MariaDB 10.2 number rows per parent with ROW_NUMBER(); 5.7 has
// no window functions and answers with a syntax error. The first such error
// turns the one-query page off for that pool, and its loads go per parent.
const windowedByPool = new WeakMap<object, WindowedPaging>();
function windowedFor(pool: MysqlPool): WindowedPaging {
  let w = windowedByPool.get(pool);
  if (!w) {
    w = { enabled: true, unsupported: isNoWindowFunctions };
    windowedByPool.set(pool, w);
  }
  return w;
}
function isNoWindowFunctions(err: unknown): boolean {
  const e = err as { errno?: number; sqlMessage?: string; message?: string } | null;
  if (!e || (e.errno !== 1064 && e.errno !== 1235)) return false;
  return /\bOVER\b|PARTITION BY|ROW_NUMBER/i.test(e.sqlMessage ?? e.message ?? '');
}

// MySQL has no RETURNING: insert/update/delete mutate, then re-SELECT the
// affected rows (by id, or by insertId range for auto-increment) within the
// same connection to satisfy forge's "return the rows written" contract.

export interface MysqlConn {
  query(sql: string, params?: unknown[]): Promise<[any, any]>;
  execute(sql: string, params?: unknown[]): Promise<[any, any]>;
  release?(): void;
}

export interface MysqlPool extends MysqlConn {
  getConnection(): Promise<MysqlConn>;
  end?(): Promise<void>;
}

export interface MysqlExecOpts {
  conn?: MysqlConn;
  /** MariaDB 10.5+: INSERT and DELETE take RETURNING, so no read-back. */
  returning?: boolean;
}

// mysql2 returns bools as 0/1, dates as Date, JSON pre-parsed; re-hydrate to
// the schema's JS types.
const decodePlans = new WeakMap<object, any>();
const toBool = (v: any) => v === 1 || v === true;
function mysqlConvert(kind: string): Convert | null {
  switch (kind) {
    // better-sqlite3 / mysql2 hand back a Buffer, the wasm build a
    // Uint8Array. Normalise so the row shape is driver-independent.
    case 'bytes': return fromDriverBytes;
    case 'bool': return toBool;
    // mysql2 auto-parses JSON columns; a TEXT-backed string still needs parsing.
    case 'json': case 'embed': case 'embedMany': case 'stringArray': case 'intArray':
      return parseJsonText;
    default: return null;
  }
}

/** Decodes a driver row in place (the driver hands each call fresh objects). */
export function decodeRow(model: ModelDef<any>, row: any): any {
  return rowDecoder(decodePlans, model, mysqlConvert)(row);
}

function decodeRows(model: ModelDef<any>, rows: any[]): any[] {
  const dec = rowDecoder(decodePlans, model, mysqlConvert);
  for (let i = 0; i < rows.length; i++) rows[i] = dec(rows[i]);
  return rows;
}

export async function executeMysqlSelect(
  pool: MysqlPool,
  node: SelectNode,
  model: ModelDef<any>,
  opts: MysqlExecOpts = {},
): Promise<any[]> {
  const exec = opts.conn ?? pool;
  const a = compileSelect(node, model);
  const [rows] = await withMysqlErrors(() => exec.query(a.sql, a.params));
  let out = decodeRows(model, rows as any[]);
  if (node.distinct?.length) out = dedupeBy(out, node.distinct);
  // Fallback geoPoint refinement — bbox prefilter → exact circle + sort.
  const { refineFallbackGeo } = await import('../shared/haversine');
  out = refineFallbackGeo(out, node, model);
  if (node.projection?.counts?.length) liftRelationCounts(out, node.projection.counts);
  if (node.hydration?.length) await hydrate(pool, opts, out, model, node.hydration);
  return out;
}

export async function executeMysqlCount(
  pool: MysqlPool,
  node: CountNode,
  model: ModelDef<any>,
  opts: MysqlExecOpts = {},
): Promise<number> {
  const exec = opts.conn ?? pool;
  const a = compileCount(node, model);
  const [rows] = await withMysqlErrors(() => exec.query(a.sql, a.params));
  return Number((rows as any[])[0]?.count ?? 0);
}

export async function executeMysqlGroupBy(
  pool: MysqlPool,
  node: GroupByNode,
  model: ModelDef<any>,
  opts: MysqlExecOpts = {},
): Promise<any[]> {
  const exec = opts.conn ?? pool;
  const a = compileGroupBy(node, model);
  const [rows] = await withMysqlErrors(() => exec.query(a.sql, a.params));
  return (rows as any[]).map((r) => reshapeGroupByRow(r, node.by));
}

function reshapeGroupByRow(row: any, byCols: string[]): any {
  const out: any = {};
  for (const c of byCols) out[c] = row[c];
  for (const k of Object.keys(row)) {
    const m = k.match(/^__agg_(count|avg|sum|min|max)_(.+)$/);
    if (!m) continue;
    out[`_${m[1]}`] ??= {};
    out[`_${m[1]}`][m[2]] = row[k];
  }
  return out;
}

export async function executeMysqlInsert(
  pool: MysqlPool,
  node: InsertNode,
  model: ModelDef<any>,
  opts: MysqlExecOpts = {},
): Promise<{ docs: any[]; count: number }> {
  const exec = opts.conn ?? pool;
  const a = compileInsert(node, model);
  if (opts.returning && !node.countOnly && !node.skipDuplicates) {
    const [rows] = await withMysqlErrors(() => exec.query(`${a.sql} RETURNING *`, a.params));
    return { docs: (rows as any[]).map((r) => decodeRow(model, r)), count: (rows as any[]).length };
  }
  const [result]: any = await withMysqlErrors(() => exec.execute(a.sql, a.params));
  if (node.countOnly) return { docs: [], count: result.affectedRows };
  // Every column's value is already known (written by us, or a literal
  // default, or the insert id): hand the rows back without reading them.
  const known = knownInsertedRows(model, node, result);
  if (known) return { docs: known, count: result.affectedRows };
  const ids = node.rows.map((r) => r.id).filter((id) => id != null);
  if (ids.length === 0) {
    // No ids supplied — recover the auto-incremented range via insertId / affectedRows.
    if (result.insertId != null && result.affectedRows > 0) {
      const placeholders = Array.from({ length: result.affectedRows }, () => '?').join(',');
      const ranged = Array.from({ length: result.affectedRows }, (_, i) => result.insertId + i);
      const [docs] = await withMysqlErrors(() => exec.query(
        `SELECT * FROM \`${model.collection}\` WHERE \`id\` IN (${placeholders})`,
        ranged,
      ));
      return { docs: (docs as any[]).map((r) => decodeRow(model, r)), count: result.affectedRows };
    }
    return { docs: [], count: result.affectedRows };
  }
  const placeholders = ids.map(() => '?').join(',');
  const [docs] = await withMysqlErrors(() => exec.query(
    `SELECT * FROM \`${model.collection}\` WHERE \`id\` IN (${placeholders})`, ids,
  ));
  return { docs: (docs as any[]).map((r) => decodeRow(model, r)), count: result.affectedRows };
}

export async function executeMysqlUpdate(
  pool: MysqlPool,
  node: UpdateNode,
  model: ModelDef<any>,
  opts: MysqlExecOpts = {},
): Promise<{ doc?: any; count: number }> {
  const exec = opts.conn ?? pool;
  const a = compileUpdate(node, model);
  const [result]: any = await withMysqlErrors(() => exec.execute(a.sql, a.params));
  if (node.many) return { count: result.affectedRows };
  // Guarded update (e.g. `col()` precondition, or any non-eq predicate): when
  // nothing changed, the row didn't match the guard → surface not-found (P2025).
  // For plain eq-by-id updates we tolerate affectedRows=0 (MySQL counts CHANGED
  // rows, so a no-op update isn't a miss) and re-SELECT to return the row.
  if (whereHasNonEq(node.where) && result.affectedRows === 0) return { doc: undefined, count: 0 };
  const selectArtifact = compileSelect(
    buildSelect(node.model, model, { where: irWhereToObject(node.where), take: 1 }, 'one'),
    model,
  );
  const [rows] = await withMysqlErrors(() => exec.query(selectArtifact.sql, selectArtifact.params));
  const doc = (rows as any[])[0];
  return { doc: doc ? decodeRow(model, doc) : undefined, count: result.affectedRows };
}

export async function executeMysqlDelete(
  pool: MysqlPool,
  node: DeleteNode,
  model: ModelDef<any>,
  opts: MysqlExecOpts = {},
): Promise<{ doc?: any; count: number }> {
  const exec = opts.conn ?? pool;
  if (node.many) {
    const a = compileDelete(node, model);
    const [result]: any = await withMysqlErrors(() => exec.execute(a.sql, a.params));
    return { count: result.affectedRows };
  }
  if (opts.returning) {
    const a = compileDelete(node, model);
    const [rows] = await withMysqlErrors(() => exec.query(`${a.sql} RETURNING *`, a.params));
    const doc = (rows as any[])[0];
    return doc ? { doc: decodeRow(model, doc), count: 1 } : { doc: undefined, count: 0 };
  }
  // Single-row delete: SELECT first to capture the row, then DELETE.
  const selectArtifact = compileSelect(
    buildSelect(node.model, model, { where: irWhereToObject(node.where), take: 1 }, 'one'),
    model,
  );
  const [rows] = await withMysqlErrors(() => exec.query(selectArtifact.sql, selectArtifact.params));
  const doc = (rows as any[])[0];
  if (!doc) return { doc: undefined, count: 0 };
  const a = compileDelete(node, model);
  const [result]: any = await withMysqlErrors(() => exec.execute(a.sql, a.params));
  // Guarded delete that matched no row → not-found, even though the identity
  // SELECT found the (unguarded) row.
  if (whereHasNonEq(node.where) && result.affectedRows === 0) return { doc: undefined, count: 0 };
  return { doc: decodeRow(model, doc), count: result.affectedRows };
}

type ColPlan = { name: string; kind: string; absent: 'null' | 'unknown' | { value: unknown }; autoInc: boolean };
const insertPlans = new WeakMap<object, ColPlan[] | null>();

// How each column of an inserted row can be known without reading it back.
// Null when some column can never be (a generated column, a geometry, a
// DECIMAL the driver hands back as text): those models always read back.
function insertPlan(model: ModelDef<any>): ColPlan[] | null {
  if (insertPlans.has(model)) return insertPlans.get(model)!;
  let plan: ColPlan[] | null = [];
  for (const [name, fd] of Object.entries(model.fields)) {
    const f = fd as any;
    if (f.dbGenerated || ['decimal', 'geoPoint', 'vector'].includes(f.kind)) { plan = null; break; }
    let absent: ColPlan['absent'] = 'unknown';
    if (f.default) {
      if (f.default.kind === 'literal') absent = { value: f.default.value };
    } else if (!(f.kind === 'uuid' && f.uuidDefault) && !(f.kind === 'embedMany' && !f.optional) && f.optional) {
      absent = 'null';
    }
    plan.push({ name, kind: f.kind, absent, autoInc: f.kind === 'id' && f.idType === 'bigserial' });
  }
  insertPlans.set(model, plan);
  return plan;
}

// A value whose stored form reads back as exactly itself.
function roundTrips(kind: string, v: unknown): boolean {
  switch (kind) {
    case 'id': case 'objectId': case 'string': case 'text': case 'enum': case 'uuid':
      return typeof v === 'string';
    case 'int': return typeof v === 'number' && Number.isSafeInteger(v);
    case 'float': return typeof v === 'number' && Number.isFinite(v);
    case 'bigint': return typeof v === 'bigint' || (typeof v === 'number' && Number.isSafeInteger(v));
    case 'bool': return v === 0 || v === 1;
    case 'dateTime': return v instanceof Date && !Number.isNaN(v.getTime());
    case 'json': case 'embed': case 'embedMany': case 'stringArray': case 'intArray':
      return typeof v === 'string';
    case 'bytes': return v instanceof Uint8Array;
    default: return false;
  }
}

function knownInsertedRows(model: ModelDef<any>, node: InsertNode, result: any): any[] | null {
  if (node.skipDuplicates || result.affectedRows !== node.rows.length) return null;
  const plan = insertPlan(model);
  if (!plan) return null;
  // A column some rows name and this one does not is sent as NULL (the
  // INSERT's column list is the union), not left to its default.
  const named = new Set<string>();
  for (const r of node.rows) for (const k of Object.keys(r)) named.add(k);
  const out: any[] = [];
  for (const row of node.rows) {
    const doc: any = {};
    for (const c of plan) {
      const v = named.has(c.name) ? (row[c.name] ?? null) : undefined;
      if (v !== undefined && v !== null) {
        if (!roundTrips(c.kind, v)) return null;
        doc[c.name] = v;
      } else if (v === null && c.absent !== 'unknown') {
        doc[c.name] = null;
      } else if (c.autoInc) {
        // insertId is exact for one row; a multi-row range depends on the
        // server's auto_increment_increment, so that case reads back.
        if (node.rows.length !== 1 || result.insertId == null) return null;
        doc[c.name] = Number(result.insertId);
      } else if (c.absent === 'null') {
        doc[c.name] = null;
      } else if (c.absent !== 'unknown') {
        doc[c.name] = c.absent.value;
      } else {
        return null;
      }
    }
    out.push(decodeRow(model, doc));
  }
  return out;
}

// Extract the stable EQ-identity predicates from an IR WhereTree to rebuild the
// follow-up SELECT (MySQL has no RETURNING). Guard/precondition predicates
// (non-eq, `col()` field comparisons, OR/NOT/relation) are DROPPED — they
// identify nothing after the write, and emitting them would reference IR
// internals as columns. The eq leaves (id / unique field) locate the row.
function irWhereToObject(tree: any): any {
  if (!tree) return undefined;
  if (tree.kind === 'leaf') {
    return tree.op === 'eq' && tree.rhsField === undefined ? { [tree.field]: tree.value } : {};
  }
  if (tree.kind === 'and') {
    const out: any = {};
    for (const c of tree.children) Object.assign(out, irWhereToObject(c) ?? {});
    return out;
  }
  return {};
}

// Whether the where carries any predicate beyond plain eq-by-value (a guard):
// a non-eq op, a `col()` field comparison, or an OR/NOT/relation node. Used to
// decide whether affectedRows=0 means "guard failed" (→ not-found).
function whereHasNonEq(tree: any): boolean {
  if (!tree) return false;
  if (tree.kind === 'leaf') return tree.op !== 'eq' || tree.rhsField !== undefined;
  if (tree.kind === 'and' || tree.kind === 'or') return (tree.children as any[]).some(whereHasNonEq);
  if (tree.kind === 'not') return whereHasNonEq(tree.child);
  return true;
}

async function hydrate(
  pool: MysqlPool,
  opts: MysqlExecOpts,
  rows: any[],
  parentModel: ModelDef<any>,
  hydration: RelationPlan[],
): Promise<void> {
  if (rows.length === 0) return;
  for (const rel of hydration) {
    const targetModel = (schema as any)[rel.target] as ModelDef<any> | undefined;
    if (!targetModel) continue;
    const isOwningOne = rel.kind === 'one' && parentModel.fields[rel.on] != null;
    if (isOwningOne) await hydrateOne(pool, opts, rows, rel, targetModel, true);
    else if (rel.kind === 'one') await hydrateOne(pool, opts, rows, rel, targetModel, false);
    else await hydrateMany(pool, opts, rows, rel, targetModel);
  }
}

async function hydrateOne(
  pool: MysqlPool, opts: MysqlExecOpts,
  rows: any[], rel: RelationPlan, targetModel: ModelDef<any>, owning: boolean,
): Promise<void> {
  await hydrateOneRelation({
    rows, rel,
    parentField: owning ? rel.on : rel.refs,
    targetField: owning ? rel.refs : rel.on,
    keyOf: (v) => String(v),
    runSelect: (node) => executeMysqlSelect(pool, node, targetModel, opts),
  });
}

async function hydrateMany(
  pool: MysqlPool, opts: MysqlExecOpts,
  rows: any[], rel: RelationPlan, targetModel: ModelDef<any>,
): Promise<void> {
  await hydrateManyRelation({
    rows, rel, keyOf: (v) => String(v),
    runSelect: (node) => executeMysqlSelect(pool, node, targetModel, opts),
    windowed: windowedFor(pool),
  });
}

function dedupeBy(rows: any[], fields: string[]): any[] {
  const seen = new Set<string>();
  const out: any[] = [];
  for (const r of rows) {
    const k = fields.map((f) => JSON.stringify(r[f] ?? null)).join('\x1e');
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(r);
  }
  return out;
}
