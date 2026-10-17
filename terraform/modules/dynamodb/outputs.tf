output "users_table_name" {
  value = aws_dynamodb_table.users.name
}

output "users_table_arn" {
  value = aws_dynamodb_table.users.arn
}

output "connections_table_name" {
  value = aws_dynamodb_table.connections.name
}

output "connections_table_arn" {
  value = aws_dynamodb_table.connections.arn
}

output "connections_table_stream_arn" {
  value = aws_dynamodb_table.connections.stream_arn
}

output "friend_requests_table_name" {
  value = aws_dynamodb_table.friend_requests.name
}

output "friend_requests_table_arn" {
  value = aws_dynamodb_table.friend_requests.arn
}

output "friendships_table_name" {
  value = aws_dynamodb_table.friendships.name
}

output "friendships_table_arn" {
  value = aws_dynamodb_table.friendships.arn
}
