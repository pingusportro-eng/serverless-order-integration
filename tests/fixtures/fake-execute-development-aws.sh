#!/usr/bin/bash

set -euo pipefail

printf '%s\n' "$*" >>"${FAKE_EXECUTE_COMMAND_LOG:?}"

service="${1:?AWS service is required}"
operation="${2:?AWS operation is required}"

case "$service:$operation" in
  sts:get-caller-identity)
    printf '%s\n' "${FAKE_EXECUTE_ACCOUNT_ID:-454921778743}"
    ;;
  cloudformation:describe-change-set)
    printf 'CREATE_COMPLETE\tAVAILABLE\tGitHub commit %s\n' "${GITHUB_SHA:?}"
    ;;
  cloudformation:describe-stacks)
    printf '%s\t%s\n' \
      "${FAKE_EXECUTE_STACK_STATUS:-REVIEW_IN_PROGRESS}" \
      "${FAKE_EXECUTE_ROLE_ARN:-arn:aws:iam::454921778743:role/serverless-order-integration-cloudformation-execution}"
    ;;
  cloudformation:execute-change-set | cloudformation:wait)
    ;;
  *)
    echo "Unexpected fake AWS command: $*" >&2
    exit 91
    ;;
esac
