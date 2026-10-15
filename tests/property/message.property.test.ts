import * as fc from 'fast-check';
import { buildLocationPush, buildInitResponse, parseLocationUpdate } from '../../src/utils/message-utils';

const RUNS = { numRuns: 100 };

// JSON has no negative zero (JSON.stringify(-0) === "0"), so keep it out of round-trip inputs.
const noNegativeZero = (n: number): number => (n === 0 ? 0 : n);

const lat = fc.double({ min: -90, max: 90, noNaN: true }).map(noNegativeZero);
const lng = fc.double({ min: -180, max: 180, noNaN: true }).map(noNegativeZero);
const distance = fc.double({ min: 0, max: 13000, noNaN: true }).map(noNegativeZero);

describe('Property 23: Message serialization round-trip', () => {
  it('location.push survives JSON serialization unchanged', () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1 }), lat, lng, fc.string(), distance, (id, la, lo, updated, d) => {
        const msg = buildLocationPush(id, la, lo, updated, d);
        expect(JSON.parse(JSON.stringify(msg))).toEqual(msg);
      }),
      RUNS
    );
  });

  it('location.push distance is rounded to two decimals and within 0.005 of the input', () => {
    fc.assert(
      fc.property(distance, (d) => {
        const rounded = buildLocationPush('f', 0, 0, 't', d).distanceMiles;
        return Math.abs(rounded - d) <= 0.005 + 1e-9 && Math.round(rounded * 100) / 100 === rounded;
      }),
      RUNS
    );
  });

  it('init.response survives JSON serialization unchanged', () => {
    const entry = fc.record({
      friendId: fc.string({ minLength: 1 }),
      latitude: lat,
      longitude: lng,
      lastUpdated: fc.string(),
      distanceMiles: distance,
    });
    fc.assert(
      fc.property(fc.array(entry, { maxLength: 20 }), (friends) => {
        const msg = buildInitResponse(friends);
        expect(JSON.parse(JSON.stringify(msg))).toEqual(msg);
      }),
      RUNS
    );
  });

  it('parseLocationUpdate recovers the fields of a serialized update', () => {
    fc.assert(
      fc.property(lat, lng, fc.string({ minLength: 1 }), (latitude, longitude, ts) => {
        const parsed = parseLocationUpdate(JSON.stringify({ latitude, longitude, timestamp: ts }));
        expect(parsed).toEqual({ action: 'location.update', latitude, longitude, timestamp: ts });
      }),
      RUNS
    );
  });
});
