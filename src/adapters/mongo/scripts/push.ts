/* eslint-disable no-console */
import * as dotenv from 'dotenv';
dotenv.config();

import type { Collection } from 'mongodb';
import { dbClient } from '../client';
import { schema as bundledSampleSchema } from '../../../schema';
import { FieldDef, ModelDef } from '../../../schema/types';

// db:u — pushes every index declared in the schema to MongoDB. Drop-in
// replacement for `prisma db push`. Notable behaviour:
//
//   1. Pre-fetch existing indexes with listIndexes() ONCE per collection, diff
//      against the desired set, and only createIndex for new/changed specs.
//      Re-running against an in-sync DB does ~N RTTs (one per collection).
//   2. When key spec OR options drifted (Mongo error 85/86), drop and recreate.
//      Old data violating a newly-added unique constraint is logged, not crashed.
//   3. Output grouped per collection: ✓ created, ↻ rebuilt, ⚡ skipped, ⚠ warning.
//
// Index sources: single-field uniques (.unique()), composite uniques
// (model.uniques), plain compound indexes (model.indexes). _id is never pushed.

interface IndexSpec {
  keys: Record<string, 1 | -1 | 'text' | '2dsphere' | '2d' | 'hashed'>;
  unique?: boolean;
  sparse?: boolean;
  name: string;
  expireAfterSeconds?: number;
  partialFilterExpression?: Record<string, unknown>;
  collation?: Record<string, unknown>;
  wildcardProjection?: Record<string, unknown>;
}

interface IndexInfo {
  name: string;
  key: Record<string, any>;
  unique?: boolean;
  sparse?: boolean;
  expireAfterSeconds?: number;
  partialFilterExpression?: Record<string, unknown>;
  collation?: Record<string, unknown>;
  wildcardProjection?: Record<string, unknown>;
}

// Order-independent JSON for comparing a partialFilterExpression we declared
// against the one Mongo echoes back (object key order isn't guaranteed equal).
export function stableJson(v: any): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stableJson).join(',')}]`;
  return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stableJson(v[k])}`).join(',')}}`;
}

// Stable string for spec comparison: preserves key insertion order.
//
// Signature stays positional + back-compat: callers that only pass keys/unique/
// sparse/ttl/pfe (pre-2.2) still work — the extra options collapse to '-' when
// absent and are appended at the end so a fingerprint computed with the old
// signature equals one computed with the new signature for the same spec.
export function fingerprint(
  keys: Record<string, any>,
  unique?: boolean,
  sparse?: boolean,
  expireAfterSeconds?: number,
  partialFilterExpression?: Record<string, unknown>,
  collation?: Record<string, unknown>,
  wildcardProjection?: Record<string, unknown>,
): string {
  const keyStr = Object.keys(keys)
    .map((k) => `${k}:${keys[k]}`)
    .join(',');
  const base = `${keyStr}|u=${unique ? 1 : 0}|s=${sparse ? 1 : 0}|ttl=${expireAfterSeconds ?? '-'}|pfe=${partialFilterExpression ? stableJson(partialFilterExpression) : '-'}`;
  // Append new dims ONLY when present so the empty-options fingerprint is
  // byte-identical with the pre-2.2 fingerprint. That keeps existing indexes
  // from being unnecessarily rebuilt on a pure-version-bump push.
  const coll = collation ? `|coll=${stableJson(collation)}` : '';
  const wcp = wildcardProjection ? `|wcp=${stableJson(wildcardProjection)}` : '';
  return base + coll + wcp;
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
        partialFilterExpression: i.partialFilterExpression,
        // Mongo echoes back collation + wildcardProjection on listIndexes()
        // so the diff can compare them and rebuild on drift.
        collation: i.collation,
        wildcardProjection: i.wildcardProjection,
      });
    }
    return map;
  } catch (err: any) {
    if (err?.code === 26) return new Map();
    throw err;
  }
}

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
  if (spec.partialFilterExpression) {
    opts.partialFilterExpression = spec.partialFilterExpression;
  }
  if (spec.collation) {
    opts.collation = spec.collation;
  }
  if (spec.wildcardProjection) {
    opts.wildcardProjection = spec.wildcardProjection;
  }

  const want = fingerprint(
    spec.keys,
    spec.unique,
    spec.sparse,
    spec.expireAfterSeconds,
    spec.partialFilterExpression,
    spec.collation,
    spec.wildcardProjection,
  );
  const have = existing.get(spec.name);

  if (have) {
    // Mongo echoes back collation with every default field filled in
    // (caseLevel, caseFirst, alternate, maxVariable, normalization, version
    // …). The user only declared a subset (typically locale + strength) so
    // a direct fingerprint comparison would always say "drifted" and force
    // an unnecessary rebuild on every push.
    //
    // Project the echoed collation down to ONLY the keys the user declared
    // before fingerprinting. If a declared key changes (locale: 'en' → 'tr')
    // the projection still catches it; if Mongo adds a brand-new default
    // field, we silently ignore it.
    let haveCollation = have.collation;
    if (haveCollation && spec.collation) {
      const declaredKeys = Object.keys(spec.collation);
      const projected: Record<string, unknown> = {};
      for (const k of declaredKeys) {
        if (k in haveCollation) projected[k] = (haveCollation as any)[k];
      }
      haveCollation = projected;
    }
    const haveFp = fingerprint(
      have.key,
      have.unique,
      have.sparse,
      have.expireAfterSeconds,
      have.partialFilterExpression,
      haveCollation,
      have.wildcardProjection,
    );
    if (haveFp === want) {
      return 'skipped';
    }
    // Spec drifted — drop and recreate.
    try {
      await collection.dropIndex(spec.name);
      await collection.createIndex(spec.keys, opts);
      return 'rebuilt';
    } catch (err: any) {
      console.warn(`   ⚠ ${spec.name} could not be rebuilt: ${err?.message || err}`);
      return 'warned';
    }
  }

  try {
    await collection.createIndex(spec.keys, opts);
    return 'created';
  } catch (err: any) {
    const code = err?.code;
    const msg = err?.message || '';
    // Race / pre-existing on a different name: recover by dropping the named
    // index if it now exists (e.g. from a concurrent run) and recreating.
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
        // Mongo error 85 (IndexOptionsConflict) with a name in the message
        // means an EQUIVALENT index already exists under an older name —
        // usually one that predates the schema declaration. Nothing is
        // wrong: the keys and options match, only the label differs.
        //
        // Warning on every push forever, with no way to act on it short of
        // dropping an index on live data, trains people to ignore warnings.
        // Say it once, quietly, and say what it means.
        const other = /already exists with a different name:\s*(\S+)/.exec(
          rebuildErr?.message || '',
        )?.[1];
        if (other) {
          console.log(
            `   ≡ ${spec.name} — same index already present as '${other}'. ` +
            `Keys and options match; only the name differs. ` +
            `Run with FORGE_RENAME_INDEXES=1 to adopt the schema name.`,
          );
          if (process.env.FORGE_RENAME_INDEXES === '1') {
            try {
              await collection.dropIndex(other);
              await collection.createIndex(spec.keys, opts);
              return 'rebuilt';
            } catch (renameErr: any) {
              console.warn(`   ⚠ ${spec.name} could not adopt '${other}': ${renameErr?.message || renameErr}`);
              return 'warned';
            }
          }
          return 'skipped';
        }
        console.warn(`   ⚠ ${spec.name} could not be created: ${rebuildErr?.message || rebuildErr}`);
        return 'warned';
      }
    }
    console.warn(`   ⚠ ${spec.name} skipped: ${msg}`);
    return 'warned';
  }
}

function indexNameFor(modelName: string, keys: Record<string, any>, unique?: boolean): string {
  const k = Object.keys(keys)
    .map((s) => s.replace(/[^a-zA-Z0-9]/g, '_'))
    .join('_');
  return `idx_${modelName}_${k}${unique ? '_uq' : ''}`;
}

/**
 * `id` is the schema's name for the primary key; `_id` is Mongo's.
 *
 * `coerce.ts` already translates it on every read and write, so a query
 * written as `where: { id }` works. Index keys did NOT go through that
 * translation — they were handed to `createIndex` verbatim — so an index
 * declared as `{ threadId: 1, id: -1 }` created a real index on a field
 * literally called `id`, which no document has.
 *
 * Nothing reported it: push said "created", doctor said nothing, and the
 * index showed up in `getIndexes()`. Only `explain()` gave it away — the
 * sort it existed for was still done in memory (stage SORT rather than
 * FETCH). `diff` then called it permanent drift, comparing the declared
 * `id` against the stored `_id`.
 *
 * The same rule was already half-applied here: single-field uniques skip
 * `kind === 'id'` because "_id is automatic". It just was not applied to
 * compound keys.
 */
export function normaliseIndexKeys<T extends Record<string, unknown>>(keys: T): T {
  if (!('id' in keys)) return keys;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(keys)) out[k === 'id' ? '_id' : k] = v;
  return out as T;
}

export function collectIndexSpecs(modelName: string, model: ModelDef<any>): IndexSpec[] {
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
    const raw: Record<string, 1> = {};
    for (const f of cu) raw[f] = 1;
    const keys = normaliseIndexKeys(raw);
    specs.push({
      keys,
      unique: true,
      name: indexNameFor(modelName, keys, true),
    });
  }

  // Plain compound indexes — schema-supplied. Expression indexes
  // (idx.expression) and SQL-only fields (idx.include, idx.method) are
  // SQL-only — skip the spec on Mongo. `where` aliases the Mongo
  // `partialFilterExpression` when given as an object; a string `where`
  // is SQL-only and ignored here.
  for (const idx of model.indexes || []) {
    if (idx.expression) continue; // Mongo doesn't support expression indexes
    const pfe =
      idx.partialFilterExpression ??
      (idx.where && typeof idx.where === 'object'
        ? (idx.where as Record<string, unknown>)
        : undefined);
    // 'spatial' is the portable cross-dialect index method. On Mongo it
    // resolves to a 2dsphere key.
    // 'vector' on Mongo is NOT a regular createIndex — Atlas Vector Search
    // uses a separate Search Index API. Skip and tell the user.
    if (idx.method === 'vector') {
      // eslint-disable-next-line no-console
      console.warn(
        `[forge:push:mongo] index '${idx.name ?? '(unnamed)'}' uses method:'vector' — ` +
        `Mongo vector indexes live in Atlas Search (createSearchIndex), not the ` +
        `regular createIndex API. Skipped. Create via the Atlas UI / CLI: ` +
        `https://www.mongodb.com/docs/atlas/atlas-vector-search/`,
      );
      continue;
    }
    const keys = normaliseIndexKeys(
      idx.method === 'spatial'
        ? Object.fromEntries(Object.keys(idx.keys).map((k) => [k, '2dsphere']))
        : idx.keys,
    );
    specs.push({
      keys: keys as Record<string, 1 | -1 | 'text' | '2dsphere' | '2d' | 'hashed'>,
      unique: idx.unique,
      sparse: idx.sparse,
      expireAfterSeconds: idx.expireAfterSeconds,
      partialFilterExpression: pfe,
      collation: idx.collation as Record<string, unknown> | undefined,
      wildcardProjection: idx.wildcardProjection,
      name: idx.name || indexNameFor(modelName, keys, idx.unique),
    });
  }

  // `.searchable()` fields. Mongo allows at most ONE text index per collection,
  // so combine every marked field into a single text index.
  const textCols =entries.filter(([, f]) => f.searchable).map(([n]) => n);
  if (textCols.length > 0) {
    const raw: Record<string, any> = {};
    for (const c of textCols) raw[c] = 'text';
    const keys = normaliseIndexKeys(raw);
    specs.push({
      keys,
      name: `forge_${model.collection}_fts`,
    });
  }

  return specs;
}

/**
 * Push every index declared on the supplied schema to MongoDB.
 *
 * @param consumerSchema - The consumer's schema map (`{ Users, Posts, ... }`).
 *                        When omitted, falls back to forge's bundled sample
 *                        schema — exists for forge's internal test/dev runs;
 *                        consumers should always pass their own schema.
 */
export async function pushAllIndexes(consumerSchema?: any): Promise<void> {
  await dbClient.connect();
  const db = dbClient.db;
  const schema = consumerSchema ?? bundledSampleSchema;

  // bigserial is SQL-only by definition (auto-incrementing scalar). Throw
  // up-front with a clear message rather than letting the schema land
  // half-pushed.
  for (const [key, model] of Object.entries(schema)) {
    const m = model as ModelDef<any>;
    for (const [fname, fdef] of Object.entries(m.fields ?? {})) {
      const f = fdef as any;
      if (f?.kind === 'id' && f?.idType === 'bigserial') {
        throw new Error(
          `[forge:push:mongo] model '${key}' (collection '${m.collection}') uses ` +
          `f.id({ type: 'bigserial' }) on field '${fname}', which has no Mongo ` +
          `equivalent. Use 'auto', 'uuid', or 'string' for an app-supplied key.`,
        );
      }
    }
  }

  let created = 0,
    skipped = 0,
    rebuilt = 0,
    warned = 0;

  // Create any view-models first. Mongo views are collections created with
  // `viewOn` + `pipeline`; we drop + recreate to honour pipeline drift.
  for (const [, model] of Object.entries(schema)) {
    const m = model as ModelDef<any>;
    if (!m.view) continue;
    const source = m.view.sourceCollection;
    const pipeline = (m.view.pipeline as any[]) ?? [];
    if (!source) {
      console.log(`   ⚠ view '${m.collection}' missing sourceCollection — skipped`);
      continue;
    }
    // Materialised view: a real collection populated by the pipeline's
    // $out/$merge stage (not a Mongo read-only view). Initial populate happens
    // here; db.<model>.refresh() re-runs it later.
    if (m.view.materialised) {
      const hasOut = pipeline.some((s) => s && (s.$merge || s.$out));
      const full = hasOut ? pipeline : [...pipeline, { $out: m.collection }];
      await db.collection(source).aggregate(full).toArray();
      console.log(`\n📦 ${m.collection}  (materialised from ${source})`);
      continue;
    }
    const existing = await db.listCollections({ name: m.collection }).toArray();
    if (existing.length > 0) {
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
  // Stand-alone invocation: load the consumer's schema first.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { loadConsumerSchema } = require('../../../scripts/load-consumer-schema');
  const { schema, source } = loadConsumerSchema();
  console.log(`[forge:push] mongo — schema: ${source}`);
  pushAllIndexes(schema)
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('\n❌ push failed:', err);
      process.exit(1);
    });
}
