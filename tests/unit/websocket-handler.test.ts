import { generateKeyPairSync } from 'crypto';
import * as jwt from 'jsonwebtoken';
import type { APIGatewayProxyEvent } from 'aws-lambda';

// The handler only talks to AWS through these wrapper modules, so we replace them.
// Factories keep the real modules (and their AWS SDK clients) from loading at all.
jest.mock('../../src/utils/dynamo-client', () => ({
  putConnection: jest.fn(),
  deleteConnection: jest.fn(),
  getConnection: jest.fn(),
  getConnectionsByUserId: jest.fn(),
  getFriends: jest.fn(),
  updateConnectionLocation: jest.fn(),
}));
jest.mock('../../src/utils/apigw-client', () => ({ postToConnection: jest.fn() }));
jest.mock('../../src/utils/config', () => ({ getConfig: jest.fn() }));

// Only the JWKS network lookup is mocked. jsonwebtoken is real, so token verification
// (signature, algorithm, expiry) is genuinely exercised with tokens we sign ourselves.
// The handler builds its JWKS client at import time; the lookup is resolved lazily.
const mockGetSigningKey = jest.fn();
jest.mock('jwks-rsa', () =>
  jest.fn(() => ({ getSigningKey: (kid: string) => mockGetSigningKey(kid) }))
);

import { handler } from '../../src/handlers/websocket-handler';
import {
  putConnection,
  deleteConnection,
  getConnection,
  getConnectionsByUserId,
  getFriends,
  updateConnectionLocation,
} from '../../src/utils/dynamo-client';
import { postToConnection } from '../../src/utils/apigw-client';
import { getConfig } from '../../src/utils/config';
import { ConnectionRecord } from '../../src/types';

const mockPutConnection = putConnection as jest.MockedFunction<typeof putConnection>;
const mockDeleteConnection = deleteConnection as jest.MockedFunction<typeof deleteConnection>;
const mockGetConnection = getConnection as jest.MockedFunction<typeof getConnection>;
const mockGetConnections = getConnectionsByUserId as jest.MockedFunction<typeof getConnectionsByUserId>;
const mockGetFriends = getFriends as jest.MockedFunction<typeof getFriends>;
const mockUpdateLocation = updateConnectionLocation as jest.MockedFunction<typeof updateConnectionLocation>;
const mockPost = postToConnection as jest.MockedFunction<typeof postToConnection>;
const mockGetConfig = getConfig as jest.MockedFunction<typeof getConfig>;

const CONFIG = {
  searchRadiusMiles: 5,
  inactivityTtlSeconds: 600,
  locationUpdateIntervalSeconds: 30,
  maxFriends: 5000,
  nearbyStrangersLimit: 50,
};

// ── Tokens ────────────────────────────────────────────────────────────────────

const KID = 'test-key-id';
const keyPair = () =>
  generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
const TRUSTED = keyPair(); // the key the (mocked) JWKS endpoint serves
const OTHER = keyPair(); // a key the JWKS endpoint does not know

function signToken(
  payload: Record<string, unknown> = { sub: 'user-1' },
  options: jwt.SignOptions = {},
  privateKey: string = TRUSTED.privateKey
): string {
  return jwt.sign(payload, privateKey, { algorithm: 'RS256', keyid: KID, expiresIn: 300, ...options });
}

const validToken = (sub = 'user-1') => signToken({ sub });

// ── Events and fixtures ───────────────────────────────────────────────────────

interface EventOptions {
  connectionId?: string;
  body?: string | null;
  token?: string;
}

function wsEvent(routeKey: string, opts: EventOptions = {}): APIGatewayProxyEvent {
  return {
    requestContext: { routeKey, connectionId: opts.connectionId ?? 'conn-1' },
    body: opts.body ?? null,
    queryStringParameters: opts.token ? { token: opts.token } : null,
  } as unknown as APIGatewayProxyEvent;
}

// Guadalajara. +0.01 deg latitude is ~0.69 miles; +1 deg is ~69 miles.
const ORIGIN = { lat: 20.6597, lng: -103.3496 };
const NEAR_LAT = ORIGIN.lat + 0.01;
const FAR_LAT = ORIGIN.lat + 1;

const nowSeconds = () => Math.floor(Date.now() / 1000);

function connection(overrides: Partial<ConnectionRecord> = {}): ConnectionRecord {
  return {
    connectionId: 'conn-x',
    userId: 'friend-1',
    latitude: NEAR_LAT,
    longitude: ORIGIN.lng,
    timestamp: '2026-10-15T11:59:00.000Z',
    connectedAt: '2026-10-15T11:00:00.000Z',
    expiresAt: nowSeconds() + 600,
    ...overrides,
  };
}

const friendship = (friendId: string) => ({ userId: 'user-1', friendId, createdAt: '2026-01-01T00:00:00.000Z' });

/** Maps userId -> that user's connections for getConnectionsByUserId. */
function givenConnections(byUser: Record<string, ConnectionRecord[]>): void {
  mockGetConnections.mockImplementation(async (userId: string) => byUser[userId] ?? []);
}

/** The subscriber's own located connection, which distances are measured from. */
const subscriberAt = (lat = ORIGIN.lat, lng = ORIGIN.lng, extra: Partial<ConnectionRecord> = {}) =>
  connection({ connectionId: 'conn-1', userId: 'user-1', latitude: lat, longitude: lng, ...extra });

/** The message sent to the client, e.g. the init.response. */
const sentMessage = (callIndex = 0) => mockPost.mock.calls[callIndex][1] as { type: string; friends?: unknown[] };

/** Asserts a TTL was set to now + the configured inactivity TTL (within a small window). */
function expectFreshTtl(expiresAt: number, beforeSeconds: number): void {
  expect(expiresAt).toBeGreaterThanOrEqual(beforeSeconds + CONFIG.inactivityTtlSeconds);
  expect(expiresAt).toBeLessThanOrEqual(nowSeconds() + CONFIG.inactivityTtlSeconds);
}

let logSpy: jest.SpyInstance;
let errorSpy: jest.SpyInstance;

beforeEach(() => {
  // clearMocks resets call history but keeps implementations, so set safe defaults every time.
  mockGetConfig.mockResolvedValue(CONFIG);
  mockGetFriends.mockResolvedValue([]);
  mockGetConnections.mockResolvedValue([]);
  mockGetConnection.mockResolvedValue(undefined);
  mockPutConnection.mockResolvedValue(undefined);
  mockDeleteConnection.mockResolvedValue(undefined);
  mockUpdateLocation.mockResolvedValue(undefined);
  mockPost.mockResolvedValue(undefined);
  mockGetSigningKey.mockImplementation(async (kid: string) => {
    if (kid !== KID) throw new Error(`Unknown signing key: ${kid}`);
    return { getPublicKey: () => TRUSTED.publicKey };
  });
  logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
  errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  logSpy.mockRestore();
  errorSpy.mockRestore();
});

// ── Routing ───────────────────────────────────────────────────────────────────

describe('websocket-handler: routing', () => {
  it('returns 400 for an unknown route', async () => {
    const result = await handler(wsEvent('something.else'));
    expect(result).toEqual({ statusCode: 400, body: JSON.stringify({ error: 'Unknown route' }) });
  });

  it.each([
    ['$disconnect', () => mockDeleteConnection],
    ['location.update', () => mockPost], // an empty body is rejected with an error message
    ['friends.refresh', () => mockGetConnection],
  ])('dispatches %s to its handler', async (routeKey, spy) => {
    await handler(wsEvent(routeKey));
    expect(spy()).toHaveBeenCalled();
  });
});

// ── $connect ──────────────────────────────────────────────────────────────────

describe('websocket-handler: $connect authentication', () => {
  it('rejects a missing token with 401 and stores nothing', async () => {
    const result = await handler(wsEvent('$connect'));
    expect(result).toEqual({ statusCode: 401, body: 'Unauthorized' });
    expect(mockPutConnection).not.toHaveBeenCalled();
  });

  const bad: [string, () => string][] = [
    ['garbage', () => 'not-a-jwt'],
    ['expired', () => signToken({ sub: 'user-1' }, { expiresIn: -10 })],
    ['signed with a key the JWKS does not serve', () => signToken({ sub: 'user-1' }, {}, OTHER.privateKey)],
    ['signed with an unknown key id', () => signToken({ sub: 'user-1' }, { keyid: 'other-kid' })],
    ['tampered payload', () => {
      const [header, , signature] = validToken('user-1').split('.');
      const forged = Buffer.from(JSON.stringify({ sub: 'attacker', exp: nowSeconds() + 300 })).toString('base64url');
      return `${header}.${forged}.${signature}`;
    }],
    ['unsigned (alg none)', () => jwt.sign({ sub: 'user-1' }, '', { algorithm: 'none', keyid: KID })],
    // Validly signed with the trusted key, but with an algorithm outside the RS256 allow-list.
    // This is what actually proves the allow-list: jsonwebtoken alone would accept it.
    ['signed with RS384 (algorithm not allowed)', () => signToken({ sub: 'user-1' }, { algorithm: 'RS384' })],
    // Algorithm-confusion attack: HMAC-sign using the public key as the secret.
    // (jsonwebtoken 9 also refuses this by itself, so this is defence in depth.)
    ['HS256 signed with the public key', () => jwt.sign({ sub: 'user-1' }, TRUSTED.publicKey, { algorithm: 'HS256', keyid: KID })],
    ['missing a sub claim', () => signToken({})],
  ];

  it.each(bad)('rejects a token that is %s', async (_name, makeToken) => {
    const result = await handler(wsEvent('$connect', { token: makeToken() }));
    expect(result).toEqual({ statusCode: 401, body: 'Unauthorized' });
    expect(mockPutConnection).not.toHaveBeenCalled();
    expect(mockPost).not.toHaveBeenCalled();
  });

  // Documents current behaviour: only signature, algorithm and expiry are checked. Both
  // Cognito ID tokens and access tokens (and any client id) are accepted for this pool.
  it.each(['id', 'access'])('accepts a validly signed %s token', async (tokenUse) => {
    const token = signToken({ sub: 'user-1', token_use: tokenUse, client_id: 'any-client' });
    const result = await handler(wsEvent('$connect', { token }));
    expect(result.statusCode).toBe(200);
  });
});

describe('websocket-handler: $connect storing the connection', () => {
  it('stores the connection for the token subject with a fresh TTL', async () => {
    const before = nowSeconds();

    const result = await handler(wsEvent('$connect', { connectionId: 'conn-9', token: validToken('user-42') }));

    expect(result).toEqual({ statusCode: 200, body: 'Connected' });
    expect(mockPutConnection).toHaveBeenCalledTimes(1);
    const record = mockPutConnection.mock.calls[0][0];
    expect(record).toMatchObject({ connectionId: 'conn-9', userId: 'user-42' });
    expect(record.connectedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expectFreshTtl(record.expiresAt, before);
  });

  it('looks up the friends of the authenticated user', async () => {
    await handler(wsEvent('$connect', { token: validToken('user-42') }));
    expect(mockGetFriends).toHaveBeenCalledWith('user-42');
  });
});

describe('websocket-handler: $connect init.response', () => {
  const connect = () => handler(wsEvent('$connect', { token: validToken('user-1') }));

  beforeEach(() => {
    mockGetFriends.mockResolvedValue([friendship('friend-1')]);
  });

  it('sends init.response with a friend inside the radius', async () => {
    givenConnections({
      'user-1': [subscriberAt()],
      'friend-1': [connection({ connectionId: 'c-f1' })],
    });

    await connect();

    expect(mockPost).toHaveBeenCalledTimes(1);
    expect(mockPost).toHaveBeenCalledWith('conn-1', {
      type: 'init.response',
      friends: [
        {
          friendId: 'friend-1',
          latitude: NEAR_LAT,
          longitude: ORIGIN.lng,
          lastUpdated: '2026-10-15T11:59:00.000Z',
          distanceMiles: 0.69, // rounded to two decimals
        },
      ],
    });
  });

  it('sends an empty friends list when the user has no friends', async () => {
    mockGetFriends.mockResolvedValue([]);
    givenConnections({ 'user-1': [subscriberAt()] });

    await connect();

    expect(mockPost).toHaveBeenCalledWith('conn-1', { type: 'init.response', friends: [] });
  });

  it('excludes a friend outside the radius', async () => {
    givenConnections({
      'user-1': [subscriberAt()],
      'friend-1': [connection({ latitude: FAR_LAT })],
    });
    await connect();
    expect(sentMessage().friends).toEqual([]);
  });

  it('uses the configured radius', async () => {
    givenConnections({ 'user-1': [subscriberAt()], 'friend-1': [connection()] }); // ~0.69 miles

    mockGetConfig.mockResolvedValue({ ...CONFIG, searchRadiusMiles: 0.5 });
    await connect();
    expect(sentMessage(0).friends).toEqual([]);

    mockGetConfig.mockResolvedValue({ ...CONFIG, searchRadiusMiles: 1 });
    await connect();
    expect(sentMessage(1).friends).toHaveLength(1);
  });

  it.each([
    ['is not connected', () => []],
    ['has only an expired connection', () => [connection({ expiresAt: nowSeconds() - 10 })]],
    ['has a connection with no location yet', () => [connection({ latitude: undefined, longitude: undefined })]],
    ['has a connection with no timestamp', () => [connection({ timestamp: undefined })]],
  ])('excludes a friend who %s', async (_name, friendConnections) => {
    givenConnections({ 'user-1': [subscriberAt()], 'friend-1': friendConnections() });
    await connect();
    expect(sentMessage().friends).toEqual([]);
  });

  it('lists several friends in friendship order, skipping those who do not qualify', async () => {
    mockGetFriends.mockResolvedValue([friendship('near-1'), friendship('far-1'), friendship('near-2')]);
    givenConnections({
      'user-1': [subscriberAt()],
      'near-1': [connection({ userId: 'near-1' })],
      'far-1': [connection({ userId: 'far-1', latitude: FAR_LAT })],
      'near-2': [connection({ userId: 'near-2' })],
    });

    await connect();

    const friends = sentMessage().friends as { friendId: string }[];
    expect(friends.map((f) => f.friendId)).toEqual(['near-1', 'near-2']);
  });

  it('reports each friend once, even with several active connections', async () => {
    givenConnections({
      'user-1': [subscriberAt()],
      'friend-1': [connection({ connectionId: 'laptop' }), connection({ connectionId: 'phone' })],
    });
    await connect();
    expect(sentMessage().friends).toHaveLength(1);
  });

  // Documents current behaviour: the first usable connection decides. If it is out of
  // range, later connections of the same friend are not considered.
  it('stops at a friend\'s first located connection, even if a later one is in range', async () => {
    givenConnections({
      'user-1': [subscriberAt()],
      'friend-1': [
        connection({ connectionId: 'far', latitude: FAR_LAT }),
        connection({ connectionId: 'near' }),
      ],
    });
    await connect();
    expect(sentMessage().friends).toEqual([]);
  });

  it('measures distance from the subscriber\'s most recently updated connection', async () => {
    givenConnections({
      'user-1': [
        subscriberAt(ORIGIN.lat, ORIGIN.lng, { connectionId: 'old', timestamp: '2026-10-15T10:00:00.000Z' }),
        subscriberAt(NEAR_LAT + 0.001, ORIGIN.lng, { connectionId: 'new', timestamp: '2026-10-15T11:00:00.000Z' }),
      ],
      'friend-1': [connection()],
    });

    await connect();

    const [friend] = sentMessage().friends as { distanceMiles: number }[];
    expect(friend.distanceMiles).toBe(0.07); // from the newer connection, not 0.69 from the older
  });

  it('ignores an expired subscriber connection when measuring distance', async () => {
    givenConnections({
      'user-1': [
        subscriberAt(ORIGIN.lat, ORIGIN.lng, { connectionId: 'live', timestamp: '2026-10-15T10:00:00.000Z' }),
        subscriberAt(NEAR_LAT + 0.001, ORIGIN.lng, {
          connectionId: 'stale',
          timestamp: '2026-10-15T11:00:00.000Z',
          expiresAt: nowSeconds() - 10,
        }),
      ],
      'friend-1': [connection()],
    });

    await connect();

    const [friend] = sentMessage().friends as { distanceMiles: number }[];
    expect(friend.distanceMiles).toBe(0.69);
  });

  // Documents current behaviour: until the subscriber shares a location there is nothing
  // to measure from, so located friends are listed with distance 0 and no radius filter.
  it('lists located friends with distance 0 when the subscriber has no location yet', async () => {
    givenConnections({
      'user-1': [connection({ connectionId: 'conn-1', userId: 'user-1', latitude: undefined, longitude: undefined })],
      'friend-1': [connection({ latitude: FAR_LAT })],
    });

    await connect();

    expect(sentMessage().friends).toEqual([expect.objectContaining({ friendId: 'friend-1', distanceMiles: 0 })]);
  });

  it('still returns 200 when sending init.response fails', async () => {
    givenConnections({ 'user-1': [subscriberAt()], 'friend-1': [connection()] });
    mockPost.mockRejectedValue(new Error('GoneException'));

    const result = await connect();

    expect(result).toEqual({ statusCode: 200, body: 'Connected' });
    expect(errorSpy).toHaveBeenCalledWith('Failed to send init.response:', expect.any(Error));
  });
});

// ── $disconnect ───────────────────────────────────────────────────────────────

describe('websocket-handler: $disconnect', () => {
  it('deletes the connection and returns 200', async () => {
    const result = await handler(wsEvent('$disconnect', { connectionId: 'conn-7' }));
    expect(result).toEqual({ statusCode: 200, body: 'Disconnected' });
    expect(mockDeleteConnection).toHaveBeenCalledWith('conn-7');
  });

  it('logs a delete failure and still returns 200 (TTL cleans up later)', async () => {
    mockDeleteConnection.mockRejectedValue(new Error('throttled'));

    const result = await handler(wsEvent('$disconnect'));

    expect(result).toEqual({ statusCode: 200, body: 'Disconnected' });
    expect(errorSpy).toHaveBeenCalledWith('Error deleting connection:', expect.any(Error));
  });
});

// ── location.update ───────────────────────────────────────────────────────────

describe('websocket-handler: location.update', () => {
  const update = (body: unknown, connectionId = 'conn-1') =>
    handler(wsEvent('location.update', { connectionId, body: JSON.stringify(body) }));

  const validBody = { latitude: ORIGIN.lat, longitude: ORIGIN.lng, timestamp: '2026-10-15T12:00:00.000Z' };

  beforeEach(() => {
    mockGetConnection.mockResolvedValue(connection({ connectionId: 'conn-1', userId: 'user-1' }));
  });

  it('writes the location and refreshes the TTL', async () => {
    const before = nowSeconds();

    const result = await update(validBody);

    expect(result).toEqual({ statusCode: 200, body: 'OK' });
    expect(mockUpdateLocation).toHaveBeenCalledTimes(1);
    const [id, lat, lng, timestamp, expiresAt] = mockUpdateLocation.mock.calls[0];
    expect([id, lat, lng, timestamp]).toEqual(['conn-1', ORIGIN.lat, ORIGIN.lng, '2026-10-15T12:00:00.000Z']);
    expectFreshTtl(expiresAt, before);
  });

  it.each([
    [{ ...validBody, latitude: 91 }, 'latitude must be between -90 and 90'],
    [{ ...validBody, longitude: -181 }, 'longitude must be between -180 and 180'],
    [{ ...validBody, latitude: 'north' }, 'latitude must be a finite number'],
    [{ ...validBody, timestamp: undefined }, 'timestamp is required and must be a string'],
  ])('rejects an invalid location (%#) by messaging the client and writing nothing', async (body, message) => {
    const result = await update(body);

    expect(result).toEqual({ statusCode: 200, body: 'Invalid' });
    expect(mockPost).toHaveBeenCalledWith('conn-1', { type: 'error', message });
    expect(mockGetConnection).not.toHaveBeenCalled();
    expect(mockUpdateLocation).not.toHaveBeenCalled();
  });

  it('treats a missing body as an invalid message', async () => {
    const result = await handler(wsEvent('location.update', { body: null }));

    expect(result).toEqual({ statusCode: 200, body: 'Invalid' });
    expect(mockPost).toHaveBeenCalledWith('conn-1', { type: 'error', message: 'Invalid message body' });
  });

  it('still returns 200 when the error message cannot be delivered', async () => {
    mockPost.mockRejectedValue(new Error('GoneException'));

    const result = await update({ ...validBody, latitude: 91 });

    expect(result).toEqual({ statusCode: 200, body: 'Invalid' });
    expect(errorSpy).toHaveBeenCalledWith('Failed to send error message:', expect.any(Error));
  });

  it('ignores an update for an unknown connection', async () => {
    mockGetConnection.mockResolvedValue(undefined);

    const result = await update(validBody);

    expect(result).toEqual({ statusCode: 200, body: 'Connection not found' });
    expect(mockUpdateLocation).not.toHaveBeenCalled();
  });

  describe('with a malformed JSON body', () => {
    const malformed = () => handler(wsEvent('location.update', { body: '{not json' }));

    it('messages the client and writes nothing, like any other invalid input', async () => {
      const result = await malformed();

      expect(result).toEqual({ statusCode: 200, body: 'Invalid' });
      expect(mockPost).toHaveBeenCalledWith('conn-1', { type: 'error', message: 'Invalid JSON' });
      expect(mockGetConnection).not.toHaveBeenCalled();
      expect(mockUpdateLocation).not.toHaveBeenCalled();
    });

    it('still returns 200 when the error message cannot be delivered', async () => {
      mockPost.mockRejectedValue(new Error('GoneException'));

      const result = await malformed();

      expect(result).toEqual({ statusCode: 200, body: 'Invalid' });
      expect(errorSpy).toHaveBeenCalledWith('Failed to send error message:', expect.any(Error));
    });
  });

  it.each(['42', '"text"', 'true', '[]'])(
    'rejects a JSON body that is not an object (%s) as an invalid message',
    async (body) => {
      const result = await handler(wsEvent('location.update', { body }));

      expect(result).toEqual({ statusCode: 200, body: 'Invalid' });
      expect(mockUpdateLocation).not.toHaveBeenCalled();
    }
  );
});

// ── friends.refresh ───────────────────────────────────────────────────────────

describe('websocket-handler: friends.refresh', () => {
  const refresh = () => handler(wsEvent('friends.refresh', { connectionId: 'conn-1' }));

  it('does nothing for an unknown connection', async () => {
    const result = await refresh();
    expect(result).toEqual({ statusCode: 200, body: 'Connection not found' });
    expect(mockPost).not.toHaveBeenCalled();
  });

  describe('for a known connection', () => {
    beforeEach(() => {
      mockGetConnection.mockResolvedValue(connection({ connectionId: 'conn-1', userId: 'user-1' }));
      mockGetFriends.mockResolvedValue([friendship('friend-1')]);
      givenConnections({
        'user-1': [subscriberAt()],
        'friend-1': [connection()],
      });
    });

    it('re-sends an init.response with the current nearby friends', async () => {
      const result = await refresh();

      expect(result).toEqual({ statusCode: 200, body: 'OK' });
      expect(mockGetFriends).toHaveBeenCalledWith('user-1');
      expect(mockPost).toHaveBeenCalledWith('conn-1', {
        type: 'init.response',
        friends: [expect.objectContaining({ friendId: 'friend-1', distanceMiles: 0.69 })],
      });
    });

    it('still returns 200 when sending fails', async () => {
      mockPost.mockRejectedValue(new Error('GoneException'));

      const result = await refresh();

      expect(result).toEqual({ statusCode: 200, body: 'OK' });
      expect(errorSpy).toHaveBeenCalledWith('Failed to send friends.refresh response:', expect.any(Error));
    });
  });
});
