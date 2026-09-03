// Schema snapshots — generating a migration without a live database.
//
// Until 2.9.0, `forge diff apply` produced a migration by connecting to
// DATABASE_URL, introspecting the live database, and diffing the schema
// against whatever was there. That works, and for adopting an existing
// database it is the only thing that does. But it means:
//
//   * CI cannot generate or verify a migration — there is no database
//   * two developers on two branches each generate against their own
//     local database, so each migration is correct only relative to a
//     world that no longer exists after the merge
//   * the same schema does not reliably produce the same SQL
//
// A snapshot is simply **what `introspect()` would return if this schema
// were applied**. Writing one beside each migration lets the next
// migration diff against the last committed state instead of against a
// database. Nothing else in the pipeline changes: `diffIntrospection`
// already takes a `DbIntrospection` as its "actual" side, and it cannot
// tell where that came from.
//
// That is the whole trick, and it is why this file is short.
//
// The snapshot is a projection, not a recording. It says what the schema
// describes, not what any database contains — so it cannot capture a
// column someone added by hand. `forge diff` against a live database
// remains the tool for that, and is still the honest answer to "is
// production actually what we think it is".

import fs from 'node:fs';
import path from 'node:path';
import type {
  AdapterKind,
  DbIntrospection,
  IntrospectedColumn,
  IntrospectedForeignKey,
  IntrospectedIndex,
  IntrospectedTable,
} from '../adapters/types';
import type { FieldDef, IndexDef, ModelDef, RelationDef } from '../schema/types';
import { dialectFor } from './dialects';

export const META_DIR = 'meta';
export const JOURNAL_FILE = '_journal.json';

/** One generated migration, in the order it must be applied. */
export interface JournalEntry {
  /** Zero-padded sequence, e.g. `0003`. Also the snapshot's filename. */
  idx: string;
  /** The `.sql` file this entry describes. */
  file: string;
  /** When it was generated. Informational — ordering is by `idx`. */
  createdAt: string;
  /** What the author called it. */
  label?: string;
}

export interface Journal {
  /** Bumped if the snapshot format ever changes shape. */
  version: 1;
  dialect: AdapterKind;
  entries: JournalEntry[];
}

// ─── projecting a schema into introspection shape ────────────────────

/** Mongo stores the primary key as `_id`; every SQL dialect uses the
 *  declared name. Same rule the Mongo push applies to index keys. */
function columnName(name: string, kind: AdapterKind): string {
  return kind === 'mongo' && name === 'id' ? '_id' : name;
}

function projectColumn(
  name: string,
  field: FieldDef,
  kind: AdapterKind,
): IntrospectedColumn {
  const d = dialectFor(kind);
  return {
    name: columnName(name, kind),
    // Mongo is schemaless — introspection reports no column types, so a
    // snapshot must not invent any or every diff would show drift.
    type: kind === 'mongo' ? '' : (d?.columnType(field) ?? '').toLowerCase(),
    nullable: field.optional === true,
    ...(field.default !== undefined && typeof field.default !== 'object'
      ? { default: String(field.default) }
      : {}),
  };
}

function projectIndexes(
  model: ModelDef<any>,
  kind: AdapterKind,
): IntrospectedIndex[] {
  const out: IntrospectedIndex[] = [];

  for (const [fname, fdef] of Object.entries(model.fields) as [string, FieldDef][]) {
    if (!fdef.unique || fdef.kind === 'id') continue;
    out.push({ name: `uq_${model.collection}_${fname}`, columns: [fname], unique: true });
  }
  for (const cu of model.uniques ?? []) {
    out.push({
      name: `uq_${model.collection}_${cu.join('_')}`,
      columns: cu.map((c) => columnName(c, kind)),
      unique: true,
    });
  }
  for (const idx of (model.indexes ?? []) as IndexDef[]) {
    const columns = Object.keys(idx.keys ?? {}).map((c) => columnName(c, kind));
    out.push({
      name: idx.name ?? `idx_${model.collection}_${columns.join('_')}`,
      columns,
      unique: idx.unique === true,
      ...(idx.method ? { method: idx.method } : {}),
      ...(typeof idx.where === 'string' ? { where: idx.where } : {}),
      ...(idx.include ? { include: idx.include } : {}),
      ...(idx.expression ? { expression: idx.expression } : {}),
      ...(idx.partialFilterExpression
        ? { partialFilterExpression: idx.partialFilterExpression }
        : {}),
      ...(idx.collation ? { collation: idx.collation as Record<string, unknown> } : {}),
      ...(idx.wildcardProjection ? { wildcardProjection: idx.wildcardProjection } : {}),
      ...(kind === 'mongo' ? { keySpec: idx.keys as Record<string, unknown> } : {}),
    });
  }
  return out;
}

function projectForeignKeys(
  model: ModelDef<any>,
  schema: Record<string, ModelDef<any>>,
  kind: AdapterKind,
): IntrospectedForeignKey[] {
  // Mongo has no foreign keys. Emitting them would make every snapshot
  // disagree with every introspection.
  if (kind === 'mongo') return [];
  const out: IntrospectedForeignKey[] = [];
  const rels = typeof model.relations === 'function' ? model.relations() : {};
  for (const r of Object.values(rels) as RelationDef[]) {
    const target = schema[(r as { model?: string }).model ?? ''];
    if (!r.on || !r.refs || !target) continue;
    out.push({
      name: `fk_${model.collection}_${r.on}`,
      column: r.on,
      refTable: target.collection,
      refColumn: r.refs,
    });
  }
  return out;
}

/**
 * What `introspect()` would return if this schema were applied to an
 * empty database of `kind`.
 *
 * This is the snapshot. It is deliberately built from the same schema
 * objects the diff already reads, so a field the diff ignores is a field
 * the snapshot ignores, and the two cannot drift apart.
 */
export function projectSchema(
  schema: Record<string, unknown>,
  kind: AdapterKind,
): DbIntrospection {
  const models = schema as Record<string, ModelDef<any>>;
  const tables: IntrospectedTable[] = [];
  const views: DbIntrospection['views'] = [];

  for (const model of Object.values(models)) {
    if (!model?.collection || !model.fields) continue;
    if (model.view) {
      views.push({
        name: model.collection,
        ...(model.view.materialised ? { materialised: true } : {}),
      });
      continue;
    }
    tables.push({
      name: model.collection,
      columns: Object.entries(model.fields).map(([n, f]) =>
        projectColumn(n, f as FieldDef, kind),
      ),
      indexes: projectIndexes(model, kind),
      foreignKeys: projectForeignKeys(model, models, kind),
    });
  }

  // Stable order, so a snapshot's diff in review is the schema change and
  // nothing else. Without this, reordering two models in the schema file
  // rewrites the whole snapshot.
  tables.sort((a, b) => a.name.localeCompare(b.name));
  for (const t of tables) {
    t.columns.sort((a, b) => a.name.localeCompare(b.name));
    t.indexes.sort((a, b) => a.name.localeCompare(b.name));
    t.foreignKeys.sort((a, b) => a.name.localeCompare(b.name));
  }
  views.sort((a, b) => a.name.localeCompare(b.name));

  return { kind, tables, views };
}

// ─── reading and writing the folder ──────────────────────────────────

function metaDir(migrationsDir: string): string {
  return path.join(migrationsDir, META_DIR);
}

export function readJournal(migrationsDir: string): Journal | null {
  const file = path.join(metaDir(migrationsDir), JOURNAL_FILE);
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8')) as Journal;
}

export function writeJournal(migrationsDir: string, journal: Journal): void {
  fs.mkdirSync(metaDir(migrationsDir), { recursive: true });
  fs.writeFileSync(
    path.join(metaDir(migrationsDir), JOURNAL_FILE),
    `${JSON.stringify(journal, null, 2)}\n`,
    'utf8',
  );
}

export function snapshotPath(migrationsDir: string, idx: string): string {
  return path.join(metaDir(migrationsDir), `${idx}_snapshot.json`);
}

export function readSnapshot(migrationsDir: string, idx: string): DbIntrospection | null {
  const file = snapshotPath(migrationsDir, idx);
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8')) as DbIntrospection;
}

export function writeSnapshot(
  migrationsDir: string,
  idx: string,
  snap: DbIntrospection,
): void {
  fs.mkdirSync(metaDir(migrationsDir), { recursive: true });
  fs.writeFileSync(snapshotPath(migrationsDir, idx), `${JSON.stringify(snap, null, 2)}\n`, 'utf8');
}

/**
 * The state the next migration is generated against.
 *
 * An empty folder yields an EMPTY database rather than null, so the first
 * generate produces a create-everything migration instead of a special
 * case.
 */
export function latestSnapshot(
  migrationsDir: string,
  kind: AdapterKind,
): { snapshot: DbIntrospection; nextIdx: string; journal: Journal } {
  const journal = readJournal(migrationsDir) ?? { version: 1 as const, dialect: kind, entries: [] };
  if (journal.dialect !== kind) {
    throw new Error(
      `[forge] this migrations folder was generated for '${journal.dialect}', ` +
        `but DATABASE_URL points at '${kind}'. A snapshot describes one dialect — ` +
        `column types and index shapes differ. Use a separate folder per dialect.`,
    );
  }
  const last = journal.entries[journal.entries.length - 1];
  const snapshot = last
    ? (readSnapshot(migrationsDir, last.idx) ?? { kind, tables: [], views: [] })
    : { kind, tables: [], views: [] };
  const nextIdx = String(journal.entries.length + 1).padStart(4, '0');
  return { snapshot, nextIdx, journal };
}
