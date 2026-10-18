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
   - `Users`: PK `userId` (Cognito `sub` UUID). Profile only: `displayName`, `profilePictureKey`, `discoverable`, `createdAt`.
   - `Friendships`: PK `userId`, SK `friendId`, GSI `friendId-index` (reverse lookup), attribute `createdAt`. One item per direction, so a friendship is two items.
   - `Connections`: PK `connectionId`, GSIs `userId-index` and `geoCell-index`, attributes `latitude`, `longitude`, `geoCell`, `timestamp`, `expiresAt` (TTL), Streams enabled (`NEW_AND_OLD_IMAGES`). `geoCell` is the key of the 0.1° grid square the location is in (`src/utils/geo-cells.ts`); `/nearby-strangers` queries only the squares that can contain someone within the search radius instead of scanning the table, falling back to a capped scan for very large radii or polar locations.
   - `FriendRequests`: PK `requestId`, GSIs on `toUserId` and `fromUserId`.
   > **Friends live in their own `Friendships` table**, not on the `Users` item: profile reads stay small, there is no per-item size ceiling, and friend changes cannot overwrite each other. Accepting a request creates both directions and deletes the request in one DynamoDB transaction (`createFriendship`); removing a friend deletes both directions in one (`removeFriendship`).

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
  - AWS mocking: `aws-sdk-client-mock` for the wrappers in `src/utils`; handler tests replace those wrappers with `jest.mock()`.
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

# Terraform (copy terraform/backend.hcl.example to backend.hcl and set your state bucket first)
cd terraform && terraform init -backend-config=backend.hcl
terraform plan
terraform apply
```

---

## 🤝 How We Work

- **Plan before building.** For anything non-trivial, write down the options and their trade-offs and agree on one before coding.
- **Tests first.** Start with a failing test that describes the behaviour, then make it pass. For important logic, break the code on purpose to check that the tests notice.
- **Definition of done.** `npm run type-check`, `npm test` and `npm run build` all pass, and the docs that describe the changed behaviour are updated in the same change.
- **One change per branch.** Never work directly on `develop` or `main`. Open a pull request per change, merge them one at a time, and keep commits small and focused.
- **The tests describe the behaviour.** There are no separate requirement or task documents, because requirements change. Change the test and the code together.
- **Keep docs short and derived from the code.** Do not copy interfaces or signatures into documents; link to the source. `docs/product.md` covers behaviour and the API, `docs/tech.md` the stack and commands, and `docs/architecture.md` how it is built and why.
- **Record design decisions.** When you choose between designs, add an entry (what, why, what it replaces) to "Decisions" in `docs/architecture.md`, and a one-line summary to "Key Design Decisions" in the README if it is a headline choice.
