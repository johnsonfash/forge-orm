import type {
  DbIntrospection,
  IntrospectedColumn,
  IntrospectedForeignKey,
  IntrospectedIndex,
  IntrospectedTable,
} from '../types';
import type { PgPoolHandle } from './execute';

// Wave 5b — live-schema introspection for Postgres.
//
// Reads information_schema + pg_catalog to build a normalized snapshot the
// drift comparator (src/scripts/diff.ts) compares against the forge schema.
// Scoped to the `public` schema (where forge:push creates objects).

export async function introspectPg(pool: PgPoolHandle): Promise<DbIntrospection> {
  // Columns (also enumerates which relations are base tables).
  const cols = await pool.query(
    `SELECT table_name, column_name, data_type, udt_name, is_nullable,
            column_default, numeric_precision, numeric_scale, character_maximum_length
       FROM information_schema.columns
      WHERE table_schema = 'public'
      ORDER BY table_name, ordinal_position`,
  );

  const baseTables = await pool.query(
    `SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`,
  );
  const baseSet = new Set<string>(baseTables.rows.map((r: any) => r.table_name));

  const idx = await pool.query(
    `SELECT t.relname AS table_name, i.relname AS index_name,
            ix.indisunique AS is_unique, a.attname AS column_name,
            array_position(ix.indkey, a.attnum) AS ord
       FROM pg_index ix
       JOIN pg_class i  ON i.oid = ix.indexrelid
       JOIN pg_class t  ON t.oid = ix.indrelid
       JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = ANY(ix.indkey)
       JOIN pg_namespace n ON n.oid = t.relnamespace
      WHERE n.nspname = 'public'
      ORDER BY t.relname, i.relname, ord`,
  );

  const fks = await pool.query(
    `SELECT con.conname AS name, t.relname AS table_name,
            att.attname AS column_name, ft.relname AS ref_table,
            fatt.attname AS ref_column
       FROM pg_constraint con
       JOIN pg_class t   ON t.oid = con.conrelid
       JOIN pg_class ft  ON ft.oid = con.confrelid
       JOIN pg_namespace n ON n.oid = t.relnamespace
       JOIN pg_attribute att  ON att.attrelid = con.conrelid  AND att.attnum  = con.conkey[1]
       JOIN pg_attribute fatt ON fatt.attrelid = con.confrelid AND fatt.attnum = con.confkey[1]
      WHERE con.contype = 'f' AND n.nspname = 'public'`,
  );

  const views = await pool.query(
    `SELECT table_name AS name FROM information_schema.views WHERE table_schema = 'public'`,
  );
  const matviews = await pool.query(
    `SELECT matviewname AS name FROM pg_matviews WHERE schemaname = 'public'`,
  );

  // ── Assemble per-table ──────────────────────────────────────────────────
  const tableMap = new Map<string, IntrospectedTable>();
  const ensure = (name: string): IntrospectedTable => {
    let t = tableMap.get(name);
    if (!t) { t = { name, columns: [], indexes: [], foreignKeys: [] }; tableMap.set(name, t); }
    return t;
  };

  for (const r of cols.rows as any[]) {
    if (!baseSet.has(r.table_name)) continue;  // skip view columns
    ensure(r.table_name).columns.push(normalizeColumn(r));
  }

  const idxAcc = new Map<string, IntrospectedIndex>();
  for (const r of idx.rows as any[]) {
    if (!baseSet.has(r.table_name)) continue;
    const k = `${r.table_name}::${r.index_name}`;
    let i = idxAcc.get(k);
    if (!i) { i = { name: r.index_name, columns: [], unique: r.is_unique }; idxAcc.set(k, i); ensure(r.table_name).indexes.push(i); }
    i.columns.push(r.column_name);
  }

  for (const r of fks.rows as any[]) {
    if (!baseSet.has(r.table_name)) continue;
    ensure(r.table_name).foreignKeys.push({
      name: r.name, column: r.column_name, refTable: r.ref_table, refColumn: r.ref_column,
    } as IntrospectedForeignKey);
  }

  return {
    kind: 'postgres',
    tables: [...tableMap.values()],
    views: [
      ...views.rows.map((r: any) => ({ name: r.name, materialised: false })),
      ...matviews.rows.map((r: any) => ({ name: r.name, materialised: true })),
    ],
  };
}

function normalizeColumn(r: any): IntrospectedColumn {
  let type = String(r.data_type).toLowerCase();
  if (type === 'numeric' && r.numeric_precision != null) {
    type = `numeric(${r.numeric_precision}${r.numeric_scale != null ? `,${r.numeric_scale}` : ''})`;
  } else if (type === 'character varying' && r.character_maximum_length != null) {
    type = `varchar(${r.character_maximum_length})`;
  } else if (type === 'ARRAY'.toLowerCase()) {
    // udt_name is like `_text` / `_int4` for arrays.
    type = String(r.udt_name).replace(/^_/, '') + '[]';
  }
  return {
    name: r.column_name,
    type,
    nullable: r.is_nullable === 'YES',
    default: r.column_default ?? undefined,
  };
}
