import { haversineMeters, applyHaversinePostFilter } from '../adapters/shared/haversine';

describe('Haversine', () => {
  it('returns 0 for identical points', () => {
    expect(haversineMeters({ lng: 3.45, lat: 6.44 }, { lng: 3.45, lat: 6.44 })).toBe(0);
  });
  it('returns ~111 km for 1 degree of latitude at the equator', () => {
    const d = haversineMeters({ lng: 0, lat: 0 }, { lng: 0, lat: 1 });
    expect(d).toBeGreaterThan(110_000);
    expect(d).toBeLessThan(112_000);
  });
  it('correctly measures Lagos → Abuja (~530 km)', () => {
    const d = haversineMeters({ lng: 3.3792, lat: 6.5244 }, { lng: 7.3986, lat: 9.0765 });
    expect(d).toBeGreaterThan(490_000);
    expect(d).toBeLessThan(560_000);
  });
});

describe('applyHaversinePostFilter', () => {
  const point = { lng: 3.45, lat: 6.44 };
  const rows = [
    { id: '1', location: { lng: 3.45, lat: 6.44 } },            // 0 m
    { id: '2', location: { lng: 3.46, lat: 6.44 } },            // ~1.1 km
    { id: '3', location: { lng: 3.5, lat: 6.5 } },              // ~9 km
    { id: '4', location: { lng: 7.4, lat: 9.1 } },              // ~530 km — way outside
    { id: '5', location: null },
    { id: '6', location: '{"lng":3.45,"lat":6.44}' },           // JSON string
    { id: '7', location: { type: 'Point', coordinates: [3.45, 6.44] } }, // GeoJSON
  ];

  it('passes rows within radius + annotates _distanceMeters', () => {
    const out = applyHaversinePostFilter(rows, { field: 'location', point, withinMeters: 5000 }, { field: 'location', point });
    const ids = out.map((r) => r.id);
    expect(ids).toContain('1');
    expect(ids).toContain('2');
    expect(ids).not.toContain('3');
    expect(ids).not.toContain('4');
    expect(out[0].id).toBe('1');                                 // sorted closest-first
    expect(out[0]._distanceMeters).toBe(0);
  });

  it('handles JSON-string + GeoJSON storage forms', () => {
    const out = applyHaversinePostFilter(rows.filter((r) => r.id === '6' || r.id === '7'),
      { field: 'location', point, withinMeters: 100 }, null);
    expect(out).toHaveLength(2);
  });

  it('orderBy alone (no filter) preserves all parseable rows and sorts by distance', () => {
    const out = applyHaversinePostFilter(rows, null, { field: 'location', point });
    // null row stays (no filter rejects it) but with _distanceMeters = null,
    // which sorts to the end.
    expect(out[out.length - 1]._distanceMeters).toBeNull();
    expect(out[0]._distanceMeters).toBe(0);
  });
});
