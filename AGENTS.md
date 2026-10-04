# Nearby Friends (FriendsFinders) — Project Rules & Guidelines

## 📍 Overview

Nearby Friends is an academic-purpose serverless real-time location sharing backend and web frontend built on AWS with TypeScript and Terraform. Opted-in users share their GPS coordinates and discover friends (and strangers) within a configurable radius.

---

## 🏗️ Architecture & Core Design Decisions

1. **3 Consolidated Lambda Functions**:
   - `websocket-handler`: Manages `$connect`, `$disconnect`, `location.update`, and `friends.refresh`. Verifies Cognito JWT via JWKS in-handler.
   - `rest-handler`: Manages REST routes (`/friends`, `/nearby-friends`, `/nearby-strangers`, `/friend-requests`, `/users/{userId}/profile`, `/users/{userId}/profile-picture-upload-url`). Protected by API Gateway Cognito JWT authorizer.
   - `fanout-handler`: Triggered by DynamoDB Streams on the `Connections` table on location updates; calculates distances via Haversine and pushes WebSocket updates to connected friends.

2. **Cost-Optimized Architecture (No VPC, No Redis)**:
   - **No VPC / No NAT Gateway**: All AWS services are accessed via public HTTPS endpoints with IAM authentication.
   - **No ElastiCache Redis**: DynamoDB `Connections` table with embedded location coordinates and TTL replaces Redis cache.
   - **DynamoDB TTL**: Automatic inactivity cleanup (default: 10 minutes / 600s).

3. **Database Schema (Amazon DynamoDB)**:
   - `Users`: PK `userId` (Cognito `sub` UUID). Also stores `friendIds` (string set) and `friendshipDates` (map of friendId → createdAt).
   - `Connections`: PK `connectionId`, GSI `userId-index`, attributes `latitude`, `longitude`, `timestamp`, `expiresAt` (TTL), Streams enabled (`NEW_AND_OLD_IMAGES`).
   - `FriendRequests`: PK `requestId`, GSIs on `toUserId` and `fromUserId`.
   > **No separate `Friendships` table**: friend data is embedded in the `Users` item (single `GetItem` lookup).

4. **Frontend**:
   - Single-file vanilla HTML/CSS/JavaScript in `frontend/index.html` (no build step, no framework).
   - Tile-free radar map rendered via HTML5 `<canvas>` (plots friends by distance and bearing).
   - Deployed directly to S3 and served via CloudFront.

5. **Infrastructure as Code**:
   - Terraform only (`terraform/` directory with modular structure).
   - Remote state via S3 bucket + DynamoDB lock table.
   - CI/CD via GitHub Actions (`.github/workflows/deploy.yml`) using AWS OIDC role assumption.

---

## 💻 Tech Stack & Coding Conventions

- **Language & Runtime**: Node.js 20+ / 24+ LTS, TypeScript (strict mode, CommonJS for Lambda packaging, ESNext target).
- **AWS SDK**: AWS SDK v3 modular (`@aws-sdk/client-dynamodb`, `@aws-sdk/lib-dynamodb`, `@aws-sdk/client-apigatewaymanagementapi`, `@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner`, `@aws-sdk/client-ssm`).
- **Bundler**: `esbuild` via `scripts/build.js` packaging into `dist/*.zip`.
- **Testing**:
  - Unit tests: `jest` with `ts-jest`.
  - Property-based tests: `fast-check` (minimum 100 iterations per property test).
- **Runtime Parameters (AWS SSM)**:
  - Search radius: `/nearby-friends/search-radius-miles` (default: 5)
  - Inactivity TTL: `/nearby-friends/inactivity-ttl-seconds` (default: 600)
  - Location update interval: `/nearby-friends/location-update-interval-seconds` (default: 30)
  - Max friends: `/nearby-friends/max-friends` (default: 5000)
  - Nearby strangers limit: `/nearby-friends/nearby-strangers-limit` (default: 50)
  - Haversine Earth radius: `3958.8` miles.

---

## 🛠️ Common Commands

```bash
# Dependencies & Compilation
npm install
npm run type-check   # npx tsc --noEmit
npm run build        # node scripts/build.js -> dist/*.zip

# Testing
npm test             # Run Jest
npm run test:unit    # Unit tests
npm run test:property # Property tests (fast-check)

# Terraform
cd terraform && terraform init
terraform plan
terraform apply
```
