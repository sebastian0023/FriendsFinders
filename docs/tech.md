# Tech Stack

## Runtime & Language

- Node.js with TypeScript (strict mode, ESNext target, CommonJS modules for Lambda compatibility)
- Latest Node.js runtime available on AWS Lambda
- Single `tsconfig.json` at repo root

## AWS Services

- API Gateway v2 (WebSocket API) — persistent bidirectional connections for real-time location updates
- API Gateway v2 (HTTP API) — stateless REST endpoints for friend management and user profiles
- AWS Lambda — one function per handler (12 total), all deployed inside VPC
- Amazon DynamoDB (on-demand billing) — five tables: Users, Friendships, Connections, Location History, FriendRequests
- Amazon ElastiCache for Redis (cluster mode enabled, Multi-AZ) — Location Cache + Pub/Sub
- Amazon S3 — profile picture storage with server-side encryption
- AWS SSM Parameter Store — configurable runtime parameters
- CloudWatch — log groups and alarms per Lambda

## AWS SDK

- `@aws-sdk/client-dynamodb`
- `@aws-sdk/lib-dynamodb`
- `@aws-sdk/client-apigatewaymanagementapi`
- `@aws-sdk/client-s3`
- `@aws-sdk/s3-request-presigner`

## Infrastructure

- Terraform only (no CDK, SAM, or Serverless Framework)
- All resources managed declaratively
- Modules: api-gateway, lambda, elasticache, dynamodb, vpc, iam, ssm, s3, monitoring

## Testing

- Jest with ts-jest preset
- fast-check for property-based testing (minimum 100 iterations per property test)

## Key Constants (all configurable via SSM)

- Search radius: 5 miles (default)
- Inactivity TTL: 600 seconds (10 minutes)
- Location update interval: 30 seconds
- Max friends: 5,000 (default)
- Nearby strangers result cap: 50 (default)
- Earth radius: 3958.8 miles (for Haversine)

## SSM Parameters

- `/nearby-friends/search-radius-miles` (default: 5)
- `/nearby-friends/inactivity-ttl-seconds` (default: 600)
- `/nearby-friends/location-update-interval-seconds` (default: 30)
- `/nearby-friends/max-friends` (default: 5000)
- `/nearby-friends/nearby-strangers-limit` (default: 50)

## Common Commands

```bash
# Install dependencies
npm install

# Run all tests
npx jest

# Run unit tests only
npx jest tests/unit

# Run property tests only
npx jest tests/property

# TypeScript compilation check
npx tsc --noEmit

# Terraform
cd terraform && terraform init
cd terraform && terraform plan
cd terraform && terraform apply
```
