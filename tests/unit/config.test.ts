export {}; // make this file a module so its top-level names stay local

// config.ts creates its SSM client and keeps its cache at module level, so every test loads
// a fresh copy of the module (and of the SDK it uses) inside jest.isolateModules.

const PATHS = {
  radius: '/nearby-friends/search-radius-miles',
  ttl: '/nearby-friends/inactivity-ttl-seconds',
  interval: '/nearby-friends/location-update-interval-seconds',
  maxFriends: '/nearby-friends/max-friends',
  strangers: '/nearby-friends/nearby-strangers-limit',
};

const DEFAULTS = {
  searchRadiusMiles: 5,
  inactivityTtlSeconds: 600,
  locationUpdateIntervalSeconds: 30,
  maxFriends: 5000,
  nearbyStrangersLimit: 50,
};

const OVERRIDE_VARS = [
  'SSM_SEARCH_RADIUS',
  'SSM_INACTIVITY_TTL',
  'SSM_LOCATION_UPDATE_INTERVAL',
  'SSM_MAX_FRIENDS',
  'SSM_NEARBY_STRANGERS_LIMIT',
];

const savedEnv = { ...process.env };

function loadConfig(env: Record<string, string> = {}) {
  for (const name of OVERRIDE_VARS) delete process.env[name];
  Object.assign(process.env, env);

  let loaded!: {
    getConfig: () => Promise<typeof DEFAULTS>;
    ssm: any;
    GetParametersCommand: any;
  };
  jest.isolateModules(() => {
    const sdk = require('@aws-sdk/client-ssm');
    const ssm = require('aws-sdk-client-mock').mockClient(sdk.SSMClient);
    const { getConfig } = require('../../src/utils/config');
    loaded = { getConfig, ssm, GetParametersCommand: sdk.GetParametersCommand };
  });
  return loaded;
}

const parameters = (values: Record<string, string>) => ({
  Parameters: Object.entries(values).map(([Name, Value]) => ({ Name, Value })),
});

afterEach(() => {
  process.env = { ...savedEnv };
});

describe('config: what is requested from SSM', () => {
  it('asks for the five parameters in a single call', async () => {
    const { getConfig, ssm, GetParametersCommand } = loadConfig();
    ssm.on(GetParametersCommand).resolves({});

    await getConfig();

    expect(ssm.commandCalls(GetParametersCommand)).toHaveLength(1);
    expect(ssm.commandCalls(GetParametersCommand)[0].args[0].input).toEqual({
      Names: [PATHS.radius, PATHS.ttl, PATHS.interval, PATHS.maxFriends, PATHS.strangers],
    });
  });

  it('uses parameter paths from the environment when they are set', async () => {
    const { getConfig, ssm, GetParametersCommand } = loadConfig({
      SSM_SEARCH_RADIUS: '/custom/radius',
      SSM_INACTIVITY_TTL: '/custom/ttl',
      SSM_LOCATION_UPDATE_INTERVAL: '/custom/interval',
      SSM_MAX_FRIENDS: '/custom/max-friends',
      SSM_NEARBY_STRANGERS_LIMIT: '/custom/strangers',
    });
    ssm.on(GetParametersCommand).resolves(parameters({ '/custom/radius': '9' }));

    const config = await getConfig();

    expect(ssm.commandCalls(GetParametersCommand)[0].args[0].input.Names).toEqual([
      '/custom/radius',
      '/custom/ttl',
      '/custom/interval',
      '/custom/max-friends',
      '/custom/strangers',
    ]);
    expect(config.searchRadiusMiles).toBe(9);
  });
});

describe('config: values', () => {
  it('reads all five settings as numbers', async () => {
    const { getConfig, ssm, GetParametersCommand } = loadConfig();
    ssm.on(GetParametersCommand).resolves(
      parameters({
        [PATHS.radius]: '12',
        [PATHS.ttl]: '900',
        [PATHS.interval]: '15',
        [PATHS.maxFriends]: '100',
        [PATHS.strangers]: '10',
      })
    );

    expect(await getConfig()).toEqual({
      searchRadiusMiles: 12,
      inactivityTtlSeconds: 900,
      locationUpdateIntervalSeconds: 15,
      maxFriends: 100,
      nearbyStrangersLimit: 10,
    });
  });

  it.each([
    ['an empty response', {}],
    ['no parameters', { Parameters: [] }],
  ])('uses the defaults for %s', async (_name, response) => {
    const { getConfig, ssm, GetParametersCommand } = loadConfig();
    ssm.on(GetParametersCommand).resolves(response);

    expect(await getConfig()).toEqual(DEFAULTS);
  });

  it('uses the default for any setting SSM did not return', async () => {
    const { getConfig, ssm, GetParametersCommand } = loadConfig();
    ssm.on(GetParametersCommand).resolves(parameters({ [PATHS.radius]: '12', [PATHS.maxFriends]: '100' }));

    expect(await getConfig()).toEqual({ ...DEFAULTS, searchRadiusMiles: 12, maxFriends: 100 });
  });

  it('ignores parameters without a value and parameters it did not ask for', async () => {
    const { getConfig, ssm, GetParametersCommand } = loadConfig();
    ssm.on(GetParametersCommand).resolves({
      Parameters: [{ Name: PATHS.radius }, { Name: PATHS.ttl, Value: '' }, { Name: '/other/param', Value: '1' }, { Value: '2' }],
    });

    expect(await getConfig()).toEqual(DEFAULTS);
  });

  it.each([
    ['not a number', 'abc', 5],
    ['a decimal', '2.5', 2.5],
    ['padded with spaces', ' 7 ', 7],
    ['in exponent form', '1e2', 100],
  ])('parses a value that is %s', async (_name, raw, expected) => {
    const { getConfig, ssm, GetParametersCommand } = loadConfig();
    ssm.on(GetParametersCommand).resolves(parameters({ [PATHS.radius]: raw }));

    expect((await getConfig()).searchRadiusMiles).toBe(expected);
  });

  // Documents known gaps: values are parsed with `Number(x) || default`, so zero becomes
  // the default (a radius of 0 can never be configured), while negative and infinite values
  // are accepted as they are. A negative radius would match nobody; an infinite one, everybody.
  it.each([
    ['zero falls back to the default', '0', 5],
    ['a negative value is accepted', '-3', -3],
    ['Infinity is accepted', 'Infinity', Infinity],
  ])('currently: %s', async (_name, raw, expected) => {
    const { getConfig, ssm, GetParametersCommand } = loadConfig();
    ssm.on(GetParametersCommand).resolves(parameters({ [PATHS.radius]: raw }));

    expect((await getConfig()).searchRadiusMiles).toBe(expected);
  });
});

describe('config: caching', () => {
  it('calls SSM once and serves later calls from the cache', async () => {
    const { getConfig, ssm, GetParametersCommand } = loadConfig();
    ssm.on(GetParametersCommand).resolves(parameters({ [PATHS.radius]: '12' }));

    const first = await getConfig();
    const second = await getConfig();

    expect(second).toEqual(first);
    expect(ssm.commandCalls(GetParametersCommand)).toHaveLength(1);
  });

  // Documents current behaviour: a cached value never expires, so changing a parameter in
  // SSM has no effect on a warm Lambda container until it is replaced.
  it('never refreshes a cached value', async () => {
    const { getConfig, ssm, GetParametersCommand } = loadConfig();
    ssm.on(GetParametersCommand).resolvesOnce(parameters({ [PATHS.radius]: '12' })).resolves(parameters({ [PATHS.radius]: '99' }));

    await getConfig();
    const later = await getConfig();

    expect(later.searchRadiusMiles).toBe(12);
    expect(ssm.commandCalls(GetParametersCommand)).toHaveLength(1);
  });
});

describe('config: when SSM fails', () => {
  it('falls back to the defaults instead of throwing', async () => {
    const { getConfig, ssm, GetParametersCommand } = loadConfig();
    ssm.on(GetParametersCommand).rejects(new Error('ThrottlingException'));

    await expect(getConfig()).resolves.toEqual(DEFAULTS);
  });

  // Documents a known gap: the defaults are cached like a real answer, and the failure is not
  // logged. One transient SSM error therefore makes a warm container ignore the configured
  // settings, silently, until it is replaced. A failure should not be cached.
  it('currently caches the fallback defaults and does not retry', async () => {
    const { getConfig, ssm, GetParametersCommand } = loadConfig();
    ssm
      .on(GetParametersCommand)
      .rejectsOnce(new Error('ThrottlingException'))
      .resolves(parameters({ [PATHS.radius]: '12' }));

    const during = await getConfig();
    const after = await getConfig();

    expect(during).toEqual(DEFAULTS);
    expect(after.searchRadiusMiles).toBe(5); // would be 12 if the failure were retried
    expect(ssm.commandCalls(GetParametersCommand)).toHaveLength(1);
  });
});
