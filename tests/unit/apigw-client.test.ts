export {}; // make this file a module so its top-level names stay local

// apigw-client.ts creates its client lazily and keeps it in a module variable, reading the
// WebSocket endpoint from the environment on first use. Each test loads a fresh copy of the
// module (and of the SDK it uses) inside jest.isolateModules.

const savedEnv = { ...process.env };

function loadClient(endpoint: string | undefined = 'https://abc123.execute-api.us-east-1.amazonaws.com/prod') {
  if (endpoint === undefined) delete process.env.WEBSOCKET_API_ENDPOINT;
  else process.env.WEBSOCKET_API_ENDPOINT = endpoint;
  process.env.AWS_REGION = 'us-east-1';

  let loaded!: {
    postToConnection: (connectionId: string, data: object) => Promise<void>;
    api: any;
    PostToConnectionCommand: any;
  };
  jest.isolateModules(() => {
    const sdk = require('@aws-sdk/client-apigatewaymanagementapi');
    const api = require('aws-sdk-client-mock').mockClient(sdk.ApiGatewayManagementApiClient);
    api.on(sdk.PostToConnectionCommand).resolves({});
    const { postToConnection } = require('../../src/utils/apigw-client');
    loaded = { postToConnection, api, PostToConnectionCommand: sdk.PostToConnectionCommand };
  });
  return loaded;
}

afterEach(() => {
  process.env = { ...savedEnv };
});

describe('apigw-client: postToConnection', () => {
  it('posts to the given connection', async () => {
    const { postToConnection, api, PostToConnectionCommand } = loadClient();

    await postToConnection('conn-1', { type: 'x' });

    expect(api.commandCalls(PostToConnectionCommand)).toHaveLength(1);
    expect(api.commandCalls(PostToConnectionCommand)[0].args[0].input.ConnectionId).toBe('conn-1');
  });

  it('sends the data as JSON bytes', async () => {
    const { postToConnection, api, PostToConnectionCommand } = loadClient();
    const message = {
      type: 'location.push',
      friendId: 'f-1',
      latitude: 20.6597,
      longitude: -103.3496,
      nested: { list: [1, 2, 3], text: 'ñ 😀' },
    };

    await postToConnection('conn-1', message);

    const data = api.commandCalls(PostToConnectionCommand)[0].args[0].input.Data;
    expect(Buffer.isBuffer(data)).toBe(true);
    expect(JSON.parse(data.toString('utf8'))).toEqual(message);
  });

  it('resolves with nothing once the message is posted', async () => {
    const { postToConnection } = loadClient();
    await expect(postToConnection('conn-1', { a: 1 })).resolves.toBeUndefined();
  });

  it('posts each message to its own connection', async () => {
    const { postToConnection, api, PostToConnectionCommand } = loadClient();

    await postToConnection('conn-1', { n: 1 });
    await postToConnection('conn-2', { n: 2 });

    const inputs = api.commandCalls(PostToConnectionCommand).map((call: any) => call.args[0].input);
    expect(inputs.map((i: any) => i.ConnectionId)).toEqual(['conn-1', 'conn-2']);
    expect(inputs.map((i: any) => JSON.parse(i.Data.toString()).n)).toEqual([1, 2]);
  });
});

describe('apigw-client: errors', () => {
  // Callers (fan-out and the WebSocket handler) recognise a closed connection by the
  // GoneException name or a 410 status, so the original error must reach them unchanged.
  it('lets a GoneException reach the caller unchanged', async () => {
    const { postToConnection, api, PostToConnectionCommand } = loadClient();
    const gone = Object.assign(new Error('Gone'), { name: 'GoneException', $metadata: { httpStatusCode: 410 } });
    api.on(PostToConnectionCommand).rejects(gone);

    const failure = await postToConnection('conn-1', { a: 1 }).catch((e) => e);

    expect(failure).toBe(gone);
    expect(failure.name).toBe('GoneException');
    expect(failure.$metadata.httpStatusCode).toBe(410);
  });

  it('lets other errors reach the caller unchanged', async () => {
    const { postToConnection, api, PostToConnectionCommand } = loadClient();
    const failure = new Error('Rate exceeded');
    api.on(PostToConnectionCommand).rejects(failure);

    await expect(postToConnection('conn-1', { a: 1 })).rejects.toBe(failure);
  });

  it('refuses data that cannot be serialised to JSON', async () => {
    const { postToConnection, api, PostToConnectionCommand } = loadClient();
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    await expect(postToConnection('conn-1', circular)).rejects.toThrow(TypeError);
    expect(api.commandCalls(PostToConnectionCommand)).toHaveLength(0);
  });
});

describe('apigw-client: endpoint', () => {
  const endpointOf = async (api: any) => {
    const instance = api.send.getCall(0).thisValue;
    return instance.config.endpoint();
  };

  it('talks to the WebSocket API endpoint from the environment', async () => {
    const { postToConnection, api } = loadClient('https://abc123.execute-api.us-east-1.amazonaws.com/prod');

    await postToConnection('conn-1', { a: 1 });

    const endpoint = await endpointOf(api);
    expect(endpoint.hostname).toBe('abc123.execute-api.us-east-1.amazonaws.com');
    expect(endpoint.path).toBe('/prod');
  });

  // Documents current behaviour: the client is created on first use and reused, so the endpoint
  // is read once. Changing the environment variable later has no effect in the same process.
  it('reads the endpoint once and reuses the client', async () => {
    const { postToConnection, api } = loadClient('https://first.execute-api.us-east-1.amazonaws.com/prod');

    await postToConnection('conn-1', { a: 1 });
    process.env.WEBSOCKET_API_ENDPOINT = 'https://second.execute-api.us-east-1.amazonaws.com/prod';
    await postToConnection('conn-2', { a: 2 });

    expect(api.send.getCall(1).thisValue).toBe(api.send.getCall(0).thisValue);
    expect((await endpointOf(api)).hostname).toBe('first.execute-api.us-east-1.amazonaws.com');
  });

  it('does not create a client until the first message is posted', async () => {
    const { api } = loadClient();
    expect(api.send.callCount).toBe(0);
  });
});
