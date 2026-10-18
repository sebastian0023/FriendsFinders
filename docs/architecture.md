# Architecture

How Nearby Friends is built and why. For what the app does and its API see [`product.md`](product.md); for the stack and commands see [`tech.md`](tech.md). The overview diagram, the list of AWS services and the table definitions are in the [README](../README.md). This document does not repeat them. It covers how the main flows work, what happens when something fails, the security model, how it scales, and the decisions behind the design.

## Shape of the system

Three Lambda functions do all the work, none inside a VPC:

| Function | Triggered by | Responsibility |
|---|---|---|
| `websocket-handler` | API Gateway WebSocket routes (`$connect`, `$disconnect`, `location.update`, `friends.refresh`) | Verifies the user, records the connection and its location, sends the initial friends snapshot |
| `rest-handler` | API Gateway HTTP API (11 routes) | Friends, friend requests, profiles, picture upload URLs, nearby friends and strangers |
| `fanout-handler` | DynamoDB Streams on the Connections table | Pushes a user's new location to their friends who are within range |

Every dependency is reached over public AWS endpoints with IAM authentication, and each function has its own IAM role with only the access it needs. Each function keeps its AWS access in small wrappers under `src/utils`, so the handlers contain the logic and the wrappers contain the requests.

## Main flows

### Connecting
1. The client opens the WebSocket with its Cognito token in `?token=`. WebSocket APIs have no built-in JWT authorizer, so `$connect` verifies the token itself against the user pool's public keys (RS256 only, signature and expiry checked) and takes the user id from `sub`.
2. The connection is stored in the **Connections** table with an `expiresAt` of now plus the inactivity TTL.
3. The handler loads the user's friends, looks up each friend's live connections, and takes the first one that has a location. It measures that against the caller's most recently updated located connection. Friends inside the radius go into an `init.response` sent to the new connection. A caller with no location yet gets all located friends at distance `0`.
4. `friends.refresh` repeats step 3 on demand.

### Sharing a location, and the fan-out
1. A `location.update` is validated, then written to the connection's item: latitude, longitude, timestamp, the **grid cell** the location falls in, and a refreshed `expiresAt`.
2. The write appears on the table's **DynamoDB stream** (new and old images). `fanout-handler` ignores records where the coordinates did not change, such as a plain expiry refresh.
3. For a changed location it loads the mover's friends and, for each friend's live connections, decides whether to notify: the friend is within the radius, or has not shared a location yet (distance `0`). Matches get a `location.push` through the API Gateway management API.
4. A connection that has closed answers `410 Gone` and is skipped; the item disappears when its TTL fires. Any other send error is logged and the loop continues.

The stream trigger delivers batches of 10 and uses partial batch responses: if the lookups for one record fail, only that record is retried, up to 3 times, and then dropped. That is safe because the same user's next update, about 30 seconds later, supersedes it.

### Friend requests
- Creating a request checks that it is not to yourself, that you are not already friends (one `GetItem` on the Friendships table), and that no pending request from you to them exists.
- **Accepting** is one DynamoDB transaction of three operations: create the friendship item for each direction (keeping the original date if it exists), and delete the request, conditional on the request still existing. Either all of it happens or none of it. If the request is already gone the call answers `409`. Concurrent transactions on the same items are retried up to three times.
- **Removing** a friend deletes both items in one transaction.

### Nearby strangers
1. The caller's location comes from their own live connection.
2. The map is cut into 0.1° squares (about 7 miles). Every connection with a location stores its square as `geoCell` (for example `1106:766`) and the sparse `geoCell-index` is built on it.
3. `src/utils/geo-cells.ts` works out which squares can contain anyone within the search radius. With the default 5 miles that is about 9 squares. They are queried in parallel, following pages and skipping expired connections.
4. The handler measures the exact Haversine distance, drops the caller and their friends, keeps only discoverable users, takes each person at their nearest connection, sorts by distance and applies the limit.
5. If more than 25 squares would be needed (a very large radius, or a location near a pole), it falls back to a scan of the table capped at 20 pages and logs a warning if it stops early.

The covering is guaranteed to be complete, so the results match what a full scan would return: a property test checks that every point within the radius, including points right at its edge, lies in a queried square.

### Profile pictures
The client asks for an upload URL, uploads the image straight to S3, and saves the returned key on its profile. The upload URL is valid 5 minutes, its key is `profile-pictures/<userId>/<uuid>.jpg`, and the `Content-Type` is part of the signature so S3 rejects anything but `image/jpeg`. Profile reads return a one-hour signed download URL that forces the response type to `image/jpeg`. A profile update only accepts a picture key under the caller's own folder.

## Data model

Four tables (keys and indexes are in the README):

- **Users**: profile only, keyed by the Cognito `sub`: `displayName`, `profilePictureKey`, `discoverable`, `createdAt`.
- **Friendships**: one item per direction, `(userId, friendId)` meaning "friendId is a friend of userId", with `createdAt`. A friendship is therefore two items, always written or removed together. The `friendId-index` finds everyone who lists a user as a friend.
- **Connections**: one item per live WebSocket connection: user, location, timestamp, `geoCell` and `expiresAt` (the TTL attribute). A user with several devices has several items.
- **FriendRequests**: pending requests, with indexes for incoming and outgoing lookups. Accepting or declining deletes the item.

The TypeScript shapes are in `src/types/index.ts`; this document deliberately does not copy them.

## When things fail

| Failure | What happens |
|---|---|
| SSM unreachable | The previous settings keep being used, or the defaults if there are none. The failure is logged and SSM is tried again after 30 seconds. Settings are otherwise refreshed every 5 minutes, and an invalid value falls back to its default with a warning. |
| Fan-out cannot look up a record's friends | Only that record is retried (up to 3 times) |
| A transaction conflicts with another | Retried up to 3 times, then the call fails with a JSON `500` |
| Accepting a request that is already handled | `409` |
| A client has already disconnected | The push is skipped; the item expires on its own |
| A table read has more than 1 MB of results | Every list query follows the pages, except the fallback scan, which stops at its cap |
| Unexpected error in a REST route | A JSON `500` with a generic message; the detail is logged |
| Invalid JSON or an invalid field in a request | `400` with the reason, before anything is written |

## Security

- **Authentication:** Cognito issues the tokens. The HTTP API's JWT authorizer checks them and passes the verified claims to the handler. The WebSocket handler checks them itself, as above.
- **Authorisation:** users can only edit their own profile and upload URL (`403` otherwise); only the recipient can accept or decline a request.
- **Privacy:** strangers get a distance and a name, never coordinates; a profile read exposes only public fields; discoverability is opt-in and independent of sharing location with friends.
- **Input:** location updates and profile updates are validated; unknown fields in a profile update are ignored, so a client cannot set anything it should not.
- **Least privilege:** the three roles differ. For example the WebSocket and fan-out roles can only `Query` the Friendships table, while the REST role can also read single items and create or delete them.

## Scaling and cost

- **Per request:** nearby strangers costs a handful of small queries, not a table read. Nearby friends costs one connection query per friend and a profile lookup for each friend in range. A location change costs the fan-out one friend lookup plus one connection query per friend.
- **Fixed cost:** essentially none. Everything is pay-per-use: on-demand DynamoDB, Lambda, API Gateway, and no NAT Gateway or cache cluster.
- **Limits to know:** the WebSocket stage is throttled to 50 requests per second (burst 100); a grid square's index partition is shared by everyone in it (about 7 miles square); a user's friend list is read in full by the fan-out on every location change.

Known gaps and ideas are in the README's Roadmap.

## Decisions

Each entry says what was chosen, why, and what it replaced.

- **Three Lambdas, not twelve.** Fewer cold starts and deployment units, with routing by route key or method and path inside each. Replaced one function per route.
- **No VPC, no NAT Gateway, no Redis.** Services are reached over public endpoints with IAM; the Connections table with a TTL holds each user's latest location. Saves the fixed monthly cost of a NAT gateway and a cache cluster. Replaced ElastiCache Redis with pub/sub and a location cache.
- **Fan-out through DynamoDB Streams.** A location write is itself the event, so there is nothing to keep in sync. The price is a friend lookup per update. Replaced Redis pub/sub channels per user.
- **Inactivity through a TTL.** Every location update pushes `expiresAt` forward and readers ignore expired items, so there is no "went offline" step. DynamoDB deletes the items later.
- **Friendships in their own table.** Two small items per friendship instead of two lists on the Users items. Profile reads stay small, there is no per-user size ceiling (an item is capped at 400 KB), and concurrent changes cannot overwrite each other. Replaced friend lists embedded in the Users item.
- **Transactions for accepting and removing.** The two directions and the request change together, so there is no half-made friendship and no double accept. Replaced several separate writes.
- **A grid index for nearby strangers.** A fixed 0.1° grid with a sparse index that the maths can cover exactly, and no extra dependency. Replaced a table scan. A geohash library or H3 would also work; the grid was chosen for being simple to reason about and to test.
- **Friends only through requests.** There is no direct "add friend" route. Replaced the original design's immediate add.
- **Strangers at their nearest device.** For a stranger, being near is what matters, so a person is listed once if any of their devices is in range, at the closest distance. `/nearby-friends` locates a friend by their most recent update instead. The WebSocket snapshot and `/nearby-friends` still pick among a user's several devices differently (see the Roadmap).
- **Settings in SSM, cached for 5 minutes.** They can be changed without a deploy, and a change reaches every warm Lambda within a few minutes. A bad or missing value never breaks a request.
- **Pictures go straight to S3 with a signed content type.** No picture bytes pass through a Lambda, and S3 enforces the type.
- **A tile-free radar map.** The web app draws friends by distance and bearing on a canvas, so there is no map or tile service to run or pay for.
- **Terraform only, with per-account state.** The state bucket's name differs per AWS account, so it is passed at `init` time and kept out of the code (`terraform/backend.hcl.example`). Provider versions are pinned by the committed lock file.
- **Tests as the specification.** Behaviour is pinned by tests that never call AWS, and there are no separate requirement or task documents. See "How We Work" in `AGENTS.md`.
