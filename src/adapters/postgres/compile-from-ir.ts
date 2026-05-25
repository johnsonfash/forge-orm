import type {
  CountNode,
  DeleteNode,
  GroupByNode,
  InsertNode,
  OrderByEntry,
  ProjectionPlan,
  SelectNode,
  UpdateNode,
  WhereTree,
} from '../../ir/types';
import type { SQLArtifact } from '../../compile';
import type { ModelDef } from '../../schema/types';
import { schema } from '../../schema';
import { PostgresDialect, type Dialect } from './dialect';

// Postgres IR consumer — takes adapter-agnostic IR nodes and emits a
// parameterised SQL string + params array, ready to hand to `pg`'s
// `pool.query(sql, params)` or any compatible driver.
//
// Hard rules:
//   • Never interpolate values into the SQL string — always via params.
//   • Quote every identifier so case + reserved words don't bite.
//   • Reject regex metacharacter injection: escape on the value, not the SQL.
//
// Schema mapping (Wave 2a):
//   • model.collection → table name
//   • field name → column name (1:1 for SQL; no id↔_id remap)
//   • Wave 2d: `@map('col_name')` for divergent column names

const REGEX_ESCAPE = /[.*+?^${}()|[\]\\]/g;
const escapeForLike = (s: string) => String(s).replace(/[%_\\]/g, (m) => '\\' + m);

function modelDef(modelKey: string, override?: ModelDef<any>): ModelDef<any> {
  if (override) return override;
  const m = (schema as any)[modelKey] as ModelDef<any> | undefined;
  if (!m) throw new Error(`[forge:postgres] unknown model '${modelKey}' in IR`);
  return m;
}

interface CompileCtx {
  d: Dialect;
  table: string;          // quoted identifier of the current row source
  model: ModelDef<any>;   // for resolving relation metadata + FK columns
  params: unknown[];
  // Alias counter so nested EXISTS subqueries get unique table aliases.
  aliasCount: { n: number };
  // Optional schema override — lets tests with ad-hoc models drive relation
  // EXISTS without registering models into the project schema map.
  schemaOverride?: Record<string, ModelDef<any>>;
}

// ─── Where ──────────────────────────────────────────────────────────────────

function compileWhere(ctx: CompileCtx, tree: WhereTree | undefined): string {
  if (!tree) return '';
  return compileWhereNode(ctx, tree);
}

function compileWhereNode(ctx: CompileCtx, tree: WhereTree): string {
  switch (tree.kind) {
    case 'and': {
      const parts = tree.children.map((c) => compileWhereNode(ctx, c)).filter(notEmpty);
      if (parts.length === 0) return '';
      if (parts.length === 1) return parts[0];
      return `(${parts.join(' AND ')})`;
    }
    case 'or': {
      const parts = tree.children.map((c) => compileWhereNode(ctx, c)).filter(notEmpty);
      if (parts.length === 0) return '';
      if (parts.length === 1) return parts[0];
      return `(${parts.join(' OR ')})`;
    }
    case 'not': {
      const inner = compileWhereNode(ctx, tree.child);
      return inner ? `NOT (${inner})` : '';
    }
    case 'relation':
      // Wave 2a: emit an EXISTS subquery against the target table by FK.
      // This is the SQL-natural form for `some/every/none` and `is/isNot`.
      return compileRelationFilter(ctx, tree);
    case 'leaf':
      return compileLeaf(ctx, tree);
  }
}

function compileLeaf(ctx: CompileCtx, leaf: Extract<WhereTree, { kind: 'leaf' }>): string {
  const col = `${ctx.table}.${ctx.d.quoteIdent(leaf.field)}`;
  const ph = (v: unknown) => ctx.d.placeholder(ctx.params, v);
  switch (leaf.op) {
    case 'eq':       return leaf.value === null ? `${col} IS NULL`      : `${col} = ${ph(leaf.value)}`;
    case 'ne':       return leaf.value === null ? `${col} IS NOT NULL`  : `${col} <> ${ph(leaf.value)}`;
    case 'in': {
      const arr = leaf.value as unknown[];
      if (!arr.length) return 'FALSE';
      return `${col} IN (${arr.map(ph).join(', ')})`;
    }
    case 'nin': {
      const arr = leaf.value as unknown[];
      if (!arr.length) return 'TRUE';
      return `${col} NOT IN (${arr.map(ph).join(', ')})`;
    }
    case 'lt':  return `${col} < ${ph(leaf.value)}`;
    case 'lte': return `${col} <= ${ph(leaf.value)}`;
    case 'gt':  return `${col} > ${ph(leaf.value)}`;
    case 'gte': return `${col} >= ${ph(leaf.value)}`;
    case 'contains':
      return likeOp(ctx, col, `%${escapeForLike(String(leaf.value))}%`, !!leaf.caseInsensitive);
    case 'startsWith':
      return likeOp(ctx, col, `${escapeForLike(String(leaf.value))}%`, !!leaf.caseInsensitive);
    case 'endsWith':
      return likeOp(ctx, col, `%${escapeForLike(String(leaf.value))}`, !!leaf.caseInsensitive);
    case 'has':
      // text[] / integer[] containment: `column @> ARRAY[value]::col_type`.
      // We don't know the column type at compile time (would need schema); use
      // `?` (text[] only) when string, `@>` with array literal otherwise.
      return `${ph(leaf.value)} = ANY(${col})`;
    case 'hasSome': {
      // ARRAY column overlap with values.
      const arr = leaf.value as unknown[];
      if (!arr.length) return 'FALSE';
      return `${col} && ARRAY[${arr.map(ph).join(', ')}]`;
    }
    case 'hasEvery': {
      const arr = leaf.value as unknown[];
      if (!arr.length) return 'TRUE';
      return `${col} @> ARRAY[${arr.map(ph).join(', ')}]`;
    }
    case 'isEmpty':
      return leaf.value ? `coalesce(array_length(${col}, 1), 0) = 0`
                        : `coalesce(array_length(${col}, 1), 0) > 0`;
    case 'search':
      return ctx.d.searchClause(col, ph(String(leaf.value)), {
        rawColumn: leaf.field,
        baseTable: ctx.model.collection,
        quoteIdent: (s: string) => ctx.d.quoteIdent(s),
      });
    case 'jsonPath':
      // Still Wave 5 territory — placeholder so compiler doesn't error.
      return 'TRUE';
  }
}

function likeOp(ctx: CompileCtx, col: string, pattern: string, ci: boolean): string {
  const ph = ctx.d.placeholder(ctx.params, pattern);
  return ci ? `${col} ILIKE ${ph}` : `${col} LIKE ${ph}`;
}

function compileRelationFilter(
  ctx: CompileCtx,
  tree: Extract<WhereTree, { kind: 'relation' }>,
): string {
  // Resolve the relation def on the parent model.
  const relations = ctx.model.relations();
  const rel = relations[tree.relation];
  if (!rel) return 'TRUE';
  const targetModel =
    ctx.schemaOverride?.[rel.target] ??
    ((schema as any)[rel.target] as ModelDef<any> | undefined);
  if (!targetModel) return 'TRUE';

  // Unique alias for this subquery — `t1`, `t2`, ... — so nested EXISTS
  // don't shadow each other.
  ctx.aliasCount.n += 1;
  const alias = `t${ctx.aliasCount.n}`;
  const aliasQ = ctx.d.quoteIdent(alias);
  const subTable = ctx.d.quoteIdent(targetModel.collection);

  // Owning side: parent.<rel.on> = target.<rel.refs>
  // Inverse side: target.<rel.on>  = parent.<rel.refs>
  const isOwning = ctx.model.fields[rel.on] != null;
  const parentCol = isOwning ? rel.on  : rel.refs;
  const targetCol = isOwning ? rel.refs : rel.on;
  const joinCondition =
    `${aliasQ}.${ctx.d.quoteIdent(targetCol)} = ${ctx.table}.${ctx.d.quoteIdent(parentCol)}`;

  // Recurse to compile the nested where against the target model's columns.
  const inner = tree.nested
    ? compileWhereNode(
        {
          d: ctx.d, model: targetModel, table: aliasQ, params: ctx.params,
          aliasCount: ctx.aliasCount, schemaOverride: ctx.schemaOverride,
        },
        tree.nested,
      )
    : '';
  const innerClause = inner ? ` AND ${inner}` : '';

  const baseExists = `EXISTS (SELECT 1 FROM ${subTable} ${aliasQ} WHERE ${joinCondition}${innerClause})`;

  switch (tree.mode) {
    case 'is':
    case 'some':
      return baseExists;
    case 'isNot':
    case 'none':
      return `NOT ${baseExists}`;
    case 'every': {
      // "every related row matches" = no related row violates the condition.
      // i.e. NOT EXISTS (rows where the inner condition is FALSE).
      if (!inner) return baseExists;
      const notInner = `NOT (${inner})`;
      return `NOT EXISTS (SELECT 1 FROM ${subTable} ${aliasQ} WHERE ${joinCondition} AND ${notInner})`;
    }
  }
}

function notEmpty(s: string): boolean {
  return s.length > 0;
}

// ─── Projection ─────────────────────────────────────────────────────────────

function compileProjectionCols(
  d: Dialect,
  table: string,
  model: ModelDef<any>,
  plan: ProjectionPlan | undefined,
): string {
  if (!plan) {
    // All scalar fields on the table. Stable-ordered by schema declaration.
    const cols = Object.keys(model.fields).map((f) => `${table}.${d.quoteIdent(f)}`);
    return cols.join(', ');
  }
  if (plan.exclusive && plan.fields.length) {
    return plan.fields.map((f) => `${table}.${d.quoteIdent(f)}`).join(', ');
  }
  if (plan.omit?.length) {
    const drop = new Set(plan.omit);
    const cols = Object.keys(model.fields)
      .filter((f) => !drop.has(f))
      .map((f) => `${table}.${d.quoteIdent(f)}`);
    return cols.join(', ');
  }
  return Object.keys(model.fields).map((f) => `${table}.${d.quoteIdent(f)}`).join(', ');
}

// ─── Order ──────────────────────────────────────────────────────────────────

function compileOrder(d: Dialect, table: string, orderBy: OrderByEntry[] | undefined): string {
  if (!orderBy?.length) return '';
  const parts = orderBy.map((e) =>
    d.orderClause(`${table}.${d.quoteIdent(e.field)}`, e.direction, e.nulls),
  );
  return `ORDER BY ${parts.join(', ')}`;
}

// ─── Cursor ─────────────────────────────────────────────────────────────────

function compileCursor(
  d: Dialect,
  table: string,
  params: unknown[],
  cursor: SelectNode['cursor'],
): string {
  if (!cursor?.fields) return '';
  const keys = Object.keys(cursor.fields);
  if (keys.length === 0) return '';
  if (keys.length === 1) {
    const k = keys[0];
    return `${table}.${d.quoteIdent(k)} > ${d.placeholder(params, cursor.fields[k])}`;
  }
  // Composite cursor: tuple comparison. PG supports (a, b) > (?, ?).
  const cols = keys.map((k) => `${table}.${d.quoteIdent(k)}`).join(', ');
  const vals = keys.map((k) => d.placeholder(params, cursor.fields[k])).join(', ');
  return `(${cols}) > (${vals})`;
}

// ─── Top-level compilers ────────────────────────────────────────────────────

export function compileSelect(
  node: SelectNode,
  modelOverride?: ModelDef<any>,
  dialect: Dialect = PostgresDialect,
  schemaOverride?: Record<string, ModelDef<any>>,
): SQLArtifact {
  const m = modelDef(node.model, modelOverride);
  const params: unknown[] = [];
  const table = dialect.quoteIdent(m.collection);
  const ctx: CompileCtx = { d: dialect, model: m, table, params, aliasCount: { n: 0 }, schemaOverride };

  const cols = compileProjectionCols(dialect, table, m, node.projection);
  const distinctClause = node.distinct?.length
    ? `DISTINCT ON (${node.distinct.map((f) => `${table}.${dialect.quoteIdent(f)}`).join(', ')}) `
    : '';

  const whereParts: string[] = [];
  const w = compileWhere(ctx, node.where);
  if (w) whereParts.push(w);
  const c = compileCursor(dialect, table, params, node.cursor);
  if (c) whereParts.push(c);
  const whereClause = whereParts.length ? `WHERE ${whereParts.join(' AND ')}` : '';

  const orderClause = compileOrder(dialect, table, node.orderBy);
  const limit = node.limit != null ? `LIMIT ${Number(node.limit)}` : '';
  const offset = node.offset != null ? `OFFSET ${Number(node.offset)}` : '';

  const sql = [
    `SELECT ${distinctClause}${cols} FROM ${table}`,
    whereClause, orderClause, limit, offset,
  ].filter(Boolean).join(' ');

  return { kind: 'sql', dialect: dialect.name, sql, params };
}

export function compileCount(
  node: CountNode,
  modelOverride?: ModelDef<any>,
  dialect: Dialect = PostgresDialect,
  schemaOverride?: Record<string, ModelDef<any>>,
): SQLArtifact {
  const m = modelDef(node.model, modelOverride);
  const params: unknown[] = [];
  const table = dialect.quoteIdent(m.collection);
  const ctx: CompileCtx = { d: dialect, model: m, table, params, aliasCount: { n: 0 }, schemaOverride };
  const where = compileWhere(ctx, node.where);
  const distinctClause = node.distinct?.length
    ? `COUNT(DISTINCT (${node.distinct.map((f) => `${table}.${dialect.quoteIdent(f)}`).join(', ')}))`
    : 'COUNT(*)';
  const sql = [
    `SELECT ${distinctClause} AS count FROM ${table}`,
    where ? `WHERE ${where}` : '',
  ].filter(Boolean).join(' ');
  return { kind: 'sql', dialect: dialect.name, sql, params };
}

export function compileInsert(
  node: InsertNode,
  modelOverride?: ModelDef<any>,
  dialect: Dialect = PostgresDialect,
  schemaOverride?: Record<string, ModelDef<any>>,
): SQLArtifact {
  const m = modelDef(node.model, modelOverride);
  const params: unknown[] = [];
  const table = dialect.quoteIdent(m.collection);
  if (node.rows.length === 0) {
    return { kind: 'sql', dialect: dialect.name, sql: `SELECT 0 WHERE FALSE`, params };
  }
  // Stable column list: union of all keys across rows, schema-ordered.
  const allKeys = new Set<string>();
  for (const r of node.rows) for (const k of Object.keys(r)) allKeys.add(k);
  const cols = Object.keys(m.fields).filter((f) => allKeys.has(f));
  // Append any keys that aren't in schema (defensive — IR rows are post-coerce).
  for (const k of allKeys) if (!cols.includes(k)) cols.push(k);

  const colList = cols.map((c) => dialect.quoteIdent(c)).join(', ');
  const valueRows = node.rows.map((row) => {
    const vals = cols.map((c) => dialect.placeholder(params, row[c] ?? null));
    return `(${vals.join(', ')})`;
  }).join(', ');

  const onConflict = node.skipDuplicates ? ' ON CONFLICT DO NOTHING' : '';
  const returning = node.returning?.exclusive && node.returning.fields.length
    ? ` RETURNING ${node.returning.fields.map((f) => dialect.quoteIdent(f)).join(', ')}`
    : ' RETURNING *';

  const sql = `INSERT INTO ${table} (${colList}) VALUES ${valueRows}${onConflict}${returning}`;
  return { kind: 'sql', dialect: dialect.name, sql, params };
}

export function compileUpdate(
  node: UpdateNode,
  modelOverride?: ModelDef<any>,
  dialect: Dialect = PostgresDialect,
  schemaOverride?: Record<string, ModelDef<any>>,
): SQLArtifact {
  const m = modelDef(node.model, modelOverride);
  const params: unknown[] = [];
  const table = dialect.quoteIdent(m.collection);
  const ctx: CompileCtx = { d: dialect, model: m, table, params, aliasCount: { n: 0 }, schemaOverride };

  // Build set clauses lazily so that for upsert we can push VALUES params
  // first (more intuitive $1, $2, $3 ordering in the emitted SQL).
  const buildSet = (): string[] => {
    const parts: string[] = [];
    if (node.set) {
      for (const [k, v] of Object.entries(node.set)) {
        parts.push(`${dialect.quoteIdent(k)} = ${dialect.placeholder(params, v)}`);
      }
    }
    if (node.increment) {
      for (const [k, v] of Object.entries(node.increment)) {
        // `SET col = col + $n` — atomic at PG's row-lock level.
        parts.push(`${dialect.quoteIdent(k)} = ${table}.${dialect.quoteIdent(k)} + ${dialect.placeholder(params, v)}`);
      }
    }
    if (node.multiply) {
      for (const [k, v] of Object.entries(node.multiply)) {
        parts.push(`${dialect.quoteIdent(k)} = ${table}.${dialect.quoteIdent(k)} * ${dialect.placeholder(params, v)}`);
      }
    }
    if (node.push) {
      for (const [k, v] of Object.entries(node.push)) {
        // For text[]/integer[]: append. PG: array_append(col, val).
        parts.push(`${dialect.quoteIdent(k)} = array_append(${table}.${dialect.quoteIdent(k)}, ${dialect.placeholder(params, v)})`);
      }
    }
    if (node.unset?.length) {
      for (const k of node.unset) {
        parts.push(`${dialect.quoteIdent(k)} = NULL`);
      }
    }
    return parts;
  };

  // Upsert: emit INSERT … ON CONFLICT (...) DO UPDATE SET …
  // VALUES params are pushed first so reading the SQL top-down also reads
  // the params in $1, $2, $3 order.
  if (node.upsertCreate) {
    const cols = Object.keys(node.upsertCreate);
    const colList = cols.map((c) => dialect.quoteIdent(c)).join(', ');
    const valList = cols.map((c) => dialect.placeholder(params, node.upsertCreate![c])).join(', ');
    const setParts = buildSet();
    const conflictCols = whereLeafColumns(node.where).map((c) => dialect.quoteIdent(c));
    const conflictClause = conflictCols.length
      ? dialect.upsertConflictClause(conflictCols, setParts.join(', '))
      : 'ON CONFLICT DO NOTHING';
    const sql = `INSERT INTO ${table} (${colList}) VALUES (${valList}) ${conflictClause} RETURNING *`;
    return { kind: 'sql', dialect: dialect.name, sql, params };
  }

  const setParts = buildSet();

  const where = compileWhere(ctx, node.where);
  const whereClause = where ? `WHERE ${where}` : '';
  const limitClause = node.many ? '' : 'WHERE ctid = (SELECT ctid FROM ' + table + (where ? ' WHERE ' + where : '') + ' LIMIT 1)';
  // For updateOne (many=false), we constrain to a single row via ctid — PG's
  // standard idiom since UPDATE … LIMIT isn't valid SQL on its own.
  const finalWhere = node.many ? whereClause : limitClause;
  const returning = node.returning?.exclusive && node.returning.fields.length
    ? ` RETURNING ${node.returning.fields.map((f) => dialect.quoteIdent(f)).join(', ')}`
    : ' RETURNING *';

  const sql = `UPDATE ${table} SET ${setParts.join(', ')} ${finalWhere}${returning}`;
  return { kind: 'sql', dialect: dialect.name, sql, params };
}

export function compileDelete(
  node: DeleteNode,
  modelOverride?: ModelDef<any>,
  dialect: Dialect = PostgresDialect,
  schemaOverride?: Record<string, ModelDef<any>>,
): SQLArtifact {
  const m = modelDef(node.model, modelOverride);
  const params: unknown[] = [];
  const table = dialect.quoteIdent(m.collection);
  const ctx: CompileCtx = { d: dialect, model: m, table, params, aliasCount: { n: 0 }, schemaOverride };
  const where = compileWhere(ctx, node.where);
  const whereClause = where ? `WHERE ${where}` : '';
  const limitClause = node.many
    ? whereClause
    : `WHERE ctid = (SELECT ctid FROM ${table}${where ? ' WHERE ' + where : ''} LIMIT 1)`;
  const finalWhere = node.many ? whereClause : limitClause;
  const sql = `DELETE FROM ${table} ${finalWhere} RETURNING *`;
  return { kind: 'sql', dialect: dialect.name, sql, params };
}

// Helper: collect column names from a where tree's eq leaves (used to guess
// the upsert ON CONFLICT target).
function whereLeafColumns(tree: WhereTree | undefined): string[] {
  if (!tree) return [];
  if (tree.kind === 'leaf' && tree.op === 'eq') return [tree.field];
  if (tree.kind === 'and') return tree.children.flatMap(whereLeafColumns);
  return [];
}

// ─── GroupBy ────────────────────────────────────────────────────────────────
//
// Emits `SELECT <by-cols>, <aggs> FROM <table> WHERE … GROUP BY <by-cols>
// HAVING … ORDER BY … LIMIT/OFFSET`. Aggregation SELECT-list entries are
// aliased with a wire-stable name (`__agg_count_all`, `__agg_avg_age`, …) so
// the executor can reshape rows back into Prisma's nested `{ _count, _avg, … }`
// payload on the way out.

export function compileGroupBy(
  node: GroupByNode,
  modelOverride?: ModelDef<any>,
  dialect: Dialect = PostgresDialect,
  schemaOverride?: Record<string, ModelDef<any>>,
): SQLArtifact {
  const m = modelDef(node.model, modelOverride);
  const params: unknown[] = [];
  const table = dialect.quoteIdent(m.collection);
  const ctx: CompileCtx = { d: dialect, model: m, table, params, aliasCount: { n: 0 }, schemaOverride };

  const byCols = node.by.map((f) => `${table}.${dialect.quoteIdent(f)}`);

  const aggSelect: string[] = [];
  const pushAgg = (bucket: '_count' | '_avg' | '_sum' | '_min' | '_max', field: string, fn: string) => {
    const colExpr = field === '_all'
      ? '*'
      : `${table}.${dialect.quoteIdent(field)}`;
    const alias = `__agg_${bucket.slice(1)}_${field}`;
    aggSelect.push(`${fn}(${colExpr}) AS ${dialect.quoteIdent(alias)}`);
  };
  if (node._count) for (const [k, v] of Object.entries(node._count)) if (v) pushAgg('_count', k, 'COUNT');
  if (node._avg)   for (const [k, v] of Object.entries(node._avg))   if (v) pushAgg('_avg',   k, 'AVG');
  if (node._sum)   for (const [k, v] of Object.entries(node._sum))   if (v) pushAgg('_sum',   k, 'SUM');
  if (node._min)   for (const [k, v] of Object.entries(node._min))   if (v) pushAgg('_min',   k, 'MIN');
  if (node._max)   for (const [k, v] of Object.entries(node._max))   if (v) pushAgg('_max',   k, 'MAX');

  const selectList = [...byCols, ...aggSelect].join(', ');
  const where = compileWhere(ctx, node.where);
  const groupByClause = node.by.length ? `GROUP BY ${byCols.join(', ')}` : '';

  // having: Prisma's nested aggregation filter. We compile a small subset —
  // `{ _count: { id: { gt: 5 } } }` — to `HAVING COUNT(id) > $n`. Unsupported
  // shapes are silently ignored (returning `''`).
  const havingParts: string[] = [];
  if (node.having && typeof node.having === 'object') {
    for (const [bucket, inner] of Object.entries(node.having)) {
      const fnName = (({ _count: 'COUNT', _avg: 'AVG', _sum: 'SUM', _min: 'MIN', _max: 'MAX' }) as Record<string, string>)[bucket];
      if (!fnName || !inner || typeof inner !== 'object') continue;
      for (const [field, opObj] of Object.entries(inner as any)) {
        if (!opObj || typeof opObj !== 'object') continue;
        const colExpr = field === '_all' ? '*' : `${table}.${dialect.quoteIdent(field)}`;
        for (const [op, val] of Object.entries(opObj as Record<string, any>)) {
          const cmp = (({ gt: '>', gte: '>=', lt: '<', lte: '<=', equals: '=', not: '<>' }) as Record<string, string>)[op];
          if (!cmp) continue;
          havingParts.push(`${fnName}(${colExpr}) ${cmp} ${dialect.placeholder(params, val)}`);
        }
      }
    }
  }
  const havingClause = havingParts.length ? `HAVING ${havingParts.join(' AND ')}` : '';

  const orderClause = (() => {
    if (!node.orderBy?.length) return '';
    // Order by either a by-column or an aggregation alias — Prisma orders on
    // grouped fields by default, so we just emit `field DIR` and let PG
    // resolve it against the GROUP BY columns.
    return `ORDER BY ${node.orderBy.map((e) =>
      dialect.orderClause(`${table}.${dialect.quoteIdent(e.field)}`, e.direction, e.nulls),
    ).join(', ')}`;
  })();
  const limit = node.limit != null ? `LIMIT ${Number(node.limit)}` : '';
  const offset = node.offset != null ? `OFFSET ${Number(node.offset)}` : '';

  const sql = [
    `SELECT ${selectList} FROM ${table}`,
    where ? `WHERE ${where}` : '',
    groupByClause,
    havingClause,
    orderClause,
    limit,
    offset,
  ].filter(Boolean).join(' ');

  return { kind: 'sql', dialect: dialect.name, sql, params };
}
