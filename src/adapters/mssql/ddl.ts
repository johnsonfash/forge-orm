// SQL Server DDL — delegates to the Postgres DDL generator with MssqlDialect
// injected, then rewrites the PG-specific tail into T-SQL:
//
//   * IF NOT EXISTS on CREATE TABLE: wrap each CREATE TABLE in `IF NOT
//     EXISTS (SELECT * FROM sys.objects WHERE name = '…' AND type = 'U')
//     BEGIN … END`. T-SQL doesn't accept `IF NOT EXISTS` inline.
//   * CREATE INDEX IF NOT EXISTS: same wrapper, but on sys.indexes.
//   * The PG ddl generates DROP TABLE … CASCADE — T-SQL doesn't have CASCADE
//     at DROP TABLE time. Strip the CASCADE keyword.
//   * Array column types — PG emits `text[]` / `integer[]`; T-SQL stores
//     these as NVARCHAR(MAX). The dialect already maps types, so this is
//     handled at type emission.

import type { SchemaMap } from '../../schema';
import { buildSchemaDDL as pgBuildSchemaDDL, type DDLStatement, type BuildDDLOptions } from '../postgres/ddl';
import { MssqlDialect } from './dialect';

export type { DDLStatement };

export function buildSchemaDDL(
  schema: SchemaMap,
  opts: BuildDDLOptions = {},
): DDLStatement[] {
  const stmts = pgBuildSchemaDDL(schema, { ...opts, dialect: opts.dialect ?? MssqlDialect });
  return stmts.map((s) => ({ ...s, sql: rewriteForTSql(s) }));
}

function rewriteForTSql(stmt: DDLStatement): string {
  let sql = stmt.sql;
  if (stmt.kind === 'table') {
    // Wrap CREATE TABLE IF NOT EXISTS in an IF (NOT EXISTS …) BEGIN … END block.
    const m = sql.match(/^CREATE TABLE IF NOT EXISTS\s+\[([^\]]+)\]\s+\(([\s\S]*)\)\s*$/m);
    if (m) {
      const tableName = m[1];
      const body = m[2];
      sql =
        `IF NOT EXISTS (SELECT 1 FROM sys.tables WHERE name = '${tableName.replace(/'/g, "''")}') ` +
        `BEGIN ` +
        `CREATE TABLE [${tableName}] (${body}) ` +
        `END`;
    }
    // CASCADE isn't valid at DROP TABLE — strip if present.
    sql = sql.replace(/\s+CASCADE\b/gi, '');
  } else if (stmt.kind === 'index') {
    // Step 1 — convert PG's `USING gist` (emitted when method='spatial') into
    // T-SQL's CREATE SPATIAL INDEX statement-prefix. Other USING <method>
    // clauses just get stripped (T-SQL has no access methods).
    const hasGist = /\sUSING\s+gist\b/i.test(sql);
    const hasHnsw = /\sUSING\s+hnsw\b/i.test(sql);
    if (hasGist) {
      sql = sql
        .replace(/CREATE\s+(UNIQUE\s+)?INDEX\b/i, 'CREATE SPATIAL INDEX')
        .replace(/\sUSING\s+gist\b/i, '');
    } else if (hasHnsw) {
      // SQL Server 2025 vector index syntax (preview).
      sql = sql
        .replace(/\s+vector_(?:cosine|l2|ip)_ops/g, '')
        .replace(/\sUSING\s+hnsw\b/i, " USING VECTOR WITH (algorithm = 'HNSW')");
    } else {
      sql = sql.replace(/\s+USING\s+\w+/i, '');
    }
    // Step 2 — wrap in IF NOT EXISTS (sys.indexes …) BEGIN … END.
    const m = sql.match(/^CREATE\s+(SPATIAL\s+|UNIQUE\s+)?INDEX IF NOT EXISTS\s+\[([^\]]+)\]\s+ON\s+\[([^\]]+)\](.+)$/i);
    if (m) {
      const prefix = m[1] ?? '';
      const idxName = m[2];
      const tbl = m[3];
      const tail = m[4];
      sql =
        `IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = '${idxName.replace(/'/g, "''")}' AND object_id = OBJECT_ID('${tbl.replace(/'/g, "''")}')) ` +
        `BEGIN ` +
        `CREATE ${prefix}INDEX [${idxName}] ON [${tbl}]${tail} ` +
        `END`;
    }
  } else if (stmt.kind === 'unique') {
    // ADD CONSTRAINT … UNIQUE — T-SQL accepts as-is. No rewrite needed.
  } else if (stmt.kind === 'foreignKey') {
    // ON DELETE NO ACTION → T-SQL accepts; ON DELETE SET NULL needs the column
    // to be nullable. PG syntax is portable; leave as-is.
  }
  return sql;
}
