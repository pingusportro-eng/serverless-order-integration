#!/usr/bin/env bash

set -euo pipefail

: "${FAKE_VENDOR_DRILL_STATE_DIRECTORY:?FAKE_VENDOR_DRILL_STATE_DIRECTORY is required}"

readonly account_id='454921778743'
readonly region='eu-central-1'
readonly stack_name='serverless-order-integration-dev'
readonly table_name="$stack_name-orders"
readonly stream_arn="arn:aws:dynamodb:$region:$account_id:table/$table_name/stream/2026-07-25T04:15:27.732"
readonly topic_arn="arn:aws:sns:$region:$account_id:$stack_name-domain-events"
readonly delivery_queue_url="https://sqs.$region.amazonaws.com/$account_id/$stack_name-delivery"
readonly delivery_queue_arn="arn:aws:sqs:$region:$account_id:$stack_name-delivery"
readonly worker_dlq_url="https://sqs.$region.amazonaws.com/$account_id/$stack_name-delivery-dlq"
readonly worker_dlq_arn="arn:aws:sqs:$region:$account_id:$stack_name-delivery-dlq"
readonly publisher_failure_queue_url="https://sqs.$region.amazonaws.com/$account_id/$stack_name-publisher-failure"
readonly subscription_dlq_url="https://sqs.$region.amazonaws.com/$account_id/$stack_name-subscription-dlq"
readonly worker_name="$stack_name-delivery-worker"
readonly worker_arn="arn:aws:lambda:$region:$account_id:function:$worker_name"
readonly worker_log_group="/aws/serverless-order-integration/$stack_name/delivery-worker"
readonly mapping_uuid='fake-worker-mapping-uuid'
readonly event_id='evt_fakevendor429drill1234567890'
readonly task_handle='fake-managed-redrive-task'

mkdir -p "$FAKE_VENDOR_DRILL_STATE_DIRECTORY"
printf '%q ' "$@" >>"$FAKE_VENDOR_DRILL_STATE_DIRECTORY/aws-commands.log"
printf '\n' >>"$FAKE_VENDOR_DRILL_STATE_DIRECTORY/aws-commands.log"

option_value() {
  local option="$1"
  shift
  while (($# > 0)); do
    if [[ "$1" == "$option" ]]; then
      printf '%s\n' "$2"
      return
    fi
    shift
  done
  return 1
}

increment_counter() {
  local name="$1"
  local value=1
  if [[ -f "$FAKE_VENDOR_DRILL_STATE_DIRECTORY/$name" ]]; then
    value="$(( $(<"$FAKE_VENDOR_DRILL_STATE_DIRECTORY/$name") + 1 ))"
  fi
  printf '%s\n' "$value" >"$FAKE_VENDOR_DRILL_STATE_DIRECTORY/$name"
  printf '%s\n' "$value"
}

order_value() {
  jq -er "$1" "$FAKE_VENDOR_DRILL_STATE_DIRECTORY/order.json"
}

attempt_log() {
  sed -n '1p' "$FAKE_VENDOR_DRILL_STATE_DIRECTORY/attempt-log-path"
}

append_attempt() {
  local scenario="$1"
  local status="$2"
  local submission_key
  local correlation_id
  local digest
  submission_key="$(order_value '.order.M.provider.M.submissionKey.S')"
  correlation_id="$(order_value '.mutation.M.correlationId.S')"
  digest="$(printf %s "$submission_key" | sha256sum | awk '{print $1}')"
  jq -cn \
    --arg scenario "$scenario" \
    --arg correlationId "$correlation_id" \
    --arg digest "$digest" \
    --argjson status "$status" '
      {
        timestamp: "2026-07-27T07:00:00.000Z",
        scenario: $scenario,
        correlationId: $correlationId,
        idempotencyKeyDigest: $digest,
        statusCode: $status
      }
    ' >>"$(attempt_log)"
}

domain_event() {
  jq -cn \
    --arg eventId "$event_id" \
    --arg orderId "$(order_value '.order.M.orderId.S')" \
    --arg occurredAt "$(order_value '.order.M.updatedAt.S')" \
    --arg correlationId "$(order_value '.mutation.M.correlationId.S')" \
    --arg causationId "$(order_value '.mutation.M.causationId.S')" \
    --arg submissionKey "$(order_value '.order.M.provider.M.submissionKey.S')" '
      {
        eventId: $eventId,
        eventType: "order.created",
        schemaVersion: 1,
        aggregateType: "ORDER",
        aggregateId: $orderId,
        aggregateVersion: 1,
        occurredAt: $occurredAt,
        correlationId: $correlationId,
        causationId: $causationId,
        payload: {
          merchantId: "mrc_demo",
          status: "PENDING_SUBMISSION",
          providerCode: "mock-delivery",
          submissionKey: $submissionKey
        }
      }
    '
}

queue_attributes() {
  local queue_url="$1"
  local queue_arn
  local visible='0'
  local invisible='0'
  local redrive_policy=''

  case "$queue_url" in
    "$delivery_queue_url")
      queue_arn="$delivery_queue_arn"
      redrive_policy="$(jq -cn --arg arn "$worker_dlq_arn" \
        '{deadLetterTargetArn: $arn, maxReceiveCount: 3}')"
      ;;
    "$worker_dlq_url")
      queue_arn="$worker_dlq_arn"
      if [[ -f "$FAKE_VENDOR_DRILL_STATE_DIRECTORY/dlq-ready" &&
        ! -f "$FAKE_VENDOR_DRILL_STATE_DIRECTORY/redrive-completed" ]]; then
        if [[ -f "$FAKE_VENDOR_DRILL_STATE_DIRECTORY/dlq-invisible" ]]; then
          invisible='1'
        else
          visible='1'
        fi
      fi
      ;;
    "$publisher_failure_queue_url")
      queue_arn="arn:aws:sqs:$region:$account_id:$stack_name-publisher-failure"
      ;;
    "$subscription_dlq_url")
      queue_arn="arn:aws:sqs:$region:$account_id:$stack_name-subscription-dlq"
      ;;
    *)
      exit 91
      ;;
  esac

  jq -cn \
    --arg arn "$queue_arn" \
    --arg visible "$visible" \
    --arg invisible "$invisible" \
    --arg redrive "$redrive_policy" '
      {
        Attributes: {
          QueueArn: $arn,
          ApproximateNumberOfMessages: $visible,
          ApproximateNumberOfMessagesNotVisible: $invisible,
          ApproximateNumberOfMessagesDelayed: "0",
          VisibilityTimeout: "90",
          MessageRetentionPeriod: "86400",
          SqsManagedSseEnabled: "true",
          RedrivePolicy: $redrive
        }
      }
      | if $redrive == "" then del(.Attributes.RedrivePolicy) else . end
    '
}

service="${1:?AWS service is required}"
operation="${2:?AWS operation is required}"
shift 2

case "$service:$operation" in
  sts:get-caller-identity)
    printf '%s\n' "$account_id"
    ;;

  budgets:describe-budget)
    jq -cn '
      {
        Budget: {
          BudgetLimit: {Amount: "1.0", Unit: "USD"},
          CalculatedSpend: {
            ActualSpend: {Amount: "0.0", Unit: "USD"},
            ForecastedSpend: {Amount: "0.0", Unit: "USD"}
          }
        }
      }
    '
    ;;

  cloudformation:describe-stacks)
    query="$(option_value --query "$@")"
    case "$query" in
      'Stacks[0].StackStatus') printf 'UPDATE_COMPLETE\n' ;;
      'Stacks[0].Parameters[].ParameterKey')
        jq -cn '[
          "EnvironmentName",
          "MerchantId",
          "CursorSigningSecret",
          "WebhookSigningSecret",
          "WebhookToleranceSeconds",
          "LogRetentionDays",
          "ApiThrottleBurstLimit",
          "ApiThrottleRateLimit",
          "DynamoMaxReadRequestUnits",
          "DynamoMaxWriteRequestUnits",
          "StreamPublisherBatchSize",
          "StreamPublisherMaximumRetryAttempts",
          "StreamPublisherMaximumRecordAgeSeconds",
          "DeliveryWorkerBatchSize",
          "DeliveryWorkerMaximumConcurrency",
          "DeliveryWorkerTimeoutSeconds",
          "DeliveryQueueVisibilityTimeoutSeconds",
          "DeliveryQueueMaxReceiveCount",
          "DeliveryMessageRetentionSeconds",
          "FailureMessageRetentionSeconds",
          "VendorBaseUrl",
          "VendorAuthToken",
          "VendorTimeoutMs"
        ]'
        ;;
      *OrdersTableName*) printf '%s\n' "$table_name" ;;
      *OrdersTableStreamArn*) printf '%s\n' "$stream_arn" ;;
      *DomainEventsTopicArn*) printf '%s\n' "$topic_arn" ;;
      *DeliveryQueueUrl*) printf '%s\n' "$delivery_queue_url" ;;
      *DeliveryDeadLetterQueueUrl*) printf '%s\n' "$worker_dlq_url" ;;
      *StreamPublisherFailureQueueUrl*) printf '%s\n' "$publisher_failure_queue_url" ;;
      *DeliverySubscriptionDeadLetterQueueUrl*) printf '%s\n' "$subscription_dlq_url" ;;
      *) exit 92 ;;
    esac
    ;;

  cloudformation:describe-stack-resource)
    logical_id="$(option_value --logical-resource-id "$@")"
    case "$logical_id" in
      DeliveryWorkerFunction) printf '%s\n' "$worker_name" ;;
      DeliveryWorkerLogGroup) printf '%s\n' "$worker_log_group" ;;
      *) exit 93 ;;
    esac
    ;;

  cloudformation:detect-stack-drift)
    printf 'fake-drift-id\n'
    ;;

  cloudformation:describe-stack-drift-detection-status)
    query="$(option_value --query "$@")"
    if [[ "$query" == 'DetectionStatus' ]]; then
      printf 'DETECTION_COMPLETE\n'
    elif [[ "$query" == 'StackDriftStatus' ]]; then
      printf 'IN_SYNC\n'
    else
      exit 94
    fi
    ;;

  cloudformation:create-change-set)
    parameter_uri="$(option_value --parameters "$@")"
    parameter_path="${parameter_uri#file://}"
    jq -e '
      length == 23 and
      ([.[] | select(.ParameterKey == "VendorBaseUrl" and
        .ParameterValue == "https://vendor-rate-limit-drill.trycloudflare.com")] | length) == 1 and
      ([.[] | select(.ParameterKey == "VendorAuthToken" and
        (.ParameterValue | length) == 64)] | length) == 1 and
      ([.[] | select(
        .ParameterKey != "VendorBaseUrl" and
        .ParameterKey != "VendorAuthToken" and
        .UsePreviousValue == true
      )] | length) == 21
    ' "$parameter_path" >/dev/null || exit 95
    touch "$FAKE_VENDOR_DRILL_STATE_DIRECTORY/change-set-created"
    printf 'fake-change-set-id\n'
    ;;

  cloudformation:describe-change-set)
    execution_status='AVAILABLE'
    if [[ -f "$FAKE_VENDOR_DRILL_STATE_DIRECTORY/stack-updated" ]]; then
      execution_status='EXECUTE_COMPLETE'
    fi
    jq -cn --arg executionStatus "$execution_status" '
      {
        Status: "CREATE_COMPLETE",
        ExecutionStatus: $executionStatus,
        Changes: [{
          Type: "Resource",
          ResourceChange: {
            Action: "Modify",
            LogicalResourceId: "DeliveryWorkerFunction",
            Replacement: "False"
          }
        }]
      }
    '
    ;;

  cloudformation:execute-change-set)
    [[ -f "$FAKE_VENDOR_DRILL_STATE_DIRECTORY/change-set-created" ]] || exit 96
    touch "$FAKE_VENDOR_DRILL_STATE_DIRECTORY/stack-updated"
    ;;

  cloudformation:delete-change-set)
    rm -f "$FAKE_VENDOR_DRILL_STATE_DIRECTORY/change-set-created"
    touch "$FAKE_VENDOR_DRILL_STATE_DIRECTORY/change-set-deleted"
    ;;

  lambda:get-function-configuration)
    query="$(option_value --query "$@")"
    if [[ "$query" == 'FunctionArn' ]]; then
      printf '%s\n' "$worker_arn"
    else
      vendor_url=''
      if [[ -f "$FAKE_VENDOR_DRILL_STATE_DIRECTORY/stack-updated" ]]; then
        vendor_url='https://vendor-rate-limit-drill.trycloudflare.com'
      fi
      jq -cn --arg arn "$worker_arn" --arg vendorUrl "$vendor_url" '
        {
          FunctionArn: $arn,
          State: "Active",
          LastUpdateStatus: "Successful",
          Timeout: 15,
          MemorySize: 128,
          VendorTimeoutMs: "3000",
          VendorBaseUrl: $vendorUrl
        }
      '
    fi
    ;;

  lambda:list-event-source-mappings)
    jq -cn --arg uuid "$mapping_uuid" \
      '{EventSourceMappings: [{UUID: $uuid}]}'
    ;;

  lambda:get-event-source-mapping)
    jq -cn \
      --arg uuid "$mapping_uuid" \
      --arg queueArn "$delivery_queue_arn" '
        {
          UUID: $uuid,
          State: "Enabled",
          EventSourceArn: $queueArn,
          BatchSize: 2,
          FunctionResponseTypes: ["ReportBatchItemFailures"],
          ScalingConfig: {MaximumConcurrency: 2}
        }
      '
    ;;

  sqs:get-queue-attributes)
    queue_attributes "$(option_value --queue-url "$@")"
    ;;

  sqs:list-message-move-tasks)
    if [[ -f "$FAKE_VENDOR_DRILL_STATE_DIRECTORY/redrive-completed" ]]; then
      started_at="$(<"$FAKE_VENDOR_DRILL_STATE_DIRECTORY/redrive-started-at")"
      moved=1
      if [[ "${FAKE_VENDOR_DRILL_STALE_REDRIVE_COUNT_ONCE:-0}" == '1' ]] &&
        [[ "$(increment_counter redrive-list-attempt)" == '1' ]]; then
        moved=0
      fi
      jq -cn \
        --arg sourceArn "$worker_dlq_arn" \
        --argjson moved "$moved" \
        --argjson startedAt "$started_at" '
          {
            Results: [{
              Status: "COMPLETED",
              SourceArn: $sourceArn,
              ApproximateNumberOfMessagesMoved: $moved,
              ApproximateNumberOfMessagesToMove: 0,
              StartedTimestamp: $startedAt
            }]
          }
        '
    fi
    ;;

  sqs:receive-message)
    attempt="$(increment_counter dlq-receive-attempt)"
    if ((attempt <= ${FAKE_VENDOR_DRILL_EMPTY_DLQ_RECEIVES:-0})); then
      exit 0
    fi
    [[ -f "$FAKE_VENDOR_DRILL_STATE_DIRECTORY/dlq-ready" ]] || exit 0
    touch "$FAKE_VENDOR_DRILL_STATE_DIRECTORY/dlq-invisible"
    body="$(domain_event)"
    jq -cn --arg body "$body" '
      {
        Messages: [{
          MessageId: "fake-rate-limit-message",
          ReceiptHandle: "fake-rate-limit-receipt",
          Body: $body,
          Attributes: {ApproximateReceiveCount: "4"}
        }]
      }
    '
    ;;

  sqs:change-message-visibility)
    [[ "$(option_value --receipt-handle "$@")" == 'fake-rate-limit-receipt' ]] || exit 97
    [[ "$(option_value --visibility-timeout "$@")" == '0' ]] || exit 98
    rm -f "$FAKE_VENDOR_DRILL_STATE_DIRECTORY/dlq-invisible"
    ;;

  sqs:start-message-move-task)
    [[ -f "$FAKE_VENDOR_DRILL_STATE_DIRECTORY/dlq-ready" ]] || exit 99
    [[ ! -f "$FAKE_VENDOR_DRILL_STATE_DIRECTORY/dlq-invisible" ]] || exit 100
    [[ "$(<"$FAKE_VENDOR_DRILL_STATE_DIRECTORY/vendor-scenario")" == 'success' ]] || exit 101
    date +%s%3N | cut -c1-13 >"$FAKE_VENDOR_DRILL_STATE_DIRECTORY/redrive-started-at"
    provider_order_id="delivery_fakevendor429drill"
    jq \
      --arg providerOrderId "$provider_order_id" '
        .status.S = "SUBMITTED" |
        .version.N = "2" |
        .order.M.status.S = "SUBMITTED" |
        .order.M.version.N = "2" |
        .order.M.provider.M.providerOrderId = {S: $providerOrderId} |
        .order.M.provider.M.acceptedAt = {S: "2026-07-27T07:05:00.000Z"}
      ' "$FAKE_VENDOR_DRILL_STATE_DIRECTORY/order.json" \
      >"$FAKE_VENDOR_DRILL_STATE_DIRECTORY/order.json.tmp"
    mv \
      "$FAKE_VENDOR_DRILL_STATE_DIRECTORY/order.json.tmp" \
      "$FAKE_VENDOR_DRILL_STATE_DIRECTORY/order.json"
    jq -cn \
      --arg orderId "$(order_value '.order.M.orderId.S')" \
      --arg providerOrderId "$provider_order_id" '
        {
          entityType: {S: "PROVIDER_ORDER"},
          schemaVersion: {N: "1"},
          merchantId: {S: "mrc_demo"},
          orderId: {S: $orderId},
          providerOrderId: {S: $providerOrderId}
        }
      ' >"$FAKE_VENDOR_DRILL_STATE_DIRECTORY/provider-item.json"
    append_attempt success 201
    touch \
      "$FAKE_VENDOR_DRILL_STATE_DIRECTORY/redrive-completed" \
      "$FAKE_VENDOR_DRILL_STATE_DIRECTORY/order-submitted"
    jq -cn --arg handle "$task_handle" '{TaskHandle: $handle}'
    ;;

  dynamodb:get-item)
    if [[ -f "$FAKE_VENDOR_DRILL_STATE_DIRECTORY/order.json" ]]; then
      jq -cn --slurpfile item "$FAKE_VENDOR_DRILL_STATE_DIRECTORY/order.json" \
        '{Item: $item[0]}'
    fi
    ;;

  dynamodb:scan)
    if [[ -f "$FAKE_VENDOR_DRILL_STATE_DIRECTORY/order.json" ]]; then
      jq -cn --slurpfile item "$FAKE_VENDOR_DRILL_STATE_DIRECTORY/order.json" \
        '{Count: 1, Items: [{pk: $item[0].pk, sk: $item[0].sk}]}'
    else
      printf '{"Count":0,"Items":[]}\n'
    fi
    ;;

  dynamodb:put-item)
    item_uri="$(option_value --item "$@")"
    cp "${item_uri#file://}" "$FAKE_VENDOR_DRILL_STATE_DIRECTORY/order.json"
    [[ "$(<"$FAKE_VENDOR_DRILL_STATE_DIRECTORY/vendor-scenario")" == 'rate-limit' ]] || exit 102
    append_attempt rate-limit 429
    append_attempt rate-limit 429
    append_attempt rate-limit 429
    touch "$FAKE_VENDOR_DRILL_STATE_DIRECTORY/dlq-ready"
    printf '{}\n'
    ;;

  dynamodb:transact-write-items)
    items_uri="$(option_value --transact-items "$@")"
    jq -e 'length == 2 and all(.[]; has("Delete"))' "${items_uri#file://}" >/dev/null ||
      exit 103
    [[ -f "$FAKE_VENDOR_DRILL_STATE_DIRECTORY/order-submitted" ]] || exit 104
    rm -f \
      "$FAKE_VENDOR_DRILL_STATE_DIRECTORY/order.json" \
      "$FAKE_VENDOR_DRILL_STATE_DIRECTORY/provider-item.json"
    touch "$FAKE_VENDOR_DRILL_STATE_DIRECTORY/data-deleted"
    printf '{}\n'
    ;;

  logs:filter-log-events)
    order_id="$(order_value '.order.M.orderId.S')"
    jq -cn \
      --arg eventId "$event_id" \
      --arg orderId "$order_id" '
        {
          events: [1, 2, 3] | map({
            timestamp: 1785135600000,
            message: (
              "2026-07-27T07:00:00.000Z\tfake-request\tINFO\t" +
              ({
                timestamp: "2026-07-27T07:00:00.000Z",
                level: "error",
                event: "delivery.message.failed",
                requestId: "fake-rate-limit-message",
                operation: "processDeliveryEvent",
                eventId: $eventId,
                orderId: $orderId,
                exceptionName: "VendorSubmissionError"
              } | tojson) +
              "\n"
            )
          })
        }
      '
    ;;

  *)
    printf 'Unexpected fake AWS call: %s %s\n' "$service" "$operation" >&2
    exit 105
    ;;
esac
