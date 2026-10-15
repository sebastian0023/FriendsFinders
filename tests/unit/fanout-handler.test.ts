import type { DynamoDBRecord, DynamoDBStreamEvent } from 'aws-lambda';

// The handler only talks to AWS through these wrapper modules, so we replace them.
// Factories keep the real modules (and their AWS SDK clients) from loading at all.
jest.mock('../../src/utils/dynamo-client', () => ({
  getFriends: jest.fn(),
  getConnectionsByUserId: jest.fn(),
  deleteConnection: jest.fn(),
}));
jest.mock('../../src/utils/apigw-client', () => ({ postToConnection: jest.fn() }));
jest.mock('../../src/utils/config', () => ({ getConfig: jest.fn() }));

import { handler } from '../../src/handlers/fanout-handler';
import { getFriends, getConnectionsByUserId, deleteConnection } from '../../src/utils/dynamo-client';
import { postToConnection } from '../../src/utils/apigw-client';
import { getConfig } from '../../src/utils/config';
import { ConnectionRecord } from '../../src/types';

const mockGetFriends = getFriends as jest.MockedFunction<typeof getFriends>;
const mockGetConnections = getConnectionsByUserId as jest.MockedFunction<typeof getConnectionsByUserId>;
const mockDeleteConnection = deleteConnection as jest.MockedFunction<typeof deleteConnection>;
const mockPost = postToConnection as jest.MockedFunction<typeof postToConnection>;
const mockGetConfig = getConfig as jest.MockedFunction<typeof getConfig>;

const CONFIG = {
  searchRadiusMiles: 5,
  inactivityTtlSeconds: 600,
  locationUpdateIntervalSeconds: 30,
  maxFriends: 5000,
  nearbyStrangersLimit: 50,
};

// Guadalajara. +0.01 deg latitude is ~0.69 miles; +1 deg is ~69 miles.
const ORIGIN = { lat: 20.6597, lng: -103.3496 };
const NEAR_LAT = ORIGIN.lat + 0.01;
const FAR_LAT = ORIGIN.lat + 1;

const nowSeconds = () => Math.floor(Date.now() / 1000);

interface RecordOptions {
  eventName?: 'INSERT' | 'MODIFY' | 'REMOVE';
  userId?: string | null;
  timestamp?: string | null;
  newLat?: string | null;
  newLng?: string | null;
  oldLat?: string | null;
  oldLng?: string | null;
}

/** Builds a Connections-table stream record for a location update. */
function streamRecord(opts: RecordOptions = {}): DynamoDBRecord {
  const {
    eventName = 'MODIFY',
    userId = 'user-1',
    timestamp = '2026-10-15T12:00:00.000Z',
    newLat = String(ORIGIN.lat),
    newLng = String(ORIGIN.lng),
    oldLat = '0',
    oldLng = '0',
  } = opts;

  const newImage: NonNullable<DynamoDBRecord['dynamodb']>['NewImage'] = {};
  if (userId !== null) newImage.userId = { S: userId };
  if (timestamp !== null) newImage.timestamp = { S: timestamp };
  if (newLat !== null) newImage.latitude = { N: newLat };
  if (newLng !== null) newImage.longitude = { N: newLng };

  const oldImage: NonNullable<DynamoDBRecord['dynamodb']>['OldImage'] = {};
  if (oldLat !== null) oldImage.latitude = { N: oldLat };
  if (oldLng !== null) oldImage.longitude = { N: oldLng };

  return { eventName, dynamodb: { NewImage: newImage, OldImage: oldImage } };
}

const eventOf = (...records: DynamoDBRecord[]): DynamoDBStreamEvent => ({ Records: records });

function connection(overrides: Partial<ConnectionRecord> = {}): ConnectionRecord {
  return {
    connectionId: 'conn-1',
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

/** Maps friendId -> that friend's connections for getConnectionsByUserId. */
function givenConnections(byUser: Record<string, ConnectionRecord[]>): void {
  mockGetConnections.mockImplementation(async (userId: string) => byUser[userId] ?? []);
}

let logSpy: jest.SpyInstance;
let errorSpy: jest.SpyInstance;

beforeEach(() => {
  // clearMocks resets call history but keeps implementations, so set safe defaults every time.
  mockGetConfig.mockResolvedValue(CONFIG);
  mockGetFriends.mockResolvedValue([]);
  mockGetConnections.mockResolvedValue([]);
  mockPost.mockResolvedValue(undefined);
  logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
  errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  logSpy.mockRestore();
  errorSpy.mockRestore();
});

describe('fanout-handler: which stream records are processed', () => {
  it.each(['INSERT', 'REMOVE'] as const)('ignores %s events', async (eventName) => {
    await handler(eventOf(streamRecord({ eventName })));
    expect(mockGetFriends).not.toHaveBeenCalled();
    expect(mockPost).not.toHaveBeenCalled();
  });

  it('ignores a MODIFY that carries no new image at all', async () => {
    await handler(eventOf({ eventName: 'MODIFY', dynamodb: {} }));
    expect(mockGetFriends).not.toHaveBeenCalled();
  });

  it('ignores a MODIFY with no location in the new image', async () => {
    await handler(eventOf(streamRecord({ newLat: null, newLng: null })));
    expect(mockGetFriends).not.toHaveBeenCalled();
  });

  it('ignores a MODIFY where the location did not change (TTL refresh only)', async () => {
    await handler(
      eventOf(streamRecord({ newLat: '20.6597', newLng: '-103.3496', oldLat: '20.6597', oldLng: '-103.3496' }))
    );
    expect(mockGetFriends).not.toHaveBeenCalled();
  });

  it('processes a MODIFY when only one coordinate changed', async () => {
    await handler(eventOf(streamRecord({ newLat: '20.6597', oldLat: '20.6597', newLng: '-103.3', oldLng: '-103.4' })));
    expect(mockGetFriends).toHaveBeenCalledWith('user-1');
  });

  it.each([
    ['userId', { userId: null }],
    ['timestamp', { timestamp: null }],
  ])('ignores a record missing %s', async (_field, opts) => {
    await handler(eventOf(streamRecord(opts)));
    expect(mockGetFriends).not.toHaveBeenCalled();
  });

  it('processes every record in a batch', async () => {
    await handler(eventOf(streamRecord({ userId: 'user-1' }), streamRecord({ userId: 'user-2' })));
    expect(mockGetFriends).toHaveBeenCalledTimes(2);
    expect(mockGetFriends).toHaveBeenNthCalledWith(1, 'user-1');
    expect(mockGetFriends).toHaveBeenNthCalledWith(2, 'user-2');
  });

  it('loads config once per invocation, not once per record', async () => {
    await handler(eventOf(streamRecord({ userId: 'user-1' }), streamRecord({ userId: 'user-2' })));
    expect(mockGetConfig).toHaveBeenCalledTimes(1);
  });

  it('does nothing for an empty batch', async () => {
    await handler(eventOf());
    expect(mockGetFriends).not.toHaveBeenCalled();
  });
});

describe('fanout-handler: notifying friends', () => {
  beforeEach(() => {
    mockGetFriends.mockResolvedValue([friendship('friend-1')]);
  });

  it('pushes a location.push message to a friend inside the radius', async () => {
    givenConnections({ 'friend-1': [connection({ connectionId: 'conn-A' })] });

    await handler(eventOf(streamRecord()));

    expect(mockPost).toHaveBeenCalledTimes(1);
    expect(mockPost).toHaveBeenCalledWith('conn-A', {
      type: 'location.push',
      friendId: 'user-1', // the user who moved, as seen by the friend
      latitude: ORIGIN.lat,
      longitude: ORIGIN.lng,
      lastUpdated: '2026-10-15T12:00:00.000Z',
      distanceMiles: 0.69, // rounded to two decimals
    });
  });

  it('skips a friend outside the radius', async () => {
    givenConnections({ 'friend-1': [connection({ latitude: FAR_LAT })] });
    await handler(eventOf(streamRecord()));
    expect(mockPost).not.toHaveBeenCalled();
  });

  it('uses the configured radius', async () => {
    givenConnections({ 'friend-1': [connection()] }); // ~0.69 miles away

    mockGetConfig.mockResolvedValue({ ...CONFIG, searchRadiusMiles: 0.5 });
    await handler(eventOf(streamRecord()));
    expect(mockPost).not.toHaveBeenCalled();

    mockGetConfig.mockResolvedValue({ ...CONFIG, searchRadiusMiles: 1 });
    await handler(eventOf(streamRecord()));
    expect(mockPost).toHaveBeenCalledTimes(1);
  });

  it('notifies every active connection of a friend (laptop and phone)', async () => {
    givenConnections({
      'friend-1': [connection({ connectionId: 'laptop' }), connection({ connectionId: 'phone' })],
    });

    await handler(eventOf(streamRecord()));

    expect(mockPost.mock.calls.map(([id]) => id)).toEqual(['laptop', 'phone']);
  });

  it('notifies each nearby friend and skips the far ones', async () => {
    mockGetFriends.mockResolvedValue([friendship('near-1'), friendship('far-1'), friendship('near-2')]);
    givenConnections({
      'near-1': [connection({ connectionId: 'c-near-1', userId: 'near-1' })],
      'far-1': [connection({ connectionId: 'c-far-1', userId: 'far-1', latitude: FAR_LAT })],
      'near-2': [connection({ connectionId: 'c-near-2', userId: 'near-2' })],
    });

    await handler(eventOf(streamRecord()));

    expect(mockPost.mock.calls.map(([id]) => id)).toEqual(['c-near-1', 'c-near-2']);
  });

  it('skips expired connections', async () => {
    givenConnections({
      'friend-1': [
        connection({ connectionId: 'expired', expiresAt: nowSeconds() - 10 }),
        connection({ connectionId: 'active' }),
      ],
    });

    await handler(eventOf(streamRecord()));

    expect(mockPost.mock.calls.map(([id]) => id)).toEqual(['active']);
  });

  it('skips a connection that expires exactly now', async () => {
    givenConnections({ 'friend-1': [connection({ expiresAt: nowSeconds() })] });
    await handler(eventOf(streamRecord()));
    expect(mockPost).not.toHaveBeenCalled();
  });

  // Documents current behaviour: a friend who has connected but not yet shared a
  // location still receives the push, with distance 0, so their radar can show the user.
  it('pushes with distance 0 to a friend connection that has no location yet', async () => {
    givenConnections({
      'friend-1': [connection({ connectionId: 'no-loc', latitude: undefined, longitude: undefined })],
    });

    await handler(eventOf(streamRecord()));

    expect(mockPost).toHaveBeenCalledTimes(1);
    expect(mockPost).toHaveBeenCalledWith('no-loc', expect.objectContaining({ distanceMiles: 0 }));
  });

  it('sends nothing when the user has no friends', async () => {
    mockGetFriends.mockResolvedValue([]);
    await handler(eventOf(streamRecord()));
    expect(mockGetConnections).not.toHaveBeenCalled();
    expect(mockPost).not.toHaveBeenCalled();
  });

  it('sends nothing when no friend is connected', async () => {
    givenConnections({ 'friend-1': [] });
    await handler(eventOf(streamRecord()));
    expect(mockPost).not.toHaveBeenCalled();
  });

  it('looks up connections for each friend of the user who moved', async () => {
    mockGetFriends.mockResolvedValue([friendship('friend-1'), friendship('friend-2')]);
    await handler(eventOf(streamRecord({ userId: 'user-9' })));
    expect(mockGetFriends).toHaveBeenCalledWith('user-9');
    expect(mockGetConnections).toHaveBeenCalledWith('friend-1');
    expect(mockGetConnections).toHaveBeenCalledWith('friend-2');
  });
});

describe('fanout-handler: failure handling', () => {
  beforeEach(() => {
    mockGetFriends.mockResolvedValue([friendship('friend-1')]);
    givenConnections({
      'friend-1': [connection({ connectionId: 'first' }), connection({ connectionId: 'second' })],
    });
  });

  it('logs a GoneException and still notifies the remaining connections', async () => {
    mockPost.mockRejectedValueOnce(Object.assign(new Error('gone'), { name: 'GoneException' }));

    await handler(eventOf(streamRecord()));

    expect(mockPost).toHaveBeenCalledTimes(2);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('first is gone'));
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('treats an HTTP 410 status as a gone connection', async () => {
    mockPost.mockRejectedValueOnce(Object.assign(new Error('gone'), { statusCode: 410 }));

    await handler(eventOf(streamRecord()));

    expect(mockPost).toHaveBeenCalledTimes(2);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('first is gone'));
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('logs other post errors with console.error and keeps going', async () => {
    mockPost.mockRejectedValueOnce(new Error('boom'));

    await handler(eventOf(streamRecord()));

    expect(mockPost).toHaveBeenCalledTimes(2);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('first'), expect.any(Error));
  });

  it('one failing record does not block later records in the batch', async () => {
    mockPost.mockRejectedValue(new Error('boom'));

    await handler(eventOf(streamRecord({ userId: 'user-1' }), streamRecord({ userId: 'user-2' })));

    expect(mockGetFriends).toHaveBeenCalledTimes(2);
  });

  // Documents current behaviour (flagged in review): gone connections are only logged.
  // They are left to expire via TTL. If the handler starts deleting them, update this test.
  it('does not delete a gone connection', async () => {
    mockPost.mockRejectedValueOnce(Object.assign(new Error('gone'), { name: 'GoneException' }));

    await handler(eventOf(streamRecord()));

    expect(mockDeleteConnection).not.toHaveBeenCalled();
  });
});
