import * as fc from 'fast-check';
import { validateLocationUpdate } from '../../src/utils/validation';

const RUNS = { numRuns: 100 };

const goodLat = fc.double({ min: -90, max: 90, noNaN: true });
const goodLng = fc.double({ min: -180, max: 180, noNaN: true });
const timestamp = fc.string({ minLength: 1 });

describe('Property 3: Coordinate validation', () => {
  it('accepts every in-range coordinate pair with a timestamp', () => {
    fc.assert(
      fc.property(goodLat, goodLng, timestamp, (latitude, longitude, ts) => {
        return validateLocationUpdate({ latitude, longitude, timestamp: ts }).valid === true;
      }),
      RUNS
    );
  });

  it('rejects any latitude outside [-90, 90]', () => {
    const badLat = fc.oneof(
      fc.double({ min: 90, max: 1e6, noNaN: true, minExcluded: true }),
      fc.double({ min: -1e6, max: -90, noNaN: true, maxExcluded: true })
    );
    fc.assert(
      fc.property(badLat, goodLng, timestamp, (latitude, longitude, ts) => {
        const result = validateLocationUpdate({ latitude, longitude, timestamp: ts });
        return result.valid === false && result.error === 'latitude must be between -90 and 90';
      }),
      RUNS
    );
  });

  it('rejects any longitude outside [-180, 180]', () => {
    const badLng = fc.oneof(
      fc.double({ min: 180, max: 1e6, noNaN: true, minExcluded: true }),
      fc.double({ min: -1e6, max: -180, noNaN: true, maxExcluded: true })
    );
    fc.assert(
      fc.property(goodLat, badLng, timestamp, (latitude, longitude, ts) => {
        const result = validateLocationUpdate({ latitude, longitude, timestamp: ts });
        return result.valid === false && result.error === 'longitude must be between -180 and 180';
      }),
      RUNS
    );
  });

  it('rejects non-finite coordinates', () => {
    const nonFinite = fc.constantFrom(NaN, Infinity, -Infinity);
    fc.assert(
      fc.property(nonFinite, goodLng, timestamp, (latitude, longitude, ts) => {
        return validateLocationUpdate({ latitude, longitude, timestamp: ts }).valid === false;
      }),
      RUNS
    );
    fc.assert(
      fc.property(goodLat, nonFinite, timestamp, (latitude, longitude, ts) => {
        return validateLocationUpdate({ latitude, longitude, timestamp: ts }).valid === false;
      }),
      RUNS
    );
  });

  it('never throws, whatever the input', () => {
    fc.assert(
      fc.property(fc.anything(), (body) => {
        const result = validateLocationUpdate(body);
        return typeof result.valid === 'boolean';
      }),
      RUNS
    );
  });
});
