import { haversine, isNearby } from '../../src/utils/distance';

const EARTH_RADIUS_MILES = 3958.8;

describe('haversine', () => {
  it('returns 0 for identical points', () => {
    expect(haversine(20.6597, -103.3496, 20.6597, -103.3496)).toBe(0);
  });

  it('measures one degree of latitude as ~69.09 miles', () => {
    const expected = (EARTH_RADIUS_MILES * Math.PI) / 180;
    expect(haversine(0, 0, 1, 0)).toBeCloseTo(expected, 6);
  });

  it('measures half the Earth circumference between antipodal points', () => {
    expect(haversine(0, 0, 0, 180)).toBeCloseTo(EARTH_RADIUS_MILES * Math.PI, 6);
  });

  it('matches a known city pair (Los Angeles to New York, ~2445 miles)', () => {
    const miles = haversine(34.0522, -118.2437, 40.7128, -74.006);
    expect(Math.abs(miles - 2445)).toBeLessThan(10);
  });

  it('is symmetric', () => {
    const ab = haversine(51.5074, -0.1278, 48.8566, 2.3522);
    const ba = haversine(48.8566, 2.3522, 51.5074, -0.1278);
    expect(ab).toBeCloseTo(ba, 9);
  });

  it('handles the antimeridian (179 to -179 longitude is a short hop)', () => {
    expect(haversine(0, 179, 0, -179)).toBeCloseTo((EARTH_RADIUS_MILES * 2 * Math.PI) / 180, 6);
  });
});

describe('isNearby', () => {
  const home: [number, number] = [20.6597, -103.3496];
  const nearby: [number, number] = [20.6697, -103.3496]; // ~0.69 miles north
  const far: [number, number] = [21.6597, -103.3496]; // ~69 miles north

  it('is true when inside the radius', () => {
    expect(isNearby(...home, ...nearby, 5)).toBe(true);
  });

  it('is false when outside the radius', () => {
    expect(isNearby(...home, ...far, 5)).toBe(false);
  });

  it('is inclusive at the exact boundary', () => {
    const exact = haversine(...home, ...nearby);
    expect(isNearby(...home, ...nearby, exact)).toBe(true);
  });

  it('is false just under the boundary', () => {
    const exact = haversine(...home, ...nearby);
    expect(isNearby(...home, ...nearby, exact - 1e-9)).toBe(false);
  });

  it('treats a zero radius as only the same point', () => {
    expect(isNearby(...home, ...home, 0)).toBe(true);
    expect(isNearby(...home, ...nearby, 0)).toBe(false);
  });
});
