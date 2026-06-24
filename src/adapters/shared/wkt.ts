// WKT (Well-Known Text) helpers for SQL geo dialects.
//
// The IR normalises every withinPolygon input to a uniform MultiPolygon shape
// (Array of Polygons, each Polygon = Array of Rings, each Ring = closed
// Array<{lng,lat}>). These helpers convert that to the WKT strings the
// dialect compile sites embed in ST_GeomFromText / GeomFromText / etc.
//
// Two forms:
//   • toMultiPolygonWKT — `MULTIPOLYGON(((lng lat,…),(lng lat,…)),((…)))` —
//     used by every SQL dialect when the input has > 1 polygon OR any
//     polygon has > 1 ring (holes).
//   • toPolygonWKT      — `POLYGON((lng lat,…),(lng lat,…))` —
//     emitted when there's exactly one polygon (with possibly holes). Many
//     legacy geo functions are happy with POLYGON; emitting it keeps
//     query plans on the well-trodden path for the common single-shape case.
//
// MySQL's coord order is lat-first (`POINT(lat lng)`) for SRID 4326 — handled
// by an `axisOrder` flag the dialect passes when calling.

export type WktAxis = 'lng-lat' | 'lat-lng';

export type Ring = Array<{ lng: number; lat: number }>;
export type Polygon = Ring[];
export type MultiPolygon = Polygon[];

function ringWKT(ring: Ring, axis: WktAxis): string {
  return ring.map((p) => axis === 'lat-lng' ? `${p.lat} ${p.lng}` : `${p.lng} ${p.lat}`).join(', ');
}

function polygonWKTBody(polygon: Polygon, axis: WktAxis): string {
  return polygon.map((r) => `(${ringWKT(r, axis)})`).join(', ');
}

export function toMultiPolygonWKT(mp: MultiPolygon, axis: WktAxis = 'lng-lat'): string {
  if (mp.length === 0) throw new Error('[forge:wkt] empty MultiPolygon');
  return `MULTIPOLYGON(${mp.map((p) => `(${polygonWKTBody(p, axis)})`).join(', ')})`;
}

export function toPolygonWKT(polygon: Polygon, axis: WktAxis = 'lng-lat'): string {
  return `POLYGON(${polygonWKTBody(polygon, axis)})`;
}

// Pick the cleanest WKT form for this MultiPolygon. Single polygon + single
// ring → POLYGON; everything else → MULTIPOLYGON (handles holes + multi-shape).
export function toGeoWKT(mp: MultiPolygon, axis: WktAxis = 'lng-lat'): string {
  if (mp.length === 1) return toPolygonWKT(mp[0], axis);
  return toMultiPolygonWKT(mp, axis);
}

// Compute the union bounding box across every polygon and ring. Used by the
// SQL fallback path to emit a B-tree-prefilter on the JSON {lng,lat} columns
// before the in-app ray-cast refines to the exact shape.
export function multiPolygonBbox(mp: MultiPolygon): { minLng: number; maxLng: number; minLat: number; maxLat: number } {
  let minLng = Infinity, maxLng = -Infinity, minLat = Infinity, maxLat = -Infinity;
  for (const polygon of mp) {
    for (const ring of polygon) {
      for (const p of ring) {
        if (p.lng < minLng) minLng = p.lng;
        if (p.lng > maxLng) maxLng = p.lng;
        if (p.lat < minLat) minLat = p.lat;
        if (p.lat > maxLat) maxLat = p.lat;
      }
    }
  }
  return { minLng, maxLng, minLat, maxLat };
}

// GeoJSON form for Mongo. Single polygon → 'Polygon' + coordinates: Ring[];
// many polygons → 'MultiPolygon' + coordinates: Polygon[]. Mongo expects
// `[lng, lat]` pairs.
export function toGeoJson(mp: MultiPolygon): { type: 'Polygon' | 'MultiPolygon'; coordinates: unknown[] } {
  if (mp.length === 1) {
    return {
      type: 'Polygon',
      coordinates: mp[0].map((ring) => ring.map((p) => [p.lng, p.lat])),
    };
  }
  return {
    type: 'MultiPolygon',
    coordinates: mp.map((polygon) => polygon.map((ring) => ring.map((p) => [p.lng, p.lat]))),
  };
}
