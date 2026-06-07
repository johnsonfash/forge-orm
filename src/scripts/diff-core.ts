import type {
  AdapterKind,
  DbIntrospection,
  IntrospectedTable,
} from '../adapters/types';
import type { FieldDef, ModelDef, RelationDef } from '../schema/types';

// Wave 5b — pure (no-IO) drift comparator.
//
// `expectedFromSchema` derives what forge:push WOULD create from the schema.
// `diffIntrospection` compares it to a live DbIntrospection snapshot and
// reports structural drift: missing/extra tables, columns, indexes, FKs, views.
//
// Type/default comparison is deliberately coarse (mapped to categories) and
// skipped on SQLite (dynamic typing) so the report never cries wolf.

export interface DriftItem {
  kind: 'table' | 'column' | 'index' | 'foreignKey' | 'view' | 'columnType';
  direction: 'missing' | 'extra' | 'mismatch';
  table: string;
  detail: string;
}

export interface DriftReport {
  dialect: AdapterKind;
  items: DriftItem[];
  inSync: boolean;
  /** Tables/collections that matched an ignore pattern. Surfaced so the
   *  caller (CLI / CI) can show "skipped 2 tables — they matched your
   *  ignore list" without those ever appearing as drift. */
  ignored?: string[];
}

/**
 * Patterns for tables/collections the report should ignore entirely —
 * useful for engine-managed collections (Atlas metadata, PostgREST
 * shadows), cross-service collections that aren't declared in your
 * schema, or anything else that would otherwise look like permanent
 * drift.
 *
 * Strings match the table name exactly. RegExp matches the table name
 * via `.test()`. A pattern that's only a substring should be written
 * as a regex (`/system\./i`) so it can't accidentally match unrelated
 * collection names.
 *
 * Pre-baked ignores stay in place regardless: `_forge_migrations` and
 * any `*_fts` shadows are always filtered (the migration ledger lives
 * outside the user schema; FTS shadows are an engine implementation
 * detail). User patterns are additive on top.
 */
export type IgnoreSpec = ReadonlyArray<string | RegExp>;

function matchesIgnore(name: string, spec: IgnoreSpec): boolean {
  for (const p of spec) {
    if (typeof p === 'string') {
      if (p === name) return true;
    } else if (p instanceof RegExp) {
      if (p.test(name)) return true;
    }
  }
  return false;
}

/**
 * Parse a comma-separated ignore-spec string (CLI flag or env var) into
 * `IgnoreSpec`. Items wrapped in `/.../flags` are treated as regex —
 * everything else is an exact-match string.
 *
 *   parseIgnoreList('logs,/^_atlas_/i,events')
 *     → ['logs', /^_atlas_/i, 'events']
 */
export function parseIgnoreList(raw: string | undefined | null): IgnoreSpec {
  if (!raw) return [];
  const out: (string | RegExp)[] = [];
  for (const item of raw.split(',')) {
    const trimmed = item.trim();
    if (!trimmed) continue;
    const m = /^\/(.+)\/([a-z]*)$/.exec(trimmed);
    if (m) {
      try { out.push(new RegExp(m[1], m[2])); continue; } catch { /* fall through */ }
    }
    out.push(trimmed);
  }
  return out;
}

// ── Expected-shape derivation ──────────────────────────────────────────────

interface ExpectedTable {
  name: string;
  columns: Map<string, FieldDef>;
  // normalized index signatures: `u:col1,col2` (unique) / `n:col1,col2`
  indexSigs: Set<string>;
  fks: { column: string; refTable: string; refColumn: string }[];
}

function indexSig(unique: boolean, cols: string[]): string {
  return `${unique ? 'u' : 'n'}:${[...cols].sort().join(',')}`;
}

export function expectedFromSchema(schema: Record<string, any>): {
  tables: Map<string, ExpectedTable>;
  views: { name: string; materialised: boolean }[];
} {
  const tables = new Map<string, ExpectedTable>();
  const views: { name: string; materialised: boolean }[] = [];

  for (const key of Object.keys(schema)) {
    const m = schema[key] as ModelDef<any> | undefined;
    if (!m) continue;
    if (m.view) {
      // Materialised views are table-backed on MySQL/SQLite, real matviews on
      // PG, collections on Mongo — all introspect as a "view" entry here.
      views.push({ name: m.collection, materialised: m.view.materialised === true });
      continue;
    }

    const columns = new Map<string, FieldDef>();
    let idCol: string | undefined;
    for (const [name, fdef] of Object.entries(m.fields)) {
      columns.set(name, fdef as FieldDef);
      if ((fdef as FieldDef).kind === 'id') idCol = name;
    }

    const indexSigs = new Set<string>();
    if (idCol) indexSigs.add(indexSig(true, [idCol]));            // primary key
    for (const [name, fdef] of Object.entries(m.fields)) {
      const fd = fdef as FieldDef;
      if (fd.unique && fd.kind !== 'id') indexSigs.add(indexSig(true, [name]));
    }
    for (const cols of m.uniques ?? []) indexSigs.add(indexSig(true, cols));
    for (const idx of m.indexes ?? []) {
      indexSigs.add(indexSig(idx.unique === true, Object.keys(idx.keys)));
    }

    const fks: ExpectedTable['fks'] = [];
    for (const rel of Object.values(m.relations())) {
      const r = rel as RelationDef;
      if (r.inverse) continue;
      if (!m.fields[r.on]) continue;
      if (m.fields[r.on]?.kind === 'id') continue;   // inverse-one heuristic
      const target = schema[r.target] as ModelDef<any> | undefined;
      if (!target) continue;
      fks.push({ column: r.on, refTable: target.collection, refColumn: r.refs });
    }

    tables.set(m.collection, { name: m.collection, columns, indexSigs, fks });
  }

  return { tables, views };
}

// ── Comparator ──────────────────────────────────────────────────────────────

// Map a forge field kind + a DB-reported type token onto a coarse category so
// type comparison survives dialect differences. Returns undefined when we
// can't confidently categorise (then we don't flag a mismatch).
function fieldCategory(kind: string): string | undefined {
  switch (kind) {
    case 'id': case 'objectId': case 'string': case 'text': case 'uuid': case 'enum': return 'string';
    case 'int': return 'int';
    case 'bigint': return 'bigint';
    case 'float': return 'float';
    case 'decimal': return 'decimal';
    case 'bool': return 'bool';
    case 'dateTime': return 'datetime';
    case 'json': case 'embed': case 'embedMany': return 'json';
    default: return undefined;   // arrays etc. — skip
  }
}

function dbTypeCategory(type: string): string | undefined {
  const t = type.toLowerCase();
  if (/^(text|varchar|char|character|uuid|citext)/.test(t)) return 'string';
  if (/^(bigint|int8)/.test(t)) return 'bigint';
  if (/^(smallint|integer|int|int4|int2|mediumint)/.test(t)) return 'int';
  if (/^(numeric|decimal)/.test(t)) return 'decimal';
  if (/^(real|double|float)/.test(t)) return 'float';
  if (/^(bool|tinyint\(1\))/.test(t)) return 'bool';
  if (/^(timestamp|datetime|date|time)/.test(t)) return 'datetime';
  if (/^(json|jsonb)/.test(t)) return 'json';
  return undefined;
}

export function diffIntrospection(
  schema: Record<string, any>,
  actual: DbIntrospection,
  ignore: IgnoreSpec = [],
): DriftReport {
  const expected = expectedFromSchema(schema);
  const items: DriftItem[] = [];
  const dialect = actual.kind;
  const checkTypes = dialect !== 'sqlite' && dialect !== 'mongo';
  // Mongo is schemaless: only collection + index level make sense.
  const structuralColumns = dialect !== 'mongo';
  const ignored: string[] = [];

  const actualTables = new Map<string, IntrospectedTable>();
  for (const t of actual.tables) actualTables.set(t.name, t);

  // Tables present in schema.
  for (const [name, exp] of expected.tables) {
    const act = actualTables.get(name);
    if (!act) { items.push({ kind: 'table', direction: 'missing', table: name, detail: `table '${name}' declared in schema but not in DB` }); continue; }

    if (structuralColumns) {
      const actCols = new Map(act.columns.map((c) => [c.name, c]));
      for (const [col, fd] of exp.columns) {
        const ac = actCols.get(col);
        if (!ac) { items.push({ kind: 'column', direction: 'missing', table: name, detail: `column '${col}'` }); continue; }
        if (checkTypes) {
          const ec = fieldCategory(fd.kind);
          const dc = dbTypeCategory(ac.type);
          if (ec && dc && ec !== dc) {
            items.push({ kind: 'columnType', direction: 'mismatch', table: name, detail: `column '${col}': schema=${ec} db=${ac.type}` });
          }
        }
      }
      for (const ac of act.columns) {
        if (!exp.columns.has(ac.name)) items.push({ kind: 'column', direction: 'extra', table: name, detail: `column '${ac.name}' in DB but not in schema` });
      }
    }

    // Indexes — compare by column-set+uniqueness, ignoring names + FTS shadows.
    const actSigs = new Set<string>();
    for (const ix of act.indexes) {
      if (/_fts/i.test(ix.name)) continue;
      actSigs.add(indexSig(ix.unique, ix.columns));
    }
    for (const sig of exp.indexSigs) {
      if (!actSigs.has(sig)) items.push({ kind: 'index', direction: 'missing', table: name, detail: `index ${sig}` });
    }
    // Extra indexes are common (engine-created); only report extra UNIQUE ones,
    // which usually signal a real divergence.
    for (const sig of actSigs) {
      if (sig.startsWith('u:') && !exp.indexSigs.has(sig)) items.push({ kind: 'index', direction: 'extra', table: name, detail: `unique index ${sig} in DB but not in schema` });
    }

    // Foreign keys — by (column → refTable.refColumn).
    if (dialect !== 'mongo') {
      const actFks = new Set(act.foreignKeys.map((f) => `${f.column}->${f.refTable}.${f.refColumn}`));
      for (const fk of exp.fks) {
        const k = `${fk.column}->${fk.refTable}.${fk.refColumn}`;
        if (!actFks.has(k)) items.push({ kind: 'foreignKey', direction: 'missing', table: name, detail: k });
      }
    }
  }

  // Extra tables in DB not in schema. Built-in skips: the migration
  // ledger and engine-generated FTS shadows. User-supplied `ignore`
  // patterns drop noisy meta-collections (Atlas, system.*, cross-
  // service tables) without inheriting them into the schema.
  for (const [name] of actualTables) {
    if (expected.tables.has(name)) continue;
    if (expected.views.some((v) => v.name === name)) continue;  // matview-backing table
    if (name === '_forge_migrations' || /_fts/i.test(name)) continue;
    if (ignore.length > 0 && matchesIgnore(name, ignore)) { ignored.push(name); continue; }
    items.push({ kind: 'table', direction: 'extra', table: name, detail: `table '${name}' in DB but not in schema` });
  }

  // Views.
  const actualViewNames = new Set(actual.views.map((v) => v.name));
  for (const v of expected.views) {
    // PG matview / Mongo collection / MySQL+SQLite table-backed: a matview may
    // surface as a table rather than a view — accept either.
    if (!actualViewNames.has(v.name) && !actualTables.has(v.name)) {
      items.push({ kind: 'view', direction: 'missing', table: v.name, detail: `view '${v.name}'` });
    }
  }

  return {
    dialect,
    items,
    inSync: items.length === 0,
    ignored: ignored.length > 0 ? ignored : undefined,
  };
}

// ── Pretty printer ────────────────────────────────────────────────────────

export function formatDriftReport(r: DriftReport): string {
  const ignoredTail =
    r.ignored && r.ignored.length > 0
      ? `\n  (ignored ${r.ignored.length} table${r.ignored.length === 1 ? '' : 's'}: ${r.ignored.join(', ')})`
      : '';
  if (r.inSync) return `✓ no drift — live ${r.dialect} schema matches forge schema${ignoredTail}`;
  const lines = [`✗ drift detected on ${r.dialect} (${r.items.length} issue${r.items.length === 1 ? '' : 's'}):`];
  for (const it of r.items) {
    const tag = it.direction === 'missing' ? '−' : it.direction === 'extra' ? '+' : '≠';
    lines.push(`  ${tag} [${it.kind}] ${it.table}: ${it.detail}`);
  }
  if (ignoredTail) lines.push(ignoredTail.replace(/^\n  /, '  '));
  return lines.join('\n');
}
