#!/usr/bin/env bash

set -euo pipefail

readonly expected_account_id='454921778743'
readonly region='eu-central-1'
readonly stack_name='serverless-order-integration-dev'
readonly artifact_bucket='soi-artifacts-454921778743-eu-central-1'
readonly artifact_prefix='serverless-order-integration-dev/'
readonly execution_role_arn='arn:aws:iam::454921778743:role/serverless-order-integration-cloudformation-execution'

fail() {
  echo "Destroy failed: $*" >&2
  exit 1
}

[[ "${CONFIRM_DESTROY:-}" == "$stack_name" ]] ||
  fail "confirmation must exactly equal $stack_name."

actual_account_id="$(
  aws sts get-caller-identity --query Account --output text --no-cli-pager
)"
[[ "$actual_account_id" == "$expected_account_id" ]] ||
  fail "expected AWS account $expected_account_id, received $actual_account_id."

describe_error="$(mktemp)"
cleanup() {
  rm -f "$describe_error"
}
trap cleanup EXIT

if aws cloudformation describe-stacks \
  --stack-name "$stack_name" \
  --region "$region" \
  --no-cli-pager \
  >/dev/null \
  2>"$describe_error"; then
  aws cloudformation delete-stack \
    --stack-name "$stack_name" \
    --role-arn "$execution_role_arn" \
    --region "$region" \
    --no-cli-pager
  aws cloudformation wait stack-delete-complete \
    --stack-name "$stack_name" \
    --region "$region" \
    --no-cli-pager
elif ! grep --quiet 'does not exist' "$describe_error"; then
  cat "$describe_error" >&2
  fail "could not determine whether stack $stack_name exists."
fi

artifact_uri="s3://$artifact_bucket/$artifact_prefix"
[[ "$artifact_uri" == 's3://soi-artifacts-454921778743-eu-central-1/serverless-order-integration-dev/' ]] ||
  fail 'refusing an unexpected artifact cleanup target.'

aws s3 rm "$artifact_uri" \
  --recursive \
  --only-show-errors \
  --region "$region" \
  --no-cli-pager

remaining_objects="$(
  aws s3api list-objects-v2 \
    --bucket "$artifact_bucket" \
    --prefix "$artifact_prefix" \
    --query 'length(Contents)' \
    --output text \
    --region "$region" \
    --no-cli-pager
)"
[[ "$remaining_objects" == '0' ]] ||
  fail "$remaining_objects deployment artifact objects remain."

if aws cloudformation describe-stacks \
  --stack-name "$stack_name" \
  --region "$region" \
  --no-cli-pager \
  >/dev/null 2>&1; then
  fail "stack $stack_name still exists after the delete waiter completed."
fi

if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
  {
    echo '## Development teardown complete'
    echo
    echo "- Application stack \`$stack_name\`: absent"
    echo "- Artifact prefix \`$artifact_prefix\`: empty"
    echo '- The empty lifecycle-managed bootstrap bucket and OIDC identities remain for reuse.'
    echo '- Expected retained application-resource cost: `$0`.'
  } >>"$GITHUB_STEP_SUMMARY"
fi

echo 'Development stack is absent and the exact artifact prefix is empty.'
