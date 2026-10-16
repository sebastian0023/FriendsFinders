import { mockClient } from 'aws-sdk-client-mock';
import {
  DynamoDBDocumentClient,
  PutCommand,
  GetCommand,
  DeleteCommand,
  QueryCommand,
  UpdateCommand,
  ScanCommand,
  BatchGetCommand,
} from '@aws-sdk/lib-dynamodb';
import * as db from '../../src/utils/dynamo-client';
import { ConnectionRecord, FriendRequest, UserProfile } from '../../src/types';

// The wrapper sends every request through a DynamoDBDocumentClient, so mocking that class
// lets us assert on the exact command input without any network or credentials.
const ddb = mockClient(DynamoDBDocumentClient);

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

const inputOf = <C extends { input: unknown }>(calls: { args: [C] }[], index = 0) => calls[index].args[0].input;

function profile(overrides: Partial<UserProfile> = {}): UserProfile {
  return {
    userId: 'user-1',
    displayName: 'Ana',
    discoverable: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function connection(overrides: Partial<ConnectionRecord> = {}): ConnectionRecord {
  return {
    connectionId: 'conn-1',
    userId: 'user-1',
    latitude: 20.6597,
    longitude: -103.3496,
    timestamp: '2026-10-16T12:00:00.000Z',
    connectedAt: '2026-10-16T11:00:00.000Z',
    expiresAt: 1_800_000_000,
    ...overrides,
  };
}

beforeEach(() => {
  ddb.reset();
  ddb.onAnyCommand().resolves({});
});

afterAll(() => {
  ddb.restore();
});

// ── Table names ───────────────────────────────────────────────────────────────

describe('dynamo-client: table names', () => {
  it('defaults to Connections, Users and FriendRequests', async () => {
    await db.getConnection('c');
    await db.getUser('u');
    await db.getFriendRequest('r');

    expect(inputOf(ddb.commandCalls(GetCommand), 0)).toMatchObject({ TableName: 'Connections' });
    expect(inputOf(ddb.commandCalls(GetCommand), 1)).toMatchObject({ TableName: 'Users' });
    expect(inputOf(ddb.commandCalls(GetCommand), 2)).toMatchObject({ TableName: 'FriendRequests' });
  });

  it('takes the names from the environment when set', async () => {
    const saved = { ...process.env };
    process.env.CONNECTIONS_TABLE_NAME = 'prod-connections';
    process.env.USERS_TABLE_NAME = 'prod-users';
    process.env.FRIEND_REQUESTS_TABLE_NAME = 'prod-requests';

    try {
      let tablesUsed!: () => Promise<string[]>;

      jest.isolateModules(() => {
        // A fresh module registry has its own copy of the SDK, so mock that copy too.
        const sdk = require('@aws-sdk/lib-dynamodb');
        const isolatedMock = require('aws-sdk-client-mock').mockClient(sdk.DynamoDBDocumentClient);
        isolatedMock.onAnyCommand().resolves({});
        const isolated = require('../../src/utils/dynamo-client');

        tablesUsed = async () => {
          await Promise.all([isolated.getConnection('c'), isolated.getUser('u'), isolated.getFriendRequest('r')]);
          return isolatedMock.commandCalls(sdk.GetCommand).map((call: any) => call.args[0].input.TableName);
        };
      });

      // Awaited outside isolateModules, which does not wait for promises itself.
      expect(await tablesUsed()).toEqual(['prod-connections', 'prod-users', 'prod-requests']);
    } finally {
      process.env = saved;
    }
  });
});

// ── Connections ───────────────────────────────────────────────────────────────

describe('dynamo-client: connections', () => {
  it('putConnection stores the record as the item', async () => {
    const record = connection();
    await db.putConnection(record);

    expect(inputOf(ddb.commandCalls(PutCommand))).toEqual({ TableName: 'Connections', Item: record });
  });

  it('deleteConnection deletes by connectionId', async () => {
    await db.deleteConnection('conn-9');
    expect(inputOf(ddb.commandCalls(DeleteCommand))).toEqual({
      TableName: 'Connections',
      Key: { connectionId: 'conn-9' },
    });
  });

  it('getConnection returns the item, or undefined when there is none', async () => {
    ddb.on(GetCommand).resolvesOnce({ Item: connection() }).resolvesOnce({});

    expect(await db.getConnection('conn-1')).toEqual(connection());
    expect(await db.getConnection('missing')).toBeUndefined();
    expect(inputOf(ddb.commandCalls(GetCommand))).toEqual({ TableName: 'Connections', Key: { connectionId: 'conn-1' } });
  });

  it('getConnectionsByUserId queries the userId-index', async () => {
    ddb.on(QueryCommand).resolves({ Items: [connection(), connection({ connectionId: 'conn-2' })] });

    const result = await db.getConnectionsByUserId('user-1');

    expect(result.map((c) => c.connectionId)).toEqual(['conn-1', 'conn-2']);
    expect(inputOf(ddb.commandCalls(QueryCommand))).toEqual({
      TableName: 'Connections',
      IndexName: 'userId-index',
      KeyConditionExpression: 'userId = :uid',
      ExpressionAttributeValues: { ':uid': 'user-1' },
    });
  });

  it('getConnectionsByUserId returns an empty list when nothing matches', async () => {
    ddb.on(QueryCommand).resolves({});
    expect(await db.getConnectionsByUserId('nobody')).toEqual([]);
  });

  it('updateConnectionLocation sets the location, timestamp and TTL (timestamp is a reserved word)', async () => {
    await db.updateConnectionLocation('conn-1', 20.5, -103.5, '2026-10-16T12:30:00.000Z', 1_800_000_600);

    expect(inputOf(ddb.commandCalls(UpdateCommand))).toEqual({
      TableName: 'Connections',
      Key: { connectionId: 'conn-1' },
      UpdateExpression: 'SET latitude = :lat, longitude = :lng, #ts = :ts, expiresAt = :exp',
      ExpressionAttributeNames: { '#ts': 'timestamp' },
      ExpressionAttributeValues: {
        ':lat': 20.5,
        ':lng': -103.5,
        ':ts': '2026-10-16T12:30:00.000Z',
        ':exp': 1_800_000_600,
      },
    });
  });

  // Documents a known gap: the Query is sent once and LastEvaluatedKey is ignored, so
  // results past DynamoDB's 1 MB page limit are silently dropped.
  it('getConnectionsByUserId reads only the first page of results', async () => {
    ddb.on(QueryCommand).resolves({ Items: [connection()], LastEvaluatedKey: { connectionId: 'conn-1' } });

    const result = await db.getConnectionsByUserId('user-1');

    expect(result).toHaveLength(1);
    expect(ddb.commandCalls(QueryCommand)).toHaveLength(1);
  });
});

describe('dynamo-client: active connections (scan)', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('scans for unexpired connections that have a location, using the current time', async () => {
    jest.spyOn(Date, 'now').mockReturnValue(1_800_000_123_456);
    ddb.on(ScanCommand).resolves({ Items: [connection()] });

    const result = await db.getActiveConnections();

    expect(result).toEqual([connection()]);
    expect(inputOf(ddb.commandCalls(ScanCommand))).toEqual({
      TableName: 'Connections',
      FilterExpression: 'expiresAt > :now AND attribute_exists(latitude) AND attribute_exists(longitude)',
      ExpressionAttributeValues: { ':now': 1_800_000_123 }, // whole seconds
    });
  });

  it('returns an empty list when nothing matches', async () => {
    ddb.on(ScanCommand).resolves({});
    expect(await db.getActiveConnections()).toEqual([]);
  });

  // Documents a known gap: a Scan reads at most 1 MB before filtering, and LastEvaluatedKey
  // is ignored, so on a large table nearby strangers are silently missing.
  it('reads only the first page of the scan', async () => {
    ddb.on(ScanCommand).resolves({ Items: [connection()], LastEvaluatedKey: { connectionId: 'conn-1' } });

    const result = await db.getActiveConnections();

    expect(result).toHaveLength(1);
    expect(ddb.commandCalls(ScanCommand)).toHaveLength(1);
  });
});

describe('dynamo-client: batchGetConnections', () => {
  it('does not call DynamoDB for an empty list', async () => {
    expect(await db.batchGetConnections([])).toEqual([]);
    expect(ddb.commandCalls(BatchGetCommand)).toHaveLength(0);
  });

  it('requests the connections by key and returns the table\'s responses', async () => {
    ddb.on(BatchGetCommand).resolves({ Responses: { Connections: [connection(), connection({ connectionId: 'conn-2' })] } });

    const result = await db.batchGetConnections(['conn-1', 'conn-2']);

    expect(result.map((c) => c.connectionId)).toEqual(['conn-1', 'conn-2']);
    expect(inputOf(ddb.commandCalls(BatchGetCommand))).toEqual({
      RequestItems: { Connections: { Keys: [{ connectionId: 'conn-1' }, { connectionId: 'conn-2' }] } },
    });
  });

  it('returns an empty list when the response has no items', async () => {
    ddb.on(BatchGetCommand).resolves({});
    expect(await db.batchGetConnections(['conn-1'])).toEqual([]);
  });

  // Documents known gaps (this function currently has no callers): UnprocessedKeys are
  // dropped, and DynamoDB's limit of 100 keys per request is not respected.
  it('drops UnprocessedKeys instead of retrying them', async () => {
    ddb.on(BatchGetCommand).resolves({
      Responses: { Connections: [connection()] },
      UnprocessedKeys: { Connections: { Keys: [{ connectionId: 'conn-2' }] } },
    });

    const result = await db.batchGetConnections(['conn-1', 'conn-2']);

    expect(result).toHaveLength(1);
    expect(ddb.commandCalls(BatchGetCommand)).toHaveLength(1);
  });

  it('sends every key in one request, even above the 100-key limit', async () => {
    const ids = Array.from({ length: 150 }, (_, i) => `conn-${i}`);

    await db.batchGetConnections(ids);

    expect(ddb.commandCalls(BatchGetCommand)).toHaveLength(1);
    const input = inputOf(ddb.commandCalls(BatchGetCommand)) as any;
    expect(input.RequestItems.Connections.Keys).toHaveLength(150);
  });
});

// ── Users ─────────────────────────────────────────────────────────────────────

describe('dynamo-client: users', () => {
  it('getUser returns the item, or undefined when there is none', async () => {
    ddb.on(GetCommand).resolvesOnce({ Item: profile() }).resolvesOnce({});

    expect(await db.getUser('user-1')).toEqual(profile());
    expect(await db.getUser('missing')).toBeUndefined();
    expect(inputOf(ddb.commandCalls(GetCommand))).toEqual({ TableName: 'Users', Key: { userId: 'user-1' } });
  });

  describe('putUser', () => {
    it('defaults the friend list and dates to empty', async () => {
      await db.putUser(profile());

      expect(inputOf(ddb.commandCalls(PutCommand))).toEqual({
        TableName: 'Users',
        Item: { ...profile(), friendIds: [], friendshipDates: {} },
      });
    });

    it('keeps a friend list and dates that are provided', async () => {
      const withFriends = profile({ friendIds: ['a'], friendshipDates: { a: '2026-02-02T00:00:00.000Z' } });

      await db.putUser(withFriends);

      expect((inputOf(ddb.commandCalls(PutCommand)) as any).Item).toEqual(withFriends);
    });

    // Documents current behaviour: the write replaces the whole item, so calling putUser for an
    // existing user whose profile object lacks friendIds would wipe their friends. The REST
    // handler only calls it when the user does not exist yet.
    it('replaces the whole item, resetting friends when the profile has none', async () => {
      await db.putUser(profile({ friendIds: undefined }));
      expect((inputOf(ddb.commandCalls(PutCommand)) as any).Item.friendIds).toEqual([]);
    });
  });

  describe('updateUser', () => {
    it('updates only the displayName', async () => {
      await db.updateUser('user-1', { displayName: 'New' });

      expect(inputOf(ddb.commandCalls(UpdateCommand))).toEqual({
        TableName: 'Users',
        Key: { userId: 'user-1' },
        UpdateExpression: 'SET #dn = :dn',
        ExpressionAttributeNames: { '#dn': 'displayName' },
        ExpressionAttributeValues: { ':dn': 'New' },
      });
    });

    it('updates all three editable fields in a fixed order', async () => {
      await db.updateUser('user-1', { discoverable: true, profilePictureKey: 'k', displayName: 'N' });

      expect(inputOf(ddb.commandCalls(UpdateCommand))).toEqual({
        TableName: 'Users',
        Key: { userId: 'user-1' },
        UpdateExpression: 'SET #dn = :dn, #ppk = :ppk, #disc = :disc',
        ExpressionAttributeNames: { '#dn': 'displayName', '#ppk': 'profilePictureKey', '#disc': 'discoverable' },
        ExpressionAttributeValues: { ':dn': 'N', ':ppk': 'k', ':disc': true },
      });
    });

    it.each([
      ['discoverable: false', { discoverable: false }, ':disc', false],
      ['an empty displayName', { displayName: '' }, ':dn', ''],
    ])('still writes %s (a falsy value is a change)', async (_name, updates, placeholder, value) => {
      await db.updateUser('user-1', updates);

      expect((inputOf(ddb.commandCalls(UpdateCommand)) as any).ExpressionAttributeValues).toEqual({
        [placeholder]: value,
      });
    });

    it('sends nothing when there are no changes', async () => {
      await db.updateUser('user-1', {});
      await db.updateUser('user-1', { displayName: undefined });

      expect(ddb.commandCalls(UpdateCommand)).toHaveLength(0);
    });
  });
});

// ── Friendships (stored on the Users item) ────────────────────────────────────

describe('dynamo-client: friendships', () => {
  const given = (user: UserProfile | undefined) => ddb.on(GetCommand).resolves({ Item: user });

  describe('getFriends', () => {
    it('returns an empty list for an unknown user or one without friends', async () => {
      given(undefined);
      expect(await db.getFriends('user-1')).toEqual([]);

      given(profile({ friendIds: undefined }));
      expect(await db.getFriends('user-1')).toEqual([]);

      given(profile({ friendIds: [] }));
      expect(await db.getFriends('user-1')).toEqual([]);
    });

    it('maps each friend id with the date they became friends', async () => {
      given(profile({ friendIds: ['a', 'b'], friendshipDates: { a: '2026-02-02T00:00:00.000Z', b: '2026-03-03T00:00:00.000Z' } }));

      expect(await db.getFriends('user-1')).toEqual([
        { userId: 'user-1', friendId: 'a', createdAt: '2026-02-02T00:00:00.000Z' },
        { userId: 'user-1', friendId: 'b', createdAt: '2026-03-03T00:00:00.000Z' },
      ]);
    });

    it('falls back to the profile creation date when a friendship date is missing', async () => {
      given(profile({ friendIds: ['a'], friendshipDates: undefined }));

      expect(await db.getFriends('user-1')).toEqual([
        { userId: 'user-1', friendId: 'a', createdAt: '2026-01-01T00:00:00.000Z' },
      ]);
    });
  });

  describe('getFriendCount', () => {
    it('counts the friends, and is 0 for an unknown user or an empty list', async () => {
      given(profile({ friendIds: ['a', 'b', 'c'] }));
      expect(await db.getFriendCount('user-1')).toBe(3);

      given(undefined);
      expect(await db.getFriendCount('user-1')).toBe(0);

      given(profile({ friendIds: undefined }));
      expect(await db.getFriendCount('user-1')).toBe(0);
    });
  });

  describe('putFriendship', () => {
    it('adds the friend and records when it happened', async () => {
      given(profile({ friendIds: ['a'], friendshipDates: { a: '2026-02-02T00:00:00.000Z' } }));

      await db.putFriendship('user-1', 'b');

      const input = inputOf(ddb.commandCalls(UpdateCommand)) as any;
      expect(input).toMatchObject({
        TableName: 'Users',
        Key: { userId: 'user-1' },
        UpdateExpression: 'SET friendIds = :fids, friendshipDates = :fdates',
      });
      expect(input.ExpressionAttributeValues[':fids']).toEqual(['a', 'b']);
      expect(Object.keys(input.ExpressionAttributeValues[':fdates']).sort()).toEqual(['a', 'b']);
      expect(input.ExpressionAttributeValues[':fdates'].a).toBe('2026-02-02T00:00:00.000Z');
      expect(input.ExpressionAttributeValues[':fdates'].b).toMatch(ISO);
    });

    it('starts a new list for a user without friends', async () => {
      given(profile({ friendIds: undefined, friendshipDates: undefined }));

      await db.putFriendship('user-1', 'a');

      expect((inputOf(ddb.commandCalls(UpdateCommand)) as any).ExpressionAttributeValues[':fids']).toEqual(['a']);
    });

    it('is idempotent: an existing friend causes no write', async () => {
      given(profile({ friendIds: ['a'], friendshipDates: { a: '2026-02-02T00:00:00.000Z' } }));

      await db.putFriendship('user-1', 'a');

      expect(ddb.commandCalls(UpdateCommand)).toHaveLength(0);
    });

    // Documents a known gap: the whole list is read, changed in memory and written back
    // (SET friendIds = :fids), not added atomically. Two accepts for the same user at the
    // same time can overwrite each other and lose a friend. It is also stored as a list,
    // while AGENTS.md describes a string set.
    it('writes back the whole list it read, so a concurrent add could be lost', async () => {
      given(profile({ friendIds: ['a'] }));

      await db.putFriendship('user-1', 'b');

      const input = inputOf(ddb.commandCalls(UpdateCommand)) as any;
      expect(input.UpdateExpression).toBe('SET friendIds = :fids, friendshipDates = :fdates');
      expect(input.UpdateExpression).not.toMatch(/ADD|list_append/);
      expect(Array.isArray(input.ExpressionAttributeValues[':fids'])).toBe(true);
    });
  });

  describe('deleteFriendship', () => {
    it('removes the friend and their date, keeping the others', async () => {
      given(profile({ friendIds: ['a', 'b'], friendshipDates: { a: 'date-a', b: 'date-b' } }));

      await db.deleteFriendship('user-1', 'a');

      expect(inputOf(ddb.commandCalls(UpdateCommand))).toEqual({
        TableName: 'Users',
        Key: { userId: 'user-1' },
        UpdateExpression: 'SET friendIds = :fids, friendshipDates = :fdates',
        ExpressionAttributeValues: { ':fids': ['b'], ':fdates': { b: 'date-b' } },
      });
    });

    it.each([
      ['an unknown user', undefined],
      ['a user without a friend list', profile({ friendIds: undefined })],
    ])('writes nothing for %s', async (_name, user) => {
      given(user);

      await db.deleteFriendship('user-1', 'a');

      expect(ddb.commandCalls(UpdateCommand)).toHaveLength(0);
    });

    it('copes with a friend list that has no dates recorded', async () => {
      given(profile({ friendIds: ['a', 'b'], friendshipDates: undefined }));

      await db.deleteFriendship('user-1', 'a');

      const values = (inputOf(ddb.commandCalls(UpdateCommand)) as any).ExpressionAttributeValues;
      expect(values).toEqual({ ':fids': ['b'], ':fdates': {} });
    });

    // Documents current behaviour: removing someone who is not a friend still rewrites the
    // unchanged list.
    it('rewrites the unchanged list when the person was not a friend', async () => {
      given(profile({ friendIds: ['a'], friendshipDates: { a: 'date-a' } }));

      await db.deleteFriendship('user-1', 'zzz');

      expect((inputOf(ddb.commandCalls(UpdateCommand)) as any).ExpressionAttributeValues[':fids']).toEqual(['a']);
    });
  });
});

// ── Friend requests ───────────────────────────────────────────────────────────

describe('dynamo-client: friend requests', () => {
  const request: FriendRequest = {
    requestId: 'req-1',
    fromUserId: 'user-2',
    toUserId: 'user-1',
    status: 'pending',
    createdAt: '2026-10-16T12:00:00.000Z',
  };

  it('putFriendRequest stores the request', async () => {
    await db.putFriendRequest(request);
    expect(inputOf(ddb.commandCalls(PutCommand))).toEqual({ TableName: 'FriendRequests', Item: request });
  });

  it('getFriendRequest returns the item, or undefined when there is none', async () => {
    ddb.on(GetCommand).resolvesOnce({ Item: request }).resolvesOnce({});

    expect(await db.getFriendRequest('req-1')).toEqual(request);
    expect(await db.getFriendRequest('missing')).toBeUndefined();
    expect(inputOf(ddb.commandCalls(GetCommand))).toEqual({ TableName: 'FriendRequests', Key: { requestId: 'req-1' } });
  });

  it('getFriendRequestsByToUser queries the toUserId-index', async () => {
    ddb.on(QueryCommand).resolves({ Items: [request] });

    expect(await db.getFriendRequestsByToUser('user-1')).toEqual([request]);
    expect(inputOf(ddb.commandCalls(QueryCommand))).toEqual({
      TableName: 'FriendRequests',
      IndexName: 'toUserId-index',
      KeyConditionExpression: 'toUserId = :tuid',
      ExpressionAttributeValues: { ':tuid': 'user-1' },
    });
  });

  it('getFriendRequestsByToUser returns an empty list when nothing matches', async () => {
    ddb.on(QueryCommand).resolves({});
    expect(await db.getFriendRequestsByToUser('user-1')).toEqual([]);
  });

  it('deleteFriendRequest deletes by requestId', async () => {
    await db.deleteFriendRequest('req-1');
    expect(inputOf(ddb.commandCalls(DeleteCommand))).toEqual({
      TableName: 'FriendRequests',
      Key: { requestId: 'req-1' },
    });
  });
});

// ── Errors ────────────────────────────────────────────────────────────────────

describe('dynamo-client: errors', () => {
  it('lets DynamoDB errors reach the caller unchanged', async () => {
    const failure = Object.assign(new Error('Throughput exceeded'), { name: 'ProvisionedThroughputExceededException' });
    ddb.onAnyCommand().rejects(failure);

    await expect(db.getUser('user-1')).rejects.toBe(failure);
    await expect(db.putConnection(connection())).rejects.toBe(failure);
    await expect(db.getActiveConnections()).rejects.toBe(failure);
    await expect(db.updateUser('user-1', { displayName: 'x' })).rejects.toBe(failure);
  });

  it('does not write when the read that precedes it fails', async () => {
    ddb.on(GetCommand).rejects(new Error('boom'));

    await expect(db.putFriendship('user-1', 'a')).rejects.toThrow('boom');
    await expect(db.deleteFriendship('user-1', 'a')).rejects.toThrow('boom');

    expect(ddb.commandCalls(UpdateCommand)).toHaveLength(0);
  });
});
