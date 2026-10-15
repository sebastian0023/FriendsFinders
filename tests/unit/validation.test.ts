import { validateLocationUpdate } from '../../src/utils/validation';

const valid = { latitude: 20.6597, longitude: -103.3496, timestamp: '2026-10-15T12:00:00.000Z' };

describe('validateLocationUpdate', () => {
  it('accepts a well-formed message', () => {
    expect(validateLocationUpdate(valid)).toEqual({ valid: true });
  });

  it('accepts the boundary values of both ranges', () => {
    expect(validateLocationUpdate({ ...valid, latitude: 90, longitude: 180 }).valid).toBe(true);
    expect(validateLocationUpdate({ ...valid, latitude: -90, longitude: -180 }).valid).toBe(true);
  });

  it.each([null, undefined, 'a string', 42, true])('rejects a non-object body (%p)', (body) => {
    expect(validateLocationUpdate(body)).toEqual({ valid: false, error: 'Invalid message body' });
  });

  it.each([NaN, Infinity, -Infinity, '20.6', null, undefined])(
    'rejects a non-finite or non-number latitude (%p)',
    (latitude) => {
      const result = validateLocationUpdate({ ...valid, latitude });
      expect(result).toEqual({ valid: false, error: 'latitude must be a finite number' });
    }
  );

  it.each([NaN, Infinity, -Infinity, '-103.3', null, undefined])(
    'rejects a non-finite or non-number longitude (%p)',
    (longitude) => {
      const result = validateLocationUpdate({ ...valid, longitude });
      expect(result).toEqual({ valid: false, error: 'longitude must be a finite number' });
    }
  );

  it.each([90.0001, -90.0001, 1000])('rejects latitude out of range (%p)', (latitude) => {
    expect(validateLocationUpdate({ ...valid, latitude })).toEqual({
      valid: false,
      error: 'latitude must be between -90 and 90',
    });
  });

  it.each([180.0001, -180.0001, 1000])('rejects longitude out of range (%p)', (longitude) => {
    expect(validateLocationUpdate({ ...valid, longitude })).toEqual({
      valid: false,
      error: 'longitude must be between -180 and 180',
    });
  });

  it.each([undefined, '', 12345, null])('rejects a missing or non-string timestamp (%p)', (timestamp) => {
    expect(validateLocationUpdate({ ...valid, timestamp })).toEqual({
      valid: false,
      error: 'timestamp is required and must be a string',
    });
  });

  it('reports the latitude problem first when several fields are bad', () => {
    const result = validateLocationUpdate({ latitude: NaN, longitude: NaN, timestamp: '' });
    expect(result.error).toBe('latitude must be a finite number');
  });
});
