import { restEvent, resultStatus, resultJson } from '../helpers/rest-events';

// The handler only talks to AWS through these wrapper modules, so we replace them.
// Factories keep the real modules (and their AWS SDK clients) from loading at all.
jest.mock('../../src/utils/dynamo-client', () => ({
  getFriends: jest.fn(),
  createFriendship: jest.fn(),
  removeFriendship: jest.fn(),
  areFriends: jest.fn(),
  getFriendCount: jest.fn(),
  getUser: jest.fn(),
  putUser: jest.fn(),
  updateUser: jest.fn(),
  putFriendRequest: jest.fn(),
  getFriendRequest: jest.fn(),
  getFriendRequestsByToUser: jest.fn(),
  deleteFriendRequest: jest.fn(),
  getConnectionsNear: jest.fn(),
  getConnectionsByUserId: jest.fn(),
}));
jest.mock('../../src/utils/config', () => ({ getConfig: jest.fn() }));
jest.mock('../../src/utils/s3-client', () => ({
  generateUploadUrl: jest.fn(),
  generateDownloadUrl: jest.fn(),
}));
jest.mock('uuid', () => ({ v4: jest.fn() }));

import { handler } from '../../src/handlers/rest-handler';
import * as dynamo from '../../src/utils/dynamo-client';
import { getConfig } from '../../src/utils/config';
import { generateDownloadUrl } from '../../src/utils/s3-client';
import { haversine } from '../../src/utils/distance';
import { ConnectionRecord, UserProfile } from '../../src/types';

const mockGetFriends = dynamo.getFriends as jest.MockedFunction<typeof dynamo.getFriends>;
const mockGetUser = dynamo.getUser as jest.MockedFunction<typeof dynamo.getUser>;
const mockGetConnections = dynamo.getConnectionsByUserId as jest.MockedFunction<typeof dynamo.getConnectionsByUserId>;
const mockGetConnectionsNear = dynamo.getConnectionsNear as jest.MockedFunction<
  typeof dynamo.getConnectionsNear
>;
const mockGetConfig = getConfig as jest.MockedFunction<typeof getConfig>;
const mockDownloadUrl = generateDownloadUrl as jest.MockedFunction<typeof generateDownloadUrl>;

const CONFIG = {
  searchRadiusMiles: 5,
  inactivityTtlSeconds: 600,
  locationUpdateIntervalSeconds: 30,
  maxFriends: 5000,
  nearbyStrangersLimit: 50,
};

// Guadalajara. Each 0.01 deg of latitude is ~0.69 miles, so:
//   +0.01 -> 0.69   +0.02 -> 1.38   +0.03 -> 2.07   +0.04 -> 2.76   +0.05 -> 3.45
//   +0.10 -> 6.91 (outside the default 5-mile radius)
const ORIGIN = { lat: 20.6597, lng: -103.3496 };
const lat = (offset: number) => ORIGIN.lat + offset;

const nowSeconds = () => Math.floor(Date.now() / 1000);

function connection(overrides: Partial<ConnectionRecord> = {}): ConnectionRecord {
  return {
    connectionId: 'conn-x',
    userId: 'user-2',
    latitude: lat(0.01),
    longitude: ORIGIN.lng,
    timestamp: '2026-10-15T11:00:00.000Z',
    connectedAt: '2026-10-15T10:00:00.000Z',
    expiresAt: nowSeconds() + 600,
    ...overrides,
  };
}

/** The caller's own live connection, which distances are measured from. */
const ownConnection = (overrides: Partial<ConnectionRecord> = {}) =>
  connection({ connectionId: 'own', userId: 'user-1', latitude: ORIGIN.lat, longitude: ORIGIN.lng, ...overrides });

function profile(overrides: Partial<UserProfile> = {}): UserProfile {
  return {
    userId: 'user-2',
    displayName: 'Friend Two',
    discoverable: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

const friendship = (friendId: string) => ({ userId: 'user-1', friendId, createdAt: '2026-02-02T00:00:00.000Z' });

/** Maps userId -> that user's connections for getConnectionsByUserId. */
function givenConnections(byUser: Record<string, ConnectionRecord[]>): void {
  mockGetConnections.mockImplementation(async (userId: string) => byUser[userId] ?? []);
}

/** Makes getUser resolve profiles from a map keyed by userId. */
function givenUsers(users: Record<string, UserProfile>): void {
  mockGetUser.mockImplementation(async (id: string) => users[id]);
}

let errorSpy: jest.SpyInstance;

beforeEach(() => {
  // clearMocks resets call history but keeps implementations, so set safe defaults every time.
  mockGetConfig.mockResolvedValue(CONFIG);
  mockGetFriends.mockResolvedValue([]);
  mockGetUser.mockResolvedValue(undefined);
  mockGetConnections.mockResolvedValue([]);
  mockGetConnectionsNear.mockResolvedValue([]);
  mockDownloadUrl.mockImplementation(async (key: string) => `https://signed.example/${key}`);
  errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  errorSpy.mockRestore();
});

const NO_LOCATION = { error: 'Your location is not available. Send a location update first.' };

// ── GET /nearby-friends ───────────────────────────────────────────────────────

describe('rest-handler: GET /nearby-friends', () => {
  const nearbyFriends = (sub: string | null = 'user-1') => handler(restEvent('GET', '/nearby-friends', { sub }));

  it('returns 401 without authorizer claims and touches nothing', async () => {
    const result = await nearbyFriends(null);

    expect(resultStatus(result)).toBe(401);
    expect(mockGetConnections).not.toHaveBeenCalled();
    expect(mockGetFriends).not.toHaveBeenCalled();
  });

  describe('the caller\'s own location', () => {
    it.each([
      ['no connection', () => []],
      ['only an expired connection', () => [ownConnection({ expiresAt: nowSeconds() - 10 })]],
      ['only a connection without a location', () => [ownConnection({ latitude: undefined, longitude: undefined })]],
    ])('is required: %s returns 400', async (_name, own) => {
      givenConnections({ 'user-1': own() });

      const result = await nearbyFriends();

      expect(resultStatus(result)).toBe(400);
      expect(resultJson(result)).toEqual(NO_LOCATION);
      expect(mockGetFriends).not.toHaveBeenCalled();
    });

    it('skips an expired connection and uses a live one', async () => {
      mockGetFriends.mockResolvedValue([friendship('user-2')]);
      givenUsers({ 'user-2': profile() });
      givenConnections({
        'user-1': [ownConnection({ expiresAt: nowSeconds() - 10, latitude: lat(1) }), ownConnection()],
        'user-2': [connection()],
      });

      const result = await nearbyFriends();

      expect(resultJson(result)).toHaveLength(1); // measured from the live connection, not the stale one
    });

    // Documents current behaviour: the first located, unexpired connection is used, not the
    // most recent one. The WebSocket handler, by contrast, picks the latest. With two devices
    // the two endpoints can therefore disagree about where the caller is.
    it('uses the first listed live connection rather than the most recently updated one', async () => {
      mockGetFriends.mockResolvedValue([friendship('user-2')]);
      givenUsers({ 'user-2': profile() });
      givenConnections({
        'user-1': [
          ownConnection({ connectionId: 'older', timestamp: '2026-10-15T10:00:00.000Z' }), // at ORIGIN
          ownConnection({ connectionId: 'newer', timestamp: '2026-10-15T11:00:00.000Z', latitude: lat(0.1) }),
        ],
        'user-2': [connection()], // +0.01: in range of ORIGIN, ~6 miles from the newer connection
      });

      const result = await nearbyFriends();

      expect(resultJson(result)).toHaveLength(1);
    });
  });

  describe('with a known location', () => {
    beforeEach(() => {
      mockGetFriends.mockResolvedValue([friendship('user-2')]);
      givenUsers({ 'user-2': profile({ displayName: 'Ana', profilePictureKey: 'pics/ana.jpg' }) });
    });

    it('returns an empty list when the caller has no friends', async () => {
      mockGetFriends.mockResolvedValue([]);
      givenConnections({ 'user-1': [ownConnection()] });

      const result = await nearbyFriends();

      expect(resultStatus(result)).toBe(200);
      expect(resultJson(result)).toEqual([]);
      expect(mockGetFriends).toHaveBeenCalledWith('user-1');
    });

    it('returns a friend in range with profile data and the rounded distance', async () => {
      givenConnections({ 'user-1': [ownConnection()], 'user-2': [connection()] });

      const result = await nearbyFriends();

      expect(resultStatus(result)).toBe(200);
      expect(resultJson(result)).toEqual([
        {
          friendId: 'user-2',
          displayName: 'Ana',
          profilePictureUrl: 'https://signed.example/pics/ana.jpg',
          latitude: lat(0.01),
          longitude: ORIGIN.lng,
          lastUpdated: '2026-10-15T11:00:00.000Z',
          distanceMiles: 0.69,
        },
      ]);
    });

    it('omits the picture URL for a friend without a picture', async () => {
      givenUsers({ 'user-2': profile({ displayName: 'Ana' }) });
      givenConnections({ 'user-1': [ownConnection()], 'user-2': [connection()] });

      const [friend] = resultJson(await nearbyFriends());

      expect(friend).not.toHaveProperty('profilePictureUrl');
      expect(mockDownloadUrl).not.toHaveBeenCalled();
    });

    it('excludes a friend outside the radius without fetching their profile', async () => {
      givenConnections({ 'user-1': [ownConnection()], 'user-2': [connection({ latitude: lat(0.1) })] });

      const result = await nearbyFriends();

      expect(resultJson(result)).toEqual([]);
      expect(mockGetUser).not.toHaveBeenCalled();
    });

    it('uses the configured radius', async () => {
      givenConnections({ 'user-1': [ownConnection()], 'user-2': [connection()] }); // ~0.69 miles

      mockGetConfig.mockResolvedValue({ ...CONFIG, searchRadiusMiles: 0.5 });
      expect(resultJson(await nearbyFriends())).toEqual([]);

      mockGetConfig.mockResolvedValue({ ...CONFIG, searchRadiusMiles: 1 });
      expect(resultJson(await nearbyFriends())).toHaveLength(1);
    });

    it('includes a friend exactly at the radius and excludes one just beyond it', async () => {
      givenConnections({ 'user-1': [ownConnection()], 'user-2': [connection()] });
      const exact = haversine(ORIGIN.lat, ORIGIN.lng, lat(0.01), ORIGIN.lng);

      mockGetConfig.mockResolvedValue({ ...CONFIG, searchRadiusMiles: exact });
      expect(resultJson(await nearbyFriends())).toHaveLength(1);

      mockGetConfig.mockResolvedValue({ ...CONFIG, searchRadiusMiles: exact - 1e-9 });
      expect(resultJson(await nearbyFriends())).toEqual([]);
    });

    it.each([
      ['is not connected', () => []],
      ['has only an expired connection', () => [connection({ expiresAt: nowSeconds() - 10 })]],
      ['has a connection without a location', () => [connection({ latitude: undefined, longitude: undefined })]],
      ['has a connection without a timestamp', () => [connection({ timestamp: undefined })]],
    ])('excludes a friend who %s', async (_name, friendConnections) => {
      givenConnections({ 'user-1': [ownConnection()], 'user-2': friendConnections() });

      const result = await nearbyFriends();

      expect(resultJson(result)).toEqual([]);
    });

    it('excludes a friend whose profile no longer exists', async () => {
      givenUsers({});
      givenConnections({ 'user-1': [ownConnection()], 'user-2': [connection()] });

      const result = await nearbyFriends();

      expect(resultJson(result)).toEqual([]);
    });

    it('locates a friend by their most recently updated connection', async () => {
      givenConnections({
        'user-1': [ownConnection()],
        'user-2': [
          connection({ connectionId: 'old-near', latitude: lat(0.01), timestamp: '2026-10-15T10:00:00.000Z' }),
          connection({ connectionId: 'new-far', latitude: lat(0.1), timestamp: '2026-10-15T11:00:00.000Z' }),
        ],
      });
      expect(resultJson(await nearbyFriends())).toEqual([]); // newest is out of range

      givenConnections({
        'user-1': [ownConnection()],
        'user-2': [
          connection({ connectionId: 'old-far', latitude: lat(0.1), timestamp: '2026-10-15T10:00:00.000Z' }),
          connection({ connectionId: 'new-near', latitude: lat(0.02), timestamp: '2026-10-15T11:00:00.000Z' }),
        ],
      });
      const [friend] = resultJson(await nearbyFriends());
      expect(friend.latitude).toBe(lat(0.02));
      expect(friend.lastUpdated).toBe('2026-10-15T11:00:00.000Z');
    });

    it('lists several friends nearest first', async () => {
      mockGetFriends.mockResolvedValue([friendship('far'), friendship('near'), friendship('mid'), friendship('out')]);
      givenUsers({
        far: profile({ userId: 'far' }),
        near: profile({ userId: 'near' }),
        mid: profile({ userId: 'mid' }),
        out: profile({ userId: 'out' }),
      });
      givenConnections({
        'user-1': [ownConnection()],
        far: [connection({ latitude: lat(0.03) })],
        near: [connection({ latitude: lat(0.01) })],
        mid: [connection({ latitude: lat(0.02) })],
        out: [connection({ latitude: lat(0.1) })],
      });

      const result = await nearbyFriends();

      expect(resultJson(result).map((f: { friendId: string; distanceMiles: number }) => [f.friendId, f.distanceMiles])).toEqual([
        ['near', 0.69],
        ['mid', 1.38],
        ['far', 2.07],
      ]);
    });
  });
});

// ── GET /nearby-strangers ─────────────────────────────────────────────────────

describe('rest-handler: GET /nearby-strangers', () => {
  const nearbyStrangers = (sub: string | null = 'user-1') => handler(restEvent('GET', '/nearby-strangers', { sub }));

  /** A scanned connection for a stranger, at `offset` degrees north of the caller. */
  const stranger = (userId: string, offset: number, overrides: Partial<ConnectionRecord> = {}) =>
    connection({ connectionId: `c-${userId}`, userId, latitude: lat(offset), ...overrides });

  it('returns 401 without authorizer claims and touches nothing', async () => {
    const result = await nearbyStrangers(null);

    expect(resultStatus(result)).toBe(401);
    expect(mockGetConnections).not.toHaveBeenCalled();
    expect(mockGetConnectionsNear).not.toHaveBeenCalled();
  });

  it.each([
    ['no connection', () => []],
    ['only an expired connection', () => [ownConnection({ expiresAt: nowSeconds() - 10 })]],
    ['only a connection without a location', () => [ownConnection({ latitude: undefined, longitude: undefined })]],
  ])('requires the caller\'s own location: %s returns 400', async (_name, own) => {
    givenConnections({ 'user-1': own() });

    const result = await nearbyStrangers();

    expect(resultStatus(result)).toBe(400);
    expect(resultJson(result)).toEqual(NO_LOCATION);
    expect(mockGetConnectionsNear).not.toHaveBeenCalled();
  });

  describe('with a known location', () => {
    beforeEach(() => {
      givenConnections({ 'user-1': [ownConnection()] });
    });

    it('asks only for connections near the caller, within the configured radius', async () => {
      mockGetConnectionsNear.mockResolvedValue([]);

      await nearbyStrangers();
      expect(mockGetConnectionsNear).toHaveBeenCalledTimes(1);
      expect(mockGetConnectionsNear).toHaveBeenLastCalledWith(ORIGIN.lat, ORIGIN.lng, 5);

      mockGetConfig.mockResolvedValue({ ...CONFIG, searchRadiusMiles: 12 });
      await nearbyStrangers();
      expect(mockGetConnectionsNear).toHaveBeenLastCalledWith(ORIGIN.lat, ORIGIN.lng, 12);
    });

    it('measures from the caller\'s own location, not from anyone else\'s', async () => {
      givenConnections({ 'user-1': [ownConnection({ latitude: lat(0.5), longitude: ORIGIN.lng + 0.5 })] });
      mockGetConnectionsNear.mockResolvedValue([]);

      await nearbyStrangers();

      expect(mockGetConnectionsNear).toHaveBeenCalledWith(lat(0.5), ORIGIN.lng + 0.5, 5);
    });

    it('returns an empty list when nobody else is around', async () => {
      mockGetConnectionsNear.mockResolvedValue([ownConnection()]);

      const result = await nearbyStrangers();

      expect(resultStatus(result)).toBe(200);
      expect(resultJson(result)).toEqual([]);
    });

    it('returns a discoverable stranger with only the fields safe to share', async () => {
      mockGetConnectionsNear.mockResolvedValue([stranger('s1', 0.01)]);
      givenUsers({ s1: profile({ userId: 's1', displayName: 'Sam', profilePictureKey: 'pics/sam.jpg' }) });

      const result = await nearbyStrangers();

      expect(resultStatus(result)).toBe(200);
      expect(resultJson(result)).toEqual([
        { userId: 's1', displayName: 'Sam', profilePictureUrl: 'https://signed.example/pics/sam.jpg', distanceMiles: 0.69 },
      ]);
      // Privacy: strangers learn a distance, never coordinates or connection details.
      expect(Object.keys(resultJson(result)[0]).sort()).toEqual([
        'displayName',
        'distanceMiles',
        'profilePictureUrl',
        'userId',
      ]);
    });

    // Documents current behaviour: strangers get an empty-string URL when they have no
    // picture, whereas friends omit the field entirely.
    it('uses an empty picture URL for a stranger without a picture', async () => {
      mockGetConnectionsNear.mockResolvedValue([stranger('s1', 0.01)]);
      givenUsers({ s1: profile({ userId: 's1' }) });

      const [entry] = resultJson(await nearbyStrangers());

      expect(entry.profilePictureUrl).toBe('');
      expect(mockDownloadUrl).not.toHaveBeenCalled();
    });

    it('excludes the caller\'s own connections', async () => {
      mockGetConnectionsNear.mockResolvedValue([ownConnection(), stranger('s1', 0.01)]);
      givenUsers({ 'user-1': profile({ userId: 'user-1' }), s1: profile({ userId: 's1' }) });

      const result = await nearbyStrangers();

      expect(resultJson(result).map((s: { userId: string }) => s.userId)).toEqual(['s1']);
    });

    it('excludes the caller\'s friends', async () => {
      mockGetFriends.mockResolvedValue([friendship('f1')]);
      mockGetConnectionsNear.mockResolvedValue([stranger('f1', 0.01), stranger('s1', 0.02)]);
      givenUsers({ f1: profile({ userId: 'f1' }), s1: profile({ userId: 's1' }) });

      const result = await nearbyStrangers();

      expect(resultJson(result).map((s: { userId: string }) => s.userId)).toEqual(['s1']);
      expect(mockGetFriends).toHaveBeenCalledWith('user-1');
    });

    it('excludes users who are not discoverable, or have no profile', async () => {
      mockGetConnectionsNear.mockResolvedValue([
        stranger('hidden', 0.01),
        stranger('ghost', 0.02),
        stranger('s1', 0.03),
      ]);
      givenUsers({
        hidden: profile({ userId: 'hidden', discoverable: false, profilePictureKey: 'pics/hidden.jpg' }),
        s1: profile({ userId: 's1' }),
      });

      const result = await nearbyStrangers();

      expect(resultJson(result).map((s: { userId: string }) => s.userId)).toEqual(['s1']);
      expect(mockDownloadUrl).not.toHaveBeenCalled(); // no signed URL is made for a hidden user
    });

    it('excludes strangers outside the radius, or without a location, and never looks them up', async () => {
      mockGetConnectionsNear.mockResolvedValue([
        stranger('out', 0.1),
        stranger('nowhere', 0.01, { latitude: undefined, longitude: undefined }),
        stranger('s1', 0.01),
      ]);
      givenUsers({ s1: profile({ userId: 's1' }) });

      const result = await nearbyStrangers();

      expect(resultJson(result).map((s: { userId: string }) => s.userId)).toEqual(['s1']);
      expect(mockGetUser).toHaveBeenCalledTimes(1);
      expect(mockGetUser).toHaveBeenCalledWith('s1');
    });

    it('uses the configured radius', async () => {
      mockGetConnectionsNear.mockResolvedValue([stranger('s1', 0.01)]); // ~0.69 miles
      givenUsers({ s1: profile({ userId: 's1' }) });

      mockGetConfig.mockResolvedValue({ ...CONFIG, searchRadiusMiles: 0.5 });
      expect(resultJson(await nearbyStrangers())).toEqual([]);

      mockGetConfig.mockResolvedValue({ ...CONFIG, searchRadiusMiles: 1 });
      expect(resultJson(await nearbyStrangers())).toHaveLength(1);
    });

    it('lists strangers nearest first', async () => {
      mockGetConnectionsNear.mockResolvedValue([stranger('c', 0.03), stranger('a', 0.01), stranger('b', 0.02)]);
      givenUsers({
        a: profile({ userId: 'a' }),
        b: profile({ userId: 'b' }),
        c: profile({ userId: 'c' }),
      });

      const result = await nearbyStrangers();

      expect(resultJson(result).map((s: { userId: string; distanceMiles: number }) => [s.userId, s.distanceMiles])).toEqual([
        ['a', 0.69],
        ['b', 1.38],
        ['c', 2.07],
      ]);
    });

    it('caps the list at the configured limit, keeping the nearest', async () => {
      mockGetConfig.mockResolvedValue({ ...CONFIG, nearbyStrangersLimit: 2 });
      mockGetConnectionsNear.mockResolvedValue([
        stranger('s4', 0.04),
        stranger('s2', 0.02),
        stranger('s3', 0.03),
        stranger('s1', 0.01),
      ]);
      givenUsers({
        s1: profile({ userId: 's1' }),
        s2: profile({ userId: 's2' }),
        s3: profile({ userId: 's3' }),
        s4: profile({ userId: 's4' }),
      });

      const result = await nearbyStrangers();

      expect(resultJson(result).map((s: { userId: string }) => s.userId)).toEqual(['s1', 's2']);
    });

    it('does not let hidden users use up the cap', async () => {
      mockGetConfig.mockResolvedValue({ ...CONFIG, nearbyStrangersLimit: 2 });
      mockGetConnectionsNear.mockResolvedValue([
        stranger('hidden', 0.005),
        stranger('s1', 0.01),
        stranger('s2', 0.02),
        stranger('s3', 0.03),
      ]);
      givenUsers({
        hidden: profile({ userId: 'hidden', discoverable: false }),
        s1: profile({ userId: 's1' }),
        s2: profile({ userId: 's2' }),
        s3: profile({ userId: 's3' }),
      });

      const result = await nearbyStrangers();

      expect(resultJson(result).map((s: { userId: string }) => s.userId)).toEqual(['s1', 's2']);
    });

    describe('a stranger with several live connections (e.g. phone and laptop)', () => {
      const EARLIER = '2026-10-15T10:00:00.000Z';
      const LATER = '2026-10-15T11:00:00.000Z';

      beforeEach(() => {
        givenUsers({ s1: profile({ userId: 's1' }), s2: profile({ userId: 's2' }), s3: profile({ userId: 's3' }) });
      });

      it('is listed once, at the distance of their nearest connection', async () => {
        mockGetConnectionsNear.mockResolvedValue([
          stranger('s1', 0.02, { connectionId: 'laptop' }),
          stranger('s1', 0.01, { connectionId: 'phone' }),
        ]);

        const result = await nearbyStrangers();

        expect(resultJson(result)).toEqual([expect.objectContaining({ userId: 's1', distanceMiles: 0.69 })]);
      });

      it('does not depend on the order the connections were scanned in', async () => {
        mockGetConnectionsNear.mockResolvedValue([
          stranger('s1', 0.01, { connectionId: 'phone' }),
          stranger('s1', 0.02, { connectionId: 'laptop' }),
        ]);

        const result = await nearbyStrangers();

        expect(resultJson(result)).toEqual([expect.objectContaining({ userId: 's1', distanceMiles: 0.69 })]);
      });

      it('is listed when any connection is in range, even if the most recent one is far away', async () => {
        mockGetConnectionsNear.mockResolvedValue([
          stranger('s1', 0.01, { connectionId: 'old-near', timestamp: EARLIER }),
          stranger('s1', 0.1, { connectionId: 'new-far', timestamp: LATER }),
        ]);

        const result = await nearbyStrangers();

        expect(resultJson(result)).toEqual([expect.objectContaining({ userId: 's1', distanceMiles: 0.69 })]);
      });

      it('is left out only when every connection is out of range', async () => {
        mockGetConnectionsNear.mockResolvedValue([
          stranger('s1', 0.1, { connectionId: 'phone' }),
          stranger('s1', 0.2, { connectionId: 'laptop' }),
        ]);

        const result = await nearbyStrangers();

        expect(resultJson(result)).toEqual([]);
      });

      it('does not depend on timestamps, which may be missing', async () => {
        mockGetConnectionsNear.mockResolvedValue([
          stranger('s1', 0.02, { connectionId: 'timed', timestamp: LATER }),
          stranger('s1', 0.01, { connectionId: 'untimed', timestamp: undefined }),
        ]);

        const result = await nearbyStrangers();

        expect(resultJson(result)).toEqual([expect.objectContaining({ userId: 's1', distanceMiles: 0.69 })]);
      });

      it('looks the profile up once per user, not once per connection', async () => {
        mockGetConnectionsNear.mockResolvedValue([
          stranger('s1', 0.01, { connectionId: 'phone' }),
          stranger('s1', 0.02, { connectionId: 'laptop' }),
        ]);

        await nearbyStrangers();

        expect(mockGetUser).toHaveBeenCalledTimes(1);
        expect(mockGetUser).toHaveBeenCalledWith('s1');
      });

      it('does not use up several slots of the cap', async () => {
        mockGetConfig.mockResolvedValue({ ...CONFIG, nearbyStrangersLimit: 2 });
        mockGetConnectionsNear.mockResolvedValue([
          stranger('s1', 0.01, { connectionId: 'phone' }),
          stranger('s1', 0.01, { connectionId: 'laptop' }),
          stranger('s2', 0.02),
          stranger('s3', 0.03),
        ]);

        const result = await nearbyStrangers();

        expect(resultJson(result).map((s: { userId: string }) => s.userId)).toEqual(['s1', 's2']);
      });

      it('is still excluded when they are a friend, whichever connection is nearest', async () => {
        mockGetFriends.mockResolvedValue([friendship('s1')]);
        mockGetConnectionsNear.mockResolvedValue([
          stranger('s1', 0.01, { connectionId: 'phone' }),
          stranger('s1', 0.02, { connectionId: 'laptop' }),
        ]);

        const result = await nearbyStrangers();

        expect(resultJson(result)).toEqual([]);
      });
    });
  });
});
