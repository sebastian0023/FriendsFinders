variable "project_name" {
  description = "Project name prefix for resource naming"
  type        = string
}

variable "websocket_handler_role_arn" {
  description = "IAM role ARN for the WebSocket handler Lambda"
  type        = string
}

variable "rest_handler_role_arn" {
  description = "IAM role ARN for the REST handler Lambda"
  type        = string
}

variable "fanout_handler_role_arn" {
  description = "IAM role ARN for the fanout handler Lambda"
  type        = string
}

variable "users_table_name" {
  description = "Name of the Users DynamoDB table"
  type        = string
}

variable "connections_table_name" {
  description = "Name of the Connections DynamoDB table"
  type        = string
}

variable "friend_requests_table_name" {
  description = "Name of the FriendRequests DynamoDB table"
  type        = string
}

variable "friendships_table_name" {
  description = "Name of the Friendships DynamoDB table"
  type        = string
}

variable "connections_table_stream_arn" {
  description = "ARN of the Connections DynamoDB table stream"
  type        = string
}

variable "s3_bucket_name" {
  description = "Name of the profile pictures S3 bucket"
  type        = string
}

variable "websocket_api_endpoint" {
  description = "WebSocket API endpoint URL"
  type        = string
}

variable "tags" {
  description = "Tags to apply to all resources"
  type        = map(string)
  default     = {}
}

variable "cognito_user_pool_id" {
  description = "Cognito User Pool ID for WebSocket token verification"
  type        = string
}
