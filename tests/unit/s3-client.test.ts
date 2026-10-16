export {}; // make this file a module so its top-level names stay local

// s3-client.ts builds its S3 client and reads the bucket name when the module is loaded, so each
// test loads a fresh copy inside jest.isolateModules.
//
// The presigner works out signatures locally and never calls S3, so these tests run the real
// thing with made-up credentials and inspect the URLs it produces. No network is involved.

const savedEnv = { ...process.env };

const FAKE_AWS = {
  AWS_REGION: 'us-east-1',
  AWS_ACCESS_KEY_ID: 'AKIAFAKEFAKEFAKEFAKE',
  AWS_SECRET_ACCESS_KEY: 'fakeSecretKeyFakeSecretKeyFakeSecretKey00',
};

function loadS3(env: Record<string, string | undefined> = { S3_BUCKET_NAME: 'test-bucket' }) {
  process.env = { ...savedEnv, ...FAKE_AWS };
  delete process.env.AWS_SESSION_TOKEN;
  delete process.env.AWS_PROFILE;
  delete process.env.S3_BUCKET_NAME;
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }

  let s3!: typeof import('../../src/utils/s3-client');
  jest.isolateModules(() => {
    s3 = require('../../src/utils/s3-client');
  });
  return s3;
}

afterEach(() => {
  process.env = { ...savedEnv };
});

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

describe('s3-client: generateUploadUrl', () => {
  it('returns a key under the user\'s own profile-pictures folder', async () => {
    const { generateUploadUrl } = loadS3();

    const { s3Key } = await generateUploadUrl('user-1');

    expect(s3Key).toMatch(new RegExp(`^profile-pictures/user-1/${UUID}\\.jpg$`));
  });

  it('returns a different key on every call', async () => {
    const { generateUploadUrl } = loadS3();

    const keys = await Promise.all([1, 2, 3, 4, 5].map(() => generateUploadUrl('user-1')));

    expect(new Set(keys.map((k) => k.s3Key)).size).toBe(5);
  });

  it('keeps different users in different folders', async () => {
    const { generateUploadUrl } = loadS3();

    const a = await generateUploadUrl('user-a');
    const b = await generateUploadUrl('user-b');

    expect(a.s3Key.startsWith('profile-pictures/user-a/')).toBe(true);
    expect(b.s3Key.startsWith('profile-pictures/user-b/')).toBe(true);
  });

  it('returns a presigned URL for that exact key in the configured bucket', async () => {
    const { generateUploadUrl } = loadS3({ S3_BUCKET_NAME: 'my-pictures' });

    const { uploadUrl, s3Key } = await generateUploadUrl('user-1');
    const url = new URL(uploadUrl);

    expect(url.protocol).toBe('https:');
    expect(url.hostname).toBe('my-pictures.s3.us-east-1.amazonaws.com');
    expect(decodeURIComponent(url.pathname)).toBe(`/${s3Key}`);
  });

  it('expires after 5 minutes', async () => {
    const { generateUploadUrl } = loadS3();

    const { uploadUrl } = await generateUploadUrl('user-1');

    expect(new URL(uploadUrl).searchParams.get('X-Amz-Expires')).toBe('300');
  });

  it('is a SigV4-signed PutObject URL', async () => {
    const { generateUploadUrl } = loadS3();

    const { uploadUrl } = await generateUploadUrl('user-1');
    const params = new URL(uploadUrl).searchParams;

    expect(params.get('X-Amz-Algorithm')).toBe('AWS4-HMAC-SHA256');
    expect(params.get('X-Amz-Signature')).toMatch(/^[0-9a-f]{64}$/);
    expect(params.get('X-Amz-Credential')).toContain('AKIAFAKEFAKEFAKEFAKE/');
    expect(params.get('x-id')).toBe('PutObject');
  });

  // The S3 presigner leaves content-type out of the signature by default, which would let a
  // client upload any type through a URL meant for a JPEG. Signing it makes S3 reject a PUT
  // whose Content-Type header is not exactly image/jpeg.
  it('signs the content type, so S3 rejects an upload that is not image/jpeg', async () => {
    const { generateUploadUrl } = loadS3();

    const { uploadUrl } = await generateUploadUrl('user-1');
    const params = new URL(uploadUrl).searchParams;

    expect(params.get('X-Amz-SignedHeaders')).toBe('content-type;host');
  });

  it('keeps the content type as a header the client must send, not a query parameter', async () => {
    const { generateUploadUrl } = loadS3();

    const { uploadUrl } = await generateUploadUrl('user-1');
    const names = [...new URL(uploadUrl).searchParams.keys()].map((name) => name.toLowerCase());

    expect(names).not.toContain('content-type');
  });

  it('fails loudly when no bucket is configured', async () => {
    const { generateUploadUrl } = loadS3({ S3_BUCKET_NAME: undefined });

    await expect(generateUploadUrl('user-1')).rejects.toThrow();
  });
});

describe('s3-client: generateDownloadUrl', () => {
  it('returns a presigned GET URL for the key in the configured bucket', async () => {
    const { generateDownloadUrl } = loadS3({ S3_BUCKET_NAME: 'my-pictures' });

    const downloadUrl = await generateDownloadUrl('profile-pictures/user-1/photo.jpg');
    const url = new URL(downloadUrl);

    expect(url.hostname).toBe('my-pictures.s3.us-east-1.amazonaws.com');
    expect(url.pathname).toBe('/profile-pictures/user-1/photo.jpg');
    expect(url.searchParams.get('x-id')).toBe('GetObject');
  });

  // Defence in depth: whatever Content-Type an object was stored with (including objects
  // uploaded before the upload URL signed it), S3 serves it as an image, never as HTML.
  it('forces the response content type to image/jpeg', async () => {
    const { generateDownloadUrl } = loadS3();

    const downloadUrl = await generateDownloadUrl('profile-pictures/user-1/photo.jpg');

    expect(new URL(downloadUrl).searchParams.get('response-content-type')).toBe('image/jpeg');
  });

  it('expires after 1 hour', async () => {
    const { generateDownloadUrl } = loadS3();

    const downloadUrl = await generateDownloadUrl('profile-pictures/user-1/photo.jpg');

    expect(new URL(downloadUrl).searchParams.get('X-Amz-Expires')).toBe('3600');
  });

  it('is signed with the caller credentials (SigV4)', async () => {
    const { generateDownloadUrl } = loadS3();

    const params = new URL(await generateDownloadUrl('profile-pictures/user-1/photo.jpg')).searchParams;

    expect(params.get('X-Amz-Algorithm')).toBe('AWS4-HMAC-SHA256');
    expect(params.get('X-Amz-Signature')).toMatch(/^[0-9a-f]{64}$/);
    expect(params.get('X-Amz-Credential')).toContain('AKIAFAKEFAKEFAKEFAKE/');
  });

  it('encodes unusual characters in the key', async () => {
    const { generateDownloadUrl } = loadS3();

    const url = new URL(await generateDownloadUrl('profile-pictures/user-1/my photo (1).jpg'));

    expect(url.pathname).not.toContain(' ');
    expect(decodeURIComponent(url.pathname)).toBe('/profile-pictures/user-1/my photo (1).jpg');
  });

  it('produces a different signature for a different key', async () => {
    const { generateDownloadUrl } = loadS3();

    const a = new URL(await generateDownloadUrl('profile-pictures/user-1/a.jpg')).searchParams.get('X-Amz-Signature');
    const b = new URL(await generateDownloadUrl('profile-pictures/user-1/b.jpg')).searchParams.get('X-Amz-Signature');

    expect(a).not.toBe(b);
  });

  it('fails loudly when no bucket is configured', async () => {
    const { generateDownloadUrl } = loadS3({ S3_BUCKET_NAME: undefined });

    await expect(generateDownloadUrl('profile-pictures/user-1/photo.jpg')).rejects.toThrow();
  });
});

describe('s3-client: the key format matches what profile updates accept', () => {
  // PUT /users/{id}/profile only accepts keys of the form profile-pictures/<id>/<file name>
  // (see profile-validation.ts), so a key issued here must always pass that check.
  it('issues keys that validateProfileUpdate accepts for the same user', async () => {
    const { generateUploadUrl } = loadS3();
    const { validateProfileUpdate } = require('../../src/utils/profile-validation');

    const { s3Key } = await generateUploadUrl('c9b1c1e4-7a0e-4a63-8f63-0f2d6f5d2a10');

    expect(
      validateProfileUpdate({ profilePictureKey: s3Key }, 'c9b1c1e4-7a0e-4a63-8f63-0f2d6f5d2a10').valid
    ).toBe(true);
  });
});
