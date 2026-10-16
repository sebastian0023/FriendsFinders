import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { v4 as uuidv4 } from 'uuid';

const s3Client = new S3Client({});
const BUCKET_NAME = process.env.S3_BUCKET_NAME || '';
const PICTURE_CONTENT_TYPE = 'image/jpeg';

export async function generateUploadUrl(userId: string): Promise<{ uploadUrl: string; s3Key: string }> {
  const s3Key = `profile-pictures/${userId}/${uuidv4()}.jpg`;
  const command = new PutObjectCommand({
    Bucket: BUCKET_NAME,
    Key: s3Key,
    ContentType: PICTURE_CONTENT_TYPE,
  });
  // The presigner leaves content-type out of the signature unless told otherwise. Signing it
  // makes S3 reject an upload whose Content-Type header is not exactly image/jpeg.
  const uploadUrl = await getSignedUrl(s3Client, command, {
    expiresIn: 300,
    signableHeaders: new Set(['content-type']),
  });
  return { uploadUrl, s3Key };
}

export async function generateDownloadUrl(s3Key: string): Promise<string> {
  const command = new GetObjectCommand({
    Bucket: BUCKET_NAME,
    Key: s3Key,
    // Serve the object as an image whatever Content-Type it was stored with.
    ResponseContentType: PICTURE_CONTENT_TYPE,
  });
  return getSignedUrl(s3Client, command, { expiresIn: 3600 });
}
