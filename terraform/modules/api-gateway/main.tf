# --- WebSocket API Routes & Integrations ---
# (The WebSocket API and stage are created in the root module to break circular dependencies)

resource "aws_apigatewayv2_integration" "websocket" {
  api_id             = var.websocket_api_id
  integration_type   = "AWS_PROXY"
  integration_uri    = var.websocket_handler_invoke_arn
  integration_method = "POST"
}

# $connect: token is validated inside the Lambda handler (WebSocket APIs do not support JWT authorizers)
resource "aws_apigatewayv2_route" "connect" {
  api_id    = var.websocket_api_id
  route_key = "$connect"
  target    = "integrations/${aws_apigatewayv2_integration.websocket.id}"
}

resource "aws_apigatewayv2_route" "disconnect" {
  api_id    = var.websocket_api_id
  route_key = "$disconnect"
  target    = "integrations/${aws_apigatewayv2_integration.websocket.id}"
}

resource "aws_apigatewayv2_route" "location_update" {
  api_id    = var.websocket_api_id
  route_key = "location.update"
  target    = "integrations/${aws_apigatewayv2_integration.websocket.id}"
}

resource "aws_apigatewayv2_route" "friends_refresh" {
  api_id    = var.websocket_api_id
  route_key = "friends.refresh"
  target    = "integrations/${aws_apigatewayv2_integration.websocket.id}"
}

resource "aws_lambda_permission" "websocket" {
  statement_id  = "AllowAPIGatewayWebSocket"
  action        = "lambda:InvokeFunction"
  function_name = var.websocket_handler_function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${var.websocket_api_execution_arn}/*/*"
}

# --- HTTP API ---

resource "aws_apigatewayv2_api" "http" {
  name          = "${var.project_name}-http"
  protocol_type = "HTTP"

  cors_configuration {
    allow_origins = ["*"]
    allow_methods = ["GET", "POST", "PUT", "DELETE", "OPTIONS"]
    allow_headers = ["Content-Type", "Authorization"]
    max_age       = 300
  }

  tags = var.tags
}

resource "aws_apigatewayv2_stage" "http" {
  api_id      = aws_apigatewayv2_api.http.id
  name        = "$default"
  auto_deploy = true

  tags = var.tags
}

resource "aws_apigatewayv2_integration" "http" {
  api_id                 = aws_apigatewayv2_api.http.id
  integration_type       = "AWS_PROXY"
  integration_uri        = var.rest_handler_invoke_arn
  integration_method     = "POST"
  payload_format_version = "2.0"
}

# JWT authorizer for HTTP API — validates Cognito id_token from Authorization header
resource "aws_apigatewayv2_authorizer" "http_jwt" {
  api_id           = aws_apigatewayv2_api.http.id
  authorizer_type  = "JWT"
  identity_sources = ["$request.header.Authorization"]
  name             = "cognito-jwt"

  jwt_configuration {
    audience = [var.web_client_id, var.mobile_client_id]
    issuer   = var.cognito_issuer_url
  }
}

locals {
  jwt_auth = {
    authorization_type = "JWT"
    authorizer_id      = aws_apigatewayv2_authorizer.http_jwt.id
  }
}

# Friend management routes
resource "aws_apigatewayv2_route" "get_friends" {
  api_id             = aws_apigatewayv2_api.http.id
  route_key          = "GET /friends"
  target             = "integrations/${aws_apigatewayv2_integration.http.id}"
  authorization_type = local.jwt_auth.authorization_type
  authorizer_id      = local.jwt_auth.authorizer_id
}

resource "aws_apigatewayv2_route" "delete_friends" {
  api_id             = aws_apigatewayv2_api.http.id
  route_key          = "DELETE /friends/{friendId}"
  target             = "integrations/${aws_apigatewayv2_integration.http.id}"
  authorization_type = local.jwt_auth.authorization_type
  authorizer_id      = local.jwt_auth.authorizer_id
}

# User profile routes
resource "aws_apigatewayv2_route" "get_profile" {
  api_id             = aws_apigatewayv2_api.http.id
  route_key          = "GET /users/{userId}/profile"
  target             = "integrations/${aws_apigatewayv2_integration.http.id}"
  authorization_type = local.jwt_auth.authorization_type
  authorizer_id      = local.jwt_auth.authorizer_id
}

resource "aws_apigatewayv2_route" "put_profile" {
  api_id             = aws_apigatewayv2_api.http.id
  route_key          = "PUT /users/{userId}/profile"
  target             = "integrations/${aws_apigatewayv2_integration.http.id}"
  authorization_type = local.jwt_auth.authorization_type
  authorizer_id      = local.jwt_auth.authorizer_id
}

resource "aws_apigatewayv2_route" "get_profile_picture_upload_url" {
  api_id             = aws_apigatewayv2_api.http.id
  route_key          = "GET /users/{userId}/profile-picture-upload-url"
  target             = "integrations/${aws_apigatewayv2_integration.http.id}"
  authorization_type = local.jwt_auth.authorization_type
  authorizer_id      = local.jwt_auth.authorizer_id
}

# Nearby friends route (one-shot HTTP snapshot; live updates still use WebSocket)
resource "aws_apigatewayv2_route" "get_nearby_friends" {
  api_id             = aws_apigatewayv2_api.http.id
  route_key          = "GET /nearby-friends"
  target             = "integrations/${aws_apigatewayv2_integration.http.id}"
  authorization_type = local.jwt_auth.authorization_type
  authorizer_id      = local.jwt_auth.authorizer_id
}

# Nearby strangers route
resource "aws_apigatewayv2_route" "get_nearby_strangers" {
  api_id             = aws_apigatewayv2_api.http.id
  route_key          = "GET /nearby-strangers"
  target             = "integrations/${aws_apigatewayv2_integration.http.id}"
  authorization_type = local.jwt_auth.authorization_type
  authorizer_id      = local.jwt_auth.authorizer_id
}

# Friend request routes
resource "aws_apigatewayv2_route" "post_friend_request" {
  api_id             = aws_apigatewayv2_api.http.id
  route_key          = "POST /friend-requests/{toUserId}"
  target             = "integrations/${aws_apigatewayv2_integration.http.id}"
  authorization_type = local.jwt_auth.authorization_type
  authorizer_id      = local.jwt_auth.authorizer_id
}

resource "aws_apigatewayv2_route" "get_friend_requests" {
  api_id             = aws_apigatewayv2_api.http.id
  route_key          = "GET /friend-requests"
  target             = "integrations/${aws_apigatewayv2_integration.http.id}"
  authorization_type = local.jwt_auth.authorization_type
  authorizer_id      = local.jwt_auth.authorizer_id
}

resource "aws_apigatewayv2_route" "accept_friend_request" {
  api_id             = aws_apigatewayv2_api.http.id
  route_key          = "PUT /friend-requests/{requestId}/accept"
  target             = "integrations/${aws_apigatewayv2_integration.http.id}"
  authorization_type = local.jwt_auth.authorization_type
  authorizer_id      = local.jwt_auth.authorizer_id
}

resource "aws_apigatewayv2_route" "decline_friend_request" {
  api_id             = aws_apigatewayv2_api.http.id
  route_key          = "PUT /friend-requests/{requestId}/decline"
  target             = "integrations/${aws_apigatewayv2_integration.http.id}"
  authorization_type = local.jwt_auth.authorization_type
  authorizer_id      = local.jwt_auth.authorizer_id
}

resource "aws_lambda_permission" "http" {
  statement_id  = "AllowAPIGatewayHTTP"
  action        = "lambda:InvokeFunction"
  function_name = var.rest_handler_function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.http.execution_arn}/*/*"
}
