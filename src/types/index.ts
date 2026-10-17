export interface LocationUpdate {
  userId: string;
  latitude: number;
  longitude: number;
  timestamp: string;
}

export interface UserProfile {
  userId: string;
  displayName: string;
  profilePictureKey?: string;
  discoverable: boolean;
  createdAt: string;
}

export interface FriendRequest {
  requestId: string;
  fromUserId: string;
  toUserId: string;
  status: 'pending' | 'accepted' | 'declined';
  createdAt: string;
}

export interface ConnectionRecord {
  connectionId: string;
  userId: string;
  latitude?: number;
  longitude?: number;
  timestamp?: string;
  connectedAt: string;
  expiresAt: number;
}

export interface NearbyFriendEntry {
  friendId: string;
  latitude: number;
  longitude: number;
  lastUpdated: string;
  distanceMiles: number;
}

export interface NearbyFriendHttpEntry extends NearbyFriendEntry {
  displayName: string;
  profilePictureUrl?: string;
}

export interface NearbyStrangerEntry {
  userId: string;
  displayName: string;
  profilePictureUrl: string;
  distanceMiles: number;
}

export interface LocationUpdateMessage {
  action: 'location.update';
  latitude: number;
  longitude: number;
  timestamp: string;
}

export interface LocationPushMessage {
  type: 'location.push';
  friendId: string;
  latitude: number;
  longitude: number;
  lastUpdated: string;
  distanceMiles: number;
}

export interface InitResponseMessage {
  type: 'init.response';
  friends: NearbyFriendEntry[];
}
