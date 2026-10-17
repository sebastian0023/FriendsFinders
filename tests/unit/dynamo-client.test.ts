import { mockClient } from 'aws-sdk-client-mock';
import {
  DynamoDBDocumentClient,
  PutCommand,
  GetCommand,
  DeleteCommand,
  QueryCommand,
  UpdateCommand,
  ScanCommand,
  TransactWriteCommand,
} from '@aws-sdk/lib-dynamodb';
import * as db from '../../src/utils/dynamo-client';
import { cellsAround } from '../../src/utils/geo-cells';
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

  it('updateConnectionLocation sets the location, its grid cell, timestamp and TTL (timestamp is a reserved word)', async () => {
    await db.updateConnectionLocation('conn-1', 20.5, -103.5, '2026-10-16T12:30:00.000Z', 1_800_000_600);

    expect(inputOf(ddb.commandCalls(UpdateCommand))).toEqual({
      TableName: 'Connections',
      Key: { connectionId: 'conn-1' },
      UpdateExpression: 'SET latitude = :lat, longitude = :lng, geoCell = :cell, #ts = :ts, expiresAt = :exp',
      ExpressionAttributeNames: { '#ts': 'timestamp' },
      ExpressionAttributeValues: {
        ':lat': 20.5,
        ':lng': -103.5,
        ':cell': '1105:765',
        ':ts': '2026-10-16T12:30:00.000Z',
        ':exp': 1_800_000_600,
      },
    });
  });

  // The cell key is what the geoCell-index is built on, so it must follow the connection when it moves.
  it('updateConnectionLocation moves the connection to the cell of its new location', async () => {
    await db.updateConnectionLocation('conn-1', 20.5, -103.5, 't1', 1);
    await db.updateConnectionLocation('conn-1', 21.5, -102.5, 't2', 2);

    const cells = ddb.commandCalls(UpdateCommand).map((call) => (call.args[0].input as any).ExpressionAttributeValues[':cell']);
    expect(cells).toEqual(['1105:765', '1115:775']);
  });

  it('getConnectionsByUserId follows LastEvaluatedKey, so no connection is missed', async () => {
    ddb
      .on(QueryCommand)
      .resolvesOnce({ Items: [connection({ connectionId: 'conn-1' })], LastEvaluatedKey: { connectionId: 'conn-1' } })
      .resolvesOnce({ Items: [connection({ connectionId: 'conn-2' })] });

    const result = await db.getConnectionsByUserId('user-1');

    expect(result.map((c) => c.connectionId)).toEqual(['conn-1', 'conn-2']);
    const calls = ddb.commandCalls(QueryCommand);
    expect(calls).toHaveLength(2);
    expect((inputOf(calls, 0) as any).ExclusiveStartKey).toBeUndefined();
    expect(inputOf(calls, 1)).toMatchObject({
      IndexName: 'userId-index',
      KeyConditionExpression: 'userId = :uid',
      ExclusiveStartKey: { connectionId: 'conn-1' },
    });
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

  it('follows LastEvaluatedKey until the whole table has been read', async () => {
    jest.spyOn(Date, 'now').mockReturnValue(1_800_000_123_456);
    ddb
      .on(ScanCommand)
      .resolvesOnce({ Items: [connection({ connectionId: 'c1' })], LastEvaluatedKey: { connectionId: 'c1' } })
      .resolvesOnce({ Items: [connection({ connectionId: 'c2' })], LastEvaluatedKey: { connectionId: 'c2' } })
      .resolvesOnce({ Items: [connection({ connectionId: 'c3' })] });

    const result = await db.getActiveConnections();

    expect(result.map((c) => c.connectionId)).toEqual(['c1', 'c2', 'c3']);
    const calls = ddb.commandCalls(ScanCommand);
    expect(calls).toHaveLength(3);
    expect((inputOf(calls, 0) as any).ExclusiveStartKey).toBeUndefined();
    expect((inputOf(calls, 1) as any).ExclusiveStartKey).toEqual({ connectionId: 'c1' });
    expect((inputOf(calls, 2) as any).ExclusiveStartKey).toEqual({ connectionId: 'c2' });
    // every page applies the same filter
    for (const index of [0, 1, 2]) {
      expect(inputOf(calls, index)).toMatchObject({
        TableName: 'Connections',
        FilterExpression: 'expiresAt > :now AND attribute_exists(latitude) AND attribute_exists(longitude)',
      });
    }
  });

  it('uses the same time on every page', async () => {
    jest.spyOn(Date, 'now').mockReturnValueOnce(1_800_000_000_000).mockReturnValue(1_900_000_000_000);
    ddb
      .on(ScanCommand)
      .resolvesOnce({ Items: [connection()], LastEvaluatedKey: { connectionId: 'x' } })
      .resolvesOnce({ Items: [connection()] });

    await db.getActiveConnections();

    const calls = ddb.commandCalls(ScanCommand);
    expect((inputOf(calls, 0) as any).ExpressionAttributeValues[':now']).toBe(1_800_000_000);
    expect((inputOf(calls, 1) as any).ExpressionAttributeValues[':now']).toBe(1_800_000_000);
  });

  // A Scan reads the whole table, so one request must never turn into an unbounded read.
  describe('safety cap', () => {
    it('stops after 20 pages and warns that the results are incomplete', async () => {
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
      ddb.on(ScanCommand).callsFake(async () => ({
        Items: [connection()],
        LastEvaluatedKey: { connectionId: 'more' },
      }));

      const result = await db.getActiveConnections();

      expect(ddb.commandCalls(ScanCommand)).toHaveLength(20);
      expect(result).toHaveLength(20); // what was read before stopping is still returned
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(expect.stringMatching(/Connections.*20 pages.*incomplete/));
    });

    it('does not warn when the twentieth page is also the last', async () => {
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
      let page = 0;
      ddb.on(ScanCommand).callsFake(async () => {
        page += 1;
        return page < 20 ? { Items: [connection()], LastEvaluatedKey: { connectionId: 'more' } } : { Items: [connection()] };
      });

      const result = await db.getActiveConnections();

      expect(ddb.commandCalls(ScanCommand)).toHaveLength(20);
      expect(result).toHaveLength(20);
      expect(warn).not.toHaveBeenCalled();
    });
  });
});

describe('dynamo-client: connections near a point', () => {
  const GDL = { lat: 20.6597, lng: -103.3496 };
  const cellFrom = (call: { args: [{ input: unknown }] }) => (call.args[0].input as any).ExpressionAttributeValues[':cell'];

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('queries every covering cell on the geoCell-index, and nothing else', async () => {
    jest.spyOn(Date, 'now').mockReturnValue(1_800_000_123_456);
    ddb.on(QueryCommand).resolves({ Items: [] });

    await db.getConnectionsNear(GDL.lat, GDL.lng, 5);

    const calls = ddb.commandCalls(QueryCommand);
    const expected = cellsAround(GDL.lat, GDL.lng, 5) as string[];
    expect(calls).toHaveLength(expected.length);
    expect(calls.map(cellFrom).sort()).toEqual([...expected].sort());
    for (const call of calls) {
      expect(call.args[0].input).toMatchObject({
        TableName: 'Connections',
        IndexName: 'geoCell-index',
        KeyConditionExpression: 'geoCell = :cell',
        FilterExpression: 'expiresAt > :now',
      });
      expect((call.args[0].input as any).ExpressionAttributeValues[':now']).toBe(1_800_000_123); // whole seconds
    }
    expect(ddb.commandCalls(ScanCommand)).toHaveLength(0);
  });

  it('returns the connections of all the cells together', async () => {
    ddb.on(QueryCommand).callsFake(async (input: any) => ({
      Items: [connection({ connectionId: `in-${input.ExpressionAttributeValues[':cell']}` })],
    }));

    const result = await db.getConnectionsNear(GDL.lat, GDL.lng, 5);

    const expected = (cellsAround(GDL.lat, GDL.lng, 5) as string[]).map((cell) => `in-${cell}`);
    expect(result.map((c) => c.connectionId).sort()).toEqual([...expected].sort());
  });

  it('returns an empty list when nobody is near', async () => {
    ddb.on(QueryCommand).resolves({});
    expect(await db.getConnectionsNear(GDL.lat, GDL.lng, 5)).toEqual([]);
  });

  it('follows LastEvaluatedKey within a cell', async () => {
    const cells = cellsAround(GDL.lat, GDL.lng, 5) as string[];
    const busy = cells[0];
    ddb.on(QueryCommand).callsFake(async (input: any) => {
      if (input.ExpressionAttributeValues[':cell'] !== busy) return { Items: [] };
      return input.ExclusiveStartKey
        ? { Items: [connection({ connectionId: 'page-2' })] }
        : { Items: [connection({ connectionId: 'page-1' })], LastEvaluatedKey: { connectionId: 'page-1' } };
    });

    const result = await db.getConnectionsNear(GDL.lat, GDL.lng, 5);

    expect(result.map((c) => c.connectionId).sort()).toEqual(['page-1', 'page-2']);
    expect(ddb.commandCalls(QueryCommand)).toHaveLength(cells.length + 1);
  });

  it('uses the same time for every cell', async () => {
    jest.spyOn(Date, 'now').mockReturnValueOnce(1_800_000_000_000).mockReturnValue(1_900_000_000_000);
    ddb.on(QueryCommand).resolves({ Items: [] });

    await db.getConnectionsNear(GDL.lat, GDL.lng, 5);

    for (const call of ddb.commandCalls(QueryCommand)) {
      expect((call.args[0].input as any).ExpressionAttributeValues[':now']).toBe(1_800_000_000);
    }
  });

  describe('when the radius is too wide for the index', () => {
    it('falls back to the capped scan of all active connections', async () => {
      ddb.on(ScanCommand).resolves({ Items: [connection({ connectionId: 'from-scan' })] });

      const result = await db.getConnectionsNear(GDL.lat, GDL.lng, 1000);

      expect(result.map((c) => c.connectionId)).toEqual(['from-scan']);
      expect(ddb.commandCalls(ScanCommand)).toHaveLength(1);
      expect(ddb.commandCalls(QueryCommand)).toHaveLength(0);
    });

    it('falls back near a pole, where every longitude is in range', async () => {
      ddb.on(ScanCommand).resolves({ Items: [] });

      await db.getConnectionsNear(89.99, 10, 5);

      expect(ddb.commandCalls(ScanCommand)).toHaveLength(1);
      expect(ddb.commandCalls(QueryCommand)).toHaveLength(0);
    });
  });

  it('lets DynamoDB errors reach the caller', async () => {
    const failure = new Error('ProvisionedThroughputExceededException');
    ddb.on(QueryCommand).rejects(failure);

    await expect(db.getConnectionsNear(GDL.lat, GDL.lng, 5)).rejects.toBe(failure);
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

  it('getFriendRequestsByToUser follows LastEvaluatedKey', async () => {
    ddb
      .on(QueryCommand)
      .resolvesOnce({ Items: [request], LastEvaluatedKey: { requestId: 'req-1' } })
      .resolvesOnce({ Items: [{ ...request, requestId: 'req-2' }] });

    const result = await db.getFriendRequestsByToUser('user-1');

    expect(result.map((r) => r.requestId)).toEqual(['req-1', 'req-2']);
    const calls = ddb.commandCalls(QueryCommand);
    expect(calls).toHaveLength(2);
    expect((inputOf(calls, 1) as any).ExclusiveStartKey).toEqual({ requestId: 'req-1' });
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
