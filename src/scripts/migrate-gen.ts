import type { DbIntrospection } from '../adapters/types';
import type { Dialect } from '../adapters/postgres/dialect';
import type { FieldDef, ModelDef, RelationDef } from '../schema/types';
import { PostgresDialect } from '../adapters/postgres/dialect';
import { MysqlDialect } from '../adapters/mysql/dialect';
import { SqliteDialect } from '../adapters/sqlite/dialect';

// Wave 5c — reconciliation migration generator.
//
// Compares the declared forge schema to a live DbIntrospection snapshot and
// emits the SQL to bring the DB *up to* the schema (forward / `up`) plus the
// inverse (`down`). Covers the common evolution cases: new tables, new columns,
// new indexes, new foreign keys (and dropping DB objects the schema removed).
//
// Mongo is index-managed via forge:push, not SQL migrations, so this is SQL-only.

export interface MigrationPair { up: string; down: string; note: string; }

function dialectFor(kind: string): Dialect | null {
  if (kind === 'postgres') return PostgresDialect;
  if (kind === 'mysql') return MysqlDialect;
  if (kind === 'sqlite') return SqliteDialect;
  return null;
}

function colDef(d: Dialect, name: string, f: FieldDef): string {
  const type = d.columnType(f);
  // Added columns are nullable unless they carry a DB default — adding a
  // NOT NULL column to a populated table without a default would fail.
  const notNull = !f.optional && (f.default || f.uuidDefault) ? ' NOT NULL' : '';
  let def = '';
  if (f.uuidDefault && f.kind === 'uuid') def = d.name === 'mysql' ? ' DEFAULT (UUID())' : ' DEFAULT gen_random_uuid()';
  return `${d.quoteIdent(name)} ${type}${notNull}${def}`;
}

function idxName(table: string, unique: boolean, cols: string[]): string {
  return `forge_${table}_${unique ? 'uq' : 'idx'}_${cols.join('_')}`;
}

export function generateMigration(
  schema: Record<string, any>,
  actual: DbIntrospection,
): MigrationPair[] {
  const d = dialectFor(actual.kind);
  if (!d) return [];
  const pairs: MigrationPair[] = [];
  const actualTables = new Map(actual.tables.map((t) => [t.name, t]));
  const actualNames = new Set([...actualTables.keys(), ...actual.views.map((v) => v.name)]);

  for (const key of Object.keys(schema)) {
    const m = schema[key] as ModelDef<any> | undefined;
    if (!m || m.view) continue;
    const q = d.quoteIdent(m.collection);
    const act = actualTables.get(m.collection);

    // Whole table missing → defer to buildSchemaDDL for the full create.
    if (!act) {
      pairs.push({
        up: `-- create table '${m.collection}' via forge:push (full DDL)`,
        down: `DROP TABLE IF EXISTS ${q}`,
        note: `create table ${m.collection}`,
      });
      continue;
    }

    const actCols = new Set(act.columns.map((c) => c.name));
    // Missing columns → ADD COLUMN.
    for (const [name, fdef] of Object.entries(m.fields)) {
      const f = fdef as FieldDef;
      if (f.kind === 'id') continue;          // pk handled at table create
      if (f.dbGenerated) continue;            // generated cols only at create time
      if (actCols.has(name)) continue;
      pairs.push({
        up: `ALTER TABLE ${q} ADD COLUMN ${colDef(d, name, f)}`,
        down: `ALTER TABLE ${q} DROP COLUMN ${d.quoteIdent(name)}`,
        note: `add ${m.collection}.${name}`,
      });
    }
    // Extra columns the schema dropped → DROP COLUMN (down can't restore type).
    const schemaCols = new Set(Object.keys(m.fields));
    for (const c of act.columns) {
      if (schemaCols.has(c.name)) continue;
      pairs.push({
        up: `ALTER TABLE ${q} DROP COLUMN ${d.quoteIdent(c.name)}`,
        down: `ALTER TABLE ${q} ADD COLUMN ${d.quoteIdent(c.name)} ${c.type}`,
        note: `drop ${m.collection}.${c.name}`,
      });
    }

    // Missing indexes (unique + composite + @@index), by column-set+uniqueness.
    const actSigs = new Set(act.indexes.map((ix) => `${ix.unique ? 'u' : 'n'}:${[...ix.columns].sort().join(',')}`));
    const wantIdx: { unique: boolean; cols: string[] }[] = [];
    for (const [name, fdef] of Object.entries(m.fields)) {
      const f = fdef as FieldDef;
      if (f.unique && f.kind !== 'id') wantIdx.push({ unique: true, cols: [name] });
    }
    for (const cols of m.uniques ?? []) wantIdx.push({ unique: true, cols });
    for (const idx of m.indexes ?? []) wantIdx.push({ unique: idx.unique === true, cols: Object.keys(idx.keys) });
    for (const w of wantIdx) {
      const sig = `${w.unique ? 'u' : 'n'}:${[...w.cols].sort().join(',')}`;
      if (actSigs.has(sig)) continue;
      const name = idxName(m.collection, w.unique, w.cols);
      const colList = w.cols.map(d.quoteIdent).join(', ');
      const onMysql = d.name === 'mysql';
      pairs.push({
        up: `CREATE ${w.unique ? 'UNIQUE ' : ''}INDEX ${d.quoteIdent(name)} ON ${q} (${colList})`,
        down: onMysql ? `DROP INDEX ${d.quoteIdent(name)} ON ${q}` : `DROP INDEX IF EXISTS ${d.quoteIdent(name)}`,
        note: `add index ${name}`,
      });
    }

    // Missing foreign keys (SQLite can't ALTER ADD FK — skip with a note).
    const actFks = new Set(act.foreignKeys.map((f) => `${f.column}->${f.refTable}.${f.refColumn}`));
    for (const rel of Object.values(m.relations())) {
      const r = rel as RelationDef;
      if (r.inverse || !m.fields[r.on] || m.fields[r.on]?.kind === 'id') continue;
      const target = schema[r.target] as ModelDef<any> | undefined;
      if (!target) continue;
      const k = `${r.on}->${target.collection}.${r.refs}`;
      if (actFks.has(k)) continue;
      if (d.name === 'sqlite') {
        pairs.push({ up: `-- SQLite cannot ALTER ADD FOREIGN KEY (${k}); recreate the table to add it`, down: `-- (no-op)`, note: `fk ${k} (manual)` });
        continue;
      }
      const fkName = `forge_${m.collection}_fk_${r.on}`;
      pairs.push({
        up: `ALTER TABLE ${q} ADD CONSTRAINT ${d.quoteIdent(fkName)} FOREIGN KEY (${d.quoteIdent(r.on)}) REFERENCES ${d.quoteIdent(target.collection)} (${d.quoteIdent(r.refs)})`,
        down: d.name === 'mysql'
          ? `ALTER TABLE ${q} DROP FOREIGN KEY ${d.quoteIdent(fkName)}`
          : `ALTER TABLE ${q} DROP CONSTRAINT IF EXISTS ${d.quoteIdent(fkName)}`,
        note: `add fk ${fkName}`,
      });
    }
  }

  // Extra tables the schema dropped → DROP TABLE (down can't recreate them).
  const schemaCollections = new Set(
    Object.keys(schema).map((k) => (schema[k] as ModelDef<any>)?.collection).filter(Boolean),
  );
  for (const t of actual.tables) {
    if (schemaCollections.has(t.name)) continue;
    if (t.name === '_forge_migrations' || /_fts/i.test(t.name)) continue;
    pairs.push({
      up: `DROP TABLE IF EXISTS ${d.quoteIdent(t.name)}`,
      down: `-- cannot auto-restore dropped table '${t.name}'`,
      note: `drop table ${t.name}`,
    });
  }

  void actualNames;
  return pairs;
}
