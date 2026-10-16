data "archive_file" "websocket_handler" {
  type        = "zip"
  source_dir  = "${path.module}/../../../dist/websocket-handler"
  output_path = "${path.module}/../../../dist/websocket-handler.zip"
}

data "archive_file" "rest_handler" {
  type        = "zip"
  source_dir  = "${path.module}/../../../dist/rest-handler"
  output_path = "${path.module}/../../../dist/rest-handler.zip"
}

data "archive_file" "fanout_handler" {
  type        = "zip"
  source_dir  = "${path.module}/../../../dist/fanout-handler"
  output_path = "${path.module}/../../../dist/fanout-handler.zip"
}

resource "aws_lambda_function" "websocket_handler" {
  function_name = "${var.project_name}-websocket-handler"
  role          = var.websocket_handler_role_arn
  handler       = "index.handler"
  runtime       = "nodejs20.x"
  timeout       = 30
  memory_size   = 256

  filename         = data.archive_file.websocket_handler.output_path
  source_code_hash = data.archive_file.websocket_handler.output_base64sha256

  environment {
    variables = {
      USERS_TABLE_NAME             = var.users_table_name
      CONNECTIONS_TABLE_NAME       = var.connections_table_name
      S3_BUCKET_NAME               = var.s3_bucket_name
      WEBSOCKET_API_ENDPOINT       = replace(var.websocket_api_endpoint, "wss://", "https://")
      SSM_SEARCH_RADIUS            = "/nearby-friends/search-radius-miles"
      SSM_INACTIVITY_TTL           = "/nearby-friends/inactivity-ttl-seconds"
      SSM_LOCATION_UPDATE_INTERVAL = "/nearby-friends/location-update-interval-seconds"
      SSM_MAX_FRIENDS              = "/nearby-friends/max-friends"
      COGNITO_USER_POOL_ID         = var.cognito_user_pool_id
    }
  }

  tags = var.tags
}

resource "aws_lambda_function" "rest_handler" {
  function_name = "${var.project_name}-rest-handler"
  role          = var.rest_handler_role_arn
  handler       = "index.handler"
  runtime       = "nodejs20.x"
  timeout       = 30
  memory_size   = 256

  filename         = data.archive_file.rest_handler.output_path
  source_code_hash = data.archive_file.rest_handler.output_base64sha256

  environment {
    variables = {
      USERS_TABLE_NAME           = var.users_table_name
      CONNECTIONS_TABLE_NAME     = var.connections_table_name
      FRIEND_REQUESTS_TABLE_NAME = var.friend_requests_table_name
      S3_BUCKET_NAME             = var.s3_bucket_name
      WEBSOCKET_API_ENDPOINT     = replace(var.websocket_api_endpoint, "wss://", "https://")
      SSM_SEARCH_RADIUS          = "/nearby-friends/search-radius-miles"
      SSM_INACTIVITY_TTL         = "/nearby-friends/inactivity-ttl-seconds"
      SSM_MAX_FRIENDS            = "/nearby-friends/max-friends"
      SSM_NEARBY_STRANGERS_LIMIT = "/nearby-friends/nearby-strangers-limit"
    }
  }

  tags = var.tags
}

resource "aws_lambda_function" "fanout_handler" {
  function_name = "${var.project_name}-fanout-handler"
  role          = var.fanout_handler_role_arn
  handler       = "index.handler"
  runtime       = "nodejs20.x"
  timeout       = 30
  memory_size   = 256

  filename         = data.archive_file.fanout_handler.output_path
  source_code_hash = data.archive_file.fanout_handler.output_base64sha256

  environment {
    variables = {
      USERS_TABLE_NAME       = var.users_table_name
      CONNECTIONS_TABLE_NAME = var.connections_table_name
      S3_BUCKET_NAME         = var.s3_bucket_name
      WEBSOCKET_API_ENDPOINT = replace(var.websocket_api_endpoint, "wss://", "https://")
      SSM_SEARCH_RADIUS      = "/nearby-friends/search-radius-miles"
      SSM_INACTIVITY_TTL     = "/nearby-friends/inactivity-ttl-seconds"
    }
  }

  tags = var.tags
}

# DynamoDB Stream trigger for fanout handler
resource "aws_lambda_event_source_mapping" "connections_stream" {
  event_source_arn  = var.connections_table_stream_arn
  function_name     = aws_lambda_function.fanout_handler.arn
  starting_position = "LATEST"
  batch_size        = 10

  # The handler returns { batchItemFailures }; without this Lambda ignores the response
  # and treats every invocation as fully successful, silently dropping failed records.
  function_response_types = ["ReportBatchItemFailures"]

  # Give up on a failing record after 3 retries so it cannot block its shard for 24h.
  # Safe for this stream: the next location update (every ~30s) supersedes a dropped one.
  maximum_retry_attempts = 3

  filter_criteria {
    filter {
      pattern = jsonencode({ eventName = ["INSERT", "MODIFY", "REMOVE"] })
    }
  }
}
