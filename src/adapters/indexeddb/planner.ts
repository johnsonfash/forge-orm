// Query planner.
//
// Given a WhereTree + the target model's IndexDefs, pick the ONE scan
// strategy that IDB should drive with, and hand the rest to the JS
// predicate compiler.
//
// Selectivity ranking (best first):
//   1. Primary-key equality                            (score 100)
//   2. Unique-index equality (single or compound eq)   (score 90 / 95)
//   3. Compound index equality on ALL keys             (score 85)
//   4. Single-column equality on indexed field         (score 70)
//   5. `in` on indexed field (N point ranges)          (score 60)
//   6. Range op (lt/lte/gt/gte/startsWith) on indexed  (score 50)
//   7. Free ordering via indexed sort column           (score 20)
//   8. Full-table scan (primary key `next` cursor)     (score 0)
//
// Rules:
//   * AND at the root — search leaves against every index.
//   * OR at the root — we could union multiple scans (expensive planning);
//     v0 falls back to a full-table scan when the root is OR.
//   * NOT at the root — always a full scan.
//   * `orderBy` on an indexed column can pick the index just to get the
//     sort for free (no re-sort in JS).

import type { IndexDef, ModelDef } from '../../schema/types';
import type { OrderByEntry, WhereLeaf, WhereTree } from '../../ir/types';
import { compoundEqualityRange, leafToRange, type RangePlan } from './range';
import { compilePredicate, type RowPredicate } from './predicate';

export interface QueryPlan {
  /** IDB index name to open. undefined = primary-key cursor over the store. */
  indexName?: string;
  /** Range/ranges to scan under the chosen index. null = full scan. */
  range: RangePlan | null;
  /** JS predicate applied to every row emerging from the cursor. */
  residual: RowPredicate;
  /** Best score the planner scored — for `EXPLAIN`-style output. */
  score: number;
  /** Ordering direction that came for free with the index (else undefined). */
  orderByFree?: 'asc' | 'desc';
  /** Human explanation for doctor / debug logs. */
  explain: string;
}

export function planSelect(model: ModelDef<any>, where: WhereTree | undefined, orderBy?: OrderByEntry[]): QueryPlan {
  const indexes = allIndexes(model);
  const leaves = topLevelAndLeaves(where);
  const primary = pickPrimaryKeyLeaf(model, leaves);
  const orderField = orderBy && orderBy.length === 1 ? orderBy[0] : undefined;

  let best: QueryPlan = {
    range: null,
    residual: compilePredicate(where),
    score: 0,
    explain: 'full-table scan',
  };

  // Primary-key eq → free unique lookup.
  if (primary) {
    const range = leafToRange(primary.leaf);
    if (range) {
      best = {
        indexName: undefined, // primary-key cursor
        range,
        residual: compilePredicate(removeLeaf(where, primary.leaf)),
        score: 100,
        explain: `primary-key ${primary.leaf.op} on '${primary.leaf.field}'`,
      };
    }
  }

  // Secondary indexes.
  for (const idx of indexes) {
    const cand = scoreIndex(idx, leaves, orderField);
    if (!cand) continue;
    if (cand.score > best.score) {
      best = {
        indexName: cand.name,
        range: cand.range,
        residual: compilePredicate(removeLeaves(where, cand.usedLeaves)),
        score: cand.score,
        orderByFree: cand.orderByFree,
        explain: cand.explain,
      };
    }
  }

  // If nothing better than a full scan but orderBy is on an indexed
  // column, prefer that index for free ordering.
  if (best.score === 0 && orderField) {
    for (const idx of indexes) {
      const keys = Object.keys(idx.keys);
      if (keys.length === 1 && keys[0] === orderField.field) {
        best = {
          indexName: idx.name ?? autoIndexName(idx),
          range: { range: null, direction: orderField.direction === 'desc' ? 'prev' : 'next' },
          residual: compilePredicate(where),
          score: 20,
          orderByFree: orderField.direction,
          explain: `full scan via '${orderField.field}' index for free sort`,
        };
      }
    }
  }

  return best;
}

// ────────────────────────────────────────────────────────────────────────

function topLevelAndLeaves(w: WhereTree | undefined): WhereLeaf[] {
  if (!w) return [];
  if (w.kind === 'leaf') return [w];
  if (w.kind === 'and') {
    const out: WhereLeaf[] = [];
    for (const child of w.children) {
      if (child.kind === 'leaf') out.push(child);
    }
    return out;
  }
  return []; // root OR / NOT / relation — can't index-optimise safely in v0
}

function pickPrimaryKeyLeaf(model: ModelDef<any>, leaves: WhereLeaf[]): { leaf: WhereLeaf } | null {
  const pkField = primaryKeyField(model);
  const l = leaves.find((x) => x.field === pkField && (x.op === 'eq' || x.op === 'in'));
  return l ? { leaf: l } : null;
}

export function primaryKeyField(model: ModelDef<any>): string {
  for (const [name, def] of Object.entries(model.fields)) {
    if ((def as any).kind === 'id') return name;
  }
  return 'id';
}

interface IndexCandidate {
  name: string;
  score: number;
  range: RangePlan;
  usedLeaves: WhereLeaf[];
  orderByFree?: 'asc' | 'desc';
  explain: string;
}

function scoreIndex(idx: IndexDef, leaves: WhereLeaf[], orderField: OrderByEntry | undefined): IndexCandidate | null {
  const keys = Object.keys(idx.keys);
  const name = idx.name ?? autoIndexName(idx);

  // Compound index: match eq prefix.
  if (keys.length > 1) {
    const values: unknown[] = [];
    const used: WhereLeaf[] = [];
    for (const k of keys) {
      const l = leaves.find((x) => x.field === k && x.op === 'eq');
      if (!l) break;
      values.push(l.value);
      used.push(l);
    }
    if (values.length === keys.length) {
      return {
        name, score: idx.unique ? 95 : 85,
        range: compoundEqualityRange(values as IDBValidKey[]),
        usedLeaves: used,
        explain: `compound eq on [${keys.join(',')}]`,
      };
    }
    // v0: only reward full-prefix compound matches; a partial eq prefix
    // with a range tail is a known IDB pattern we defer to a later cut.
    return null;
  }

  // Single-column index.
  const [col] = keys;
  const eqLeaf = leaves.find((x) => x.field === col && x.op === 'eq');
  if (eqLeaf) {
    const r = leafToRange(eqLeaf);
    if (!r) return null;
    return {
      name, score: idx.unique ? 90 : 70,
      range: r, usedLeaves: [eqLeaf],
      explain: `${idx.unique ? 'unique ' : ''}eq on '${col}'`,
    };
  }
  const inLeaf = leaves.find((x) => x.field === col && x.op === 'in');
  if (inLeaf) {
    const r = leafToRange(inLeaf);
    if (!r) return null;
    return {
      name, score: 60,
      range: r, usedLeaves: [inLeaf],
      explain: `in on '${col}' (${(inLeaf.value as unknown[]).length} points)`,
    };
  }
  const rangeLeaf = leaves.find((x) =>
    x.field === col && ['lt', 'lte', 'gt', 'gte', 'startsWith'].includes(x.op));
  if (rangeLeaf) {
    const r = leafToRange(rangeLeaf);
    if (!r) return null;
    return {
      name, score: 50,
      range: r, usedLeaves: [rangeLeaf],
      explain: `${rangeLeaf.op} on '${col}'`,
    };
  }

  // No where match — but does it satisfy orderBy for free?
  if (orderField && orderField.field === col) {
    return {
      name, score: 20,
      range: { range: null, direction: orderField.direction === 'desc' ? 'prev' : 'next' },
      usedLeaves: [], orderByFree: orderField.direction,
      explain: `free sort on '${col}'`,
    };
  }
  return null;
}

/** Union of model.indexes + synthesised entries for field-level .unique()
 *  marks + composite uniques. Must match what ddl.ts emits so name lookups
 *  in the executor find the right IDB index. */
function allIndexes(model: ModelDef<any>): IndexDef[] {
  const out: IndexDef[] = [];
  const pk = primaryKeyField(model);
  for (const [name, def] of Object.entries(model.fields)) {
    if (name === pk) continue;
    if ((def as any).unique) {
      out.push({ keys: { [name]: 1 }, unique: true, name: `_u_${name}` });
    }
  }
  for (const combo of model.uniques ?? []) {
    const keys: Record<string, 1> = {};
    for (const c of combo) keys[c] = 1;
    out.push({ keys, unique: true, name: `_u_${combo.join('_')}` });
  }
  for (const idx of model.indexes ?? []) out.push(idx);
  return out;
}

// Match ddl.ts's autoIndexName exactly — the string here is the IDB index
// name the planner will hand to `store.index(name)`, so any mismatch with
// what `createIndex` was called with turns into a runtime NotFoundError.
function autoIndexName(idx: IndexDef): string {
  const keys = Object.keys(idx.keys);
  return (idx.unique ? '_u_' : '_i_') + keys.join('_');
}

function removeLeaf(w: WhereTree | undefined, leaf: WhereLeaf): WhereTree | undefined {
  return removeLeaves(w, [leaf]);
}
function removeLeaves(w: WhereTree | undefined, leaves: WhereLeaf[]): WhereTree | undefined {
  if (!w) return undefined;
  if (w.kind === 'leaf') return leaves.includes(w) ? undefined : w;
  if (w.kind === 'and') {
    const kept = w.children.map((c) => removeLeaves(c, leaves)).filter(Boolean) as WhereTree[];
    if (kept.length === 0) return undefined;
    if (kept.length === 1) return kept[0];
    return { kind: 'and', children: kept };
  }
  return w;
}
