// Haversine distance for fallback geoPoint mode.
//
// When a geoPoint field is declared with `fallback: true`, the column is
// stored as JSON `{lng, lat}` and the SQL compiler emits a bounding-box
// pre-filter on the JSON-extracted lng/lat columns. That filter is over-
// inclusive (it returns rows in a square that circumscribes the search
// circle). This module post-filters those rows to the exact circle and
// annotates each row with `_distanceMeters`.
//
// Used by SQL adapter executors when a `near` filter or `nearTo` orderBy
// references a fallback geoPoint field.

import type { SelectNode } from '../../ir/types';
import type { ModelDef } from '../../schema/types';

const EARTH_R_METERS = 6_371_008.8;

export interface FallbackGeoOps {
  near: { field: string; point: { lng: number; lat: number }; withinMeters?: number } | null;
  nearTo: { field: string; point: { lng: number; lat: number } } | null;
  withinPolygon: { field: string; polygon: Array<{ lng: number; lat: number }> } | null;
}

/**
 * Point-in-polygon test via ray-casting. Polygon is a closed ring of
 * { lng, lat } vertices (first = last). Used in fallback mode to refine
 * the SQL-emitted bbox prefilter to the exact polygon shape.
 */
export function pointInPolygon(
  point: { lng: number; lat: number },
  polygon: Array<{ lng: number; lat: number }>,
): boolean {
  let inside = false;
  const x = point.lng, y = point.lat;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = polygon[i].lng, yi = polygon[i].lat;
    const xj = polygon[j].lng, yj = polygon[j].lat;
    const intersects = ((yi > y) !== (yj > y))
      && (x < (xj - xi) * (y - yi) / (yj - yi) + xi);
    if (intersects) inside = !inside;
  }
  return inside;
}

/**
 * Walk a SelectNode and extract any geo ops (near filter, nearTo orderBy)
 * targeting a fallback-mode geoPoint field. Returns nulls when no fallback
 * geo ops are present — executors can skip the post-filter entirely.
 *
 * Used by every SQL executor (PG / MySQL / SQLite / DuckDB / MSSQL) when
 * the SELECT has fallback geo columns; the compile path emits a bbox
 * pre-filter only, this fills in the Haversine refinement.
 */
export function extractFallbackGeoOps(
  node: SelectNode,
  model: ModelDef<any>,
): FallbackGeoOps {
  let near: FallbackGeoOps['near'] = null;
  let nearTo: FallbackGeoOps['nearTo'] = null;
  let withinPolygon: FallbackGeoOps['withinPolygon'] = null;
  walkWhere(node.where, (leaf) => {
    const fld = model.fields[(leaf as any).field];
    if (!(fld?.kind === 'geoPoint' && fld.geo?.fallback)) return;
    if ((leaf as any).op === 'near') {
      const v = (leaf as any).value;
      near = { field: (leaf as any).field, point: { lng: v.lng, lat: v.lat }, withinMeters: v.withinMeters };
    } else if ((leaf as any).op === 'withinPolygon') {
      withinPolygon = { field: (leaf as any).field, polygon: (leaf as any).value.polygon };
    }
  });
  const nt = node.orderBy?.find((e) => e.nearTo);
  if (nt) {
    const fld = model.fields[nt.field];
    // Only geo nearTo participates in Haversine fallback; vector nearTo is
    // ignored here (vectors don't have a fallback ANN path in this layer).
    const ntVal = nt.nearTo as { lng?: number; lat?: number; vector?: number[] } | undefined;
    if (fld?.kind === 'geoPoint' && fld.geo?.fallback
        && ntVal && typeof ntVal.lng === 'number' && typeof ntVal.lat === 'number') {
      nearTo = { field: nt.field, point: { lng: ntVal.lng, lat: ntVal.lat } };
    }
  }
  return { near, nearTo, withinPolygon };
}

function walkWhere(tree: any, cb: (leaf: any) => void): void {
  if (!tree) return;
  if (tree.kind === 'leaf') return cb(tree);
  if (tree.kind === 'and' || tree.kind === 'or') tree.children.forEach((c: any) => walkWhere(c, cb));
  if (tree.kind === 'not') walkWhere(tree.child, cb);
}

/** Great-circle distance between two lat/lng points in meters. */
export function haversineMeters(
  a: { lng: number; lat: number },
  b: { lng: number; lat: number },
): number {
  const toRad = (d: number) => d * Math.PI / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h = Math.sin(dLat / 2) ** 2
          + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_R_METERS * Math.asin(Math.min(1, Math.sqrt(h)));
}

interface FallbackOp {
  field: string;
  point: { lng: number; lat: number };
  withinMeters?: number;
}

interface PolygonOp {
  field: string;
  polygon: Array<{ lng: number; lat: number }>;
}

/**
 * Post-process rows returned by a fallback-mode query:
 *   1. Compute `_distanceMeters` for the search point.
 *   2. Drop rows outside `withinMeters` (the bbox prefilter is over-inclusive).
 *   3. Drop rows outside the polygon (point-in-polygon refinement).
 *   4. Sort by distance if a `nearTo` orderBy is present.
 *
 * The field value on each row may be a JSON string (SQLite, MySQL fallback)
 * or an object (PG jsonb); we accept either.
 */
export function applyHaversinePostFilter(
  rows: any[],
  filter: FallbackOp | null,
  orderBy: FallbackOp | null,
  polygon: PolygonOp | null = null,
): any[] {
  if (!filter && !orderBy && !polygon) return rows;
  const ref = (filter ?? orderBy)!;
  const radius = filter?.withinMeters;

  const out: any[] = [];
  for (const row of rows) {
    const fieldName = ref?.field ?? polygon?.field;
    if (!fieldName) continue;
    const raw = row[fieldName];
    const pt = parsePoint(raw);
    if (!pt) {
      if (orderBy) row._distanceMeters = null;
      if (!filter && !polygon) out.push(row);
      continue;
    }
    // Polygon refinement (exact point-in-polygon).
    if (polygon && !pointInPolygon(pt, polygon.polygon)) continue;
    // Distance filter / annotation.
    if (ref) {
      const d = haversineMeters(pt, ref.point);
      if (filter && radius !== undefined && d > radius) continue;
      if (orderBy) row._distanceMeters = d;
    }
    out.push(row);
  }

  if (orderBy) {
    out.sort((a, b) => {
      const da = a._distanceMeters ?? Number.POSITIVE_INFINITY;
      const db = b._distanceMeters ?? Number.POSITIVE_INFINITY;
      return da - db;
    });
  }
  return out;
}

function parsePoint(v: unknown): { lng: number; lat: number } | null {
  if (v == null) return null;
  let obj: any = v;
  if (typeof v === 'string') {
    try { obj = JSON.parse(v); } catch { return null; }
  }
  if (typeof obj !== 'object') return null;
  if (typeof obj.lng === 'number' && typeof obj.lat === 'number') return { lng: obj.lng, lat: obj.lat };
  // Accept GeoJSON Point form as a courtesy (Mongo storage shape).
  if (obj.type === 'Point' && Array.isArray(obj.coordinates) && obj.coordinates.length >= 2) {
    return { lng: Number(obj.coordinates[0]), lat: Number(obj.coordinates[1]) };
  }
  return null;
}
