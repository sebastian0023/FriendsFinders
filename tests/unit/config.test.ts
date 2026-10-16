export {}; // make this file a module so its top-level names stay local

// config.ts creates its SSM client and keeps its cache at module level, so every test loads
// a fresh copy of the module (and of the SDK it uses) inside jest.isolateModules.
// Time is controlled by replacing Date.now, so cache expiry and retry back-off are exact.

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
  'CONFIG_CACHE_TTL_SECONDS',
];

const CACHE_TTL = 300; // seconds a good value is used before SSM is asked again
const RETRY_BACKOFF = 30; // seconds to wait before asking SSM again after a failure

const savedEnv = { ...process.env };

let nowMs: number;
const advance = (seconds: number) => {
  nowMs += seconds * 1000;
};

let errorSpy: jest.SpyInstance;
let warnSpy: jest.SpyInstance;

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

beforeEach(() => {
  nowMs = 1_800_000_000_000;
  jest.spyOn(Date, 'now').mockImplementation(() => nowMs);
  errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  jest.restoreAllMocks();
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
    expect(warnSpy).not.toHaveBeenCalled(); // nothing was invalid, just not set
  });

  it('uses the default for any setting SSM did not return', async () => {
    const { getConfig, ssm, GetParametersCommand } = loadConfig();
    ssm.on(GetParametersCommand).resolves(parameters({ [PATHS.radius]: '12', [PATHS.maxFriends]: '100' }));

    expect(await getConfig()).toEqual({ ...DEFAULTS, searchRadiusMiles: 12, maxFriends: 100 });
  });

  it('ignores parameters without a value and parameters it did not ask for, without complaint', async () => {
    const { getConfig, ssm, GetParametersCommand } = loadConfig();
    ssm.on(GetParametersCommand).resolves({
      Parameters: [{ Name: PATHS.radius }, { Name: PATHS.ttl, Value: '' }, { Name: '/other/param', Value: '1' }, { Value: '2' }],
    });

    expect(await getConfig()).toEqual(DEFAULTS);
    expect(warnSpy).not.toHaveBeenCalled();
  });
});

describe('config: validation', () => {
  const returning = (path: string, value: string) => {
    const loaded = loadConfig();
    loaded.ssm.on(loaded.GetParametersCommand).resolves(parameters({ [path]: value }));
    return loaded;
  };

  it.each([
    ['a decimal', '2.5', 2.5],
    ['padded with spaces', ' 7 ', 7],
    ['in exponent form', '1e2', 100],
    ['a small positive decimal', '0.25', 0.25],
  ])('accepts a radius that is %s', async (_name, raw, expected) => {
    const { getConfig } = returning(PATHS.radius, raw);

    expect((await getConfig()).searchRadiusMiles).toBe(expected);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it.each([
    ['not a number', 'abc'],
    ['zero', '0'],
    ['negative', '-3'],
    ['infinite', 'Infinity'],
    ['negative infinity', '-Infinity'],
    ['NaN', 'NaN'],
  ])('replaces a radius that is %s with the default and warns', async (_name, raw) => {
    const { getConfig } = returning(PATHS.radius, raw);

    expect((await getConfig()).searchRadiusMiles).toBe(5);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining(PATHS.radius));
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining(`"${raw}"`));
  });

  it.each([
    ['inactivity TTL', PATHS.ttl, 'inactivityTtlSeconds', 600],
    ['update interval', PATHS.interval, 'locationUpdateIntervalSeconds', 30],
    ['max friends', PATHS.maxFriends, 'maxFriends', 5000],
    ['strangers limit', PATHS.strangers, 'nearbyStrangersLimit', 50],
  ])('requires the %s to be a positive whole number', async (_name, path, key, fallback) => {
    for (const raw of ['2.5', '0', '-1', 'abc', 'Infinity']) {
      const { getConfig } = returning(path, raw);
      expect((await getConfig() as any)[key]).toBe(fallback);
    }
    const { getConfig } = returning(path, '7');
    expect((await getConfig() as any)[key]).toBe(7);
  });

  it('only discards the setting that is invalid, not the others', async () => {
    const { getConfig, ssm, GetParametersCommand } = loadConfig();
    ssm.on(GetParametersCommand).resolves(parameters({ [PATHS.radius]: '-3', [PATHS.maxFriends]: '100' }));

    expect(await getConfig()).toEqual({ ...DEFAULTS, maxFriends: 100 });
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });
});

describe('config: caching and refreshing', () => {
  it('serves later calls from the cache without calling SSM again', async () => {
    const { getConfig, ssm, GetParametersCommand } = loadConfig();
    ssm.on(GetParametersCommand).resolves(parameters({ [PATHS.radius]: '12' }));

    const first = await getConfig();
    advance(CACHE_TTL - 1);
    const second = await getConfig();

    expect(second).toEqual(first);
    expect(ssm.commandCalls(GetParametersCommand)).toHaveLength(1);
  });

  it('asks SSM again once the cache has expired, so a changed parameter takes effect', async () => {
    const { getConfig, ssm, GetParametersCommand } = loadConfig();
    ssm.on(GetParametersCommand).resolvesOnce(parameters({ [PATHS.radius]: '12' })).resolves(parameters({ [PATHS.radius]: '99' }));

    expect((await getConfig()).searchRadiusMiles).toBe(12);
    advance(CACHE_TTL);
    expect((await getConfig()).searchRadiusMiles).toBe(99);

    expect(ssm.commandCalls(GetParametersCommand)).toHaveLength(2);
  });

  it('caches the refreshed value for another full period', async () => {
    const { getConfig, ssm, GetParametersCommand } = loadConfig();
    ssm.on(GetParametersCommand).resolves(parameters({ [PATHS.radius]: '12' }));

    await getConfig();
    advance(CACHE_TTL);
    await getConfig();
    advance(CACHE_TTL - 1);
    await getConfig();

    expect(ssm.commandCalls(GetParametersCommand)).toHaveLength(2);
  });

  it('lets the cache period be set with CONFIG_CACHE_TTL_SECONDS', async () => {
    const { getConfig, ssm, GetParametersCommand } = loadConfig({ CONFIG_CACHE_TTL_SECONDS: '60' });
    ssm.on(GetParametersCommand).resolves({});

    await getConfig();
    advance(59);
    await getConfig();
    expect(ssm.commandCalls(GetParametersCommand)).toHaveLength(1);

    advance(1);
    await getConfig();
    expect(ssm.commandCalls(GetParametersCommand)).toHaveLength(2);
  });

  it.each(['abc', '0', '-5', ''])('ignores an invalid CONFIG_CACHE_TTL_SECONDS (%p) and uses 5 minutes', async (raw) => {
    const { getConfig, ssm, GetParametersCommand } = loadConfig({ CONFIG_CACHE_TTL_SECONDS: raw });
    ssm.on(GetParametersCommand).resolves({});

    await getConfig();
    advance(CACHE_TTL - 1);
    await getConfig();
    expect(ssm.commandCalls(GetParametersCommand)).toHaveLength(1);

    advance(1);
    await getConfig();
    expect(ssm.commandCalls(GetParametersCommand)).toHaveLength(2);
  });
});

describe('config: concurrent callers', () => {
  const slowResponse = (value: unknown) => async () => {
    await new Promise<void>((resolve) => setImmediate(resolve)); // the call is still in flight for a moment
    return value;
  };

  it('share a single SSM call', async () => {
    const { getConfig, ssm, GetParametersCommand } = loadConfig();
    ssm.on(GetParametersCommand).callsFake(slowResponse(parameters({ [PATHS.radius]: '12' })));

    const results = await Promise.all([getConfig(), getConfig(), getConfig()]);

    expect(ssm.commandCalls(GetParametersCommand)).toHaveLength(1);
    expect(results.map((c) => c.searchRadiusMiles)).toEqual([12, 12, 12]);
  });

  it('also share a failed attempt, and all get the fallback', async () => {
    const { getConfig, ssm, GetParametersCommand } = loadConfig();
    ssm.on(GetParametersCommand).callsFake(async () => {
      await new Promise<void>((resolve) => setImmediate(resolve));
      throw new Error('ThrottlingException');
    });

    const results = await Promise.all([getConfig(), getConfig()]);

    expect(ssm.commandCalls(GetParametersCommand)).toHaveLength(1);
    expect(results).toEqual([DEFAULTS, DEFAULTS]);
  });
});

describe('config: when SSM fails', () => {
  it('serves the defaults instead of throwing, and logs the failure', async () => {
    const { getConfig, ssm, GetParametersCommand } = loadConfig();
    const failure = new Error('ThrottlingException');
    ssm.on(GetParametersCommand).rejects(failure);

    await expect(getConfig()).resolves.toEqual(DEFAULTS);

    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('SSM'), failure);
  });

  it('waits before asking again, so a failing SSM does not slow every request', async () => {
    const { getConfig, ssm, GetParametersCommand } = loadConfig();
    ssm.on(GetParametersCommand).rejects(new Error('boom'));

    await getConfig();
    advance(RETRY_BACKOFF - 1);
    const during = await getConfig();

    expect(during).toEqual(DEFAULTS);
    expect(ssm.commandCalls(GetParametersCommand)).toHaveLength(1);
  });

  it('does not keep the defaults: it asks again after the back-off and uses what SSM then returns', async () => {
    const { getConfig, ssm, GetParametersCommand } = loadConfig();
    ssm.on(GetParametersCommand).rejectsOnce(new Error('boom')).resolves(parameters({ [PATHS.radius]: '12' }));

    expect((await getConfig()).searchRadiusMiles).toBe(5);
    advance(RETRY_BACKOFF);
    expect((await getConfig()).searchRadiusMiles).toBe(12);

    // and the recovered value is then cached for a full period
    advance(CACHE_TTL - 1);
    await getConfig();
    expect(ssm.commandCalls(GetParametersCommand)).toHaveLength(2);
  });

  it('keeps serving the last good values when a refresh fails, and says so', async () => {
    const { getConfig, ssm, GetParametersCommand } = loadConfig();
    ssm.on(GetParametersCommand).resolvesOnce(parameters({ [PATHS.radius]: '12' })).rejects(new Error('boom'));

    await getConfig();
    advance(CACHE_TTL);
    const during = await getConfig();

    expect(during.searchRadiusMiles).toBe(12); // not the default of 5
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('last known'), expect.any(Error));
  });

  it('backs off after a failed refresh, then retries and recovers', async () => {
    const { getConfig, ssm, GetParametersCommand } = loadConfig();
    ssm
      .on(GetParametersCommand)
      .resolvesOnce(parameters({ [PATHS.radius]: '12' }))
      .rejectsOnce(new Error('boom'))
      .resolves(parameters({ [PATHS.radius]: '20' }));

    await getConfig(); // call 1: good
    advance(CACHE_TTL);
    await getConfig(); // call 2: refresh fails, last good served
    advance(RETRY_BACKOFF - 1);
    expect((await getConfig()).searchRadiusMiles).toBe(12); // still backing off: no call
    expect(ssm.commandCalls(GetParametersCommand)).toHaveLength(2);

    advance(1);
    expect((await getConfig()).searchRadiusMiles).toBe(20); // call 3: recovered
    expect(ssm.commandCalls(GetParametersCommand)).toHaveLength(3);
  });
});
