import * as fc from 'fast-check';
import { validateProfileUpdate, MAX_DISPLAY_NAME_LENGTH } from '../../src/utils/profile-validation';

const RUNS = { numRuns: 100 };

const ALLOWED_FIELDS = ['displayName', 'profilePictureKey', 'discoverable'];
const CONTROL = /[\u0000-\u001F\u007F]/;
const codePoints = (s: string) => Array.from(s).length;

// Characters that are never whitespace or control characters, so trimming cannot surprise us.
const nameChar = fc.constantFrom('a', 'Z', '7', 'é', '日', '😀', '-', '_', '.');
const nameOf = (min: number, max: number) =>
  fc.array(nameChar, { minLength: min, maxLength: max }).map((chars) => chars.join(''));

const userId = fc.uuid();
const fileName = fc
  .array(fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789-'.split('')), { minLength: 1, maxLength: 40 })
  .map((chars) => chars.join(''));

describe('Property: display name validation', () => {
  it('accepts every name of 1 to 50 characters and stores it trimmed', () => {
    fc.assert(
      fc.property(nameOf(1, MAX_DISPLAY_NAME_LENGTH), fc.constantFrom('', ' ', '\t', '\n', '  '), (name, pad) => {
        const result = validateProfileUpdate({ displayName: pad + name + pad }, 'u');
        return result.valid && result.fields.displayName === name;
      }),
      RUNS
    );
  });

  it('rejects every name longer than 50 characters', () => {
    fc.assert(
      fc.property(nameOf(MAX_DISPLAY_NAME_LENGTH + 1, 120), (name) => {
        return !validateProfileUpdate({ displayName: name }, 'u').valid;
      }),
      RUNS
    );
  });

  it('rejects any name containing a control character', () => {
    const control = fc.integer({ min: 0, max: 0x1f }).map((n) => String.fromCharCode(n));
    fc.assert(
      fc.property(nameOf(1, 10), control, nameOf(1, 10), (before, ctrl, after) => {
        return !validateProfileUpdate({ displayName: before + ctrl + after }, 'u').valid;
      }),
      RUNS
    );
  });

  it('a stored name is always trimmed, non-empty, short and control-free', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'binary', maxLength: 80 }), (name) => {
        const result = validateProfileUpdate({ displayName: name }, 'u');
        if (!result.valid) return true;
        const stored = result.fields.displayName as string;
        return (
          stored === stored.trim() &&
          codePoints(stored) >= 1 &&
          codePoints(stored) <= MAX_DISPLAY_NAME_LENGTH &&
          !CONTROL.test(stored)
        );
      }),
      RUNS
    );
  });
});

describe('Property: discoverable validation', () => {
  it('accepts exactly the booleans', () => {
    fc.assert(
      fc.property(fc.boolean(), (value) => {
        const result = validateProfileUpdate({ discoverable: value }, 'u');
        return result.valid && result.fields.discoverable === value;
      }),
      RUNS
    );
  });

  it('rejects every value that is not a boolean', () => {
    fc.assert(
      fc.property(
        // undefined is excluded: JSON cannot carry it, and it means "field not sent".
        fc.anything().filter((value) => typeof value !== 'boolean' && value !== undefined),
        (value) => !validateProfileUpdate({ discoverable: value }, 'u').valid
      ),
      RUNS
    );
  });
});

describe('Property: profile picture key validation', () => {
  it('accepts every plain file name under the caller\'s own prefix', () => {
    fc.assert(
      fc.property(userId, fileName, (id, file) => {
        const key = `profile-pictures/${id}/${file}.jpg`;
        const result = validateProfileUpdate({ profilePictureKey: key }, id);
        return result.valid && result.fields.profilePictureKey === key;
      }),
      RUNS
    );
  });

  it('rejects every key under another user\'s prefix', () => {
    fc.assert(
      fc.property(
        fc.tuple(userId, userId).filter(([a, b]) => a !== b),
        fileName,
        ([caller, other], file) => !validateProfileUpdate({ profilePictureKey: `profile-pictures/${other}/${file}.jpg` }, caller).valid
      ),
      RUNS
    );
  });

  it('rejects any key that escapes the caller\'s folder', () => {
    const escape = fc.constantFrom('../', '/', '../../', 'a/', './');
    fc.assert(
      fc.property(userId, escape, fileName, (id, esc, file) => {
        return !validateProfileUpdate({ profilePictureKey: `profile-pictures/${id}/${esc}${file}.jpg` }, id).valid;
      }),
      RUNS
    );
  });
});

describe('Property: validateProfileUpdate on arbitrary input', () => {
  it('never throws and always answers with a verdict', () => {
    fc.assert(
      fc.property(fc.anything(), fc.string(), (body, id) => {
        const result = validateProfileUpdate(body, id);
        return typeof result.valid === 'boolean' && (result.valid || typeof result.error === 'string');
      }),
      RUNS
    );
  });

  it('only ever returns the three editable fields', () => {
    fc.assert(
      fc.property(fc.object(), (body) => {
        const result = validateProfileUpdate({ ...body, displayName: 'Ana', discoverable: true }, 'u');
        return result.valid && Object.keys(result.fields).every((key) => ALLOWED_FIELDS.includes(key));
      }),
      RUNS
    );
  });
});
