import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import * as jwt from 'jsonwebtoken';
import * as jwksClient from 'jwks-rsa';
import {
  putConnection,
  deleteConnection,
  getConnection,
  getConnectionsByUserId,
  getFriends,
  updateConnectionLocation,
} from '../utils/dynamo-client';
import { postToConnection } from '../utils/apigw-client';
import { getConfig } from '../utils/config';
import { haversine } from '../utils/distance';
import { validateLocationUpdate } from '../utils/validation';
import { buildInitResponse } from '../utils/message-utils';
import { ConnectionRecord, NearbyFriendEntry } from '../types';

function pickLatestLocatedConnection(
  connections: ConnectionRecord[],
  currentTimeSeconds: number
): ConnectionRecord | undefined {
  let best: ConnectionRecord | undefined;
  for (const conn of connections) {
    if (conn.expiresAt <= currentTimeSeconds) continue;
    if (conn.latitude === undefined || conn.longitude === undefined || !conn.timestamp) continue;
    if (!best || conn.timestamp > best.timestamp!) best = conn;
  }
  return best;
}

async function buildNearbyFriendSnapshots(
  userId: string,
  friendships: Awaited<ReturnType<typeof getFriends>>,
  config: Awaited<ReturnType<typeof getConfig>>,
  currentTimeSeconds: number
): Promise<NearbyFriendEntry[]> {
  const subscriberConnections = await getConnectionsByUserId(userId);
  const subscriberBest = pickLatestLocatedConnection(subscriberConnections, currentTimeSeconds);
  const subLat = subscriberBest?.latitude;
  const subLng = subscriberBest?.longitude;

  const nearbyFriends: NearbyFriendEntry[] = [];

  for (const friend of friendships) {
    const friendConnections = await getConnectionsByUserId(friend.friendId);
    for (const conn of friendConnections) {
      if (
        conn.latitude !== undefined &&
        conn.longitude !== undefined &&
        conn.expiresAt > currentTimeSeconds &&
        conn.timestamp
      ) {
        let distanceMiles = 0;
        if (subLat !== undefined && subLng !== undefined) {
          distanceMiles = haversine(subLat, subLng, conn.latitude, conn.longitude);
          if (distanceMiles > config.searchRadiusMiles) break;
          distanceMiles = Math.round(distanceMiles * 100) / 100;
        }
        nearbyFriends.push({
          friendId: friend.friendId,
          latitude: conn.latitude,
          longitude: conn.longitude,
          lastUpdated: conn.timestamp,
          distanceMiles,
        });
        break;
      }
    }
  }

  return nearbyFriends;
}

export async function handler(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const routeKey = (event.requestContext as unknown as { routeKey: string }).routeKey;
  const connectionId = event.requestContext.connectionId!;

  switch (routeKey) {
    case '$connect':
      return handleConnect(event, connectionId);
    case '$disconnect':
      return handleDisconnect(connectionId);
    case 'location.update':
      return handleLocationUpdate(event, connectionId);
    case 'friends.refresh':
      return handleFriendsRefresh(connectionId);
    default:
      return { statusCode: 400, body: JSON.stringify({ error: 'Unknown route' }) };
  }
}

async function handleConnect(event: APIGatewayProxyEvent, connectionId: string): Promise<APIGatewayProxyResult> {
  const token = event.queryStringParameters?.token;
  if (!token) {
    return { statusCode: 401, body: 'Unauthorized' };
  }
  const userId = await verifyToken(token);
  if (!userId) {
    return { statusCode: 401, body: 'Unauthorized' };
  }
  const config = await getConfig();
  const now = new Date();
  const expiresAt = Math.floor(now.getTime() / 1000) + config.inactivityTtlSeconds;

  // Store connection record
  await putConnection({
    connectionId,
    userId,
    connectedAt: now.toISOString(),
    expiresAt,
  });

  const friends = await getFriends(userId);
  const currentTime = Math.floor(Date.now() / 1000);
  const nearbyFriends = await buildNearbyFriendSnapshots(userId, friends, config, currentTime);

  // Send init.response to the connecting client
  const initResponse = buildInitResponse(nearbyFriends);
  try {
    await postToConnection(connectionId, initResponse);
  } catch (err) {
    console.error('Failed to send init.response:', err);
  }

  return { statusCode: 200, body: 'Connected' };
}

async function handleDisconnect(connectionId: string): Promise<APIGatewayProxyResult> {
  try {
    await deleteConnection(connectionId);
  } catch (err) {
    console.error('Error deleting connection:', err);
  }
  return { statusCode: 200, body: 'Disconnected' };
}

async function handleFriendsRefresh(connectionId: string): Promise<APIGatewayProxyResult> {
  const connection = await getConnection(connectionId);
  if (!connection) return { statusCode: 200, body: 'Connection not found' };

  const config = await getConfig();
  const friends = await getFriends(connection.userId);
  const currentTime = Math.floor(Date.now() / 1000);
  const nearbyFriends = await buildNearbyFriendSnapshots(connection.userId, friends, config, currentTime);

  try {
    await postToConnection(connectionId, buildInitResponse(nearbyFriends));
  } catch (err) {
    console.error('Failed to send friends.refresh response:', err);
  }
  return { statusCode: 200, body: 'OK' };
}

/** Tells the client why its location update was rejected; always acknowledges with 200. */
async function rejectLocationUpdate(connectionId: string, message: string | undefined): Promise<APIGatewayProxyResult> {
  try {
    await postToConnection(connectionId, { type: 'error', message });
  } catch (err) {
    console.error('Failed to send error message:', err);
  }
  return { statusCode: 200, body: 'Invalid' };
}

async function handleLocationUpdate(event: APIGatewayProxyEvent, connectionId: string): Promise<APIGatewayProxyResult> {
  let body: any = null;
  if (event.body) {
    try {
      body = JSON.parse(event.body);
    } catch {
      return rejectLocationUpdate(connectionId, 'Invalid JSON');
    }
  }

  const validation = validateLocationUpdate(body);
  if (!validation.valid) {
    return rejectLocationUpdate(connectionId, validation.error);
  }

  // Look up connection to get userId
  const connection = await getConnection(connectionId);
  if (!connection) {
    return { statusCode: 200, body: 'Connection not found' };
  }

  const config = await getConfig();
  const expiresAt = Math.floor(Date.now() / 1000) + config.inactivityTtlSeconds;

  // Update connection with new location and refresh TTL
  await updateConnectionLocation(
    connectionId,
    body.latitude,
    body.longitude,
    body.timestamp,
    expiresAt
  );

  return { statusCode: 200, body: 'OK' };
}

const jwks = jwksClient.default({
  jwksUri: `https://cognito-idp.${process.env.AWS_REGION}.amazonaws.com/${process.env.COGNITO_USER_POOL_ID}/.well-known/jwks.json`,
  cache: true,
  rateLimit: true,
});

async function verifyToken(token: string): Promise<string | null> {
  try {
    const decoded = jwt.decode(token, { complete: true });
    if (!decoded || typeof decoded === 'string') return null;

    const key = await jwks.getSigningKey(decoded.header.kid);
    const verified = jwt.verify(token, key.getPublicKey(), { algorithms: ['RS256'] }) as jwt.JwtPayload;
    return verified.sub || null;
  } catch {
    return null;
  }
}