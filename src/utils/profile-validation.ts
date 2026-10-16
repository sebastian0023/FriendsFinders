export const MAX_DISPLAY_NAME_LENGTH = 50;

export interface ProfileFields {
  displayName?: string;
  profilePictureKey?: string;
  discoverable?: boolean;
}

export type ProfileValidationResult =
  | { valid: true; fields: ProfileFields }
  | { valid: false; error: string };

const CONTROL_CHARACTERS = /[\u0000-\u001F\u007F]/;
// A plain file name as produced by generateUploadUrl: no folders and no leading dot.
const FILE_NAME = /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/;

function invalid(error: string): ProfileValidationResult {
  return { valid: false, error };
}

/**
 * Validates a profile update body and returns only the editable fields that were present.
 * Unknown fields are ignored, so clients cannot set the friend list, creation date, etc.
 */
export function validateProfileUpdate(body: unknown, userId: string): ProfileValidationResult {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return invalid('Request body must be a JSON object');
  }

  const input = body as Record<string, unknown>;
  const fields: ProfileFields = {};

  if (input.displayName !== undefined) {
    if (typeof input.displayName !== 'string') return invalid('displayName must be a string');

    const name = input.displayName.trim();
    const length = Array.from(name).length; // code points, so an emoji counts once
    if (length < 1 || length > MAX_DISPLAY_NAME_LENGTH) {
      return invalid(`displayName must be between 1 and ${MAX_DISPLAY_NAME_LENGTH} characters`);
    }
    if (CONTROL_CHARACTERS.test(name)) return invalid('displayName must not contain control characters');
    fields.displayName = name;
  }

  if (input.discoverable !== undefined) {
    // Strictly a boolean: the string "false" is truthy and would make the user discoverable.
    if (typeof input.discoverable !== 'boolean') return invalid('discoverable must be true or false');
    fields.discoverable = input.discoverable;
  }

  if (input.profilePictureKey !== undefined) {
    if (typeof input.profilePictureKey !== 'string') return invalid('profilePictureKey must be a string');

    const key = input.profilePictureKey;
    const prefix = `profile-pictures/${userId}/`;
    if (!key.startsWith(prefix) || !FILE_NAME.test(key.slice(prefix.length))) {
      return invalid('profilePictureKey must be an upload key for your own profile');
    }
    fields.profilePictureKey = key;
  }

  return { valid: true, fields };
}
