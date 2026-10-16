import { validateProfileUpdate, MAX_DISPLAY_NAME_LENGTH } from '../../src/utils/profile-validation';

const USER = 'user-1';
const OWN_KEY = `profile-pictures/${USER}/0b9c5a52-7d2f-4a43-9b53-1f6d6a1e2c11.jpg`;

const validate = (body: unknown, userId = USER) => validateProfileUpdate(body, userId);
const fieldsOf = (body: unknown, userId = USER) => {
  const result = validate(body, userId);
  if (!result.valid) throw new Error(`expected valid, got: ${result.error}`);
  return result.fields;
};
const errorOf = (body: unknown, userId = USER) => {
  const result = validate(body, userId);
  if (result.valid) throw new Error('expected invalid');
  return result.error;
};

describe('validateProfileUpdate: body', () => {
  it('accepts an empty object and returns no fields', () => {
    expect(validate({})).toEqual({ valid: true, fields: {} });
  });

  it.each([null, undefined, 'text', 42, true, [], [{ displayName: 'x' }]])(
    'rejects a body that is not a JSON object (%p)',
    (body) => {
      expect(errorOf(body)).toBe('Request body must be a JSON object');
    }
  );

  it('ignores fields a client must not set', () => {
    const fields = fieldsOf({
      displayName: 'Ana',
      userId: 'user-99',
      createdAt: '1999-01-01T00:00:00.000Z',
      friendIds: ['user-5'],
      friendshipDates: { 'user-5': '1999-01-01T00:00:00.000Z' },
      isAdmin: true,
    });

    expect(fields).toEqual({ displayName: 'Ana' });
  });

  it('returns only the fields that were present', () => {
    expect(Object.keys(fieldsOf({ discoverable: false }))).toEqual(['discoverable']);
    expect(Object.keys(fieldsOf({ displayName: 'A', discoverable: true })).sort()).toEqual([
      'discoverable',
      'displayName',
    ]);
  });

  it('reports the first problem when several fields are invalid', () => {
    expect(errorOf({ displayName: '', discoverable: 'x', profilePictureKey: 7 })).toMatch(/^displayName/);
    expect(errorOf({ displayName: 'ok', discoverable: 'x', profilePictureKey: 7 })).toMatch(/^discoverable/);
  });
});

describe('validateProfileUpdate: displayName', () => {
  it('accepts an ordinary name', () => {
    expect(fieldsOf({ displayName: 'Ana García' })).toEqual({ displayName: 'Ana García' });
  });

  it('trims surrounding whitespace, including newlines', () => {
    expect(fieldsOf({ displayName: '  Ana  ' }).displayName).toBe('Ana');
    expect(fieldsOf({ displayName: '\tAna\n' }).displayName).toBe('Ana');
  });

  it('accepts exactly the maximum length and rejects one more', () => {
    expect(MAX_DISPLAY_NAME_LENGTH).toBe(50);
    expect(validate({ displayName: 'a'.repeat(50) }).valid).toBe(true);
    expect(errorOf({ displayName: 'a'.repeat(51) })).toBe('displayName must be between 1 and 50 characters');
  });

  it('counts characters, not UTF-16 units (emoji count once)', () => {
    expect(validate({ displayName: '😀'.repeat(50) }).valid).toBe(true);
    expect(validate({ displayName: '😀'.repeat(51) }).valid).toBe(false);
  });

  it('measures the length after trimming', () => {
    expect(validate({ displayName: `  ${'a'.repeat(50)}  ` }).valid).toBe(true);
  });

  it.each(['', ' ', '   ', '\n\t'])('rejects an empty or blank name (%p)', (displayName) => {
    expect(errorOf({ displayName })).toBe('displayName must be between 1 and 50 characters');
  });

  it.each([42, null, true, {}, [], ['Ana']])('rejects a name that is not a string (%p)', (displayName) => {
    expect(errorOf({ displayName })).toBe('displayName must be a string');
  });

  it.each(['a\nb', 'a\u0000b', 'a\tb', 'a\u001Fb', 'a\u007Fb', '\u0007bell'])(
    'rejects control characters inside the name (%p)',
    (displayName) => {
      expect(errorOf({ displayName })).toBe('displayName must not contain control characters');
    }
  );
});

describe('validateProfileUpdate: discoverable', () => {
  it.each([true, false])('accepts %p and keeps it, including false', (discoverable) => {
    expect(fieldsOf({ discoverable })).toEqual({ discoverable });
  });

  // The string "false" is truthy; storing it would make the user visible to strangers.
  it.each(['true', 'false', 'yes', 0, 1, null, [], {}, 'False'])(
    'rejects anything that is not exactly true or false (%p)',
    (discoverable) => {
      expect(errorOf({ discoverable })).toBe('discoverable must be true or false');
    }
  );
});

describe('validateProfileUpdate: profilePictureKey', () => {
  it('accepts a key under the caller\'s own prefix', () => {
    expect(fieldsOf({ profilePictureKey: OWN_KEY })).toEqual({ profilePictureKey: OWN_KEY });
  });

  it.each(['a.jpg', 'x_y-z.1.jpg', 'A1'])('accepts the plain file name %p', (file) => {
    expect(validate({ profilePictureKey: `profile-pictures/${USER}/${file}` }).valid).toBe(true);
  });

  it.each([42, null, true, {}, []])('rejects a key that is not a string (%p)', (profilePictureKey) => {
    expect(errorOf({ profilePictureKey })).toBe('profilePictureKey must be a string');
  });

  const NOT_OWN = 'profilePictureKey must be an upload key for your own profile';

  it.each([
    ['empty', ''],
    ['no prefix', 'a.jpg'],
    ['another user', 'profile-pictures/user-2/their.jpg'],
    ['a user whose id starts with the caller\'s', 'profile-pictures/user-10/x.jpg'],
    ['a different folder', 'avatars/user-1/x.jpg'],
    ['just the prefix', `profile-pictures/${USER}/`],
    ['a nested path', `profile-pictures/${USER}/a/b.jpg`],
    ['path traversal', `profile-pictures/${USER}/../user-2/x.jpg`],
    ['a dot-dot file name', `profile-pictures/${USER}/..`],
    ['a hidden file', `profile-pictures/${USER}/.secret`],
    ['a space in the file name', `profile-pictures/${USER}/a b.jpg`],
    ['a leading slash', `/profile-pictures/${USER}/x.jpg`],
  ])('rejects a key that is not the caller\'s own: %s', (_name, profilePictureKey) => {
    expect(errorOf({ profilePictureKey })).toBe(NOT_OWN);
  });

  it('treats the caller id literally, not as a pattern', () => {
    expect(validate({ profilePictureKey: 'profile-pictures/aXb/x.jpg' }, 'a.b').valid).toBe(false);
    expect(validate({ profilePictureKey: 'profile-pictures/a.b/x.jpg' }, 'a.b').valid).toBe(true);
  });
});
