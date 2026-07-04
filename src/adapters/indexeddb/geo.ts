// Geo fallback — Haversine + point-in-polygon.
//
// Mirror of adapters/shared/haversine.ts, kept local so the IDB adapter
// stays tree-shakable — server bundles that don't import
// `forge-orm/indexeddb` never pull this file. IDB has no spatial index,
// so `near` / `withinPolygon` are cursor-scan + JS post-filter. A
// `[lng, lat]` compound index (when the schema declares one) cuts most
// rows out via a bbox prefilter.

export interface Point { lng: number; lat: number; alt?: number; }
export type Ring = Point[];
export type Polygon = Ring[];
export type MultiPolygon = Polygon[];

const R_METERS = 6_371_008.8;

export function haversineMeters(a: Point, b: Point): number {
  const φ1 = (a.lat * Math.PI) / 180;
  const φ2 = (b.lat * Math.PI) / 180;
  const dφ = ((b.lat - a.lat) * Math.PI) / 180;
  const dλ = ((b.lng - a.lng) * Math.PI) / 180;
  const s = Math.sin(dφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(dλ / 2) ** 2;
  return 2 * R_METERS * Math.asin(Math.min(1, Math.sqrt(s)));
}

export function pointInMultiPolygon(mp: MultiPolygon, p: Point): boolean {
  for (const poly of mp) {
    if (poly.length === 0) continue;
    const [outer, ...holes] = poly;
    if (!pointInRing(outer, p)) continue;
    if (holes.some((h) => pointInRing(h, p))) continue;
    return true;
  }
  return false;
}

function pointInRing(ring: Ring, p: Point): boolean {
  let inside = false;
  const n = ring.length;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = ring[i].lng, yi = ring[i].lat;
    const xj = ring[j].lng, yj = ring[j].lat;
    const intersect =
      yi > p.lat !== yj > p.lat &&
      p.lng < ((xj - xi) * (p.lat - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}
