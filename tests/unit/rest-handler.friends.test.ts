import { v4 as uuidv4 } from 'uuid';
import { restEvent, resultStatus, resultJson, resultHeaders } from '../helpers/rest-events';

// The handler only talks to AWS through these wrapper modules, so we replace them.
// Factories keep the real modules (and their AWS SDK clients) from loading at all.
jest.mock('../../src/utils/dynamo-client', () => ({
  getFriends: jest.fn(),
  putFriendship: jest.fn(),
  deleteFriendship: jest.fn(),
  getFriendCount: jest.fn(),
  getUser: jest.fn(),
  putUser: jest.fn(),
  updateUser: jest.fn(),
  putFriendRequest: jest.fn(),
  getFriendRequest: jest.fn(),
  getFriendRequestsByToUser: jest.fn(),
  deleteFriendRequest: jest.fn(),
  getActiveConnections: jest.fn(),
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
import { FriendRequest, UserProfile } from '../../src/types';

const mockGetFriends = dynamo.getFriends as jest.MockedFunction<typeof dynamo.getFriends>;
const mockPutFriendship = dynamo.putFriendship as jest.MockedFunction<typeof dynamo.putFriendship>;
const mockDeleteFriendship = dynamo.deleteFriendship as jest.MockedFunction<typeof dynamo.deleteFriendship>;
const mockGetFriendCount = dynamo.getFriendCount as jest.MockedFunction<typeof dynamo.getFriendCount>;
const mockGetUser = dynamo.getUser as jest.MockedFunction<typeof dynamo.getUser>;
const mockPutFriendRequest = dynamo.putFriendRequest as jest.MockedFunction<typeof dynamo.putFriendRequest>;
const mockGetFriendRequest = dynamo.getFriendRequest as jest.MockedFunction<typeof dynamo.getFriendRequest>;
const mockGetRequestsByToUser = dynamo.getFriendRequestsByToUser as jest.MockedFunction<
  typeof dynamo.getFriendRequestsByToUser
>;
const mockDeleteFriendRequest = dynamo.deleteFriendRequest as jest.MockedFunction<typeof dynamo.deleteFriendRequest>;
const mockGetConfig = getConfig as jest.MockedFunction<typeof getConfig>;
const mockDownloadUrl = generateDownloadUrl as jest.MockedFunction<typeof generateDownloadUrl>;
const mockUuid = uuidv4 as unknown as jest.Mock;

const CONFIG = {
  searchRadiusMiles: 5,
  inactivityTtlSeconds: 600,
  locationUpdateIntervalSeconds: 30,
  maxFriends: 5000,
  nearbyStrangersLimit: 50,
};

// ── Fixtures ──────────────────────────────────────────────────────────────────

function user(overrides: Partial<UserProfile> = {}): UserProfile {
  return {
    userId: 'user-2',
    displayName: 'Friend Two',
    discoverable: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function friendRequest(overrides: Partial<FriendRequest> = {}): FriendRequest {
  return {
    requestId: 'req-1',
    fromUserId: 'user-2',
    toUserId: 'user-1',
    status: 'pending',
    createdAt: '2026-10-01T00:00:00.000Z',
    ...overrides,
  };
}

const friendship = (friendId: string, createdAt = '2026-02-02T00:00:00.000Z') => ({
  userId: 'user-1',
  friendId,
  createdAt,
});

/** Makes getUser resolve profiles from a map keyed by userId. */
function givenUsers(users: Record<string, UserProfile>): void {
  mockGetUser.mockImplementation(async (id: string) => users[id]);
}

const everyDataCall = () => [
  mockGetFriends,
  mockPutFriendship,
  mockDeleteFriendship,
  mockGetFriendCount,
  mockGetUser,
  mockPutFriendRequest,
  mockGetFriendRequest,
  mockGetRequestsByToUser,
  mockDeleteFriendRequest,
];

let errorSpy: jest.SpyInstance;

beforeEach(() => {
  // clearMocks resets call history but keeps implementations, so set safe defaults every time.
  mockGetConfig.mockResolvedValue(CONFIG);
  mockGetFriends.mockResolvedValue([]);
  mockGetFriendCount.mockResolvedValue(0);
  mockGetUser.mockResolvedValue(undefined);
  mockGetFriendRequest.mockResolvedValue(undefined);
  mockGetRequestsByToUser.mockResolvedValue([]);
  mockPutFriendship.mockResolvedValue(undefined);
  mockDeleteFriendship.mockResolvedValue(undefined);
  mockPutFriendRequest.mockResolvedValue(undefined);
  mockDeleteFriendRequest.mockResolvedValue(undefined);
  mockDownloadUrl.mockImplementation(async (key: string) => `https://signed.example/${key}`);
  mockUuid.mockReturnValue('request-uuid');
  errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  errorSpy.mockRestore();
});

// ── Authentication and routing ────────────────────────────────────────────────

describe('rest-handler: authentication', () => {
  it.each([
    ['GET', '/friends'],
    ['DELETE', '/friends/friend-1'],
    ['POST', '/friend-requests/user-2'],
    ['GET', '/friend-requests'],
    ['PUT', '/friend-requests/req-1/accept'],
    ['PUT', '/friend-requests/req-1/decline'],
  ])('%s %s returns 401 without authorizer claims and touches nothing', async (method, path) => {
    const result = await handler(restEvent(method, path, { sub: null }));

    expect(resultStatus(result)).toBe(401);
    expect(resultJson(result)).toEqual({ error: 'Unauthorized' });
    for (const call of everyDataCall()) expect(call).not.toHaveBeenCalled();
  });
});

describe('rest-handler: routing', () => {
  it('returns 404 for an unknown path', async () => {
    const result = await handler(restEvent('GET', '/nope'));
    expect(resultStatus(result)).toBe(404);
    expect(resultJson(result)).toEqual({ error: 'Not found' });
  });

  it.each([
    ['POST', '/friends'],
    ['DELETE', '/friends'], // removal needs a friend id in the path
    ['GET', '/friends/friend-1'],
    ['DELETE', '/friends/'],
    ['DELETE', '/friends/a/b'],
    ['GET', '/friend-requests/'],
    ['PUT', '/friend-requests/req-1'],
    ['PUT', '/friend-requests/req-1/other'],
    ['POST', '/friend-requests'],
  ])('%s %s is not routed (404)', async (method, path) => {
    const result = await handler(restEvent(method, path));
    expect(resultStatus(result)).toBe(404);
  });

  // Documents current behaviour: API Gateway defines POST /friends/{friendId} (see
  // terraform/modules/api-gateway), but the handler has no such route, so it always 404s.
  it('has no handler behind POST /friends/{friendId}', async () => {
    const result = await handler(restEvent('POST', '/friends/friend-1'));
    expect(resultStatus(result)).toBe(404);
    expect(mockPutFriendship).not.toHaveBeenCalled();
  });

  it('answers every response as JSON', async () => {
    const result = await handler(restEvent('GET', '/friends'));
    expect(resultHeaders(result)).toEqual({ 'Content-Type': 'application/json' });
  });

  // Routes must be awaited inside the try block; otherwise a rejected promise bypasses the
  // catch and API Gateway answers with its own non-JSON 500.
  it('turns an unexpected error into a generic JSON 500 and logs it', async () => {
    mockGetFriends.mockRejectedValue(new Error('DynamoDB exploded'));

    const result = await handler(restEvent('GET', '/friends'));

    expect(resultStatus(result)).toBe(500);
    expect(resultJson(result)).toEqual({ error: 'Internal server error' }); // no internals leaked
    expect(errorSpy).toHaveBeenCalledWith('Unhandled error:', expect.any(Error));
  });

  it.each([
    ['GET', '/friends'],
    ['DELETE', '/friends/friend-1'],
    ['POST', '/friend-requests/user-2'],
    ['GET', '/friend-requests'],
    ['PUT', '/friend-requests/req-1/accept'],
    ['PUT', '/friend-requests/req-1/decline'],
    ['GET', '/users/user-1/profile'],
    ['PUT', '/users/user-1/profile'],
    ['GET', '/users/user-1/profile-picture-upload-url'],
    ['GET', '/nearby-friends'],
    ['GET', '/nearby-strangers'],
  ])('%s %s also returns a JSON 500 when its data layer fails', async (method, path) => {
    const dataCalls = Object.values(dynamo).filter((fn) => jest.isMockFunction(fn)) as jest.Mock[];
    try {
      for (const call of dataCalls) call.mockRejectedValue(new Error('boom'));

      const result = await handler(restEvent(method, path, { body: {} }));

      expect(resultStatus(result)).toBe(500);
      expect(resultJson(result)).toEqual({ error: 'Internal server error' });
    } finally {
      // Back to a bare jest.fn() so rejecting mocks cannot leak into later tests.
      for (const call of dataCalls) call.mockReset();
    }
  });
});

// ── GET /friends ──────────────────────────────────────────────────────────────

describe('rest-handler: GET /friends', () => {
  it('returns an empty list when the caller has no friends', async () => {
    const result = await handler(restEvent('GET', '/friends'));
    expect(resultStatus(result)).toBe(200);
    expect(resultJson(result)).toEqual([]);
    expect(mockGetFriends).toHaveBeenCalledWith('user-1');
  });

  it('lists friends with their profile data and friendship date', async () => {
    mockGetFriends.mockResolvedValue([
      friendship('user-2', '2026-03-03T00:00:00.000Z'),
      friendship('user-3', '2026-04-04T00:00:00.000Z'),
    ]);
    givenUsers({
      'user-2': user({ userId: 'user-2', displayName: 'Ana', profilePictureKey: 'pics/ana.jpg' }),
      'user-3': user({ userId: 'user-3', displayName: 'Beto' }),
    });

    const result = await handler(restEvent('GET', '/friends'));

    expect(resultJson(result)).toEqual([
      {
        friendId: 'user-2',
        displayName: 'Ana',
        profilePictureUrl: 'https://signed.example/pics/ana.jpg',
        friendsSince: '2026-03-03T00:00:00.000Z',
      },
      { friendId: 'user-3', displayName: 'Beto', friendsSince: '2026-04-04T00:00:00.000Z' },
    ]);
    expect(mockDownloadUrl).toHaveBeenCalledTimes(1); // only for the friend that has a picture
  });

  it('skips a friend whose user record no longer exists', async () => {
    mockGetFriends.mockResolvedValue([friendship('ghost'), friendship('user-2')]);
    givenUsers({ 'user-2': user() });

    const result = await handler(restEvent('GET', '/friends'));

    expect(resultJson(result).map((f: { friendId: string }) => f.friendId)).toEqual(['user-2']);
  });
});

// ── DELETE /friends/{friendId} ────────────────────────────────────────────────

describe('rest-handler: DELETE /friends/{friendId}', () => {
  it('removes the friendship in both directions', async () => {
    const result = await handler(restEvent('DELETE', '/friends/friend-1'));

    expect(resultStatus(result)).toBe(200);
    expect(resultJson(result)).toEqual({ message: 'Friend removed' });
    expect(mockDeleteFriendship).toHaveBeenCalledTimes(2);
    expect(mockDeleteFriendship).toHaveBeenCalledWith('user-1', 'friend-1');
    expect(mockDeleteFriendship).toHaveBeenCalledWith('friend-1', 'user-1');
  });

  // Documents current behaviour: the handler never checks the friendship exists first,
  // so removing a non-friend is an idempotent success rather than a 404.
  it('succeeds even when the two users were not friends', async () => {
    mockGetFriends.mockResolvedValue([]);
    const result = await handler(restEvent('DELETE', '/friends/stranger'));
    expect(resultStatus(result)).toBe(200);
  });

  // Documents current behaviour: the two deletes are separate writes, so a failure on the
  // second leaves the friendship removed on one side only.
  it('returns 500 after the first delete when the second one fails, leaving a half-removed friendship', async () => {
    mockDeleteFriendship.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('throttled'));

    const result = await handler(restEvent('DELETE', '/friends/friend-1'));

    expect(resultStatus(result)).toBe(500);
    expect(mockDeleteFriendship).toHaveBeenCalledTimes(2);
  });
});

// ── POST /friend-requests/{toUserId} ──────────────────────────────────────────

describe('rest-handler: POST /friend-requests/{toUserId}', () => {
  const send = (toUserId = 'user-2') => handler(restEvent('POST', `/friend-requests/${toUserId}`));

  it('creates a pending request and returns it with 201', async () => {
    const result = await send();

    expect(resultStatus(result)).toBe(201);
    const created = resultJson(result);
    expect(created).toEqual({
      requestId: 'request-uuid',
      fromUserId: 'user-1',
      toUserId: 'user-2',
      status: 'pending',
      createdAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T.*Z$/),
    });
    expect(mockPutFriendRequest).toHaveBeenCalledWith(created);
  });

  it('rejects a request to yourself with 400 and stores nothing', async () => {
    const result = await send('user-1');

    expect(resultStatus(result)).toBe(400);
    expect(resultJson(result)).toEqual({ error: 'Cannot send friend request to yourself' });
    expect(mockPutFriendRequest).not.toHaveBeenCalled();
  });

  it('rejects a request to an existing friend with 409', async () => {
    mockGetFriends.mockResolvedValue([friendship('user-2')]);

    const result = await send();

    expect(resultStatus(result)).toBe(409);
    expect(resultJson(result)).toEqual({ error: 'Already friends' });
    expect(mockGetFriends).toHaveBeenCalledWith('user-1');
    expect(mockPutFriendRequest).not.toHaveBeenCalled();
  });

  it('rejects a duplicate pending request from the same sender with 409', async () => {
    mockGetRequestsByToUser.mockResolvedValue([friendRequest({ fromUserId: 'user-1', toUserId: 'user-2' })]);

    const result = await send();

    expect(resultStatus(result)).toBe(409);
    expect(resultJson(result)).toEqual({ error: 'Friend request already pending' });
    expect(mockGetRequestsByToUser).toHaveBeenCalledWith('user-2');
    expect(mockPutFriendRequest).not.toHaveBeenCalled();
  });

  it.each([
    ['a pending request from someone else', { fromUserId: 'user-9', status: 'pending' as const }],
    ['an earlier declined request from the same sender', { fromUserId: 'user-1', status: 'declined' as const }],
  ])('is not blocked by %s', async (_name, existing) => {
    mockGetRequestsByToUser.mockResolvedValue([friendRequest({ toUserId: 'user-2', ...existing })]);

    const result = await send();

    expect(resultStatus(result)).toBe(201);
  });

  // Documents current behaviour: neither the target's existence nor a request already
  // sent the other way is checked, so requests can cross and can target unknown ids.
  it('does not check that the target user exists', async () => {
    const result = await send('no-such-user');
    expect(resultStatus(result)).toBe(201);
    expect(mockGetUser).not.toHaveBeenCalled();
  });

  it('does not look for a request the target already sent to the caller', async () => {
    const result = await send();
    expect(resultStatus(result)).toBe(201);
    expect(mockGetRequestsByToUser).toHaveBeenCalledTimes(1);
    expect(mockGetRequestsByToUser).toHaveBeenCalledWith('user-2'); // never 'user-1'
  });
});

// ── GET /friend-requests ──────────────────────────────────────────────────────

describe('rest-handler: GET /friend-requests', () => {
  const list = () => handler(restEvent('GET', '/friend-requests'));

  it('returns an empty list when nothing is pending', async () => {
    const result = await list();
    expect(resultStatus(result)).toBe(200);
    expect(resultJson(result)).toEqual([]);
    expect(mockGetRequestsByToUser).toHaveBeenCalledWith('user-1');
  });

  it('returns only pending requests, each with the sender\'s display name', async () => {
    mockGetRequestsByToUser.mockResolvedValue([
      friendRequest({ requestId: 'r-pending', fromUserId: 'user-2' }),
      friendRequest({ requestId: 'r-declined', fromUserId: 'user-3', status: 'declined' }),
      friendRequest({ requestId: 'r-accepted', fromUserId: 'user-4', status: 'accepted' }),
    ]);
    givenUsers({ 'user-2': user({ userId: 'user-2', displayName: 'Ana' }) });

    const result = await list();

    expect(resultJson(result)).toEqual([
      { ...friendRequest({ requestId: 'r-pending', fromUserId: 'user-2' }), fromDisplayName: 'Ana' },
    ]);
  });

  it('falls back to "User" when the sender has no profile', async () => {
    mockGetRequestsByToUser.mockResolvedValue([friendRequest({ fromUserId: 'ghost' })]);

    const result = await list();

    expect(resultJson(result)[0].fromDisplayName).toBe('User');
  });
});

// ── PUT /friend-requests/{requestId}/accept ───────────────────────────────────

describe('rest-handler: PUT /friend-requests/{requestId}/accept', () => {
  const accept = (requestId = 'req-1') => handler(restEvent('PUT', `/friend-requests/${requestId}/accept`));

  beforeEach(() => {
    mockGetFriendRequest.mockResolvedValue(friendRequest());
  });

  it('creates the friendship in both directions, then deletes the request', async () => {
    const result = await accept();

    expect(resultStatus(result)).toBe(200);
    expect(resultJson(result)).toEqual({ message: 'Friend request accepted' });
    expect(mockPutFriendship).toHaveBeenCalledTimes(2);
    expect(mockPutFriendship).toHaveBeenCalledWith('user-1', 'user-2');
    expect(mockPutFriendship).toHaveBeenCalledWith('user-2', 'user-1');
    expect(mockDeleteFriendRequest).toHaveBeenCalledWith('req-1');

    const lastPut = Math.max(...mockPutFriendship.mock.invocationCallOrder);
    expect(mockDeleteFriendRequest.mock.invocationCallOrder[0]).toBeGreaterThan(lastPut);
  });

  it('looks the request up by the id in the path', async () => {
    await accept('req-77');
    expect(mockGetFriendRequest).toHaveBeenCalledWith('req-77');
  });

  it('returns 404 for an unknown request', async () => {
    mockGetFriendRequest.mockResolvedValue(undefined);

    const result = await accept();

    expect(resultStatus(result)).toBe(404);
    expect(resultJson(result)).toEqual({ error: 'Friend request not found' });
    expect(mockPutFriendship).not.toHaveBeenCalled();
  });

  it('returns 403 when the caller is not the recipient', async () => {
    mockGetFriendRequest.mockResolvedValue(friendRequest({ toUserId: 'someone-else' }));

    const result = await accept();

    expect(resultStatus(result)).toBe(403);
    expect(mockPutFriendship).not.toHaveBeenCalled();
    expect(mockDeleteFriendRequest).not.toHaveBeenCalled();
  });

  it('does not let the sender accept their own request', async () => {
    mockGetFriendRequest.mockResolvedValue(friendRequest({ fromUserId: 'user-1', toUserId: 'user-2' }));

    const result = await accept();

    expect(resultStatus(result)).toBe(403);
    expect(mockPutFriendship).not.toHaveBeenCalled();
  });

  it.each(['accepted', 'declined'] as const)('returns 409 for a request that is already %s', async (status) => {
    mockGetFriendRequest.mockResolvedValue(friendRequest({ status }));

    const result = await accept();

    expect(resultStatus(result)).toBe(409);
    expect(resultJson(result)).toEqual({ error: 'Request is not pending' });
    expect(mockPutFriendship).not.toHaveBeenCalled();
  });

  describe('friend limit', () => {
    beforeEach(() => {
      mockGetConfig.mockResolvedValue({ ...CONFIG, maxFriends: 2 });
    });

    const countsFor = (counts: Record<string, number>) =>
      mockGetFriendCount.mockImplementation(async (id: string) => counts[id] ?? 0);

    it.each([
      ['the caller', { 'user-1': 2, 'user-2': 0 }],
      ['the sender', { 'user-1': 0, 'user-2': 2 }],
      ['both users', { 'user-1': 5, 'user-2': 5 }],
    ])('returns 409 when %s is at the limit', async (_who, counts) => {
      countsFor(counts);

      const result = await accept();

      expect(resultStatus(result)).toBe(409);
      expect(resultJson(result)).toEqual({ error: 'Friend limit reached' });
      expect(mockPutFriendship).not.toHaveBeenCalled();
      expect(mockDeleteFriendRequest).not.toHaveBeenCalled();
    });

    it('accepts when both users are one below the limit', async () => {
      countsFor({ 'user-1': 1, 'user-2': 1 });
      const result = await accept();
      expect(resultStatus(result)).toBe(200);
    });

    it('checks the friend count of both users', async () => {
      await accept();
      expect(mockGetFriendCount).toHaveBeenCalledWith('user-1');
      expect(mockGetFriendCount).toHaveBeenCalledWith('user-2');
    });
  });

  // Documents current behaviour: the two friendship writes are separate, so a failure on
  // the second leaves a one-sided friendship, and the request is neither deleted nor retried.
  it('returns 500 and keeps the request when the second friendship write fails, leaving a one-sided friendship', async () => {
    mockPutFriendship.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('throttled'));

    const result = await accept();

    expect(resultStatus(result)).toBe(500);
    expect(mockPutFriendship).toHaveBeenCalledTimes(2);
    expect(mockDeleteFriendRequest).not.toHaveBeenCalled();
  });
});

// ── PUT /friend-requests/{requestId}/decline ──────────────────────────────────

describe('rest-handler: PUT /friend-requests/{requestId}/decline', () => {
  const decline = (requestId = 'req-1') => handler(restEvent('PUT', `/friend-requests/${requestId}/decline`));

  beforeEach(() => {
    mockGetFriendRequest.mockResolvedValue(friendRequest());
  });

  it('deletes the request without creating a friendship', async () => {
    const result = await decline();

    expect(resultStatus(result)).toBe(200);
    expect(resultJson(result)).toEqual({ message: 'Friend request declined' });
    expect(mockDeleteFriendRequest).toHaveBeenCalledWith('req-1');
    expect(mockPutFriendship).not.toHaveBeenCalled();
  });

  it('looks the request up by the id in the path', async () => {
    await decline('req-77');
    expect(mockGetFriendRequest).toHaveBeenCalledWith('req-77');
  });

  it('returns 404 for an unknown request', async () => {
    mockGetFriendRequest.mockResolvedValue(undefined);

    const result = await decline();

    expect(resultStatus(result)).toBe(404);
    expect(resultJson(result)).toEqual({ error: 'Friend request not found' });
    expect(mockDeleteFriendRequest).not.toHaveBeenCalled();
  });

  it('returns 403 when the caller is not the recipient', async () => {
    mockGetFriendRequest.mockResolvedValue(friendRequest({ toUserId: 'someone-else' }));

    const result = await decline();

    expect(resultStatus(result)).toBe(403);
    expect(mockDeleteFriendRequest).not.toHaveBeenCalled();
  });

  it.each(['accepted', 'declined'] as const)('returns 409 for a request that is already %s', async (status) => {
    mockGetFriendRequest.mockResolvedValue(friendRequest({ status }));

    const result = await decline();

    expect(resultStatus(result)).toBe(409);
    expect(resultJson(result)).toEqual({ error: 'Request is not pending' });
    expect(mockDeleteFriendRequest).not.toHaveBeenCalled();
  });
});
