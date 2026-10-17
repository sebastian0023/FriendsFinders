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
import { generateDownloadUrl, generateUploadUrl } from '../../src/utils/s3-client';
import { UserProfile } from '../../src/types';

const mockGetUser = dynamo.getUser as jest.MockedFunction<typeof dynamo.getUser>;
const mockPutUser = dynamo.putUser as jest.MockedFunction<typeof dynamo.putUser>;
const mockUpdateUser = dynamo.updateUser as jest.MockedFunction<typeof dynamo.updateUser>;
const mockGetConfig = getConfig as jest.MockedFunction<typeof getConfig>;
const mockDownloadUrl = generateDownloadUrl as jest.MockedFunction<typeof generateDownloadUrl>;
const mockUploadUrl = generateUploadUrl as jest.MockedFunction<typeof generateUploadUrl>;

const CONFIG = {
  searchRadiusMiles: 5,
  inactivityTtlSeconds: 600,
  locationUpdateIntervalSeconds: 30,
  maxFriends: 5000,
  nearbyStrangersLimit: 50,
};

// The key format produced by the upload-URL endpoint, for the default caller (user-1).
const OWN_KEY = 'profile-pictures/user-1/0b9c5a52-7d2f-4a43-9b53-1f6d6a1e2c11.jpg';

function user(overrides: Partial<UserProfile> = {}): UserProfile {
  return {
    userId: 'user-2',
    displayName: 'Friend Two',
    discoverable: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

let errorSpy: jest.SpyInstance;

beforeEach(() => {
  // clearMocks resets call history but keeps implementations, so set safe defaults every time.
  mockGetConfig.mockResolvedValue(CONFIG);
  mockGetUser.mockResolvedValue(undefined);
  mockPutUser.mockResolvedValue(undefined);
  mockUpdateUser.mockResolvedValue(undefined);
  mockDownloadUrl.mockImplementation(async (key: string) => `https://signed.example/${key}`);
  mockUploadUrl.mockResolvedValue({ uploadUrl: 'https://upload.example/put', s3Key: 'profile-pictures/user-1/k.jpg' });
  errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  errorSpy.mockRestore();
});

// ── GET /users/{userId}/profile ───────────────────────────────────────────────

describe('rest-handler: GET /users/{userId}/profile', () => {
  const getProfile = (id = 'user-2', sub: string | null = 'user-1') =>
    handler(restEvent('GET', `/users/${id}/profile`, { sub }));

  it('returns 404 for an unknown user', async () => {
    const result = await getProfile('ghost');

    expect(resultStatus(result)).toBe(404);
    expect(resultJson(result)).toEqual({ error: 'User not found' });
    expect(mockGetUser).toHaveBeenCalledWith('ghost');
  });

  it('returns the public profile with a signed picture URL', async () => {
    mockGetUser.mockResolvedValue(user({ profilePictureKey: 'pics/two.jpg' }));

    const result = await getProfile();

    expect(resultStatus(result)).toBe(200);
    expect(resultJson(result)).toEqual({
      userId: 'user-2',
      displayName: 'Friend Two',
      profilePictureUrl: 'https://signed.example/pics/two.jpg',
      discoverable: true,
      createdAt: '2026-01-01T00:00:00.000Z',
    });
  });

  it('omits the picture URL when the user has no picture', async () => {
    mockGetUser.mockResolvedValue(user());

    const result = await getProfile();

    expect(resultJson(result)).not.toHaveProperty('profilePictureUrl');
    expect(mockDownloadUrl).not.toHaveBeenCalled();
  });

  it('does not leak other stored attributes or the raw storage key', async () => {
    // Whatever else is stored on the item (old friend lists, internal fields) must not be exposed.
    mockGetUser.mockResolvedValue({
      ...user({ profilePictureKey: 'pics/two.jpg' }),
      friendIds: ['user-3', 'user-4'],
      friendshipDates: { 'user-3': '2026-02-02T00:00:00.000Z' },
      internalNote: 'staff only',
    } as unknown as UserProfile);

    const body = resultJson(await getProfile());

    expect(Object.keys(body).sort()).toEqual(['createdAt', 'discoverable', 'displayName', 'profilePictureUrl', 'userId']);
  });

  // Documents current behaviour: the handler never reads the caller's claims for this route;
  // it relies on the API Gateway JWT authorizer to reject unauthenticated calls.
  it('does not itself require authorizer claims', async () => {
    mockGetUser.mockResolvedValue(user());
    const result = await getProfile('user-2', null);
    expect(resultStatus(result)).toBe(200);
  });
});

// ── PUT /users/{userId}/profile ───────────────────────────────────────────────

describe('rest-handler: PUT /users/{userId}/profile', () => {
  const put = (opts: Parameters<typeof restEvent>[2] = {}, id = 'user-1') =>
    handler(restEvent('PUT', `/users/${id}/profile`, opts));

  it('returns 401 without authorizer claims and touches nothing', async () => {
    const result = await put({ sub: null, body: { displayName: 'X' } });

    expect(resultStatus(result)).toBe(401);
    expect(mockGetUser).not.toHaveBeenCalled();
    expect(mockPutUser).not.toHaveBeenCalled();
    expect(mockUpdateUser).not.toHaveBeenCalled();
  });

  it("returns 403 when editing another user's profile and writes nothing", async () => {
    const result = await put({ body: { displayName: 'Hijacked' } }, 'user-2');

    expect(resultStatus(result)).toBe(403);
    expect(resultJson(result)).toEqual({ error: 'Forbidden' });
    expect(mockGetUser).not.toHaveBeenCalled();
    expect(mockPutUser).not.toHaveBeenCalled();
    expect(mockUpdateUser).not.toHaveBeenCalled();
  });

  describe('when the profile does not exist yet', () => {
    it('creates it from the body', async () => {
      const result = await put({
        body: { displayName: 'Ana', profilePictureKey: OWN_KEY, discoverable: true },
      });

      expect(resultStatus(result)).toBe(200);
      expect(resultJson(result)).toEqual({ message: 'Profile created' });
      expect(mockPutUser).toHaveBeenCalledWith({
        userId: 'user-1',
        displayName: 'Ana',
        profilePictureKey: OWN_KEY,
        discoverable: true,
        createdAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T.*Z$/),
      });
      expect(mockUpdateUser).not.toHaveBeenCalled();
    });

    it('defaults to display name "User" and not discoverable', async () => {
      await put({ body: {} });

      expect(mockPutUser).toHaveBeenCalledWith(
        expect.objectContaining({ userId: 'user-1', displayName: 'User', discoverable: false })
      );
    });

    it('defaults when there is no body at all', async () => {
      const result = await put();

      expect(resultStatus(result)).toBe(200);
      expect(mockPutUser).toHaveBeenCalledWith(
        expect.objectContaining({ displayName: 'User', discoverable: false })
      );
    });

    it('rejects an empty display name instead of silently using "User"', async () => {
      const result = await put({ body: { displayName: '' } });

      expect(resultStatus(result)).toBe(400);
      expect(resultJson(result)).toEqual({ error: 'displayName must be between 1 and 50 characters' });
      expect(mockPutUser).not.toHaveBeenCalled();
    });

    it('stores the display name trimmed', async () => {
      await put({ body: { displayName: '  Ana  ' } });
      expect(mockPutUser).toHaveBeenCalledWith(expect.objectContaining({ displayName: 'Ana' }));
    });

    it('keeps an explicit discoverable: false', async () => {
      await put({ body: { discoverable: false } });
      expect(mockPutUser).toHaveBeenCalledWith(expect.objectContaining({ discoverable: false }));
    });

    it('ignores fields a client must not set (friend list, creation date, user id)', async () => {
      await put({
        body: {
          userId: 'user-99',
          createdAt: '1999-01-01T00:00:00.000Z',
          friendIds: ['user-5'],
          friendshipDates: { 'user-5': '1999-01-01T00:00:00.000Z' },
        },
      });

      const stored = mockPutUser.mock.calls[0][0];
      expect(stored.userId).toBe('user-1');
      expect(stored.createdAt).not.toBe('1999-01-01T00:00:00.000Z');
      expect(stored).not.toHaveProperty('friendIds');
      expect(stored).not.toHaveProperty('friendshipDates');
    });
  });

  describe('when the profile already exists', () => {
    beforeEach(() => {
      mockGetUser.mockResolvedValue(user({ userId: 'user-1', displayName: 'Old Name' }));
    });

    it('updates only the fields that were sent', async () => {
      const result = await put({ body: { displayName: 'New Name' } });

      expect(resultStatus(result)).toBe(200);
      expect(resultJson(result)).toEqual({ message: 'Profile updated' });
      expect(mockUpdateUser).toHaveBeenCalledWith('user-1', { displayName: 'New Name' });
      expect(mockPutUser).not.toHaveBeenCalled();
    });

    it('updates all three editable fields together', async () => {
      await put({ body: { displayName: 'N', profilePictureKey: OWN_KEY, discoverable: true } });

      expect(mockUpdateUser).toHaveBeenCalledWith('user-1', {
        displayName: 'N',
        profilePictureKey: OWN_KEY,
        discoverable: true,
      });
    });

    it('stores the display name trimmed', async () => {
      await put({ body: { displayName: '  New Name  ' } });
      expect(mockUpdateUser).toHaveBeenCalledWith('user-1', { displayName: 'New Name' });
    });

    it('applies discoverable: false (a falsy value is still a change)', async () => {
      await put({ body: { discoverable: false } });
      expect(mockUpdateUser).toHaveBeenCalledWith('user-1', { discoverable: false });
    });

    it('ignores fields a client must not set (friend list, creation date, user id)', async () => {
      await put({
        body: { displayName: 'N', userId: 'user-99', createdAt: '1999-01-01T00:00:00.000Z', friendIds: ['user-5'] },
      });

      expect(mockUpdateUser).toHaveBeenCalledWith('user-1', { displayName: 'N' });
    });

    // Documents current behaviour: an update with nothing to change still issues a write.
    it('still calls updateUser with no changes for an empty body', async () => {
      const result = await put({ body: {} });

      expect(resultStatus(result)).toBe(200);
      expect(mockUpdateUser).toHaveBeenCalledWith('user-1', {});
    });

  });

  // Invalid input is rejected whether or not the profile exists, and before any database access.
  describe.each([
    ['a new profile', undefined],
    ['an existing profile', user({ userId: 'user-1' })],
  ])('with invalid input for %s', (_case, existing) => {
    beforeEach(() => {
      mockGetUser.mockResolvedValue(existing);
    });

    it.each([
      ['an empty display name', { displayName: '' }, 'displayName must be between 1 and 50 characters'],
      ['a blank display name', { displayName: '   ' }, 'displayName must be between 1 and 50 characters'],
      ['a non-string display name', { displayName: 42 }, 'displayName must be a string'],
      ['a very long display name', { displayName: 'x'.repeat(10_000) }, 'displayName must be between 1 and 50 characters'],
      ['a display name with control characters', { displayName: 'a\u0000b' }, 'displayName must not contain control characters'],
      ['a string discoverable flag', { discoverable: 'false' }, 'discoverable must be true or false'],
      ['a numeric discoverable flag', { discoverable: 0 }, 'discoverable must be true or false'],
      ['another user\'s picture key', { profilePictureKey: 'profile-pictures/user-2/their.jpg' }, 'profilePictureKey must be an upload key for your own profile'],
      ['an arbitrary bucket key', { profilePictureKey: 'private/report.pdf' }, 'profilePictureKey must be an upload key for your own profile'],
      ['a non-string picture key', { profilePictureKey: 7 }, 'profilePictureKey must be a string'],
    ])('rejects %s with 400 and writes nothing', async (_name, body, error) => {
      const result = await put({ body });

      expect(resultStatus(result)).toBe(400);
      expect(resultJson(result)).toEqual({ error });
      expect(mockGetUser).not.toHaveBeenCalled();
      expect(mockPutUser).not.toHaveBeenCalled();
      expect(mockUpdateUser).not.toHaveBeenCalled();
    });

    it('rejects malformed JSON with 400', async () => {
      const result = await put({ rawBody: '{not json' });

      expect(resultStatus(result)).toBe(400);
      expect(resultJson(result)).toEqual({ error: 'Invalid JSON' });
      expect(mockGetUser).not.toHaveBeenCalled();
      expect(mockPutUser).not.toHaveBeenCalled();
      expect(mockUpdateUser).not.toHaveBeenCalled();
    });

    it.each(['null', '[]', '"text"', '42', 'true'])('rejects a JSON body of %s with 400', async (rawBody) => {
      const result = await put({ rawBody });

      expect(resultStatus(result)).toBe(400);
      expect(resultJson(result)).toEqual({ error: 'Request body must be a JSON object' });
      expect(mockGetUser).not.toHaveBeenCalled();
      expect(mockPutUser).not.toHaveBeenCalled();
      expect(mockUpdateUser).not.toHaveBeenCalled();
    });
  });

  it('checks ownership before validating the body (403, not 400)', async () => {
    const result = await put({ body: { displayName: '' } }, 'user-2');
    expect(resultStatus(result)).toBe(403);
  });

  it('checks authentication before validating the body (401, not 400)', async () => {
    const result = await put({ sub: null, rawBody: '{not json' });
    expect(resultStatus(result)).toBe(401);
  });
});

// ── GET /users/{userId}/profile-picture-upload-url ────────────────────────────

describe('rest-handler: GET /users/{userId}/profile-picture-upload-url', () => {
  const upload = (opts: Parameters<typeof restEvent>[2] = {}, id = 'user-1') =>
    handler(restEvent('GET', `/users/${id}/profile-picture-upload-url`, opts));

  it('returns 401 without authorizer claims', async () => {
    const result = await upload({ sub: null });

    expect(resultStatus(result)).toBe(401);
    expect(mockUploadUrl).not.toHaveBeenCalled();
  });

  it("returns 403 for another user's upload URL", async () => {
    const result = await upload({}, 'user-2');

    expect(resultStatus(result)).toBe(403);
    expect(resultJson(result)).toEqual({ error: 'Forbidden' });
    expect(mockUploadUrl).not.toHaveBeenCalled();
  });

  it('returns a signed upload URL and the key for the caller', async () => {
    const result = await upload();

    expect(resultStatus(result)).toBe(200);
    expect(resultJson(result)).toEqual({
      uploadUrl: 'https://upload.example/put',
      s3Key: 'profile-pictures/user-1/k.jpg',
    });
    expect(mockUploadUrl).toHaveBeenCalledWith('user-1');
  });

  it('is not shadowed by the profile route', async () => {
    await upload();
    expect(mockGetUser).not.toHaveBeenCalled();
  });

  it('is only available through GET', async () => {
    const result = await handler(restEvent('PUT', '/users/user-1/profile-picture-upload-url'));

    expect(resultStatus(result)).toBe(404);
    expect(mockUploadUrl).not.toHaveBeenCalled();
  });
});
