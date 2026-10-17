data "aws_iam_policy_document" "lambda_assume_role" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

# --- WebSocket Handler Role ---

resource "aws_iam_role" "websocket_handler" {
  name               = "${var.project_name}-websocket-handler-role"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume_role.json
  tags               = var.tags
}

resource "aws_iam_role_policy" "websocket_handler" {
  name   = "${var.project_name}-websocket-handler-policy"
  role   = aws_iam_role.websocket_handler.id
  policy = data.aws_iam_policy_document.websocket_handler.json
}

data "aws_iam_policy_document" "websocket_handler" {
  statement {
    sid = "DynamoDBAccess"
    actions = [
      "dynamodb:GetItem",
      "dynamodb:PutItem",
      "dynamodb:DeleteItem",
      "dynamodb:Query",
      "dynamodb:UpdateItem",
    ]
    resources = [
      var.users_table_arn,
      var.connections_table_arn,
      "${var.connections_table_arn}/index/*",
    ]
  }

  # Lists a user's friends.
  statement {
    sid = "FriendshipsRead"
    actions = [
      "dynamodb:Query",
    ]
    resources = [
      var.friendships_table_arn,
    ]
  }

  statement {
    sid = "SSMAccess"
    actions = [
      "ssm:GetParameter",
      "ssm:GetParameters",
    ]
    resources = var.ssm_parameter_arns
  }

  statement {
    sid = "APIGatewayManagement"
    actions = [
      "execute-api:ManageConnections",
    ]
    resources = [
      "${var.websocket_api_arn}/*",
    ]
  }

  statement {
    sid = "CloudWatchLogs"
    actions = [
      "logs:CreateLogGroup",
      "logs:CreateLogStream",
      "logs:PutLogEvents",
    ]
    resources = ["arn:aws:logs:*:*:*"]
  }
}

resource "aws_iam_role_policy_attachment" "websocket_handler_basic" {
  role       = aws_iam_role.websocket_handler.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

# --- REST Handler Role ---

resource "aws_iam_role" "rest_handler" {
  name               = "${var.project_name}-rest-handler-role"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume_role.json
  tags               = var.tags
}

resource "aws_iam_role_policy" "rest_handler" {
  name   = "${var.project_name}-rest-handler-policy"
  role   = aws_iam_role.rest_handler.id
  policy = data.aws_iam_policy_document.rest_handler.json
}

data "aws_iam_policy_document" "rest_handler" {
  statement {
    sid = "DynamoDBAccess"
    actions = [
      "dynamodb:GetItem",
      "dynamodb:PutItem",
      "dynamodb:DeleteItem",
      "dynamodb:Query",
      "dynamodb:UpdateItem",
      "dynamodb:Scan",
    ]
    resources = [
      var.users_table_arn,
      var.connections_table_arn,
      "${var.connections_table_arn}/index/*",
      var.friend_requests_table_arn,
      "${var.friend_requests_table_arn}/index/*",
    ]
  }

  # Reads friendships and creates or removes them. A transaction is authorised through the
  # permissions of its individual operations (UpdateItem to create, DeleteItem to remove), so no
  # separate transaction action is needed.
  statement {
    sid = "FriendshipsAccess"
    actions = [
      "dynamodb:GetItem",
      "dynamodb:Query",
      "dynamodb:UpdateItem",
      "dynamodb:DeleteItem",
    ]
    resources = [
      var.friendships_table_arn,
      "${var.friendships_table_arn}/index/*",
    ]
  }

  statement {
    sid = "S3Access"
    actions = [
      "s3:GetObject",
      "s3:PutObject",
    ]
    resources = [
      "${var.s3_bucket_arn}/*",
    ]
  }

  statement {
    sid = "SSMAccess"
    actions = [
      "ssm:GetParameter",
      "ssm:GetParameters",
    ]
    resources = var.ssm_parameter_arns
  }

  statement {
    sid = "APIGatewayManagement"
    actions = [
      "execute-api:ManageConnections",
    ]
    resources = [
      "${var.websocket_api_arn}/*",
    ]
  }

  statement {
    sid = "CloudWatchLogs"
    actions = [
      "logs:CreateLogGroup",
      "logs:CreateLogStream",
      "logs:PutLogEvents",
    ]
    resources = ["arn:aws:logs:*:*:*"]
  }
}

resource "aws_iam_role_policy_attachment" "rest_handler_basic" {
  role       = aws_iam_role.rest_handler.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

# --- Fanout Handler Role ---

resource "aws_iam_role" "fanout_handler" {
  name               = "${var.project_name}-fanout-handler-role"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume_role.json
  tags               = var.tags
}

resource "aws_iam_role_policy" "fanout_handler" {
  name   = "${var.project_name}-fanout-handler-policy"
  role   = aws_iam_role.fanout_handler.id
  policy = data.aws_iam_policy_document.fanout_handler.json
}

data "aws_iam_policy_document" "fanout_handler" {
  statement {
    sid = "DynamoDBStreamAccess"
    actions = [
      "dynamodb:GetRecords",
      "dynamodb:GetShardIterator",
      "dynamodb:DescribeStream",
      "dynamodb:ListStreams",
    ]
    resources = [
      var.connections_table_stream_arn,
    ]
  }

  statement {
    sid = "DynamoDBTableAccess"
    actions = [
      "dynamodb:GetItem",
      "dynamodb:Query",
    ]
    resources = [
      var.users_table_arn,
      var.connections_table_arn,
      "${var.connections_table_arn}/index/*",
    ]
  }

  # Lists a user's friends.
  statement {
    sid = "FriendshipsRead"
    actions = [
      "dynamodb:Query",
    ]
    resources = [
      var.friendships_table_arn,
    ]
  }

  statement {
    sid = "SSMAccess"
    actions = [
      "ssm:GetParameter",
      "ssm:GetParameters",
    ]
    resources = var.ssm_parameter_arns
  }

  statement {
    sid = "APIGatewayManagement"
    actions = [
      "execute-api:ManageConnections",
    ]
    resources = [
      "${var.websocket_api_arn}/*",
    ]
  }

  statement {
    sid = "CloudWatchLogs"
    actions = [
      "logs:CreateLogGroup",
      "logs:CreateLogStream",
      "logs:PutLogEvents",
    ]
    resources = ["arn:aws:logs:*:*:*"]
  }
}

resource "aws_iam_role_policy_attachment" "fanout_handler_basic" {
  role       = aws_iam_role.fanout_handler.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}
