#!/usr/bin/env bash

set -euo pipefail

: "${FAKE_AWS_STATE_DIRECTORY:?FAKE_AWS_STATE_DIRECTORY is required}"

readonly account_id='454921778743'
readonly region='eu-central-1'
readonly stack_name='serverless-order-integration-dev'
readonly topic_arn="arn:aws:sns:$region:$account_id:$stack_name-domain-events"
readonly delivery_queue_url="https://sqs.$region.amazonaws.com/$account_id/$stack_name-delivery"
readonly worker_dlq_url="https://sqs.$region.amazonaws.com/$account_id/$stack_name-delivery-dlq"
readonly publisher_failure_queue_url="https://sqs.$region.amazonaws.com/$account_id/$stack_name-publisher-failure"
readonly subscription_dlq_url="https://sqs.$region.amazonaws.com/$account_id/$stack_name-subscription-dlq"
readonly delivery_queue_arn="arn:aws:sqs:$region:$account_id:$stack_name-delivery"
readonly subscription_dlq_arn="arn:aws:sqs:$region:$account_id:$stack_name-subscription-dlq"
readonly main_subscription_arn="$topic_arn:11111111-1111-1111-1111-111111111111"
readonly temporary_subscription_arn="$topic_arn:22222222-2222-2222-2222-222222222222"

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

queue_attributes() {
  local queue_url="$1"
  local queue_arn
  local policy=''
  local retention='1209600'
  local visible_messages='0'

  case "$queue_url" in
    "$delivery_queue_url")
      queue_arn="$delivery_queue_arn"
      ;;
    "$worker_dlq_url")
      queue_arn="arn:aws:sqs:$region:$account_id:$stack_name-delivery-dlq"
      ;;
    "$publisher_failure_queue_url")
      queue_arn="arn:aws:sqs:$region:$account_id:$stack_name-publisher-failure"
      ;;
    "$subscription_dlq_url")
      queue_arn="$subscription_dlq_arn"
      policy="$(jq -cn \
        --arg accountId "$account_id" \
        --arg queueArn "$subscription_dlq_arn" \
        --arg topicArn "$topic_arn" '
          {
            Version: "2012-10-17",
            Statement: [{
              Sid: "AllowDomainEventsTopicFailureDelivery",
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
      if [[ -f "$FAKE_AWS_STATE_DIRECTORY/marker-deleted" ]]; then
        stale_check=1
        if [[ -f "$FAKE_AWS_STATE_DIRECTORY/stale-empty-check" ]]; then
          stale_check="$(( $(<"$FAKE_AWS_STATE_DIRECTORY/stale-empty-check") + 1 ))"
        fi
        printf '%s\n' "$stale_check" >"$FAKE_AWS_STATE_DIRECTORY/stale-empty-check"
        if ((stale_check <= ${FAKE_AWS_STALE_EMPTY_CHECKS_AFTER_DELETE:-0})); then
          visible_messages='1'
        fi
      fi
      ;;
    *)
      [[ -f "$FAKE_AWS_STATE_DIRECTORY/temporary-queue-url" ]] || exit 91
      [[ "$queue_url" == "$(<"$FAKE_AWS_STATE_DIRECTORY/temporary-queue-url")" ]] || exit 92
      queue_arn="$(<"$FAKE_AWS_STATE_DIRECTORY/temporary-queue-arn")"
      retention='300'
      ;;
  esac

  jq -cn \
    --arg queueArn "$queue_arn" \
    --arg policy "$policy" \
    --arg retention "$retention" \
    --arg visibleMessages "$visible_messages" '
      {
        Attributes: {
          QueueArn: $queueArn,
          ApproximateNumberOfMessages: $visibleMessages,
          ApproximateNumberOfMessagesNotVisible: "0",
          ApproximateNumberOfMessagesDelayed: "0",
          MessageRetentionPeriod: $retention,
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
      *StackStatus*)
        printf 'UPDATE_COMPLETE\n'
        ;;
      *DomainEventsTopicArn*)
        printf '%s\n' "$topic_arn"
        ;;
      *DeliveryQueueUrl*)
        printf '%s\n' "$delivery_queue_url"
        ;;
      *DeliveryDeadLetterQueueUrl*)
        printf '%s\n' "$worker_dlq_url"
        ;;
      *StreamPublisherFailureQueueUrl*)
        printf '%s\n' "$publisher_failure_queue_url"
        ;;
      *DeliverySubscriptionDeadLetterQueueUrl*)
        printf '%s\n' "$subscription_dlq_url"
        ;;
      *)
        exit 93
        ;;
    esac
    ;;

  cloudformation:detect-stack-drift)
    printf 'fake-drift-detection-id\n'
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

  sqs:get-queue-attributes)
    queue_attributes "$(option_value --queue-url "$@")"
    ;;

  sqs:list-queues)
    if [[ -f "$FAKE_AWS_STATE_DIRECTORY/temporary-queue-url" ]]; then
      jq -cn --arg url "$(<"$FAKE_AWS_STATE_DIRECTORY/temporary-queue-url")" \
        '{QueueUrls: [$url]}'
    fi
    ;;

  sqs:create-queue)
    queue_name="$(option_value --queue-name "$@")"
    temporary_queue_url="https://sqs.$region.amazonaws.com/$account_id/$queue_name"
    temporary_queue_arn="arn:aws:sqs:$region:$account_id:$queue_name"
    printf '%s\n' "$temporary_queue_url" >"$FAKE_AWS_STATE_DIRECTORY/temporary-queue-url"
    printf '%s\n' "$temporary_queue_arn" >"$FAKE_AWS_STATE_DIRECTORY/temporary-queue-arn"
    printf '%s\n' "$temporary_queue_url"
    ;;

  sqs:list-queue-tags)
    printf '%s\n' \
      '{"Tags":{"Project":"serverless-order-integration","Environment":"dev","Purpose":"sns-dlq-drill"}}'
    ;;

  sqs:receive-message)
    receive_attempt=1
    if [[ -f "$FAKE_AWS_STATE_DIRECTORY/receive-attempt" ]]; then
      receive_attempt="$(( $(<"$FAKE_AWS_STATE_DIRECTORY/receive-attempt") + 1 ))"
    fi
    printf '%s\n' "$receive_attempt" >"$FAKE_AWS_STATE_DIRECTORY/receive-attempt"
    if ((receive_attempt <= ${FAKE_AWS_EMPTY_RECEIVES_BEFORE_MESSAGE:-0})); then
      exit 0
    elif [[ -f "$FAKE_AWS_STATE_DIRECTORY/published-body" &&
      ! -f "$FAKE_AWS_STATE_DIRECTORY/marker-received" ]]; then
      jq -cn --arg body "$(<"$FAKE_AWS_STATE_DIRECTORY/published-body")" \
        '{Messages: [{MessageId: "fake-sqs-message-id", ReceiptHandle: "fake-receipt", Body: $body}]}'
      touch "$FAKE_AWS_STATE_DIRECTORY/marker-received"
    fi
    ;;

  sqs:delete-message)
    touch "$FAKE_AWS_STATE_DIRECTORY/marker-deleted"
    ;;

  sqs:delete-queue)
    rm -f \
      "$FAKE_AWS_STATE_DIRECTORY/temporary-queue-url" \
      "$FAKE_AWS_STATE_DIRECTORY/temporary-queue-arn"
    ;;

  sns:list-subscriptions-by-topic)
    if [[ -f "$FAKE_AWS_STATE_DIRECTORY/temporary-subscription" ]]; then
      jq -cn \
        --arg mainArn "$main_subscription_arn" \
        --arg deliveryArn "$delivery_queue_arn" \
        --arg temporaryArn "$temporary_subscription_arn" \
        --arg temporaryEndpoint "$(<"$FAKE_AWS_STATE_DIRECTORY/temporary-subscription-endpoint")" '
          {
            Subscriptions: [
              {
                SubscriptionArn: $mainArn,
                Protocol: "sqs",
                Endpoint: $deliveryArn
              },
              {
                SubscriptionArn: $temporaryArn,
                Protocol: "sqs",
                Endpoint: $temporaryEndpoint
              }
            ]
          }
        '
    else
      jq -cn \
        --arg subscriptionArn "$main_subscription_arn" \
        --arg endpoint "$delivery_queue_arn" '
          {
            Subscriptions: [{
              SubscriptionArn: $subscriptionArn,
              Protocol: "sqs",
              Endpoint: $endpoint
            }]
          }
        '
    fi
    ;;

  sns:get-subscription-attributes)
    subscription_arn="$(option_value --subscription-arn "$@")"
    if [[ "$subscription_arn" == "$main_subscription_arn" ]]; then
      jq -cn --arg dlqArn "$subscription_dlq_arn" '
        {
          Attributes: {
            PendingConfirmation: "false",
            RawMessageDelivery: "true",
            FilterPolicyScope: "MessageAttributes",
            FilterPolicy: "{\"eventType\":[\"order.ready_for_submission\",\"order.submission_retry_requested\"]}",
            RedrivePolicy: ({deadLetterTargetArn: $dlqArn} | tojson)
          }
        }
      '
    elif [[ "$subscription_arn" == "$temporary_subscription_arn" ]]; then
      jq -cn --arg dlqArn "$subscription_dlq_arn" '
        {
          Attributes: {
            PendingConfirmation: "false",
            RawMessageDelivery: "true",
            FilterPolicyScope: "MessageAttributes",
            FilterPolicy: "{\"eventType\":[\"sns.subscription_dlq_drill\"]}",
            RedrivePolicy: ({deadLetterTargetArn: $dlqArn} | tojson)
          }
        }
      '
    else
      exit 95
    fi
    ;;

  sns:subscribe)
    option_value --notification-endpoint "$@" \
      >"$FAKE_AWS_STATE_DIRECTORY/temporary-subscription-endpoint"
    touch "$FAKE_AWS_STATE_DIRECTORY/temporary-subscription"
    printf '%s\n' "$temporary_subscription_arn"
    ;;

  sns:publish)
    option_value --message "$@" >"$FAKE_AWS_STATE_DIRECTORY/published-body"
    printf 'fake-sns-message-id\n'
    ;;

  sns:unsubscribe)
    rm -f \
      "$FAKE_AWS_STATE_DIRECTORY/temporary-subscription" \
      "$FAKE_AWS_STATE_DIRECTORY/temporary-subscription-endpoint"
    ;;

  *)
    printf 'Unexpected fake AWS call: %s %s\n' "$service" "$operation" >&2
    exit 96
    ;;
esac
