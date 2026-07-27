#!/usr/bin/env bash

set -euo pipefail

readonly expected_account_id='454921778743'
readonly region='eu-central-1'
readonly stack_name='serverless-order-integration-dev'
readonly artifact_bucket='soi-artifacts-454921778743-eu-central-1'
readonly artifact_prefix='serverless-order-integration-dev/'
readonly execution_role_arn='arn:aws:iam::454921778743:role/serverless-order-integration-cloudformation-execution'
readonly maximum_artifact_bytes=$((50 * 1024 * 1024))
readonly packaged_template='.aws-sam/cloud-packaged.yaml'

fail() {
  echo "Prepare failed: $*" >&2
  exit 1
}

require_secret() {
  local name="$1"
  local value="$2"
  ((${#value} >= 32)) || fail "$name must contain at least 32 characters."
}

[[ "${GITHUB_SHA:-}" =~ ^[0-9a-f]{40}$ ]] ||
  fail 'GITHUB_SHA must be the full lowercase commit SHA.'
[[ "${GITHUB_RUN_ID:-}" =~ ^[0-9]+$ ]] || fail 'GITHUB_RUN_ID must be numeric.'
[[ "${VENDOR_BASE_URL:-}" =~ ^https://[a-z0-9-]+\.trycloudflare\.com/?$ ]] ||
  fail 'VENDOR_BASE_URL must be a reviewed HTTPS Quick Tunnel root URL.'
require_secret CURSOR_SIGNING_SECRET "${CURSOR_SIGNING_SECRET:-}"
require_secret WEBHOOK_SIGNING_SECRET "${WEBHOOK_SIGNING_SECRET:-}"
require_secret VENDOR_AUTH_TOKEN "${VENDOR_AUTH_TOKEN:-}"

actual_account_id="$(
  aws sts get-caller-identity --query Account --output text --no-cli-pager
)"
[[ "$actual_account_id" == "$expected_account_id" ]] ||
  fail "expected AWS account $expected_account_id, received $actual_account_id."

vendor_status="$(
  curl \
    --silent \
    --show-error \
    --output /dev/null \
    --write-out '%{http_code}' \
    --connect-timeout 5 \
    --max-time 10 \
    "$VENDOR_BASE_URL/"
)"
[[ "$vendor_status" == '404' ]] ||
  fail "the Quick Tunnel did not expose the mock vendor (expected HTTP 404 at /, received $vendor_status)."

[[ -f '.aws-sam/cloud-build/template.yaml' ]] ||
  fail 'the deployable SAM build is missing.'

build_bytes="$(du --bytes --summarize .aws-sam/cloud-build | cut -f1)"
[[ "$build_bytes" =~ ^[0-9]+$ ]] || fail 'could not measure the SAM build.'
((build_bytes <= maximum_artifact_bytes)) ||
  fail "the SAM build exceeds the permanent 50 MB artifact cap."

existing_artifact_bytes="$(
  aws s3api list-objects-v2 \
    --bucket "$artifact_bucket" \
    --prefix "$artifact_prefix" \
    --query 'sum(Contents[].Size || `[]`)' \
    --output text \
    --region "$region" \
    --no-cli-pager
)"
[[ "$existing_artifact_bytes" == 'None' ]] && existing_artifact_bytes=0
[[ "$existing_artifact_bytes" =~ ^[0-9]+$ ]] ||
  fail 'could not measure existing deployment artifacts.'
((existing_artifact_bytes + build_bytes <= maximum_artifact_bytes)) ||
  fail 'existing objects plus the SAM build could exceed the permanent 50 MB artifact cap; destroy or wait for lifecycle cleanup.'

sam package \
  --template-file .aws-sam/cloud-build/template.yaml \
  --s3-bucket "$artifact_bucket" \
  --s3-prefix "${artifact_prefix%/}" \
  --output-template-file "$packaged_template" \
  --region "$region"

artifact_bytes="$(
  aws s3api list-objects-v2 \
    --bucket "$artifact_bucket" \
    --prefix "$artifact_prefix" \
    --query 'sum(Contents[].Size || `[]`)' \
    --output text \
    --region "$region" \
    --no-cli-pager
)"
[[ "$artifact_bytes" == 'None' ]] && artifact_bytes=0
[[ "$artifact_bytes" =~ ^[0-9]+$ ]] || fail 'could not verify packaged artifact size.'
((artifact_bytes <= maximum_artifact_bytes)) ||
  fail 'packaged artifacts exceeded the permanent 50 MB cap.'

change_set_type='CREATE'
describe_error="$(mktemp)"
parameters_file="$(mktemp)"
cleanup() {
  rm -f "$describe_error" "$parameters_file"
}
trap cleanup EXIT

if stack_status="$(
  aws cloudformation describe-stacks \
    --stack-name "$stack_name" \
    --query 'Stacks[0].StackStatus' \
    --output text \
    --region "$region" \
    --no-cli-pager \
    2>"$describe_error"
)"; then
  case "$stack_status" in
    CREATE_COMPLETE | UPDATE_COMPLETE | UPDATE_ROLLBACK_COMPLETE)
      change_set_type='UPDATE'
      ;;
    *)
      fail "stack $stack_name is in $stack_status; resolve it before preparing another change set."
      ;;
  esac
elif ! grep --quiet 'does not exist' "$describe_error"; then
  cat "$describe_error" >&2
  fail "could not determine whether stack $stack_name exists."
fi

jq \
  --null-input \
  --arg cursorSigningSecret "$CURSOR_SIGNING_SECRET" \
  --arg webhookSigningSecret "$WEBHOOK_SIGNING_SECRET" \
  --arg vendorBaseUrl "${VENDOR_BASE_URL%/}" \
  --arg vendorAuthToken "$VENDOR_AUTH_TOKEN" \
  '[
    {ParameterKey: "EnvironmentName", ParameterValue: "dev"},
    {ParameterKey: "MerchantId", ParameterValue: "mrc_demo"},
    {ParameterKey: "CursorSigningSecret", ParameterValue: $cursorSigningSecret},
    {ParameterKey: "WebhookSigningSecret", ParameterValue: $webhookSigningSecret},
    {ParameterKey: "WebhookToleranceSeconds", ParameterValue: "300"},
    {ParameterKey: "LogRetentionDays", ParameterValue: "1"},
    {ParameterKey: "ApiThrottleBurstLimit", ParameterValue: "2"},
    {ParameterKey: "ApiThrottleRateLimit", ParameterValue: "1"},
    {ParameterKey: "DynamoMaxReadRequestUnits", ParameterValue: "10"},
    {ParameterKey: "DynamoMaxWriteRequestUnits", ParameterValue: "10"},
    {ParameterKey: "StreamPublisherBatchSize", ParameterValue: "10"},
    {ParameterKey: "StreamPublisherMaximumRetryAttempts", ParameterValue: "2"},
    {ParameterKey: "StreamPublisherMaximumRecordAgeSeconds", ParameterValue: "3600"},
    {ParameterKey: "DeliveryWorkerBatchSize", ParameterValue: "2"},
    {ParameterKey: "DeliveryWorkerMaximumConcurrency", ParameterValue: "2"},
    {ParameterKey: "DeliveryWorkerTimeoutSeconds", ParameterValue: "15"},
    {ParameterKey: "DeliveryQueueVisibilityTimeoutSeconds", ParameterValue: "90"},
    {ParameterKey: "DeliveryQueueMaxReceiveCount", ParameterValue: "3"},
    {ParameterKey: "DeliveryMessageRetentionSeconds", ParameterValue: "86400"},
    {ParameterKey: "FailureMessageRetentionSeconds", ParameterValue: "86400"},
    {ParameterKey: "VendorBaseUrl", ParameterValue: $vendorBaseUrl},
    {ParameterKey: "VendorAuthToken", ParameterValue: $vendorAuthToken},
    {ParameterKey: "VendorTimeoutMs", ParameterValue: "3000"}
  ]' >"$parameters_file"

change_set_name="github-${GITHUB_SHA:0:12}-${GITHUB_RUN_ID}"
description="GitHub commit $GITHUB_SHA"

change_set_id="$(
  aws cloudformation create-change-set \
    --stack-name "$stack_name" \
    --change-set-name "$change_set_name" \
    --change-set-type "$change_set_type" \
    --description "$description" \
    --template-body "file://$packaged_template" \
    --parameters "file://$parameters_file" \
    --capabilities CAPABILITY_IAM \
    --role-arn "$execution_role_arn" \
    --tags \
    Key=Project,Value=serverless-order-integration \
    Key=Environment,Value=dev \
    Key=ManagedBy,Value=GitHubActions \
    Key=GitCommit,Value="$GITHUB_SHA" \
    --query Id \
    --output text \
    --region "$region" \
    --no-cli-pager
)"

if ! aws cloudformation wait change-set-create-complete \
  --stack-name "$stack_name" \
  --change-set-name "$change_set_name" \
  --region "$region" \
  --no-cli-pager; then
  aws cloudformation describe-change-set \
    --stack-name "$stack_name" \
    --change-set-name "$change_set_name" \
    --query '{Name:ChangeSetName,Status:Status,StatusReason:StatusReason,ExecutionStatus:ExecutionStatus}' \
    --output json \
    --region "$region" \
    --no-cli-pager >&2 || true
  fail 'change-set creation did not complete; no application change was executed.'
fi

aws cloudformation describe-change-set \
  --stack-name "$stack_name" \
  --change-set-name "$change_set_name" \
  --query '{Id:Id,Name:ChangeSetName,Type:ChangeSetType,Status:Status,ExecutionStatus:ExecutionStatus,Description:Description,Changes:Changes[*].ResourceChange.{Action:Action,LogicalResourceId:LogicalResourceId,ResourceType:ResourceType,Replacement:Replacement}}' \
  --output json \
  --region "$region" \
  --no-cli-pager

if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
  {
    echo '## Development change set prepared'
    echo
    echo "- Change set: \`$change_set_name\`"
    echo "- Type: \`$change_set_type\`"
    echo "- Commit: \`$GITHUB_SHA\`"
    echo "- Artifact bytes retained: \`$artifact_bytes\` / \`$maximum_artifact_bytes\`"
    echo '- No application change was executed.'
    echo
    echo 'After reviewing the changes above, run this workflow again with operation `execute` and the exact change-set name.'
  } >>"$GITHUB_STEP_SUMMARY"
fi

echo "Prepared change set $change_set_name ($change_set_id); nothing was executed."
