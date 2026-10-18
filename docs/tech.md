# Tech Stack

## Runtime & Language

- TypeScript (strict mode, ESNext target, CommonJS modules for Lambda compatibility), one `tsconfig.json` at the repo root that also covers the tests
- Node.js 20 on AWS Lambda (`nodejs20.x`)
- Lambda code is bundled with esbuild (`scripts/build.js`), one bundle per handler, with the AWS SDK left external because the Lambda runtime provides it
- The web app is a single `frontend/index.html` (plain HTML, CSS and JavaScript, no build step)

## AWS Services

- API Gateway v2 (WebSocket API): persistent connections for real-time location updates
- API Gateway v2 (HTTP API): REST endpoints, protected by a Cognito JWT authorizer
- AWS Lambda: three functions, none inside a VPC: `websocket-handler`, `rest-handler`, `fanout-handler`
- Amazon DynamoDB (on-demand billing): four tables, `Users`, `Friendships`, `Connections` (with TTL, a stream and a `geoCell` index) and `FriendRequests`
- Amazon Cognito: user pool and hosted sign-in for the web app
- Amazon S3: profile pictures (server-side encryption) and the hosted web app; CloudFront serves the web app
- AWS SSM Parameter Store: runtime settings
- CloudWatch: log groups and error alarms per Lambda

## AWS SDK

AWS SDK for JavaScript v3, modular clients only:

- `@aws-sdk/client-dynamodb`, `@aws-sdk/lib-dynamodb`
- `@aws-sdk/client-apigatewaymanagementapi`
- `@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner`
- `@aws-sdk/client-ssm`

## Infrastructure

- Terraform only (no CDK, SAM or Serverless Framework); everything is declarative
- Modules: `api-gateway`, `lambda`, `dynamodb`, `cognito`, `frontend`, `frontend-deploy`, `iam`, `ssm`, `s3`, `monitoring`, plus `cicd.tf` for the GitHub deploy role
- Remote state in S3 with a DynamoDB lock table; the bucket name is supplied at `init` time (see `terraform/backend.hcl.example`) because it differs per AWS account
- The provider versions are pinned by the committed `terraform/.terraform.lock.hcl`

## Testing

- Jest with ts-jest. Unit tests are in `tests/unit`, property tests in `tests/property`, shared helpers in `tests/helpers`
- fast-check for property-based tests (at least 100 runs per property)
- AWS calls are never made in tests: the wrappers in `src/utils` are tested with `aws-sdk-client-mock`, and the handlers are tested with those wrappers replaced by `jest.mock()`

## Key Constants (configurable through SSM)

- Search radius: 5 miles
- Inactivity TTL: 600 seconds (10 minutes)
- Location update interval: 30 seconds
- Max friends: 5,000
- Nearby strangers limit: 50
- Earth radius: 3958.8 miles (for Haversine)

## SSM Parameters

- `/nearby-friends/search-radius-miles` (default: 5)
- `/nearby-friends/inactivity-ttl-seconds` (default: 600)
- `/nearby-friends/location-update-interval-seconds` (default: 30)
- `/nearby-friends/max-friends` (default: 5000)
- `/nearby-friends/nearby-strangers-limit` (default: 50)

The Lambdas read them through `src/utils/config.ts`, which caches them for 5 minutes (`CONFIG_CACHE_TTL_SECONDS` overrides that), falls back to the defaults for a missing or invalid value, and logs when SSM cannot be reached.

## Common Commands

```bash
# Install dependencies
npm install

# Type-check (source and tests)
npm run type-check

# Bundle the Lambdas into dist/
npm run build

# Run all tests, or only one kind
npm test
npm run test:unit
npm run test:property

# Coverage
npx jest --coverage

# Terraform (first time: pass your state bucket, see terraform/backend.hcl.example)
cd terraform
terraform init -backend-config=backend.hcl
terraform plan
terraform apply
```
