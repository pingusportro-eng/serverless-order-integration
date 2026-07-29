#!/usr/bin/env bash

set -euo pipefail

readonly expected_account_id='454921778743'
readonly expected_region='eu-central-1'
readonly expected_profile='pingusportro-admin'
readonly expected_merchant_id='mrc_demo'
readonly budget_name='My Zero-Spend Budget'
readonly stack_name='serverless-order-integration-dev'
readonly drill_order_prefix='ord_vendor429drill'
readonly drill_reference_prefix='vendor-429-drill-'
readonly call_cap=200
readonly max_failed_vendor_attempts=4

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
default_state_directory="$project_root/.aws-sam/cloud-drill/vendor-rate-limit"

if [[ -n "${VENDOR_RATE_LIMIT_DRILL_AWS_CLI:-}" ||
  -n "${VENDOR_RATE_LIMIT_DRILL_PROCESS_CLI:-}" ||
  -n "${VENDOR_RATE_LIMIT_DRILL_STATE_DIRECTORY:-}" ||
  -n "${VENDOR_RATE_LIMIT_DRILL_POLL_SECONDS:-}" ]]; then
  if [[ "${VENDOR_RATE_LIMIT_DRILL_TEST_MODE:-}" != '1' ]]; then
    echo 'Drill overrides require VENDOR_RATE_LIMIT_DRILL_TEST_MODE=1.' >&2
    exit 2
  fi
fi

readonly test_mode="${VENDOR_RATE_LIMIT_DRILL_TEST_MODE:-0}"
readonly aws_cli="${VENDOR_RATE_LIMIT_DRILL_AWS_CLI:-aws}"
readonly process_cli="${VENDOR_RATE_LIMIT_DRILL_PROCESS_CLI:-}"
readonly state_directory="${VENDOR_RATE_LIMIT_DRILL_STATE_DIRECTORY:-$default_state_directory}"
readonly poll_seconds="${VENDOR_RATE_LIMIT_DRILL_POLL_SECONDS:-5}"
readonly state_file="$state_directory/state.json"
readonly token_file="$state_directory/vendor-token.json"
readonly parameter_file="$state_directory/cloudformation-parameters.json"
readonly order_item_file="$state_directory/order-item.json"
readonly cleanup_items_file="$state_directory/cleanup-items.json"
readonly attempt_log="$state_directory/vendor-attempts.jsonl"
readonly vendor_log="$state_directory/vendor.log"
readonly tunnel_log="$state_directory/cloudflared.log"
readonly call_log="$state_directory/aws-calls.log"

table_name=''
stream_arn=''
topic_arn=''
delivery_queue_url=''
delivery_queue_arn=''
worker_dlq_url=''
worker_dlq_arn=''
publisher_failure_queue_url=''
subscription_dlq_url=''
worker_function_name=''
worker_function_arn=''
worker_log_group=''
worker_mapping_uuid=''

usage() {
  cat <<'EOF'
Usage:
  scripts/cloud/vendor-rate-limit-dlq-drill.sh run
  scripts/cloud/vendor-rate-limit-dlq-drill.sh cleanup

The run mode configures one temporary local mock-vendor endpoint, inserts one
synthetic order, proves bounded 429 retries and worker-DLQ retention, performs
managed redrive after vendor recovery, and removes the marked data.

The cleanup mode resumes an interrupted approved run from validated ignored
state under .aws-sam/cloud-drill/vendor-rate-limit/.
EOF
}

fail() {
  echo "Vendor rate-limit drill: $*" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "required command not found: $1"
}

call_count() {
  local service="$1"
  if [[ ! -f "$call_log" ]]; then
    echo '0'
    return
  fi
  awk -v service="$service" '$1 == service { count += 1 } END { print count + 0 }' "$call_log"
}

operation_count() {
  local service="$1"
  local operation="$2"
  if [[ ! -f "$call_log" ]]; then
    echo '0'
    return
  fi
  awk -v service="$service" -v operation="$operation" '
    $1 == service && $2 == operation { count += 1 }
    END { print count + 0 }
  ' "$call_log"
}

assert_operation_headroom() {
  local service="$1"
  local operation="$2"
  local cap=0
  case "$service:$operation" in
    cloudformation:create-change-set) cap=2 ;;
    cloudformation:execute-change-set) cap=2 ;;
    dynamodb:put-item) cap=1 ;;
    dynamodb:transact-write-items) cap=2 ;;
    sqs:change-message-visibility) cap=2 ;;
    sqs:start-message-move-task) cap=1 ;;
  esac
  if ((cap > 0)); then
    local current
    current="$(operation_count "$service" "$operation")"
    ((current < cap)) ||
      fail "$service $operation mutation cap of $cap would be exceeded"
  fi
}

aws_call() {
  local counted_service="$1"
  shift
  local command_service="${1:-}"
  local operation="${2:-}"
  [[ "$counted_service" == "$command_service" ]] ||
    fail "internal AWS service mismatch: $counted_service != $command_service"

  local current
  current="$(call_count "$counted_service")"
  ((current < call_cap)) ||
    fail "$counted_service API-call cap of $call_cap would be exceeded"
  assert_operation_headroom "$counted_service" "$operation"

  printf '%s %s\n' "$counted_service" "$operation" >>"$call_log"
  "$aws_cli" "$@" \
    --profile "$expected_profile" \
    --region "$expected_region" \
    --no-cli-pager
}

budget_call() {
  local current
  current="$(call_count budgets)"
  ((current < call_cap)) || fail "budgets API-call cap of $call_cap would be exceeded"
  printf 'budgets describe-budget\n' >>"$call_log"
  "$aws_cli" budgets describe-budget \
    --account-id "$expected_account_id" \
    --budget-name "$budget_name" \
    --profile "$expected_profile" \
    --region us-east-1 \
    --no-cli-pager \
    --output json
}

state_string() {
  local field="$1"
  jq -er --arg field "$field" '
    if (.[$field] | type) == "string" then
      .[$field]
    else
      error("state field must be a string: " + $field)
    end
  ' "$state_file"
}

state_boolean() {
  local field="$1"
  jq -er --arg field "$field" '
    if (.[$field] | type) == "boolean" then
      .[$field]
    else
      error("state field must be a boolean: " + $field)
    end
  ' "$state_file"
}

state_set_string() {
  local field="$1"
  local value="$2"
  local temporary="$state_file.tmp"
  jq --arg field "$field" --arg value "$value" '.[$field] = $value' \
    "$state_file" >"$temporary"
  chmod 600 "$temporary"
  mv "$temporary" "$state_file"
}

state_set_boolean() {
  local field="$1"
  local value="$2"
  local temporary="$state_file.tmp"
  jq --arg field "$field" --argjson value "$value" '.[$field] = $value' \
    "$state_file" >"$temporary"
  chmod 600 "$temporary"
  mv "$temporary" "$state_file"
}

state_create() {
  local suffix="$1"
  local started_at_ms="$2"
  local order_id="$drill_order_prefix$suffix"
  local merchant_reference="$drill_reference_prefix$suffix"
  local submission_key="submission_vendor429drill$suffix"
  local correlation_id="corr.vendor429drill.$suffix"
  local causation_id="request.vendor429drill.$suffix"

  jq -n \
    --arg accountId "$expected_account_id" \
    --arg region "$expected_region" \
    --arg stackName "$stack_name" \
    --arg suffix "$suffix" \
    --arg startedAtMs "$started_at_ms" \
    --arg orderId "$order_id" \
    --arg merchantReference "$merchant_reference" \
    --arg submissionKey "$submission_key" \
    --arg correlationId "$correlation_id" \
    --arg causationId "$causation_id" \
    --arg tableName "$table_name" \
    --arg streamArn "$stream_arn" \
    --arg topicArn "$topic_arn" \
    --arg deliveryQueueUrl "$delivery_queue_url" \
    --arg deliveryQueueArn "$delivery_queue_arn" \
    --arg workerDlqUrl "$worker_dlq_url" \
    --arg workerDlqArn "$worker_dlq_arn" \
    --arg publisherFailureQueueUrl "$publisher_failure_queue_url" \
    --arg subscriptionDlqUrl "$subscription_dlq_url" \
    --arg workerFunctionName "$worker_function_name" \
    --arg workerFunctionArn "$worker_function_arn" \
    --arg workerLogGroup "$worker_log_group" \
    --arg workerMappingUuid "$worker_mapping_uuid" '
      {
        accountId: $accountId,
        region: $region,
        stackName: $stackName,
        suffix: $suffix,
        startedAtMs: $startedAtMs,
        orderId: $orderId,
        merchantReference: $merchantReference,
        submissionKey: $submissionKey,
        correlationId: $correlationId,
        causationId: $causationId,
        tableName: $tableName,
        streamArn: $streamArn,
        topicArn: $topicArn,
        deliveryQueueUrl: $deliveryQueueUrl,
        deliveryQueueArn: $deliveryQueueArn,
        workerDlqUrl: $workerDlqUrl,
        workerDlqArn: $workerDlqArn,
        publisherFailureQueueUrl: $publisherFailureQueueUrl,
        subscriptionDlqUrl: $subscriptionDlqUrl,
        workerFunctionName: $workerFunctionName,
        workerFunctionArn: $workerFunctionArn,
        workerLogGroup: $workerLogGroup,
        workerMappingUuid: $workerMappingUuid,
        vendorRunning: false,
        tunnelRunning: false,
        tunnelUrl: "",
        changeSetName: "",
        stackUpdated: false,
        orderWriteAttempted: false,
        orderWritten: false,
        dlqReceiptHandle: "",
        eventId: "",
        dlqVerified: false,
        visibilityRestored: false,
        failureEvidenceVerified: false,
        redriveTaskHandle: "",
        redriveStartedAtMs: "",
        redriveStarted: false,
        redriveCompleted: false,
        orderSubmitted: false,
        dataDeleteAttempted: false,
        dataDeleted: false
      }
    ' >"$state_file"
  chmod 600 "$state_file"
}

assert_identity() {
  local account_id
  account_id="$(aws_call sts sts get-caller-identity --query Account --output text)"
  [[ "$account_id" == "$expected_account_id" ]] ||
    fail "expected account $expected_account_id, received $account_id"
}

assert_budget() {
  local response
  response="$(budget_call)"
  jq -e '
    .Budget.BudgetLimit.Unit == "USD" and
    (.Budget.BudgetLimit.Amount | tonumber) >= 1 and
    (.Budget.CalculatedSpend.ActualSpend.Amount | tonumber) < 1 and
    (.Budget.CalculatedSpend.ForecastedSpend.Amount | tonumber) < 1
  ' <<<"$response" >/dev/null ||
    fail 'budget is absent, unhealthy, or already at its one-dollar limit'
}

stack_output() {
  local output_key="$1"
  aws_call cloudformation cloudformation describe-stacks \
    --stack-name "$stack_name" \
    --query "Stacks[0].Outputs[?OutputKey=='$output_key'].OutputValue | [0]" \
    --output text
}

stack_resource() {
  local logical_id="$1"
  aws_call cloudformation cloudformation describe-stack-resource \
    --stack-name "$stack_name" \
    --logical-resource-id "$logical_id" \
    --query StackResourceDetail.PhysicalResourceId \
    --output text
}

stack_status() {
  aws_call cloudformation cloudformation describe-stacks \
    --stack-name "$stack_name" \
    --query 'Stacks[0].StackStatus' \
    --output text
}

assert_stack_status() {
  local status
  status="$(stack_status)"
  [[ "$status" == 'CREATE_COMPLETE' || "$status" == 'UPDATE_COMPLETE' ]] ||
    fail "stack must be CREATE_COMPLETE or UPDATE_COMPLETE, received $status"
}

assert_stack_in_sync() {
  local detection_id
  local detection_status
  local drift_status
  detection_id="$(aws_call cloudformation cloudformation detect-stack-drift \
    --stack-name "$stack_name" \
    --query StackDriftDetectionId \
    --output text)"
  for _ in {1..36}; do
    detection_status="$(aws_call cloudformation cloudformation describe-stack-drift-detection-status \
      --stack-drift-detection-id "$detection_id" \
      --query DetectionStatus \
      --output text)"
    if [[ "$detection_status" == 'DETECTION_COMPLETE' ]]; then
      drift_status="$(aws_call cloudformation cloudformation describe-stack-drift-detection-status \
        --stack-drift-detection-id "$detection_id" \
        --query StackDriftStatus \
        --output text)"
      [[ "$drift_status" == 'IN_SYNC' ]] ||
        fail "stack drift status must be IN_SYNC, received $drift_status"
      return
    fi
    [[ "$detection_status" != 'DETECTION_FAILED' ]] ||
      fail 'stack drift detection failed'
    sleep "$poll_seconds"
  done
  fail 'stack drift detection did not complete within the bounded wait'
}

queue_attributes() {
  aws_call sqs sqs get-queue-attributes \
    --queue-url "$1" \
    --attribute-names All \
    --output json
}

queue_arn() {
  queue_attributes "$1" | jq -er '.Attributes.QueueArn'
}

assert_queue_empty() {
  local queue_url="$1"
  local response
  for attempt in {1..12}; do
    response="$(queue_attributes "$queue_url")"
    if jq -e '
      .Attributes.ApproximateNumberOfMessages == "0" and
      .Attributes.ApproximateNumberOfMessagesNotVisible == "0" and
      .Attributes.ApproximateNumberOfMessagesDelayed == "0"
    ' <<<"$response" >/dev/null; then
      return
    fi
    ((attempt == 12)) || sleep "$poll_seconds"
  done
  fail "queue did not report empty: $queue_url"
}

assert_deployed_queues_empty() {
  assert_queue_empty "$delivery_queue_url"
  assert_queue_empty "$worker_dlq_url"
  assert_queue_empty "$publisher_failure_queue_url"
  assert_queue_empty "$subscription_dlq_url"
}

resolve_resources() {
  table_name="$(stack_output OrdersTableName)"
  stream_arn="$(stack_output OrdersTableStreamArn)"
  topic_arn="$(stack_output DomainEventsTopicArn)"
  delivery_queue_url="$(stack_output DeliveryQueueUrl)"
  worker_dlq_url="$(stack_output DeliveryDeadLetterQueueUrl)"
  publisher_failure_queue_url="$(stack_output StreamPublisherFailureQueueUrl)"
  subscription_dlq_url="$(stack_output DeliverySubscriptionDeadLetterQueueUrl)"
  delivery_queue_arn="$(queue_arn "$delivery_queue_url")"
  worker_dlq_arn="$(queue_arn "$worker_dlq_url")"
  worker_function_name="$(stack_resource DeliveryWorkerFunction)"
  worker_log_group="$(stack_resource DeliveryWorkerLogGroup)"
  worker_function_arn="$(aws_call lambda lambda get-function-configuration \
    --function-name "$worker_function_name" \
    --query FunctionArn \
    --output text)"

  local mapping
  mapping="$(aws_call lambda lambda list-event-source-mappings \
    --function-name "$worker_function_name" \
    --event-source-arn "$delivery_queue_arn" \
    --output json)"
  worker_mapping_uuid="$(jq -er '.EventSourceMappings | select(length == 1) | .[0].UUID' \
    <<<"$mapping")"
}

assert_worker_contract() {
  local configuration
  local mapping
  local queue
  configuration="$(aws_call lambda lambda get-function-configuration \
    --function-name "$worker_function_name" \
    --query '{FunctionArn:FunctionArn,State:State,LastUpdateStatus:LastUpdateStatus,Timeout:Timeout,MemorySize:MemorySize,VendorTimeoutMs:Environment.Variables.VENDOR_TIMEOUT_MS}' \
    --output json)"
  jq -e \
    --arg arn "$worker_function_arn" '
      .FunctionArn == $arn and
      .State == "Active" and
      .LastUpdateStatus == "Successful" and
      .Timeout == 15 and
      .MemorySize == 128 and
      .VendorTimeoutMs == "3000"
    ' <<<"$configuration" >/dev/null ||
    fail 'delivery worker does not match the approved runtime contract'

  mapping="$(aws_call lambda lambda get-event-source-mapping \
    --uuid "$worker_mapping_uuid" \
    --output json)"
  jq -e \
    --arg queueArn "$delivery_queue_arn" '
      .State == "Enabled" and
      .EventSourceArn == $queueArn and
      .BatchSize == 2 and
      .FunctionResponseTypes == ["ReportBatchItemFailures"] and
      .ScalingConfig.MaximumConcurrency == 2
    ' <<<"$mapping" >/dev/null ||
    fail 'delivery-worker SQS mapping does not match the approved contract'

  queue="$(queue_attributes "$delivery_queue_url")"
  jq -e \
    --arg dlqArn "$worker_dlq_arn" '
      .Attributes.VisibilityTimeout == "90" and
      .Attributes.MessageRetentionPeriod == "86400" and
      (.Attributes.RedrivePolicy | fromjson |
        .deadLetterTargetArn == $dlqArn and .maxReceiveCount == 3)
    ' <<<"$queue" >/dev/null ||
    fail 'delivery queue does not match the approved retry contract'
}

assert_no_active_move_task() {
  local response
  response="$(aws_call sqs sqs list-message-move-tasks \
    --source-arn "$worker_dlq_arn" \
    --max-results 10 \
    --output json)"
  [[ -n "$response" ]] || response='{}'
  jq -e '[.Results[]? | select(.Status == "RUNNING")] | length == 0' \
    <<<"$response" >/dev/null ||
    fail 'the delivery-worker DLQ already has an active move task'
}

assert_no_local_setup() {
  local path
  for path in "$token_file" "$parameter_file" "$order_item_file" "$cleanup_items_file"; do
    [[ ! -e "$path" ]] ||
      fail "a previous drill input or secret remains without recovery state: $path"
  done

  if [[ "$test_mode" == '1' ]]; then
    "$process_cli" assert-stopped
    return
  fi
  if ps -eo args= | awk '
    /scripts\/mock-vendor\/start-local[.]mjs/ { found = 1 }
    /cloudflared tunnel/ && /127[.]0[.]0[.]1:4000/ { found = 1 }
    END { exit(found ? 0 : 1) }
  '; then
    fail 'a mock-vendor or port-4000 Quick Tunnel process is already running'
  fi
}

item_key_json() {
  jq -cn \
    --arg pk "MERCHANT#$expected_merchant_id" \
    --arg sk "ORDER#$(state_string orderId)" \
    '{pk: {S: $pk}, sk: {S: $sk}}'
}

read_order_item() {
  local response
  response="$(aws_call dynamodb dynamodb get-item \
    --table-name "$table_name" \
    --key "$(item_key_json)" \
    --consistent-read \
    --output json)"
  [[ -n "$response" ]] || response='{}'
  printf '%s\n' "$response"
}

assert_order_absent() {
  jq -e '.Item == null' <<<"$(read_order_item)" >/dev/null ||
    fail 'the generated drill order already exists'
}

assert_no_drill_orders() {
  local response
  response="$(aws_call dynamodb dynamodb scan \
    --table-name "$table_name" \
    --filter-expression 'begins_with(#order.#orderId, :prefix)' \
    --expression-attribute-names '{"#order":"order","#orderId":"orderId"}' \
    --expression-attribute-values "{\":prefix\":{\"S\":\"$drill_order_prefix\"}}" \
    --projection-expression 'pk, sk' \
    --consistent-read \
    --output json)"
  [[ -n "$response" ]] || response='{"Count":0,"Items":[]}'
  jq -e '.Count == 0 and (.Items | length) == 0' <<<"$response" >/dev/null ||
    fail 'a previous vendor rate-limit drill order remains'
}

generate_secret() {
  umask 077
  openssl rand -hex 32 | jq -R . >"$token_file"
  chmod 600 "$token_file"
}

process_start_vendor() {
  local scenario="$1"
  if [[ "$test_mode" == '1' ]]; then
    "$process_cli" start-vendor \
      --scenario "$scenario" \
      --token-file "$token_file" \
      --attempt-log "$attempt_log"
    state_set_boolean vendorRunning true
    return
  fi

  [[ -f "$project_root/dist/mock-vendor/mock-delivery-vendor.js" ]] ||
    fail 'built mock vendor is absent; run npm run build'
  local token
  token="$(jq -er . "$token_file")"
  MOCK_VENDOR_PORT=4000 \
    MOCK_VENDOR_SCENARIO="$scenario" \
    MOCK_VENDOR_TOKEN="$token" \
    MOCK_VENDOR_ATTEMPT_LOG="$attempt_log" \
    nohup node "$project_root/scripts/mock-vendor/start-local.mjs" \
    >"$vendor_log" 2>&1 &
  local pid=$!
  state_set_string vendorPid "$pid"
  state_set_boolean vendorRunning true

  for _ in {1..30}; do
    kill -0 "$pid" 2>/dev/null ||
      fail "mock vendor stopped during startup; see $vendor_log"
    local status
    status="$(curl --silent --output /dev/null --write-out '%{http_code}' \
      --request POST http://127.0.0.1:4000/deliveries || true)"
    [[ "$status" == '401' ]] && return
    sleep 1
  done
  fail "mock vendor was not ready within 30 seconds; see $vendor_log"
}

process_start_tunnel() {
  if [[ "$test_mode" == '1' ]]; then
    local url
    url="$("$process_cli" start-tunnel --origin http://127.0.0.1:4000)"
    [[ "$url" =~ ^https://[a-z0-9-]+\.trycloudflare\.com$ ]] ||
      fail 'fake tunnel returned an invalid URL'
    state_set_string tunnelUrl "$url"
    state_set_boolean tunnelRunning true
    return
  fi

  : >"$tunnel_log"
  nohup cloudflared tunnel --no-autoupdate --url http://127.0.0.1:4000 \
    >"$tunnel_log" 2>&1 &
  local pid=$!
  state_set_string tunnelPid "$pid"
  state_set_boolean tunnelRunning true
  for _ in {1..60}; do
    kill -0 "$pid" 2>/dev/null ||
      fail "Quick Tunnel stopped during startup; see $tunnel_log"
    local url
    url="$(grep -Eo 'https://[a-z0-9-]+\.trycloudflare\.com' "$tunnel_log" | head -1 || true)"
    if [[ -n "$url" ]]; then
      state_set_string tunnelUrl "$url"
      return
    fi
    sleep 1
  done
  fail "Quick Tunnel URL was not visible within 60 seconds; see $tunnel_log"
}

assert_tunnel_reachable() {
  local url
  url="$(state_string tunnelUrl)"
  if [[ "$test_mode" == '1' ]]; then
    "$process_cli" check-tunnel --url "$url"
    return
  fi

  local hostname="${url#https://}"
  local last_status='DNS_PENDING'
  for _ in {1..90}; do
    local address
    address="$(dig +time=2 +tries=1 +short @1.1.1.1 "$hostname" A | head -1 || true)"
    if [[ -z "$address" ]]; then
      sleep 1
      continue
    fi

    local status
    status="$(curl --silent --output /dev/null --write-out '%{http_code}' \
      --connect-timeout 5 \
      --max-time 10 \
      --resolve "$hostname:443:$address" \
      --request POST "$url/deliveries" || true)"
    [[ "$status" == '401' ]] && return
    last_status="$status"
    sleep 1
  done
  fail "Quick Tunnel did not expose the authenticated mock-vendor boundary; last status: $last_status"
}

process_stop_vendor() {
  [[ "$(state_boolean vendorRunning)" == 'true' ]] || return 0
  if [[ "$test_mode" == '1' ]]; then
    "$process_cli" stop-vendor
  else
    local pid
    pid="$(state_string vendorPid)"
    if kill -0 "$pid" 2>/dev/null; then
      local command
      command="$(ps -p "$pid" -o args=)"
      [[ "$command" == *'scripts/mock-vendor/start-local.mjs'* ]] ||
        fail 'saved vendor PID no longer belongs to the mock vendor'
      kill "$pid"
      wait "$pid" 2>/dev/null || true
    fi
  fi
  state_set_boolean vendorRunning false
}

process_stop_tunnel() {
  [[ "$(state_boolean tunnelRunning)" == 'true' ]] || return 0
  if [[ "$test_mode" == '1' ]]; then
    "$process_cli" stop-tunnel
  else
    local pid
    pid="$(state_string tunnelPid)"
    if kill -0 "$pid" 2>/dev/null; then
      local command
      command="$(ps -p "$pid" -o args=)"
      [[ "$command" == *'cloudflared tunnel'* ]] ||
        fail 'saved tunnel PID no longer belongs to cloudflared'
      kill "$pid"
      wait "$pid" 2>/dev/null || true
    fi
  fi
  state_set_boolean tunnelRunning false
}

create_worker_change_set() {
  local tunnel_url
  local change_set_name
  local parameter_keys
  local change_set_id
  tunnel_url="$(state_string tunnelUrl)"
  change_set_name="vendor-rate-limit-drill-$(state_string suffix)"
  state_set_string changeSetName "$change_set_name"

  parameter_keys="$(aws_call cloudformation cloudformation describe-stacks \
    --stack-name "$stack_name" \
    --query 'Stacks[0].Parameters[].ParameterKey' \
    --output json)"
  jq -n \
    --argjson keys "$parameter_keys" \
    --arg url "$tunnel_url" \
    --slurpfile token "$token_file" '
      $keys | map(
        if . == "VendorBaseUrl" then
          {ParameterKey: ., ParameterValue: $url}
        elif . == "VendorAuthToken" then
          {ParameterKey: ., ParameterValue: $token[0]}
        else
          {ParameterKey: ., UsePreviousValue: true}
        end
      )
    ' >"$parameter_file"
  chmod 600 "$parameter_file"

  change_set_id="$(aws_call cloudformation cloudformation create-change-set \
    --stack-name "$stack_name" \
    --change-set-name "$change_set_name" \
    --change-set-type UPDATE \
    --use-previous-template \
    --parameters "file://$parameter_file" \
    --capabilities CAPABILITY_IAM \
    --query Id \
    --output text)"
  rm -f "$parameter_file"
  [[ -n "$change_set_id" ]] || fail 'CloudFormation did not return a change-set ID'

  local response
  for _ in {1..36}; do
    response="$(aws_call cloudformation cloudformation describe-change-set \
      --stack-name "$stack_name" \
      --change-set-name "$change_set_name" \
      --output json)"
    if [[ "$(jq -r '.Status' <<<"$response")" == 'CREATE_COMPLETE' ]]; then
      jq -e '
        .ExecutionStatus == "AVAILABLE" and
        (.Changes | length) == 1 and
        .Changes[0].Type == "Resource" and
        .Changes[0].ResourceChange.Action == "Modify" and
        .Changes[0].ResourceChange.LogicalResourceId == "DeliveryWorkerFunction" and
        .Changes[0].ResourceChange.Replacement == "False"
      ' <<<"$response" >/dev/null ||
        fail 'change set contains a change outside the delivery-worker configuration'
      break
    fi
    [[ "$(jq -r '.Status' <<<"$response")" != 'FAILED' ]] ||
      fail 'worker endpoint change set failed to create'
    sleep "$poll_seconds"
  done
  [[ "$(jq -r '.Status' <<<"$response")" == 'CREATE_COMPLETE' ]] ||
    fail 'worker endpoint change set did not become ready'

  if [[ "${FAKE_VENDOR_DRILL_INTERRUPT_AFTER_CHANGE_SET:-0}" == '1' ]]; then
    fail 'forced test interruption after change-set creation'
  fi

  aws_call cloudformation cloudformation execute-change-set \
    --stack-name "$stack_name" \
    --change-set-name "$change_set_name" \
    --output json >/dev/null

  if [[ "${FAKE_VENDOR_DRILL_INTERRUPT_AFTER_CHANGE_SET_EXECUTION:-0}" == '1' ]]; then
    fail 'forced test interruption after change-set execution'
  fi

  for _ in {1..60}; do
    local status
    status="$(stack_status)"
    [[ "$status" != *'ROLLBACK'* && "$status" != *'FAILED'* ]] ||
      fail "worker endpoint stack update failed: $status"
    if [[ "$status" == 'UPDATE_COMPLETE' ]]; then
      local configuration
      configuration="$(aws_call lambda lambda get-function-configuration \
        --function-name "$worker_function_name" \
        --query '{State:State,LastUpdateStatus:LastUpdateStatus,VendorBaseUrl:Environment.Variables.VENDOR_BASE_URL}' \
        --output json)"
      if jq -e \
        --arg url "$tunnel_url" '
          .State == "Active" and
          .LastUpdateStatus == "Successful" and
          .VendorBaseUrl == $url
        ' <<<"$configuration" >/dev/null; then
        state_set_boolean stackUpdated true
        return
      fi
    fi
    sleep "$poll_seconds"
  done
  fail 'worker endpoint stack update did not complete within the bounded wait'
}

reconcile_stack_update() {
  [[ "$(state_boolean stackUpdated)" == 'false' ]] || return 0
  local tunnel_url
  tunnel_url="$(state_string tunnelUrl)"
  [[ -n "$tunnel_url" ]] || return 0

  local configuration
  configuration="$(aws_call lambda lambda get-function-configuration \
    --function-name "$worker_function_name" \
    --query '{State:State,LastUpdateStatus:LastUpdateStatus,VendorBaseUrl:Environment.Variables.VENDOR_BASE_URL}' \
    --output json)"
  if jq -e \
    --arg url "$tunnel_url" '
      .State == "Active" and
      .LastUpdateStatus == "Successful" and
      .VendorBaseUrl == $url
    ' <<<"$configuration" >/dev/null; then
    state_set_boolean stackUpdated true
  fi
}

cleanup_unexecuted_change_set() {
  [[ "$(state_boolean stackUpdated)" == 'false' ]] || return 0
  local change_set_name
  change_set_name="$(state_string changeSetName)"
  [[ -n "$change_set_name" ]] || return 0

  local response
  if response="$(aws_call cloudformation cloudformation describe-change-set \
    --stack-name "$stack_name" \
    --change-set-name "$change_set_name" \
    --output json 2>/dev/null)"; then
    local execution_status
    execution_status="$(jq -r '.ExecutionStatus // ""' <<<"$response")"
    if [[ "$execution_status" == 'AVAILABLE' || "$execution_status" == 'UNAVAILABLE' ]]; then
      aws_call cloudformation cloudformation delete-change-set \
        --stack-name "$stack_name" \
        --change-set-name "$change_set_name" \
        --output json >/dev/null
    fi
  fi
  state_set_string changeSetName ''
}

write_order_item_file() {
  local now
  local order_id
  local reference
  local submission_key
  local correlation_id
  local causation_id
  now="$(date -u +'%Y-%m-%dT%H:%M:%S.000Z')"
  order_id="$(state_string orderId)"
  reference="$(state_string merchantReference)"
  submission_key="$(state_string submissionKey)"
  correlation_id="$(state_string correlationId)"
  causation_id="$(state_string causationId)"
  jq -n \
    --arg merchantId "$expected_merchant_id" \
    --arg orderId "$order_id" \
    --arg reference "$reference" \
    --arg submissionKey "$submission_key" \
    --arg correlationId "$correlation_id" \
    --arg causationId "$causation_id" \
    --arg now "$now" '
      {
        pk: {S: ("MERCHANT#" + $merchantId)},
        sk: {S: ("ORDER#" + $orderId)},
        gsi1pk: {S: ("MERCHANT#" + $merchantId)},
        gsi1sk: {S: ("ORDER#" + $now + "#" + $orderId)},
        gsi2pk: {S: ("MERCHANT#" + $merchantId + "#STATUS#PENDING_SUBMISSION")},
        gsi2sk: {S: ("ORDER#" + $now + "#" + $orderId)},
        entityType: {S: "ORDER"},
        schemaVersion: {N: "1"},
        status: {S: "PENDING_SUBMISSION"},
        version: {N: "1"},
        order: {M: {
          orderId: {S: $orderId},
          merchantId: {S: $merchantId},
          merchantOrderReference: {S: $reference},
          status: {S: "PENDING_SUBMISSION"},
          items: {L: [{M: {
            itemReference: {S: "synthetic-item-1"},
            description: {S: "Synthetic drill item"},
            quantity: {N: "1"},
            unitPrice: {M: {amountMinor: {N: "1000"}, currency: {S: "RON"}}}
          }}]},
          total: {M: {amountMinor: {N: "1000"}, currency: {S: "RON"}}},
          pickup: {M: {
            addressLine: {S: "10 Synthetic Test Street"},
            city: {S: "Bucharest"},
            postalCode: {S: "010101"},
            countryCode: {S: "RO"}
          }},
          dropoff: {M: {
            addressLine: {S: "20 Synthetic Test Avenue"},
            city: {S: "Bucharest"},
            postalCode: {S: "020202"},
            countryCode: {S: "RO"}
          }},
          provider: {M: {
            providerCode: {S: "mock-delivery"},
            submissionKey: {S: $submissionKey}
          }},
          createdAt: {S: $now},
          updatedAt: {S: $now},
          version: {N: "1"}
        }},
        mutation: {M: {
          kind: {S: "ORDER_CREATED"},
          correlationId: {S: $correlationId},
          causationId: {S: $causationId}
        }}
      }
    ' >"$order_item_file"
  chmod 600 "$order_item_file"
}

write_order() {
  state_set_boolean orderWriteAttempted true
  write_order_item_file
  aws_call dynamodb dynamodb put-item \
    --table-name "$table_name" \
    --item "file://$order_item_file" \
    --condition-expression 'attribute_not_exists(pk) AND attribute_not_exists(sk)' \
    --return-consumed-capacity TOTAL \
    --output json >/dev/null
  state_set_boolean orderWritten true
  if [[ "${FAKE_VENDOR_DRILL_INTERRUPT_AFTER_ORDER:-0}" == '1' ]]; then
    fail 'forced test interruption after order write'
  fi
}

reconcile_order_write() {
  local item
  item="$(read_order_item)"
  if jq -e '.Item == null' <<<"$item" >/dev/null; then
    if [[ "$(state_boolean dataDeleteAttempted)" == 'true' ]]; then
      state_set_boolean dataDeleted true
    fi
    state_set_boolean orderWritten false
    return
  fi
  jq -e \
    --arg orderId "$(state_string orderId)" \
    --arg submissionKey "$(state_string submissionKey)" '
      .Item.entityType.S == "ORDER" and
      .Item.schemaVersion.N == "1" and
      .Item.order.M.orderId.S == $orderId and
      .Item.order.M.provider.M.submissionKey.S == $submissionKey
    ' <<<"$item" >/dev/null ||
    fail 'stored order does not match the retained drill identity'
  state_set_boolean orderWritten true
}

reconcile_redrive() {
  [[ "$(state_boolean redriveStarted)" == 'false' ]] || return 0
  local started_at
  started_at="$(state_string redriveStartedAtMs)"
  if [[ -z "$started_at" ]]; then
    return
  fi

  local response
  response="$(aws_call sqs sqs list-message-move-tasks \
    --source-arn "$worker_dlq_arn" \
    --max-results 10 \
    --output json)"
  [[ -n "$response" ]] || response='{}'
  local task
  task="$(jq -c \
    --arg sourceArn "$worker_dlq_arn" \
    --argjson startedAt "$started_at" '
      [
        .Results[]? |
        select(.SourceArn == $sourceArn and .StartedTimestamp >= $startedAt)
      ] | sort_by(.StartedTimestamp) | last // {}
    ' <<<"$response")"
  [[ "$task" != '{}' ]] || return 0

  local status
  status="$(jq -r '.Status // ""' <<<"$task")"
  [[ "$status" != 'FAILED' ]] || fail 'the retained managed-redrive task failed'
  if [[ "$status" == 'RUNNING' || "$status" == 'COMPLETED' ]]; then
    state_set_string redriveTaskHandle "$(jq -r '.TaskHandle // ""' <<<"$task")"
    state_set_boolean redriveStarted true
  fi
  if [[ "$status" == 'COMPLETED' ]]; then
    local moved
    moved="$(jq -er '.ApproximateNumberOfMessagesMoved // 0' <<<"$task")"
    [[ "$moved" =~ ^[0-9]+$ ]] ||
      fail 'retained managed redrive returned an invalid moved-message count'
    ((moved <= 1)) ||
      fail 'retained managed redrive moved more than one message'
    if ((moved == 1)); then
      state_set_boolean redriveCompleted true
    fi
  fi
}

receive_and_verify_dlq() {
  local response
  for _ in {1..48}; do
    response="$(aws_call sqs sqs receive-message \
      --queue-url "$worker_dlq_url" \
      --max-number-of-messages 2 \
      --wait-time-seconds 5 \
      --visibility-timeout 60 \
      --attribute-names All \
      --message-attribute-names All \
      --output json)"
    [[ -n "$response" ]] || response='{}'
    local count
    count="$(jq '.Messages // [] | length' <<<"$response")"
    if [[ "$count" == '0' ]]; then
      sleep "$poll_seconds"
      continue
    fi
    [[ "$count" == '1' ]] ||
      fail "expected one worker-DLQ message, received $count"
    jq -e \
      --arg orderId "$(state_string orderId)" \
      --arg submissionKey "$(state_string submissionKey)" \
      --arg correlationId "$(state_string correlationId)" '
        .Messages[0] as $message |
        ($message.Body | fromjson) as $event |
        $event.eventType == "order.created" and
        $event.schemaVersion == 1 and
        $event.aggregateId == $orderId and
        $event.aggregateVersion == 1 and
        $event.correlationId == $correlationId and
        $event.payload.merchantId == "mrc_demo" and
        $event.payload.status == "PENDING_SUBMISSION" and
        $event.payload.providerCode == "mock-delivery" and
        $event.payload.submissionKey == $submissionKey and
        ($message.Attributes.ApproximateReceiveCount | tonumber) > 3
      ' <<<"$response" >/dev/null ||
      fail 'worker DLQ contains an unexpected message; it was preserved'

    local receipt
    local event_id
    receipt="$(jq -er '.Messages[0].ReceiptHandle' <<<"$response")"
    event_id="$(jq -er '.Messages[0].Body | fromjson | .eventId' <<<"$response")"
    state_set_string dlqReceiptHandle "$receipt"
    state_set_string eventId "$event_id"
    state_set_boolean dlqVerified true
    return
  done
  fail 'marked rate-limited message did not reach the worker DLQ within eight minutes'
}

verify_failure_evidence() {
  local expected_digest
  local attempts
  expected_digest="$(printf %s "$(state_string submissionKey)" | sha256sum | awk '{print $1}')"
  [[ -f "$attempt_log" ]] || fail 'mock-vendor attempt journal is absent'
  attempts="$(jq -s \
    --arg digest "$expected_digest" \
    --arg correlationId "$(state_string correlationId)" '
      [
        .[] |
        select(
          .scenario == "rate-limit" and
          .statusCode == 429 and
          .correlationId == $correlationId and
          .idempotencyKeyDigest == $digest
        )
      ] | length
    ' "$attempt_log")"
  ((attempts >= 3 && attempts <= max_failed_vendor_attempts)) ||
    fail "expected three or four safe rate-limit attempts, received $attempts"

  local start_time
  local response
  local log_count
  start_time="$(state_string startedAtMs)"
  for _ in {1..24}; do
    response="$(aws_call logs logs filter-log-events \
      --log-group-name "$worker_log_group" \
      --start-time "$start_time" \
      --filter-pattern "\"$(state_string orderId)\"" \
      --output json)"
    log_count="$(jq \
      --arg eventId "$(state_string eventId)" \
      --arg orderId "$(state_string orderId)" '
        [
          .events[]?.message |
          split("\t") |
          .[-1] |
          fromjson? |
          select(
            .event == "delivery.message.failed" and
            .level == "error" and
            .operation == "processDeliveryEvent" and
            .eventId == $eventId and
            .orderId == $orderId and
            .exceptionName == "VendorSubmissionError"
          )
        ] | length
      ' <<<"$response")"
    if [[ "$log_count" == "$attempts" ]]; then
      state_set_boolean failureEvidenceVerified true
      return
    fi
    ((log_count <= attempts)) ||
      fail "received more marked worker failures than vendor attempts: $log_count > $attempts"
    sleep "$poll_seconds"
  done
  fail 'marked worker failure logs did not match the vendor attempt journal'
}

restore_dlq_visibility() {
  [[ "$(state_boolean visibilityRestored)" == 'false' ]] || return 0
  [[ "$(state_boolean dlqVerified)" == 'true' ]] ||
    fail 'refusing to restore visibility for an unverified message'
  aws_call sqs sqs change-message-visibility \
    --queue-url "$worker_dlq_url" \
    --receipt-handle "$(state_string dlqReceiptHandle)" \
    --visibility-timeout 0 \
    --output json >/dev/null
  state_set_boolean visibilityRestored true
}

switch_vendor_to_success() {
  process_stop_vendor
  process_start_vendor success
  assert_tunnel_reachable
}

start_managed_redrive() {
  [[ "$(state_boolean dlqVerified)" == 'true' ]] ||
    fail 'refusing to redrive an unverified message'
  assert_queue_empty "$delivery_queue_url"
  local dlq
  dlq="$(queue_attributes "$worker_dlq_url")"
  jq -e '
    .Attributes.ApproximateNumberOfMessages == "1" and
    .Attributes.ApproximateNumberOfMessagesNotVisible == "0" and
    .Attributes.ApproximateNumberOfMessagesDelayed == "0"
  ' <<<"$dlq" >/dev/null ||
    fail 'worker DLQ does not contain exactly the verified visible message'

  local response
  state_set_string redriveStartedAtMs "$(( $(date +%s) * 1000 ))"
  response="$(aws_call sqs sqs start-message-move-task \
    --source-arn "$worker_dlq_arn" \
    --max-number-of-messages-per-second 1 \
    --output json)"
  if [[ "${FAKE_VENDOR_DRILL_INTERRUPT_AFTER_REDRIVE:-0}" == '1' ]]; then
    fail 'forced test interruption after managed redrive started'
  fi
  state_set_string redriveTaskHandle "$(jq -er '.TaskHandle' <<<"$response")"
  state_set_boolean redriveStarted true
}

wait_for_redrive() {
  for _ in {1..60}; do
    local response
    response="$(aws_call sqs sqs list-message-move-tasks \
      --source-arn "$worker_dlq_arn" \
      --max-results 10 \
      --output json)"
    [[ -n "$response" ]] || response='{}'
    local task
    task="$(jq -c \
      --arg handle "$(state_string redriveTaskHandle)" '
        [.Results[]? | select(.TaskHandle == $handle)] | first // {}
      ' <<<"$response")"
    if [[ "$task" == '{}' ]]; then
      task="$(jq -c \
        --arg sourceArn "$worker_dlq_arn" \
        --argjson startedAt "$(state_string redriveStartedAtMs)" '
          [
            .Results[]? |
            select(.SourceArn == $sourceArn and .StartedTimestamp >= $startedAt)
          ] | sort_by(.StartedTimestamp) | last // {}
        ' <<<"$response")"
    fi
    if [[ "$(jq -r '.Status // ""' <<<"$task")" == 'COMPLETED' ]]; then
      local moved
      moved="$(jq -er '.ApproximateNumberOfMessagesMoved // 0' <<<"$task")"
      [[ "$moved" =~ ^[0-9]+$ ]] ||
        fail 'managed redrive returned an invalid moved-message count'
      ((moved <= 1)) ||
        fail 'managed redrive moved more than one message'
      if ((moved == 1)); then
        state_set_boolean redriveCompleted true
        return
      fi
    fi
    [[ "$(jq -r '.Status // ""' <<<"$task")" != 'FAILED' ]] ||
      fail 'managed redrive task failed'
    sleep "$poll_seconds"
  done
  fail 'managed redrive did not complete within the bounded wait'
}

wait_for_submitted_order() {
  local item
  for _ in {1..60}; do
    item="$(read_order_item)"
    if jq -e \
      --arg orderId "$(state_string orderId)" \
      --arg submissionKey "$(state_string submissionKey)" '
        .Item.entityType.S == "ORDER" and
        .Item.version.N == "2" and
        .Item.status.S == "SUBMITTED" and
        .Item.order.M.orderId.S == $orderId and
        .Item.order.M.status.S == "SUBMITTED" and
        .Item.order.M.version.N == "2" and
        .Item.order.M.provider.M.submissionKey.S == $submissionKey and
        (.Item.order.M.provider.M.providerOrderId.S | length) > 0 and
        (.Item.order.M.provider.M.acceptedAt.S |
          test("^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\\.[0-9]{3})?Z$"))
      ' <<<"$item" >/dev/null; then
      state_set_boolean orderSubmitted true
      return
    fi
    sleep "$poll_seconds"
  done
  fail 'redriven order did not reach SUBMITTED version 2'
}

verify_recovery_attempt() {
  local expected_digest
  expected_digest="$(printf %s "$(state_string submissionKey)" | sha256sum | awk '{print $1}')"
  jq -se \
    --arg digest "$expected_digest" \
    --arg correlationId "$(state_string correlationId)" '
      [
        .[] |
        select(
          .scenario == "success" and
          .statusCode == 201 and
          .correlationId == $correlationId and
          .idempotencyKeyDigest == $digest
        )
      ] | length == 1
    ' "$attempt_log" >/dev/null ||
    fail 'vendor journal does not contain exactly one marked recovery acceptance'
}

write_cleanup_items() {
  local item
  local provider_order_id
  item="$(read_order_item)"
  provider_order_id="$(jq -er '.Item.order.M.provider.M.providerOrderId.S' <<<"$item")"
  jq -n \
    --arg tableName "$table_name" \
    --arg merchantId "$expected_merchant_id" \
    --arg orderId "$(state_string orderId)" \
    --arg submissionKey "$(state_string submissionKey)" \
    --arg providerOrderId "$provider_order_id" '
      [
        {
          Delete: {
            TableName: $tableName,
            Key: {
              pk: {S: ("MERCHANT#" + $merchantId)},
              sk: {S: ("ORDER#" + $orderId)}
            },
            ConditionExpression: "#entityType = :orderType AND #version = :version AND #order.#orderId = :orderId AND #order.#provider.#submissionKey = :submissionKey AND #order.#provider.#providerOrderId = :providerOrderId",
            ExpressionAttributeNames: {
              "#entityType": "entityType",
              "#version": "version",
              "#order": "order",
              "#orderId": "orderId",
              "#provider": "provider",
              "#submissionKey": "submissionKey",
              "#providerOrderId": "providerOrderId"
            },
            ExpressionAttributeValues: {
              ":orderType": {S: "ORDER"},
              ":version": {N: "2"},
              ":orderId": {S: $orderId},
              ":submissionKey": {S: $submissionKey},
              ":providerOrderId": {S: $providerOrderId}
            }
          }
        },
        {
          Delete: {
            TableName: $tableName,
            Key: {
              pk: {S: "PROVIDER#mock-delivery"},
              sk: {S: ("ORDER#" + $providerOrderId)}
            },
            ConditionExpression: "#entityType = :providerType AND #schemaVersion = :schemaVersion AND merchantId = :merchantId AND orderId = :orderId",
            ExpressionAttributeNames: {
              "#entityType": "entityType",
              "#schemaVersion": "schemaVersion"
            },
            ExpressionAttributeValues: {
              ":providerType": {S: "PROVIDER_ORDER"},
              ":schemaVersion": {N: "1"},
              ":merchantId": {S: $merchantId},
              ":orderId": {S: $orderId}
            }
          }
        }
      ]
    ' >"$cleanup_items_file"
  chmod 600 "$cleanup_items_file"
}

delete_drill_data() {
  [[ "$(state_boolean dataDeleted)" == 'false' ]] || return 0
  [[ "$(state_boolean orderSubmitted)" == 'true' ]] ||
    fail 'refusing to delete an order that did not complete recovery'
  state_set_boolean dataDeleteAttempted true
  write_cleanup_items
  aws_call dynamodb dynamodb transact-write-items \
    --transact-items "file://$cleanup_items_file" \
    --return-consumed-capacity TOTAL \
    --output json >/dev/null
  rm -f "$cleanup_items_file" "$order_item_file"
  state_set_boolean dataDeleted true
}

assert_data_deleted() {
  jq -e '.Item == null' <<<"$(read_order_item)" >/dev/null ||
    fail 'marked order remains after cleanup'
  assert_no_drill_orders
}

complete_drill() {
  reconcile_order_write
  [[ "$(state_boolean orderWritten)" == 'true' ]] ||
    fail 'synthetic order was not written'

  if [[ "$(state_boolean dlqVerified)" == 'false' ]]; then
    receive_and_verify_dlq
  fi
  if [[ "$(state_boolean failureEvidenceVerified)" == 'false' ]]; then
    verify_failure_evidence
  fi
  if [[ "$(state_boolean visibilityRestored)" == 'false' ]]; then
    restore_dlq_visibility
  fi
  reconcile_redrive
  if [[ "$(state_boolean redriveStarted)" == 'false' ]]; then
    switch_vendor_to_success
    start_managed_redrive
  fi
  if [[ "$(state_boolean redriveCompleted)" == 'false' ]]; then
    wait_for_redrive
  fi
  if [[ "$(state_boolean orderSubmitted)" == 'false' ]]; then
    wait_for_submitted_order
  fi
  verify_recovery_attempt

  assert_deployed_queues_empty
  delete_drill_data
  assert_data_deleted
  process_stop_vendor
  process_stop_tunnel
  assert_worker_contract
  assert_stack_status
  assert_stack_in_sync
  assert_budget
}

validate_recovery_state() {
  [[ -f "$state_file" ]] || fail "recovery state does not exist: $state_file"
  jq -e \
    --arg accountId "$expected_account_id" \
    --arg region "$expected_region" \
    --arg stackName "$stack_name" \
    --arg orderPrefix "$drill_order_prefix" '
      .accountId == $accountId and
      .region == $region and
      .stackName == $stackName and
      (.orderId | startswith($orderPrefix)) and
      (.suffix | type) == "string" and
      (.submissionKey | type) == "string" and
      (.correlationId | type) == "string" and
      (.orderWriteAttempted | type) == "boolean" and
      (.orderWritten | type) == "boolean" and
      (.dlqVerified | type) == "boolean" and
      (.failureEvidenceVerified | type) == "boolean" and
      (.redriveStarted | type) == "boolean" and
      (.redriveCompleted | type) == "boolean" and
      (.orderSubmitted | type) == "boolean" and
      (.dataDeleted | type) == "boolean"
    ' "$state_file" >/dev/null ||
    fail 'recovery state identity or shape does not match this drill'
  [[ -f "$token_file" ]] || fail 'recovery token file is absent'
  [[ "$(stat -c '%a' "$token_file")" == '600' ]] ||
    fail 'recovery token file permissions must be 0600'
}

assert_recovery_resources_match() {
  local field
  local current
  for field in \
    tableName streamArn topicArn deliveryQueueUrl deliveryQueueArn workerDlqUrl workerDlqArn \
    publisherFailureQueueUrl subscriptionDlqUrl workerFunctionName workerFunctionArn \
    workerLogGroup workerMappingUuid; do
    case "$field" in
      tableName) current="$table_name" ;;
      streamArn) current="$stream_arn" ;;
      topicArn) current="$topic_arn" ;;
      deliveryQueueUrl) current="$delivery_queue_url" ;;
      deliveryQueueArn) current="$delivery_queue_arn" ;;
      workerDlqUrl) current="$worker_dlq_url" ;;
      workerDlqArn) current="$worker_dlq_arn" ;;
      publisherFailureQueueUrl) current="$publisher_failure_queue_url" ;;
      subscriptionDlqUrl) current="$subscription_dlq_url" ;;
      workerFunctionName) current="$worker_function_name" ;;
      workerFunctionArn) current="$worker_function_arn" ;;
      workerLogGroup) current="$worker_log_group" ;;
      workerMappingUuid) current="$worker_mapping_uuid" ;;
    esac
    [[ "$(state_string "$field")" == "$current" ]] ||
      fail "recovery resource mismatch for $field"
  done
}

run_trap() {
  local exit_code="$1"
  trap - EXIT INT TERM
  set +e
  rm -f "$parameter_file"
  if ((exit_code != 0)) && [[ -f "$state_file" ]] &&
    [[ "$(state_boolean orderWriteAttempted 2>/dev/null)" != 'true' ]]; then
    process_stop_vendor
    process_stop_tunnel
  fi
  if ((exit_code != 0)) && [[ -f "$state_file" ]]; then
    echo "Drill interrupted; recovery state retained at $state_file" >&2
    echo 'Run cleanup mode promptly to recover the marked message and stop local processes.' >&2
  fi
  exit "$exit_code"
}

run_drill() {
  [[ ! -e "$state_file" ]] ||
    fail "recovery state already exists; run cleanup first: $state_file"
  : >"$call_log"
  : >"$attempt_log"

  assert_identity
  assert_budget
  assert_stack_status
  assert_stack_in_sync
  resolve_resources
  assert_worker_contract
  assert_deployed_queues_empty
  assert_no_active_move_task
  assert_no_drill_orders
  assert_no_local_setup

  local suffix
  suffix="$(date +%s)$$"
  state_create "$suffix" "$(( $(date +%s) * 1000 ))"
  generate_secret
  trap 'run_trap $?' EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM

  assert_order_absent
  process_start_vendor rate-limit
  process_start_tunnel
  assert_tunnel_reachable
  create_worker_change_set
  write_order
  complete_drill

  local summary
  summary="$(jq -cn \
    --arg eventId "$(state_string eventId)" \
    --arg orderId "$(state_string orderId)" \
    --argjson cloudformationCalls "$(call_count cloudformation)" \
    --argjson dynamodbCalls "$(call_count dynamodb)" \
    --argjson logsCalls "$(call_count logs)" \
    --argjson sqsCalls "$(call_count sqs)" '
      {
        eventId: $eventId,
        orderId: $orderId,
        cloudformationCalls: $cloudformationCalls,
        dynamodbCalls: $dynamodbCalls,
        logsCalls: $logsCalls,
        sqsCalls: $sqsCalls
      }
    ')"
  rm -f "$state_file" "$token_file" "$parameter_file" "$order_item_file" "$cleanup_items_file"
  trap - EXIT INT TERM
  echo "Vendor rate-limit drill passed: $summary"
}

cleanup_drill() {
  : >"$call_log"
  assert_identity
  validate_recovery_state
  assert_stack_status
  resolve_resources
  assert_worker_contract
  assert_recovery_resources_match
  reconcile_stack_update
  reconcile_order_write

  if [[ "$(state_boolean orderWritten)" == 'true' ]]; then
    complete_drill
  else
    cleanup_unexecuted_change_set
    process_stop_vendor
    process_stop_tunnel
    assert_deployed_queues_empty
    assert_no_drill_orders
    assert_stack_in_sync
    assert_budget
  fi

  rm -f "$state_file" "$token_file" "$parameter_file" "$order_item_file" "$cleanup_items_file"
  echo 'Vendor rate-limit drill cleanup completed.'
}

main() {
  require_command "$aws_cli"
  require_command jq
  require_command openssl
  require_command sha256sum
  require_command stat
  if [[ "$test_mode" == '1' ]]; then
    [[ -n "$process_cli" ]] || fail 'test mode requires VENDOR_RATE_LIMIT_DRILL_PROCESS_CLI'
    require_command "$process_cli"
  else
    require_command cloudflared
    require_command curl
    require_command dig
    require_command node
    require_command ps
  fi
  mkdir -p "$state_directory"
  chmod 700 "$state_directory"

  local drill_mode="${1:-}"
  case "$drill_mode" in
    run)
      [[ "$#" == '1' ]] || {
        usage >&2
        exit 2
      }
      run_drill
      ;;
    cleanup)
      [[ "$#" == '1' ]] || {
        usage >&2
        exit 2
      }
      cleanup_drill
      ;;
    *)
      usage >&2
      exit 2
      ;;
  esac
}

main "$@"
