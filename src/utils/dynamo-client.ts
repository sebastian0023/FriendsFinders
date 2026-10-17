import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
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
  TransactWriteCommandInput,
} from '@aws-sdk/lib-dynamodb';
import { ConnectionRecord, UserProfile, FriendRequest } from '../types';

const ddbClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(ddbClient, {
  marshallOptions: { removeUndefinedValues: true },
});

const CONNECTIONS_TABLE = process.env.CONNECTIONS_TABLE_NAME || 'Connections';
const USERS_TABLE = process.env.USERS_TABLE_NAME || 'Users';
const FRIEND_REQUESTS_TABLE = process.env.FRIEND_REQUESTS_TABLE_NAME || 'FriendRequests';
const FRIENDSHIPS_TABLE = process.env.FRIENDSHIPS_TABLE_NAME || 'Friendships';

// --- Connections Table ---

export async function putConnection(record: ConnectionRecord): Promise<void> {
  await docClient.send(new PutCommand({
    TableName: CONNECTIONS_TABLE,
    Item: record,
  }));
}

export async function deleteConnection(connectionId: string): Promise<void> {
  await docClient.send(new DeleteCommand({
    TableName: CONNECTIONS_TABLE,
    Key: { connectionId },
  }));
}

export async function getConnection(connectionId: string): Promise<ConnectionRecord | undefined> {
  const result = await docClient.send(new GetCommand({
    TableName: CONNECTIONS_TABLE,
    Key: { connectionId },
  }));
  return result.Item as ConnectionRecord | undefined;
}

export async function getConnectionsByUserId(userId: string): Promise<ConnectionRecord[]> {
  const result = await docClient.send(new QueryCommand({
    TableName: CONNECTIONS_TABLE,
    IndexName: 'userId-index',
    KeyConditionExpression: 'userId = :uid',
    ExpressionAttributeValues: { ':uid': userId },
  }));
  return (result.Items || []) as ConnectionRecord[];
}

export async function updateConnectionLocation(
  connectionId: string,
  latitude: number,
  longitude: number,
  timestamp: string,
  expiresAt: number
): Promise<void> {
  await docClient.send(new UpdateCommand({
    TableName: CONNECTIONS_TABLE,
    Key: { connectionId },
    UpdateExpression: 'SET latitude = :lat, longitude = :lng, #ts = :ts, expiresAt = :exp',
    ExpressionAttributeNames: { '#ts': 'timestamp' },
    ExpressionAttributeValues: {
      ':lat': latitude,
      ':lng': longitude,
      ':ts': timestamp,
      ':exp': expiresAt,
    },
  }));
}

// --- Friendships ---
//
// One item per direction: (userId, friendId) means "friendId is a friend of userId". A friendship
// is therefore two items, one for each user, and is always created and removed together in a
// transaction. Friends live in their own table so a profile read never drags a friend list along.

export async function getFriends(userId: string): Promise<{ userId: string; friendId: string; createdAt: string }[]> {
  const friends: { userId: string; friendId: string; createdAt: string }[] = [];
  let startKey: Record<string, unknown> | undefined;

  do {
    const result = await docClient.send(new QueryCommand({
      TableName: FRIENDSHIPS_TABLE,
      KeyConditionExpression: 'userId = :uid',
      ExpressionAttributeValues: { ':uid': userId },
      ...(startKey ? { ExclusiveStartKey: startKey } : {}),
    }));
    for (const item of result.Items || []) {
      friends.push({ userId: item.userId, friendId: item.friendId, createdAt: item.createdAt });
    }
    startKey = result.LastEvaluatedKey;
  } while (startKey);

  return friends;
}

export async function getFriendCount(userId: string): Promise<number> {
  let count = 0;
  let startKey: Record<string, unknown> | undefined;

  do {
    const result = await docClient.send(new QueryCommand({
      TableName: FRIENDSHIPS_TABLE,
      KeyConditionExpression: 'userId = :uid',
      ExpressionAttributeValues: { ':uid': userId },
      Select: 'COUNT',
      ...(startKey ? { ExclusiveStartKey: startKey } : {}),
    }));
    count += result.Count || 0;
    startKey = result.LastEvaluatedKey;
  } while (startKey);

  return count;
}

export async function areFriends(userId: string, friendId: string): Promise<boolean> {
  const result = await docClient.send(new GetCommand({
    TableName: FRIENDSHIPS_TABLE,
    Key: { userId, friendId },
  }));
  return result.Item !== undefined;
}

export type CreateFriendshipResult = 'created' | 'request_not_found';

/**
 * Makes two users friends and consumes the friend request, all or nothing. Repeating it is
 * harmless: an existing friendship keeps its original date. Returns 'request_not_found' when the
 * request was already accepted or declined, in which case nothing is written.
 */
export async function createFriendship(
  userId: string,
  friendId: string,
  requestId: string
): Promise<CreateFriendshipResult> {
  const now = new Date().toISOString();
  const stamp = (from: string, to: string) => ({
    Update: {
      TableName: FRIENDSHIPS_TABLE,
      Key: { userId: from, friendId: to },
      UpdateExpression: 'SET createdAt = if_not_exists(createdAt, :now)',
      ExpressionAttributeValues: { ':now': now },
    },
  });

  try {
    await transact([
      stamp(userId, friendId),
      stamp(friendId, userId),
      {
        Delete: {
          TableName: FRIEND_REQUESTS_TABLE,
          Key: { requestId },
          ConditionExpression: 'attribute_exists(requestId)',
        },
      },
    ]);
    return 'created';
  } catch (err) {
    // The request is the third item; its condition fails when it no longer exists.
    if (cancellationCodes(err)[2] === 'ConditionalCheckFailed') return 'request_not_found';
    throw err;
  }
}

/** Removes the friendship in both directions, all or nothing. Removing a non-friend is harmless. */
export async function removeFriendship(userId: string, friendId: string): Promise<void> {
  await transact([
    { Delete: { TableName: FRIENDSHIPS_TABLE, Key: { userId, friendId } } },
    { Delete: { TableName: FRIENDSHIPS_TABLE, Key: { userId: friendId, friendId: userId } } },
  ]);
}

const MAX_TRANSACTION_ATTEMPTS = 3;

async function transact(items: TransactWriteCommandInput['TransactItems']): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await docClient.send(new TransactWriteCommand({ TransactItems: items }));
      return;
    } catch (err) {
      // Another transaction touching the same items is transient: wait a moment and try again.
      const conflict = cancellationCodes(err).includes('TransactionConflict');
      if (!conflict || attempt >= MAX_TRANSACTION_ATTEMPTS) throw err;
      await new Promise((resolve) => setTimeout(resolve, 25 * attempt + Math.random() * 25));
    }
  }
}

/** The per-item outcome of a cancelled transaction, in the order the items were sent. */
function cancellationCodes(err: unknown): (string | undefined)[] {
  const failure = err as { name?: string; CancellationReasons?: { Code?: string }[] } | undefined;
  return failure?.name === 'TransactionCanceledException'
    ? (failure.CancellationReasons || []).map((reason) => reason?.Code)
    : [];
}

// --- Users Table ---

export async function getUser(userId: string): Promise<UserProfile | undefined> {
  const result = await docClient.send(new GetCommand({
    TableName: USERS_TABLE,
    Key: { userId },
  }));
  return result.Item as UserProfile | undefined;
}

export async function putUser(profile: UserProfile): Promise<void> {
  await docClient.send(new PutCommand({
    TableName: USERS_TABLE,
    Item: profile,
  }));
}

export async function updateUser(userId: string, updates: Partial<Pick<UserProfile, 'displayName' | 'profilePictureKey' | 'discoverable'>>): Promise<void> {
  const expressionParts: string[] = [];
  const expressionValues: Record<string, unknown> = {};
  const expressionNames: Record<string, string> = {};

  if (updates.displayName !== undefined) {
    expressionParts.push('#dn = :dn');
    expressionNames['#dn'] = 'displayName';
    expressionValues[':dn'] = updates.displayName;
  }
  if (updates.profilePictureKey !== undefined) {
    expressionParts.push('#ppk = :ppk');
    expressionNames['#ppk'] = 'profilePictureKey';
    expressionValues[':ppk'] = updates.profilePictureKey;
  }
  if (updates.discoverable !== undefined) {
    expressionParts.push('#disc = :disc');
    expressionNames['#disc'] = 'discoverable';
    expressionValues[':disc'] = updates.discoverable;
  }

  if (expressionParts.length === 0) return;

  await docClient.send(new UpdateCommand({
    TableName: USERS_TABLE,
    Key: { userId },
    UpdateExpression: `SET ${expressionParts.join(', ')}`,
    ExpressionAttributeNames: expressionNames,
    ExpressionAttributeValues: expressionValues,
  }));
}

// --- Friend Requests Table ---

export async function putFriendRequest(request: FriendRequest): Promise<void> {
  await docClient.send(new PutCommand({
    TableName: FRIEND_REQUESTS_TABLE,
    Item: request,
  }));
}

export async function getFriendRequest(requestId: string): Promise<FriendRequest | undefined> {
  const result = await docClient.send(new GetCommand({
    TableName: FRIEND_REQUESTS_TABLE,
    Key: { requestId },
  }));
  return result.Item as FriendRequest | undefined;
}

export async function getFriendRequestsByToUser(toUserId: string): Promise<FriendRequest[]> {
  const result = await docClient.send(new QueryCommand({
    TableName: FRIEND_REQUESTS_TABLE,
    IndexName: 'toUserId-index',
    KeyConditionExpression: 'toUserId = :tuid',
    ExpressionAttributeValues: { ':tuid': toUserId },
  }));
  return (result.Items || []) as FriendRequest[];
}

export async function deleteFriendRequest(requestId: string): Promise<void> {
  await docClient.send(new DeleteCommand({
    TableName: FRIEND_REQUESTS_TABLE,
    Key: { requestId },
  }));
}

// --- Active Connections (for nearby strangers) ---

export async function getActiveConnections(): Promise<ConnectionRecord[]> {
  const now = Math.floor(Date.now() / 1000);
  const result = await docClient.send(new ScanCommand({
    TableName: CONNECTIONS_TABLE,
    FilterExpression: 'expiresAt > :now AND attribute_exists(latitude) AND attribute_exists(longitude)',
    ExpressionAttributeValues: { ':now': now },
  }));
  return (result.Items || []) as ConnectionRecord[];
}

export async function batchGetConnections(connectionIds: string[]): Promise<ConnectionRecord[]> {
  if (connectionIds.length === 0) return [];

  const keys = connectionIds.map(id => ({ connectionId: id }));
  const result = await docClient.send(new BatchGetCommand({
    RequestItems: {
      [CONNECTIONS_TABLE]: { Keys: keys },
    },
  }));
  return (result.Responses?.[CONNECTIONS_TABLE] || []) as ConnectionRecord[];
}
