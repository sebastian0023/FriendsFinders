import * as fc from 'fast-check';
import { cellOf, cellsAround, CELL_SIZE_DEGREES } from '../../src/utils/geo-cells';
import { haversine } from '../../src/utils/distance';

const RUNS = { numRuns: 100 };
const EARTH_RADIUS_MILES = 3958.8;
const NO_LIMIT = 1_000_000; // test the geometry itself, without the fall-back limit

const toRad = (degrees: number) => (degrees * Math.PI) / 180;
const toDeg = (radians: number) => (radians * 180) / Math.PI;

/** The point reached by travelling `miles` from (lat, lng) along `bearing` radians, on a sphere. */
function destination(lat: number, lng: number, bearing: number, miles: number): [number, number] {
  const delta = miles / EARTH_RADIUS_MILES;
  const phi1 = toRad(lat);
  const lambda1 = toRad(lng);
  const phi2 = Math.asin(Math.sin(phi1) * Math.cos(delta) + Math.cos(phi1) * Math.sin(delta) * Math.cos(bearing));
  const lambda2 =
    lambda1 +
    Math.atan2(Math.sin(bearing) * Math.sin(delta) * Math.cos(phi1), Math.cos(delta) - Math.sin(phi1) * Math.sin(phi2));
  return [toDeg(phi2), ((toDeg(lambda2) + 540) % 360) - 180];
}

const lat = fc.double({ min: -89, max: 89, noNaN: true });
const lng = fc.double({ min: -180, max: 180, noNaN: true });
const radius = fc.double({ min: 0.01, max: 40, noNaN: true });

describe('Property: the covering cells contain every point within the radius', () => {
  it('cellOf(any point within the radius) is one of the cells returned', () => {
    fc.assert(
      fc.property(
        lat,
        lng,
        radius,
        fc.double({ min: 0, max: 2 * Math.PI, noNaN: true }),
        fc.double({ min: 0, max: 0.999999, noNaN: true }),
        (pLat, pLng, r, bearing, fraction) => {
          const [qLat, qLng] = destination(pLat, pLng, bearing, r * fraction);

          // sanity check of the test itself: the generated point really is within the radius
          if (haversine(pLat, pLng, qLat, qLng) > r) return true;

          const cells = cellsAround(pLat, pLng, r, NO_LIMIT) as string[];
          return cells.includes(cellOf(qLat, qLng));
        }
      ),
      RUNS
    );
  });

  it('holds right at the edge of the radius', () => {
    fc.assert(
      fc.property(lat, lng, radius, fc.double({ min: 0, max: 2 * Math.PI, noNaN: true }), (pLat, pLng, r, bearing) => {
        const [qLat, qLng] = destination(pLat, pLng, bearing, r * 0.9999);
        const cells = cellsAround(pLat, pLng, r, NO_LIMIT) as string[];
        return cells.includes(cellOf(qLat, qLng));
      }),
      RUNS
    );
  });
});

describe('Property: shape of the covering', () => {
  it('always includes the own cell', () => {
    fc.assert(
      fc.property(lat, lng, radius, (pLat, pLng, r) => {
        return (cellsAround(pLat, pLng, r, NO_LIMIT) as string[]).includes(cellOf(pLat, pLng));
      }),
      RUNS
    );
  });

  it('lists each cell once, in a valid form', () => {
    fc.assert(
      fc.property(lat, lng, radius, (pLat, pLng, r) => {
        const cells = cellsAround(pLat, pLng, r, NO_LIMIT) as string[];
        return (
          new Set(cells).size === cells.length &&
          cells.every((cell) => {
            const [row, column] = cell.split(':').map(Number);
            return /^\d+:\d+$/.test(cell) && row >= 0 && row <= 1800 && column >= 0 && column <= 3599;
          })
        );
      }),
      RUNS
    );
  });

  it('a larger radius covers every cell a smaller one does', () => {
    fc.assert(
      fc.property(lat, lng, radius, radius, (pLat, pLng, r1, r2) => {
        const [small, large] = r1 <= r2 ? [r1, r2] : [r2, r1];
        const inner = cellsAround(pLat, pLng, small, NO_LIMIT) as string[];
        const outer = new Set(cellsAround(pLat, pLng, large, NO_LIMIT) as string[]);
        return inner.every((cell) => outer.has(cell));
      }),
      RUNS
    );
  });

  it('never exceeds the limit: it returns null instead', () => {
    fc.assert(
      fc.property(lat, lng, radius, fc.integer({ min: 1, max: 40 }), (pLat, pLng, r, limit) => {
        const cells = cellsAround(pLat, pLng, r, limit);
        return cells === null || cells.length <= limit;
      }),
      RUNS
    );
  });

  it('returns the same answer every time', () => {
    fc.assert(
      fc.property(lat, lng, radius, (pLat, pLng, r) => {
        return JSON.stringify(cellsAround(pLat, pLng, r)) === JSON.stringify(cellsAround(pLat, pLng, r));
      }),
      RUNS
    );
  });
});

describe('Property: cellOf', () => {
  it('gives the same cell to every point inside one square', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 1799 }),
        fc.integer({ min: 0, max: 3599 }),
        fc.double({ min: 0.01, max: 0.99, noNaN: true }),
        fc.double({ min: 0.01, max: 0.99, noNaN: true }),
        fc.double({ min: 0.01, max: 0.99, noNaN: true }),
        fc.double({ min: 0.01, max: 0.99, noNaN: true }),
        (row, column, a, b, c, d) => {
          const point = (fractionLat: number, fractionLng: number) =>
            cellOf(-90 + (row + fractionLat) * CELL_SIZE_DEGREES, -180 + (column + fractionLng) * CELL_SIZE_DEGREES);
          return point(a, b) === point(c, d);
        }
      ),
      RUNS
    );
  });

  it('stays in range for any valid coordinate', () => {
    fc.assert(
      fc.property(fc.double({ min: -90, max: 90, noNaN: true }), fc.double({ min: -180, max: 180, noNaN: true }), (pLat, pLng) => {
        const [row, column] = cellOf(pLat, pLng).split(':').map(Number);
        return row >= 0 && row <= 1800 && column >= 0 && column <= 3599;
      }),
      RUNS
    );
  });
});
