import { parseDuration } from '../builder/collection';

// Wave 5d — duration parser backing scheduleRefresh().
describe('parseDuration', () => {
  test('parses ms/s/m/h/d units', () => {
    expect(parseDuration('500ms')).toBe(500);
    expect(parseDuration('30s')).toBe(30_000);
    expect(parseDuration('5m')).toBe(300_000);
    expect(parseDuration('1h')).toBe(3_600_000);
    expect(parseDuration('2d')).toBe(172_800_000);
  });
  test('tolerates surrounding whitespace', () => {
    expect(parseDuration('  15m ')).toBe(900_000);
  });
  test('returns undefined for garbage / empty', () => {
    expect(parseDuration('soon')).toBeUndefined();
    expect(parseDuration('')).toBeUndefined();
    expect(parseDuration(undefined)).toBeUndefined();
    expect(parseDuration('10')).toBeUndefined();
  });
});
