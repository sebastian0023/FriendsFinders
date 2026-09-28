# Project Structure

```
/
├── terraform/
│   ├── main.tf
│   ├── variables.tf
│   ├── outputs.tf
│   └── modules/
│       ├── api-gateway/       # WebSocket API + HTTP API routes
│       ├── lambda/            # One Lambda per handler, VPC-deployed, least-privilege IAM
│       ├── elasticache/       # Redis cluster mode, Multi-AZ, subnet/security groups
│       ├── dynamodb/          # Five tables with keys, GSIs, TTL
│       ├── vpc/               # Private subnets (Lambda + ElastiCache), NAT gateway
│       ├── iam/               # Lambda execution roles and policies
│       ├── ssm/               # Runtime configuration parameters
│       ├── s3/                # Profile pictures bucket with server-side encryption
│       └── monitoring/        # CloudWatch log groups and alarms
├── src/
│   ├── handlers/
│   │   ├── websocket-connect.ts          # $connect — seeds nearby friends, subscribes channels
│   │   ├── websocket-disconnect.ts       # $disconnect — cleans up connection state
│   │   ├── websocket-location-update.ts  # location.update — persists, caches, publishes
│   │   ├── websocket-subscribe-friend.ts # friend.subscribe — subscribes to Redis channel
│   │   ├── websocket-unsubscribe-friend.ts # friend.unsubscribe — unsubscribes from channel
│   │   ├── pubsub-fanout.ts              # Redis pub/sub → Haversine → push to subscribers
│   │   ├── rest-friend-add.ts            # POST /friends/{friendId}
│   │   ├── rest-friend-remove.ts         # DELETE /friends/{friendId}
│   │   ├── rest-user-profile.ts          # GET/PUT /users/{userId}/profile
│   │   ├── rest-nearby-strangers.ts      # GET /nearby-strangers
│   │   ├── rest-friend-request.ts        # POST/GET/PUT friend requests
│   │   └── rest-profile-picture-upload.ts # GET pre-signed S3 upload URL
│   ├── utils/
│   │   ├── distance.ts        # Haversine formula (great-circle distance)
│   │   ├── redis-client.ts    # ElastiCache Redis singleton
│   │   ├── dynamo-client.ts   # DynamoDB DocumentClient singleton
│   │   ├── apigw-client.ts    # API Gateway Management API client
│   │   └── s3-client.ts       # S3 client + pre-signed URL helpers
│   └── types/
│       └── index.ts           # All shared TypeScript interfaces
├── tests/
│   ├── unit/                  # Jest unit tests (mocked AWS services)
│   └── property/              # fast-check property-based tests
├── package.json
├── tsconfig.json
└── README.md
```

## TypeScript Data Models (src/types/index.ts)

- `LocationUpdate` — userId, latitude, longitude, timestamp
- `LocationCacheEntry` — extends LocationUpdate
- `LocationHistoryRecord` — extends LocationUpdate
- `UserProfile` — userId, displayName, profilePictureKey, discoverable, createdAt
- `Friendship` — userId, friendId, createdAt
- `FriendRequest` — requestId, fromUserId, toUserId, status, createdAt
- `WebSocketConnection` — connectionId, userId, connectedAt
- `NearbyFriendEntry` — friendId, latitude, longitude, lastUpdated, distanceMiles
- `NearbyStrangerEntry` — userId, displayName, profilePictureUrl, distanceMiles

## DynamoDB Tables

| Table | PK | SK | GSI | TTL |
|---|---|---|---|---|
| Users | userId | — | — | — |
| Friendships | userId | friendId | friendId (reverse lookup) | — |
| Connections | connectionId | — | userId | — |
| Location History | userId | timestamp | — | — |
| FriendRequests | requestId | — | toUserId (incoming lookup), fromUserId (outgoing lookup) | — |

## Conventions

- Each Lambda handler is a separate file in `src/handlers/`
- Pure functions (Haversine, validation) live in `src/utils/`
- All DynamoDB and Redis interactions are abstracted into utility/client modules
- Property tests reference their design property with a tag comment: `Feature: nearby-friends, Property {number}: {text}`
- All DynamoDB and Redis interactions are mocked in tests
- Lambda environment variables are wired from SSM Parameter Store
- Each Lambda has its own IAM role with least-privilege policies
