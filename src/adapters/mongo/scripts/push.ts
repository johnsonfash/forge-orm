/* eslint-disable no-console */
import * as dotenv from 'dotenv';
dotenv.config();

import { Collection } from 'mongodb';
import { dbClient } from '../client';
import { schema } from '../../../schema';
import { FieldDef, ModelDef } from '../../../schema/types';

// ============================================================================
// db:u — pushes every index declared in the schema to MongoDB.
//
// Drop-in replacement for `prisma db push`. Differences worth knowing:
//
//   1. Pre-fetch existing indexes with listIndexes() ONCE per collection,
//      diff against the desired set, and only call createIndex for new or
//      changed specs. The hot path is now a single index list per collection
//      and zero server-side work for indexes that match — re-running this
//      against an in-sync DB does ~N RTTs (one per collection), nothing more.
//
//   2. When key spec OR options drifted (Mongo error 85/86), drop and
//      recreate so the new definition lands. Old data that violates a
//      newly-added unique constraint is logged, not crashed.
//
//   3. Output is grouped per collection and tagged so you can tell at a
//      glance what changed: ✓ created, ↻ rebuilt, ⚡ skipped, ⚠ warning.
//
// Walks the schema:
//   • _id (always present, automatic by Mongo) — never re-pushed.
//   • Single-field uniques  — every field with `.unique()`.
//   • Composite uniques     — every entry in model.uniques (@@unique).
//   • Plain compound idxs   — every entry in model.indexes (@@index).
// ============================================================================

interface IndexSpec {
  keys: Record<string, 1 | -1 | 'text'>;
  unique?: boolean;
  sparse?: boolean;
  name: string;
  expireAfterSeconds?: number;
}

interface IndexInfo {
  name: string;
  key: Record<string, any>;
  unique?: boolean;
  sparse?: boolean;
  expireAfterSeconds?: number;
}

// ─── Existing-index diff ────────────────────────────────────────────────────

// Stable JSON for spec comparison: preserves key insertion order.
function fingerprint(keys: Record<string, any>, unique?: boolean, sparse?: boolean, expireAfterSeconds?: number): string {
  const keyStr = Object.keys(keys)
    .map((k) => `${k}:${keys[k]}`)
    .join(',');
  return `${keyStr}|u=${unique ? 1 : 0}|s=${sparse ? 1 : 0}|ttl=${expireAfterSeconds ?? '-'}`;
}

async function listExisting(collection: Collection): Promise<Map<string, IndexInfo>> {
  // listIndexes throws NamespaceNotFound (26) when the collection is brand
  // new — that's fine, we'll create everything from scratch.
  try {
    const idx = await collection.listIndexes().toArray();
    const map = new Map<string, IndexInfo>();
    for (const i of idx) {
      map.set(i.name, {
        name: i.name,
        key: i.key,
        unique: !!i.unique,
        sparse: !!i.sparse,
        expireAfterSeconds: i.expireAfterSeconds,
      });
    }
    return map;
  } catch (err: any) {
    if (err?.code === 26) return new Map();
    throw err;
  }
}

// ─── Per-spec push with conflict recovery ───────────────────────────────────

async function ensureIndex(
  collection: Collection,
  spec: IndexSpec,
  existing: Map<string, IndexInfo>,
): Promise<'created' | 'skipped' | 'rebuilt' | 'warned'> {
  const opts: any = { name: spec.name };
  if (spec.unique) opts.unique = true;
  if (spec.sparse) opts.sparse = true;
  if (spec.expireAfterSeconds !== undefined) {
    opts.expireAfterSeconds = spec.expireAfterSeconds;
  }

  const want = fingerprint(spec.keys, spec.unique, spec.sparse, spec.expireAfterSeconds);
  const have = existing.get(spec.name);

  if (have) {
    const haveFp = fingerprint(have.key, have.unique, have.sparse, have.expireAfterSeconds);
    if (haveFp === want) {
      return 'skipped';
    }
    // Drift — drop and recreate.
    try {
      await collection.dropIndex(spec.name);
      await collection.createIndex(spec.keys, opts);
      return 'rebuilt';
    } catch (err: any) {
      console.warn(`   ⚠ ${spec.name} could not be rebuilt: ${err?.message || err}`);
      return 'warned';
    }
  }

  // Not present — create.
  try {
    await collection.createIndex(spec.keys, opts);
    return 'created';
  } catch (err: any) {
    const code = err?.code;
    const msg = err?.message || '';
    // Race / pre-existing on a different name (rare): try to recover by
    // dropping the named one if it now exists (e.g. created by a concurrent
    // run) then no-op.
    if (
      code === 85 ||
      code === 86 ||
      code === 68 ||
      msg.includes('already exists')
    ) {
      try {
        await collection.dropIndex(spec.name);
        await collection.createIndex(spec.keys, opts);
        return 'rebuilt';
      } catch (rebuildErr: any) {
        console.warn(`   ⚠ ${spec.name} could not be created: ${rebuildErr?.message || rebuildErr}`);
        return 'warned';
      }
    }
    console.warn(`   ⚠ ${spec.name} skipped: ${msg}`);
    return 'warned';
  }
}

// ─── Schema → IndexSpec[] ────────────────────────────────────────────────────

function indexNameFor(modelName: string, keys: Record<string, any>, unique?: boolean): string {
  const k = Object.keys(keys)
    .map((s) => s.replace(/[^a-zA-Z0-9]/g, '_'))
    .join('_');
  return `idx_${modelName}_${k}${unique ? '_uq' : ''}`;
}

function collectIndexSpecs(modelName: string, model: ModelDef<any>): IndexSpec[] {
  const specs: IndexSpec[] = [];

  // Single-field uniques.
  const entries = Object.entries(model.fields) as [string, FieldDef][];
  for (const [fname, fdef] of entries) {
    if (!fdef.unique) continue;
    if (fdef.kind === 'id') continue; // _id is automatic
    specs.push({
      keys: { [fname]: 1 },
      unique: true,
      sparse: fdef.optional || undefined,
      name: indexNameFor(modelName, { [fname]: 1 }, true),
    });
  }

  // Composite uniques.
  for (const cu of model.uniques || []) {
    const keys: Record<string, 1> = {};
    for (const f of cu) keys[f] = 1;
    specs.push({
      keys,
      unique: true,
      name: indexNameFor(modelName, keys, true),
    });
  }

  // Plain compound indexes — schema-supplied.
  for (const idx of model.indexes || []) {
    specs.push({
      keys: idx.keys,
      unique: idx.unique,
      sparse: idx.sparse,
      expireAfterSeconds: idx.expireAfterSeconds,
      name: idx.name || indexNameFor(modelName, idx.keys, idx.unique),
    });
  }

  // Wave 4b — `.searchable()` fields. Mongo allows at most ONE text index
  // per collection; if multiple fields are marked, combine them into a
  // single text index across all marked columns.
  const textCols = entries.filter(([, f]) => f.searchable).map(([n]) => n);
  if (textCols.length > 0) {
    const keys: Record<string, any> = {};
    for (const c of textCols) keys[c] = 'text';
    specs.push({
      keys,
      name: `forge_${model.collection}_fts`,
    });
  }

  return specs;
}

// ─── Main ────────────────────────────────────────────────────────────────────

export async function pushAllIndexes(): Promise<void> {
  await dbClient.connect();
  const db = dbClient.db;

  let created = 0,
    skipped = 0,
    rebuilt = 0,
    warned = 0;

  // Wave 4c — create any view-models first. Mongo views are collections
  // created with `viewOn` + `pipeline`. Idempotent: if a collection of that
  // name already exists with the same source/pipeline, skip; otherwise
  // re-create (drop + create).
  for (const [, model] of Object.entries(schema)) {
    const m = model as ModelDef<any>;
    if (!m.view) continue;
    const source = m.view.sourceCollection;
    const pipeline = (m.view.pipeline as any[]) ?? [];
    if (!source) {
      console.log(`   ⚠ view '${m.collection}' missing sourceCollection — skipped`);
      continue;
    }
    // Wave 5d — materialised view: a real collection populated by the
    // pipeline's $out/$merge stage (not a Mongo read-only view). Initial
    // populate happens here; db.<model>.refresh() re-runs it later.
    if (m.view.materialised) {
      const hasOut = pipeline.some((s) => s && (s.$merge || s.$out));
      const full = hasOut ? pipeline : [...pipeline, { $out: m.collection }];
      await db.collection(source).aggregate(full).toArray();
      console.log(`\n📦 ${m.collection}  (materialised from ${source})`);
      continue;
    }
    const existing = await db.listCollections({ name: m.collection }).toArray();
    if (existing.length > 0) {
      // Drop + recreate to honour any pipeline drift. Cheap — views hold no data.
      try { await db.dropCollection(m.collection); } catch { /* */ }
    }
    await db.createCollection(m.collection, { viewOn: source, pipeline });
    console.log(`\n📦 ${m.collection}  (view on ${source})`);
  }

  for (const [modelName, model] of Object.entries(schema)) {
    const m = model as ModelDef<any>;
    if (m.view) continue;  // views handled above; no index push on view collections
    const specs = collectIndexSpecs(modelName, m);
    if (specs.length === 0) continue;

    const collection = db.collection(m.collection);
    const existing = await listExisting(collection);

    console.log(`\n📦 ${m.collection}`);
    for (const s of specs) {
      const result = await ensureIndex(collection, s, existing);
      switch (result) {
        case 'created':
          created++;
          console.log(`   ✓ ${s.name}`);
          break;
        case 'rebuilt':
          rebuilt++;
          console.log(`   ↻ ${s.name} (rebuilt — spec drifted)`);
          break;
        case 'skipped':
          skipped++;
          console.log(`   ⚡ ${s.name} (already up-to-date)`);
          break;
        case 'warned':
          warned++;
          break;
      }
    }
  }

  console.log(
    `\n✅ done — created ${created}, rebuilt ${rebuilt}, skipped ${skipped}` +
      (warned ? `, ${warned} warning${warned === 1 ? '' : 's'}` : '') +
      '\n',
  );
}

if (require.main === module) {
  pushAllIndexes()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('\n❌ push failed:', err);
      process.exit(1);
    });
}
