import type { FieldDef, IndexDef, ModelDef, RelationDef } from '../../schema/types';
import type { SchemaMap } from '../../schema';
import type { DDLStatement } from '../postgres/ddl';
import { MysqlDialect } from './dialect';

// MySQL DDL. Same overall shape as Postgres, with these adjustments:
//   • Backtick identifier quoting.
//   • DEFAULT now() → DEFAULT CURRENT_TIMESTAMP(3) (millisecond precision).
//   • boolean → TINYINT(1); defaults 0/1 not TRUE/FALSE.
//   • No `CREATE INDEX … USING text_pattern_ops` — plain BTREE.
//   • No `text[]` — use JSON for arrays.
//   • Foreign keys can be emitted via ALTER TABLE (same as PG).

const RESERVED_INDEX_PREFIX = 'forge_';

function tableConstraintName(table: string, kind: string, parts: string[]): string {
  const raw = `${RESERVED_INDEX_PREFIX}${table}_${kind}_${parts.join('_')}`;
  if (raw.length <= 60) return raw;
  let hash = 0;
  for (let i = 0; i < raw.length; i++) hash = (hash * 31 + raw.charCodeAt(i)) | 0;
  return `${RESERVED_INDEX_PREFIX}${table}_${kind}_${(hash >>> 0).toString(36)}`;
}

export function buildSchemaDDL(schema: SchemaMap): DDLStatement[] {
  const d = MysqlDialect;
  const out: DDLStatement[] = [];
  for (const key of Object.keys(schema)) {
    const m = (schema as any)[key] as ModelDef<any>;
    if (!m || m.view) continue;
    out.push(buildCreateTable(m));
  }
  for (const key of Object.keys(schema)) {
    const m = (schema as any)[key] as ModelDef<any>;
    if (!m || m.view) continue;
    out.push(...buildPerFieldUniques(m));
    out.push(...buildCompositeUniques(m));
    out.push(...buildForeignKeys(m, schema));
    out.push(...buildEnumChecks(m));
    out.push(...buildIndexes(m));
    out.push(...buildSearchableIndexes(m));
  }
  // MySQL has no native materialised views — back them with a real TABLE
  // populated from the SELECT; db.<model>.refresh() truncates + re-inserts.
  for (const key of Object.keys(schema)) {
    const m = (schema as any)[key] as ModelDef<any>;
    if (!m?.view?.sql) continue;
    const q = d.quoteIdent(m.collection);
    if (m.view.materialised) {
      out.push({
        kind: 'table',
        name: m.collection,
        table: m.collection,
        sql: `CREATE TABLE IF NOT EXISTS ${q} AS ${m.view.sql}`,
        dropSql: `DROP TABLE IF EXISTS ${q}`,
      });
      continue;
    }
    out.push({
      kind: 'table',
      name: m.collection,
      table: m.collection,
      sql: `CREATE OR REPLACE VIEW ${q} AS ${m.view.sql}`,
      dropSql: `DROP VIEW IF EXISTS ${q}`,
    });
  }
  return out;
}

// Auto-emit FULLTEXT indexes for `.searchable()` fields: the search operator
// compiles to `MATCH(col) AGAINST(?)`, which requires a FULLTEXT index.
function buildSearchableIndexes(m: ModelDef<any>): DDLStatement[] {
  const d = MysqlDialect;
  const out: DDLStatement[] = [];
  for (const [fieldName, fdef] of Object.entries(m.fields)) {
    const field = fdef as FieldDef;
    if (!field.searchable) continue;
    const name = `forge_${m.collection}_fts_${fieldName}`;
    out.push({
      kind: 'index', name, table: m.collection,
      sql: `ALTER TABLE ${d.quoteIdent(m.collection)} ADD FULLTEXT ${d.quoteIdent(name)} (${d.quoteIdent(fieldName)})`,
      dropSql: `ALTER TABLE ${d.quoteIdent(m.collection)} DROP INDEX ${d.quoteIdent(name)}`,
    });
  }
  return out;
}

function buildCreateTable(m: ModelDef<any>): DDLStatement {
  const d = MysqlDialect;
  const table = m.collection;
  const cols: string[] = [];
  let pkField: string | undefined;
  for (const [name, fdef] of Object.entries(m.fields)) {
    const field = fdef as FieldDef;
    cols.push(renderColumn(name, field));
    if (field.kind === 'id') pkField = name;
  }
  if (pkField) cols.push(`PRIMARY KEY (${d.quoteIdent(pkField)})`);
  const sql = `CREATE TABLE IF NOT EXISTS ${d.quoteIdent(table)} (\n  ${cols.join(',\n  ')}\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`;
  return { kind: 'table', sql, name: table, table, dropSql: `DROP TABLE IF EXISTS ${d.quoteIdent(table)}` };
}

function renderColumn(name: string, field: FieldDef): string {
  const d = MysqlDialect;
  const colName = d.quoteIdent(name);
  const type = d.columnType(field);
  if (field.dbGenerated) {
    return `${colName} ${type} GENERATED ALWAYS AS (${field.dbGenerated}) STORED`;
  }
  // bigserial — MySQL form is BIGINT NOT NULL AUTO_INCREMENT. No DEFAULT
  // clause; AUTO_INCREMENT is mutually exclusive with one.
  if (field.kind === 'id' && field.idType === 'bigserial') {
    return `${colName} ${type} NOT NULL AUTO_INCREMENT`;
  }
  const nullable = field.optional ? '' : ' NOT NULL';
  const def = renderDefault(field);
  return `${colName} ${type}${nullable}${def}`;
}

function renderDefault(field: FieldDef): string {
  if (!field.default) {
    // uuid DB-side default — MySQL 8+ allows expression defaults.
    if (field.kind === 'uuid' && field.uuidDefault) return ` DEFAULT (UUID())`;
    if (field.kind === 'embedMany' && !field.optional) return ` DEFAULT (JSON_ARRAY())`;
    return '';
  }
  switch (field.default.kind) {
    case 'now':     return ' DEFAULT CURRENT_TIMESTAMP(3)';
    case 'autoId':  return '';
    case 'literal': {
      const v = field.default.value;
      if (v === null) return ' DEFAULT NULL';
      if (typeof v === 'boolean') return ` DEFAULT ${v ? 1 : 0}`;
      if (typeof v === 'number')  return ` DEFAULT ${v}`;
      if (typeof v === 'string')  return ` DEFAULT ${escapeSqlString(v)}`;
      return ` DEFAULT (${escapeSqlString(JSON.stringify(v))})`;  // JSON expression default
    }
  }
}

function escapeSqlString(v: string): string {
  return `'${String(v).replace(/'/g, "''").replace(/\\/g, '\\\\')}'`;
}

function buildPerFieldUniques(m: ModelDef<any>): DDLStatement[] {
  const d = MysqlDialect;
  const table = m.collection;
  const out: DDLStatement[] = [];
  for (const [name, fdef] of Object.entries(m.fields)) {
    const field = fdef as FieldDef;
    if (!field.unique) continue;
    if (field.kind === 'id') continue;
    const cname = tableConstraintName(table, 'uq', [name]);
    out.push({
      kind: 'unique', name: cname, table,
      sql: `ALTER TABLE ${d.quoteIdent(table)} ADD CONSTRAINT ${d.quoteIdent(cname)} UNIQUE (${d.quoteIdent(name)})`,
      dropSql: `ALTER TABLE ${d.quoteIdent(table)} DROP INDEX ${d.quoteIdent(cname)}`,
    });
  }
  return out;
}

function buildCompositeUniques(m: ModelDef<any>): DDLStatement[] {
  const d = MysqlDialect;
  const table = m.collection;
  const out: DDLStatement[] = [];
  for (const cols of m.uniques ?? []) {
    const cname = tableConstraintName(table, 'uq', cols);
    out.push({
      kind: 'unique', name: cname, table,
      sql: `ALTER TABLE ${d.quoteIdent(table)} ADD CONSTRAINT ${d.quoteIdent(cname)} UNIQUE (${cols.map(d.quoteIdent).join(', ')})`,
      dropSql: `ALTER TABLE ${d.quoteIdent(table)} DROP INDEX ${d.quoteIdent(cname)}`,
    });
  }
  return out;
}

function buildForeignKeys(m: ModelDef<any>, schema: SchemaMap): DDLStatement[] {
  const d = MysqlDialect;
  const table = m.collection;
  const out: DDLStatement[] = [];
  for (const [, rel] of Object.entries(m.relations())) {
    const r = rel as RelationDef;
    if (r.inverse) continue;
    if (!m.fields[r.on]) continue;
    if (m.fields[r.on]?.kind === 'id') continue;     // inverse-one heuristic
    const targetModel = (schema as any)[r.target] as ModelDef<any> | undefined;
    if (!targetModel) continue;
    const cname = tableConstraintName(table, 'fk', [r.on]);
    const onDelete = (() => {
      switch (r.onDelete) {
        case 'Cascade':  return ' ON DELETE CASCADE';
        case 'SetNull':  return ' ON DELETE SET NULL';
        case 'Restrict': return ' ON DELETE RESTRICT';
        default:         return ' ON DELETE NO ACTION';
      }
    })();
    out.push({
      kind: 'foreignKey', name: cname, table,
      sql:
        `ALTER TABLE ${d.quoteIdent(table)} ` +
        `ADD CONSTRAINT ${d.quoteIdent(cname)} ` +
        `FOREIGN KEY (${d.quoteIdent(r.on)}) ` +
        `REFERENCES ${d.quoteIdent(targetModel.collection)} (${d.quoteIdent(r.refs)})` +
        onDelete,
      dropSql: `ALTER TABLE ${d.quoteIdent(table)} DROP FOREIGN KEY ${d.quoteIdent(cname)}`,
    });
  }
  return out;
}

function buildEnumChecks(m: ModelDef<any>): DDLStatement[] {
  const d = MysqlDialect;
  const table = m.collection;
  const out: DDLStatement[] = [];
  for (const [name, fdef] of Object.entries(m.fields)) {
    const field = fdef as FieldDef;
    if (field.kind !== 'enum' || !field.enumValues?.length) continue;
    const cname = tableConstraintName(table, 'enum', [name]);
    const vals = field.enumValues.map(escapeSqlString).join(', ');
    out.push({
      kind: 'check', name: cname, table,
      sql: `ALTER TABLE ${d.quoteIdent(table)} ADD CONSTRAINT ${d.quoteIdent(cname)} CHECK (${d.quoteIdent(name)} IN (${vals}))`,
      dropSql: `ALTER TABLE ${d.quoteIdent(table)} DROP CONSTRAINT ${d.quoteIdent(cname)}`,
    });
  }
  return out;
}

function buildIndexes(m: ModelDef<any>): DDLStatement[] {
  const d = MysqlDialect;
  const table = m.collection;
  const out: DDLStatement[] = [];
  for (const idx of m.indexes ?? []) {
    const i = idx as IndexDef;
    const cols = Object.keys(i.keys);
    const name = i.name ?? tableConstraintName(table, 'idx', i.expression ? ['expr'] : cols);

    // MySQL spatial / fulltext are statement-prefix keywords (CREATE SPATIAL
    // INDEX … / CREATE FULLTEXT INDEX …) — not USING clauses. Other methods
    // (gin / gist / brin / hash) don't exist on MySQL; we ignore them so the
    // schema can stay portable.
    let kindKW = '';
    if (i.method === 'spatial') kindKW = 'SPATIAL ';
    else if (i.method === 'fulltext') kindKW = 'FULLTEXT ';
    else if (i.unique) kindKW = 'UNIQUE ';

    // Expression index: MySQL 8.0+ supports (CAST/JSON-extract/etc) — wrap
    // the user-supplied expression in an extra paren pair per the docs:
    // `CREATE INDEX i ON t ((LOWER(name)))`.
    let payload: string;
    if (i.expression) {
      payload = `(${i.expression})`;
    } else {
      payload = cols
        .map((c) => {
          const dir = i.keys[c];
          if (dir === 'text') return `${d.quoteIdent(c)}`;
          // SPATIAL / FULLTEXT don't accept ASC/DESC.
          if (i.method === 'spatial' || i.method === 'fulltext') return d.quoteIdent(c);
          return `${d.quoteIdent(c)} ${dir === -1 ? 'DESC' : 'ASC'}`;
        })
        .join(', ');
    }

    // INCLUDE is PG-only — warn if the user passes it on MySQL.
    if (i.include?.length) {
      // eslint-disable-next-line no-console
      console.warn(
        `[forge:push:mysql] index '${name}' uses include — INCLUDE is a ` +
        `Postgres-only feature. Ignored on MySQL.`,
      );
    }

    // WHERE — MySQL does NOT support partial indexes natively. Warn + skip.
    if (i.where) {
      // eslint-disable-next-line no-console
      console.warn(
        `[forge:push:mysql] index '${name}' uses 'where' — MySQL does not ` +
        `support partial indexes. Either drop the filter or model it as a ` +
        `generated column + plain index. Ignored.`,
      );
    }

    out.push({
      kind: 'index',
      name,
      table,
      sql: `CREATE ${kindKW}INDEX ${d.quoteIdent(name)} ON ${d.quoteIdent(table)} (${payload})`,
      dropSql: `DROP INDEX ${d.quoteIdent(name)} ON ${d.quoteIdent(table)}`,
    });
  }
  return out;
}
