resource "aws_dynamodb_table" "users" {
  name         = "${var.project_name}-users"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "userId"

  attribute {
    name = "userId"
    type = "S"
  }

  tags = var.tags
}

resource "aws_dynamodb_table" "connections" {
  name             = "${var.project_name}-connections"
  billing_mode     = "PAY_PER_REQUEST"
  hash_key         = "connectionId"
  stream_enabled   = true
  stream_view_type = "NEW_AND_OLD_IMAGES"

  attribute {
    name = "connectionId"
    type = "S"
  }

  attribute {
    name = "userId"
    type = "S"
  }

  attribute {
    name = "geoCell"
    type = "S"
  }

  global_secondary_index {
    name            = "userId-index"
    hash_key        = "userId"
    projection_type = "ALL"
  }

  # Finds the connections near a point without scanning the table. Each connection with a
  # location stores the grid cell it is in (geoCell); a search queries only the few cells that
  # can contain anyone within the search radius. Connections without a location have no
  # geoCell, so they are not in this index at all.
  global_secondary_index {
    name            = "geoCell-index"
    hash_key        = "geoCell"
    projection_type = "ALL"
  }

  ttl {
    attribute_name = "expiresAt"
    enabled        = true
  }

  tags = var.tags
}

resource "aws_dynamodb_table" "friend_requests" {
  name         = "${var.project_name}-friend-requests"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "requestId"

  attribute {
    name = "requestId"
    type = "S"
  }

  attribute {
    name = "toUserId"
    type = "S"
  }

  attribute {
    name = "fromUserId"
    type = "S"
  }

  global_secondary_index {
    name            = "toUserId-index"
    hash_key        = "toUserId"
    projection_type = "ALL"
  }

  global_secondary_index {
    name            = "fromUserId-index"
    hash_key        = "fromUserId"
    projection_type = "ALL"
  }

  tags = var.tags
}

# One item per direction of a friendship: (userId, friendId) means "friendId is a friend of
# userId". A friendship is stored twice, once for each user, and both items are written (or
# removed) together in a single transaction.
resource "aws_dynamodb_table" "friendships" {
  name         = "${var.project_name}-friendships"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "userId"
  range_key    = "friendId"

  attribute {
    name = "userId"
    type = "S"
  }

  attribute {
    name = "friendId"
    type = "S"
  }

  # Reverse lookup: everyone who lists a given user as a friend (account deletion, blocking).
  global_secondary_index {
    name            = "friendId-index"
    hash_key        = "friendId"
    range_key       = "userId"
    projection_type = "ALL"
  }

  tags = var.tags
}
