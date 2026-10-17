import { EARTH_RADIUS_MILES } from './distance';

// The map is cut into a grid of squares 0.1 degrees on a side (about 7 miles). Each connection is
// stored with the key of the square it is in, so the people near a point can be found by looking
// at a few squares instead of reading the whole table.

export const CELL_SIZE_DEGREES = 0.1;

/** More squares than this means the area is too wide for the index; callers fall back to a scan. */
export const MAX_COVERING_CELLS = 25;

const CELLS_PER_DEGREE = 10; // 1 / CELL_SIZE_DEGREES, kept as a whole number so the maths stays exact
const COLUMNS = 360 * CELLS_PER_DEGREE;

// Added to every edge of the search area so rounding can never lose a point that sits exactly on it.
const MARGIN_DEGREES = 1e-6;

const toRadians = (degrees: number) => (degrees * Math.PI) / 180;
const toDegrees = (radians: number) => (radians * 180) / Math.PI;

const rowOf = (latitude: number) => Math.floor((latitude + 90) * CELLS_PER_DEGREE);
const columnOf = (longitude: number) => Math.floor((longitude + 180) * CELLS_PER_DEGREE);
const wrap = (column: number) => ((column % COLUMNS) + COLUMNS) % COLUMNS; // -180 and 180 are the same meridian

/** The key of the square containing a point, as "row:column". */
export function cellOf(latitude: number, longitude: number): string {
  return `${rowOf(latitude)}:${wrap(columnOf(longitude))}`;
}

/**
 * The keys of every square that can contain a point within `radiusMiles` of the given point, or
 * null when that would take more than `maxCells` squares (a very large radius, or a circle that
 * reaches a pole where every longitude is in range), in which case the caller should not use the
 * grid. Every point within the radius is guaranteed to be in one of the squares returned.
 */
export function cellsAround(
  latitude: number,
  longitude: number,
  radiusMiles: number,
  maxCells: number = MAX_COVERING_CELLS
): string[] | null {
  if (!Number.isFinite(radiusMiles) || radiusMiles < 0) return null;

  const angle = radiusMiles / EARTH_RADIUS_MILES; // the radius as an angle at the centre of the Earth, in radians
  const phi = toRadians(latitude);

  // Rows. Moving a distance along a meridian changes latitude by exactly that angle, and no other
  // direction changes it faster, so this is the tightest latitude range that is always sufficient.
  const latitudeSpan = toDegrees(angle) + MARGIN_DEGREES;
  const firstRow = rowOf(Math.max(-90, latitude - latitudeSpan));
  const lastRow = rowOf(Math.min(90, latitude + latitudeSpan));

  // Columns. The widest a circle gets in longitude is asin(sin(angle) / cos(latitude)), unless the
  // circle reaches a pole, in which case it spans every longitude.
  let firstColumn: number;
  let lastColumn: number;
  const reachesPole = Math.abs(phi) + angle >= Math.PI / 2;
  if (reachesPole) {
    firstColumn = 0;
    lastColumn = COLUMNS - 1;
  } else {
    const longitudeSpan = toDegrees(Math.asin(Math.min(1, Math.sin(angle) / Math.cos(phi)))) + MARGIN_DEGREES;
    // Without a pole in range this is always under 180 degrees either side, so it never wraps fully round.
    firstColumn = columnOf(longitude - longitudeSpan);
    lastColumn = columnOf(longitude + longitudeSpan);
  }

  const rows = lastRow - firstRow + 1;
  const columns = lastColumn - firstColumn + 1;
  if (rows * columns > maxCells) return null;

  const cells = new Set<string>();
  for (let row = firstRow; row <= lastRow; row++) {
    for (let column = firstColumn; column <= lastColumn; column++) {
      cells.add(`${row}:${wrap(column)}`); // columns past the date line wrap round to the other side
    }
  }
  return [...cells];
}
