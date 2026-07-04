// JS-side predicate compiler.
//
// The planner picks one leaf to become the IDB range; everything else — the
// residual tree — is compiled here into a `(row) => boolean` function that
// runs per-row as we walk the cursor. This is where AND/OR/NOT logic lives,
// where non-indexable ops (`contains`, `endsWith`, `has*`, `jsonPath`, etc.)
// are evaluated, and where we honour case-insensitive string comparison.
//
// Every operator here has a matching semantic in the Prisma-shape query
// vocabulary. The one gap: `search` and `near` / `withinPolygon` are wired
// into separate fallback paths (fts.ts / geo.ts / vector.ts) — the executor
// applies them AFTER cursor scanning, not through this function. WhereRelation
// filters are a v0 gap and always match (documented; producers can post-filter
// downstream via a follow-up `.findMany()`).

import type { WhereLeaf, WhereTree } from '../../ir/types';

export type RowPredicate = (row: Record<string, unknown>) => boolean;

export const ALWAYS_TRUE: RowPredicate = () => true;

export function compilePredicate(tree: WhereTree | undefined): RowPredicate {
  if (!tree) return ALWAYS_TRUE;
  switch (tree.kind) {
    case 'leaf': return compileLeaf(tree);
    case 'and': {
      const parts = tree.children.map(compilePredicate);
      return (r) => parts.every((p) => p(r));
    }
    case 'or': {
      const parts = tree.children.map(compilePredicate);
      return (r) => parts.some((p) => p(r));
    }
    case 'not': {
      const p = compilePredicate(tree.child);
      return (r) => !p(r);
    }
    case 'relation':
      // WhereRelation is a v0 gap — no cross-store join at this layer. Match
      // everything so the residual doesn't drop rows; higher layers (or app
      // code) can post-filter with a separate query if needed.
      return ALWAYS_TRUE;
  }
}

function compileLeaf(leaf: WhereLeaf): RowPredicate {
  const { field, op, value, caseInsensitive } = leaf;
  const get = getter(field);

  switch (op) {
    case 'eq':  return (r) => eqValue(get(r), value, caseInsensitive);
    case 'ne':  return (r) => !eqValue(get(r), value, caseInsensitive);
    case 'lt':  return (r) => cmp(get(r), value) <  0;
    case 'lte': return (r) => cmp(get(r), value) <= 0;
    case 'gt':  return (r) => cmp(get(r), value) >  0;
    case 'gte': return (r) => cmp(get(r), value) >= 0;

    case 'in':  return (r) => Array.isArray(value) && value.some((v) => eqValue(get(r), v, caseInsensitive));
    case 'nin': return (r) => Array.isArray(value) && !value.some((v) => eqValue(get(r), v, caseInsensitive));

    case 'contains':   return (r) => stringOp(get(r), value, caseInsensitive, (a, b) => a.includes(b));
    case 'startsWith': return (r) => stringOp(get(r), value, caseInsensitive, (a, b) => a.startsWith(b));
    case 'endsWith':   return (r) => stringOp(get(r), value, caseInsensitive, (a, b) => a.endsWith(b));

    case 'has':      return (r) => Array.isArray(get(r)) && (get(r) as unknown[]).some((x) => eqValue(x, value, caseInsensitive));
    case 'hasSome':  return (r) => Array.isArray(get(r)) && Array.isArray(value) && value.some((v) => (get(r) as unknown[]).some((x) => eqValue(x, v, caseInsensitive)));
    case 'hasEvery': return (r) => Array.isArray(get(r)) && Array.isArray(value) && value.every((v) => (get(r) as unknown[]).some((x) => eqValue(x, v, caseInsensitive)));
    case 'isEmpty':  return (r) => {
      const v = get(r);
      const wantEmpty = !!value;
      const isEmpty = v == null || (Array.isArray(v) && v.length === 0);
      return wantEmpty ? isEmpty : !isEmpty;
    };

    case 'jsonPath': {
      if (!leaf.jsonPath) return () => false;
      const { path, subOp } = leaf.jsonPath;
      const nestedGet = (r: Record<string, unknown>) => walkPath(get(r), path);
      return (r) => {
        const at = nestedGet(r);
        switch (subOp) {
          case 'eq':  return eqValue(at, value);
          case 'ne':  return !eqValue(at, value);
          case 'lt':  return cmp(at, value) <  0;
          case 'lte': return cmp(at, value) <= 0;
          case 'gt':  return cmp(at, value) >  0;
          case 'gte': return cmp(at, value) >= 0;
          case 'contains': return typeof at === 'string' && typeof value === 'string' && at.includes(value);
          case 'in':  return Array.isArray(value) && value.some((v) => eqValue(at, v));
          case 'has': return Array.isArray(at) && (at as unknown[]).some((x) => eqValue(x, value));
          default: return false;
        }
      };
    }

    // Handled by fallback paths, not this compiler:
    case 'search':
    case 'near':
    case 'withinPolygon':
      return ALWAYS_TRUE;
  }
}

function getter(field: string): (r: Record<string, unknown>) => unknown {
  if (!field.includes('.')) return (r) => r[field];
  const parts = field.split('.');
  return (r) => walkPath(r, parts);
}

function walkPath(root: unknown, parts: string[]): unknown {
  let cur: any = root;
  for (const p of parts) {
    if (cur == null) return undefined;
    cur = cur[p];
  }
  return cur;
}

function eqValue(a: unknown, b: unknown, ci?: boolean): boolean {
  if (a === b) return true;
  if (a == null || b == null) return a == b;
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  if (a instanceof Date && typeof b === 'string') return a.getTime() === Date.parse(b);
  if (typeof a === 'string' && typeof b === 'string' && ci) return a.toLowerCase() === b.toLowerCase();
  return false;
}

function cmp(a: unknown, b: unknown): number {
  if (a == null && b == null) return 0;
  if (a == null) return -1;
  if (b == null) return 1;
  if (a instanceof Date && b instanceof Date) return a.getTime() - b.getTime();
  if (a instanceof Date && typeof b === 'string') return a.getTime() - Date.parse(b);
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  if (typeof a === 'string' && typeof b === 'string') return a < b ? -1 : a > b ? 1 : 0;
  return 0;
}

function stringOp(av: unknown, bv: unknown, ci: boolean | undefined, fn: (a: string, b: string) => boolean): boolean {
  if (typeof av !== 'string' || typeof bv !== 'string') return false;
  return ci ? fn(av.toLowerCase(), bv.toLowerCase()) : fn(av, bv);
}
