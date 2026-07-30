#!/usr/bin/env bash

set -euo pipefail

readonly expected_account_id='454921778743'
readonly expected_region='eu-central-1'
readonly expected_profile='pingusportro-admin'
readonly expected_merchant_id='mrc_demo'
readonly stack_name='serverless-order-integration-dev'
readonly drill_queue_prefix='serverless-order-integration-dev-publisher-failure-drill-'
readonly drill_item_prefix='DRILL#STREAM_PUBLISHER#'
readonly sqs_call_cap=100
readonly sns_call_cap=50
readonly dynamodb_call_cap=20
readonly streams_call_cap=50
readonly logs_call_cap=50
readonly lambda_call_cap=20

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
default_state_directory="$project_root/.aws-sam/cloud-drill/stream-publisher-failure"

if [[ -n "${STREAM_PUBLISHER_DRILL_AWS_CLI:-}" ||
  -n "${STREAM_PUBLISHER_DRILL_STATE_DIRECTORY:-}" ||
  -n "${STREAM_PUBLISHER_DRILL_POLL_SECONDS:-}" ]]; then
  if [[ "${STREAM_PUBLISHER_DRILL_TEST_MODE:-}" != '1' ]]; then
    echo 'Drill test overrides require STREAM_PUBLISHER_DRILL_TEST_MODE=1.' >&2
    exit 2
  fi
fi

readonly aws_cli="${STREAM_PUBLISHER_DRILL_AWS_CLI:-aws}"
readonly state_directory="${STREAM_PUBLISHER_DRILL_STATE_DIRECTORY:-$default_state_directory}"
readonly poll_seconds="${STREAM_PUBLISHER_DRILL_POLL_SECONDS:-5}"
readonly state_file="$state_directory/state.json"
readonly call_log="$state_directory/aws-calls.log"

usage() {
  cat <<'EOF'
Usage:
  scripts/cloud/stream-publisher-failure-drill.sh run
  scripts/cloud/stream-publisher-failure-drill.sh cleanup

The run mode injects one marked malformed DynamoDB item, verifies retry
exhaustion through the publisher failure queue, repairs that same item, proves
same-shard progress through an isolated SNS subscription, and cleans up.

The cleanup mode resumes an interrupted approved run from validated ignored
state under .aws-sam/cloud-drill/stream-publisher-failure/.
EOF
}

fail() {
  echo "Stream-publisher failure drill: $*" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "required command not found: $1"
}

service_cap() {
  case "$1" in
    sqs) echo "$sqs_call_cap" ;;
    sns) echo "$sns_call_cap" ;;
    dynamodb) echo "$dynamodb_call_cap" ;;
    dynamodbstreams) echo "$streams_call_cap" ;;
    logs) echo "$logs_call_cap" ;;
    lambda) echo "$lambda_call_cap" ;;
    *) echo '0' ;;
  esac
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
    dynamodb:put-item) cap=2 ;;
    dynamodb:delete-item) cap=3 ;;
    sqs:create-queue) cap=1 ;;
    sqs:set-queue-attributes) cap=1 ;;
    sqs:delete-message) cap=10 ;;
    sqs:delete-queue) cap=3 ;;
    sns:subscribe) cap=1 ;;
    sns:unsubscribe) cap=3 ;;
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

  local cap
  local current
  cap="$(service_cap "$counted_service")"
  if ((cap > 0)); then
    current="$(call_count "$counted_service")"
    ((current < cap)) ||
      fail "$counted_service API-call cap of $cap would be exceeded"
  fi
  assert_operation_headroom "$counted_service" "$operation"

  printf '%s %s\n' "$counted_service" "$operation" >>"$call_log"
  "$aws_cli" "$@" \
    --profile "$expected_profile" \
    --region "$expected_region" \
    --no-cli-pager
}

state_create() {
  local marker="$1"
  local order_id="$2"
  local item_pk="$3"
  local item_sk="$4"
  local queue_name="$5"
  local started_at_ms="$6"

  jq -n \
    --arg accountId "$expected_account_id" \
    --arg region "$expected_region" \
    --arg stackName "$stack_name" \
    --arg marker "$marker" \
    --arg orderId "$order_id" \
    --arg itemPk "$item_pk" \
    --arg itemSk "$item_sk" \
    --arg queueName "$queue_name" \
    --arg startedAtMs "$started_at_ms" \
    --arg tableName "$table_name" \
    --arg streamArn "$stream_arn" \
    --arg topicArn "$topic_arn" \
    --arg publisherFunctionName "$publisher_function_name" \
    --arg publisherFunctionArn "$publisher_function_arn" \
    --arg publisherLogGroup "$publisher_log_group" \
    --arg mappingUuid "$mapping_uuid" \
    --arg deliveryQueueUrl "$delivery_queue_url" \
    --arg workerDlqUrl "$worker_dlq_url" \
    --arg publisherFailureQueueUrl "$publisher_failure_queue_url" \
    --arg publisherFailureQueueArn "$publisher_failure_queue_arn" \
    --arg subscriptionDlqUrl "$subscription_dlq_url" '
      {
        accountId: $accountId,
        region: $region,
        stackName: $stackName,
        marker: $marker,
        orderId: $orderId,
        itemPk: $itemPk,
        itemSk: $itemSk,
        queueName: $queueName,
        startedAtMs: $startedAtMs,
        tableName: $tableName,
        streamArn: $streamArn,
        topicArn: $topicArn,
        publisherFunctionName: $publisherFunctionName,
        publisherFunctionArn: $publisherFunctionArn,
        publisherLogGroup: $publisherLogGroup,
        mappingUuid: $mappingUuid,
        deliveryQueueUrl: $deliveryQueueUrl,
        workerDlqUrl: $workerDlqUrl,
        publisherFailureQueueUrl: $publisherFailureQueueUrl,
        publisherFailureQueueArn: $publisherFailureQueueArn,
        subscriptionDlqUrl: $subscriptionDlqUrl,
        temporaryQueueUrl: "",
        temporaryQueueArn: "",
        temporarySubscriptionArn: "",
        poisonWriteAttempted: false,
        poisonWritten: false,
        failureReceiptHandle: "",
        failureSequenceNumber: "",
        failureShardId: "",
        failureVerified: false,
        failureDeleteAttempted: false,
        failureDeleted: false,
        logsVerified: false,
        repairWriteAttempted: false,
        repairWritten: false,
        recoveryReceiptHandle: "",
        recoveryEventId: "",
        recoveryVerified: false,
        recoveryDeleteAttempted: false,
        recoveryDeleted: false,
        itemDeleteAttempted: false,
        itemDeleted: false
      }
    ' >"$state_file"
}

state_set_string() {
  local field="$1"
  local value="$2"
  local next_state="$state_file.next"
  jq --arg field "$field" --arg value "$value" '.[$field] = $value' "$state_file" >"$next_state"
  mv "$next_state" "$state_file"
}

state_set_boolean() {
  local field="$1"
  local value="$2"
  local next_state="$state_file.next"
  jq --arg field "$field" --argjson value "$value" '.[$field] = $value' "$state_file" >"$next_state"
  mv "$next_state" "$state_file"
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
  jq -r --arg field "$field" '
    if (.[$field] | type) == "boolean" then
      .[$field]
    else
      error("state field must be a boolean: " + $field)
    end
  ' "$state_file"
}

assert_identity() {
  local account_id
  account_id="$(aws_call sts sts get-caller-identity --query Account --output text)"
  [[ "$account_id" == "$expected_account_id" ]] ||
    fail "expected account $expected_account_id, received $account_id"
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

assert_stack_status() {
  local status
  status="$(aws_call cloudformation cloudformation describe-stacks \
    --stack-name "$stack_name" \
    --query 'Stacks[0].StackStatus' \
    --output text)"
  [[ "$status" == 'UPDATE_COMPLETE' ]] ||
    fail "stack must be UPDATE_COMPLETE, received $status"
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
  local attributes
  for attempt in {1..5}; do
    attributes="$(queue_attributes "$queue_url")"
    if jq -e '
      .Attributes.ApproximateNumberOfMessages == "0" and
      .Attributes.ApproximateNumberOfMessagesNotVisible == "0" and
      .Attributes.ApproximateNumberOfMessagesDelayed == "0"
    ' <<<"$attributes" >/dev/null; then
      return
    fi
    ((attempt == 5)) || sleep "$poll_seconds"
  done
  fail "queue did not report empty after bounded consistency checks: $queue_url"
}

queue_is_empty_once() {
  local attributes
  attributes="$(queue_attributes "$1")"
  jq -e '
    .Attributes.ApproximateNumberOfMessages == "0" and
    .Attributes.ApproximateNumberOfMessagesNotVisible == "0" and
    .Attributes.ApproximateNumberOfMessagesDelayed == "0"
  ' <<<"$attributes" >/dev/null
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
  publisher_function_name="$(stack_resource StreamPublisherFunction)"
  publisher_log_group="$(stack_resource StreamPublisherLogGroup)"

  [[ "$stream_arn" == "arn:aws:dynamodb:$expected_region:$expected_account_id:"* ]] ||
    fail "unexpected stream ARN: $stream_arn"
  [[ "$topic_arn" == "arn:aws:sns:$expected_region:$expected_account_id:"* ]] ||
    fail "unexpected topic ARN: $topic_arn"

  publisher_failure_queue_arn="$(queue_arn "$publisher_failure_queue_url")"
  publisher_function_arn="$(aws_call lambda lambda get-function-configuration \
    --function-name "$publisher_function_name" \
    --query FunctionArn \
    --output text)"
  local expected_function_arn
  expected_function_arn="arn:aws:lambda:$expected_region:$expected_account_id:function:$publisher_function_name"
  [[ "$publisher_function_arn" == "$expected_function_arn" ]] ||
    fail "unexpected publisher function ARN: $publisher_function_arn"

  local mappings
  mappings="$(aws_call lambda lambda list-event-source-mappings \
    --function-name "$publisher_function_name" \
    --event-source-arn "$stream_arn" \
    --output json)"
  mapping_uuid="$(jq -er '
    if (.EventSourceMappings | length) == 1 then
      .EventSourceMappings[0].UUID
    else
      error("expected exactly one publisher stream mapping")
    end
  ' <<<"$mappings")"
  mapping_json="$(jq -c '.EventSourceMappings[0]' <<<"$mappings")"
}

assert_mapping_contract() {
  jq -e \
    --arg destination "$publisher_failure_queue_arn" \
    --arg streamArn "$stream_arn" '
      .State == "Enabled" and
      .EventSourceArn == $streamArn and
      .BatchSize == 10 and
      .BisectBatchOnFunctionError == true and
      .MaximumRecordAgeInSeconds == 3600 and
      .MaximumRetryAttempts == 2 and
      (.ParallelizationFactor // 1) == 1 and
      .FunctionResponseTypes == ["ReportBatchItemFailures"] and
      .DestinationConfig.OnFailure.Destination == $destination and
      (.FilterCriteria.Filters | length) == 1 and
      (.FilterCriteria.Filters[0].Pattern | fromjson) == {
        eventName: ["INSERT", "MODIFY"],
        dynamodb: {NewImage: {entityType: {S: ["ORDER"]}}}
      }
    ' <<<"$mapping_json" >/dev/null ||
    fail 'publisher event-source mapping does not match the approved contract'
}

assert_table_contract() {
  local table
  table="$(aws_call dynamodb dynamodb describe-table \
    --table-name "$table_name" \
    --output json)"
  jq -e '
    .Table.TableStatus == "ACTIVE" and
    .Table.BillingModeSummary.BillingMode == "PAY_PER_REQUEST" and
    .Table.StreamSpecification == {
      StreamEnabled: true,
      StreamViewType: "NEW_IMAGE"
    } and
    .Table.KeySchema == [
      {AttributeName: "pk", KeyType: "HASH"},
      {AttributeName: "sk", KeyType: "RANGE"}
    ]
  ' <<<"$table" >/dev/null ||
    fail 'orders table does not match the approved drill contract'
}

assert_no_drill_items() {
  local result
  result="$(aws_call dynamodb dynamodb scan \
    --table-name "$table_name" \
    --filter-expression 'begins_with(pk, :prefix)' \
    --expression-attribute-values \
      "$(jq -cn --arg prefix "$drill_item_prefix" '{":prefix": {S: $prefix}}')" \
    --projection-expression 'pk, sk, drillMarker' \
    --output json)"
  [[ "$(jq '.Count // 0' <<<"$result")" == '0' ]] ||
    fail 'a previous stream-publisher drill item remains in DynamoDB'
}

assert_no_temporary_resources() {
  local queues
  local subscriptions
  queues="$(aws_call sqs sqs list-queues \
    --queue-name-prefix "$drill_queue_prefix" \
    --output json)"
  [[ -n "$queues" ]] || queues='{}'
  [[ "$(jq '(.QueueUrls // []) | length' <<<"$queues")" == '0' ]] ||
    fail 'a previous stream-publisher drill queue remains'

  subscriptions="$(aws_call sns sns list-subscriptions-by-topic \
    --topic-arn "$topic_arn" \
    --output json)"
  jq -e --arg prefix "$drill_queue_prefix" '
    [.Subscriptions[]? | select((.Endpoint // "") | contains($prefix))] | length == 0
  ' <<<"$subscriptions" >/dev/null ||
    fail 'a previous stream-publisher drill subscription remains'
}

item_key_json() {
  jq -cn \
    --arg pk "$(state_string itemPk)" \
    --arg sk "$(state_string itemSk)" \
    '{pk: {S: $pk}, sk: {S: $sk}}'
}

read_drill_item() {
  local result
  result="$(aws_call dynamodb dynamodb get-item \
    --table-name "$table_name" \
    --key "$(item_key_json)" \
    --consistent-read \
    --output json)"
  [[ -n "$result" ]] || result='{}'
  printf '%s\n' "$result"
}

assert_item_absent() {
  local item
  item="$(read_drill_item)"
  [[ "$(jq 'has("Item")' <<<"$item")" == 'false' ]] ||
    fail 'the generated drill key already exists'
}

poison_item_json() {
  jq -cn \
    --arg pk "$(state_string itemPk)" \
    --arg sk "$(state_string itemSk)" \
    --arg marker "$(state_string marker)" '
      {
        pk: {S: $pk},
        sk: {S: $sk},
        entityType: {S: "ORDER"},
        schemaVersion: {N: "999"},
        drillMarker: {S: $marker}
      }
    '
}

repair_item_json() {
  local now
  now="$(date -u +%Y-%m-%dT%H:%M:%S.000Z)"
  jq -cn \
    --arg pk "$(state_string itemPk)" \
    --arg sk "$(state_string itemSk)" \
    --arg marker "$(state_string marker)" \
    --arg orderId "$(state_string orderId)" \
    --arg merchantId "$expected_merchant_id" \
    --arg now "$now" '
      {
        pk: {S: $pk},
        sk: {S: $sk},
        entityType: {S: "ORDER"},
        schemaVersion: {N: "2"},
        drillMarker: {S: $marker},
        order: {M: {
          orderId: {S: $orderId},
          merchantId: {S: $merchantId},
          status: {S: "CANCELLED"},
          version: {N: "2"},
          updatedAt: {S: $now},
          provider: {M: {
            deliveryProviderCode: {S: "mock-delivery"},
            deliveryProviderSubmissionKey: {S: ("submission_" + $marker)}
          }}
        }},
        mutation: {M: {
          kind: {S: "ORDER_STATUS_CHANGED"},
          correlationId: {S: $marker},
          causationId: {S: ("cause_" + $marker)},
          previousStatus: {S: "PENDING_SUBMISSION"},
          reason: {S: "Publisher failure drill recovery."}
        }}
      }
    '
}

write_poison_item() {
  state_set_boolean poisonWriteAttempted true
  aws_call dynamodb dynamodb put-item \
    --table-name "$table_name" \
    --item "$(poison_item_json)" \
    --condition-expression 'attribute_not_exists(pk) AND attribute_not_exists(sk)' \
    --return-consumed-capacity TOTAL \
    --output json >/dev/null
  state_set_boolean poisonWritten true
}

reconcile_poison_write() {
  [[ "$(state_boolean poisonWritten)" == 'false' ]] || return 0
  [[ "$(state_boolean poisonWriteAttempted)" == 'true' ]] || return 0
  local item
  item="$(read_drill_item)"
  if [[ "$(jq 'has("Item")' <<<"$item")" == 'false' ]]; then
    return
  fi
  jq -e \
    --arg marker "$(state_string marker)" '
      .Item.entityType.S == "ORDER" and
      .Item.schemaVersion.N == "999" and
      .Item.drillMarker.S == $marker
    ' <<<"$item" >/dev/null ||
    fail 'the attempted poison write cannot be reconciled to the saved marker'
  state_set_boolean poisonWritten true
}

create_temporary_queue() {
  local queue_name
  local queue_url
  local attributes
  local queue_arn
  local policy
  local policy_attributes
  queue_name="$(state_string queueName)"
  queue_url="$(aws_call sqs sqs create-queue \
    --queue-name "$queue_name" \
    --attributes MessageRetentionPeriod=300,SqsManagedSseEnabled=true \
    --tags Project=serverless-order-integration,Environment=dev,Purpose=publisher-failure-drill \
    --query QueueUrl \
    --output text)"
  [[ "${queue_url##*/}" == "$queue_name" ]] ||
    fail "created queue URL does not match requested drill name: $queue_url"
  state_set_string temporaryQueueUrl "$queue_url"

  attributes="$(queue_attributes "$queue_url")"
  queue_arn="$(jq -er '.Attributes.QueueArn' <<<"$attributes")"
  state_set_string temporaryQueueArn "$queue_arn"
  jq -e '
    .Attributes.MessageRetentionPeriod == "300" and
    .Attributes.SqsManagedSseEnabled == "true" and
    ((.Attributes.Policy // "") == "")
  ' <<<"$attributes" >/dev/null ||
    fail 'temporary recovery queue base attributes violate the drill contract'

  policy="$(jq -cn \
    --arg accountId "$expected_account_id" \
    --arg queueArn "$queue_arn" \
    --arg topicArn "$topic_arn" '
      {
        Version: "2012-10-17",
        Statement: [{
          Sid: "AllowDrillRecoveryEvent",
          Effect: "Allow",
          Principal: {Service: "sns.amazonaws.com"},
          Action: "sqs:SendMessage",
          Resource: $queueArn,
          Condition: {
            ArnEquals: {"aws:SourceArn": $topicArn},
            StringEquals: {"aws:SourceAccount": $accountId}
          }
        }]
      }
    ')"
  policy_attributes="$(jq -cn --arg policy "$policy" '{Policy: $policy}')"
  aws_call sqs sqs set-queue-attributes \
    --queue-url "$queue_url" \
    --attributes "$policy_attributes" >/dev/null

  attributes="$(queue_attributes "$queue_url")"
  jq -e \
    --arg policy "$policy" '
      .Attributes.MessageRetentionPeriod == "300" and
      .Attributes.SqsManagedSseEnabled == "true" and
      (.Attributes.Policy | fromjson) == ($policy | fromjson)
    ' <<<"$attributes" >/dev/null ||
    fail 'temporary recovery queue policy violates the drill contract'

  local tags
  tags="$(aws_call sqs sqs list-queue-tags --queue-url "$queue_url" --output json)"
  jq -e '
    .Tags == {
      Environment: "dev",
      Project: "serverless-order-integration",
      Purpose: "publisher-failure-drill"
    }
  ' <<<"$tags" >/dev/null ||
    fail 'temporary recovery queue tags violate the drill contract'
}

create_temporary_subscription() {
  local filter_policy
  local attributes
  local subscription_arn
  local deployed
  filter_policy="$(jq -cn \
    --arg aggregateId "$(state_string orderId)" '
      {
        eventType: ["order.cancelled"],
        aggregateId: [$aggregateId]
      }
    ')"
  attributes="$(jq -cn --arg filter "$filter_policy" '
    {
      RawMessageDelivery: "true",
      FilterPolicyScope: "MessageAttributes",
      FilterPolicy: $filter
    }
  ')"
  subscription_arn="$(aws_call sns sns subscribe \
    --topic-arn "$topic_arn" \
    --protocol sqs \
    --notification-endpoint "$(state_string temporaryQueueArn)" \
    --attributes "$attributes" \
    --return-subscription-arn \
    --query SubscriptionArn \
    --output text)"
  [[ "$subscription_arn" == "$topic_arn:"* ]] ||
    fail "temporary recovery subscription was not confirmed: $subscription_arn"
  state_set_string temporarySubscriptionArn "$subscription_arn"

  deployed="$(aws_call sns sns get-subscription-attributes \
    --subscription-arn "$subscription_arn" \
    --output json)"
  jq -e --arg filter "$filter_policy" '
    .Attributes.PendingConfirmation == "false" and
    .Attributes.RawMessageDelivery == "true" and
    .Attributes.FilterPolicyScope == "MessageAttributes" and
    (.Attributes.FilterPolicy | fromjson) == ($filter | fromjson) and
    ((.Attributes.RedrivePolicy // "") == "")
  ' <<<"$deployed" >/dev/null ||
    fail 'temporary recovery subscription attributes violate the drill contract'
}

verify_stream_record() {
  local shard_id="$1"
  local sequence_number="$2"
  local iterator
  local records
  iterator="$(aws_call dynamodbstreams dynamodbstreams get-shard-iterator \
    --stream-arn "$stream_arn" \
    --shard-id "$shard_id" \
    --shard-iterator-type AT_SEQUENCE_NUMBER \
    --sequence-number "$sequence_number" \
    --query ShardIterator \
    --output text)"
  [[ -n "$iterator" && "$iterator" != 'None' ]] ||
    fail 'DynamoDB Streams did not return a shard iterator'
  records="$(aws_call dynamodbstreams dynamodbstreams get-records \
    --shard-iterator "$iterator" \
    --limit 10 \
    --output json)"
  jq -e \
    --arg sequence "$sequence_number" \
    --arg pk "$(state_string itemPk)" \
    --arg sk "$(state_string itemSk)" \
    --arg marker "$(state_string marker)" '
      [
        .Records[]? |
        select(.dynamodb.SequenceNumber == $sequence)
      ] as $matches |
      ($matches | length) == 1 and
      $matches[0].eventName == "INSERT" and
      $matches[0].dynamodb.Keys.pk.S == $pk and
      $matches[0].dynamodb.Keys.sk.S == $sk and
      $matches[0].dynamodb.NewImage.entityType.S == "ORDER" and
      $matches[0].dynamodb.NewImage.schemaVersion.N == "999" and
      $matches[0].dynamodb.NewImage.drillMarker.S == $marker
    ' <<<"$records" >/dev/null ||
    fail 'failure metadata did not resolve to the exact marked poison record'
}

receive_and_verify_failure() {
  local response
  local count
  local body
  local receipt
  local shard_id
  local sequence

  for _ in {1..12}; do
    response="$(aws_call sqs sqs receive-message \
      --queue-url "$publisher_failure_queue_url" \
      --max-number-of-messages 10 \
      --wait-time-seconds 10 \
      --visibility-timeout 60 \
      --attribute-names All \
      --message-attribute-names All \
      --output json)"
    [[ -n "$response" ]] || response='{}'
    count="$(jq '(.Messages // []) | length' <<<"$response")"
    if [[ "$count" == '0' ]]; then
      continue
    fi
    [[ "$count" == '1' ]] ||
      fail "expected one publisher failure message, received $count"

    body="$(jq -er '.Messages[0].Body' <<<"$response")"
    jq -e \
      --arg functionArn "$publisher_function_arn" \
      --arg streamArn "$stream_arn" '
        .version == "1.0" and
        .requestContext.condition == "RetryAttemptsExhausted" and
        .requestContext.functionArn == $functionArn and
        .DDBStreamBatchInfo.streamArn == $streamArn and
        .DDBStreamBatchInfo.batchSize == 1 and
        .DDBStreamBatchInfo.startSequenceNumber ==
          .DDBStreamBatchInfo.endSequenceNumber and
        (.DDBStreamBatchInfo.shardId | type) == "string" and
        (.DDBStreamBatchInfo.shardId | length) > 0 and
        (.DDBStreamBatchInfo.startSequenceNumber | type) == "string" and
        (.DDBStreamBatchInfo.startSequenceNumber | length) > 0
      ' <<<"$body" >/dev/null ||
      fail 'publisher failure queue contains an unexpected invocation record'

    shard_id="$(jq -er '.DDBStreamBatchInfo.shardId' <<<"$body")"
    sequence="$(jq -er '.DDBStreamBatchInfo.startSequenceNumber' <<<"$body")"
    verify_stream_record "$shard_id" "$sequence"

    receipt="$(jq -er '.Messages[0].ReceiptHandle' <<<"$response")"
    state_set_string failureReceiptHandle "$receipt"
    state_set_string failureShardId "$shard_id"
    state_set_string failureSequenceNumber "$sequence"
    state_set_boolean failureVerified true
    return
  done
  if [[ "$(state_boolean failureDeleteAttempted)" == 'true' ]] &&
    queue_is_empty_once "$publisher_failure_queue_url"; then
    state_set_string failureReceiptHandle ''
    state_set_boolean failureDeleted true
    return
  fi
  fail 'marked poison record did not reach the publisher failure queue within 120 seconds'
}

verify_failure_logs() {
  local sequence
  local start_time
  local response
  local count
  sequence="$(state_string failureSequenceNumber)"
  start_time="$(state_string startedAtMs)"
  if [[ ! "$start_time" =~ ^[0-9]{13}$ ]]; then
    [[ "$start_time" =~ ^[0-9]{10,}$ ]] ||
      fail 'saved drill start time is not a Unix timestamp'
    start_time="${start_time:0:10}000"
    state_set_string startedAtMs "$start_time"
  fi

  for _ in {1..24}; do
    response="$(aws_call logs logs filter-log-events \
      --log-group-name "$publisher_log_group" \
      --start-time "$start_time" \
      --filter-pattern "\"$sequence\"" \
      --output json)"
    count="$(jq \
      --arg sequence "$sequence" '
        [
          .events[]?.message |
          split("\t") |
          .[-1] |
          fromjson? |
          select(
            .event == "stream.record.failed" and
            .level == "error" and
            .requestId == $sequence and
            .operation == "parseOrderStreamRecord" and
            .exceptionName == "Error"
          )
        ] | length
      ' <<<"$response")"
    if [[ "$count" == '3' ]]; then
      state_set_boolean logsVerified true
      return
    fi
    ((count < 3)) ||
      fail "expected exactly three marked publisher failures, received $count"
    sleep "$poll_seconds"
  done
  fail 'three structured poison-record failure logs were not visible within 120 seconds'
}

write_repair_item() {
  state_set_boolean repairWriteAttempted true
  aws_call dynamodb dynamodb put-item \
    --table-name "$table_name" \
    --item "$(repair_item_json)" \
    --condition-expression 'drillMarker = :marker AND entityType = :entityType' \
    --expression-attribute-values \
      "$(jq -cn \
        --arg marker "$(state_string marker)" '
          {
            ":marker": {S: $marker},
            ":entityType": {S: "ORDER"}
          }
        ')" \
    --return-consumed-capacity TOTAL \
    --output json >/dev/null
  state_set_boolean repairWritten true
}

reconcile_repair_write() {
  [[ "$(state_boolean repairWritten)" == 'false' ]] || return 0
  [[ "$(state_boolean repairWriteAttempted)" == 'true' ]] || return 0
  local item
  item="$(read_drill_item)"
  if jq -e \
    --arg marker "$(state_string marker)" '
      .Item.entityType.S == "ORDER" and
      .Item.schemaVersion.N == "999" and
      .Item.drillMarker.S == $marker
    ' <<<"$item" >/dev/null; then
    return
  fi
  jq -e \
    --arg marker "$(state_string marker)" \
    --arg orderId "$(state_string orderId)" '
      .Item.entityType.S == "ORDER" and
      .Item.schemaVersion.N == "2" and
      .Item.drillMarker.S == $marker and
      .Item.order.M.orderId.S == $orderId and
      .Item.order.M.status.S == "CANCELLED"
    ' <<<"$item" >/dev/null ||
    fail 'the attempted repair write cannot be reconciled to the saved marker'
  state_set_boolean repairWritten true
}

receive_and_verify_recovery() {
  local response
  local count
  local body
  local receipt
  local event_id
  local queue_url
  queue_url="$(state_string temporaryQueueUrl)"
  [[ -n "$queue_url" ]] || fail 'recovery queue URL is absent from state'

  for _ in {1..12}; do
    response="$(aws_call sqs sqs receive-message \
      --queue-url "$queue_url" \
      --max-number-of-messages 10 \
      --wait-time-seconds 10 \
      --visibility-timeout 60 \
      --attribute-names All \
      --message-attribute-names All \
      --output json)"
    [[ -n "$response" ]] || response='{}'
    count="$(jq '(.Messages // []) | length' <<<"$response")"
    if [[ "$count" == '0' ]]; then
      continue
    fi
    [[ "$count" == '1' ]] ||
      fail "expected one recovery event, received $count"

    body="$(jq -er '.Messages[0].Body' <<<"$response")"
    jq -e \
      --arg aggregateId "$(state_string orderId)" \
      --arg marker "$(state_string marker)" \
      --arg merchantId "$expected_merchant_id" '
        .eventType == "order.cancelled" and
        .schemaVersion == 2 and
        .aggregateType == "ORDER" and
        .aggregateId == $aggregateId and
        .aggregateVersion == 2 and
        .correlationId == $marker and
        .causationId == ("cause_" + $marker) and
        .payload.merchantId == $merchantId and
        .payload.previousStatus == "PENDING_SUBMISSION" and
        .payload.status == "CANCELLED"
      ' <<<"$body" >/dev/null ||
      fail 'temporary queue contains an unexpected recovery event'

    receipt="$(jq -er '.Messages[0].ReceiptHandle' <<<"$response")"
    event_id="$(jq -er '.eventId' <<<"$body")"
    state_set_string recoveryReceiptHandle "$receipt"
    state_set_string recoveryEventId "$event_id"
    state_set_boolean recoveryVerified true
    return
  done
  if [[ "$(state_boolean recoveryDeleteAttempted)" == 'true' ]] &&
    queue_is_empty_once "$queue_url"; then
    state_set_string recoveryReceiptHandle ''
    state_set_boolean recoveryDeleted true
    return
  fi
  fail 'same-shard recovery event was not received within 120 seconds'
}

delete_verified_message() {
  local queue_url="$1"
  local receipt_field="$2"
  local verified_field="$3"
  local attempted_field="$4"
  local deleted_field="$5"
  [[ "$(state_boolean "$verified_field")" == 'true' ]] ||
    fail "refusing to delete an unverified message: $verified_field"
  [[ "$(state_boolean "$deleted_field")" == 'false' ]] || return 0
  local receipt
  receipt="$(state_string "$receipt_field")"
  [[ -n "$receipt" ]] || return 1
  state_set_boolean "$attempted_field" true
  if aws_call sqs sqs delete-message \
    --queue-url "$queue_url" \
    --receipt-handle "$receipt" >/dev/null; then
    state_set_string "$receipt_field" ''
    state_set_boolean "$deleted_field" true
    return
  fi
  state_set_string "$receipt_field" ''
  return 1
}

delete_failure_message() {
  if delete_verified_message \
    "$publisher_failure_queue_url" \
    failureReceiptHandle \
    failureVerified \
    failureDeleteAttempted \
    failureDeleted; then
    return
  fi
  receive_and_verify_failure
  delete_verified_message \
    "$publisher_failure_queue_url" \
    failureReceiptHandle \
    failureVerified \
    failureDeleteAttempted \
    failureDeleted
}

delete_recovery_message() {
  if delete_verified_message \
    "$(state_string temporaryQueueUrl)" \
    recoveryReceiptHandle \
    recoveryVerified \
    recoveryDeleteAttempted \
    recoveryDeleted; then
    return
  fi
  receive_and_verify_recovery
  delete_verified_message \
    "$(state_string temporaryQueueUrl)" \
    recoveryReceiptHandle \
    recoveryVerified \
    recoveryDeleteAttempted \
    recoveryDeleted
}

delete_drill_item() {
  [[ "$(state_boolean itemDeleted)" == 'false' ]] || return 0
  local current
  current="$(read_drill_item)"
  if [[ "$(jq 'has("Item")' <<<"$current")" == 'false' ]]; then
    [[ "$(state_boolean itemDeleteAttempted)" == 'true' ]] ||
      fail 'drill item disappeared before a conditional delete was attempted'
    state_set_boolean itemDeleted true
    return
  fi
  local result
  state_set_boolean itemDeleteAttempted true
  result="$(aws_call dynamodb dynamodb delete-item \
    --table-name "$table_name" \
    --key "$(item_key_json)" \
    --condition-expression 'drillMarker = :marker' \
    --expression-attribute-values \
      "$(jq -cn \
        --arg marker "$(state_string marker)" '
          {":marker": {S: $marker}}
        ')" \
    --return-values ALL_OLD \
    --output json)"
  jq -e --arg marker "$(state_string marker)" '
    .Attributes.drillMarker.S == $marker
  ' <<<"$result" >/dev/null ||
    fail 'conditional item deletion did not return the marked drill item'
  state_set_boolean itemDeleted true
}

cleanup_temporary_resources() {
  local subscription_arn
  local queue_url
  subscription_arn="$(state_string temporarySubscriptionArn)"
  queue_url="$(state_string temporaryQueueUrl)"

  if [[ -n "$subscription_arn" ]]; then
    aws_call sns sns unsubscribe --subscription-arn "$subscription_arn" >/dev/null
    state_set_string temporarySubscriptionArn ''
  fi
  if [[ -n "$queue_url" ]]; then
    aws_call sqs sqs delete-queue --queue-url "$queue_url" >/dev/null
    state_set_string temporaryQueueUrl ''
    state_set_string temporaryQueueArn ''
  fi
}

assert_item_deleted() {
  local result
  result="$(read_drill_item)"
  [[ "$(jq 'has("Item")' <<<"$result")" == 'false' ]] ||
    fail 'marked drill item remains after cleanup'
}

assert_mapping_healthy() {
  local mapping
  for _ in {1..12}; do
    mapping="$(aws_call lambda lambda get-event-source-mapping \
      --uuid "$mapping_uuid" \
      --output json)"
    if jq -e '
      .State == "Enabled" and
      .LastProcessingResult == "OK"
    ' <<<"$mapping" >/dev/null; then
      return
    fi
    sleep "$poll_seconds"
  done
  fail 'publisher event-source mapping did not return to Enabled/OK'
}

complete_drill() {
  reconcile_poison_write
  [[ "$(state_boolean poisonWritten)" == 'true' ]] ||
    fail 'poison record was not written'

  if [[ "$(state_boolean failureVerified)" == 'false' ]]; then
    receive_and_verify_failure
  fi
  if [[ "$(state_boolean logsVerified)" == 'false' ]]; then
    verify_failure_logs
  fi

  reconcile_repair_write
  if [[ "$(state_boolean repairWritten)" == 'false' ]]; then
    write_repair_item
  fi
  if [[ "$(state_boolean recoveryVerified)" == 'false' ]]; then
    receive_and_verify_recovery
  fi

  delete_failure_message
  delete_recovery_message
  delete_drill_item
  cleanup_temporary_resources

  assert_item_deleted
  assert_deployed_queues_empty
  assert_no_temporary_resources
  assert_no_drill_items
  assert_mapping_healthy
  assert_stack_status
  assert_stack_in_sync
}

validate_recovery_state() {
  [[ -f "$state_file" ]] || fail "recovery state does not exist: $state_file"
  jq -e \
    --arg accountId "$expected_account_id" \
    --arg region "$expected_region" \
    --arg stackName "$stack_name" \
    --arg itemPrefix "$drill_item_prefix" \
    --arg queuePrefix "$drill_queue_prefix" '
      .accountId == $accountId and
      .region == $region and
      .stackName == $stackName and
      (.itemPk | startswith($itemPrefix)) and
      (.queueName | startswith($queuePrefix)) and
      (.marker | type) == "string" and
      (.orderId | type) == "string" and
      (.temporaryQueueUrl | type) == "string" and
      (.temporaryQueueArn | type) == "string" and
      (.temporarySubscriptionArn | type) == "string" and
      (.poisonWriteAttempted | type) == "boolean" and
      (.poisonWritten | type) == "boolean" and
      (.failureVerified | type) == "boolean" and
      (.failureDeleteAttempted | type) == "boolean" and
      (.failureDeleted | type) == "boolean" and
      (.logsVerified | type) == "boolean" and
      (.repairWriteAttempted | type) == "boolean" and
      (.repairWritten | type) == "boolean" and
      (.recoveryVerified | type) == "boolean" and
      (.recoveryDeleteAttempted | type) == "boolean" and
      (.recoveryDeleted | type) == "boolean" and
      (.itemDeleteAttempted | type) == "boolean" and
      (.itemDeleted | type) == "boolean"
    ' "$state_file" >/dev/null ||
    fail 'recovery state identity or shape does not match this drill'

  local queue_url
  local queue_arn
  local queue_name
  local subscription_arn
  queue_url="$(state_string temporaryQueueUrl)"
  queue_arn="$(state_string temporaryQueueArn)"
  queue_name="$(state_string queueName)"
  subscription_arn="$(state_string temporarySubscriptionArn)"
  if [[ -n "$queue_url" ]]; then
    local expected_queue_url
    expected_queue_url="https://sqs.$expected_region.amazonaws.com/$expected_account_id/$queue_name"
    [[ "$queue_url" == "$expected_queue_url" ]] ||
      fail 'recovery queue URL is outside the expected account or name'
    [[ "$queue_arn" == "arn:aws:sqs:$expected_region:$expected_account_id:$queue_name" ]] ||
      fail 'recovery queue ARN does not match its URL'
  fi
  if [[ -n "$subscription_arn" ]]; then
    [[ "$subscription_arn" == "$(state_string topicArn):"* ]] ||
      fail 'recovery subscription does not belong to the saved topic'
  fi
}

assert_recovery_resources_match() {
  local field
  local current
  local stored
  for field in \
    tableName \
    streamArn \
    topicArn \
    publisherFunctionName \
    publisherFunctionArn \
    publisherLogGroup \
    mappingUuid \
    deliveryQueueUrl \
    workerDlqUrl \
    publisherFailureQueueUrl \
    publisherFailureQueueArn \
    subscriptionDlqUrl; do
    stored="$(state_string "$field")"
    case "$field" in
      tableName) current="$table_name" ;;
      streamArn) current="$stream_arn" ;;
      topicArn) current="$topic_arn" ;;
      publisherFunctionName) current="$publisher_function_name" ;;
      publisherFunctionArn) current="$publisher_function_arn" ;;
      publisherLogGroup) current="$publisher_log_group" ;;
      mappingUuid) current="$mapping_uuid" ;;
      deliveryQueueUrl) current="$delivery_queue_url" ;;
      workerDlqUrl) current="$worker_dlq_url" ;;
      publisherFailureQueueUrl) current="$publisher_failure_queue_url" ;;
      publisherFailureQueueArn) current="$publisher_failure_queue_arn" ;;
      subscriptionDlqUrl) current="$subscription_dlq_url" ;;
    esac
    [[ "$stored" == "$current" ]] ||
      fail "recovery resource mismatch for $field"
  done
}

run_trap() {
  local exit_code="$1"
  trap - EXIT INT TERM
  set +e
  if [[ -f "$state_file" ]] &&
    [[ "$(state_boolean poisonWriteAttempted 2>/dev/null)" != 'true' ]]; then
    cleanup_temporary_resources
  fi
  if ((exit_code != 0)) && [[ -f "$state_file" ]]; then
    echo "Drill interrupted; recovery state retained at $state_file" >&2
    echo 'Run cleanup mode to finish the marked journey and remove its resources.' >&2
  fi
  exit "$exit_code"
}

run_drill() {
  [[ ! -e "$state_file" ]] ||
    fail "recovery state already exists; run cleanup first: $state_file"
  : >"$call_log"

  assert_identity
  assert_stack_status
  assert_stack_in_sync
  resolve_resources
  assert_mapping_contract
  assert_table_contract
  assert_deployed_queues_empty
  assert_no_temporary_resources
  assert_no_drill_items

  local suffix
  local marker
  local order_id
  local item_pk
  local item_sk
  local queue_name
  local started_at_ms
  suffix="$(date +%s)-$$"
  marker="publisher-failure-drill-$suffix"
  order_id="ord_publisher_failure_drill_$suffix"
  item_pk="$drill_item_prefix$suffix"
  item_sk="ORDER#$order_id"
  queue_name="$drill_queue_prefix$suffix"
  started_at_ms="$(( $(date +%s) * 1000 ))"

  state_create \
    "$marker" \
    "$order_id" \
    "$item_pk" \
    "$item_sk" \
    "$queue_name" \
    "$started_at_ms"
  trap 'run_trap $?' EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM

  assert_item_absent
  create_temporary_queue
  create_temporary_subscription
  write_poison_item
  complete_drill

  local summary
  summary="$(jq -cn \
    --arg eventId "$(state_string recoveryEventId)" \
    --arg sequenceNumber "$(state_string failureSequenceNumber)" \
    --argjson sqsCalls "$(call_count sqs)" \
    --argjson snsCalls "$(call_count sns)" \
    --argjson dynamodbCalls "$(call_count dynamodb)" \
    --argjson streamsCalls "$(call_count dynamodbstreams)" \
    --argjson logsCalls "$(call_count logs)" '
      {
        eventId: $eventId,
        sequenceNumber: $sequenceNumber,
        sqsCalls: $sqsCalls,
        snsCalls: $snsCalls,
        dynamodbCalls: $dynamodbCalls,
        streamsCalls: $streamsCalls,
        logsCalls: $logsCalls
      }
    ')"
  rm -f "$state_file"
  trap - EXIT INT TERM
  echo "Stream-publisher failure drill passed: $summary"
}

cleanup_drill() {
  : >"$call_log"
  assert_identity
  validate_recovery_state
  assert_stack_status
  resolve_resources
  assert_mapping_contract
  assert_table_contract
  assert_recovery_resources_match

  reconcile_poison_write
  if [[ "$(state_boolean poisonWritten)" == 'true' ]]; then
    complete_drill
  else
    cleanup_temporary_resources
    assert_item_deleted
    assert_deployed_queues_empty
    assert_no_temporary_resources
    assert_no_drill_items
    assert_stack_in_sync
  fi

  rm -f "$state_file"
  echo 'Stream-publisher failure drill cleanup completed.'
}

main() {
  require_command "$aws_cli"
  require_command jq
  mkdir -p "$state_directory"

  drill_mode="${1:-}"
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
