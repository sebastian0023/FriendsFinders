import { cellOf, cellsAround, CELL_SIZE_DEGREES, MAX_COVERING_CELLS } from '../../src/utils/geo-cells';

// Guadalajara, the project's usual test location.
const GDL = { lat: 20.6597, lng: -103.3496 };

describe('cellOf', () => {
  it('uses 0.1 degree cells', () => {
    expect(CELL_SIZE_DEGREES).toBe(0.1);
  });

  it.each([
    ['Guadalajara', GDL.lat, GDL.lng, '1106:766'],
    ['the equator and prime meridian', 0, 0, '900:1800'],
    ['the south-west corner', -90, -180, '0:0'],
    ['the north pole', 90, 0, '1800:1800'],
    ['just short of the antimeridian', 10, 179.99, '1000:3599'],
    ['an exact cell boundary', 20, -100, '1100:800'],
  ])('puts %s in the right cell', (_name, lat, lng, expected) => {
    expect(cellOf(lat, lng)).toBe(expected);
  });

  it('treats longitude 180 and -180 as the same meridian', () => {
    expect(cellOf(10, 180)).toBe(cellOf(10, -180));
  });

  it('puts nearby points of the same square in the same cell', () => {
    expect(cellOf(20.61, -103.39)).toBe(cellOf(20.69, -103.31));
  });

  it('puts points on either side of a boundary in different cells', () => {
    expect(cellOf(20.0, -103.35)).not.toBe(cellOf(19.9999, -103.35));
    expect(cellOf(20.65, -100)).not.toBe(cellOf(20.65, -100.0001));
  });

  it('produces a key of the form row:column', () => {
    expect(cellOf(-33.8688, 151.2093)).toMatch(/^\d+:\d+$/);
  });
});

describe('cellsAround', () => {
  const cells = (lat: number, lng: number, radius: number, max?: number) => cellsAround(lat, lng, radius, max);

  it('returns just the own cell for a zero radius', () => {
    expect(cells(GDL.lat, GDL.lng, 0)).toEqual([cellOf(GDL.lat, GDL.lng)]);
  });

  it('returns a single cell for a tiny radius in the middle of a cell', () => {
    expect(cells(20.65, -103.35, 0.1)).toEqual(['1106:766']);
  });

  it('covers the default 5 mile radius with a 3 x 3 block around Guadalajara', () => {
    const result = cells(GDL.lat, GDL.lng, 5) as string[];

    const expected: string[] = [];
    for (const row of [1105, 1106, 1107]) for (const col of [765, 766, 767]) expected.push(`${row}:${col}`);
    expect([...result].sort()).toEqual(expected.sort());
  });

  // These pin the covering tightly. An oversized covering would still be correct, only slower, so
  // correctness tests alone cannot notice it. Near the equator a degree is about 69.09 miles, so a
  // half-cell of 0.05 degrees is about 3.45 miles.
  describe('how tight the covering is', () => {
    const CENTRE = { lat: 0.05, lng: 0.05 }; // the middle of cell 900:1800

    it('stays in one cell while the radius fits inside the cell', () => {
      expect(cells(CENTRE.lat, CENTRE.lng, 3.4)).toEqual(['900:1800']);
    });

    it('spills into all the neighbours once the radius passes the half-cell', () => {
      const result = cells(CENTRE.lat, CENTRE.lng, 3.5) as string[];
      const expected: string[] = [];
      for (const row of [899, 900, 901]) for (const col of [1799, 1800, 1801]) expected.push(`${row}:${col}`);
      expect([...result].sort()).toEqual(expected.sort());
    });
  });

  it('always includes the cell the point is in', () => {
    for (const radius of [0.5, 5, 12]) {
      expect(cells(GDL.lat, GDL.lng, radius)).toContain(cellOf(GDL.lat, GDL.lng));
    }
  });

  it('covers more cells as the radius grows, never fewer', () => {
    const small = cells(GDL.lat, GDL.lng, 1) as string[];
    const large = cells(GDL.lat, GDL.lng, 8) as string[];

    for (const cell of small) expect(large).toContain(cell);
    expect(large.length).toBeGreaterThanOrEqual(small.length);
  });

  it('works in the southern and western hemispheres', () => {
    const result = cells(-33.8688, 151.2093, 5) as string[];
    expect(result).toContain(cellOf(-33.8688, 151.2093));
    expect(result.length).toBeGreaterThanOrEqual(1);
  });

  it('never lists a cell twice', () => {
    const result = cells(GDL.lat, GDL.lng, 20, 100) as string[]; // wide enough to need many cells
    expect(result.length).toBeGreaterThan(25);
    expect(new Set(result).size).toBe(result.length);
  });

  describe('the date line', () => {
    it('wraps from the eastern edge to the western edge', () => {
      const result = cells(0, 179.99, 5) as string[];
      expect(result).toContain('900:3599');
      expect(result).toContain('900:0');
    });

    it('wraps from the western edge to the eastern edge', () => {
      const result = cells(0, -179.99, 5) as string[];
      expect(result).toContain('900:0');
      expect(result).toContain('900:3599');
    });

    it('never produces a column outside 0 to 3599', () => {
      for (const lng of [179.99, -179.99, 180, -180]) {
        for (const cell of cells(10, lng, 6) as string[]) {
          const column = Number(cell.split(':')[1]);
          expect(column).toBeGreaterThanOrEqual(0);
          expect(column).toBeLessThanOrEqual(3599);
        }
      }
    });
  });

  describe('when the index cannot be used (the caller falls back to a scan)', () => {
    it('returns null when more cells are needed than the limit', () => {
      expect(MAX_COVERING_CELLS).toBe(25);
      expect(cells(GDL.lat, GDL.lng, 1000)).toBeNull();
    });

    it('honours a custom limit', () => {
      expect(cells(GDL.lat, GDL.lng, 5, 8)).toBeNull(); // needs 9
      expect(cells(GDL.lat, GDL.lng, 5, 9)).toHaveLength(9);
    });

    it.each([
      ['next to the north pole', 89.99, 10, 1],
      ['at the north pole', 90, 0, 5],
      ['at the south pole', -90, 0, 5],
      ['with a circle that contains the pole', 85, 0, 400],
    ])('returns null %s, where every longitude is in range', (_name, lat, lng, radius) => {
      expect(cells(lat, lng, radius)).toBeNull();
    });

    // With the limit lifted, the whole polar cap is listed, and no row falls off either end of the map.
    it.each([
      ['north', 89.99],
      ['south', -89.99],
    ])('keeps every row on the map near the %s pole', (_hemisphere, lat) => {
      const result = cells(lat, 0, 5, 100_000) as string[];
      const rows = result.map((cell) => Number(cell.split(':')[0]));
      expect(Math.min(...rows)).toBeGreaterThanOrEqual(0);
      expect(Math.max(...rows)).toBeLessThanOrEqual(1800);
      expect(result.length).toBeGreaterThan(3000); // every longitude
    });

    it.each([NaN, -1, Infinity, -Infinity])('returns null for an invalid radius (%p)', (radius) => {
      expect(cells(GDL.lat, GDL.lng, radius)).toBeNull();
    });
  });

  it('still uses the index at high latitudes, where cells are narrower', () => {
    const result = cells(75, 0, 5);
    expect(result).not.toBeNull();
    expect(result).toContain(cellOf(75, 0));
    expect((result as string[]).length).toBeGreaterThan(9); // more columns are needed up north
  });
});
