import { readFileSync } from 'fs';
import { join } from 'path';
import { restEvent, resultJson } from '../helpers/rest-events';

// Same module replacements as the other REST handler tests: no AWS client is ever created.
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
