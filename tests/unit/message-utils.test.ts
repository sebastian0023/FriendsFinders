import { parseLocationUpdate, buildLocationPush, buildInitResponse } from '../../src/utils/message-utils';

describe('parseLocationUpdate', () => {
  it('maps a JSON body to a location.update message', () => {
    const body = JSON.stringify({ latitude: 1.5, longitude: -2.5, timestamp: '2026-10-15T12:00:00.000Z' });
    expect(parseLocationUpdate(body)).toEqual({
      action: 'location.update',
      latitude: 1.5,
      longitude: -2.5,
      timestamp: '2026-10-15T12:00:00.000Z',
    });
  });

  it('forces the action to location.update and drops unknown fields', () => {
    const body = JSON.stringify({ action: 'other', latitude: 1, longitude: 2, timestamp: 't', extra: 'x' });
    const parsed = parseLocationUpdate(body);
    expect(parsed.action).toBe('location.update');
    expect(parsed).not.toHaveProperty('extra');
  });

  it('throws on malformed JSON', () => {
    expect(() => parseLocationUpdate('{not json')).toThrow(SyntaxError);
  });

  // parseLocationUpdate does not validate; validateLocationUpdate does that afterwards.
  it('passes missing fields through as undefined', () => {
    const parsed = parseLocationUpdate('{}');
    expect(parsed.latitude).toBeUndefined();
    expect(parsed.timestamp).toBeUndefined();
  });
});

describe('buildLocationPush', () => {
  it('builds a location.push message', () => {
    expect(buildLocationPush('friend-1', 10, 20, '2026-10-15T12:00:00.000Z', 1.23)).toEqual({
      type: 'location.push',
      friendId: 'friend-1',
      latitude: 10,
      longitude: 20,
      lastUpdated: '2026-10-15T12:00:00.000Z',
      distanceMiles: 1.23,
    });
  });

  it.each([
    [3.14159, 3.14],
    [2.999, 3],
    [0, 0],
    [0.004, 0],
    [0.006, 0.01],
    [12, 12],
  ])('rounds distance %p to two decimals (%p)', (input, expected) => {
    expect(buildLocationPush('f', 0, 0, 't', input).distanceMiles).toBe(expected);
  });
});

describe('buildInitResponse', () => {
  it('wraps friends in an init.response message', () => {
    const friends = [{ friendId: 'a', latitude: 1, longitude: 2, lastUpdated: 't', distanceMiles: 0.5 }];
    expect(buildInitResponse(friends)).toEqual({ type: 'init.response', friends });
  });

  it('allows an empty friends list', () => {
    expect(buildInitResponse([])).toEqual({ type: 'init.response', friends: [] });
  });
});
