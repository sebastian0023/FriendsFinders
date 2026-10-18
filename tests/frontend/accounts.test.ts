import { openPage, closeAllPages, waitFor, settle, idToken, CognitoRoutes, Routes } from '../helpers/page';

// Creating an account, confirming it with an emailed code, and resetting a forgotten password all
// happen in the page itself. These tests open the real page against a fake Cognito and a fake API.

const ok = (json: unknown = {}) => ({ status: 200, json });
const fail = (type: string, message = 'Cognito says no') => ({ status: 400, json: { __type: type, message } });

const EMAIL = 'ana@example.com';
const PASSWORD = 'Sup3rsecret';

const signedIn = (name?: string) =>
  ok({
    AuthenticationResult: {
      IdToken: idToken({ sub: 'user-1', email: EMAIL, ...(name ? { name } : {}) }),
      AccessToken: 'access',
      RefreshToken: 'refresh',
    },
  });

const NO_PROFILE = { status: 404, json: { error: 'User not found' } };
const EXISTING_PROFILE = ok({ userId: 'user-1', displayName: 'Ana', discoverable: false });
const apiRoutes = (profile = EXISTING_PROFILE): Routes => ({
  'GET /users/user-1/profile': profile,
  'PUT /users/user-1/profile': ok({ message: 'Profile created' }),
  'GET /friends': ok([]),
});

type TestPage = ReturnType<typeof openPage>;

function fill(page: TestPage, values: Record<string, string>) {
  for (const [id, value] of Object.entries(values)) (page.$(id) as HTMLInputElement).value = value;
}
const text = (page: TestPage, id: string) => page.$(id).textContent || '';

async function openSignUp(cognito: CognitoRoutes = {}, routes: Routes = apiRoutes()) {
  const page = openPage({ claims: null, cognito, routes });
  await settle();
  page.$('btn-show-signup').click();
  return page;
}

const fillSignUp = (page: TestPage, overrides: Record<string, string> = {}) =>
  fill(page, {
    'signup-name': 'Ana',
    'signup-email': EMAIL,
    'signup-password': PASSWORD,
    'signup-confirm': PASSWORD,
    ...overrides,
  });

/** Signs up successfully and leaves the page on the "enter the code" step. */
async function atConfirmStep(cognito: CognitoRoutes = {}, routes: Routes = apiRoutes()) {
  const page = await openSignUp({ SignUp: ok({ UserConfirmed: false }), ...cognito }, routes);
  fillSignUp(page);
  page.$('btn-signup').click();
  await waitFor(() => page.visible('section-confirm'), 'the code step');
  return page;
}

async function atResetStep(cognito: CognitoRoutes = {}, routes: Routes = apiRoutes()) {
  const page = openPage({ claims: null, cognito: { ForgotPassword: ok({}), ...cognito }, routes });
  await settle();
  page.$('btn-show-forgot').click();
  fill(page, { 'forgot-email': EMAIL });
  page.$('btn-forgot').click();
  await waitFor(() => page.visible('section-reset'), 'the reset step');
  return page;
}

afterEach(() => {
  closeAllPages();
});

describe('web app: the sign-in card', () => {
  it('offers to create an account and to reset a password, next to signing in', async () => {
    const page = openPage({ claims: null });
    await settle();

    expect(page.visible('btn-login')).toBe(true);
    expect(page.visible('btn-show-signup')).toBe(true);
    expect(page.visible('btn-show-forgot')).toBe(true);
    expect(page.visible('section-signup')).toBe(false);
    expect(page.visible('section-forgot')).toBe(false);
  });

  it('opens the create-account form with every field, and goes back', async () => {
    const page = await openSignUp();

    expect(page.visible('section-signup')).toBe(true);
    expect(page.visible('section-auth')).toBe(false);
    for (const id of ['signup-name', 'signup-email', 'signup-password', 'signup-confirm']) {
      expect(page.$(id)).not.toBeNull();
    }
    expect((page.$('signup-password') as HTMLInputElement).type).toBe('password');
    expect((page.$('signup-confirm') as HTMLInputElement).type).toBe('password');

    page.$('btn-signup-back').click();
    expect(page.visible('section-auth')).toBe(true);
    expect(page.visible('section-signup')).toBe(false);
  });
});

describe('web app: creating an account', () => {
  it.each([
    ['no name', { 'signup-name': '   ' }, 'Please enter a name.'],
    ['a name that is too long', { 'signup-name': 'x'.repeat(51) }, 'Your name can have at most 50 characters.'],
    ['no email', { 'signup-email': '  ' }, 'Please enter your email.'],
    ['passwords that differ', { 'signup-confirm': 'Different1' }, 'The passwords do not match.'],
    ['a password that is too short', { 'signup-password': 'Ab1', 'signup-confirm': 'Ab1' }, 'password'],
    ['a password without a number', { 'signup-password': 'Abcdefghi', 'signup-confirm': 'Abcdefghi' }, 'password'],
    ['a password without a capital', { 'signup-password': 'abcdefgh1', 'signup-confirm': 'abcdefgh1' }, 'password'],
  ])('refuses %s and sends nothing', async (_kind, overrides, message) => {
    const page = await openSignUp();
    fillSignUp(page, overrides);
    page.$('btn-signup').click();
    await settle();

    expect(text(page, 'signup-status')).toContain(message);
    expect(page.cognitoCalls).toEqual([]);
    expect(page.visible('section-confirm')).toBe(false);
  });

  it('tells the password rule up front', async () => {
    const page = await openSignUp();
    expect(text(page, 'section-signup')).toMatch(/at least 8 characters/i);
  });

  it('sends the trimmed name and email to Cognito and then asks for the emailed code', async () => {
    const page = await openSignUp({ SignUp: ok({ UserConfirmed: false }) });
    fillSignUp(page, { 'signup-name': '  Ana  ', 'signup-email': `  ${EMAIL} ` });
    page.$('btn-signup').click();
    await waitFor(() => page.visible('section-confirm'), 'the code step');

    expect(page.cognitoCalls).toEqual([
      {
        action: 'SignUp',
        body: {
          ClientId: 'client',
          Username: EMAIL,
          Password: PASSWORD,
          UserAttributes: [
            { Name: 'email', Value: EMAIL },
            { Name: 'name', Value: 'Ana' },
          ],
        },
      },
    ]);
    expect(page.visible('section-signup')).toBe(false);
    expect(text(page, 'section-confirm')).toContain(EMAIL);
  });

  it.each([
    ['UsernameExistsException', 'An account with this email already exists. Sign in instead.'],
    ['InvalidPasswordException', 'Password did not conform with policy: needs a symbol'],
    ['InvalidParameterException', 'Invalid email address format.'],
    ['TooManyRequestsException', 'Too many attempts. Wait a moment and try again.'],
  ])('explains a %s in plain words and stays on the form', async (type, message) => {
    const page = await openSignUp({
      SignUp: fail(type, type === 'InvalidPasswordException' || type === 'InvalidParameterException' ? message : 'x'),
    });
    fillSignUp(page);
    page.$('btn-signup').click();
    await waitFor(() => text(page, 'signup-status') !== '', 'an error');

    expect(text(page, 'signup-status')).toBe(message);
    expect(page.visible('section-signup')).toBe(true);
    expect(page.visible('section-confirm')).toBe(false);
    expect((page.$('btn-signup') as HTMLButtonElement).disabled).toBe(false);
  });

  it('says so when Cognito cannot be reached', async () => {
    const page = await openSignUp();
    page.window.fetch = async () => {
      throw new TypeError('Failed to fetch');
    };
    fillSignUp(page);
    page.$('btn-signup').click();
    await waitFor(() => text(page, 'signup-status') !== '', 'an error');

    expect(text(page, 'signup-status')).toBe('Could not reach the sign-in service. Check your connection and try again.');
    expect((page.$('btn-signup') as HTMLButtonElement).disabled).toBe(false);
  });

  it('never leaves the password in the address bar or in storage', async () => {
    const page = await atConfirmStep();

    expect(page.window.location.href).not.toContain(PASSWORD);
    expect(JSON.stringify({ ...page.window.sessionStorage })).not.toContain(PASSWORD);
    expect(JSON.stringify({ ...page.window.localStorage })).not.toContain(PASSWORD);
  });
});

describe('web app: confirming the account', () => {
  it('refuses an empty code and sends nothing', async () => {
    const page = await atConfirmStep();
    fill(page, { 'confirm-code': '  ' });
    page.$('btn-confirm').click();
    await settle();

    expect(text(page, 'confirm-status')).toBe('Please enter the code from your email.');
    expect(page.cognitoCalls.map((c) => c.action)).toEqual(['SignUp']);
  });

  it('confirms with the code, signs in by itself and goes on to the name step with the name given', async () => {
    const page = await atConfirmStep(
      { ConfirmSignUp: ok({}), InitiateAuth: signedIn('Ana') },
      apiRoutes(NO_PROFILE),
    );
    fill(page, { 'confirm-code': ' 123456 ' });
    page.$('btn-confirm').click();
    await waitFor(() => page.visible('section-name'), 'the name step');

    expect(page.cognitoCalls.slice(1)).toEqual([
      { action: 'ConfirmSignUp', body: { ClientId: 'client', Username: EMAIL, ConfirmationCode: '123456' } },
      {
        action: 'InitiateAuth',
        body: {
          AuthFlow: 'USER_PASSWORD_AUTH',
          ClientId: 'client',
          AuthParameters: { USERNAME: EMAIL, PASSWORD },
        },
      },
    ]);
    expect((page.$('input-first-name') as HTMLInputElement).value).toBe('Ana');
    expect(page.visible('section-confirm')).toBe(false);
    expect(page.visible('section-auth')).toBe(false);

    const tokens = JSON.parse(page.window.sessionStorage.getItem('tokens'));
    expect(tokens.access_token).toBe('access');
    expect(tokens.id_token).toContain('.');
    expect(JSON.stringify({ ...page.window.sessionStorage })).not.toContain(PASSWORD);
    expect(page.run('pending.password')).toBe(''); // forgotten once signed in
  });

  it('goes straight to the app when the profile already exists', async () => {
    const page = await atConfirmStep({ ConfirmSignUp: ok({}), InitiateAuth: signedIn('Ana') });
    fill(page, { 'confirm-code': '123456' });
    page.$('btn-confirm').click();
    await waitFor(() => page.visible('tabs-container'), 'the app');

    expect(page.visible('section-name')).toBe(false);
  });

  it.each([
    ['CodeMismatchException', 'That code is not right. Check it and try again.'],
    ['ExpiredCodeException', 'That code has expired. Send a new one.'],
  ])('explains a %s, stays on the code step and does not sign in', async (type, message) => {
    const page = await atConfirmStep({ ConfirmSignUp: fail(type) });
    fill(page, { 'confirm-code': '000000' });
    page.$('btn-confirm').click();
    await waitFor(() => text(page, 'confirm-status') !== '', 'an error');

    expect(text(page, 'confirm-status')).toBe(message);
    expect(page.visible('section-confirm')).toBe(true);
    expect(page.cognitoCalls.map((c) => c.action)).toEqual(['SignUp', 'ConfirmSignUp']);
    expect(page.window.sessionStorage.getItem('tokens')).toBeNull();
  });

  it('sends a new code on request', async () => {
    const page = await atConfirmStep({ ResendConfirmationCode: ok({}) });
    page.$('btn-resend-confirm').click();
    await waitFor(() => text(page, 'confirm-status') !== '', 'a message');

    expect(page.cognitoCalls[1]).toEqual({
      action: 'ResendConfirmationCode',
      body: { ClientId: 'client', Username: EMAIL },
    });
    expect(text(page, 'confirm-status')).toBe(`A new code was sent to ${EMAIL}.`);
  });

  it('explains it when sending a new code fails', async () => {
    const page = await atConfirmStep({ ResendConfirmationCode: fail('LimitExceededException') });
    page.$('btn-resend-confirm').click();
    await waitFor(() => text(page, 'confirm-status') !== '', 'a message');

    expect(text(page, 'confirm-status')).toBe('Too many attempts. Wait a moment and try again.');
  });

  it('falls back to the sign-in card with a message if the automatic sign-in is refused', async () => {
    const page = await atConfirmStep({ ConfirmSignUp: ok({}), InitiateAuth: fail('NotAuthorizedException') });
    fill(page, { 'confirm-code': '123456' });
    page.$('btn-confirm').click();
    await waitFor(() => page.visible('section-auth'), 'the sign-in card');

    expect(text(page, 'signin-status')).toBe('Your account is confirmed. Please sign in.');
    expect(page.visible('section-confirm')).toBe(false);
    expect(page.window.sessionStorage.getItem('tokens')).toBeNull();
  });
});

describe('web app: forgotten password', () => {
  it('refuses an empty email and sends nothing', async () => {
    const page = openPage({ claims: null });
    await settle();
    page.$('btn-show-forgot').click();
    fill(page, { 'forgot-email': ' ' });
    page.$('btn-forgot').click();
    await settle();

    expect(text(page, 'forgot-status')).toBe('Please enter your email.');
    expect(page.cognitoCalls).toEqual([]);
  });

  it('asks Cognito to email a code and then shows the reset step', async () => {
    const page = await atResetStep();

    expect(page.cognitoCalls).toEqual([{ action: 'ForgotPassword', body: { ClientId: 'client', Username: EMAIL } }]);
    expect(page.visible('section-forgot')).toBe(false);
    expect(text(page, 'section-reset')).toContain(EMAIL);
  });

  it('explains it when there is no such account', async () => {
    const page = openPage({ claims: null, cognito: { ForgotPassword: fail('UserNotFoundException') } });
    await settle();
    page.$('btn-show-forgot').click();
    fill(page, { 'forgot-email': EMAIL });
    page.$('btn-forgot').click();
    await waitFor(() => text(page, 'forgot-status') !== '', 'an error');

    expect(text(page, 'forgot-status')).toBe('There is no account with that email.');
    expect(page.visible('section-reset')).toBe(false);
  });

  it('goes back to the sign-in card', async () => {
    const page = openPage({ claims: null });
    await settle();
    page.$('btn-show-forgot').click();
    page.$('btn-forgot-back').click();

    expect(page.visible('section-auth')).toBe(true);
    expect(page.visible('section-forgot')).toBe(false);
  });

  it.each([
    ['no code', { 'reset-code': '' }, 'Please enter the code from your email.'],
    ['passwords that differ', { 'reset-confirm': 'Different1' }, 'The passwords do not match.'],
    ['a weak password', { 'reset-password': 'abc', 'reset-confirm': 'abc' }, 'password'],
  ])('refuses %s and sends nothing more', async (_kind, overrides, message) => {
    const page = await atResetStep();
    fill(page, { 'reset-code': '123456', 'reset-password': PASSWORD, 'reset-confirm': PASSWORD, ...overrides });
    page.$('btn-reset').click();
    await settle();

    expect(text(page, 'reset-status')).toContain(message);
    expect(page.cognitoCalls.map((c) => c.action)).toEqual(['ForgotPassword']);
  });

  it('sets the new password with the code and signs in with it', async () => {
    const page = await atResetStep({ ConfirmForgotPassword: ok({}), InitiateAuth: signedIn('Ana') });
    fill(page, { 'reset-code': ' 654321 ', 'reset-password': 'N3wpassword', 'reset-confirm': 'N3wpassword' });
    page.$('btn-reset').click();
    await waitFor(() => page.visible('tabs-container'), 'the app');

    expect(page.cognitoCalls.slice(1)).toEqual([
      {
        action: 'ConfirmForgotPassword',
        body: { ClientId: 'client', Username: EMAIL, ConfirmationCode: '654321', Password: 'N3wpassword' },
      },
      {
        action: 'InitiateAuth',
        body: {
          AuthFlow: 'USER_PASSWORD_AUTH',
          ClientId: 'client',
          AuthParameters: { USERNAME: EMAIL, PASSWORD: 'N3wpassword' },
        },
      },
    ]);
    expect(page.visible('section-reset')).toBe(false);
    expect(JSON.stringify({ ...page.window.sessionStorage })).not.toContain('N3wpassword');
  });

  it.each([
    ['CodeMismatchException', 'That code is not right. Check it and try again.'],
    ['ExpiredCodeException', 'That code has expired. Send a new one.'],
  ])('explains a %s and stays on the reset step', async (type, message) => {
    const page = await atResetStep({ ConfirmForgotPassword: fail(type) });
    fill(page, { 'reset-code': '000000', 'reset-password': PASSWORD, 'reset-confirm': PASSWORD });
    page.$('btn-reset').click();
    await waitFor(() => text(page, 'reset-status') !== '', 'an error');

    expect(text(page, 'reset-status')).toBe(message);
    expect(page.visible('section-reset')).toBe(true);
    expect(page.window.sessionStorage.getItem('tokens')).toBeNull();
  });

  it('sends a new code on request', async () => {
    const page = await atResetStep();
    page.$('btn-resend-reset').click();
    await waitFor(() => page.cognitoCalls.length === 2, 'a second request');
    await settle();

    expect(page.cognitoCalls[1]).toEqual({ action: 'ForgotPassword', body: { ClientId: 'client', Username: EMAIL } });
    expect(text(page, 'reset-status')).toBe(`A new code was sent to ${EMAIL}.`);
  });
});
