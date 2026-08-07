terraform {
  required_version = ">= 1.0"

  # Remote state — required so CI (ephemeral runners) shares one state file.
  # The bucket + lock table are created once by scripts/bootstrap-tf-backend.sh.
  backend "s3" {
    bucket         = "friendsfinders-tfstate-sebastian0023"
    key            = "friendsfinders/terraform.tfstate"
    region         = "us-east-1"
    dynamodb_table = "friendsfinders-tf-lock"
    encrypt        = true
  }

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
    archive = {
      source  = "hashicorp/archive"
      version = "~> 2.0"
    }
    null = {
      source  = "hashicorp/null"
      version = "~> 3.0"
    }
  }
}

provider "aws" {
  region = var.aws_region
}

data "aws_caller_identity" "current" {}

# --- DynamoDB Tables ---

module "dynamodb" {
  source = "./modules/dynamodb"

  project_name = var.project_name
  tags         = var.tags
}

# --- S3 Bucket ---

module "s3" {
  source = "./modules/s3"

  project_name   = var.project_name
  aws_account_id = data.aws_caller_identity.current.account_id
  tags           = var.tags
}

# --- SSM Parameters ---

module "ssm" {
  source = "./modules/ssm"

  tags = var.tags
}

# --- WebSocket API (created early to break circular dependency) ---

resource "aws_apigatewayv2_api" "websocket" {
  name                       = "${var.project_name}-websocket"
  protocol_type              = "WEBSOCKET"
  route_selection_expression = "$request.body.action"

  tags = var.tags
}

resource "aws_apigatewayv2_stage" "websocket" {
  api_id      = aws_apigatewayv2_api.websocket.id
  name        = "prod"
  auto_deploy = true

  default_route_settings {
    throttling_burst_limit = 100
    throttling_rate_limit  = 50
  }

  tags = var.tags
}

locals {
  websocket_api_endpoint = "${aws_apigatewayv2_api.websocket.api_endpoint}/${aws_apigatewayv2_stage.websocket.name}"
  websocket_api_arn      = aws_apigatewayv2_api.websocket.execution_arn
}

# --- IAM Roles ---

module "iam" {
  source = "./modules/iam"

  project_name                = var.project_name
  users_table_arn             = module.dynamodb.users_table_arn
  connections_table_arn       = module.dynamodb.connections_table_arn
  connections_table_stream_arn = module.dynamodb.connections_table_stream_arn
  friend_requests_table_arn   = module.dynamodb.friend_requests_table_arn
  s3_bucket_arn               = module.s3.bucket_arn
  ssm_parameter_arns          = module.ssm.parameter_arns
  websocket_api_arn           = local.websocket_api_arn
  tags                        = var.tags
}

# --- Lambda Functions ---

module "lambda" {
  source = "./modules/lambda"

  project_name                = var.project_name
  websocket_handler_role_arn  = module.iam.websocket_handler_role_arn
  rest_handler_role_arn       = module.iam.rest_handler_role_arn
  fanout_handler_role_arn     = module.iam.fanout_handler_role_arn
  users_table_name            = module.dynamodb.users_table_name
  connections_table_name      = module.dynamodb.connections_table_name
  friend_requests_table_name  = module.dynamodb.friend_requests_table_name
  connections_table_stream_arn = module.dynamodb.connections_table_stream_arn
  s3_bucket_name              = module.s3.bucket_name
  websocket_api_endpoint      = local.websocket_api_endpoint
  cognito_user_pool_id        = module.cognito.user_pool_id
  tags                        = var.tags
}

# --- API Gateway Routes & Integrations ---

module "api_gateway" {
  source = "./modules/api-gateway"

  project_name                    = var.project_name
  websocket_api_id                = aws_apigatewayv2_api.websocket.id
  websocket_api_execution_arn     = aws_apigatewayv2_api.websocket.execution_arn
  websocket_handler_invoke_arn    = module.lambda.websocket_handler_invoke_arn
  websocket_handler_function_name = module.lambda.websocket_handler_function_name
  rest_handler_invoke_arn         = module.lambda.rest_handler_invoke_arn
  rest_handler_function_name      = module.lambda.rest_handler_function_name
  cognito_issuer_url              = module.cognito.issuer_url
  web_client_id                   = module.cognito.web_client_id
  mobile_client_id                = module.cognito.mobile_client_id
  tags                            = var.tags
}

# --- Frontend infrastructure (S3 + CloudFront) ---
# Created first so its CloudFront URL can be passed to Cognito as a callback URL.

module "frontend" {
  source = "./modules/frontend"

  project_name   = var.project_name
  aws_account_id = data.aws_caller_identity.current.account_id
  tags           = var.tags
}

# --- Cognito ---
# Depends on frontend so it can register the CloudFront URL as an OAuth callback.

module "cognito" {
  source = "./modules/cognito"

  project_name          = var.project_name
  cognito_domain_prefix = "${var.project_name}-${data.aws_caller_identity.current.account_id}"
  callback_urls         = ["${module.frontend.cloudfront_url}/"]
  logout_urls           = ["${module.frontend.cloudfront_url}/"]
  tags                  = var.tags
}

# --- Frontend deploy (uploads index.html with injected runtime config) ---
# Depends on both frontend infra and Cognito.

module "frontend_deploy" {
  source = "./modules/frontend-deploy"

  frontend_bucket_name       = module.frontend.bucket_name
  cloudfront_distribution_id = module.frontend.cloudfront_distribution_id
  cognito_hosted_ui_base_url = module.cognito.hosted_ui_base_url
  cognito_web_client_id      = module.cognito.web_client_id
  http_api_endpoint          = module.api_gateway.http_api_endpoint
  websocket_api_endpoint     = local.websocket_api_endpoint
}

# --- Monitoring ---

module "monitoring" {
  source = "./modules/monitoring"

  websocket_handler_function_name = module.lambda.websocket_handler_function_name
  rest_handler_function_name      = module.lambda.rest_handler_function_name
  fanout_handler_function_name    = module.lambda.fanout_handler_function_name
  tags                            = var.tags
}
