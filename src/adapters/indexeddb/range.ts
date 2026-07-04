// IDBKeyRange builders.
//
// The query planner picks ONE where-leaf to become the IDB range scan; every
// other leaf becomes a JS predicate applied per-row on the cursor. So this
// module only translates individual leaves — it never sees the whole tree.
//
// IDB key comparison (Structured Clone Key algorithm) orders:
//   number < Date < string < binary < array
// Types compare by category first, then within category by value. `in` on a
// single-column index becomes a UNION of point ranges, not one range.

import type { WhereLeaf } from '../../ir/types';

export interface RangePlan {
  /** IDB range to feed openCursor / getAll. `null` = scan all. */
  range: IDBKeyRange | null;
  /** If set, the range covers >1 point — the planner unions results across them. */
  ranges?: IDBKeyRange[];
  direction: IDBCursorDirection;
}

/**
 * Convert a single leaf to an IDB range plan when the leaf targets an
 * indexed column. Returns null when the operator can't be expressed as a
 * key range — the caller must fall back to a full-table scan.
 */
export function leafToRange(leaf: WhereLeaf): RangePlan | null {
  const { op, value } = leaf;
  switch (op) {
    case 'eq':
      // `null`/`undefined` don't index in IDB — they store but a range on
      // them is a footgun. Fall back to predicate.
      if (value === null || value === undefined) return null;
      return { range: IDBKeyRange.only(value as IDBValidKey), direction: 'next' };

    case 'in': {
      if (!Array.isArray(value) || value.length === 0) return null;
      const ranges = value
        .filter((v) => v !== null && v !== undefined)
        .map((v) => IDBKeyRange.only(v as IDBValidKey));
      if (ranges.length === 0) return null;
      return { range: ranges[0], ranges, direction: 'next' };
    }

    case 'lt':
      return { range: IDBKeyRange.upperBound(value as IDBValidKey, true), direction: 'next' };
    case 'lte':
      return { range: IDBKeyRange.upperBound(value as IDBValidKey, false), direction: 'next' };
    case 'gt':
      return { range: IDBKeyRange.lowerBound(value as IDBValidKey, true), direction: 'next' };
    case 'gte':
      return { range: IDBKeyRange.lowerBound(value as IDBValidKey, false), direction: 'next' };

    case 'startsWith': {
      // Prefix scan trick: 'foo' → range ['foo', 'foo￿')
      if (typeof value !== 'string') return null;
      const lower = value;
      const upper = value + '￿';
      return {
        range: IDBKeyRange.bound(lower, upper, false, true),
        direction: 'next',
      };
    }

    // ne / contains / endsWith / has / hasSome / hasEvery / isEmpty / jsonPath /
    // search / near / withinPolygon: no key-range form — predicate scan only.
    default:
      return null;
  }
}

/**
 * Combine leaves that target the SAME compound-index prefix into one range.
 * E.g. an index on `[org_id, status]` + where `{ org_id: 'X', status: 'ok' }`
 * → a compound `IDBKeyRange.only(['X', 'ok'])`.
 */
export function compoundEqualityRange(values: IDBValidKey[]): RangePlan {
  return { range: IDBKeyRange.only(values as unknown as IDBValidKey), direction: 'next' };
}

export function compoundPrefixRange(prefix: IDBValidKey[]): RangePlan {
  // e.g. index ['a','b','c'] + prefix ['X','Y'] → ['X','Y',-Inf]..['X','Y',+Inf]
  const lower = [...prefix, -Infinity];
  const upper = [...prefix, 'zzzzzzzzzz￿'];
  return {
    range: IDBKeyRange.bound(lower as unknown as IDBValidKey, upper as unknown as IDBValidKey, false, false),
    direction: 'next',
  };
}
