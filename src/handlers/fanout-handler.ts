import { DynamoDBBatchResponse, DynamoDBRecord, DynamoDBStreamEvent } from 'aws-lambda';
import { getFriends, getConnectionsByUserId } from '../utils/dynamo-client';
import { postToConnection } from '../utils/apigw-client';
import { getConfig } from '../utils/config';
import { haversine } from '../utils/distance';
import { buildLocationPush } from '../utils/message-utils';

type AppConfig = Awaited<ReturnType<typeof getConfig>>;

/**
 * Failures are reported per record (ReportBatchItemFailures) so Lambda retries only the
 * records that failed, instead of re-running the whole batch and re-sending pushes.
 */
export async function handler(event: DynamoDBStreamEvent): Promise<DynamoDBBatchResponse> {
  const config = await getConfig();
  const currentTime = Math.floor(Date.now() / 1000);
  const batchItemFailures: DynamoDBBatchResponse['batchItemFailures'] = [];

  for (const record of event.Records) {
    try {
      await processRecord(record, config, currentTime);
    } catch (err: unknown) {
      const sequenceNumber = record.dynamodb?.SequenceNumber;
      // A failure can only be reported by sequence number; without one, fail the whole
      // invocation so Lambda retries the batch rather than silently dropping the record.
      if (!sequenceNumber) throw err;
      console.error(`Failed to process stream record ${sequenceNumber}:`, err);
      batchItemFailures.push({ itemIdentifier: sequenceNumber });
    }
  }

  return { batchItemFailures };
}

async function processRecord(record: DynamoDBRecord, config: AppConfig, currentTime: number): Promise<void> {
  if (record.eventName !== 'MODIFY') return;

  const newImage = record.dynamodb?.NewImage;
  const oldImage = record.dynamodb?.OldImage;
  if (!newImage) return;

  // Check if location data exists in new image
  const newLat = newImage.latitude?.N;
  const newLng = newImage.longitude?.N;
  if (!newLat || !newLng) return;

  // Check if location actually changed
  const oldLat = oldImage?.latitude?.N;
  const oldLng = oldImage?.longitude?.N;
  if (oldLat === newLat && oldLng === newLng) return;

  const userId = newImage.userId?.S;
  const timestamp = newImage.timestamp?.S;
  if (!userId || !timestamp) return;

  const latitude = parseFloat(newLat);
  const longitude = parseFloat(newLng);

  // Get user's friends
  const friends = await getFriends(userId);

  for (const friend of friends) {
    // Get friend's active connections
    const friendConnections = await getConnectionsByUserId(friend.friendId);

    for (const conn of friendConnections) {
      if (conn.expiresAt <= currentTime) continue;

      let distanceMiles: number;
      if (conn.latitude === undefined || conn.longitude === undefined) {
        // Subscriber has not sent a location yet — still notify so they see the friend after accepting, etc.
        distanceMiles = 0;
      } else {
        distanceMiles = haversine(latitude, longitude, conn.latitude, conn.longitude);
        if (distanceMiles > config.searchRadiusMiles) continue;
      }

      const message = buildLocationPush(userId, latitude, longitude, timestamp, distanceMiles);
      try {
        await postToConnection(conn.connectionId, message);
      } catch (err: unknown) {
        const error = err as { name?: string; statusCode?: number };
        if (error.name === 'GoneException' || error.statusCode === 410) {
          console.log(`Connection ${conn.connectionId} is gone, skipping`);
        } else {
          console.error(`Failed to post to connection ${conn.connectionId}:`, err);
        }
      }
    }
  }
}
