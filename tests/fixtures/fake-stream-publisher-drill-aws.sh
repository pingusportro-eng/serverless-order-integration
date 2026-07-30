#!/usr/bin/env bash

set -euo pipefail

: "${FAKE_AWS_STATE_DIRECTORY:?FAKE_AWS_STATE_DIRECTORY is required}"

readonly account_id='454921778743'
readonly region='eu-central-1'
readonly stack_name='serverless-order-integration-dev'
readonly table_name="$stack_name-orders"
readonly stream_arn="arn:aws:dynamodb:$region:$account_id:table/$table_name/stream/2026-07-25T04:15:27.732"
readonly topic_arn="arn:aws:sns:$region:$account_id:$stack_name-domain-events"
readonly publisher_name="$stack_name-stream-publisher"
readonly publisher_arn="arn:aws:lambda:$region:$account_id:function:$publisher_name"
readonly publisher_log_group="/aws/serverless-order-integration/$stack_name/stream-publisher"
readonly mapping_uuid='fake-stream-mapping-uuid'
readonly delivery_queue_url="https://sqs.$region.amazonaws.com/$account_id/$stack_name-delivery"
readonly worker_dlq_url="https://sqs.$region.amazonaws.com/$account_id/$stack_name-delivery-dlq"
readonly publisher_failure_queue_url="https://sqs.$region.amazonaws.com/$account_id/$stack_name-publisher-failure"
readonly subscription_dlq_url="https://sqs.$region.amazonaws.com/$account_id/$stack_name-subscription-dlq"
readonly publisher_failure_queue_arn="arn:aws:sqs:$region:$account_id:$stack_name-publisher-failure"
readonly main_subscription_arn="$topic_arn:11111111-1111-1111-1111-111111111111"
readonly temporary_subscription_arn="$topic_arn:22222222-2222-2222-2222-222222222222"
readonly sequence_number='700000000000000000001'
readonly shard_id='shardId-00000000000000000001-fake'

mkdir -p "$FAKE_AWS_STATE_DIRECTORY"
printf '%q ' "$@" >>"$FAKE_AWS_STATE_DIRECTORY/commands.log"
printf '\n' >>"$FAKE_AWS_STATE_DIRECTORY/commands.log"

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
  if [[ -f "$FAKE_AWS_STATE_DIRECTORY/$name" ]]; then
    value="$(( $(<"$FAKE_AWS_STATE_DIRECTORY/$name") + 1 ))"
  fi
  printf '%s\n' "$value" >"$FAKE_AWS_STATE_DIRECTORY/$name"
  printf '%s\n' "$value"
}

temporary_queue_url() {
  [[ -f "$FAKE_AWS_STATE_DIRECTORY/temporary-queue-url" ]] || return 1
  sed -n '1p' "$FAKE_AWS_STATE_DIRECTORY/temporary-queue-url"
}

temporary_queue_arn() {
  [[ -f "$FAKE_AWS_STATE_DIRECTORY/temporary-queue-arn" ]] || return 1
  sed -n '1p' "$FAKE_AWS_STATE_DIRECTORY/temporary-queue-arn"
}

queue_attributes() {
  local queue_url="$1"
  local queue_arn
  local policy=''
  local visible='0'

  case "$queue_url" in
    "$delivery_queue_url")
      queue_arn="arn:aws:sqs:$region:$account_id:$stack_name-delivery"
      ;;
    "$worker_dlq_url")
      queue_arn="arn:aws:sqs:$region:$account_id:$stack_name-delivery-dlq"
      ;;
    "$publisher_failure_queue_url")
      queue_arn="$publisher_failure_queue_arn"
      if [[ -f "$FAKE_AWS_STATE_DIRECTORY/failure-ready" &&
        ! -f "$FAKE_AWS_STATE_DIRECTORY/failure-deleted" ]]; then
        visible='1'
      fi
      ;;
    "$subscription_dlq_url")
      queue_arn="arn:aws:sqs:$region:$account_id:$stack_name-subscription-dlq"
      ;;
    *)
      [[ "$queue_url" == "$(temporary_queue_url)" ]] || exit 91
      queue_arn="$(temporary_queue_arn)"
      if [[ -f "$FAKE_AWS_STATE_DIRECTORY/temporary-queue-policy" ]]; then
        policy="$(<"$FAKE_AWS_STATE_DIRECTORY/temporary-queue-policy")"
      fi
      ;;
  esac

  jq -cn \
    --arg arn "$queue_arn" \
    --arg policy "$policy" \
    --arg visible "$visible" '
      {
        Attributes: {
          QueueArn: $arn,
          ApproximateNumberOfMessages: $visible,
          ApproximateNumberOfMessagesNotVisible: "0",
          ApproximateNumberOfMessagesDelayed: "0",
          MessageRetentionPeriod: "300",
          SqsManagedSseEnabled: "true",
          Policy: $policy
        }
      }
      | if $policy == "" then del(.Attributes.Policy) else . end
    '
}

service="${1:?AWS service is required}"
operation="${2:?AWS operation is required}"
shift 2

case "$service:$operation" in
  sts:get-caller-identity)
    printf '%s\n' "$account_id"
    ;;

  cloudformation:describe-stacks)
    query="$(option_value --query "$@")"
    case "$query" in
      *StackStatus*) printf 'UPDATE_COMPLETE\n' ;;
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
      StreamPublisherFunction) printf '%s\n' "$publisher_name" ;;
      StreamPublisherLogGroup) printf '%s\n' "$publisher_log_group" ;;
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

  lambda:get-function-configuration)
    printf '%s\n' "$publisher_arn"
    ;;

  lambda:list-event-source-mappings)
    jq -cn \
      --arg destination "$publisher_failure_queue_arn" \
      --arg streamArn "$stream_arn" \
      --arg uuid "$mapping_uuid" '
        {
          EventSourceMappings: [{
            UUID: $uuid,
            State: "Enabled",
            LastProcessingResult: "OK",
            EventSourceArn: $streamArn,
            BatchSize: 10,
            BisectBatchOnFunctionError: true,
            MaximumRecordAgeInSeconds: 3600,
            MaximumRetryAttempts: 2,
            ParallelizationFactor: 1,
            FunctionResponseTypes: ["ReportBatchItemFailures"],
            DestinationConfig: {OnFailure: {Destination: $destination}},
            FilterCriteria: {
              Filters: [{
                Pattern: "{\"eventName\":[\"INSERT\",\"MODIFY\"],\"dynamodb\":{\"NewImage\":{\"entityType\":{\"S\":[\"ORDER\"]}}}}"
              }]
            }
          }]
        }
      '
    ;;

  lambda:get-event-source-mapping)
    jq -cn --arg uuid "$mapping_uuid" \
      '{UUID: $uuid, State: "Enabled", LastProcessingResult: "OK"}'
    ;;

  dynamodb:describe-table)
    jq -cn '
      {
        Table: {
          TableStatus: "ACTIVE",
          BillingModeSummary: {BillingMode: "PAY_PER_REQUEST"},
          StreamSpecification: {
            StreamEnabled: true,
            StreamViewType: "NEW_IMAGE"
          },
          KeySchema: [
            {AttributeName: "pk", KeyType: "HASH"},
            {AttributeName: "sk", KeyType: "RANGE"}
          ]
        }
      }
    '
    ;;

  dynamodb:scan)
    if [[ -f "$FAKE_AWS_STATE_DIRECTORY/item.json" ]]; then
      jq -cn --slurpfile item "$FAKE_AWS_STATE_DIRECTORY/item.json" \
        '{Count: 1, ScannedCount: 1, Items: $item}'
    else
      printf '{"Count":0,"ScannedCount":0,"Items":[]}\n'
    fi
    ;;

  dynamodb:get-item)
    if [[ -f "$FAKE_AWS_STATE_DIRECTORY/item.json" ]]; then
      jq -cn --slurpfile item "$FAKE_AWS_STATE_DIRECTORY/item.json" \
        '{Item: $item[0]}'
    fi
    ;;

  dynamodb:put-item)
    item="$(option_value --item "$@")"
    printf '%s\n' "$item" >"$FAKE_AWS_STATE_DIRECTORY/item.json"
    schema_version="$(jq -r '.schemaVersion.N' <<<"$item")"
    if [[ "$schema_version" == '999' ]]; then
      printf '%s\n' "$item" >"$FAKE_AWS_STATE_DIRECTORY/poison-item.json"
      touch "$FAKE_AWS_STATE_DIRECTORY/poison-written"
    elif [[ "$schema_version" == '2' ]]; then
      touch "$FAKE_AWS_STATE_DIRECTORY/repair-written"
      jq -cn \
        --arg aggregateId "$(jq -r '.order.M.orderId.S' <<<"$item")" \
        --arg correlationId "$(jq -r '.mutation.M.correlationId.S' <<<"$item")" \
        --arg causationId "$(jq -r '.mutation.M.causationId.S' <<<"$item")" '
          {
            eventId: "evt_fake_recovery",
            eventType: "order.cancelled",
            schemaVersion: 2,
            aggregateType: "ORDER",
            aggregateId: $aggregateId,
            aggregateVersion: 2,
            occurredAt: "2026-07-27T00:00:00.000Z",
            correlationId: $correlationId,
            causationId: $causationId,
            payload: {
              merchantId: "mrc_demo",
              previousStatus: "PENDING_SUBMISSION",
              status: "CANCELLED",
              reason: "Publisher failure drill recovery."
            }
          }
        ' >"$FAKE_AWS_STATE_DIRECTORY/recovery-event.json"
    else
      exit 95
    fi
    printf '{"ConsumedCapacity":{"CapacityUnits":1}}\n'
    ;;

  dynamodb:delete-item)
    [[ -f "$FAKE_AWS_STATE_DIRECTORY/item.json" ]] || exit 96
    jq -cn --slurpfile item "$FAKE_AWS_STATE_DIRECTORY/item.json" \
      '{Attributes: $item[0]}'
    rm -f "$FAKE_AWS_STATE_DIRECTORY/item.json"
    touch "$FAKE_AWS_STATE_DIRECTORY/item-deleted"
    ;;

  sqs:get-queue-attributes)
    queue_attributes "$(option_value --queue-url "$@")"
    ;;

  sqs:list-queues)
    if [[ -f "$FAKE_AWS_STATE_DIRECTORY/temporary-queue-url" ]]; then
      jq -cn --arg url "$(temporary_queue_url)" '{QueueUrls: [$url]}'
    fi
    ;;

  sqs:create-queue)
    queue_name="$(option_value --queue-name "$@")"
    queue_url="https://sqs.$region.amazonaws.com/$account_id/$queue_name"
    queue_arn="arn:aws:sqs:$region:$account_id:$queue_name"
    printf '%s\n' "$queue_url" >"$FAKE_AWS_STATE_DIRECTORY/temporary-queue-url"
    printf '%s\n' "$queue_arn" >"$FAKE_AWS_STATE_DIRECTORY/temporary-queue-arn"
    printf '%s\n' "$queue_url"
    ;;

  sqs:set-queue-attributes)
    attributes="$(option_value --attributes "$@")"
    jq -er '.Policy' <<<"$attributes" >"$FAKE_AWS_STATE_DIRECTORY/temporary-queue-policy"
    ;;

  sqs:list-queue-tags)
    printf '%s\n' \
      '{"Tags":{"Project":"serverless-order-integration","Environment":"dev","Purpose":"publisher-failure-drill"}}'
    ;;

  sqs:receive-message)
    queue_url="$(option_value --queue-url "$@")"
    if [[ "$queue_url" == "$publisher_failure_queue_url" ]]; then
      if [[ "${FAKE_STREAM_DRILL_INTERRUPT_AFTER_POISON:-}" == '1' &&
        ! -f "$FAKE_AWS_STATE_DIRECTORY/interruption-injected" ]]; then
        touch "$FAKE_AWS_STATE_DIRECTORY/interruption-injected"
        exit 97
      fi
      attempt="$(increment_counter failure-receive-attempt)"
      if ((attempt <= ${FAKE_STREAM_DRILL_EMPTY_FAILURE_RECEIVES:-0})); then
        exit 0
      fi
      touch "$FAKE_AWS_STATE_DIRECTORY/failure-ready"
      failure_body="$(jq -cn \
        --arg functionArn "$publisher_arn" \
        --arg shardId "$shard_id" \
        --arg sequence "$sequence_number" \
        --arg streamArn "$stream_arn" '
          {
            requestContext: {
              requestId: "fake-request-id",
              functionArn: $functionArn,
              condition: "RetryAttemptsExhausted",
              approximateInvokeCount: 3
            },
            responseContext: {
              statusCode: 200,
              executedVersion: "$LATEST"
            },
            version: "1.0",
            timestamp: "2026-07-27T00:00:00.000Z",
            DDBStreamBatchInfo: {
              shardId: $shardId,
              startSequenceNumber: $sequence,
              endSequenceNumber: $sequence,
              approximateArrivalOfFirstRecord: "2026-07-27T00:00:00Z",
              approximateArrivalOfLastRecord: "2026-07-27T00:00:00Z",
              batchSize: 1,
              streamArn: $streamArn
            }
          }
        ')"
      jq -cn --arg body "$failure_body" '
        {
          Messages: [{
            MessageId: "fake-failure-message",
            ReceiptHandle: "fake-failure-receipt",
            Body: $body
          }]
        }
      '
    elif [[ "$queue_url" == "$(temporary_queue_url)" ]]; then
      attempt="$(increment_counter recovery-receive-attempt)"
      if ((attempt <= ${FAKE_STREAM_DRILL_EMPTY_RECOVERY_RECEIVES:-0})) ||
        [[ ! -f "$FAKE_AWS_STATE_DIRECTORY/recovery-event.json" ]]; then
        exit 0
      fi
      jq -cn \
        --arg body "$(<"$FAKE_AWS_STATE_DIRECTORY/recovery-event.json")" '
          {
            Messages: [{
              MessageId: "fake-recovery-message",
              ReceiptHandle: "fake-recovery-receipt",
              Body: $body
            }]
          }
        '
    else
      exit 98
    fi
    ;;

  sqs:delete-message)
    queue_url="$(option_value --queue-url "$@")"
    if [[ "$queue_url" == "$publisher_failure_queue_url" ]]; then
      touch "$FAKE_AWS_STATE_DIRECTORY/failure-deleted"
    else
      touch "$FAKE_AWS_STATE_DIRECTORY/recovery-deleted"
    fi
    ;;

  sqs:delete-queue)
    rm -f \
      "$FAKE_AWS_STATE_DIRECTORY/temporary-queue-url" \
      "$FAKE_AWS_STATE_DIRECTORY/temporary-queue-arn" \
      "$FAKE_AWS_STATE_DIRECTORY/temporary-queue-policy"
    ;;

  sns:list-subscriptions-by-topic)
    if [[ -f "$FAKE_AWS_STATE_DIRECTORY/temporary-subscription" ]]; then
      jq -cn \
        --arg mainArn "$main_subscription_arn" \
        --arg temporaryArn "$temporary_subscription_arn" \
        --arg endpoint "$(temporary_queue_arn)" '
          {
            Subscriptions: [
              {
                SubscriptionArn: $mainArn,
                Protocol: "sqs",
                Endpoint: "arn:aws:sqs:eu-central-1:454921778743:delivery"
              },
              {
                SubscriptionArn: $temporaryArn,
                Protocol: "sqs",
                Endpoint: $endpoint
              }
            ]
          }
        '
    else
      jq -cn --arg arn "$main_subscription_arn" '
        {
          Subscriptions: [{
            SubscriptionArn: $arn,
            Protocol: "sqs",
            Endpoint: "arn:aws:sqs:eu-central-1:454921778743:delivery"
          }]
        }
      '
    fi
    ;;

  sns:subscribe)
    touch "$FAKE_AWS_STATE_DIRECTORY/temporary-subscription"
    printf '%s\n' "$temporary_subscription_arn"
    ;;

  sns:get-subscription-attributes)
    aggregate_id="$(jq -r '.order.M.orderId.S' "$FAKE_AWS_STATE_DIRECTORY/item.json" 2>/dev/null || true)"
    if [[ -z "$aggregate_id" ]]; then
      endpoint="$(temporary_queue_arn)"
      aggregate_id="${endpoint##*:}"
      aggregate_id="${aggregate_id#*publisher-failure-drill-}"
      aggregate_id="ord_publisher_failure_drill_$aggregate_id"
    fi
    jq -cn --arg aggregateId "$aggregate_id" '
      {
        Attributes: {
          PendingConfirmation: "false",
          RawMessageDelivery: "true",
          FilterPolicyScope: "MessageAttributes",
          FilterPolicy: ({
            eventType: ["order.cancelled"],
            aggregateId: [$aggregateId]
          } | tojson)
        }
      }
    '
    ;;

  sns:unsubscribe)
    rm -f "$FAKE_AWS_STATE_DIRECTORY/temporary-subscription"
    ;;

  dynamodbstreams:get-shard-iterator)
    printf 'fake-shard-iterator\n'
    ;;

  dynamodbstreams:get-records)
    [[ -f "$FAKE_AWS_STATE_DIRECTORY/poison-item.json" ]] || exit 99
    item="$(<"$FAKE_AWS_STATE_DIRECTORY/poison-item.json")"
    jq -cn \
      --arg sequence "$sequence_number" \
      --argjson item "$item" '
        {
          Records: [{
            eventID: "fake-stream-event",
            eventName: "INSERT",
            dynamodb: {
              Keys: {
                pk: $item.pk,
                sk: $item.sk
              },
              NewImage: $item,
              SequenceNumber: $sequence
            }
          }],
          NextShardIterator: "fake-next-iterator"
        }
      '
    ;;

  logs:filter-log-events)
    attempt="$(increment_counter log-filter-attempt)"
    if ((attempt <= ${FAKE_STREAM_DRILL_EMPTY_LOG_POLLS:-0})); then
      printf '{"events":[]}\n'
      exit 0
    fi
    jq -cn --arg sequence "$sequence_number" '
      {
        events: [
          1, 2, 3
        ] | map({
          timestamp: 1785110400000,
          message: (
            "2026-07-27T00:00:00.000Z\tfake-lambda-request\tINFO\t" +
            ({
              timestamp: "2026-07-27T00:00:00.000Z",
              level: "error",
              event: "stream.record.failed",
              requestId: $sequence,
              operation: "parseOrderStreamRecord",
              exceptionName: "Error"
            } | tojson) +
            "\n"
          )
        })
      }
    '
    ;;

  *)
    printf 'Unexpected fake AWS call: %s %s\n' "$service" "$operation" >&2
    exit 100
    ;;
esac
