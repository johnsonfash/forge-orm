// Schema → IDB DDL.
//
// IDB DDL runs exclusively inside `onupgradeneeded` — the executor never
// mutates schema at runtime. This module produces `DDLPlan` values that
// `open.ts` interprets against `IDBDatabase` when the version bumps.
//
// Schema evolution is naturally non-destructive on IDB:
//   - New object store            → createObjectStore
//   - New index                   → createIndex (IDB re-scans existing rows)
//   - New field (rename/repurpose)→ NO-OP (IDB is schemaless)
//   - Dropped index               → deleteIndex
//   - Dropped store (destructive) → surfaced in `pending`, opt-in only
//   - Field type change           → surfaced in `pending` (would need a
//                                    per-row rewrite in a cursor pass)
//
// multiEntry inference: IDB has no dedicated array-index type, but setting
// `multiEntry: true` on an index over an array-valued key path emits one
// index entry per element. The shipped IndexKey enum from forge core doesn't
// carry that toggle (it's SQL/Mongo-shaped), so we infer it locally: an index
// over a `stringArray` / `intArray` field, or over a synthetic FTS-token
// column (`_tokens_<field>`), gets `multiEntry: true`.

import type { IndexDef, ModelDef } from '../../schema/types';
import type { SchemaShape } from '../../schema/active';
import { primaryKeyField } from './planner';

export interface StoreDDL {
  storeName: string;
  keyPath: string;
  autoIncrement: false;
  indexes: IndexDDL[];
}
export interface IndexDDL {
  name: string;
  keyPath: string | string[];
  unique: boolean;
  multiEntry: boolean;
}
export interface DDLPlan {
  stores: StoreDDL[];
  /** Everything the shipped schema wants that could be safe-applied. */
  meta: {
    /** Fingerprint hash — bumps trigger onupgradeneeded. */
    fingerprint: string;
  };
}

export function buildDDLPlan(schema: SchemaShape): DDLPlan {
  const stores: StoreDDL[] = [];
  for (const key of Object.keys(schema)) {
    const model = schema[key] as unknown as ModelDef<any>;
    if (!model || (model as any).view) continue;
    stores.push(buildStoreDDL(model));
  }
  return { stores, meta: { fingerprint: fingerprint(stores) } };
}

export function buildStoreDDL(model: ModelDef<any>): StoreDDL {
  const pk = primaryKeyField(model);
  const indexes: IndexDDL[] = [];

  // Field-level `.unique()` → single-column unique index.
  for (const [name, def] of Object.entries(model.fields)) {
    if (name === pk) continue;
    if ((def as any).unique) {
      indexes.push({
        name: `_u_${name}`,
        keyPath: name,
        unique: true,
        multiEntry: isArrayField(def as any),
      });
    }
  }

  // Composite uniques → compound unique indexes.
  for (const combo of model.uniques ?? []) {
    indexes.push({
      name: `_u_${combo.join('_')}`,
      keyPath: combo,
      unique: true,
      multiEntry: false,
    });
  }

  // Explicit indexes (model.indexes).
  for (const idx of model.indexes ?? []) {
    const keys = Object.keys(idx.keys);
    indexes.push({
      name: idx.name ?? autoIndexName(keys, idx),
      keyPath: keys.length === 1 ? keys[0] : keys,
      unique: !!idx.unique,
      multiEntry: keys.length === 1 && shouldMultiEntry(model, keys[0]),
    });
  }

  // Shadow FTS-token indexes for every .searchable() field.
  for (const [name, def] of Object.entries(model.fields)) {
    if (!(def as any).searchable) continue;
    const tokenField = `_tokens_${name}`;
    indexes.push({
      name: `_i_tokens_${name}`,
      keyPath: tokenField,
      unique: false,
      multiEntry: true,
    });
  }

  return {
    storeName: model.collection,
    keyPath: pk,
    autoIncrement: false,
    indexes,
  };
}

function autoIndexName(keys: string[], idx: IndexDef): string {
  return (idx.unique ? '_u_' : '_i_') + keys.join('_');
}

// A single-column IDB index over an array-valued field must be `multiEntry`
// to give per-element entries. Applies to schema-declared arrays plus the
// synthetic `_tokens_<field>` shadow field the FTS layer maintains.
function shouldMultiEntry(model: ModelDef<any>, field: string): boolean {
  if (field.startsWith('_tokens_')) return true;
  const def = model.fields[field] as any;
  return !!def && isArrayField(def);
}

function isArrayField(def: { kind: string }): boolean {
  return def.kind === 'stringArray' || def.kind === 'intArray';
}

export function fingerprint(stores: StoreDDL[]): string {
  // Deterministic, cheap. Not cryptographically secure — just to detect drift.
  const canonical = JSON.stringify(
    stores
      .map((s) => ({
        n: s.storeName,
        k: s.keyPath,
        i: s.indexes
          .map((i) => ({ n: i.name, k: i.keyPath, u: i.unique, m: i.multiEntry }))
          .sort((a, b) => a.n.localeCompare(b.n)),
      }))
      .sort((a, b) => a.n.localeCompare(b.n)),
  );
  // fnv-1a — small, fast.
  let h = 0x811c9dc5;
  for (let i = 0; i < canonical.length; i++) {
    h ^= canonical.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}
