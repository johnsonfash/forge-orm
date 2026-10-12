import type { FieldDef, IndexDef, ModelDef, RelationDef } from '../../schema/types';
import type { SchemaMap } from '../../schema';
import { PostgresDialect, type Dialect } from './dialect';
import { mongoToSqlWhere } from '../shared/mongo-to-sql-where';

// DDL generator — turns a Forge schema into the SQL statements that build the
// physical Postgres tables, constraints, and indexes.
//
// Design rules:
//   • Constraint + index names are deterministic and prefixed (`<table>_*`) so
//     diff-based migrations can find and reconcile them.
//   • `IF NOT EXISTS` on every CREATE so first-time and incremental pushes use
//     the same statement list. Constraints use a name lookup against
//     pg_constraint to skip when already present (see migrate.ts).

export interface DDLStatement {
  kind: 'table' | 'unique' | 'foreignKey' | 'check' | 'index';
  sql: string;
  // Deterministic name for the object this statement creates. Used by the
  // migrator to look up "is this already applied?" in pg_class/pg_constraint.
  name: string;
  table: string;
  dropSql?: string;
}

const RESERVED_INDEX_PREFIX = 'forge_';

function tableConstraintName(table: string, kind: string, parts: string[]): string {
  // Constraint names are 63-byte limited in PG; collapse long ones.
  const raw = `${RESERVED_INDEX_PREFIX}${table}_${kind}_${parts.join('_')}`;
  if (raw.length <= 60) return raw;
  // Hash-collapse when too long (deterministic per input).
  let hash = 0;
  for (let i = 0; i < raw.length; i++) hash = (hash * 31 + raw.charCodeAt(i)) | 0;
  return `${RESERVED_INDEX_PREFIX}${table}_${kind}_${(hash >>> 0).toString(36)}`;
}

export interface BuildDDLOptions {
  dialect?: Dialect;
}

export function buildSchemaDDL(
  schema: SchemaMap,
  opts: BuildDDLOptions = {},
): DDLStatement[] {
  const d = opts.dialect ?? PostgresDialect;
  const out: DDLStatement[] = [];

  // Pass 1: tables (so FKs in pass 2 and views in pass 3 can reference them).
  for (const key of Object.keys(schema)) {
    const m = (schema as any)[key] as ModelDef<any>;
    if (!m) continue;
    if (m.view) continue;
    out.push(buildCreateTable(d, m));
  }

  // Pass 2: constraints (unique, FK, check) + indexes — tables only.
  for (const key of Object.keys(schema)) {
    const m = (schema as any)[key] as ModelDef<any>;
    if (!m || m.view) continue;
    out.push(...buildPerFieldUniques(d, m));
    out.push(...buildCompositeUniques(d, m));
    out.push(...buildForeignKeys(d, m, schema));
    out.push(...buildEnumChecks(d, m));
    out.push(...buildIndexes(d, m));
    out.push(...buildSearchableIndexes(d, m));
  }

  // Pass 3: CREATE [MATERIALIZED] VIEW for view-marked models.
  for (const key of Object.keys(schema)) {
    const m = (schema as any)[key] as ModelDef<any>;
    if (!m?.view?.sql) continue;
    const q = d.quoteIdent(m.collection);
    if (m.view.materialised) {
      out.push({
        kind: 'table',
        name: m.collection,
        table: m.collection,
        // No CREATE OR REPLACE for matviews; IF NOT EXISTS makes push idempotent.
        sql: `CREATE MATERIALIZED VIEW IF NOT EXISTS ${q} AS ${m.view.sql}`,
        dropSql: `DROP MATERIALIZED VIEW IF EXISTS ${q}`,
      });
      continue;
    }
    out.push({
      kind: 'table',          // close enough — DDL applier treats this as a CREATE-DROP unit
      name: m.collection,
      table: m.collection,
      sql: `CREATE OR REPLACE VIEW ${q} AS ${m.view.sql}`,
      dropSql: `DROP VIEW IF EXISTS ${q}`,
    });
  }

  return out;
}

// Auto-emit GIN indexes on to_tsvector(col) for `.searchable()` fields. The
// `where: { col: { search: q } }` operator compiles to the same expression so
// this index serves the query.
function buildSearchableIndexes(d: Dialect, m: ModelDef<any>): DDLStatement[] {
  const out: DDLStatement[] = [];
  for (const [fieldName, fdef] of Object.entries(m.fields)) {
    const field = fdef as FieldDef;
    if (!field.searchable) continue;
    const name = `forge_${m.collection}_fts_${fieldName}`;
    out.push({
      kind: 'index', name, table: m.collection,
      sql: `CREATE INDEX IF NOT EXISTS ${d.quoteIdent(name)} ON ${d.quoteIdent(m.collection)} USING gin(to_tsvector('simple', ${d.quoteIdent(fieldName)}))`,
      dropSql: `DROP INDEX IF EXISTS ${d.quoteIdent(name)}`,
    });
  }
  return out;
}

function buildCreateTable(d: Dialect, m: ModelDef<any>): DDLStatement {
  const table = m.collection;
  const cols: string[] = [];
  let pkField: string | undefined;
  for (const [fieldName, field] of Object.entries(m.fields)) {
    const col = renderColumn(d, fieldName, field as FieldDef);
    cols.push(col);
    if ((field as FieldDef).kind === 'id') pkField = fieldName;
  }
  if (pkField) cols.push(`PRIMARY KEY (${d.quoteIdent(pkField)})`);
  const sql = `CREATE TABLE IF NOT EXISTS ${d.quoteIdent(table)} (\n  ${cols.join(',\n  ')}\n)`;
  return {
    kind: 'table',
    sql,
    name: table,
    table,
    dropSql: `DROP TABLE IF EXISTS ${d.quoteIdent(table)} CASCADE`,
  };
}

function renderColumn(d: Dialect, name: string, field: FieldDef): string {
  const colName = d.quoteIdent(name);
  const type = d.columnType(field);
  // Generated columns are computed by the DB; they take neither a default
  // nor an explicit NOT NULL (the expression governs nullability).
  if (field.dbGenerated) {
    return `${colName} ${type} GENERATED ALWAYS AS (${field.dbGenerated}) STORED`;
  }
  // BIGSERIAL on Postgres expands to BIGINT + sequence + DEFAULT nextval(...)
  // + NOT NULL all in one — appending any of those again is a syntax error.
  if (field.kind === 'id' && field.idType === 'bigserial') {
    return `${colName} ${type}`;
  }
  const nullable = field.optional ? '' : ' NOT NULL';
  const def = renderDefault(field);
  return `${colName} ${type}${nullable}${def}`;
}

function renderDefault(field: FieldDef): string {
  if (!field.default) {
    if (field.kind === 'uuid' && field.uuidDefault) {
      return ` DEFAULT gen_random_uuid()`;
    }
    // embedMany defaults to empty array so callers don't pass `[]` on every
    // create. Optional embedManys remain free to be NULL.
    if (field.kind === 'embedMany' && !field.optional) {
      return ` DEFAULT '[]'::jsonb`;
    }
    return '';
  }
  switch (field.default.kind) {
    case 'now':    return ' DEFAULT now()';
    case 'autoId': return ''; // ObjectId-flavour ids are caller-generated
    case 'literal': {
      const v = field.default.value;
      if (v === null) return ' DEFAULT NULL';
      if (typeof v === 'boolean') return ` DEFAULT ${v ? 'TRUE' : 'FALSE'}`;
      if (typeof v === 'number') return ` DEFAULT ${v}`;
      if (typeof v === 'string') return ` DEFAULT ${escapeSqlString(v)}`;
      // An array column takes an array literal, not JSON. The `::jsonb`
      // fallback below is right for json / embed / geoPoint and wrong for
      // `text[]` / `integer[]` — Postgres refuses the CREATE TABLE outright
      // ("column is of type text[] but default expression is of type jsonb"),
      // so declaring a default on a list column made the whole table
      // undeployable. Found by running the DDL against a real server; a
      // string-level test cannot see it.
      if (field.kind === 'stringArray' || field.kind === 'intArray') {
        const cast = field.kind === 'intArray' ? 'integer[]' : 'text[]';
        if (!Array.isArray(v)) return ` DEFAULT '{}'::${cast}`;
        if (v.length === 0) return ` DEFAULT '{}'::${cast}`;
        const items = v.map((x) =>
          field.kind === 'intArray' ? String(Number(x)) : escapeSqlString(String(x)),
        );
        return ` DEFAULT ARRAY[${items.join(', ')}]::${cast}`;
      }
      return ` DEFAULT ${escapeSqlString(JSON.stringify(v))}::jsonb`;
    }
  }
}

function escapeSqlString(v: string): string {
  return `'${String(v).replace(/'/g, "''")}'`;
}

function buildPerFieldUniques(d: Dialect, m: ModelDef<any>): DDLStatement[] {
  const table = m.collection;
  const out: DDLStatement[] = [];
  for (const [fieldName, field] of Object.entries(m.fields)) {
    if (!(field as FieldDef).unique) continue;
    // The `id` field gets a PRIMARY KEY which implies UNIQUE — don't double up.
    if ((field as FieldDef).kind === 'id') continue;
    const name = tableConstraintName(table, 'uq', [fieldName]);
    out.push({
      kind: 'unique',
      name,
      table,
      sql: `ALTER TABLE ${d.quoteIdent(table)} ADD CONSTRAINT ${d.quoteIdent(name)} UNIQUE (${d.quoteIdent(fieldName)})`,
      dropSql: `ALTER TABLE ${d.quoteIdent(table)} DROP CONSTRAINT IF EXISTS ${d.quoteIdent(name)}`,
    });
  }
  return out;
}

function buildCompositeUniques(d: Dialect, m: ModelDef<any>): DDLStatement[] {
  const table = m.collection;
  const out: DDLStatement[] = [];
  for (const cols of m.uniques ?? []) {
    const name = tableConstraintName(table, 'uq', cols);
    const colList = cols.map(d.quoteIdent).join(', ');
    out.push({
      kind: 'unique',
      name,
      table,
      sql: `ALTER TABLE ${d.quoteIdent(table)} ADD CONSTRAINT ${d.quoteIdent(name)} UNIQUE (${colList})`,
      dropSql: `ALTER TABLE ${d.quoteIdent(table)} DROP CONSTRAINT IF EXISTS ${d.quoteIdent(name)}`,
    });
  }
  return out;
}

function buildForeignKeys(
  d: Dialect,
  m: ModelDef<any>,
  schema: SchemaMap,
): DDLStatement[] {
  const table = m.collection;
  const out: DDLStatement[] = [];
  const rels = m.relations();
  for (const [, rel] of Object.entries(rels)) {
    const r = rel as RelationDef;
    // Inverse-side relations don't get FKs (they're the other side of an
    // owning-side FK on the partner table).
    if (r.inverse) continue;
    // FK only when the parent actually owns the column.
    if (!m.fields[r.on]) continue;
    // Inverse-one heuristic: if `on` is the model's primary key (kind:'id'),
    // this is the inverse side of a one-to-one — the FK actually lives on
    // the target's `refs` column. Skip FK emission here.
    const onField = m.fields[r.on];
    if (onField?.kind === 'id') continue;
    out.push(buildForeignKey(d, table, r, schema));
  }
  return out;
}

function buildForeignKey(
  d: Dialect,
  table: string,
  rel: RelationDef,
  schema: SchemaMap,
): DDLStatement {
  const name = tableConstraintName(table, 'fk', [rel.on]);
  const onDelete = (() => {
    switch (rel.onDelete) {
      case 'Cascade':  return ' ON DELETE CASCADE';
      case 'SetNull':  return ' ON DELETE SET NULL';
      case 'Restrict': return ' ON DELETE RESTRICT';
      case 'NoAction':
      default:         return ' ON DELETE NO ACTION';
    }
  })();
  // `rel.target` is the schema map KEY (e.g. 'user'); the actual table name
  // is the target model's `collection` (e.g. 'users'). Resolve through the
  // live schema so the FK references the right physical table.
  const targetModel = (schema as any)[rel.target] as ModelDef<any> | undefined;
  const targetTable = targetModel?.collection ?? rel.target;
  return {
    kind: 'foreignKey',
    name,
    table,
    sql:
      `ALTER TABLE ${d.quoteIdent(table)} ` +
      `ADD CONSTRAINT ${d.quoteIdent(name)} ` +
      `FOREIGN KEY (${d.quoteIdent(rel.on)}) ` +
      `REFERENCES ${d.quoteIdent(targetTable)} (${d.quoteIdent(rel.refs)})` +
      onDelete,
    dropSql: `ALTER TABLE ${d.quoteIdent(table)} DROP CONSTRAINT IF EXISTS ${d.quoteIdent(name)}`,
  };
}

function buildEnumChecks(d: Dialect, m: ModelDef<any>): DDLStatement[] {
  const table = m.collection;
  const out: DDLStatement[] = [];
  for (const [fieldName, field] of Object.entries(m.fields)) {
    const fd = field as FieldDef;
    if (fd.kind !== 'enum' || !fd.enumValues?.length) continue;
    const name = tableConstraintName(table, 'enum', [fieldName]);
    const valList = fd.enumValues.map(escapeSqlString).join(', ');
    out.push({
      kind: 'check',
      name,
      table,
      sql:
        `ALTER TABLE ${d.quoteIdent(table)} ` +
        `ADD CONSTRAINT ${d.quoteIdent(name)} ` +
        `CHECK (${d.quoteIdent(fieldName)} IN (${valList}))`,
      dropSql: `ALTER TABLE ${d.quoteIdent(table)} DROP CONSTRAINT IF EXISTS ${d.quoteIdent(name)}`,
    });
  }
  return out;
}

function buildIndexes(d: Dialect, m: ModelDef<any>): DDLStatement[] {
  const table = m.collection;
  const out: DDLStatement[] = [];
  for (const idx of m.indexes ?? []) {
    out.push(buildIndex(d, table, idx, m));
  }
  return out;
}

function buildIndex(d: Dialect, table: string, idx: IndexDef, m: ModelDef<any>): DDLStatement {
  // Name fallback: use idx.name when supplied; otherwise derive from columns
  // (or 'expr' for expression indexes, since there are no column names then).
  const cols = Object.keys(idx.keys);
  const name = idx.name ?? tableConstraintName(table, 'idx', idx.expression ? ['expr'] : cols);
  const uniqueKW = idx.unique ? 'UNIQUE ' : '';

  // USING <method> — gin / gist / brin / hash. Omitted when unset or
  // 'btree' (PG's default). 'spatial' is the cross-dialect alias for
  // "spatial index family"; on PG it resolves to GIST (PostGIS-native).
  // 'vector' resolves to HNSW with the field's distance-metric opclass
  // (pgvector — needs `CREATE EXTENSION vector`).
  let resolvedMethod: string | undefined = idx.method;
  let vectorOpsClass: string | undefined;
  if (idx.method === 'spatial') {
    resolvedMethod = 'gist';
  } else if (idx.method === 'vector') {
    resolvedMethod = 'hnsw';
    const firstCol = Object.keys(idx.keys ?? {})[0];
    const fdef = firstCol ? (m.fields[firstCol] as any) : undefined;
    const metric = fdef?.vector?.metric ?? 'cosine';
    vectorOpsClass = metric === 'cosine' ? 'vector_cosine_ops'
                    : metric === 'l2'     ? 'vector_l2_ops'
                    : /* dot */              'vector_ip_ops';
  }
  const method = resolvedMethod && resolvedMethod !== 'btree' ? ` USING ${resolvedMethod}` : '';

  // Payload — either an arbitrary expression (CREATE INDEX … ((<expr>)))
  // or a column list. For column lists with the btree method we still
  // honour the existing text→text_pattern_ops opclass shortcut.
  let payload: string;
  if (idx.expression) {
    payload = `(${idx.expression})`;
  } else {
    const isBtree = !idx.method || idx.method === 'btree';
    const colExpr = cols
      .map((c) => {
        const dir = idx.keys[c];
        /*
         * ─── A DOTTED KEY OVER A JSON COLUMN ────────────────────────
         *
         * `{ 'customer.id': 1 }` is Mongo's way of indexing inside an
         * embedded document, and it is the natural way to write it:
         * the schema already says `customer` is an `f.embed()`.
         *
         * Quoting it as an identifier emits the column `"customer.id"`,
         * which does not exist — the single thing that stopped a real
         * schema (277 models) from pushing to Postgres. The author's
         * only escape was `expression`, which is wrapped as ONE
         * expression and therefore cannot carry a mixed index like
         * `(orgId, customer.id, createdAt DESC)` — it emits a row
         * constructor and PG answers "syntax error at or near ','".
         *
         * So the path is translated here instead. forge already knows
         * the root is jsonb, because the schema declared it: `a.b.c`
         * becomes `(("a"->'b'->>'c'))`, with the last hop as `->>` so
         * the index is over text rather than jsonb. Nobody has to
         * write SQL, and the same declaration serves both dialects.
         *
         * A dotted key whose ROOT IS NOT a json/embed column is left
         * alone and will fail loudly as before — that is a typo, not a
         * path, and inventing a translation for it would hide it.
         */
        const dot = c.indexOf('.');
        if (dot > 0) {
          const root = c.slice(0, dot);
          const rootDef = m.fields[root] as { kind?: string } | undefined;
          const kind = rootDef?.kind;
          if (kind === 'json' || kind === 'embed' || kind === 'embedMany') {
            const path = c.slice(dot + 1).split('.');
            // Segments come from the schema, never from a request. A
            // quote in one is a typo, and silently escaping it would
            // build an index on a key nobody meant.
            for (const seg of path) {
              if (seg.includes("'")) {
                throw new Error(
                  `[forge:postgres] index key '${c}' has a quote in its path. ` +
                  'JSON path segments must be plain keys.',
                );
              }
            }
            const last = path.pop()!;
            const hops = path.map((seg) => `->'${seg}'`).join('');
            const expr = `(${d.quoteIdent(root)}${hops}->>'${last}')`;
            if (!isBtree) return `(${expr})`;
            return `(${expr}) ${dir === -1 ? 'DESC' : 'ASC'}`;
          }
        }
        if (isBtree && dir === 'text') return `${d.quoteIdent(c)} text_pattern_ops`;
        // pgvector requires the metric opclass alongside the column:
        // `embedding vector_cosine_ops`.
        if (vectorOpsClass) return `${d.quoteIdent(c)} ${vectorOpsClass}`;
        if (!isBtree) return d.quoteIdent(c);
        return `${d.quoteIdent(c)} ${dir === -1 ? 'DESC' : 'ASC'}`;
      })
      .join(', ');
    payload = colExpr;
  }

  // INCLUDE — covering columns for index-only scans. PG-only feature; the
  // schema typing already gates it to SQL by convention.
  const include = idx.include?.length
    ? ` INCLUDE (${idx.include.map(d.quoteIdent).join(', ')})`
    : '';

  // WHERE — partial index predicate. Mongo callers pass an object via
  // partialFilterExpression / where; SQL prefers a raw SQL string. When a
  // Mongo-shaped object is passed on a SQL schema, attempt to translate
  // the common operators ($eq / $ne / $in / $exists / $type / etc.) into
  // SQL via the shared mongo-to-sql translator. Anything we can't
  // translate falls through to a warn-and-skip so the user knows to write
  // raw SQL.
  let whereClause = '';
  if (typeof idx.where === 'string' && idx.where.trim()) {
    whereClause = ` WHERE ${idx.where}`;
  } else if (idx.where && typeof idx.where === 'object') {
    const translated = mongoToSqlWhere(idx.where as Record<string, unknown>, {
      quoteIdent: d.quoteIdent,
      dialect: 'postgres',
    });
    if (translated) {
      whereClause = ` WHERE ${translated}`;
    } else {
      // eslint-disable-next-line no-console
      console.warn(
        `[forge:push:postgres] index '${name}' has an object-form 'where' ` +
        `that uses operators outside the translator's coverage. Pass a raw ` +
        `SQL string in 'where' or simplify the object. Filter omitted.`,
      );
    }
  } else if (idx.partialFilterExpression) {
    // Cross-dialect schemas may pass partialFilterExpression instead of `where`.
    // Translate it the same way so a single Mongo-shaped filter drives both
    // dialects.
    const translated = mongoToSqlWhere(idx.partialFilterExpression, {
      quoteIdent: d.quoteIdent,
      dialect: 'postgres',
    });
    if (translated) whereClause = ` WHERE ${translated}`;
  }

  /*
   * ─── TTL IS MONGO-ONLY, AND SILENCE WAS THE DANGEROUS PART ─────────
   *
   * `expireAfterSeconds` tells Mongo to delete a row once a date column
   * is old enough. Postgres has no equivalent — expiry is a job, not an
   * index — so this adapter cannot honour it and never could.
   *
   * What it did until now was build the index WITHOUT the expiry and
   * say nothing. The index then looks right in `\d`, the push reports
   * success, and the rows simply stop being deleted. On a real schema
   * that was eight indexes, every one of them on a table that grows a
   * row per authentication attempt — OTP codes, password-reset tokens,
   * refresh tokens, portal sessions, finished jobs. The tables the TTLs
   * were added to stop growing.
   *
   * There is nothing to emit, so this warns instead, in the same voice
   * as `method: 'vector'` above: the index is still created, and the
   * operator is told what it does NOT do, by name, while they are
   * looking at the push output.
   */
  if (typeof idx.expireAfterSeconds === 'number') {
    // eslint-disable-next-line no-console
    console.warn(
      `[forge:push:postgres] index '${name}' sets 'expireAfterSeconds: ` +
      `${idx.expireAfterSeconds}' — Postgres has no TTL index, so rows in ` +
      `'${table}' will NOT expire. The index is created without it. Schedule ` +
      `a delete job for this table, or the rows accumulate forever.`,
    );
  }

  // MySQL-only fields — warn loudly if set on Postgres so a portable schema
  // can drop them.
  if (idx.visible === false) {
    // eslint-disable-next-line no-console
    console.warn(
      `[forge:push:postgres] index '${name}' sets 'visible: false' — Postgres ` +
      `doesn't have invisible indexes. Ignored.`,
    );
  }
  if (idx.parser) {
    // eslint-disable-next-line no-console
    console.warn(
      `[forge:push:postgres] index '${name}' sets 'parser' — Postgres uses ` +
      `to_tsvector/configuration, not FULLTEXT parser plugins. Ignored.`,
    );
  }

  return {
    kind: 'index',
    name,
    table,
    sql:
      `CREATE ${uniqueKW}INDEX IF NOT EXISTS ${d.quoteIdent(name)} ` +
      `ON ${d.quoteIdent(table)}${method} (${payload})${include}${whereClause}`,
    dropSql: `DROP INDEX IF EXISTS ${d.quoteIdent(name)}`,
  };
}
