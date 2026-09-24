# ──────────────────────────────────────────────────────────────────────────────
# CI/CD — GitHub Actions OIDC provider + deploy role
#
# Lets the GitHub Actions workflow assume an IAM role using a short-lived OIDC
# token — no long-lived AWS keys stored in GitHub. These resources are created
# by the FIRST local `terraform apply`; every push to main thereafter uses them.
# ──────────────────────────────────────────────────────────────────────────────

variable "github_repo" {
  description = "GitHub repo (owner/name) allowed to assume the deploy role"
  type        = string
  default     = "sebastian0023/FriendsFinders"
}

# GitHub's OIDC identity provider. There can be only ONE per AWS account — if
# one already exists, import it instead of creating it:
#   terraform import aws_iam_openid_connect_provider.github <existing-arn>
resource "aws_iam_openid_connect_provider" "github" {
  url            = "https://token.actions.githubusercontent.com"
  client_id_list = ["sts.amazonaws.com"]
  thumbprint_list = [
    "6938fd4d98bab03faadb97b34396831e3780aea1",
    "1c58a3a8518e8759bf075b76b750d4f2df264fca",
  ]
  tags = var.tags
}

# Trust policy: only the GitHub Actions workflow on the main branch of this
# repo may assume the role.
data "aws_iam_policy_document" "github_actions_trust" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRoleWithWebIdentity"]

    principals {
      type        = "Federated"
      identifiers = [aws_iam_openid_connect_provider.github.arn]
    }

    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:aud"
      values   = ["sts.amazonaws.com"]
    }

    condition {
      test     = "StringLike"
      variable = "token.actions.githubusercontent.com:sub"
      values   = ["repo:${var.github_repo}:ref:refs/heads/main"]
    }
  }
}

resource "aws_iam_role" "github_actions_deploy" {
  name               = "${var.project_name}-github-actions-deploy"
  assume_role_policy = data.aws_iam_policy_document.github_actions_trust.json
  tags               = var.tags
}

# Broad access so Terraform can manage the whole stack + remote state.
# For production, scope this down to the services actually used (Lambda, API
# Gateway, DynamoDB, S3, Cognito, CloudFront, IAM, SSM, CloudWatch) plus the
# state bucket and lock table.
resource "aws_iam_role_policy_attachment" "github_actions_admin" {
  role       = aws_iam_role.github_actions_deploy.name
  policy_arn = "arn:aws:iam::aws:policy/AdministratorAccess"
}

output "github_actions_deploy_role_arn" {
  description = "Set this as the GitHub Actions repo variable AWS_DEPLOY_ROLE_ARN"
  value       = aws_iam_role.github_actions_deploy.arn
}
