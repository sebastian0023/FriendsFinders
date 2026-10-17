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
  TransactWriteCommand,
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
  it('defaults to Connections, Users, FriendRequests and Friendships', async () => {
    await db.getConnection('c');
    await db.getUser('u');
    await db.getFriendRequest('r');
    await db.areFriends('a', 'b');

    expect(inputOf(ddb.commandCalls(GetCommand), 0)).toMatchObject({ TableName: 'Connections' });
    expect(inputOf(ddb.commandCalls(GetCommand), 1)).toMatchObject({ TableName: 'Users' });
    expect(inputOf(ddb.commandCalls(GetCommand), 2)).toMatchObject({ TableName: 'FriendRequests' });
    expect(inputOf(ddb.commandCalls(GetCommand), 3)).toMatchObject({ TableName: 'Friendships' });
  });

  it('takes the names from the environment when set', async () => {
    const saved = { ...process.env };
    process.env.CONNECTIONS_TABLE_NAME = 'prod-connections';
    process.env.USERS_TABLE_NAME = 'prod-users';
    process.env.FRIEND_REQUESTS_TABLE_NAME = 'prod-requests';
    process.env.FRIENDSHIPS_TABLE_NAME = 'prod-friendships';

    try {
      let tablesUsed!: () => Promise<string[]>;

      jest.isolateModules(() => {
        // A fresh module registry has its own copy of the SDK, so mock that copy too.
        const sdk = require('@aws-sdk/lib-dynamodb');
        const isolatedMock = require('aws-sdk-client-mock').mockClient(sdk.DynamoDBDocumentClient);
        isolatedMock.onAnyCommand().resolves({});
        const isolated = require('../../src/utils/dynamo-client');

        tablesUsed = async () => {
          await Promise.all([
            isolated.getConnection('c'),
            isolated.getUser('u'),
            isolated.getFriendRequest('r'),
            isolated.areFriends('a', 'b'),
          ]);
          return isolatedMock.commandCalls(sdk.GetCommand).map((call: any) => call.args[0].input.TableName);
        };
      });

      // Awaited outside isolateModules, which does not wait for promises itself.
      expect(await tablesUsed()).toEqual(['prod-connections', 'prod-users', 'prod-requests', 'prod-friendships']);
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
    it('stores the profile as given', async () => {
      await db.putUser(profile({ profilePictureKey: 'k' }));

      expect(inputOf(ddb.commandCalls(PutCommand))).toEqual({
        TableName: 'Users',
        Item: profile({ profilePictureKey: 'k' }),
      });
    });

    // Friendships live in their own table, so a profile write can never touch a user's friends.
    it('writes no friend data into the profile', async () => {
      await db.putUser(profile());

      const item = (inputOf(ddb.commandCalls(PutCommand)) as any).Item;
      expect(item).not.toHaveProperty('friendIds');
      expect(item).not.toHaveProperty('friendshipDates');
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

// ── Friendships (one item per direction, in their own table) ──────────────────

const cancelled = (...codes: string[]) =>
  Object.assign(new Error('Transaction cancelled'), {
    name: 'TransactionCanceledException',
    CancellationReasons: codes.map((Code) => ({ Code })),
  });

describe('dynamo-client: friendships', () => {
  describe('getFriends', () => {
    it('queries the friendships of the user', async () => {
      ddb.on(QueryCommand).resolves({ Items: [] });

      await db.getFriends('user-1');

      expect(inputOf(ddb.commandCalls(QueryCommand))).toEqual({
        TableName: 'Friendships',
        KeyConditionExpression: 'userId = :uid',
        ExpressionAttributeValues: { ':uid': 'user-1' },
      });
    });

    it('returns each friend with the date they became friends', async () => {
      ddb.on(QueryCommand).resolves({
        Items: [
          { userId: 'user-1', friendId: 'a', createdAt: '2026-02-02T00:00:00.000Z' },
          { userId: 'user-1', friendId: 'b', createdAt: '2026-03-03T00:00:00.000Z' },
        ],
      });

      expect(await db.getFriends('user-1')).toEqual([
        { userId: 'user-1', friendId: 'a', createdAt: '2026-02-02T00:00:00.000Z' },
        { userId: 'user-1', friendId: 'b', createdAt: '2026-03-03T00:00:00.000Z' },
      ]);
    });

    it.each([
      ['no items', { Items: [] }],
      ['no Items field', {}],
    ])('returns an empty list for %s', async (_name, response) => {
      ddb.on(QueryCommand).resolves(response);
      expect(await db.getFriends('user-1')).toEqual([]);
    });

    it('follows LastEvaluatedKey, so friends beyond the first page are not lost', async () => {
      const row = (friendId: string) => ({ userId: 'user-1', friendId, createdAt: 'd' });
      ddb
        .on(QueryCommand)
        .resolvesOnce({ Items: [row('a'), row('b')], LastEvaluatedKey: { userId: 'user-1', friendId: 'b' } })
        .resolvesOnce({ Items: [row('c')], LastEvaluatedKey: { userId: 'user-1', friendId: 'c' } })
        .resolvesOnce({ Items: [row('d')] });

      const friends = await db.getFriends('user-1');

      expect(friends.map((f) => f.friendId)).toEqual(['a', 'b', 'c', 'd']);
      const calls = ddb.commandCalls(QueryCommand);
      expect(calls).toHaveLength(3);
      expect((inputOf(calls, 0) as any).ExclusiveStartKey).toBeUndefined();
      expect((inputOf(calls, 1) as any).ExclusiveStartKey).toEqual({ userId: 'user-1', friendId: 'b' });
      expect((inputOf(calls, 2) as any).ExclusiveStartKey).toEqual({ userId: 'user-1', friendId: 'c' });
    });
  });

  describe('getFriendCount', () => {
    it('asks DynamoDB only for the count', async () => {
      ddb.on(QueryCommand).resolves({ Count: 3 });

      expect(await db.getFriendCount('user-1')).toBe(3);
      expect(inputOf(ddb.commandCalls(QueryCommand))).toEqual({
        TableName: 'Friendships',
        KeyConditionExpression: 'userId = :uid',
        ExpressionAttributeValues: { ':uid': 'user-1' },
        Select: 'COUNT',
      });
    });

    it('is 0 when there are no friends', async () => {
      ddb.on(QueryCommand).resolves({});
      expect(await db.getFriendCount('user-1')).toBe(0);
    });

    it('adds up the counts of every page', async () => {
      ddb
        .on(QueryCommand)
        .resolvesOnce({ Count: 1000, LastEvaluatedKey: { userId: 'user-1', friendId: 'x' } })
        .resolvesOnce({ Count: 234 });

      expect(await db.getFriendCount('user-1')).toBe(1234);
      expect(ddb.commandCalls(QueryCommand)).toHaveLength(2);
      expect((inputOf(ddb.commandCalls(QueryCommand), 1) as any).ExclusiveStartKey).toEqual({
        userId: 'user-1',
        friendId: 'x',
      });
    });
  });

  describe('areFriends', () => {
    it('looks up the single friendship item', async () => {
      ddb.on(GetCommand).resolves({ Item: { userId: 'user-1', friendId: 'user-2', createdAt: 'd' } });

      expect(await db.areFriends('user-1', 'user-2')).toBe(true);
      expect(inputOf(ddb.commandCalls(GetCommand))).toEqual({
        TableName: 'Friendships',
        Key: { userId: 'user-1', friendId: 'user-2' },
      });
    });

    it('is false when there is no such item', async () => {
      ddb.on(GetCommand).resolves({});
      expect(await db.areFriends('user-1', 'user-2')).toBe(false);
    });
  });

  describe('createFriendship', () => {
    const create = () => db.createFriendship('user-1', 'user-2', 'req-1');

    it('writes both directions and deletes the request in one transaction', async () => {
      await create();

      expect(ddb.commandCalls(TransactWriteCommand)).toHaveLength(1);
      const items = (inputOf(ddb.commandCalls(TransactWriteCommand)) as any).TransactItems;
      expect(items).toHaveLength(3);

      expect(items[0].Update).toMatchObject({
        TableName: 'Friendships',
        Key: { userId: 'user-1', friendId: 'user-2' },
        UpdateExpression: 'SET createdAt = if_not_exists(createdAt, :now)',
      });
      expect(items[1].Update).toMatchObject({
        TableName: 'Friendships',
        Key: { userId: 'user-2', friendId: 'user-1' },
        UpdateExpression: 'SET createdAt = if_not_exists(createdAt, :now)',
      });
      expect(items[2].Delete).toEqual({
        TableName: 'FriendRequests',
        Key: { requestId: 'req-1' },
        ConditionExpression: 'attribute_exists(requestId)',
      });
    });

    it('stamps both directions with the same date, and keeps an existing one', async () => {
      await create();

      const [first, second] = (inputOf(ddb.commandCalls(TransactWriteCommand)) as any).TransactItems;
      expect(first.Update.ExpressionAttributeValues[':now']).toMatch(ISO);
      expect(second.Update.ExpressionAttributeValues[':now']).toBe(first.Update.ExpressionAttributeValues[':now']);
      // if_not_exists makes repeating the call harmless: the original date is never overwritten
      expect(first.Update.UpdateExpression).toContain('if_not_exists(createdAt');
    });

    it('reports success', async () => {
      await expect(create()).resolves.toBe('created');
    });

    it('reports request_not_found when the request no longer exists', async () => {
      ddb.on(TransactWriteCommand).rejects(cancelled('None', 'None', 'ConditionalCheckFailed'));

      await expect(create()).resolves.toBe('request_not_found');
      expect(ddb.commandCalls(TransactWriteCommand)).toHaveLength(1); // not retried
    });

    it.each([
      ['a validation problem', cancelled('ValidationError', 'None', 'None')],
      ['throttling', cancelled('ThrottlingError', 'None', 'None')],
      ['a cancellation that lists no reasons', Object.assign(new Error('x'), { name: 'TransactionCanceledException' })],
      [
        'an error that carries reasons but is not a cancellation',
        Object.assign(new Error('x'), {
          name: 'SomethingElse',
          CancellationReasons: [{ Code: 'None' }, { Code: 'None' }, { Code: 'ConditionalCheckFailed' }],
        }),
      ],
      ['an error that is not a cancellation', Object.assign(new Error('boom'), { name: 'InternalServerError' })],
    ])('rethrows %s without retrying', async (_name, failure) => {
      ddb.on(TransactWriteCommand).rejects(failure);

      await expect(create()).rejects.toBe(failure);
      expect(ddb.commandCalls(TransactWriteCommand)).toHaveLength(1);
    });

    it('retries when another transaction is touching the same items', async () => {
      ddb
        .on(TransactWriteCommand)
        .rejectsOnce(cancelled('TransactionConflict', 'None', 'None'))
        .resolves({});

      await expect(create()).resolves.toBe('created');
      expect(ddb.commandCalls(TransactWriteCommand)).toHaveLength(2);
    });

    it('gives up after three conflicting attempts', async () => {
      const conflict = cancelled('None', 'TransactionConflict', 'None');
      ddb.on(TransactWriteCommand).rejects(conflict);

      await expect(create()).rejects.toBe(conflict);
      expect(ddb.commandCalls(TransactWriteCommand)).toHaveLength(3);
    });

    it('does not report request_not_found for a conflict on the request item', async () => {
      ddb.on(TransactWriteCommand).rejectsOnce(cancelled('None', 'None', 'TransactionConflict')).resolves({});

      await expect(create()).resolves.toBe('created');
    });
  });

  describe('removeFriendship', () => {
    const remove = () => db.removeFriendship('user-1', 'user-2');

    it('deletes both directions in one transaction', async () => {
      await remove();

      expect(ddb.commandCalls(TransactWriteCommand)).toHaveLength(1);
      expect((inputOf(ddb.commandCalls(TransactWriteCommand)) as any).TransactItems).toEqual([
        { Delete: { TableName: 'Friendships', Key: { userId: 'user-1', friendId: 'user-2' } } },
        { Delete: { TableName: 'Friendships', Key: { userId: 'user-2', friendId: 'user-1' } } },
      ]);
    });

    it('is harmless to repeat, because the deletes have no condition', async () => {
      await remove();

      const items = (inputOf(ddb.commandCalls(TransactWriteCommand)) as any).TransactItems;
      for (const item of items) expect(item.Delete).not.toHaveProperty('ConditionExpression');
    });

    it('retries on a transaction conflict and then succeeds', async () => {
      ddb.on(TransactWriteCommand).rejectsOnce(cancelled('TransactionConflict', 'None')).resolves({});

      await expect(remove()).resolves.toBeUndefined();
      expect(ddb.commandCalls(TransactWriteCommand)).toHaveLength(2);
    });

    it('gives up after three conflicting attempts', async () => {
      const conflict = cancelled('TransactionConflict', 'TransactionConflict');
      ddb.on(TransactWriteCommand).rejects(conflict);

      await expect(remove()).rejects.toBe(conflict);
      expect(ddb.commandCalls(TransactWriteCommand)).toHaveLength(3);
    });

    it('rethrows any other failure without retrying', async () => {
      const failure = new Error('boom');
      ddb.on(TransactWriteCommand).rejects(failure);

      await expect(remove()).rejects.toBe(failure);
      expect(ddb.commandCalls(TransactWriteCommand)).toHaveLength(1);
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

});
