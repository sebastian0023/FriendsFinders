# Implementation Plan: Nearby Friends

## Overview

Incremental implementation of the Nearby Friends serverless backend using 3 Lambda handlers (websocket-handler, rest-handler, fanout-handler), 4 DynamoDB tables (Users, Friendships, Connections with embedded location + TTL + Streams, FriendRequests), S3 for profile pictures, and SSM Parameter Store for runtime configuration. No Redis or VPC required.

## Tasks

- [ ] 1. Project setup and TypeScript interfaces
  - [ ] 1.1 Initialize project structure with package.json, tsconfig.json, and dependencies
    - Install: @aws-sdk/client-dynamodb, @aws-sdk/lib-dynamodb, @aws-sdk/client-apigatewaymanagementapi, @aws-sdk/client-s3, @aws-sdk/s3-request-presigner, @aws-sdk/client-ssm, uuid
    - Install dev: typescript, jest, ts-jest, @types/jest, fast-check, @types/uuid
    - Configure tsconfig.json (strict mode, ESNext target, CommonJS modules)
    - Configure jest.config.ts with ts-jest preset
    - _Requirements: 15.1–15.5_

  - [ ] 1.2 Define all TypeScript interfaces in src/types/index.ts
    - LocationUpdate, UserProfile, Friendship, FriendRequest, WebSocketConnection (with latitude, longitude, timestamp, ttl fields)
    - NearbyFriendEntry, NearbyStrangerEntry
    - LocationUpdateMessage, LocationPushMessage, InitResponseMessage
    - _Requirements: 16.1, 16.2, 16.3_

- [ ] 2. Utility modules
  - [ ] 2.1 Implement Haversine distance calculation in src/utils/distance.ts
    - Pure function: haversine(lat1, lng1, lat2, lng2) → distance in miles
    - Earth radius constant: 3958.8 miles
    - _Requirements: 5.1, 5.5_

  - [ ]* 2.2 Write property tests for Haversine (tests/property/distance.property.test.ts)
    - **Property 5: Haversine mathematical properties** — non-negative, symmetric, identity
    - **Validates: Requirement 5.1**

  - [ ]* 2.3 Write property test for nearby classification (tests/property/distance.property.test.ts)
    - **Property 6: Nearby classification matches distance comparison**
    - **Validates: Requirements 1.7, 4.5, 4.6, 5.3, 5.4**

  - [ ] 2.4 Implement coordinate validation in src/utils/validation.ts
    - validateLocationUpdate(body): validates lat ∈ [-90, 90], lng ∈ [-180, 180], timestamp present
    - _Requirements: 3.2, 3.4_

  - [ ]* 2.5 Write property test for coordinate validation (tests/property/validation.property.test.ts)
    - **Property 3: Coordinate validation**
    - **Validates: Requirements 3.2, 3.4**

  - [ ] 2.6 Implement SSM config loader in src/utils/config.ts
    - Fetch parameters from SSM with fallback defaults: search-radius-miles (5), inactivity-ttl-seconds (600), location-update-interval-seconds (30), max-friends (5000), nearby-strangers-limit (50)
    - _Requirements: 15.1, 15.2, 15.3, 15.4, 15.5_

  - [ ]* 2.7 Write property test for SSM config (tests/property/ssm-config.property.test.ts)
    - **Property 22: SSM parameters with defaults**
    - **Validates: Requirements 15.1, 15.2, 15.3, 15.4, 15.5**

  - [ ] 2.8 Implement message utilities in src/utils/message-utils.ts
    - buildLocationPush, buildInitResponse, parseLocationUpdate
    - _Requirements: 16.1, 16.2, 16.3_

  - [ ]* 2.9 Write property test for message serialization (tests/property/message.property.test.ts)
    - **Property 23: Message serialization round-trip**
    - **Validates: Requirements 16.4, 16.5, 16.6**

  - [ ] 2.10 Implement DynamoDB client helpers in src/utils/dynamo-client.ts
    - Typed wrappers for Connections, Friendships, Users, FriendRequests tables
    - putConnection, deleteConnection, getConnectionsByUserId, updateConnectionLocation
    - getFriends, putFriendship, deleteFriendship, getFriendCount
    - getUser, putUser, updateUser
    - putFriendRequest, getFriendRequest, getFriendRequestsByToUser, deleteFriendRequest
    - _Requirements: 1.4, 2.1, 3.3, 7.1, 8.1, 8.3, 11.1, 12.1, 13.5, 13.6, 14.3_

  - [ ] 2.11 Implement API Gateway Management client in src/utils/apigw-client.ts
    - postToConnection(connectionId, data): sends JSON to WebSocket client
    - _Requirements: 1.8, 4.5, 4.7_

  - [ ] 2.12 Implement S3 client helpers in src/utils/s3-client.ts
    - generateUploadUrl(userId): returns { uploadUrl, s3Key } with unique key
    - generateDownloadUrl(s3Key): returns pre-signed GET URL
    - _Requirements: 8.2, 9.1, 9.2_

- [ ] 3. Checkpoint — Verify utilities compile and tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 4. WebSocket handler (src/handlers/websocket-handler.ts)
  - [ ] 4.1 Implement $connect route handler
    - Authenticate user from token query param
    - Store connection record in Connections_Table with TTL
    - Fetch friend list from Friendships_Table
    - Query Connections_Table for friends' active locations
    - Compute Haversine, filter within Search_Radius
    - Send init.response to client
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 1.8, 1.9_

  - [ ]* 4.2 Write property test for connection record storage (tests/property/connection.property.test.ts)
    - **Property 1: Connection record storage**
    - **Validates: Requirement 1.4**

  - [ ]* 4.3 Write property test for init response correctness (tests/property/connection.property.test.ts)
    - **Property 9: Init response contains exactly the nearby friends**
    - **Validates: Requirements 1.7, 1.8**

  - [ ] 4.4 Implement $disconnect route handler
    - Delete connection record from Connections_Table
    - Log errors gracefully, allow TTL cleanup
    - _Requirements: 2.1, 2.2_

  - [ ]* 4.5 Write property test for disconnect cleanup (tests/property/connection.property.test.ts)
    - **Property 2: Disconnect removes connection**
    - **Validates: Requirement 2.1**

  - [ ] 4.6 Implement location.update route handler
    - Validate coordinates using validation utility
    - Update Connections_Table record with new lat/lng/timestamp and refresh TTL
    - Return error to client on validation failure
    - _Requirements: 3.1, 3.2, 3.3, 3.4_

  - [ ]* 4.7 Write property test for location update writes (tests/property/location.property.test.ts)
    - **Property 4: Location update writes to Connections_Table with TTL**
    - **Validates: Requirements 3.3, 6.2**

  - [ ] 4.8 Wire the websocket-handler entry point with route dispatching ($connect, $disconnect, location.update)
    - Single Lambda handler that routes based on event.requestContext.routeKey
    - _Requirements: 1.1, 2.1, 3.1_

- [ ] 5. Checkpoint — Verify WebSocket handler compiles and tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 6. Fan-out handler (src/handlers/fanout-handler.ts)
  - [ ] 6.1 Implement DynamoDB Streams event processing
    - Parse stream event for INSERT/MODIFY records with location data
    - Look up updated user's friend list from Friendships_Table
    - Query Connections_Table for each friend's active connection and location
    - Compute Haversine distance between updated user and each friend
    - Send location.push to friends within Search_Radius via PostToConnection
    - Skip friends outside radius; log and continue on PostToConnection failure
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 4.7_

  - [ ]* 6.2 Write property test for fan-out notification (tests/property/fanout.property.test.ts)
    - **Property 8: Fan-out notifies all nearby friends**
    - **Validates: Requirements 4.2, 4.3, 4.4, 4.5, 4.6**

  - [ ]* 6.3 Write property test for inactive user exclusion (tests/property/fanout.property.test.ts)
    - **Property 7: Inactive user exclusion from nearby results**
    - **Validates: Requirement 6.3**

- [ ] 7. REST handler — Friend management (src/handlers/rest-handler.ts)
  - [ ] 7.1 Implement DELETE /friends/{friendId} route
    - Delete both bidirectional Friendship records
    - Return success response
    - _Requirements: 7.1, 7.2_

  - [ ]* 7.2 Write property test for friendship bidirectionality on remove (tests/property/friendship.property.test.ts)
    - **Property 11: Friendship bidirectionality on remove**
    - **Validates: Requirement 7.1**

  - [ ] 7.3 Implement POST /friend-requests/{toUserId} route
    - Validate no duplicate pending request and no existing friendship
    - Create pending request in FriendRequests_Table with unique requestId
    - _Requirements: 11.1, 11.2, 11.3, 11.4_

  - [ ]* 7.4 Write property test for friend request creation (tests/property/friend-request.property.test.ts)
    - **Property 20: Friend request creation and listing round-trip**
    - **Validates: Requirements 11.1, 12.1, 12.2**

  - [ ] 7.5 Implement GET /friend-requests route
    - Query FriendRequests_Table by toUserId GSI for pending requests
    - Return list of pending requests
    - _Requirements: 12.1, 12.2, 12.3_

  - [ ] 7.6 Implement PUT /friend-requests/{requestId}/accept route
    - Verify request exists and is pending
    - Check both users' friend counts against max-friends limit
    - Create bidirectional Friendship records
    - Delete friend request record
    - _Requirements: 13.1, 13.2, 13.3, 13.4, 13.5, 13.6, 13.7_

  - [ ]* 7.7 Write property test for friendship bidirectionality on accept (tests/property/friendship.property.test.ts)
    - **Property 10: Friendship bidirectionality on accept**
    - **Validates: Requirement 13.5**

  - [ ]* 7.8 Write property test for friend count limit enforcement (tests/property/friendship.property.test.ts)
    - **Property 12: Friend count limit enforcement on accept**
    - **Validates: Requirements 13.3, 13.4**

  - [ ]* 7.9 Write property test for friend request deletion on resolution (tests/property/friend-request.property.test.ts)
    - **Property 21: Friend request deletion on resolution**
    - **Validates: Requirements 13.6, 14.3**

  - [ ] 7.10 Implement PUT /friend-requests/{requestId}/decline route
    - Verify request exists and is pending
    - Delete friend request record
    - _Requirements: 14.1, 14.2, 14.3, 14.4_

- [ ] 8. Checkpoint — Verify friend management routes compile and tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 9. REST handler — User profiles and pictures
  - [ ] 9.1 Implement GET /users/{userId}/profile route
    - Fetch profile from Users_Table
    - Generate pre-signed GET URL if profilePictureKey exists
    - Return 404 if user not found
    - _Requirements: 8.1, 8.2, 8.5_

  - [ ] 9.2 Implement PUT /users/{userId}/profile route
    - Update displayName, profilePictureKey, discoverable in Users_Table
    - Discoverable flag independent from location sharing
    - _Requirements: 8.3, 8.4_

  - [ ]* 9.3 Write property test for profile update round-trip (tests/property/profile.property.test.ts)
    - **Property 13: Profile update round-trip**
    - **Validates: Requirements 8.1, 8.3**

  - [ ]* 9.4 Write property test for profile picture URL generation (tests/property/profile.property.test.ts)
    - **Property 14: Profile picture URL generation**
    - **Validates: Requirement 8.2**

  - [ ]* 9.5 Write property test for discoverable flag independence (tests/property/profile.property.test.ts)
    - **Property 15: Discoverable flag independence**
    - **Validates: Requirement 8.4**

  - [ ] 9.6 Implement GET /users/{userId}/profile-picture-upload-url route
    - Generate pre-signed S3 PUT URL with unique key and time-limited expiration
    - _Requirements: 9.1, 9.2_

  - [ ]* 9.7 Write property test for upload URL uniqueness (tests/property/profile.property.test.ts)
    - **Property 16: Upload URL uniqueness**
    - **Validates: Requirement 9.1**

- [ ] 10. REST handler — Nearby strangers discovery
  - [ ] 10.1 Implement GET /nearby-strangers route
    - Query all active connection records from Connections_Table with valid location
    - Compute Haversine distance, filter within Search_Radius
    - Exclude requesting user and existing friends (Friendships_Table lookup)
    - Include only users with discoverable=true (Users_Table lookup)
    - Order by proximity (closest first), cap results to configured limit
    - Generate pre-signed profile picture URLs for results
    - _Requirements: 10.1, 10.2, 10.3, 10.4, 10.5, 10.6, 10.7_

  - [ ]* 10.2 Write property test for nearby strangers filtering (tests/property/nearby-strangers.property.test.ts)
    - **Property 17: Nearby strangers filtering**
    - **Validates: Requirements 10.2, 10.3, 10.4, 10.5**

  - [ ]* 10.3 Write property test for nearby strangers ordering (tests/property/nearby-strangers.property.test.ts)
    - **Property 18: Nearby strangers ordering by proximity**
    - **Validates: Requirement 10.5**

  - [ ]* 10.4 Write property test for nearby strangers result cap (tests/property/nearby-strangers.property.test.ts)
    - **Property 19: Nearby strangers result cap**
    - **Validates: Requirement 10.6**

- [ ] 11. Wire REST handler entry point with route dispatching
  - Single Lambda handler that routes based on event.routeKey or event.httpMethod + event.path
  - Connect all REST routes: DELETE /friends, POST/GET/PUT /friend-requests, GET/PUT /users/profile, GET /profile-picture-upload-url, GET /nearby-strangers
  - _Requirements: 7.1, 8.1, 9.1, 10.1, 11.1, 12.1, 13.1, 14.1_

- [ ] 12. Checkpoint — Verify all handlers compile and all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 13. Terraform infrastructure
  - [ ] 13.1 Create DynamoDB module (terraform/modules/dynamodb/)
    - Users table (PK: userId)
    - Friendships table (PK: userId, SK: friendId, GSI: friendId-index)
    - Connections table (PK: connectionId, GSI: userId-index, TTL attribute, DynamoDB Streams enabled)
    - FriendRequests table (PK: requestId, GSI: toUserId-index, GSI: fromUserId-index)
    - _Requirements: 1.4, 6.1, 4.1_

  - [ ] 13.2 Create S3 module (terraform/modules/s3/)
    - Profile pictures bucket with server-side encryption
    - _Requirements: 9.3_

  - [ ] 13.3 Create SSM module (terraform/modules/ssm/)
    - Parameters: search-radius-miles, inactivity-ttl-seconds, location-update-interval-seconds, max-friends, nearby-strangers-limit
    - _Requirements: 15.1, 15.2, 15.3, 15.4, 15.5_

  - [ ] 13.4 Create IAM module (terraform/modules/iam/)
    - Execution roles for websocket-handler, rest-handler, fanout-handler
    - Least-privilege policies for DynamoDB, S3, SSM, API Gateway Management
    - _Requirements: 1.1, 4.1_

  - [ ] 13.5 Create API Gateway module (terraform/modules/api-gateway/)
    - WebSocket API with routes: $connect, $disconnect, location.update
    - HTTP API with all REST routes
    - _Requirements: 1.1, 7.1, 8.1, 9.1, 10.1, 11.1, 12.1, 13.1, 14.1_

  - [ ] 13.6 Create Lambda module (terraform/modules/lambda/)
    - 3 Lambda functions: websocket-handler, rest-handler, fanout-handler
    - fanout-handler triggered by DynamoDB Streams on Connections table
    - Environment variables wired from SSM
    - _Requirements: 4.1, 15.1_

  - [ ] 13.7 Create main Terraform configuration (terraform/main.tf, variables.tf, outputs.tf)
    - Wire all modules together
    - _Requirements: all_

- [ ] 14. Final checkpoint — Ensure all tests pass and TypeScript compiles cleanly
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Each task references specific requirements for traceability
- Checkpoints ensure incremental validation
- Property tests validate universal correctness properties from the design document
- No Redis, no VPC, no NAT Gateway — simplified architecture using DynamoDB Streams for fan-out
- 3 Lambda handlers instead of 12 — route dispatching handled within each handler
- Friends are added only through accepting friend requests (no direct POST /friends/{friendId} add endpoint)
