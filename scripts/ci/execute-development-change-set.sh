#!/usr/bin/env bash

set -euo pipefail

readonly expected_account_id='454921778743'
readonly region='eu-central-1'
readonly stack_name='serverless-order-integration-dev'
readonly execution_role_arn='arn:aws:iam::454921778743:role/serverless-order-integration-cloudformation-execution'

fail() {
  echo "Execute failed: $*" >&2
  exit 1
}

[[ "${GITHUB_SHA:-}" =~ ^[0-9a-f]{40}$ ]] ||
  fail 'GITHUB_SHA must be the full lowercase commit SHA.'
[[ "${CHANGE_SET_NAME:-}" =~ ^github-[0-9a-f]{12}-[0-9]+$ ]] ||
  fail 'CHANGE_SET_NAME must use the exact name printed by the prepare operation.'
[[ "$CHANGE_SET_NAME" == "github-${GITHUB_SHA:0:12}-"* ]] ||
  fail 'the change set was not prepared from the currently checked-out commit.'

actual_account_id="$(
  aws sts get-caller-identity --query Account --output text --no-cli-pager
)"
[[ "$actual_account_id" == "$expected_account_id" ]] ||
  fail "expected AWS account $expected_account_id, received $actual_account_id."

readarray -t change_set_metadata < <(
  aws cloudformation describe-change-set \
    --stack-name "$stack_name" \
    --change-set-name "$CHANGE_SET_NAME" \
    --query '[Status,ExecutionStatus,Description]' \
    --output text \
    --region "$region" \
    --no-cli-pager |
    tr '\t' '\n'
)

[[ "${change_set_metadata[0]:-}" == 'CREATE_COMPLETE' ]] ||
  fail 'the change set is not ready.'
[[ "${change_set_metadata[1]:-}" == 'AVAILABLE' ]] ||
  fail 'the change set is not available for execution.'
[[ "${change_set_metadata[2]:-}" == "GitHub commit $GITHUB_SHA" ]] ||
  fail 'the change set description does not bind it to this commit.'

readarray -t stack_metadata < <(
  aws cloudformation describe-stacks \
    --stack-name "$stack_name" \
    --query '[Stacks[0].StackStatus,Stacks[0].RoleARN]' \
    --output text \
    --region "$region" \
    --no-cli-pager |
    tr '\t' '\n'
)

[[ "${stack_metadata[1]:-}" == "$execution_role_arn" ]] ||
  fail 'the change set does not use the reviewed CloudFormation execution role.'

case "${stack_metadata[0]:-}" in
  REVIEW_IN_PROGRESS)
    waiter='stack-create-complete'
    ;;
  CREATE_COMPLETE | UPDATE_COMPLETE | UPDATE_ROLLBACK_COMPLETE)
    waiter='stack-update-complete'
    ;;
  *)
    fail "the stack is not ready for execution (${stack_metadata[0]:-missing status})."
    ;;
esac

aws cloudformation execute-change-set \
  --stack-name "$stack_name" \
  --change-set-name "$CHANGE_SET_NAME" \
  --region "$region" \
  --no-cli-pager

aws cloudformation wait "$waiter" \
  --stack-name "$stack_name" \
  --region "$region" \
  --no-cli-pager

bash scripts/ci/smoke-development-stack.sh

if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
  {
    echo
    echo "Executed reviewed change set \`$CHANGE_SET_NAME\`."
    echo 'The application remains deployed until a separately approved `destroy` operation.'
  } >>"$GITHUB_STEP_SUMMARY"
fi
