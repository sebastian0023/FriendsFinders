import { openPage, closeAllPages, waitFor, settle, Routes } from '../helpers/page';

// Nobody can use the app without a name, and people are only ever shown by name. These tests open
// the real page against a fake API and check what the user would see.

const ok = (json: unknown = {}) => ({ status: 200, json });

const NO_PROFILE = { status: 404, json: { error: 'User not found' } };
const EXISTING_PROFILE = ok({ userId: 'user-1', displayName: 'Cami', discoverable: true });

/** Routes for a signed-in user; pass overrides for the parts a test cares about. */
const routes = (overrides: Routes = {}): Routes => ({
  'GET /users/user-1/profile': NO_PROFILE,
  'PUT /users/user-1/profile': ({ body }) => ok({ message: 'Profile created', body }),
  'GET /friends': ok([]),
  ...overrides,
});

const withProfile = (overrides: Routes = {}) => routes({ 'GET /users/user-1/profile': EXISTING_PROFILE, ...overrides });

const UNKNOWN_ID = 'e4686448-e0d1-70e4-ed9f-6cca1df210e9';

afterEach(() => {
  closeAllPages();
});

describe('web app: signed out', () => {
  it('shows only the sign-in card', async () => {
    const page = openPage({ claims: null });
    await settle();

    expect(page.visible('section-auth')).toBe(true);
    expect(page.visible('section-name')).toBe(false);
    expect(page.visible('tabs-container')).toBe(false);
    expect(page.calls).toEqual([]);
  });
});

describe('web app: choosing a name', () => {
  it('is asked for before anything else when the user has no profile', async () => {
    const page = openPage({ routes: routes() });
    await waitFor(() => page.visible('section-name'), 'the name step');

    expect(page.visible('tabs-container')).toBe(false);
    expect(page.visible('tab-nav')).toBe(false);
    expect(page.visible('section-auth')).toBe(false);
  });

  it.each([
    ['empty', ''],
    ['blank', '   '],
  ])('refuses a name that is %s and sends nothing', async (_kind, value) => {
    const page = openPage({ routes: routes() });
    await waitFor(() => page.visible('section-name'), 'the name step');

    (page.$('input-first-name') as HTMLInputElement).value = value;
    page.$('btn-save-first-name').click();
    await settle();

    expect(page.$('first-name-status').textContent).toBe('Please enter a name.');
    expect(page.calls.filter((c) => c.method === 'PUT')).toEqual([]);
    expect(page.visible('tabs-container')).toBe(false);
  });

  it('creates the profile with the trimmed name, not discoverable, and then shows the app', async () => {
    const page = openPage({ routes: routes() });
    await waitFor(() => page.visible('section-name'), 'the name step');

    (page.$('input-first-name') as HTMLInputElement).value = '  Ana  ';
    page.$('btn-save-first-name').click();
    await waitFor(() => page.visible('tabs-container'), 'the app');

    expect(page.calls.find((c) => c.method === 'PUT')).toEqual({
      method: 'PUT',
      path: '/users/user-1/profile',
      body: { displayName: 'Ana', discoverable: false },
    });
    expect(page.visible('section-name')).toBe(false);
    expect(page.visible('tab-nav')).toBe(true);
    expect((page.$('input-name') as HTMLInputElement).value).toBe('Ana');
    expect(page.calls.some((c) => c.method === 'GET' && c.path === '/friends')).toBe(true);
  });

  it('also accepts the name with the Enter key', async () => {
    const page = openPage({ routes: routes() });
    await waitFor(() => page.visible('section-name'), 'the name step');

    (page.$('input-first-name') as HTMLInputElement).value = 'Beto';
    page.$('input-first-name').dispatchEvent(new page.window.KeyboardEvent('keydown', { key: 'Enter' }));
    await waitFor(() => page.visible('tabs-container'), 'the app');

    expect(page.calls.some((c) => c.method === 'PUT' && c.body.displayName === 'Beto')).toBe(true);
  });

  it('is prefilled with a name given at sign-up', async () => {
    const page = openPage({ routes: routes(), claims: { sub: 'user-1', email: 'a@example.com', name: 'Dani' } });
    await waitFor(() => page.visible('section-name'), 'the name step');

    expect((page.$('input-first-name') as HTMLInputElement).value).toBe('Dani');
  });

  it("shows the server's reason in plain words and lets the user try again", async () => {
    const page = openPage({
      routes: routes({
        'PUT /users/user-1/profile': { status: 400, json: { error: 'displayName must not contain control characters' } },
      }),
    });
    await waitFor(() => page.visible('section-name'), 'the name step');

    (page.$('input-first-name') as HTMLInputElement).value = 'bad';
    page.$('btn-save-first-name').click();
    await waitFor(() => (page.$('first-name-status').textContent || '').length > 0, 'an error message');

    expect(page.$('first-name-status').textContent).toBe('displayName must not contain control characters');
    expect(page.visible('section-name')).toBe(true);
    expect(page.visible('tabs-container')).toBe(false);
    expect((page.$('btn-save-first-name') as HTMLButtonElement).disabled).toBe(false);
  });

  it('is skipped for a user who already has a profile', async () => {
    const page = openPage({ routes: withProfile() });
    await waitFor(() => page.visible('tabs-container'), 'the app');

    expect(page.visible('section-name')).toBe(false);
    expect((page.$('input-name') as HTMLInputElement).value).toBe('Cami');
    expect((page.$('input-discoverable') as HTMLInputElement).checked).toBe(true);
    expect(page.calls.filter((c) => c.method === 'PUT')).toEqual([]);
  });

  it('does not mistake a failure loading the profile for a new user', async () => {
    const page = openPage({
      routes: routes({ 'GET /users/user-1/profile': { status: 500, json: { error: 'Internal server error' } } }),
    });
    await waitFor(() => page.alerts.length > 0, 'an alert');

    expect(page.alerts[0]).toContain('Internal server error');
    expect(page.visible('section-name')).toBe(false);
    expect(page.visible('tabs-container')).toBe(false);
    expect(page.visible('section-auth')).toBe(true);
    expect(page.calls.filter((c) => c.method === 'PUT')).toEqual([]);
  });
});

describe('web app: people are shown by name only', () => {
  const nearby = (page: ReturnType<typeof openPage>, ids: string[]) =>
    page.run(
      `nearbyFriends = ${JSON.stringify(
        Object.fromEntries(
          ids.map((id) => [id, { friendId: id, latitude: 20.65, longitude: -103.35, lastUpdated: '2026-10-18T12:00:00Z', distanceMiles: 0.5 }])
        )
      )};`
    );

  async function signedInPage(friends: () => unknown[]) {
    const page = openPage({ routes: withProfile({ 'GET /friends': () => ok(friends()) }) });
    await waitFor(() => page.visible('tabs-container'), 'the app');
    await settle();
    return page;
  }
  const friendsRequests = (page: ReturnType<typeof openPage>) =>
    page.calls.filter((c) => c.method === 'GET' && c.path === '/friends').length;

  it('lists a friend by name and leaves out one whose name is unknown, with no id or placeholder', async () => {
    const page = await signedInPage(() => [{ friendId: 'f1', displayName: 'Ana' }]);

    nearby(page, ['f1', UNKNOWN_ID]);
    page.run('namesLoadedAt = Date.now(); renderFriends();');

    const text = page.$('friends-list').textContent || '';
    expect(text).toContain('Ana');
    expect(text).not.toContain(UNKNOWN_ID);
    expect(text).not.toContain('e4686448');
    expect(text).not.toMatch(/unnamed|unknown/i);
    expect(page.document.querySelectorAll('#friends-list .friend-item').length).toBe(1);
  });

  it('does not reload the names again within 10 seconds', async () => {
    const page = await signedInPage(() => [{ friendId: 'f1', displayName: 'Ana' }]);
    const before = friendsRequests(page);

    nearby(page, ['f1', UNKNOWN_ID]);
    page.run('namesLoadedAt = Date.now(); renderFriends();');
    await settle();

    expect(friendsRequests(page)).toBe(before);
  });

  it('reloads the names by itself when a friend it does not know appears, and then lists them', async () => {
    let friends = [{ friendId: 'f1', displayName: 'Ana' }];
    const page = await signedInPage(() => friends);
    const before = friendsRequests(page);

    // this friend accepted a request after the page was opened
    friends = [...friends, { friendId: UNKNOWN_ID, displayName: 'Beto' }];
    nearby(page, ['f1', UNKNOWN_ID]);
    page.run('namesLoadedAt = 0; renderFriends();');
    await waitFor(() => /Beto/.test(page.$('friends-list').textContent || ''), 'the new name to appear');

    const text = page.$('friends-list').textContent || '';
    expect(friendsRequests(page)).toBe(before + 1);
    expect(text).toContain('Ana');
    expect(text).toContain('Beto');
    expect(text).not.toContain(UNKNOWN_ID);
    expect(page.document.querySelectorAll('#friends-list .friend-item').length).toBe(2);
  });

  it('does not keep reloading for a name that stays unknown', async () => {
    const page = await signedInPage(() => [{ friendId: 'f1', displayName: 'Ana' }]);
    const before = friendsRequests(page);

    nearby(page, ['f1', UNKNOWN_ID]);
    page.run('namesLoadedAt = 0; renderFriends();');
    await waitFor(() => friendsRequests(page) === before + 1, 'one reload');
    await settle();
    page.run('renderFriends(); renderFriends(); renderFriends();');
    await settle();

    expect(friendsRequests(page)).toBe(before + 1);
    expect(page.$('friends-list').textContent || '').not.toContain(UNKNOWN_ID);
    expect(page.document.querySelectorAll('#friends-list .friend-item').length).toBe(1);
  });

  describe('on the map', () => {
    // jsdom has no layout or canvas, so give the map a size and a stand-in that ignores drawing.
    function prepareMap(page: ReturnType<typeof openPage>) {
      const canvas = page.$('map-canvas') as HTMLCanvasElement;
      const stage = canvas.parentElement as HTMLElement;
      Object.defineProperty(stage, 'clientWidth', { value: 400, configurable: true });
      Object.defineProperty(stage, 'clientHeight', { value: 400, configurable: true });
      const context = new Proxy({} as Record<string, unknown>, {
        get: (target, prop: string) => (prop in target ? target[prop] : () => undefined),
        set: (target, prop: string, value) => {
          target[prop] = value;
          return true;
        },
      });
      (canvas as any).getContext = () => context;
      (page.$('input-lat') as HTMLInputElement).value = '20.65';
      (page.$('input-lng') as HTMLInputElement).value = '-103.35';
    }

    it('draws only the friends whose names are known', async () => {
      const page = await signedInPage(() => [{ friendId: 'f1', displayName: 'Ana' }]);
      prepareMap(page);

      nearby(page, ['f1', UNKNOWN_ID]);
      page.run('namesLoadedAt = Date.now(); renderMap();');

      expect(page.run('mapHits.map((hit) => hit.friendId)')).toEqual(['f1']);
    });

    it('shows a popup for a known friend, with their name', async () => {
      const page = await signedInPage(() => [{ friendId: 'f1', displayName: 'Ana' }]);

      page.run(`showMapPopup({ friendId: 'f1', x: 10, y: 10, dist: 0.5, lastUpdated: '2026-10-18T12:00:00Z' })`);

      expect(page.visible('map-popup')).toBe(true);
      expect(page.$('map-popup').textContent).toContain('Ana');
    });

    it('shows no popup for a friend whose name is unknown, and never their id', async () => {
      const page = await signedInPage(() => [{ friendId: 'f1', displayName: 'Ana' }]);

      page.run(`showMapPopup({ friendId: '${UNKNOWN_ID}', x: 10, y: 10, dist: 0.5, lastUpdated: null })`);

      expect(page.visible('map-popup')).toBe(false);
      expect(page.$('map-popup').textContent || '').not.toContain(UNKNOWN_ID);
    });
  });
});

describe('web app: friend requests', () => {
  it('shows each sender by name and never by id', async () => {
    const page = openPage({
      routes: withProfile({
        'GET /friend-requests': ok([{ requestId: 'r1', fromUserId: 'a1b2c3d4-uuid', fromDisplayName: 'Dana' }]),
      }),
    });
    await waitFor(() => page.visible('tabs-container'), 'the app');

    page.$('btn-refresh-requests').click();
    await waitFor(() => /Dana/.test(page.$('requests-list').textContent || ''), 'the requests');

    expect(page.$('requests-list').textContent).toContain('Dana');
    expect(page.$('requests-list').textContent).not.toContain('a1b2c3d4');
  });
});

describe('web app: the Profile tab', () => {
  async function profilePage(put: () => { status: number; json?: unknown }) {
    const page = openPage({ routes: withProfile({ 'PUT /users/user-1/profile': put }) });
    await waitFor(() => page.visible('tabs-container'), 'the app');
    return page;
  }

  it('refuses to save an empty name and sends nothing', async () => {
    const page = await profilePage(() => ok());

    (page.$('input-name') as HTMLInputElement).value = '   ';
    page.$('btn-save-profile').click();
    await settle();

    expect(page.$('profile-status').textContent).toBe('Your name cannot be empty.');
    expect(page.calls.filter((c) => c.method === 'PUT')).toEqual([]);
  });

  it('saves a valid name trimmed', async () => {
    const page = await profilePage(() => ok({ message: 'Profile updated' }));

    (page.$('input-name') as HTMLInputElement).value = ' Eli ';
    page.$('btn-save-profile').click();
    await waitFor(() => page.$('profile-status').textContent === 'Saved', 'the save to finish');

    expect(page.calls.some((c) => c.method === 'PUT' && c.body.displayName === 'Eli')).toBe(true);
  });

  it("shows the server's reason plainly, not the raw status and JSON", async () => {
    const page = await profilePage(() => ({
      status: 400,
      json: { error: 'displayName must be between 1 and 50 characters' },
    }));

    (page.$('input-name') as HTMLInputElement).value = 'x'.repeat(60);
    page.$('btn-save-profile').click();
    await waitFor(() => /between 1 and 50/.test(page.$('profile-status').textContent || ''), 'the error');

    expect(page.$('profile-status').textContent).toBe('displayName must be between 1 and 50 characters');
  });
});
