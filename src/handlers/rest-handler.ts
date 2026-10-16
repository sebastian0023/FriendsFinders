import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { v4 as uuidv4 } from 'uuid';
import {
  getFriends,
  putFriendship,
  deleteFriendship,
  getFriendCount,
  getUser,
  putUser,
  updateUser,
  putFriendRequest,
  getFriendRequest,
  getFriendRequestsByToUser,
  deleteFriendRequest,
  getActiveConnections,
  getConnectionsByUserId,
} from '../utils/dynamo-client';
import { getConfig } from '../utils/config';
import { haversine } from '../utils/distance';
import { generateUploadUrl, generateDownloadUrl } from '../utils/s3-client';
import { validateProfileUpdate } from '../utils/profile-validation';
import { UserProfile, FriendRequest, NearbyStrangerEntry, NearbyFriendHttpEntry, ConnectionRecord } from '../types';

export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  const method = event.requestContext.http.method;
  const path = event.rawPath;

  try {
    // Route matching
    // GET /friends   (must be checked BEFORE /friends/{friendId})
    if (method === 'GET' && path === '/friends') {
      return await handleGetFriends(event);
    }

    // DELETE /friends/{friendId}
    if (method === 'DELETE' && path.match(/^\/friends\/[^/]+$/)) {
      return await handleRemoveFriend(event);
    }

    // POST /friend-requests/{toUserId}
    if (method === 'POST' && path.match(/^\/friend-requests\/[^/]+$/)) {
      return await handleCreateFriendRequest(event);
    }

    // GET /friend-requests
    if (method === 'GET' && path === '/friend-requests') {
      return await handleGetFriendRequests(event);
    }

    // PUT /friend-requests/{requestId}/accept
    if (method === 'PUT' && path.match(/^\/friend-requests\/[^/]+\/accept$/)) {
      return await handleAcceptFriendRequest(event);
    }

    // PUT /friend-requests/{requestId}/decline
    if (method === 'PUT' && path.match(/^\/friend-requests\/[^/]+\/decline$/)) {
      return await handleDeclineFriendRequest(event);
    }

    // GET /users/{userId}/profile-picture-upload-url
    if (method === 'GET' && path.match(/^\/users\/[^/]+\/profile-picture-upload-url$/)) {
      return await handleGetUploadUrl(event);
    }

    // GET /users/{userId}/profile
    if (method === 'GET' && path.match(/^\/users\/[^/]+\/profile$/)) {
      return await handleGetProfile(event);
    }

    // PUT /users/{userId}/profile
    if (method === 'PUT' && path.match(/^\/users\/[^/]+\/profile$/)) {
      return await handleUpdateProfile(event);
    }

    // GET /nearby-friends (must be before nearby-strangers; neither uses path params)
    if (method === 'GET' && path === '/nearby-friends') {
      return await handleNearbyFriends(event);
    }

    // GET /nearby-strangers
    if (method === 'GET' && path === '/nearby-strangers') {
      return await handleNearbyStrangers(event);
    }

    return response(404, { error: 'Not found' });
  } catch (err) {
    console.error('Unhandled error:', err);
    return response(500, { error: 'Internal server error' });
  }
}

function getAuthUserId(event: APIGatewayProxyEventV2): string | null {
  // API Gateway JWT authorizer injects verified Cognito claims
  const claims = (event.requestContext as any)?.authorizer?.jwt?.claims;
  return claims?.sub || null;
}

function extractPathParam(path: string, pattern: RegExp): string | null {
  const match = path.match(pattern);
  return match ? match[1] : null;
}

function response(statusCode: number, body: unknown): APIGatewayProxyResultV2 {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}

// --- GET /friends ---
async function handleGetFriends(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  const userId = getAuthUserId(event);
  if (!userId) return response(401, { error: 'Unauthorized' });

  const friendships = await getFriends(userId);

  const result: {
    friendId: string;
    displayName: string;
    profilePictureUrl?: string;
    friendsSince: string;
  }[] = [];

  for (const f of friendships) {
    const user = await getUser(f.friendId);
    if (!user) continue;

    let profilePictureUrl: string | undefined;
    if (user.profilePictureKey) {
      profilePictureUrl = await generateDownloadUrl(user.profilePictureKey);
    }

    result.push({
      friendId: user.userId,
      displayName: user.displayName,
      profilePictureUrl,
      friendsSince: f.createdAt,
    });
  }

  return response(200, result);
}

// --- DELETE /friends/{friendId} ---
async function handleRemoveFriend(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  const userId = getAuthUserId(event);
  if (!userId) return response(401, { error: 'Unauthorized' });

  const friendId = extractPathParam(event.rawPath, /^\/friends\/([^/]+)$/);
  if (!friendId) return response(400, { error: 'Missing friendId' });

  await deleteFriendship(userId, friendId);
  await deleteFriendship(friendId, userId);

  return response(200, { message: 'Friend removed' });
}

// --- POST /friend-requests/{toUserId} ---
async function handleCreateFriendRequest(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  const fromUserId = getAuthUserId(event);
  if (!fromUserId) return response(401, { error: 'Unauthorized' });

  const toUserId = extractPathParam(event.rawPath, /^\/friend-requests\/([^/]+)$/);
  if (!toUserId) return response(400, { error: 'Missing toUserId' });

  if (fromUserId === toUserId) {
    return response(400, { error: 'Cannot send friend request to yourself' });
  }

  // Check if already friends
  const friends = await getFriends(fromUserId);
  const alreadyFriends = friends.some(f => f.friendId === toUserId);
  if (alreadyFriends) {
    return response(409, { error: 'Already friends' });
  }

  // Check for existing pending request
  const existingRequests = await getFriendRequestsByToUser(toUserId);
  const hasPending = existingRequests.some(
    r => r.fromUserId === fromUserId && r.status === 'pending'
  );
  if (hasPending) {
    return response(409, { error: 'Friend request already pending' });
  }

  const request: FriendRequest = {
    requestId: uuidv4(),
    fromUserId,
    toUserId,
    status: 'pending',
    createdAt: new Date().toISOString(),
  };

  await putFriendRequest(request);
  return response(201, request);
}

// --- GET /friend-requests ---
async function handleGetFriendRequests(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  const userId = getAuthUserId(event);
  if (!userId) return response(401, { error: 'Unauthorized' });

  const requests = await getFriendRequestsByToUser(userId);
  const pending = requests.filter(r => r.status === 'pending');

  const enriched = await Promise.all(
    pending.map(async r => {
      const fromProfile = await getUser(r.fromUserId);
      return {
        ...r,
        fromDisplayName: fromProfile?.displayName || 'User',
      };
    }),
  );

  return response(200, enriched);
}

// --- PUT /friend-requests/{requestId}/accept ---
async function handleAcceptFriendRequest(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  const userId = getAuthUserId(event);
  if (!userId) return response(401, { error: 'Unauthorized' });

  const requestId = extractPathParam(event.rawPath, /^\/friend-requests\/([^/]+)\/accept$/);
  if (!requestId) return response(400, { error: 'Missing requestId' });

  const request = await getFriendRequest(requestId);
  if (!request) return response(404, { error: 'Friend request not found' });
  if (request.toUserId !== userId) return response(403, { error: 'Forbidden' });
  if (request.status !== 'pending') return response(409, { error: 'Request is not pending' });

  // Check friend count limits
  const config = await getConfig();
  const [userCount, fromUserCount] = await Promise.all([
    getFriendCount(userId),
    getFriendCount(request.fromUserId),
  ]);

  if (userCount >= config.maxFriends || fromUserCount >= config.maxFriends) {
    return response(409, { error: 'Friend limit reached' });
  }

  // Create bidirectional friendship
  await putFriendship(userId, request.fromUserId);
  await putFriendship(request.fromUserId, userId);

  // Delete the request
  await deleteFriendRequest(requestId);

  return response(200, { message: 'Friend request accepted' });
}

// --- PUT /friend-requests/{requestId}/decline ---
async function handleDeclineFriendRequest(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  const userId = getAuthUserId(event);
  if (!userId) return response(401, { error: 'Unauthorized' });

  const requestId = extractPathParam(event.rawPath, /^\/friend-requests\/([^/]+)\/decline$/);
  if (!requestId) return response(400, { error: 'Missing requestId' });

  const request = await getFriendRequest(requestId);
  if (!request) return response(404, { error: 'Friend request not found' });
  if (request.toUserId !== userId) return response(403, { error: 'Forbidden' });
  if (request.status !== 'pending') return response(409, { error: 'Request is not pending' });

  await deleteFriendRequest(requestId);

  return response(200, { message: 'Friend request declined' });
}

// --- GET /users/{userId}/profile ---
async function handleGetProfile(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  const targetUserId = extractPathParam(event.rawPath, /^\/users\/([^/]+)\/profile$/);
  if (!targetUserId) return response(400, { error: 'Missing userId' });

  const user = await getUser(targetUserId);
  if (!user) return response(404, { error: 'User not found' });

  let profilePictureUrl: string | undefined;
  if (user.profilePictureKey) {
    profilePictureUrl = await generateDownloadUrl(user.profilePictureKey);
  }

  return response(200, {
    userId: user.userId,
    displayName: user.displayName,
    profilePictureUrl,
    discoverable: user.discoverable,
    createdAt: user.createdAt,
  });
}

// --- PUT /users/{userId}/profile ---
async function handleUpdateProfile(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  const userId = getAuthUserId(event);
  if (!userId) return response(401, { error: 'Unauthorized' });

  const targetUserId = extractPathParam(event.rawPath, /^\/users\/([^/]+)\/profile$/);
  if (!targetUserId || targetUserId !== userId) {
    return response(403, { error: 'Forbidden' });
  }

  let body: unknown = {};
  if (event.body) {
    try {
      body = JSON.parse(event.body);
    } catch {
      return response(400, { error: 'Invalid JSON' });
    }
  }

  const validation = validateProfileUpdate(body, userId);
  if (!validation.valid) return response(400, { error: validation.error });
  const fields = validation.fields;

  // Check if user exists; if not, create
  const existingUser = await getUser(userId);
  if (!existingUser) {
    const newProfile: UserProfile = {
      userId,
      displayName: fields.displayName ?? 'User',
      profilePictureKey: fields.profilePictureKey,
      discoverable: fields.discoverable ?? false,
      createdAt: new Date().toISOString(),
    };
    await putUser(newProfile);
    return response(200, { message: 'Profile created' });
  }

  await updateUser(userId, fields);
  return response(200, { message: 'Profile updated' });
}

// --- GET /users/{userId}/profile-picture-upload-url ---
async function handleGetUploadUrl(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  const userId = getAuthUserId(event);
  if (!userId) return response(401, { error: 'Unauthorized' });

  const targetUserId = extractPathParam(event.rawPath, /^\/users\/([^/]+)\/profile-picture-upload-url$/);
  if (!targetUserId || targetUserId !== userId) {
    return response(403, { error: 'Forbidden' });
  }

  const { uploadUrl, s3Key } = await generateUploadUrl(userId);
  return response(200, { uploadUrl, s3Key });
}

// --- GET /nearby-friends ---
async function handleNearbyFriends(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  const userId = getAuthUserId(event);
  if (!userId) return response(401, { error: 'Unauthorized' });

  const userConnections = await getConnectionsByUserId(userId);
  const now = Math.floor(Date.now() / 1000);
  const activeUserConn = userConnections.find(
    c => c.latitude !== undefined && c.longitude !== undefined && c.expiresAt > now
  );

  if (!activeUserConn || activeUserConn.latitude === undefined || activeUserConn.longitude === undefined) {
    return response(400, { error: 'Your location is not available. Send a location update first.' });
  }

  const config = await getConfig();
  const userLat = activeUserConn.latitude;
  const userLng = activeUserConn.longitude;

  const friendships = await getFriends(userId);
  const results: NearbyFriendHttpEntry[] = [];

  for (const f of friendships) {
    const friendConnections = await getConnectionsByUserId(f.friendId);
    let best: ConnectionRecord | undefined;
    for (const conn of friendConnections) {
      if (conn.expiresAt <= now) continue;
      if (conn.latitude === undefined || conn.longitude === undefined || !conn.timestamp) continue;
      if (!best || (conn.timestamp > best.timestamp!)) best = conn;
    }
    if (!best || best.latitude === undefined || best.longitude === undefined || !best.timestamp) continue;

    const distance = haversine(userLat, userLng, best.latitude, best.longitude);
    if (distance > config.searchRadiusMiles) continue;

    const profile = await getUser(f.friendId);
    if (!profile) continue;

    let profilePictureUrl: string | undefined;
    if (profile.profilePictureKey) {
      profilePictureUrl = await generateDownloadUrl(profile.profilePictureKey);
    }

    results.push({
      friendId: f.friendId,
      displayName: profile.displayName,
      profilePictureUrl,
      latitude: best.latitude,
      longitude: best.longitude,
      lastUpdated: best.timestamp,
      distanceMiles: Math.round(distance * 100) / 100,
    });
  }

  results.sort((a, b) => a.distanceMiles - b.distanceMiles);
  return response(200, results);
}

// --- GET /nearby-strangers ---
async function handleNearbyStrangers(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  const userId = getAuthUserId(event);
  if (!userId) return response(401, { error: 'Unauthorized' });

  // Get user's own connection to find their location
  const userConnections = await getConnectionsByUserId(userId);
  const activeUserConn = userConnections.find(
    c => c.latitude !== undefined && c.longitude !== undefined && c.expiresAt > Math.floor(Date.now() / 1000)
  );

  if (!activeUserConn || activeUserConn.latitude === undefined || activeUserConn.longitude === undefined) {
    return response(400, { error: 'Your location is not available. Send a location update first.' });
  }

  const config = await getConfig();
  const userLat = activeUserConn.latitude;
  const userLng = activeUserConn.longitude;

  // Get all active connections
  const allConnections = await getActiveConnections();

  // Get user's friends to exclude them
  const friends = await getFriends(userId);
  const friendIds = new Set(friends.map(f => f.friendId));

  // Exclude self and friends. A user may have several live connections (phone, laptop), so
  // keep only the nearest one per user: each stranger is listed once, at their closest distance.
  const nearestByUser = new Map<string, number>();
  for (const conn of allConnections) {
    if (conn.userId === userId) continue;
    if (friendIds.has(conn.userId)) continue;
    if (conn.latitude === undefined || conn.longitude === undefined) continue;

    const distance = haversine(userLat, userLng, conn.latitude, conn.longitude);
    const current = nearestByUser.get(conn.userId);
    if (current === undefined || distance < current) {
      nearestByUser.set(conn.userId, distance);
    }
  }

  // Keep those within the search radius
  const candidates: { userId: string; distanceMiles: number }[] = [];
  for (const [strangerId, distance] of nearestByUser) {
    if (distance <= config.searchRadiusMiles) {
      candidates.push({ userId: strangerId, distanceMiles: distance });
    }
  }

  // Filter discoverable users
  const nearbyStrangers: NearbyStrangerEntry[] = [];
  for (const candidate of candidates) {
    const user = await getUser(candidate.userId);
    if (!user || !user.discoverable) continue;

    let profilePictureUrl = '';
    if (user.profilePictureKey) {
      profilePictureUrl = await generateDownloadUrl(user.profilePictureKey);
    }

    nearbyStrangers.push({
      userId: user.userId,
      displayName: user.displayName,
      profilePictureUrl,
      distanceMiles: Math.round(candidate.distanceMiles * 100) / 100,
    });
  }

  // Sort by distance ascending and cap
  nearbyStrangers.sort((a, b) => a.distanceMiles - b.distanceMiles);
  const capped = nearbyStrangers.slice(0, config.nearbyStrangersLimit);

  return response(200, capped);
}
