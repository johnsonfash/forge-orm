import type { FieldDef, IndexDef, ModelDef, RelationDef } from '../../schema/types';
import type { SchemaMap } from '../../schema';
import { SqliteDialect } from './dialect';
import type { DDLStatement } from '../postgres/ddl';

// SQLite DDL — same shape as Postgres, adjusted for SQLite quirks:
//   • FKs emitted inside CREATE TABLE (SQLite can't ALTER TABLE … ADD FK), and
//     only enforced when `PRAGMA foreign_keys = ON` (adapter sets it at connect).
//   • No `ALTER TABLE … ADD CONSTRAINT UNIQUE` — use `CREATE UNIQUE INDEX`.
//   • Boolean defaults 0/1; timestamp default `CURRENT_TIMESTAMP` (no `now()`).

const RESERVED_INDEX_PREFIX = 'forge_';

function tableConstraintName(table: string, kind: string, parts: string[]): string {
  const raw = `${RESERVED_INDEX_PREFIX}${table}_${kind}_${parts.join('_')}`;
  if (raw.length <= 60) return raw;
  let hash = 0;
  for (let i = 0; i < raw.length; i++) hash = (hash * 31 + raw.charCodeAt(i)) | 0;
  return `${RESERVED_INDEX_PREFIX}${table}_${kind}_${(hash >>> 0).toString(36)}`;
}

export function buildSchemaDDL(schema: SchemaMap): DDLStatement[] {
  const d = SqliteDialect;
  const out: DDLStatement[] = [];

  // FKs are inline in CREATE TABLE, so build the full table statement up-front.
  for (const key of Object.keys(schema)) {
    const m = (schema as any)[key] as ModelDef<any>;
    if (!m || m.view) continue;
    out.push(buildCreateTable(m, schema));
  }

  for (const key of Object.keys(schema)) {
    const m = (schema as any)[key] as ModelDef<any>;
    if (!m || m.view) continue;
    out.push(...buildUniques(m));
    out.push(...buildIndexes(m));
    out.push(...buildFtsTables(m));
  }

  // SQLite has no native materialised views — back them with a TABLE populated
  // from the SELECT; db.<model>.refresh() clears + re-inserts. Plain views use
  // CREATE VIEW; writes against them are blocked at the wrapper layer.
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
      sql: `CREATE VIEW IF NOT EXISTS ${q} AS ${m.view.sql}`,
      dropSql: `DROP VIEW IF EXISTS ${q}`,
    });
  }

  return out;
}

// Auto-emit an FTS5 virtual table (`<table>_fts`) for models with
// `.searchable()` fields. Reads aren't auto-routed through it (would need
// executor route-rewriting); $queryRaw is the supported query path for now.
function buildFtsTables(m: ModelDef<any>): DDLStatement[] {
  const d = SqliteDialect;
  const cols: string[] = [];
  for (const [name, fdef] of Object.entries(m.fields)) {
    if ((fdef as FieldDef).searchable) cols.push(name);
  }
  if (cols.length === 0) return [];
  const out: DDLStatement[] = [];
  const tname = `${m.collection}_fts`;
  const baseQ = d.quoteIdent(m.collection);
  const ftsQ = d.quoteIdent(tname);
  const colsQ = cols.map(d.quoteIdent).join(', ');
  const colsList = cols.join(', ');
  const newCols = cols.map((c) => `new.${d.quoteIdent(c)}`).join(', ');
  const oldCols = cols.map((c) => `old.${d.quoteIdent(c)}`).join(', ');

  // FTS5 virtual table (external-content shadow of the base table).
  out.push({
    kind: 'index', name: tname, table: m.collection,
    sql: `CREATE VIRTUAL TABLE IF NOT EXISTS ${ftsQ} USING fts5(${colsQ}, content=${baseQ}, content_rowid='rowid')`,
    dropSql: `DROP TABLE IF EXISTS ${ftsQ}`,
  });

  // Triggers mirror base-table INSERT/DELETE/UPDATE into the FTS index —
  // without them the virtual table stays empty even as the base fills.
  out.push({
    kind: 'index', name: `${tname}_ai`, table: m.collection,
    sql: `CREATE TRIGGER IF NOT EXISTS ${d.quoteIdent(`${tname}_ai`)}
          AFTER INSERT ON ${baseQ} BEGIN
            INSERT INTO ${ftsQ}(rowid, ${colsList}) VALUES (new.rowid, ${newCols});
          END`,
    dropSql: `DROP TRIGGER IF EXISTS ${d.quoteIdent(`${tname}_ai`)}`,
  });
  out.push({
    kind: 'index', name: `${tname}_ad`, table: m.collection,
    sql: `CREATE TRIGGER IF NOT EXISTS ${d.quoteIdent(`${tname}_ad`)}
          AFTER DELETE ON ${baseQ} BEGIN
            INSERT INTO ${ftsQ}(${ftsQ}, rowid, ${colsList}) VALUES('delete', old.rowid, ${oldCols});
          END`,
    dropSql: `DROP TRIGGER IF EXISTS ${d.quoteIdent(`${tname}_ad`)}`,
  });
  out.push({
    kind: 'index', name: `${tname}_au`, table: m.collection,
    sql: `CREATE TRIGGER IF NOT EXISTS ${d.quoteIdent(`${tname}_au`)}
          AFTER UPDATE ON ${baseQ} BEGIN
            INSERT INTO ${ftsQ}(${ftsQ}, rowid, ${colsList}) VALUES('delete', old.rowid, ${oldCols});
            INSERT INTO ${ftsQ}(rowid, ${colsList}) VALUES (new.rowid, ${newCols});
          END`,
    dropSql: `DROP TRIGGER IF EXISTS ${d.quoteIdent(`${tname}_au`)}`,
  });
  return out;
}

function buildCreateTable(m: ModelDef<any>, schema: SchemaMap): DDLStatement {
  const d = SqliteDialect;
  const table = m.collection;
  const cols: string[] = [];
  let pkField: string | undefined;
  let pkInline = false;
  for (const [name, fdef] of Object.entries(m.fields)) {
    const field = fdef as FieldDef;
    cols.push(renderColumn(name, field));
    if (field.kind === 'id') {
      pkField = name;
      // SQLite quirk: AUTOINCREMENT only works when PRIMARY KEY is
      // declared inline on the column. renderColumn does that for
      // bigserial; suppress the table-level PRIMARY KEY clause here.
      if (field.idType === 'bigserial') pkInline = true;
    }
  }
  if (pkField && !pkInline) cols.push(`PRIMARY KEY (${d.quoteIdent(pkField)})`);

  for (const [name, fdef] of Object.entries(m.fields)) {
    const field = fdef as FieldDef;
    if (field.kind === 'enum' && field.enumValues?.length) {
      const vals = field.enumValues.map(escapeSqlString).join(', ');
      cols.push(`CHECK (${d.quoteIdent(name)} IN (${vals}))`);
    }
  }

  const rels = m.relations();
  for (const [, rel] of Object.entries(rels)) {
    const r = rel as RelationDef;
    if (r.inverse) continue;
    if (!m.fields[r.on]) continue;
    const onField = m.fields[r.on];
    if (onField?.kind === 'id') continue;          // inverse-one
    const targetModel = (schema as any)[r.target] as ModelDef<any> | undefined;
    if (!targetModel) continue;
    const onDelete = (() => {
      switch (r.onDelete) {
        case 'Cascade':  return ' ON DELETE CASCADE';
        case 'SetNull':  return ' ON DELETE SET NULL';
        case 'Restrict': return ' ON DELETE RESTRICT';
        default:         return ' ON DELETE NO ACTION';
      }
    })();
    cols.push(
      `FOREIGN KEY (${d.quoteIdent(r.on)}) REFERENCES ${d.quoteIdent(targetModel.collection)} (${d.quoteIdent(r.refs)})${onDelete}`,
    );
  }

  const sql = `CREATE TABLE IF NOT EXISTS ${d.quoteIdent(table)} (\n  ${cols.join(',\n  ')}\n)`;
  return {
    kind: 'table',
    sql,
    name: table,
    table,
    dropSql: `DROP TABLE IF EXISTS ${d.quoteIdent(table)}`,
  };
}

function renderColumn(name: string, field: FieldDef): string {
  const d = SqliteDialect;
  const colName = d.quoteIdent(name);
  const type = d.columnType(field);
  // SQLite generated column (3.31+). STORED keeps it on disk so it's
  // introspectable/indexable like the SQL engines.
  if (field.dbGenerated) {
    return `${colName} ${type} GENERATED ALWAYS AS (${field.dbGenerated}) STORED`;
  }
  // bigserial — inline PK + AUTOINCREMENT. NOT NULL is implied by PRIMARY
  // KEY here; adding it explicitly would also be valid but redundant.
  if (field.kind === 'id' && field.idType === 'bigserial') {
    return `${colName} ${type} PRIMARY KEY AUTOINCREMENT`;
  }
  const nullable = field.optional ? '' : ' NOT NULL';
  const def = renderDefault(field);
  return `${colName} ${type}${nullable}${def}`;
}

function renderDefault(field: FieldDef): string {
  if (!field.default) {
    if (field.kind === 'embedMany' && !field.optional) return ` DEFAULT '[]'`;
    return '';
  }
  switch (field.default.kind) {
    case 'now':     return ' DEFAULT CURRENT_TIMESTAMP';
    case 'autoId':  return ''; // user-supplied
    case 'literal': {
      const v = field.default.value;
      if (v === null) return ' DEFAULT NULL';
      if (typeof v === 'boolean') return ` DEFAULT ${v ? 1 : 0}`;
      if (typeof v === 'number')  return ` DEFAULT ${v}`;
      if (typeof v === 'string')  return ` DEFAULT ${escapeSqlString(v)}`;
      return ` DEFAULT ${escapeSqlString(JSON.stringify(v))}`;
    }
  }
}

function escapeSqlString(v: string): string {
  return `'${String(v).replace(/'/g, "''")}'`;
}

function buildUniques(m: ModelDef<any>): DDLStatement[] {
  const d = SqliteDialect;
  const table = m.collection;
  const out: DDLStatement[] = [];
  for (const [fieldName, field] of Object.entries(m.fields)) {
    const fd = field as FieldDef;
    if (!fd.unique) continue;
    if (fd.kind === 'id') continue;     // PK already unique
    const name = tableConstraintName(table, 'uq', [fieldName]);
    out.push({
      kind: 'unique', name, table,
      sql: `CREATE UNIQUE INDEX IF NOT EXISTS ${d.quoteIdent(name)} ON ${d.quoteIdent(table)} (${d.quoteIdent(fieldName)})`,
      dropSql: `DROP INDEX IF EXISTS ${d.quoteIdent(name)}`,
    });
  }
  for (const cols of m.uniques ?? []) {
    const name = tableConstraintName(table, 'uq', cols);
    const colList = cols.map(d.quoteIdent).join(', ');
    out.push({
      kind: 'unique', name, table,
      sql: `CREATE UNIQUE INDEX IF NOT EXISTS ${d.quoteIdent(name)} ON ${d.quoteIdent(table)} (${colList})`,
      dropSql: `DROP INDEX IF EXISTS ${d.quoteIdent(name)}`,
    });
  }
  return out;
}

function buildIndexes(m: ModelDef<any>): DDLStatement[] {
  const d = SqliteDialect;
  const table = m.collection;
  const out: DDLStatement[] = [];
  for (const idx of m.indexes ?? []) {
    const i = idx as IndexDef;
    const cols = Object.keys(i.keys);
    const name = i.name ?? tableConstraintName(table, 'idx', i.expression ? ['expr'] : cols);
    const uniqueKW = i.unique ? 'UNIQUE ' : '';

    // SQLite supports expression indexes natively:
    //   CREATE INDEX i ON t (lower(name))
    let payload: string;
    if (i.expression) {
      payload = `(${i.expression})`;
    } else {
      payload = cols
        .map((c) => {
          const dir = i.keys[c];
          if (dir === 'text') return `${d.quoteIdent(c)}`;
          return `${d.quoteIdent(c)} ${dir === -1 ? 'DESC' : 'ASC'}`;
        })
        .join(', ');
    }

    // SQLite supports partial indexes via WHERE. Mongo-object form is
    // ignored with a warning — SQL needs raw SQL.
    let whereClause = '';
    if (typeof i.where === 'string' && i.where.trim()) {
      whereClause = ` WHERE ${i.where}`;
    } else if (i.where && typeof i.where === 'object') {
      // eslint-disable-next-line no-console
      console.warn(
        `[forge:push:sqlite] index '${name}' has object-form 'where' — ` +
        `expected a raw SQL string on SQLite. Filter ignored.`,
      );
    }

    // INCLUDE + method aren't supported on SQLite.
    if (i.include?.length) {
      // eslint-disable-next-line no-console
      console.warn(
        `[forge:push:sqlite] index '${name}' uses include — INCLUDE is a ` +
        `Postgres-only feature. Ignored on SQLite.`,
      );
    }
    if (i.method && i.method !== 'btree') {
      // eslint-disable-next-line no-console
      console.warn(
        `[forge:push:sqlite] index '${name}' specifies method='${i.method}' — ` +
        `SQLite only supports BTREE. Method ignored.`,
      );
    }

    out.push({
      kind: 'index',
      name,
      table,
      sql: `CREATE ${uniqueKW}INDEX IF NOT EXISTS ${d.quoteIdent(name)} ON ${d.quoteIdent(table)} (${payload})${whereClause}`,
      dropSql: `DROP INDEX IF EXISTS ${d.quoteIdent(name)}`,
    });
  }
  return out;
}
