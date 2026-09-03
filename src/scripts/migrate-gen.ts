import type { DbIntrospection } from '../adapters/types';
import type { Dialect } from '../adapters/postgres/dialect';
import { dialectFor } from './dialects';
import { diffColumn } from './alter-column';
import { planRenames } from './rename-column';
import { buildSchemaDDL as buildPgDDL } from '../adapters/postgres/ddl';
import { buildSchemaDDL as buildMysqlDDL } from '../adapters/mysql/ddl';
import { buildSchemaDDL as buildSqliteDDL } from '../adapters/sqlite/ddl';
import type { FieldDef, ModelDef, RelationDef } from '../schema/types';

// Reconciliation migration generator. Compares the declared schema to a
// DbIntrospection snapshot and emits SQL to bring the DB up to the schema
// (`up`) plus the inverse (`down`). Covers new tables, new columns, new
// indexes, new FKs, and drops for DB objects the schema removed.
//
// Mongo is index-managed via forge push, not SQL migrations — SQL-only here.

export interface MigrationPair {
  up: string;
  down: string;
  note: string;
 /** Present when the change must NOT be generated — a narrowing, a type
  *  conversion, or NULL → NOT NULL. `forge generate` refuses the whole
  *  run rather than write a file that quietly omits it. */
  unsafe?: { reason: string; guidance: string };
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

/** The full CREATE DDL for one model, in the right dialect. */
function buildDDLFor(
  kind: string,
  one: Record<string, unknown>,
): { kind: string; sql: string; name: string }[] {
  if (kind === 'postgres') return buildPgDDL(one as never);
  if (kind === 'mysql') return buildMysqlDDL(one as never);
  if (kind === 'sqlite') return buildSqliteDDL(one as never);
  return [];
}

export function generateMigration(
  schema: Record<string, any>,
  actual: DbIntrospection,
  opts: { allowDrop?: boolean } = {},
): MigrationPair[] {
  const d = dialectFor(actual.kind);
  const kind = actual.kind;
  if (!d) return [];
  const pairs: MigrationPair[] = [];
  const actualTables = new Map(actual.tables.map((t) => [t.name, t]));

  for (const key of Object.keys(schema)) {
    const m = schema[key] as ModelDef<any> | undefined;
    if (!m || m.view) continue;
    const q = d.quoteIdent(m.collection);
    const act = actualTables.get(m.collection);

    // Whole table missing → the real CREATE TABLE, plus its indexes and
    // constraints.
    //
    // This used to emit a COMMENT — `-- create table 'x' via forge:push`
    // — on the assumption that push would do the work. For a migration
    // generated against a live database that was survivable, because
    // push had usually just run. For one generated against a snapshot it
    // is not: the file is the only record, and a migration whose `up` is
    // a comment applies cleanly and creates nothing.
    if (!act) {
      const ddl = buildDDLFor(kind, { [key]: m } as Record<string, unknown>);
      for (const stmt of ddl) {
        pairs.push({
          up: stmt.sql,
          // Dropping the table takes its indexes and constraints with it,
          // so only the table statement needs a reverse.
          down: stmt.kind === 'table' ? `DROP TABLE IF EXISTS ${q}` : '-- (dropped with the table)',
          note: `${stmt.kind === 'table' ? 'create table' : `create ${stmt.kind}`} ${stmt.name}`,
        });
      }
      continue;
    }

    // Renames FIRST — before add, drop or alter.
    //
    // A rename that ran after the ADD would find the new column already
    // there; one that ran after the DROP would have nothing to rename.
    // Order is not cosmetic here.
    const rn = planRenames(d, m.collection, m.fields as Record<string, FieldDef>, act.columns, opts);
    for (const r of rn.renames) {
      pairs.push({ up: r.up, down: r.down, note: r.note });
    }
    for (const u of rn.unsafe) {
      pairs.push({
        up: `-- ${u.note} — refused, see below`,
        down: '-- (nothing to reverse)',
        note: u.note,
        unsafe: { reason: u.reason, guidance: u.guidance },
      });
    }

    // A renamed column is present under its NEW name from here on, so the
    // add / drop / alter passes below see the post-rename world. Without
    // this the same column is renamed and then added again.
    const renamedTo = new Map(rn.renames.map((r) => [r.to, r.from]));
    const actCols = new Set(
      act.columns.map((c) => c.name).filter((n) => !rn.consumed.has(n)),
    );
    for (const r of rn.renames) actCols.add(r.to);
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
    // Columns in both → has the TYPE or NULLABILITY changed?
    //
    // This was the gap: such a change was silently absent from the
    // migration. The schema said varchar(255), the database kept
    // varchar(64), the file applied cleanly, and nothing said a word.
    const actByName = new Map(act.columns.map((c) => [c.name, c]));
    for (const [name, fdef] of Object.entries(m.fields)) {
      const f = fdef as FieldDef;
      if (f.kind === 'id' || f.dbGenerated) continue;
      // A renamed column is still under its old name in `act` — look it
      // up there, so a rename PLUS a type change emits both statements.
      // Drizzle emits only the rename in that case
      // (drizzle-team/drizzle-orm#5499); here the ALTER follows it, or
      // the run is refused.
      const col = actByName.get(name) ?? actByName.get(renamedTo.get(name) ?? '');
      if (!col) continue;                    // handled by ADD above
      const change = diffColumn(d, m.collection, name, f, col);
      if (!change) continue;
      pairs.push({
        up: change.up ?? `-- ${change.note} — refused, see below`,
        down: change.down ?? '-- (nothing to reverse)',
        note: change.note,
        ...(change.unsafe ? { unsafe: change.unsafe } : {}),
      });
    }

    // Extra columns the schema dropped → DROP COLUMN (down can't restore type).
    const schemaCols = new Set(Object.keys(m.fields));
    for (const c of act.columns) {
      if (schemaCols.has(c.name)) continue;
      if (rn.consumed.has(c.name)) continue;   // renamed, not dropped
      pairs.push({
        up: `ALTER TABLE ${q} DROP COLUMN ${d.quoteIdent(c.name)}`,
        down: `ALTER TABLE ${q} ADD COLUMN ${d.quoteIdent(c.name)} ${c.type}`,
        note: `drop ${m.collection}.${c.name}`,
      });
    }

    // Missing indexes (unique + composite + @@index), by column-set+uniqueness.
    // Column-set diff doesn't catch method / where / include / expression
    // drift on EXISTING indexes — for that, drop & recreate via `forge:push`.
    // But when an index is genuinely missing from the DB, generate the FULL
    // 2.2+ SQL — method/where/include/expression — so the migration matches
    // the schema's intent and not a watered-down BTREE fallback.
    const actSigs = new Set(act.indexes.map((ix) => `${ix.unique ? 'u' : 'n'}:${[...ix.columns].sort().join(',')}`));
    type WantIdx = {
      unique: boolean;
      cols: string[];
      method?: string;
      where?: string;
      include?: string[];
      expression?: string;
      explicitName?: string;
    };
    const wantIdx: WantIdx[] = [];
    for (const [name, fdef] of Object.entries(m.fields)) {
      const f = fdef as FieldDef;
      if (f.unique && f.kind !== 'id') wantIdx.push({ unique: true, cols: [name] });
    }
    for (const cols of m.uniques ?? []) wantIdx.push({ unique: true, cols });
    for (const idx of m.indexes ?? []) {
      wantIdx.push({
        unique: idx.unique === true,
        cols: Object.keys(idx.keys),
        method: idx.method,
        where: typeof idx.where === 'string' ? idx.where : undefined,
        include: idx.include,
        expression: idx.expression,
        explicitName: idx.name,
      });
    }
    for (const w of wantIdx) {
      // Expression indexes have NO column list — they can't be compared by
      // the column-set sig (every expression index would otherwise look like
      // a duplicate of every other one). Skip the diff for them — `forge:push`
      // handles their lifecycle.
      if (w.expression) continue;
      const sig = `${w.unique ? 'u' : 'n'}:${[...w.cols].sort().join(',')}`;
      if (actSigs.has(sig)) continue;
      const name = w.explicitName ?? idxName(m.collection, w.unique, w.cols);
      const onMysql = d.name === 'mysql';

      // Build per-dialect SQL that mirrors what buildSchemaDDL produces.
      let sql: string;
      if (d.name === 'postgres') {
        const method = w.method && w.method !== 'btree' ? ` USING ${w.method}` : '';
        const colList = w.cols.map(d.quoteIdent).join(', ');
        const includeSql = w.include?.length
          ? ` INCLUDE (${w.include.map(d.quoteIdent).join(', ')})`
          : '';
        const whereSql = w.where ? ` WHERE ${w.where}` : '';
        sql = `CREATE ${w.unique ? 'UNIQUE ' : ''}INDEX IF NOT EXISTS ${d.quoteIdent(name)} ON ${q}${method} (${colList})${includeSql}${whereSql}`;
      } else if (d.name === 'mysql') {
        // MySQL spatial / fulltext are STATEMENT-prefix keywords, not USING.
        let kindKW = '';
        if (w.method === 'spatial') kindKW = 'SPATIAL ';
        else if (w.method === 'fulltext') kindKW = 'FULLTEXT ';
        else if (w.unique) kindKW = 'UNIQUE ';
        const colList = w.cols.map(d.quoteIdent).join(', ');
        sql = `CREATE ${kindKW}INDEX ${d.quoteIdent(name)} ON ${q} (${colList})`;
      } else {
        // SQLite supports WHERE natively.
        const colList = w.cols.map(d.quoteIdent).join(', ');
        const whereSql = w.where ? ` WHERE ${w.where}` : '';
        sql = `CREATE ${w.unique ? 'UNIQUE ' : ''}INDEX IF NOT EXISTS ${d.quoteIdent(name)} ON ${q} (${colList})${whereSql}`;
      }

      pairs.push({
        up: sql,
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

  return pairs;
}
