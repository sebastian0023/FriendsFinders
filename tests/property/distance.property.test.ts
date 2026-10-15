import * as fc from 'fast-check';
import { haversine, isNearby } from '../../src/utils/distance';

const RUNS = { numRuns: 100 };
const EARTH_RADIUS_MILES = 3958.8;
const MAX_DISTANCE = Math.PI * EARTH_RADIUS_MILES; // half the circumference

// Haversine loses precision near antipodal points (sqrt(1 - a) with a ~ 1), where
// results can be off by ~1e-4 miles (a few cm). 1e-3 miles (~1.6 m) is still far
// below any real GPS accuracy, so it keeps the properties meaningful without flakiness.
const TOLERANCE = 1e-3;

const lat = fc.double({ min: -90, max: 90, noNaN: true });
const lng = fc.double({ min: -180, max: 180, noNaN: true });
const point = fc.tuple(lat, lng);

describe('Property 5: Haversine mathematical properties', () => {
  it('is non-negative and never exceeds half the Earth circumference', () => {
    fc.assert(
      fc.property(point, point, ([la1, lo1], [la2, lo2]) => {
        const d = haversine(la1, lo1, la2, lo2);
        return d >= 0 && d <= MAX_DISTANCE + TOLERANCE;
      }),
      RUNS
    );
  });

  it('is symmetric', () => {
    fc.assert(
      fc.property(point, point, ([la1, lo1], [la2, lo2]) => {
        return Math.abs(haversine(la1, lo1, la2, lo2) - haversine(la2, lo2, la1, lo1)) < TOLERANCE;
      }),
      RUNS
    );
  });

  it('is zero for identical points', () => {
    fc.assert(fc.property(point, ([la, lo]) => haversine(la, lo, la, lo) === 0), RUNS);
  });

  it('satisfies the triangle inequality', () => {
    fc.assert(
      fc.property(point, point, point, ([la1, lo1], [la2, lo2], [la3, lo3]) => {
        const direct = haversine(la1, lo1, la3, lo3);
        const viaMiddle = haversine(la1, lo1, la2, lo2) + haversine(la2, lo2, la3, lo3);
        return direct <= viaMiddle + TOLERANCE;
      }),
      RUNS
    );
  });
});

describe('Property 6: Nearby classification matches distance comparison', () => {
  it('isNearby is exactly haversine <= radius', () => {
    fc.assert(
      fc.property(point, point, fc.double({ min: 0, max: 13000, noNaN: true }), ([la1, lo1], [la2, lo2], radius) => {
        return isNearby(la1, lo1, la2, lo2, radius) === haversine(la1, lo1, la2, lo2) <= radius;
      }),
      RUNS
    );
  });

  it('a point is always within its own computed distance', () => {
    fc.assert(
      fc.property(point, point, ([la1, lo1], [la2, lo2]) => {
        return isNearby(la1, lo1, la2, lo2, haversine(la1, lo1, la2, lo2));
      }),
      RUNS
    );
  });
});
