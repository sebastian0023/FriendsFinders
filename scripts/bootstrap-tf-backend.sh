#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────────────
# One-time bootstrap: create the S3 bucket + DynamoDB table that hold Terraform
# remote state. Run this ONCE, locally, before `terraform init -migrate-state`.
#
# Requires: AWS CLI configured with credentials for the target account.
# These names must match the backend block in terraform/main.tf.
# ──────────────────────────────────────────────────────────────────────────────
set -euo pipefail

BUCKET="friendsfinders-tfstate-sebastian0023"
TABLE="friendsfinders-tf-lock"
REGION="us-east-1"

echo "Region:       $REGION"
echo "State bucket: $BUCKET"
echo "Lock table:   $TABLE"
echo

# ── S3 bucket for state ───────────────────────────────────────────────────────
if aws s3api head-bucket --bucket "$BUCKET" 2>/dev/null; then
  echo "Bucket $BUCKET already exists — skipping create."
else
  echo "Creating bucket $BUCKET ..."
  if [ "$REGION" = "us-east-1" ]; then
    # us-east-1 must NOT receive a LocationConstraint
    aws s3api create-bucket --bucket "$BUCKET" --region "$REGION"
  else
    aws s3api create-bucket --bucket "$BUCKET" --region "$REGION" \
      --create-bucket-configuration LocationConstraint="$REGION"
  fi
fi

echo "Enabling versioning ..."
aws s3api put-bucket-versioning --bucket "$BUCKET" \
  --versioning-configuration Status=Enabled

echo "Enabling default encryption ..."
aws s3api put-bucket-encryption --bucket "$BUCKET" \
  --server-side-encryption-configuration \
  '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"}}]}'

echo "Blocking public access ..."
aws s3api put-public-access-block --bucket "$BUCKET" \
  --public-access-block-configuration \
  BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true

# ── DynamoDB table for state locking ──────────────────────────────────────────
if aws dynamodb describe-table --table-name "$TABLE" --region "$REGION" >/dev/null 2>&1; then
  echo "Table $TABLE already exists — skipping create."
else
  echo "Creating lock table $TABLE ..."
  aws dynamodb create-table --table-name "$TABLE" --region "$REGION" \
    --attribute-definitions AttributeName=LockID,AttributeType=S \
    --key-schema AttributeName=LockID,KeyType=HASH \
    --billing-mode PAY_PER_REQUEST
  aws dynamodb wait table-exists --table-name "$TABLE" --region "$REGION"
fi

echo
echo "✅ Remote state backend ready."
echo "   Next: cd terraform && terraform init -migrate-state"
