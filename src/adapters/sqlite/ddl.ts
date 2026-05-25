import type { FieldDef, IndexDef, ModelDef, RelationDef } from '../../schema/types';
import type { SchemaMap } from '../../schema';
import { SqliteDialect } from './dialect';
import type { DDLStatement } from '../postgres/ddl';

// SQLite DDL — same shape as Postgres but adjusted for SQLite quirks:
//   • No CHECK on enum CREATE TABLE clauses can use IN — same as PG.
//   • Foreign keys are emitted inside CREATE TABLE (not via ALTER TABLE,
//     which SQLite doesn't fully support for FKs). They take effect only if
//     `PRAGMA foreign_keys = ON` was set — the adapter does this at connect.
//   • No `ALTER TABLE … ADD CONSTRAINT UNIQUE` — emit `CREATE UNIQUE INDEX`
//     instead.
//   • Boolean defaults: 0 / 1, not TRUE / FALSE.
//   • Timestamp default: `CURRENT_TIMESTAMP` (no `now()`).

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

  // SQLite emits FKs inline in CREATE TABLE, so we build the whole table
  // statement up-front including FKs.
  for (const key of Object.keys(schema)) {
    const m = (schema as any)[key] as ModelDef<any>;
    if (!m || m.view) continue;
    out.push(buildCreateTable(m, schema));
  }

  // Per-field uniques + composite uniques become CREATE UNIQUE INDEX
  // (SQLite doesn't have an ALTER TABLE … ADD CONSTRAINT UNIQUE form).
  for (const key of Object.keys(schema)) {
    const m = (schema as any)[key] as ModelDef<any>;
    if (!m || m.view) continue;
    out.push(...buildUniques(m));
    out.push(...buildIndexes(m));
    out.push(...buildFtsTables(m));
  }

  // Wave 4c — views. SQLite supports CREATE VIEW; updates / inserts /
  // deletes against views are blocked at the wrapper layer.
  for (const key of Object.keys(schema)) {
    const m = (schema as any)[key] as ModelDef<any>;
    if (!m?.view?.sql) continue;
    out.push({
      kind: 'table',
      name: m.collection,
      table: m.collection,
      sql: `CREATE VIEW IF NOT EXISTS ${d.quoteIdent(m.collection)} AS ${m.view.sql}`,
      dropSql: `DROP VIEW IF EXISTS ${d.quoteIdent(m.collection)}`,
    });
  }

  return out;
}

// Wave 4b — auto-emit FTS5 virtual table for models with `.searchable()`
// fields. SQLite's full-text search lives in a separate `<table>_fts` virtual
// table; users query it via $queryRaw. We don't auto-wire reads through the
// FTS table (would require route-rewriting in the executor); `$queryRaw` is
// the supported query path until that lands.
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

  // 1. The FTS5 virtual table (external-content shadow of the base table).
  out.push({
    kind: 'index', name: tname, table: m.collection,
    sql: `CREATE VIRTUAL TABLE IF NOT EXISTS ${ftsQ} USING fts5(${colsQ}, content=${baseQ}, content_rowid='rowid')`,
    dropSql: `DROP TABLE IF EXISTS ${ftsQ}`,
  });

  // 2. Triggers to keep the FTS table in sync with INSERT/DELETE/UPDATE on
  // the base table. Without these the virtual table starts empty even when
  // the base has data — every base mutation must mirror into the FTS index.
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
  for (const [name, fdef] of Object.entries(m.fields)) {
    const field = fdef as FieldDef;
    cols.push(renderColumn(name, field));
    if (field.kind === 'id') pkField = name;
  }
  if (pkField) cols.push(`PRIMARY KEY (${d.quoteIdent(pkField)})`);

  // Enum CHECKs inline
  for (const [name, fdef] of Object.entries(m.fields)) {
    const field = fdef as FieldDef;
    if (field.kind === 'enum' && field.enumValues?.length) {
      const vals = field.enumValues.map(escapeSqlString).join(', ');
      cols.push(`CHECK (${d.quoteIdent(name)} IN (${vals}))`);
    }
  }

  // FKs inline
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
  // Per-field
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
  // Composite
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
    const cols = Object.keys(idx.keys);
    const name = idx.name ?? tableConstraintName(table, 'idx', cols);
    const colExpr = cols.map((c) => {
      const dir = (idx as IndexDef).keys[c];
      if (dir === 'text') return `${d.quoteIdent(c)}`;
      return `${d.quoteIdent(c)} ${dir === -1 ? 'DESC' : 'ASC'}`;
    }).join(', ');
    const uniqueKW = idx.unique ? 'UNIQUE ' : '';
    out.push({
      kind: 'index', name, table,
      sql: `CREATE ${uniqueKW}INDEX IF NOT EXISTS ${d.quoteIdent(name)} ON ${d.quoteIdent(table)} (${colExpr})`,
      dropSql: `DROP INDEX IF EXISTS ${d.quoteIdent(name)}`,
    });
  }
  return out;
}
