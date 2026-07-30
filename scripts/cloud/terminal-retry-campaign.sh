#!/usr/bin/env bash

set -euo pipefail

readonly expected_account_id='454921778743'
readonly expected_region='eu-central-1'
readonly expected_profile='pingusportro-admin'
readonly expected_merchant_id='mrc_demo'
readonly budget_name='My Zero-Spend Budget'
readonly stack_name='serverless-order-integration-dev'
readonly drill_prefix='terminal-campaign'
readonly call_cap=200
readonly http_call_cap=200
readonly throttle_request_count=100
readonly throttle_parallelism=2

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
readonly state_directory="$project_root/.aws-sam/cloud-drill/terminal-retry"
readonly state_file="$state_directory/state.json"
readonly secrets_file="$state_directory/secrets.json"
readonly operator_token_file="$state_directory/operator-token.txt"
readonly member_token_file="$state_directory/member-token.txt"
readonly input_file="$state_directory/aws-input.json"
readonly parameter_file="$state_directory/cloudformation-parameters.json"
readonly response_file="$state_directory/http-response.json"
readonly headers_file="$state_directory/http-headers.txt"
readonly order_body_file="$state_directory/order.json"
readonly changed_order_body_file="$state_directory/order-changed.json"
readonly webhook_body_file="$state_directory/webhook.json"
readonly duplicate_event_file="$state_directory/duplicate-delivery-event.json"
readonly audit_events_file="$state_directory/audit-events.jsonl"
readonly attempt_log="$state_directory/vendor-attempts.jsonl"
readonly vendor_log="$state_directory/vendor.log"
readonly tunnel_log="$state_directory/cloudflared.log"
readonly call_log="$state_directory/aws-calls.log"
readonly http_log="$state_directory/http-calls.log"
readonly cleanup_file="$state_directory/cleanup.json"

table_name=''
topic_arn=''
delivery_queue_url=''
worker_dlq_url=''
publisher_failure_queue_url=''
subscription_dlq_url=''
worker_function_name=''
webhook_function_name=''
worker_log_group=''
publisher_mapping_uuid=''
worker_mapping_uuid=''
api_url=''
user_pool_id=''
user_pool_client_id=''

usage() {
  cat <<'EOF'
Usage:
  scripts/cloud/terminal-retry-campaign.sh run
  scripts/cloud/terminal-retry-campaign.sh cleanup

The run mode executes the bounded terminal-vendor, operator-retry, public-error,
webhook, duplicate-delivery, and API-throttling campaign.

The cleanup mode removes only validated terminal-campaign users, messages,
subscriptions, queue, DynamoDB items, local processes, and ignored secrets.
EOF
}

fail() {
  echo "Terminal/retry campaign: $*" >&2
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

aws_call() {
  local counted_service="$1"
  shift
  [[ "${1:-}" == "$counted_service" ]] ||
    fail "internal AWS service mismatch: $counted_service != ${1:-missing}"
  local current
  current="$(call_count "$counted_service")"
  ((current < call_cap)) || fail "$counted_service API-call cap of $call_cap would be exceeded"
  printf '%s %s\n' "$counted_service" "${2:-missing}" >>"$call_log"
  aws "$@" \
    --profile "$expected_profile" \
    --region "$expected_region" \
    --no-cli-pager
}

budget_call() {
  local current
  current="$(call_count budgets)"
  ((current < call_cap)) || fail "budgets API-call cap of $call_cap would be exceeded"
  printf '%s\n' 'budgets describe-budget' >>"$call_log"
  aws budgets describe-budget \
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
    if (.[$field] | type) == "string" then .[$field]
    else error("state field must be a string: " + $field)
    end
  ' "$state_file"
}

state_boolean() {
  local field="$1"
  jq -er --arg field "$field" '
    if (.[$field] | type) == "boolean" then .[$field]
    else error("state field must be a boolean: " + $field)
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

stack_output() {
  local key="$1"
  aws_call cloudformation cloudformation describe-stacks \
    --stack-name "$stack_name" \
    --query "Stacks[0].Outputs[?OutputKey=='$key'].OutputValue | [0]" \
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

queue_attributes() {
  local queue_url="$1"
  aws_call sqs sqs get-queue-attributes \
    --queue-url "$queue_url" \
    --attribute-names All \
    --output json
}

queue_arn() {
  local queue_url="$1"
  jq -er '.Attributes.QueueArn' <<<"$(queue_attributes "$queue_url")"
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

assert_stack_status() {
  local status
  status="$(stack_status)"
  [[ "$status" == 'UPDATE_COMPLETE' ]] ||
    fail "stack must be UPDATE_COMPLETE, received $status"
}

assert_stack_in_sync() {
  local detection_id
  detection_id="$(aws_call cloudformation cloudformation detect-stack-drift \
    --stack-name "$stack_name" \
    --query StackDriftDetectionId \
    --output text)"
  for _ in {1..36}; do
    local detection_status
    detection_status="$(aws_call cloudformation cloudformation describe-stack-drift-detection-status \
      --stack-drift-detection-id "$detection_id" \
      --query DetectionStatus \
      --output text)"
    if [[ "$detection_status" == 'DETECTION_COMPLETE' ]]; then
      local drift_status
      drift_status="$(aws_call cloudformation cloudformation describe-stack-drift-detection-status \
        --stack-drift-detection-id "$detection_id" \
        --query StackDriftStatus \
        --output text)"
      [[ "$drift_status" == 'IN_SYNC' ]] ||
        fail "stack drift status must be IN_SYNC, received $drift_status"
      return
    fi
    [[ "$detection_status" != 'DETECTION_FAILED' ]] || fail 'stack drift detection failed'
    sleep 5
  done
  fail 'stack drift detection did not complete within the bounded wait'
}

assert_queue_empty() {
  local queue_url="$1"
  for attempt in {1..18}; do
    local response
    response="$(queue_attributes "$queue_url")"
    if jq -e '
      .Attributes.ApproximateNumberOfMessages == "0" and
      .Attributes.ApproximateNumberOfMessagesNotVisible == "0" and
      .Attributes.ApproximateNumberOfMessagesDelayed == "0"
    ' <<<"$response" >/dev/null; then
      return
    fi
    ((attempt == 18)) || sleep 5
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
  topic_arn="$(stack_output DomainEventsTopicArn)"
  delivery_queue_url="$(stack_output DeliveryQueueUrl)"
  worker_dlq_url="$(stack_output DeliveryDeadLetterQueueUrl)"
  publisher_failure_queue_url="$(stack_output StreamPublisherFailureQueueUrl)"
  subscription_dlq_url="$(stack_output DeliverySubscriptionDeadLetterQueueUrl)"
  api_url="$(stack_output ApiUrl)"
  user_pool_id="$(stack_output UserPoolId)"
  user_pool_client_id="$(stack_output UserPoolClientId)"
  worker_function_name="$(stack_resource DeliveryWorkerFunction)"
  webhook_function_name="$(stack_resource VendorWebhookFunction)"
  worker_log_group="$(stack_resource DeliveryWorkerLogGroup)"

  local delivery_queue_arn
  delivery_queue_arn="$(queue_arn "$delivery_queue_url")"
  local mappings
  mappings="$(aws_call lambda lambda list-event-source-mappings \
    --function-name "$worker_function_name" \
    --event-source-arn "$delivery_queue_arn" \
    --output json)"
  worker_mapping_uuid="$(jq -er '.EventSourceMappings | select(length == 1) | .[0].UUID' \
    <<<"$mappings")"

  local publisher_function_name
  publisher_function_name="$(stack_resource StreamPublisherFunction)"
  local stream_arn
  stream_arn="$(stack_output OrdersTableStreamArn)"
  mappings="$(aws_call lambda lambda list-event-source-mappings \
    --function-name "$publisher_function_name" \
    --event-source-arn "$stream_arn" \
    --output json)"
  publisher_mapping_uuid="$(jq -er \
    '.EventSourceMappings | select(length == 1) | .[0].UUID' <<<"$mappings")"
}

assert_mapping_contracts() {
  local worker
  worker="$(aws_call lambda lambda get-event-source-mapping \
    --uuid "$worker_mapping_uuid" \
    --output json)"
  jq -e '
    .State == "Enabled" and
    .BatchSize == 2 and
    .FunctionResponseTypes == ["ReportBatchItemFailures"] and
    .ScalingConfig.MaximumConcurrency == 2
  ' <<<"$worker" >/dev/null || fail 'delivery-worker mapping does not match the approved contract'

  local publisher
  publisher="$(aws_call lambda lambda get-event-source-mapping \
    --uuid "$publisher_mapping_uuid" \
    --output json)"
  jq -e '
    .State == "Enabled" and
    .FunctionResponseTypes == ["ReportBatchItemFailures"] and
    (.FilterCriteria.Filters | length) == 1 and
    (.FilterCriteria.Filters[0].Pattern | fromjson) ==
      {"eventName":["INSERT","MODIFY"],"dynamodb":{"NewImage":{"entityType":{"S":["ORDER"]}}}}
  ' <<<"$publisher" >/dev/null ||
    fail 'stream-publisher mapping does not match the approved filter contract'
}

assert_no_local_processes() {
  if ps -eo args= | awk '
    /scripts\/mock-vendor\/start-local[.]mjs/ { found = 1 }
    /cloudflared tunnel/ && /127[.]0[.]0[.]1:4000/ { found = 1 }
    END { exit(found ? 0 : 1) }
  '; then
    fail 'a mock-vendor or port-4000 Quick Tunnel process is already running'
  fi
}

assert_no_previous_campaign_data() {
  local users
  users="$(aws_call cognito-idp cognito-idp list-users \
    --user-pool-id "$user_pool_id" \
    --output json)"
  jq -e \
    --arg prefix "$drill_prefix-" '
      [.Users[]? | select(.Username | startswith($prefix))] | length == 0
    ' <<<"$users" >/dev/null || fail 'a previous terminal-campaign Cognito user remains'

  local response
  response="$(aws_call dynamodb dynamodb scan \
    --table-name "$table_name" \
    --filter-expression 'begins_with(sk, :eventPrefix) OR begins_with(sk, :idempotencyPrefix) OR begins_with(sk, :merchantOrderIdPrefix)' \
    --expression-attribute-values '{
      ":eventPrefix":{"S":"EVENT#provider-terminal-campaign-"},
      ":idempotencyPrefix":{"S":"IDEMPOTENCY#terminal-campaign-"},
      ":merchantOrderIdPrefix":{"S":"MERCHANT_ORDER_ID#terminal-campaign-"}
    }' \
    --projection-expression 'pk,sk' \
    --output json)"
  jq -e '.Count == 0 and (.Items | length) == 0' <<<"$response" >/dev/null ||
    fail 'a previous terminal-campaign DynamoDB item remains'
}

state_create() {
  local suffix="$1"
  jq -n \
    --arg accountId "$expected_account_id" \
    --arg region "$expected_region" \
    --arg stackName "$stack_name" \
    --arg suffix "$suffix" \
    --arg tableName "$table_name" \
    --arg topicArn "$topic_arn" \
    --arg deliveryQueueUrl "$delivery_queue_url" \
    --arg workerDlqUrl "$worker_dlq_url" \
    --arg publisherFailureQueueUrl "$publisher_failure_queue_url" \
    --arg subscriptionDlqUrl "$subscription_dlq_url" \
    --arg workerFunctionName "$worker_function_name" \
    --arg webhookFunctionName "$webhook_function_name" \
    --arg workerLogGroup "$worker_log_group" \
    --arg workerMappingUuid "$worker_mapping_uuid" \
    --arg publisherMappingUuid "$publisher_mapping_uuid" \
    --arg apiUrl "$api_url" \
    --arg userPoolId "$user_pool_id" \
    --arg userPoolClientId "$user_pool_client_id" \
    --arg operatorUsername "$drill_prefix-operator-$suffix" \
    --arg memberUsername "$drill_prefix-member-$suffix" \
    --arg idempotencyKey "$drill_prefix-idempotency-$suffix" \
    --arg conflictIdempotencyKey "$drill_prefix-conflict-$suffix" \
    --arg merchantOrderId "$drill_prefix-merchant-order-$suffix" \
    --arg createCorrelationId "corr.$drill_prefix.create.$suffix" \
    --arg retryCorrelationId "corr.$drill_prefix.retry.$suffix" \
    --arg pickupEventId "provider-$drill_prefix-pickup-$suffix" \
    --arg deliveredEventId "provider-$drill_prefix-delivered-$suffix" \
    --arg staleEventId "provider-$drill_prefix-stale-$suffix" '
      {
        accountId: $accountId,
        region: $region,
        stackName: $stackName,
        suffix: $suffix,
        tableName: $tableName,
        topicArn: $topicArn,
        deliveryQueueUrl: $deliveryQueueUrl,
        workerDlqUrl: $workerDlqUrl,
        publisherFailureQueueUrl: $publisherFailureQueueUrl,
        subscriptionDlqUrl: $subscriptionDlqUrl,
        workerFunctionName: $workerFunctionName,
        webhookFunctionName: $webhookFunctionName,
        workerLogGroup: $workerLogGroup,
        workerMappingUuid: $workerMappingUuid,
        publisherMappingUuid: $publisherMappingUuid,
        apiUrl: $apiUrl,
        userPoolId: $userPoolId,
        userPoolClientId: $userPoolClientId,
        operatorUsername: $operatorUsername,
        memberUsername: $memberUsername,
        idempotencyKey: $idempotencyKey,
        conflictIdempotencyKey: $conflictIdempotencyKey,
        merchantOrderId: $merchantOrderId,
        createCorrelationId: $createCorrelationId,
        retryCorrelationId: $retryCorrelationId,
        pickupEventId: $pickupEventId,
        deliveredEventId: $deliveredEventId,
        staleEventId: $staleEventId,
        vendorRunning: false,
        tunnelRunning: false,
        tunnelUrl: "",
        changeSetName: "",
        stackUpdated: false,
        auditQueueUrl: "",
        auditQueueArn: "",
        auditSubscriptionArn: "",
        auditQueueCreated: false,
        auditSubscriptionCreated: false,
        operatorCreated: false,
        memberCreated: false,
        orderId: "",
        orderCreated: false,
        terminalFailureVerified: false,
        retryRequested: false,
        orderSubmitted: false,
        webhooksVerified: false,
        duplicateVerified: false,
        throttlingVerified: false,
        dataDeleted: false
      }
    ' >"$state_file"
  chmod 600 "$state_file"
}

generate_secrets() {
  umask 077
  local vendor_token
  local webhook_secret
  local operator_password
  local member_password
  vendor_token="$(openssl rand -hex 32)"
  webhook_secret="$(openssl rand -hex 32)"
  operator_password="Aa1!$(openssl rand -hex 20)"
  member_password="Bb2!$(openssl rand -hex 20)"
  jq -n \
    --arg vendorToken "$vendor_token" \
    --arg webhookSecret "$webhook_secret" \
    --arg operatorPassword "$operator_password" \
    --arg memberPassword "$member_password" \
    '{
      vendorToken: $vendorToken,
      webhookSecret: $webhookSecret,
      operatorPassword: $operatorPassword,
      memberPassword: $memberPassword
    }' >"$secrets_file"
  chmod 600 "$secrets_file"
}

process_start_vendor() {
  local scenario="$1"
  local token
  token="$(jq -er '.vendorToken' "$secrets_file")"
  : >"$vendor_log"
  MOCK_VENDOR_PORT=4000 \
    MOCK_VENDOR_SCENARIO="$scenario" \
    MOCK_VENDOR_TOKEN="$token" \
    MOCK_VENDOR_ATTEMPT_LOG="$attempt_log" \
    nohup node "$project_root/scripts/mock-vendor/start-local.mjs" \
    >"$vendor_log" 2>&1 &
  local pid=$!
  state_set_string vendorPid "$pid"
  state_set_string vendorScenario "$scenario"
  state_set_boolean vendorRunning true
  for _ in {1..30}; do
    kill -0 "$pid" 2>/dev/null ||
      fail "mock vendor stopped during startup; see $vendor_log"
    local status
    status="$(curl --silent --max-time 3 --output /dev/null --write-out '%{http_code}' \
      --request POST http://127.0.0.1:4000/deliveries || true)"
    [[ "$status" == '401' ]] && return
    sleep 1
  done
  fail 'mock vendor was not ready within 30 seconds'
}

process_stop_vendor() {
  [[ "$(state_boolean vendorRunning)" == 'true' ]] || return 0
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
  state_set_boolean vendorRunning false
}

process_start_tunnel() {
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
  fail 'Quick Tunnel URL was not visible within 60 seconds'
}

process_stop_tunnel() {
  [[ "$(state_boolean tunnelRunning)" == 'true' ]] || return 0
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
  state_set_boolean tunnelRunning false
}

assert_tunnel_reachable() {
  local url
  url="$(state_string tunnelUrl)"
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
  fail "Quick Tunnel did not expose the authenticated mock vendor; last status: $last_status"
}

create_endpoint_change_set() {
  local tunnel_url
  tunnel_url="$(state_string tunnelUrl)"
  local change_set_name="$drill_prefix-$(state_string suffix)"
  state_set_string changeSetName "$change_set_name"
  local parameter_keys
  parameter_keys="$(aws_call cloudformation cloudformation describe-stacks \
    --stack-name "$stack_name" \
    --query 'Stacks[0].Parameters[].ParameterKey' \
    --output json)"
  jq -n \
    --argjson keys "$parameter_keys" \
    --arg url "$tunnel_url" \
    --slurpfile secrets "$secrets_file" '
      $keys | map(
        if . == "VendorBaseUrl" then
          {ParameterKey: ., ParameterValue: $url}
        elif . == "VendorAuthToken" then
          {ParameterKey: ., ParameterValue: $secrets[0].vendorToken}
        elif . == "WebhookSigningSecret" then
          {ParameterKey: ., ParameterValue: $secrets[0].webhookSecret}
        else
          {ParameterKey: ., UsePreviousValue: true}
        end
      )
    ' >"$parameter_file"
  chmod 600 "$parameter_file"

  local change_set_id
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

  local response='{}'
  for _ in {1..36}; do
    response="$(aws_call cloudformation cloudformation describe-change-set \
      --stack-name "$stack_name" \
      --change-set-name "$change_set_name" \
      --output json)"
    if [[ "$(jq -r '.Status' <<<"$response")" == 'CREATE_COMPLETE' ]]; then
      jq -e '
        .ExecutionStatus == "AVAILABLE" and
        ([.Changes[] | select(
          .Type == "Resource" and
          .ResourceChange.Action == "Modify" and
          .ResourceChange.Replacement == "False"
        ) | .ResourceChange.LogicalResourceId] | sort) ==
          ["DeliveryWorkerFunction", "SynchronousHttpApi", "VendorWebhookFunction"]
      ' <<<"$response" >/dev/null ||
        fail 'change set contains a change outside the worker, webhook, and dependent HTTP API'
      break
    fi
    [[ "$(jq -r '.Status' <<<"$response")" != 'FAILED' ]] ||
      fail 'endpoint change set failed to create'
    sleep 5
  done
  [[ "$(jq -r '.Status' <<<"$response")" == 'CREATE_COMPLETE' ]] ||
    fail 'endpoint change set did not become ready'

  aws_call cloudformation cloudformation execute-change-set \
    --stack-name "$stack_name" \
    --change-set-name "$change_set_name" \
    --output json >/dev/null

  for _ in {1..60}; do
    local status
    status="$(stack_status)"
    [[ "$status" != *'ROLLBACK'* && "$status" != *'FAILED'* ]] ||
      fail "endpoint stack update failed: $status"
    if [[ "$status" == 'UPDATE_COMPLETE' ]] && endpoint_configuration_matches; then
      state_set_boolean stackUpdated true
      return
    fi
    sleep 5
  done
  fail 'endpoint stack update did not complete within the bounded wait'
}

endpoint_configuration_matches() {
  local worker
  worker="$(aws_call lambda lambda get-function-configuration \
    --function-name "$worker_function_name" \
    --query '{State:State,LastUpdateStatus:LastUpdateStatus,VendorBaseUrl:Environment.Variables.VENDOR_BASE_URL,VendorAuthToken:Environment.Variables.VENDOR_AUTH_TOKEN}' \
    --output json)"
  jq -e \
    --arg url "$(state_string tunnelUrl)" \
    --slurpfile secrets "$secrets_file" '
      .State == "Active" and
      .LastUpdateStatus == "Successful" and
      .VendorBaseUrl == $url and
      .VendorAuthToken == $secrets[0].vendorToken
    ' <<<"$worker" >/dev/null || return 1

  local webhook
  webhook="$(aws_call lambda lambda get-function-configuration \
    --function-name "$webhook_function_name" \
    --query '{State:State,LastUpdateStatus:LastUpdateStatus,WebhookSigningSecret:Environment.Variables.WEBHOOK_SIGNING_SECRET}' \
    --output json)"
  jq -e \
    --slurpfile secrets "$secrets_file" '
      .State == "Active" and
      .LastUpdateStatus == "Successful" and
      .WebhookSigningSecret == $secrets[0].webhookSecret
    ' <<<"$webhook" >/dev/null
}

cleanup_change_set() {
  [[ "$(state_boolean stackUpdated)" == 'false' ]] || return 0
  local name
  name="$(state_string changeSetName)"
  [[ -n "$name" ]] || return 0
  if endpoint_configuration_matches 2>/dev/null; then
    state_set_boolean stackUpdated true
    return
  fi
  local response
  if response="$(aws_call cloudformation cloudformation describe-change-set \
    --stack-name "$stack_name" \
    --change-set-name "$name" \
    --output json 2>/dev/null)"; then
    if [[ "$(jq -r '.ExecutionStatus // ""' <<<"$response")" == 'AVAILABLE' ]]; then
      aws_call cloudformation cloudformation delete-change-set \
        --stack-name "$stack_name" \
        --change-set-name "$name" \
        --output json >/dev/null
    fi
  fi
}

create_audit_subscription() {
  local name="$stack_name-$drill_prefix-audit-$(state_string suffix)"
  local response
  response="$(aws_call sqs sqs create-queue \
    --queue-name "$name" \
    --attributes SqsManagedSseEnabled=true,MessageRetentionPeriod=3600 \
    --tags Project=serverless-order-integration,Environment=dev,Purpose=terminal-retry-campaign \
    --output json)"
  local queue_url
  queue_url="$(jq -er '.QueueUrl' <<<"$response")"
  state_set_string auditQueueUrl "$queue_url"
  state_set_boolean auditQueueCreated true
  local queue_arn_value
  queue_arn_value="$(queue_arn "$queue_url")"
  state_set_string auditQueueArn "$queue_arn_value"

  local policy
  policy="$(jq -cn \
    --arg resource "$queue_arn_value" \
    --arg sourceArn "$topic_arn" \
    --arg accountId "$expected_account_id" '
      {
        Version: "2012-10-17",
        Statement: [{
          Sid: "AllowTerminalCampaignAudit",
          Effect: "Allow",
          Principal: {Service: "sns.amazonaws.com"},
          Action: "sqs:SendMessage",
          Resource: $resource,
          Condition: {
            ArnEquals: {"aws:SourceArn": $sourceArn},
            StringEquals: {"aws:SourceAccount": $accountId}
          }
        }]
      }
    ')"
  jq -n \
    --arg queueUrl "$queue_url" \
    --arg policy "$policy" \
    '{QueueUrl: $queueUrl, Attributes: {Policy: $policy}}' >"$input_file"
  chmod 600 "$input_file"
  aws_call sqs sqs set-queue-attributes \
    --cli-input-json "file://$input_file" \
    --output json >/dev/null

  local subscription_arn
  subscription_arn="$(aws_call sns sns subscribe \
    --topic-arn "$topic_arn" \
    --protocol sqs \
    --notification-endpoint "$queue_arn_value" \
    --attributes RawMessageDelivery=true \
    --return-subscription-arn \
    --query SubscriptionArn \
    --output text)"
  [[ "$subscription_arn" == arn:aws:sns:* ]] ||
    fail 'SNS did not return a confirmed audit subscription ARN'
  state_set_string auditSubscriptionArn "$subscription_arn"
  state_set_boolean auditSubscriptionCreated true
  assert_queue_empty "$queue_url"
}

delete_audit_subscription() {
  if [[ "$(state_boolean auditSubscriptionCreated)" == 'true' ]]; then
    aws_call sns sns unsubscribe \
      --subscription-arn "$(state_string auditSubscriptionArn)" \
      --output json >/dev/null
    state_set_boolean auditSubscriptionCreated false
  fi
  if [[ "$(state_boolean auditQueueCreated)" == 'true' ]]; then
    aws_call sqs sqs delete-queue \
      --queue-url "$(state_string auditQueueUrl)" \
      --output json >/dev/null
    state_set_boolean auditQueueCreated false
  fi
}

create_cognito_user() {
  local role="$1"
  local username_field="${role}Username"
  local password_field="${role}Password"
  local username
  username="$(state_string "$username_field")"
  jq -n \
    --arg pool "$user_pool_id" \
    --arg username "$username" \
    --arg password "$(jq -er --arg field "$password_field" '.[$field]' "$secrets_file")" '
      {
        UserPoolId: $pool,
        Username: $username,
        TemporaryPassword: $password,
        MessageAction: "SUPPRESS"
      }
    ' >"$input_file"
  chmod 600 "$input_file"
  aws_call cognito-idp cognito-idp admin-create-user \
    --cli-input-json "file://$input_file" \
    --output json >/dev/null
  state_set_boolean "${role}Created" true

  jq -n \
    --arg pool "$user_pool_id" \
    --arg username "$username" \
    --arg password "$(jq -er --arg field "$password_field" '.[$field]' "$secrets_file")" '
      {
        UserPoolId: $pool,
        Username: $username,
        Password: $password,
        Permanent: true
      }
    ' >"$input_file"
  chmod 600 "$input_file"
  aws_call cognito-idp cognito-idp admin-set-user-password \
    --cli-input-json "file://$input_file" \
    --output json >/dev/null
}

authenticate_cognito_user() {
  local role="$1"
  local username
  username="$(state_string "${role}Username")"
  local password
  password="$(jq -er --arg field "${role}Password" '.[$field]' "$secrets_file")"
  jq -n \
    --arg clientId "$user_pool_client_id" \
    --arg username "$username" \
    --arg password "$password" '
      {
        AuthFlow: "USER_PASSWORD_AUTH",
        ClientId: $clientId,
        AuthParameters: {USERNAME: $username, PASSWORD: $password}
      }
    ' >"$input_file"
  chmod 600 "$input_file"
  local destination="$operator_token_file"
  [[ "$role" == 'operator' ]] || destination="$member_token_file"
  aws_call cognito-idp cognito-idp initiate-auth \
    --cli-input-json "file://$input_file" \
    --query AuthenticationResult.AccessToken \
    --output text >"$destination"
  chmod 600 "$destination"
  [[ "$(wc -c <"$destination")" -gt 100 ]] ||
    fail "Cognito did not return an access token for $role"
}

create_campaign_users() {
  create_cognito_user operator
  aws_call cognito-idp cognito-idp admin-add-user-to-group \
    --user-pool-id "$user_pool_id" \
    --username "$(state_string operatorUsername)" \
    --group-name operators \
    --output json >/dev/null
  create_cognito_user member
  authenticate_cognito_user operator
  authenticate_cognito_user member
}

delete_campaign_users() {
  local role
  for role in operator member; do
    local username
    username="$(state_string "${role}Username")"
    [[ "$username" == "$drill_prefix-"* ]] ||
      fail "refusing to inspect unexpected Cognito username: $username"
    if [[ "$(state_boolean "${role}Created")" == 'true' ]] ||
      aws_call cognito-idp cognito-idp admin-get-user \
        --user-pool-id "$user_pool_id" \
        --username "$username" \
        --output json >/dev/null 2>&1; then
      aws_call cognito-idp cognito-idp admin-delete-user \
        --user-pool-id "$user_pool_id" \
        --username "$username" \
        --output json >/dev/null
      state_set_boolean "${role}Created" false
    fi
  done
}

http_count() {
  [[ -f "$http_log" ]] && wc -l <"$http_log" || echo '0'
}

record_http_calls() {
  local count="$1"
  local current
  current="$(http_count)"
  ((current + count <= http_call_cap)) ||
    fail "HTTP API-call cap of $http_call_cap would be exceeded"
  for ((index = 0; index < count; index += 1)); do
    printf '%s\n' 'api request' >>"$http_log"
  done
}

write_headers() {
  local token_file="$1"
  shift
  : >"$headers_file"
  chmod 600 "$headers_file"
  if [[ "$token_file" != 'none' ]]; then
    local token
    token="$(<"$token_file")"
    printf 'Authorization: Bearer %s\n' "$token" >>"$headers_file"
  fi
  local header_value
  for header_value in "$@"; do
    printf '%s\n' "$header_value" >>"$headers_file"
  done
}

api_request() {
  local token_file="$1"
  local method="$2"
  local path="$3"
  local body_file="$4"
  local output_file="$5"
  shift 5
  local body_arguments=()
  if [[ "$body_file" != 'none' ]]; then
    body_arguments=(--data-binary "@$body_file")
  fi
  local status
  for attempt in {1..10}; do
    record_http_calls 1
    write_headers "$token_file" "$@"
    status="$(curl --silent --show-error \
      --connect-timeout 5 \
      --max-time 20 \
      --output "$output_file" \
      --write-out '%{http_code}' \
      --request "$method" \
      --header "@$headers_file" \
      "${body_arguments[@]}" \
      "$api_url$path")"
    if [[ "$status" != '429' ]]; then
      printf '%s\n' "$status"
      return
    fi
    ((attempt == 10)) || sleep 2
  done
  printf '%s\n' "$status"
}

assert_problem() {
  local actual_status="$1"
  local expected_status="$2"
  local expected_code="$3"
  local file="$4"
  [[ "$actual_status" == "$expected_status" ]] ||
    fail "expected HTTP $expected_status/$expected_code, received $actual_status"
  jq -e \
    --arg code "$expected_code" \
    --argjson status "$expected_status" '
      .status == $status and .code == $code and (.requestId | length) >= 8
    ' "$file" >/dev/null ||
    fail "response did not contain $expected_code Problem Details"
}

write_order_bodies() {
  jq -n \
    --arg merchantOrderId "$(state_string merchantOrderId)" '
      {
        merchantOrderId: $merchantOrderId,
        items: [{
          itemReference: "terminal-campaign-item",
          description: "Synthetic terminal campaign item",
          quantity: 1,
          unitPrice: {amountMinor: 1000, currency: "RON"}
        }],
        pickup: {
          addressLine: "10 Synthetic Test Street",
          city: "Bucharest",
          postalCode: "010101",
          countryCode: "RO"
        },
        dropoff: {
          addressLine: "20 Synthetic Test Avenue",
          city: "Bucharest",
          postalCode: "020202",
          countryCode: "RO"
        }
      }
    ' >"$order_body_file"
  jq '.items[0].quantity = 2' "$order_body_file" >"$changed_order_body_file"
}

create_order_and_http_errors() {
  write_order_bodies
  local status
  status="$(api_request "$operator_token_file" POST /orders "$order_body_file" "$response_file" \
    'Content-Type: application/json' \
    "Idempotency-Key: $(state_string idempotencyKey)" \
    "X-Correlation-Id: $(state_string createCorrelationId)")"
  [[ "$status" == '201' ]] || fail "create order returned HTTP $status"
  jq -e '
    .merchantId == "mrc_demo" and .status == "PENDING_SUBMISSION" and .version == 1
  ' "$response_file" >/dev/null || fail 'create order returned an unexpected representation'
  local order_id
  order_id="$(jq -er '.orderId' "$response_file")"
  state_set_string orderId "$order_id"
  state_set_boolean orderCreated true

  status="$(api_request "$operator_token_file" POST /orders "$order_body_file" "$response_file" \
    'Content-Type: application/json' \
    "Idempotency-Key: $(state_string idempotencyKey)")"
  [[ "$status" == '200' ]] || fail "idempotent replay returned HTTP $status"
  jq -e --arg orderId "$order_id" '.orderId == $orderId' "$response_file" >/dev/null ||
    fail 'idempotent replay returned another order'

  status="$(api_request "$operator_token_file" POST /orders "$changed_order_body_file" \
    "$response_file" 'Content-Type: application/json' \
    "Idempotency-Key: $(state_string idempotencyKey)")"
  assert_problem "$status" 409 IDEMPOTENCY_CONFLICT "$response_file"

  status="$(api_request "$operator_token_file" POST /orders "$order_body_file" "$response_file" \
    'Content-Type: application/json' \
    "Idempotency-Key: $(state_string conflictIdempotencyKey)")"
  assert_problem "$status" 409 MERCHANT_ORDER_ID_CONFLICT "$response_file"

  printf '%s' '{malformed' >"$input_file"
  status="$(api_request "$operator_token_file" POST /orders "$input_file" "$response_file" \
    'Content-Type: application/json' \
    "Idempotency-Key: $drill_prefix-malformed-$(state_string suffix)")"
  assert_problem "$status" 400 MALFORMED_REQUEST "$response_file"

  printf '%s' '{}' >"$input_file"
  status="$(api_request "$operator_token_file" POST /orders "$input_file" "$response_file" \
    'Content-Type: application/json' \
    "Idempotency-Key: $drill_prefix-invalid-$(state_string suffix)")"
  assert_problem "$status" 422 VALIDATION_ERROR "$response_file"

  status="$(api_request "$operator_token_file" GET '/orders?limit=0' none "$response_file")"
  assert_problem "$status" 422 VALIDATION_ERROR "$response_file"

  status="$(api_request "$operator_token_file" GET /orders/ord_00000000000000000000 none \
    "$response_file")"
  assert_problem "$status" 404 ORDER_NOT_FOUND "$response_file"

  status="$(api_request none GET /orders none "$response_file")"
  [[ "$status" == '401' ]] || fail "missing bearer token returned HTTP $status instead of 401"
}

read_order_item() {
  aws_call dynamodb dynamodb get-item \
    --table-name "$table_name" \
    --key "$(jq -cn \
      --arg pk "MERCHANT#$expected_merchant_id" \
      --arg sk "ORDER#$(state_string orderId)" \
      '{pk:{S:$pk},sk:{S:$sk}}')" \
    --consistent-read \
    --output json
}

wait_for_terminal_failure() {
  for _ in {1..60}; do
    local item
    item="$(read_order_item)"
    if jq -e '
      .Item.entityType.S == "ORDER" and
      .Item.status.S == "SUBMISSION_FAILED" and
      .Item.version.N == "2" and
      .Item.order.M.status.S == "SUBMISSION_FAILED" and
      .Item.order.M.version.N == "2" and
      .Item.order.M.failure.M.stage.S == "SUBMISSION" and
      .Item.order.M.failure.M.reasonCode.S == "REQUEST_REJECTED" and
      (.Item.order.M.provider.M.deliveryProviderOrderId? == null)
    ' <<<"$item" >/dev/null; then
      state_set_boolean terminalFailureVerified true
      return
    fi
    sleep 5
  done
  fail 'order did not reach SUBMISSION_FAILED version 2'
}

collect_audit_events() {
  local expected_count="$1"
  local queue_url
  queue_url="$(state_string auditQueueUrl)"
  for _ in {1..60}; do
    local current=0
    if [[ -s "$audit_events_file" ]]; then
      current="$(jq -s 'unique_by(.eventId) | length' "$audit_events_file")"
    fi
    ((current >= expected_count)) && return
    local response
    response="$(aws_call sqs sqs receive-message \
      --queue-url "$queue_url" \
      --max-number-of-messages 5 \
      --wait-time-seconds 5 \
      --visibility-timeout 30 \
      --attribute-names All \
      --message-attribute-names All \
      --output json)"
    [[ -n "$response" ]] || response='{}'
    local count
    count="$(jq '.Messages // [] | length' <<<"$response")"
    if ((count == 0)); then
      sleep 2
      continue
    fi
    for ((index = 0; index < count; index += 1)); do
      local body
      body="$(jq -er --argjson index "$index" '.Messages[$index].Body' <<<"$response")"
      jq -e \
        --arg orderId "$(state_string orderId)" '
          .aggregateId == $orderId and .schemaVersion == 2
        ' <<<"$body" >/dev/null || fail 'audit subscription received an unrelated event'
      jq -c . <<<"$body" >>"$audit_events_file"
      local receipt
      receipt="$(jq -er --argjson index "$index" '.Messages[$index].ReceiptHandle' \
        <<<"$response")"
      aws_call sqs sqs delete-message \
        --queue-url "$queue_url" \
        --receipt-handle "$receipt" \
        --output json >/dev/null
    done
  done
  fail "audit subscription did not receive $expected_count events"
}

assert_audit_event_set() {
  local expected_json="$1"
  jq -se \
    --argjson expected "$expected_json" '
      group_by(.eventId) as $deliveries |
      all($deliveries[]; (unique | length) == 1) and
      (
        $deliveries |
        map(.[0] | {eventType, aggregateVersion}) |
        sort_by(.aggregateVersion)
      ) == $expected
    ' "$audit_events_file" >/dev/null || fail 'audit event journey did not match expected types'
}

verify_terminal_failure() {
  wait_for_terminal_failure
  collect_audit_events 2
  assert_audit_event_set \
    '[{"eventType":"order.created","aggregateVersion":1},{"eventType":"order.submission_failed","aggregateVersion":2}]'
  assert_deployed_queues_empty

  jq -se \
    --arg correlationId "$(state_string createCorrelationId)" '
      length == 1 and
      .[0].scenario == "request-rejected" and
      .[0].statusCode == 422 and
      .[0].correlationId == $correlationId and
      (.[0].idempotencyKeyDigest | length) == 64
    ' "$attempt_log" >/dev/null ||
    fail 'vendor journal did not contain exactly one terminal rejection'

  local response
  response="$(aws_call logs logs filter-log-events \
    --log-group-name "$worker_log_group" \
    --start-time "$(( $(date +%s) * 1000 - 900000 ))" \
    --filter-pattern "\"$(state_string orderId)\"" \
    --output json)"
  jq -e '
    [.events[]?.message | split("\t") | .[-1] | fromjson? |
      select(.event == "delivery.message.failed")] | length == 0
  ' <<<"$response" >/dev/null ||
    fail 'terminal vendor response was incorrectly reported as an SQS failure'
}

write_status_body() {
  local target="$1"
  local reason="$2"
  jq -n --arg target "$target" --arg reason "$reason" \
    '{targetStatus:$target,reason:$reason}' >"$input_file"
}

exercise_operator_errors_and_retry() {
  local order_path="/orders/$(state_string orderId)/status"
  write_status_body PENDING_SUBMISSION 'Approved synthetic submission retry.'
  local status
  status="$(api_request "$member_token_file" PATCH "$order_path" "$input_file" "$response_file" \
    'Content-Type: application/json' 'If-Match: "2"')"
  assert_problem "$status" 403 FORBIDDEN "$response_file"

  status="$(api_request "$operator_token_file" PATCH "$order_path" "$input_file" "$response_file" \
    'Content-Type: application/json')"
  assert_problem "$status" 428 PRECONDITION_REQUIRED "$response_file"

  status="$(api_request "$operator_token_file" PATCH "$order_path" "$input_file" "$response_file" \
    'Content-Type: application/json' 'If-Match: 2')"
  assert_problem "$status" 400 MALFORMED_REQUEST "$response_file"

  status="$(api_request "$operator_token_file" PATCH "$order_path" "$input_file" "$response_file" \
    'Content-Type: application/json' 'If-Match: "1"')"
  assert_problem "$status" 412 VERSION_MISMATCH "$response_file"

  write_status_body DELIVERED 'Invalid synthetic terminal transition.'
  status="$(api_request "$operator_token_file" PATCH "$order_path" "$input_file" "$response_file" \
    'Content-Type: application/json' 'If-Match: "2"')"
  assert_problem "$status" 409 INVALID_STATUS_TRANSITION "$response_file"

  write_status_body PENDING_SUBMISSION x
  status="$(api_request "$operator_token_file" PATCH "$order_path" "$input_file" "$response_file" \
    'Content-Type: application/json' 'If-Match: "2"')"
  assert_problem "$status" 422 VALIDATION_ERROR "$response_file"

  process_stop_vendor
  process_start_vendor success
  assert_tunnel_reachable
  write_status_body PENDING_SUBMISSION 'Approved synthetic submission retry.'
  status="$(api_request "$operator_token_file" PATCH "$order_path" "$input_file" "$response_file" \
    'Content-Type: application/json' \
    'If-Match: "2"' \
    "X-Correlation-Id: $(state_string retryCorrelationId)")"
  [[ "$status" == '200' ]] || fail "operator retry returned HTTP $status"
  jq -e '.status == "PENDING_SUBMISSION" and .version == 3' "$response_file" >/dev/null ||
    fail 'operator retry did not return PENDING_SUBMISSION version 3'
  state_set_boolean retryRequested true
}

wait_for_submitted_order() {
  for _ in {1..60}; do
    local item
    item="$(read_order_item)"
    if jq -e '
      .Item.status.S == "SUBMITTED" and
      .Item.version.N == "4" and
      .Item.order.M.status.S == "SUBMITTED" and
      .Item.order.M.version.N == "4" and
      (.Item.order.M.provider.M.deliveryProviderOrderId.S | length) > 0
    ' <<<"$item" >/dev/null; then
      state_set_boolean orderSubmitted true
      return
    fi
    sleep 5
  done
  fail 'retried order did not reach SUBMITTED version 4'
}

verify_retry_journey() {
  wait_for_submitted_order
  collect_audit_events 4
  assert_audit_event_set \
    '[{"eventType":"order.created","aggregateVersion":1},{"eventType":"order.submission_failed","aggregateVersion":2},{"eventType":"order.submission_retry_requested","aggregateVersion":3},{"eventType":"order.submitted","aggregateVersion":4}]'
  assert_deployed_queues_empty
  jq -se \
    --arg firstCorrelation "$(state_string createCorrelationId)" \
    --arg retryCorrelation "$(state_string retryCorrelationId)" '
      length == 2 and
      .[0].scenario == "request-rejected" and .[0].statusCode == 422 and
      .[0].correlationId == $firstCorrelation and
      .[1].scenario == "success" and .[1].statusCode == 201 and
      .[1].correlationId == $retryCorrelation and
      .[0].idempotencyKeyDigest == .[1].idempotencyKeyDigest
    ' "$attempt_log" >/dev/null ||
    fail 'vendor journal did not prove stable idempotency across operator retry'
}

webhook_request() {
  local body_file="$1"
  local output_file="$2"
  local status
  for attempt in {1..10}; do
    local timestamp
    timestamp="$(date +%s)"
    local signature
    signature="$(node "$project_root/scripts/cloud/sign-webhook.mjs" \
      "$secrets_file" "$timestamp" "$body_file")"
    record_http_calls 1
    write_headers none \
      'Content-Type: application/json' \
      "X-Webhook-Timestamp: $timestamp" \
      "X-Webhook-Signature: $signature" \
      "X-Correlation-Id: corr.$drill_prefix.webhook.$(state_string suffix)"
    status="$(curl --silent --show-error \
      --connect-timeout 5 \
      --max-time 20 \
      --output "$output_file" \
      --write-out '%{http_code}' \
      --request POST \
      --header "@$headers_file" \
      --data-binary "@$body_file" \
      "$api_url/webhooks/vendor")"
    if [[ "$status" != '429' ]]; then
      printf '%s\n' "$status"
      return
    fi
    ((attempt == 10)) || sleep 2
  done
  printf '%s\n' "$status"
}

delivery_provider_order_id() {
  jq -er '.Item.order.M.provider.M.deliveryProviderOrderId.S' <<<"$(read_order_item)"
}

exercise_webhook_cases() {
  local delivery_provider_order_id_value
  delivery_provider_order_id_value="$(delivery_provider_order_id)"
  local status

  jq -n \
    --arg eventId "provider-$drill_prefix-unknown-$(state_string suffix)" \
    --arg occurredAt "$(date -u +'%Y-%m-%dT%H:%M:%S.000Z')" '
      {
        eventId:$eventId,
        eventType:"DELIVERY_PICKED_UP",
        occurredAt:$occurredAt,
        deliveryProviderOrderId:"delivery-unknown-terminal-campaign"
      }
    ' >"$webhook_body_file"
  status="$(webhook_request "$webhook_body_file" "$response_file")"
  assert_problem "$status" 404 ORDER_NOT_FOUND "$response_file"

  jq -n \
    --arg eventId "provider-$drill_prefix-invalid-$(state_string suffix)" '
      {eventId:$eventId,eventType:"UNKNOWN",occurredAt:"invalid",deliveryProviderOrderId:""}
    ' >"$webhook_body_file"
  status="$(webhook_request "$webhook_body_file" "$response_file")"
  assert_problem "$status" 422 VALIDATION_ERROR "$response_file"

  printf '%s' '{malformed' >"$webhook_body_file"
  status="$(webhook_request "$webhook_body_file" "$response_file")"
  assert_problem "$status" 400 MALFORMED_REQUEST "$response_file"

  sleep 1
  local pickup_at
  pickup_at="$(date -u +'%Y-%m-%dT%H:%M:%S.000Z')"
  jq -n \
    --arg eventId "$(state_string pickupEventId)" \
    --arg occurredAt "$pickup_at" \
    --arg deliveryProviderOrderId "$delivery_provider_order_id_value" '
      {eventId:$eventId,eventType:"DELIVERY_PICKED_UP",occurredAt:$occurredAt,deliveryProviderOrderId:$deliveryProviderOrderId}
    ' >"$webhook_body_file"
  status="$(webhook_request "$webhook_body_file" "$response_file")"
  [[ "$status" == '204' ]] || fail "pickup webhook returned HTTP $status"

  sleep 1
  local conflict_at
  conflict_at="$(date -u +'%Y-%m-%dT%H:%M:%S.000Z')"
  jq -n \
    --arg eventId "$(state_string pickupEventId)" \
    --arg occurredAt "$conflict_at" \
    --arg deliveryProviderOrderId "$delivery_provider_order_id_value" '
      {eventId:$eventId,eventType:"DELIVERY_DELIVERED",occurredAt:$occurredAt,deliveryProviderOrderId:$deliveryProviderOrderId}
    ' >"$webhook_body_file"
  status="$(webhook_request "$webhook_body_file" "$response_file")"
  assert_problem "$status" 409 EVENT_ID_CONFLICT "$response_file"

  sleep 1
  local delivered_at
  delivered_at="$(date -u +'%Y-%m-%dT%H:%M:%S.000Z')"
  jq -n \
    --arg eventId "$(state_string deliveredEventId)" \
    --arg occurredAt "$delivered_at" \
    --arg deliveryProviderOrderId "$delivery_provider_order_id_value" '
      {eventId:$eventId,eventType:"DELIVERY_DELIVERED",occurredAt:$occurredAt,deliveryProviderOrderId:$deliveryProviderOrderId}
    ' >"$webhook_body_file"
  status="$(webhook_request "$webhook_body_file" "$response_file")"
  [[ "$status" == '204' ]] || fail "delivered webhook returned HTTP $status"

  jq -n \
    --arg eventId "$(state_string staleEventId)" \
    --arg occurredAt "$pickup_at" \
    --arg deliveryProviderOrderId "$delivery_provider_order_id_value" '
      {eventId:$eventId,eventType:"DELIVERY_PICKED_UP",occurredAt:$occurredAt,deliveryProviderOrderId:$deliveryProviderOrderId}
    ' >"$webhook_body_file"
  status="$(webhook_request "$webhook_body_file" "$response_file")"
  [[ "$status" == '204' ]] || fail "stale webhook returned HTTP $status"

  for _ in {1..30}; do
    local item
    item="$(read_order_item)"
    if jq -e '
      .Item.status.S == "DELIVERED" and
      .Item.version.N == "6" and
      .Item.order.M.status.S == "DELIVERED" and
      .Item.order.M.version.N == "6"
    ' <<<"$item" >/dev/null; then
      state_set_boolean webhooksVerified true
      break
    fi
    sleep 2
  done
  [[ "$(state_boolean webhooksVerified)" == 'true' ]] ||
    fail 'webhook sequence did not leave the order DELIVERED version 6'
  collect_audit_events 6
  assert_audit_event_set \
    '[{"eventType":"order.created","aggregateVersion":1},{"eventType":"order.submission_failed","aggregateVersion":2},{"eventType":"order.submission_retry_requested","aggregateVersion":3},{"eventType":"order.submitted","aggregateVersion":4},{"eventType":"order.picked_up","aggregateVersion":5},{"eventType":"order.delivered","aggregateVersion":6}]'
  assert_deployed_queues_empty
}

exercise_duplicate_delivery() {
  local item
  item="$(read_order_item)"
  local occurred_at
  local delivery_provider_submission_key
  occurred_at="$(jq -er '.Item.order.M.updatedAt.S' <<<"$item")"
  delivery_provider_submission_key="$(jq -er '.Item.order.M.provider.M.deliveryProviderSubmissionKey.S' <<<"$item")"
  jq -n \
    --arg eventId "evt_terminalcampaign_duplicate_$(state_string suffix)" \
    --arg orderId "$(state_string orderId)" \
    --arg occurredAt "$occurred_at" \
    --arg correlationId "$(state_string retryCorrelationId)" \
    --arg causationId "request.$drill_prefix.duplicate.$(state_string suffix)" \
    --arg deliveryProviderSubmissionKey "$delivery_provider_submission_key" '
      {
        eventId:$eventId,
        eventType:"order.submission_retry_requested",
        schemaVersion:2,
        aggregateType:"ORDER",
        aggregateId:$orderId,
        aggregateVersion:3,
        occurredAt:$occurredAt,
        correlationId:$correlationId,
        causationId:$causationId,
        payload:{
          merchantId:"mrc_demo",
          previousStatus:"SUBMISSION_FAILED",
          status:"PENDING_SUBMISSION",
          deliveryProviderCode:"mock-delivery",
          deliveryProviderSubmissionKey:$deliveryProviderSubmissionKey,
          reason:"Approved synthetic submission retry."
        }
      }
    ' >"$duplicate_event_file"
  aws_call sqs sqs send-message \
    --queue-url "$delivery_queue_url" \
    --message-body "file://$duplicate_event_file" \
    --output json >/dev/null
  assert_queue_empty "$delivery_queue_url"
  assert_queue_empty "$worker_dlq_url"
  jq -se 'length == 2' "$attempt_log" >/dev/null ||
    fail 'duplicate delivery caused another external vendor attempt'
  state_set_boolean duplicateVerified true
}

exercise_api_throttling() {
  record_http_calls "$throttle_request_count"
  write_headers "$operator_token_file"
  local throttle_directory="$state_directory/throttle"
  mkdir -p "$throttle_directory"
  local pids=()
  local failed=0
  for index in $(seq 1 "$throttle_request_count"); do
    (
      curl --silent --show-error \
        --connect-timeout 5 \
        --max-time 20 \
        --output /dev/null \
        --write-out '%{http_code}' \
        --request GET \
        --header "@$headers_file" \
        "$api_url/orders?limit=1" >"$throttle_directory/status-$index"
    ) &
    pids+=("$!")
    if ((${#pids[@]} == throttle_parallelism)); then
      local batch_pid
      for batch_pid in "${pids[@]}"; do
        wait "$batch_pid" || failed=1
      done
      pids=()
    fi
  done
  local pid
  for pid in "${pids[@]}"; do
    wait "$pid" || failed=1
  done
  ((failed == 0)) || fail 'an API throttling request failed at the transport layer'
  local distribution
  distribution="$(sort "$throttle_directory"/status-* | uniq -c)"
  local throttled
  throttled="$(awk '$2 == 429 { print $1 }' <<<"$distribution")"
  throttled="${throttled:-0}"
  ((throttled > 0)) || fail 'bounded burst did not reproduce API Gateway HTTP 429'
  if awk '$2 != 200 && $2 != 429 { unexpected = 1 } END { exit unexpected ? 0 : 1 }' \
    <<<"$distribution"; then
    fail "API throttling burst returned an unexpected status: $distribution"
  fi
  state_set_string throttleDistribution "$(tr '\n' ';' <<<"$distribution")"
  state_set_boolean throttlingVerified true
}

append_delete_if_valid() {
  local key_json="$1"
  local validation_filter="$2"
  local deletes="$3"
  local item
  item="$(aws_call dynamodb dynamodb get-item \
    --table-name "$table_name" \
    --key "$key_json" \
    --consistent-read \
    --output json)"
  [[ -n "$item" ]] || item='{}'
  if jq -e '.Item == null' <<<"$item" >/dev/null; then
    printf '%s\n' "$deletes"
    return
  fi
  jq -e "$validation_filter" <<<"$item" >/dev/null ||
    fail "refusing to delete a campaign item that failed identity validation: $key_json"
  local key
  key="$(jq -c '.Item | {pk,sk}' <<<"$item")"
  jq -c --argjson key "$key" '. + [{DeleteRequest:{Key:$key}}]' <<<"$deletes"
}

delete_campaign_data() {
  [[ "$(state_boolean orderCreated)" == 'true' ]] || return 0
  [[ "$(state_boolean dataDeleted)" == 'false' ]] || return 0
  assert_deployed_queues_empty
  local order_id
  order_id="$(state_string orderId)"
  local deletes='[]'
  local key

  key="$(jq -cn --arg pk "MERCHANT#$expected_merchant_id" --arg sk "ORDER#$order_id" \
    '{pk:{S:$pk},sk:{S:$sk}}')"
  deletes="$(append_delete_if_valid "$key" \
    ".Item.entityType.S == \"ORDER\" and .Item.order.M.orderId.S == \"$order_id\"" "$deletes")"

  key="$(jq -cn --arg pk "MERCHANT#$expected_merchant_id" \
    --arg sk "IDEMPOTENCY#$(state_string idempotencyKey)" '{pk:{S:$pk},sk:{S:$sk}}')"
  deletes="$(append_delete_if_valid "$key" \
    ".Item.entityType.S == \"IDEMPOTENCY\" and .Item.orderId.S == \"$order_id\"" "$deletes")"

  key="$(jq -cn --arg pk "MERCHANT#$expected_merchant_id" \
    --arg sk "MERCHANT_ORDER_ID#$(state_string merchantOrderId)" '{pk:{S:$pk},sk:{S:$sk}}')"
  deletes="$(append_delete_if_valid "$key" \
    ".Item.entityType.S == \"MERCHANT_ORDER_ID\" and .Item.orderId.S == \"$order_id\"" "$deletes")"

  local delivery_provider_order_id_value=''
  local order_item
  order_item="$(read_order_item)"
  delivery_provider_order_id_value="$(jq -r '.Item.order.M.provider.M.deliveryProviderOrderId.S // ""' <<<"$order_item")"
  if [[ -n "$delivery_provider_order_id_value" ]]; then
    key="$(jq -cn --arg pk 'DELIVERY_PROVIDER#mock-delivery' --arg sk "ORDER#$delivery_provider_order_id_value" \
      '{pk:{S:$pk},sk:{S:$sk}}')"
    deletes="$(append_delete_if_valid "$key" \
      ".Item.entityType.S == \"DELIVERY_PROVIDER_ORDER\" and .Item.orderId.S == \"$order_id\"" "$deletes")"
  fi

  local event_field
  for event_field in pickupEventId deliveredEventId staleEventId; do
    key="$(jq -cn --arg pk 'CONSUMER#provider-webhook' \
      --arg sk "EVENT#$(state_string "$event_field")" '{pk:{S:$pk},sk:{S:$sk}}')"
    deletes="$(append_delete_if_valid "$key" \
      '.Item.entityType.S == "PROCESSED_EVENT"' "$deletes")"
  done

  local count
  count="$(jq 'length' <<<"$deletes")"
  ((count >= 3 && count <= 7)) ||
    fail "unexpected campaign cleanup item count: $count"
  jq -n \
    --arg tableName "$table_name" \
    --argjson deletes "$deletes" \
    '{RequestItems:{($tableName):$deletes},ReturnConsumedCapacity:"TOTAL"}' >"$cleanup_file"
  chmod 600 "$cleanup_file"
  local response
  response="$(aws_call dynamodb dynamodb batch-write-item \
    --cli-input-json "file://$cleanup_file" \
    --output json)"
  jq -e '.UnprocessedItems | length == 0' <<<"$response" >/dev/null ||
    fail 'campaign cleanup returned unprocessed DynamoDB deletes'
  state_set_boolean dataDeleted true
}

assert_campaign_data_absent() {
  local response
  response="$(aws_call dynamodb dynamodb scan \
    --table-name "$table_name" \
    --filter-expression 'begins_with(sk, :eventPrefix) OR begins_with(sk, :idempotencyPrefix) OR begins_with(sk, :merchantOrderIdPrefix) OR orderId = :orderId OR #order.#orderId = :orderId' \
    --expression-attribute-names '{"#order":"order","#orderId":"orderId"}' \
    --expression-attribute-values "$(jq -cn \
      --arg eventPrefix "EVENT#provider-$drill_prefix-" \
      --arg idempotencyPrefix "IDEMPOTENCY#$drill_prefix-" \
      --arg merchantOrderIdPrefix "MERCHANT_ORDER_ID#$drill_prefix-" \
      --arg orderId "$(state_string orderId)" '{
        ":eventPrefix":{S:$eventPrefix},
        ":idempotencyPrefix":{S:$idempotencyPrefix},
        ":merchantOrderIdPrefix":{S:$merchantOrderIdPrefix},
        ":orderId":{S:$orderId}
      }')" \
    --projection-expression 'pk,sk' \
    --output json)"
  jq -e '.Count == 0 and (.Items | length) == 0' <<<"$response" >/dev/null ||
    fail 'terminal-campaign DynamoDB items remain after cleanup'
}

run_trap() {
  local exit_code="$1"
  trap - EXIT INT TERM
  set +e
  rm -f "$input_file" "$parameter_file" "$headers_file"
  if ((exit_code != 0)) && [[ -f "$state_file" ]] &&
    [[ "$(state_boolean orderCreated 2>/dev/null)" != 'true' ]]; then
    process_stop_vendor
    process_stop_tunnel
  fi
  if ((exit_code != 0)) && [[ -f "$state_file" ]]; then
    echo "Campaign interrupted; recovery state retained at $state_file" >&2
    echo 'Run cleanup mode promptly after diagnosis.' >&2
  fi
  exit "$exit_code"
}

run_campaign() {
  [[ ! -e "$state_file" ]] ||
    fail "recovery state already exists; run cleanup first: $state_file"
  mkdir -p "$state_directory"
  chmod 700 "$state_directory"
  : >"$call_log"
  : >"$http_log"
  : >"$attempt_log"
  : >"$audit_events_file"

  assert_identity
  assert_budget
  assert_stack_status
  assert_stack_in_sync
  resolve_resources
  assert_mapping_contracts
  assert_deployed_queues_empty
  assert_no_local_processes
  assert_no_previous_campaign_data

  local suffix
  suffix="$(date +%s)$$"
  state_create "$suffix"
  generate_secrets
  trap 'run_trap $?' EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM

  process_start_vendor request-rejected
  process_start_tunnel
  assert_tunnel_reachable
  create_endpoint_change_set
  create_audit_subscription
  create_campaign_users
  create_order_and_http_errors
  verify_terminal_failure
  exercise_operator_errors_and_retry
  verify_retry_journey
  exercise_webhook_cases
  exercise_duplicate_delivery
  exercise_api_throttling

  delete_campaign_data
  assert_campaign_data_absent
  delete_audit_subscription
  delete_campaign_users
  process_stop_vendor
  process_stop_tunnel
  assert_deployed_queues_empty
  assert_mapping_contracts
  assert_stack_status
  assert_stack_in_sync
  assert_budget

  local summary
  summary="$(jq -cn \
    --arg orderId "$(state_string orderId)" \
    --arg throttleDistribution "$(state_string throttleDistribution)" \
    --argjson httpCalls "$(http_count)" \
    --argjson cognitoCalls "$(call_count cognito-idp)" \
    --argjson dynamodbCalls "$(call_count dynamodb)" \
    --argjson sqsCalls "$(call_count sqs)" '
      {
        orderId:$orderId,
        httpCalls:$httpCalls,
        cognitoCalls:$cognitoCalls,
        dynamodbCalls:$dynamodbCalls,
        sqsCalls:$sqsCalls,
        throttleDistribution:$throttleDistribution
      }
    ')"
  rm -f \
    "$state_file" \
    "$secrets_file" \
    "$operator_token_file" \
    "$member_token_file" \
    "$input_file" \
    "$parameter_file" \
    "$headers_file" \
    "$order_body_file" \
    "$changed_order_body_file" \
    "$webhook_body_file" \
    "$duplicate_event_file" \
    "$cleanup_file"
  trap - EXIT INT TERM
  echo "Terminal/retry campaign passed: $summary"
}

cleanup_campaign() {
  [[ -f "$state_file" ]] || fail "recovery state does not exist: $state_file"
  : >"$call_log"
  assert_identity
  assert_stack_status
  resolve_resources
  cleanup_change_set

  if [[ "$(state_boolean orderCreated)" == 'true' ]]; then
    local item
    item="$(read_order_item)"
    if jq -e '.Item.status.S == "PENDING_SUBMISSION" and .Item.version.N == "1"' \
      <<<"$item" >/dev/null; then
      wait_for_terminal_failure
    elif jq -e '.Item.status.S == "PENDING_SUBMISSION" and .Item.version.N == "3"' \
      <<<"$item" >/dev/null; then
      if [[ "$(state_boolean vendorRunning)" != 'true' ]] ||
        [[ "$(state_string vendorScenario)" != 'success' ]]; then
        process_stop_vendor
        process_start_vendor success
      fi
      wait_for_submitted_order
    fi
    assert_deployed_queues_empty
    delete_campaign_data
    assert_campaign_data_absent
  fi

  delete_audit_subscription
  delete_campaign_users
  process_stop_vendor
  process_stop_tunnel
  assert_deployed_queues_empty
  assert_mapping_contracts
  assert_stack_status
  assert_stack_in_sync
  assert_budget
  rm -f \
    "$state_file" \
    "$secrets_file" \
    "$operator_token_file" \
    "$member_token_file" \
    "$input_file" \
    "$parameter_file" \
    "$headers_file" \
    "$order_body_file" \
    "$changed_order_body_file" \
    "$webhook_body_file" \
    "$duplicate_event_file" \
    "$cleanup_file"
  echo 'Terminal/retry campaign cleanup completed.'
}

main() {
  local mode="${1:-}"
  case "$mode" in
    run | cleanup)
      [[ "$#" == '1' ]] || {
        usage >&2
        exit 2
      }
      ;;
    *)
      usage >&2
      exit 2
      ;;
  esac

  require_command aws
  require_command cloudflared
  require_command curl
  require_command dig
  require_command jq
  require_command node
  require_command openssl
  require_command ps
  require_command seq

  if [[ "$mode" == 'run' ]]; then
    run_campaign
  else
    cleanup_campaign
  fi
}

main "$@"
