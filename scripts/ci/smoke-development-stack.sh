#!/usr/bin/env bash

set -euo pipefail

readonly expected_account_id='454921778743'
readonly region='eu-central-1'
readonly stack_name='serverless-order-integration-dev'

fail() {
  echo "Smoke test failed: $*" >&2
  exit 1
}

actual_account_id="$(
  aws sts get-caller-identity --query Account --output text --no-cli-pager
)"
[[ "$actual_account_id" == "$expected_account_id" ]] ||
  fail "expected AWS account $expected_account_id, received $actual_account_id."

stack_status="$(
  aws cloudformation describe-stacks \
    --stack-name "$stack_name" \
    --query 'Stacks[0].StackStatus' \
    --output text \
    --region "$region" \
    --no-cli-pager
)"
[[ "$stack_status" == 'CREATE_COMPLETE' || "$stack_status" == 'UPDATE_COMPLETE' ]] ||
  fail "stack finished in unexpected status $stack_status."

api_url="$(
  aws cloudformation describe-stacks \
    --stack-name "$stack_name" \
    --query "Stacks[0].Outputs[?OutputKey=='ApiUrl'].OutputValue | [0]" \
    --output text \
    --region "$region" \
    --no-cli-pager
)"
[[ "$api_url" =~ ^https://[a-z0-9]+\.execute-api\.eu-central-1\.amazonaws\.com$ ]] ||
  fail 'the stack did not return the expected regional API URL.'

orders_status="$(
  curl \
    --silent \
    --show-error \
    --output /dev/null \
    --write-out '%{http_code}' \
    --connect-timeout 5 \
    --max-time 15 \
    "$api_url/orders?limit=1"
)"
[[ "$orders_status" == '401' ]] ||
  fail "the protected orders route returned HTTP $orders_status instead of 401."

webhook_status="$(
  curl \
    --silent \
    --show-error \
    --output /dev/null \
    --write-out '%{http_code}' \
    --connect-timeout 5 \
    --max-time 15 \
    --request POST \
    --header 'content-type: application/json' \
    --data '{}' \
    "$api_url/webhooks/vendor"
)"
[[ "$webhook_status" == '401' ]] ||
  fail "the unsigned webhook returned HTTP $webhook_status instead of 401."

if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
  {
    echo '## Development smoke test passed'
    echo
    echo "- Stack status: \`$stack_status\`"
    echo '- Protected order request without a JWT: `401`'
    echo '- Unsigned public webhook: `401`'
    echo '- AWS HTTP requests made: `2`'
  } >>"$GITHUB_STEP_SUMMARY"
fi

echo 'Development deployment smoke test passed with two bounded HTTP requests.'
