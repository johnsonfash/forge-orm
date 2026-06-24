import type {
  DbIntrospection,
  IntrospectedIndex,
  IntrospectedTable,
} from '../types';
import type { MysqlPool } from './execute';

// Live-schema introspection via INFORMATION_SCHEMA, scoped to DATABASE().

export async function introspectMysql(pool: MysqlPool): Promise<DbIntrospection> {
  const [tables] = await pool.query(
    `SELECT TABLE_NAME AS name, TABLE_TYPE AS type
       FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE()`,
  ) as any;
  const [cols] = await pool.query(
    `SELECT TABLE_NAME AS t, COLUMN_NAME AS name, COLUMN_TYPE AS type,
            IS_NULLABLE AS nullable, COLUMN_DEFAULT AS dflt
       FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE()
      ORDER BY TABLE_NAME, ORDINAL_POSITION`,
  ) as any;
  // INDEX_TYPE: 'BTREE' | 'FULLTEXT' | 'SPATIAL' | 'HASH'. EXPRESSION exists
  // on MySQL 8.0+ (functional indexes); older servers raise an Unknown column
  // error which we swallow per-row by selecting both with conditional SQL.
  let idxRows: any[];
  try {
    const [r] = await pool.query(
      `SELECT TABLE_NAME AS t, INDEX_NAME AS name, NON_UNIQUE AS nonUnique,
              COLUMN_NAME AS col, SEQ_IN_INDEX AS seq,
              INDEX_TYPE AS indexType, EXPRESSION AS expr
         FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE()
        ORDER BY TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX`,
    ) as any;
    idxRows = r;
  } catch {
    // Pre-8.0: no EXPRESSION column. Drop it from the projection.
    const [r] = await pool.query(
      `SELECT TABLE_NAME AS t, INDEX_NAME AS name, NON_UNIQUE AS nonUnique,
              COLUMN_NAME AS col, SEQ_IN_INDEX AS seq,
              INDEX_TYPE AS indexType, NULL AS expr
         FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE()
        ORDER BY TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX`,
    ) as any;
    idxRows = r;
  }
  const [fks] = await pool.query(
    `SELECT CONSTRAINT_NAME AS name, TABLE_NAME AS t, COLUMN_NAME AS col,
            REFERENCED_TABLE_NAME AS refTable, REFERENCED_COLUMN_NAME AS refColumn
       FROM information_schema.KEY_COLUMN_USAGE
      WHERE TABLE_SCHEMA = DATABASE() AND REFERENCED_TABLE_NAME IS NOT NULL`,
  ) as any;

  const baseTables = new Set<string>(
    (tables as any[]).filter((r) => r.type === 'BASE TABLE').map((r) => r.name),
  );
  const tableMap = new Map<string, IntrospectedTable>();
  const ensure = (name: string): IntrospectedTable => {
    let t = tableMap.get(name);
    if (!t) { t = { name, columns: [], indexes: [], foreignKeys: [] }; tableMap.set(name, t); }
    return t;
  };

  for (const r of cols as any[]) {
    if (!baseTables.has(r.t)) continue;
    ensure(r.t).columns.push({
      name: r.name,
      type: String(r.type).toLowerCase(),
      nullable: r.nullable === 'YES',
      default: r.dflt ?? undefined,
    });
  }

  const idxAcc = new Map<string, IntrospectedIndex>();
  for (const r of idxRows as any[]) {
    if (!baseTables.has(r.t)) continue;
    const k = `${r.t}::${r.name}`;
    let i = idxAcc.get(k);
    if (!i) {
      // INDEX_TYPE maps to our `method` field, lower-cased. FULLTEXT and
      // SPATIAL are statement-prefix keywords on MySQL — schema declares
      // them as method: 'fulltext' / 'spatial', so the comparison aligns.
      const it = String(r.indexType ?? 'btree').toLowerCase();
      i = {
        name: r.name,
        columns: [],
        unique: Number(r.nonUnique) === 0,
        method: it !== 'btree' ? it : undefined,
      };
      idxAcc.set(k, i);
      ensure(r.t).indexes.push(i);
    }
    // EXPRESSION non-null on MySQL 8 functional indexes — the COLUMN_NAME
    // is NULL when the entry is an expression, so we capture the expression
    // text and skip pushing a phantom column.
    if (r.expr != null) {
      i.expression = String(r.expr);
    } else if (r.col != null) {
      i.columns.push(r.col);
    }
  }

  for (const r of fks as any[]) {
    if (!baseTables.has(r.t)) continue;
    ensure(r.t).foreignKeys.push({ name: r.name, column: r.col, refTable: r.refTable, refColumn: r.refColumn });
  }

  return {
    kind: 'mysql',
    tables: [...tableMap.values()],
    views: (tables as any[]).filter((r) => r.type === 'VIEW').map((r) => ({ name: r.name, materialised: false })),
  };
}
