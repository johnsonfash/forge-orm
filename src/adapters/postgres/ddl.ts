import type { FieldDef, IndexDef, ModelDef, RelationDef } from '../../schema/types';
import type { SchemaMap } from '../../schema';
import { PostgresDialect, type Dialect } from './dialect';

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
    out.push(buildIndex(d, table, idx));
  }
  return out;
}

function buildIndex(d: Dialect, table: string, idx: IndexDef): DDLStatement {
  // Name fallback: use idx.name when supplied; otherwise derive from columns
  // (or 'expr' for expression indexes, since there are no column names then).
  const cols = Object.keys(idx.keys);
  const name = idx.name ?? tableConstraintName(table, 'idx', idx.expression ? ['expr'] : cols);
  const uniqueKW = idx.unique ? 'UNIQUE ' : '';

  // USING <method> — gin / gist / brin / hash. Omitted when unset or
  // 'btree' (PG's default). The DB raises a clear error if the method
  // isn't installed (e.g. gin/gist without the extensions).
  const method = idx.method && idx.method !== 'btree' ? ` USING ${idx.method}` : '';

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
        if (isBtree && dir === 'text') return `${d.quoteIdent(c)} text_pattern_ops`;
        // Non-btree methods don't take ASC/DESC and won't accept the
        // text_pattern_ops opclass.
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
  // partialFilterExpression / where; SQL needs a raw SQL string. When an
  // object is passed accidentally to a SQL schema it would be wrong to
  // try to translate Mongo operators ($type / $exists / …) verbatim —
  // skip it with a warning instead of producing wrong SQL.
  let whereClause = '';
  if (typeof idx.where === 'string' && idx.where.trim()) {
    whereClause = ` WHERE ${idx.where}`;
  } else if (idx.where && typeof idx.where === 'object') {
    // eslint-disable-next-line no-console
    console.warn(
      `[forge:push:postgres] index '${name}' has object-form 'where' — ` +
      `expected a raw SQL string on Postgres. The partial filter is being ` +
      `omitted. (Use partialFilterExpression for Mongo and where: 'sql…' for PG.)`,
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
