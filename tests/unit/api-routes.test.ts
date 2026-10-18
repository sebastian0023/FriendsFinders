import { readFileSync } from 'fs';
import { join } from 'path';
import { restEvent, resultJson, resultStatus } from '../helpers/rest-events';

// Same module replacements as the other REST handler tests: no AWS client is ever created.
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
  getConnectionsNear: jest.fn(),
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

// Every HTTP route exposed by API Gateway must be served by the REST handler. A route that
// API Gateway forwards but the handler does not know answers 404 { error: 'Not found' }.
const TERRAFORM = readFileSync(join(__dirname, '../../terraform/modules/api-gateway/main.tf'), 'utf8');

// HTTP API route keys look like "GET /friends/{friendId}"; WebSocket ones ("$connect") have no method.
const httpRoutes = [...TERRAFORM.matchAll(/route_key\s*=\s*"([A-Z]+) (\/[^"]*)"/g)].map((match) => ({
  method: match[1],
  path: match[2],
}));

describe('API Gateway routes are served by the REST handler', () => {
  beforeEach(() => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    // A normal user: signed in, with a profile.
    (dynamo.getUser as jest.Mock).mockResolvedValue({
      userId: 'user-1',
      displayName: 'Caller',
      discoverable: false,
      createdAt: '2026-01-01T00:00:00.000Z',
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('finds the HTTP routes in the Terraform file', () => {
    expect(httpRoutes.length).toBeGreaterThan(0);
  });

  it.each(httpRoutes.map((route) => [`${route.method} ${route.path}`, route] as const))(
    '%s is routed',
    async (_name, route) => {
      const path = route.path.replace(/\{[^}]+\}/g, 'user-1'); // fill {params} with a sample id

      const result = await handler(restEvent(route.method, path));

      // Whatever the handler decides (200, 400, 404 for a missing record, 500 ...), it must not
      // be the router's own "no such route" answer.
      expect(resultJson(result)).not.toEqual({ error: 'Not found' });
    }
  );
});

// Nobody can use the app without a name. Every route needs a profile, except reading or creating
// your own profile, which is how a new user gets one.
const OWN_PROFILE_ROUTES = new Set(['GET /users/{userId}/profile', 'PUT /users/{userId}/profile']);
const sampleRoutes = httpRoutes.map((route) => ({
  key: `${route.method} ${route.path}`,
  method: route.method,
  path: route.path.replace(/\{[^}]+\}/g, 'user-1'), // the caller's own id
}));

describe('a caller without a profile', () => {
  beforeEach(() => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    (dynamo.getUser as jest.Mock).mockResolvedValue(undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  const dataCallsOtherThanGetUser = () =>
    Object.entries(dynamo)
      .filter(([name, fn]) => name !== 'getUser' && jest.isMockFunction(fn))
      .map(([, fn]) => fn as jest.Mock);

  it.each(sampleRoutes.filter((route) => !OWN_PROFILE_ROUTES.has(route.key)).map((route) => [route.key, route] as const))(
    '%s answers 403 and does nothing',
    async (_name, route) => {
      const result = await handler(restEvent(route.method, route.path));

      expect(resultStatus(result)).toBe(403);
      expect(resultJson(result)).toEqual({ error: 'Set a display name first' });
      for (const call of dataCallsOtherThanGetUser()) expect(call).not.toHaveBeenCalled();
      expect(dynamo.getUser).toHaveBeenCalledTimes(1);
      expect(dynamo.getUser).toHaveBeenCalledWith('user-1');
    }
  );

  it.each(sampleRoutes.filter((route) => OWN_PROFILE_ROUTES.has(route.key)).map((route) => [route.key, route] as const))(
    '%s still works, so the profile can be created',
    async (_name, route) => {
      const result = await handler(restEvent(route.method, route.path, { body: { displayName: 'Ana' } }));

      expect(resultStatus(result)).not.toBe(403);
    }
  );

  it('is not asked for a profile when it is not signed in at all (401, not 403)', async () => {
    const result = await handler(restEvent('GET', '/friends', { sub: null }));

    expect(resultStatus(result)).toBe(401);
    expect(dynamo.getUser).not.toHaveBeenCalled();
  });
});
