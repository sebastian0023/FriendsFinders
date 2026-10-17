variable "project_name" {
  description = "Project name prefix for resource naming"
  type        = string
}

variable "users_table_arn" {
  description = "ARN of the Users DynamoDB table"
  type        = string
}

variable "connections_table_arn" {
  description = "ARN of the Connections DynamoDB table"
  type        = string
}

variable "connections_table_stream_arn" {
  description = "ARN of the Connections DynamoDB table stream"
  type        = string
}

variable "friend_requests_table_arn" {
  description = "ARN of the FriendRequests DynamoDB table"
  type        = string
}

variable "friendships_table_arn" {
  description = "ARN of the Friendships DynamoDB table"
  type        = string
}

variable "s3_bucket_arn" {
  description = "ARN of the profile pictures S3 bucket"
  type        = string
}

variable "ssm_parameter_arns" {
  description = "ARNs of SSM parameters"
  type        = list(string)
}

variable "websocket_api_arn" {
  description = "ARN of the WebSocket API for execute-api permissions"
  type        = string
}

variable "tags" {
  description = "Tags to apply to all resources"
  type        = map(string)
  default     = {}
}
