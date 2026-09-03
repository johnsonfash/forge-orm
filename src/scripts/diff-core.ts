import type {
  AdapterKind,
  DbIntrospection,
  IntrospectedTable,
} from '../adapters/types';
import type { FieldDef, ModelDef, RelationDef } from '../schema/types';

// Pure (no-IO) drift comparator.
//
// `expectedFromSchema` derives what forge push would create from the schema.
// `diffIntrospection` compares it to a live DbIntrospection snapshot.
//
// Type comparison is deliberately coarse (mapped to categories) and skipped
// on SQLite + Mongo so the report doesn't cry wolf on dynamic typing.

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

interface ExpectedIndexDecl {
  name?: string;
  unique: boolean;
  keys: Record<string, unknown>;
  method?: string;
  where?: Record<string, unknown> | string;
  include?: string[];
  expression?: string;
  partialFilterExpression?: Record<string, unknown>;
  collation?: Record<string, unknown>;
  wildcardProjection?: Record<string, unknown>;
}

interface ExpectedTable {
  name: string;
  columns: Map<string, FieldDef>;
  // normalized index signatures: `u:col1,col2` (unique) / `n:col1,col2`
  indexSigs: Set<string>;
  // Full per-index declarations for deep-field drift detection (method,
  // where, include, expression, collation, etc.). Only entries with an
  // explicit `name` participate in the deep comparison so unnamed indexes
  // don't false-positive.
  indexDecls: ExpectedIndexDecl[];
  fks: { column: string; refTable: string; refColumn: string }[];
}

function indexSig(unique: boolean, cols: string[]): string {
  return `${unique ? 'u' : 'n'}:${[...cols].sort().join(',')}`;
}

// Stable JSON for cross-side comparison — sorts keys recursively so
// `{ a: 1, b: 2 }` and `{ b: 2, a: 1 }` produce identical strings.
function canonOrdered(v: unknown): unknown {
  if (v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map(canonOrdered);
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(v as Record<string, unknown>).sort()) {
    out[k] = canonOrdered((v as Record<string, unknown>)[k]);
  }
  return out;
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
    const indexDecls: ExpectedIndexDecl[] = [];
    if (idCol) indexSigs.add(indexSig(true, [idCol]));            // primary key
    for (const [name, fdef] of Object.entries(m.fields)) {
      const fd = fdef as FieldDef;
      if (fd.unique && fd.kind !== 'id') indexSigs.add(indexSig(true, [name]));
    }
    for (const cols of m.uniques ?? []) indexSigs.add(indexSig(true, cols));
    for (const idx of m.indexes ?? []) {
      // Expression indexes have no column list — comparing them by column-set
      // would treat every expression index as a duplicate of every other one
      // (all "empty cols"). They still participate in the deep per-name
      // comparison below; only the column-set signature skips them.
      if (!idx.expression) {
        indexSigs.add(indexSig(idx.unique === true, Object.keys(idx.keys)));
        // …and under Mongo's own name for the primary key, so the signature
        // matches whichever spelling the schema used.
        const asMongo = Object.keys(idx.keys).map((k) => (k === 'id' ? '_id' : k));
        indexSigs.add(indexSig(idx.unique === true, asMongo));
      }
      indexDecls.push({
        name: idx.name,
        unique: idx.unique === true,
        keys: idx.keys,
        method: idx.method,
        where: idx.where,
        include: idx.include,
        expression: idx.expression,
        partialFilterExpression: idx.partialFilterExpression,
        collation: idx.collation as Record<string, unknown> | undefined,
        wildcardProjection: idx.wildcardProjection,
      });
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

    tables.set(m.collection, { name: m.collection, columns, indexSigs, indexDecls, fks });
  }

  return { tables, views };
}

/** `id` in a schema index key is Mongo's `_id`. Only on Mongo — every SQL
 *  dialect has a column genuinely called whatever the schema says. */
function mongoKeys(
  keys: Record<string, unknown>,
  dialect: AdapterKind,
): Record<string, unknown> {
  if (dialect !== 'mongo' || !('id' in keys)) return keys;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(keys)) out[k === 'id' ? '_id' : k] = v;
  return out;
}

// Coarse categories so type comparison survives dialect quirks. Returns
// undefined for shapes we can't confidently categorise — then we don't flag.
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

    // Indexes — first pass: column-set+uniqueness match (cheap, catches the
    // common case of "missing index entirely").
    const actSigs = new Set<string>();
    const actByName = new Map<string, typeof act.indexes[number]>();
    for (const ix of act.indexes) {
      if (/_fts/i.test(ix.name)) continue;
      actSigs.add(indexSig(ix.unique, ix.columns));
      actByName.set(ix.name, ix);
    }
    for (const sig of exp.indexSigs) {
      if (!actSigs.has(sig)) items.push({ kind: 'index', direction: 'missing', table: name, detail: `index ${sig}` });
    }
    // Extra indexes are common (engine-created); only report extra UNIQUE ones,
    // which usually signal a real divergence.
    for (const sig of actSigs) {
      if (sig.startsWith('u:') && !exp.indexSigs.has(sig)) items.push({ kind: 'index', direction: 'extra', table: name, detail: `unique index ${sig} in DB but not in schema` });
    }

    // Second pass — when an expected index has an explicit name and the DB
    // has an index with that name, deep-compare method / where / include /
    // expression / partial filter / collation / wildcardProjection. Each
    // mismatch becomes its own drift entry, scoped by index name, so an
    // operator can see exactly which property drifted instead of just
    // "something changed".
    for (const decl of exp.indexDecls) {
      if (!decl.name) continue;
      const ix = actByName.get(decl.name);
      if (!ix) continue; // already reported by the column-set pass

      // Method — only compare when the adapter actually read it back. On
      // Mongo `method` doesn't exist; on older PG/MySQL the introspect
      // pass leaves it undefined and we skip the check.
      if (ix.method !== undefined) {
        const expM = decl.method ?? 'btree';
        if (expM !== ix.method) {
          items.push({ kind: 'index', direction: 'mismatch', table: name, detail: `index '${decl.name}' method: schema=${expM} db=${ix.method}` });
        }
      }

      // Partial WHERE / partialFilterExpression. SQL: compare as trimmed
      // strings. Mongo: compare via stable JSON so key-order doesn't
      // produce false positives.
      const expWhereStr = typeof decl.where === 'string' ? decl.where.trim() : undefined;
      const expPfe = decl.partialFilterExpression ?? (typeof decl.where === 'object' ? decl.where as Record<string, unknown> : undefined);
      if (ix.where !== undefined && (expWhereStr || ix.where)) {
        const norm = (s: string) => s.replace(/\s+/g, ' ').toLowerCase().trim().replace(/^\(+|\)+$/g, '').trim();
        const a = norm(expWhereStr || '');
        const b = norm(String(ix.where));
        if (a !== b) items.push({ kind: 'index', direction: 'mismatch', table: name, detail: `index '${decl.name}' where: schema=${a || '∅'} db=${b}` });
      }
      if (ix.partialFilterExpression !== undefined) {
        const a = expPfe ? JSON.stringify(canonOrdered(expPfe)) : '∅';
        const b = JSON.stringify(canonOrdered(ix.partialFilterExpression));
        if (a !== b) items.push({ kind: 'index', direction: 'mismatch', table: name, detail: `index '${decl.name}' partialFilter: schema=${a} db=${b}` });
      }

      // INCLUDE — PG covering columns.
      if (ix.include !== undefined) {
        const a = (decl.include ?? []).join(',');
        const b = (ix.include ?? []).join(',');
        if (a !== b) items.push({ kind: 'index', direction: 'mismatch', table: name, detail: `index '${decl.name}' include: schema=[${a}] db=[${b}]` });
      }

      // Expression — strings can differ in whitespace / case (PG echoes
      // the parsed form, not the user's exact text). Compare normalized.
      if (ix.expression !== undefined && (decl.expression || ix.expression)) {
        const norm = (s: string) => s.replace(/\s+/g, ' ').toLowerCase().trim();
        const a = decl.expression ? norm(decl.expression) : '';
        const b = ix.expression ? norm(ix.expression) : '';
        // PG often wraps with extra parens; tolerate.
        const ap = a.replace(/^\(+|\)+$/g, '');
        const bp = b.replace(/^\(+|\)+$/g, '');
        if (ap !== bp) items.push({ kind: 'index', direction: 'mismatch', table: name, detail: `index '${decl.name}' expression: schema='${a}' db='${b}'` });
      }

      // Collation (Mongo) — project the DB's echoed defaults down to the
      // user-declared keys before comparing.
      if (ix.collation && decl.collation) {
        const dk = Object.keys(decl.collation);
        const projected: Record<string, unknown> = {};
        for (const k of dk) projected[k] = (ix.collation as any)[k];
        const a = JSON.stringify(canonOrdered(decl.collation));
        const b = JSON.stringify(canonOrdered(projected));
        if (a !== b) items.push({ kind: 'index', direction: 'mismatch', table: name, detail: `index '${decl.name}' collation: schema=${a} db=${b}` });
      }

      // Wildcard projection (Mongo).
      if (ix.wildcardProjection !== undefined && (decl.wildcardProjection || ix.wildcardProjection)) {
        const a = JSON.stringify(canonOrdered(decl.wildcardProjection ?? {}));
        const b = JSON.stringify(canonOrdered(ix.wildcardProjection ?? {}));
        if (a !== b) items.push({ kind: 'index', direction: 'mismatch', table: name, detail: `index '${decl.name}' wildcardProjection: schema=${a} db=${b}` });
      }

      // Per-key Mongo direction tokens (1, -1, 'text', '2dsphere', '2d',
      // 'hashed'). Only checked when the introspect adapter populated
      // keySpec (Mongo).
      if (ix.keySpec) {
        // The schema calls the primary key `id`; Mongo stores it as `_id`,
        // and the push adapter now translates it. Compare like for like or
        // every such index reports as permanent drift.
        const a = JSON.stringify(canonOrdered(mongoKeys(decl.keys, dialect)));
        const b = JSON.stringify(canonOrdered(ix.keySpec));
        if (a !== b) items.push({ kind: 'index', direction: 'mismatch', table: name, detail: `index '${decl.name}' keys: schema=${a} db=${b}` });
      }
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

  // Extra tables. Built-in skips: migration ledger + FTS shadows.
  // User patterns suppress noisy meta-collections on top.
  for (const [name] of actualTables) {
    if (expected.tables.has(name)) continue;
    if (expected.views.some((v) => v.name === name)) continue;  // matview-backing table
    if (name === '_forge_migrations' || /_fts/i.test(name)) continue;
    if (ignore.length > 0 && matchesIgnore(name, ignore)) { ignored.push(name); continue; }
    // Say what push will DO with it. "in DB but not in schema" reads like a
    // deletion plan; push only reconciles indexes and never drops a table,
    // and at least one team wrote a "do not run forge push" warning into
    // their own docs on the strength of this line.
    items.push({ kind: 'table', direction: 'extra', table: name, detail: `table '${name}' is not managed by forge — push will leave it alone` });
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
