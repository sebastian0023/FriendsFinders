# Product: Nearby Friends

Opted-in users share their location in real time and see which of their friends are within a configurable radius (default 5 miles), with the distance and when each friend last updated. They can also discover nearby strangers who have chosen to be discoverable, and send them friend requests.

This is an academic project: the architecture aims to be correct and well structured, not to serve production-scale traffic. It is still built so cost and latency do not grow with the total number of users where that is cheap to do (see `architecture.md`).

## What users can do

- **See nearby friends** on a live radar: each entry shows the friend, the straight-line distance and the time of their last update. The list updates as friends move.
- **Share location** by sending an update about every 30 seconds. A user who stops updating drops off everyone's list after 10 minutes, with no explicit "went offline" step.
- **Manage friends**: list them, remove them, and add new ones through friend requests (there is no direct "add friend").
- **Discover strangers**: see nearby people who turned discoverability on, nearest first, and send them a request. Discoverability is independent of sharing location with friends.
- **Edit a profile**: display name, discoverability and a profile picture uploaded straight to S3.
- **Everyone has a name.** A new user chooses a display name before anything else, and nobody can use the app without one (see below).

## How it behaves

### Accounts
The web app has its own forms next to the Cognito sign-in page. **Create account** asks for a display name, email, password and the password again; the app checks that the two passwords match and follow the rule (at least 8 characters with a capital letter, a lowercase letter and a number) before anything is sent. Cognito then emails a code; entering it confirms the account and signs the user in, and the name they gave is already filled in on the name step. **Send a new code** is available on the code step. **Forgot password** emails a code, and entering it with a new password (typed twice) changes the password and signs the user in. Wrong or expired codes, an email that already has an account and Cognito being unreachable are each explained in plain words. If the automatic sign-in is refused, the user is sent back to sign in by hand.

### Having a name
Nobody can use the app without a display name. After signing in, a user who has no profile is asked to choose a name before anything else is shown. Until they have one the server refuses every request except reading or creating their own profile (`403`), and the WebSocket refuses to connect (`403`). People are always shown by name, never by id and never as a placeholder, and anyone without a profile does not appear in friends, requests or nearby lists.

### Connecting
A client opens a WebSocket with its Cognito token in the `token` query parameter. The server verifies the token, checks that the user has a profile, records the connection (with an expiry), and sends an `init.response` listing the friends currently within the radius. If a user has not shared a location yet, their friends are listed with distance `0`, since there is nothing to measure from. A client can send `friends.refresh` at any time to receive a fresh `init.response`.

### Sharing a location
`location.update` messages are validated (latitude −90 to 90, longitude −180 to 180, a timestamp string). A valid update stores the location, refreshes the connection's expiry, and notifies friends; an invalid one gets an `error` message back and changes nothing. Updates for an unknown connection are ignored.

### Notifying friends
Each stored location change triggers a fan-out: for every friend with a live connection, if the friend is within the radius (or has not shared a location yet) they receive a `location.push`. Friends who are out of range receive nothing, and connections that have closed are skipped. If looking up friends fails for one update, only that update is retried.

### Friends and requests
- Sending a request to someone creates a pending request. You cannot send one to yourself, to an existing friend, or twice to the same person, and the person must have a profile (otherwise `404`).
- The recipient lists pending requests (each with the sender's name) and accepts or declines.
- **Accepting** makes both users friends and consumes the request in a single step, so it can never leave a one-sided friendship. If the request was already accepted or declined it answers `409`, and it is refused when either user has reached the friend limit.
- **Removing** a friend removes the friendship for both users in one step. Removing someone who is not a friend succeeds quietly.

### Nearby strangers
The server finds connections near the caller, excludes the caller and their friends, keeps only users who are discoverable, and returns each person once at the distance of their nearest device, closest first, up to the configured limit. Strangers only ever see a distance, never coordinates. The caller needs a recent location, otherwise the answer is `400`.

### Profiles and pictures
Reading a profile returns only public fields. A user can edit only their own profile, and creating one requires a display name; changes are validated (see below). To set a picture, the client asks for an upload URL, uploads the file straight to S3, then saves the returned key on the profile. Pictures are served through short-lived signed URLs.

## Rules and limits

| Rule | Value |
|---|---|
| Search radius | 5 miles by default (`/nearby-friends/search-radius-miles`) |
| Inactivity before a user drops off lists | 10 minutes (`/nearby-friends/inactivity-ttl-seconds`) |
| Location update interval for clients | 30 seconds (`/nearby-friends/location-update-interval-seconds`) |
| Friends per user | 5,000 (`/nearby-friends/max-friends`) |
| Nearby strangers returned | 50 (`/nearby-friends/nearby-strangers-limit`) |
| Display name | required; 1–50 characters after trimming, no control characters |
| `discoverable` | exactly `true` or `false` |
| Profile picture key | must be an upload key for your own profile (`profile-pictures/<your id>/…`) |
| Picture upload | URL valid 5 minutes; the upload must be sent as `Content-Type: image/jpeg` |
| Picture download URL | valid 1 hour |

Settings are read from SSM and refreshed about every 5 minutes. A missing or invalid value falls back to its default.

## API

All REST calls need a Cognito token. The API Gateway authorizer checks it and the handler uses its `sub` as the caller's id. Errors are JSON `{ "error": "<message>" }`.

Every route except reading or creating your own profile also needs the caller to have a profile; without one it answers `403` with "Set a display name first".

### REST

| Method and path | Success | Errors |
|---|---|---|
| `GET /friends` | `200` `[{ friendId, displayName, profilePictureUrl?, friendsSince }]` | |
| `DELETE /friends/{friendId}` | `200` `{ message }` | |
| `GET /nearby-friends` | `200` `[{ friendId, displayName, profilePictureUrl?, latitude, longitude, lastUpdated, distanceMiles }]`, nearest first | `400` no recent location |
| `GET /nearby-strangers` | `200` `[{ userId, displayName, profilePictureUrl, distanceMiles }]`, nearest first | `400` no recent location |
| `POST /friend-requests/{toUserId}` | `201` the request `{ requestId, fromUserId, toUserId, status, createdAt }` | `400` to yourself; `404` the person has no profile; `409` already friends or already pending |
| `GET /friend-requests` | `200` pending incoming requests, each with `fromDisplayName` | |
| `PUT /friend-requests/{requestId}/accept` | `200` `{ message }` | `403` not the recipient; `404` unknown; `409` not pending, friend limit reached |
| `PUT /friend-requests/{requestId}/decline` | `200` `{ message }` | `403`; `404`; `409` not pending |
| `GET /users/{userId}/profile` | `200` `{ userId, displayName, profilePictureUrl?, discoverable, createdAt }` | `404` |
| `PUT /users/{userId}/profile` | `200` `{ message }` (created or updated) | `400` invalid JSON or field, or no `displayName` when creating; `403` not your profile |
| `GET /users/{userId}/profile-picture-upload-url` | `200` `{ uploadUrl, s3Key }` | `403` not your profile |

Every route also answers `401` without a valid token, `404` for an unknown route, and `500` `{ "error": "Internal server error" }` for an unexpected failure.

### WebSocket

Connect to the WebSocket API with `?token=<Cognito token>`; an invalid token is refused with `401`, and a user without a profile with `403`.

| Message | Direction | Payload |
|---|---|---|
| `location.update` | client → server | `{ "action": "location.update", "latitude", "longitude", "timestamp" }` |
| `friends.refresh` | client → server | `{ "action": "friends.refresh" }` |
| `init.response` | server → client | `{ "type": "init.response", "friends": [{ friendId, latitude, longitude, lastUpdated, distanceMiles }] }` |
| `location.push` | server → client | `{ "type": "location.push", friendId, latitude, longitude, lastUpdated, distanceMiles }` |
| `error` | server → client | `{ "type": "error", "message" }` for an invalid `location.update` |

## Out of scope

- Peer-to-peer connections between clients (everything goes through the backend)
- Travel distance or routing (distance is always straight-line, Haversine)
- Strong consistency for locations; a few seconds of delay is acceptable
- GDPR/CCPA compliance
