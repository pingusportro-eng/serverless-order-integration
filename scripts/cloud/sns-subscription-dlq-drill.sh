#!/usr/bin/env bash

set -euo pipefail

readonly expected_account_id='454921778743'
readonly expected_region='eu-central-1'
readonly expected_profile='pingusportro-admin'
readonly stack_name='serverless-order-integration-dev'
readonly drill_queue_prefix='serverless-order-integration-dev-sns-dlq-drill-'
readonly drill_event_type='sns.subscription_dlq_drill'
readonly sqs_call_cap=30
readonly sns_call_cap=10

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
default_state_directory="$project_root/.aws-sam/cloud-drill"

if [[ -n "${SNS_DLQ_DRILL_AWS_CLI:-}" || -n "${SNS_DLQ_DRILL_STATE_DIRECTORY:-}" || -n "${SNS_DLQ_DRILL_POLL_SECONDS:-}" ]]; then
  if [[ "${SNS_DLQ_DRILL_TEST_MODE:-}" != '1' ]]; then
    echo 'Drill test overrides require SNS_DLQ_DRILL_TEST_MODE=1.' >&2
    exit 2
  fi
fi

readonly aws_cli="${SNS_DLQ_DRILL_AWS_CLI:-aws}"
readonly state_directory="${SNS_DLQ_DRILL_STATE_DIRECTORY:-$default_state_directory}"
readonly poll_seconds="${SNS_DLQ_DRILL_POLL_SECONDS:-5}"
readonly state_file="$state_directory/state.json"
readonly call_log="$state_directory/aws-calls.log"

usage() {
  cat <<'EOF'
Usage:
  scripts/cloud/sns-subscription-dlq-drill.sh run
  scripts/cloud/sns-subscription-dlq-drill.sh cleanup

The run mode creates one temporary queue and subscription, publishes one
drill-only SNS message, proves delivery to the deployed subscription DLQ, and
cleans up. The cleanup mode recovers an interrupted run from ignored state
under .aws-sam/cloud-drill/.
EOF
}

fail() {
  echo "SNS subscription-DLQ drill: $*" >&2
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
  awk -v service="$service" '$0 == service { count += 1 } END { print count + 0 }' "$call_log"
}

aws_call() {
  local service="$1"
  shift
  local cap=0
  case "$service" in
    sqs) cap=$sqs_call_cap ;;
    sns) cap=$sns_call_cap ;;
  esac

  if ((cap > 0)) && [[ "${drill_mode:-}" == 'run' ]]; then
    local current_count
    current_count="$(call_count "$service")"
    ((current_count < cap)) || fail "$service API-call cap of $cap would be exceeded"
  fi

  printf '%s\n' "$service" >>"$call_log"
  "$aws_cli" "$@" \
    --profile "$expected_profile" \
    --region "$expected_region" \
    --no-cli-pager
}

state_create() {
  local marker="$1"
  local message_body="$2"
  local topic_arn="$3"
  local delivery_queue_url="$4"
  local subscription_dlq_url="$5"
  local subscription_dlq_arn="$6"

  jq -n \
    --arg accountId "$expected_account_id" \
    --arg region "$expected_region" \
    --arg stackName "$stack_name" \
    --arg topicArn "$topic_arn" \
    --arg deliveryQueueUrl "$delivery_queue_url" \
    --arg subscriptionDlqUrl "$subscription_dlq_url" \
    --arg subscriptionDlqArn "$subscription_dlq_arn" \
    --arg marker "$marker" \
    --arg messageBody "$message_body" \
    '{
      accountId: $accountId,
      region: $region,
      stackName: $stackName,
      topicArn: $topicArn,
      deliveryQueueUrl: $deliveryQueueUrl,
      subscriptionDlqUrl: $subscriptionDlqUrl,
      subscriptionDlqArn: $subscriptionDlqArn,
      marker: $marker,
      messageBody: $messageBody,
      temporaryQueueUrl: "",
      temporaryQueueArn: "",
      temporarySubscriptionArn: "",
      messageId: "",
      publishAttempted: false,
      receiptHandle: "",
      markerDeleted: false
    }' >"$state_file"
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
  jq -er --arg field "$field" '.[$field] | select(type == "string")' "$state_file"
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

assert_stack_status() {
  local stack_status
  stack_status="$(aws_call cloudformation cloudformation describe-stacks \
    --stack-name "$stack_name" \
    --query 'Stacks[0].StackStatus' \
    --output text)"
  [[ "$stack_status" == 'UPDATE_COMPLETE' ]] ||
    fail "stack must be UPDATE_COMPLETE, received $stack_status"
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
  local queue_url="$1"
  aws_call sqs sqs get-queue-attributes \
    --queue-url "$queue_url" \
    --attribute-names All \
    --output json
}

queue_arn() {
  local queue_url="$1"
  queue_attributes "$queue_url" | jq -er '.Attributes.QueueArn'
}

assert_queue_empty() {
  local queue_url="$1"
  local attributes

  for attempt in {1..3}; do
    attributes="$(queue_attributes "$queue_url")"
    if jq -e '
      .Attributes.ApproximateNumberOfMessages == "0" and
      .Attributes.ApproximateNumberOfMessagesNotVisible == "0" and
      .Attributes.ApproximateNumberOfMessagesDelayed == "0"
    ' <<<"$attributes" >/dev/null; then
      return
    fi
    ((attempt == 3)) || sleep "$poll_seconds"
  done

  fail "queue did not report empty after bounded consistency checks: $queue_url"
}

assert_deployed_queues_empty() {
  local delivery_queue_url="$1"
  local worker_dlq_url="$2"
  local publisher_failure_queue_url="$3"
  local subscription_dlq_url="$4"

  assert_queue_empty "$delivery_queue_url"
  assert_queue_empty "$worker_dlq_url"
  assert_queue_empty "$publisher_failure_queue_url"
  assert_queue_empty "$subscription_dlq_url"
}

assert_no_previous_drill_resources() {
  local topic_arn="$1"
  local queue_urls
  local subscriptions

  queue_urls="$(aws_call sqs sqs list-queues \
    --queue-name-prefix "$drill_queue_prefix" \
    --output json)"
  [[ -n "$queue_urls" ]] || queue_urls='{}'
  [[ "$(jq '(.QueueUrls // []) | length' <<<"$queue_urls")" == '0' ]] ||
    fail 'a previous drill queue still exists; run cleanup before another drill'

  subscriptions="$(aws_call sns sns list-subscriptions-by-topic \
    --topic-arn "$topic_arn" \
    --output json)"
  jq -e --arg prefix "$drill_queue_prefix" '
    [.Subscriptions[]? | select((.Endpoint // "") | contains($prefix))] | length == 0
  ' <<<"$subscriptions" >/dev/null ||
    fail 'a previous drill subscription still exists; run cleanup before another drill'
}

resolve_and_verify_stack_resources() {
  topic_arn="$(stack_output DomainEventsTopicArn)"
  delivery_queue_url="$(stack_output DeliveryQueueUrl)"
  worker_dlq_url="$(stack_output DeliveryDeadLetterQueueUrl)"
  publisher_failure_queue_url="$(stack_output StreamPublisherFailureQueueUrl)"
  subscription_dlq_url="$(stack_output DeliverySubscriptionDeadLetterQueueUrl)"

  [[ "$topic_arn" == "arn:aws:sns:$expected_region:$expected_account_id:"* ]] ||
    fail "unexpected topic ARN: $topic_arn"

  delivery_queue_arn="$(queue_arn "$delivery_queue_url")"
  subscription_dlq_attributes="$(queue_attributes "$subscription_dlq_url")"
  subscription_dlq_arn="$(jq -er '.Attributes.QueueArn' <<<"$subscription_dlq_attributes")"

  local subscriptions
  subscriptions="$(aws_call sns sns list-subscriptions-by-topic \
    --topic-arn "$topic_arn" \
    --output json)"
  main_subscription_arn="$(jq -er --arg endpoint "$delivery_queue_arn" '
    [.Subscriptions[] | select(.Protocol == "sqs" and .Endpoint == $endpoint)] |
    if length == 1 then .[0].SubscriptionArn else error("expected one main subscription") end
  ' <<<"$subscriptions")"

  local attributes
  attributes="$(aws_call sns sns get-subscription-attributes \
    --subscription-arn "$main_subscription_arn" \
    --output json)"

  jq -e --arg dlqArn "$subscription_dlq_arn" '
    .Attributes.PendingConfirmation == "false" and
    .Attributes.RawMessageDelivery == "true" and
    .Attributes.FilterPolicyScope == "MessageAttributes" and
    (.Attributes.FilterPolicy | fromjson) ==
      {"eventType": ["order.created", "order.submission_retry_requested"]} and
    (.Attributes.RedrivePolicy | fromjson).deadLetterTargetArn == $dlqArn
  ' <<<"$attributes" >/dev/null ||
    fail 'main SNS subscription attributes do not match the deployed contract'
}

assert_subscription_dlq_policy() {
  jq -e \
    --arg accountId "$expected_account_id" \
    --arg queueArn "$subscription_dlq_arn" \
    --arg topicArn "$topic_arn" '
      (.Attributes.Policy | fromjson) as $policy |
      $policy.Version == "2012-10-17" and
      $policy.Statement == [{
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
    ' <<<"$subscription_dlq_attributes" >/dev/null ||
    fail 'subscription DLQ policy does not authorize only the deployed topic contract'
}

validate_recovery_state() {
  [[ -f "$state_file" ]] || fail "recovery state does not exist: $state_file"
  jq -e \
    --arg accountId "$expected_account_id" \
    --arg region "$expected_region" \
    --arg stackName "$stack_name" '
      .topicArn as $topicArn |
      .accountId == $accountId and
      .region == $region and
      .stackName == $stackName and
      (.topicArn | startswith("arn:aws:sns:" + $region + ":" + $accountId + ":")) and
      (.subscriptionDlqArn | startswith("arn:aws:sqs:" + $region + ":" + $accountId + ":")) and
      (
        .temporarySubscriptionArn == "" or
        (.temporarySubscriptionArn | startswith($topicArn + ":"))
      ) and
      (
        .temporaryQueueArn == "" or
        (.temporaryQueueArn | startswith("arn:aws:sqs:" + $region + ":" + $accountId + ":"))
      ) and
      (.publishAttempted | type) == "boolean" and
      (.markerDeleted | type) == "boolean"
    ' "$state_file" >/dev/null ||
    fail 'recovery state identity does not match this project'

  local temporary_queue_url
  local temporary_queue_arn
  temporary_queue_url="$(state_string temporaryQueueUrl)"
  temporary_queue_arn="$(state_string temporaryQueueArn)"
  if [[ -n "$temporary_queue_url" ]]; then
    local temporary_queue_name="${temporary_queue_url##*/}"
    local expected_queue_url_prefix=
    expected_queue_url_prefix="https://sqs.$expected_region.amazonaws.com/$expected_account_id/$drill_queue_prefix"
    [[ "$temporary_queue_url" == "$expected_queue_url_prefix"* ]] ||
      fail 'recovery state queue URL is outside the drill account or prefix'
    [[ "$temporary_queue_arn" == \
      "arn:aws:sqs:$expected_region:$expected_account_id:$temporary_queue_name" ]] ||
      fail 'recovery state queue ARN does not match its queue URL'
  fi
}

cleanup_temporary_resources() {
  [[ -f "$state_file" ]] || return 0

  local temporary_subscription_arn
  local temporary_queue_url
  local cleanup_failed=0
  temporary_subscription_arn="$(state_string temporarySubscriptionArn)"
  temporary_queue_url="$(state_string temporaryQueueUrl)"

  if [[ -n "$temporary_subscription_arn" ]]; then
    if aws_call sns sns unsubscribe \
      --subscription-arn "$temporary_subscription_arn" >/dev/null; then
      state_set_string temporarySubscriptionArn ''
    else
      echo "Could not remove temporary subscription: $temporary_subscription_arn" >&2
      cleanup_failed=1
    fi
  fi

  if [[ -n "$temporary_queue_url" ]]; then
    if aws_call sqs sqs delete-queue \
      --queue-url "$temporary_queue_url" >/dev/null; then
      state_set_string temporaryQueueUrl ''
      state_set_string temporaryQueueArn ''
    else
      echo "Could not remove temporary queue: $temporary_queue_url" >&2
      cleanup_failed=1
    fi
  fi

  ((cleanup_failed == 0))
}

receive_matching_marker() {
  local subscription_dlq_url="$1"
  local expected_body="$2"
  local response
  local message_count
  local received_body
  local receipt_handle

  for _ in {1..9}; do
    response="$(aws_call sqs sqs receive-message \
      --queue-url "$subscription_dlq_url" \
      --max-number-of-messages 10 \
      --wait-time-seconds 10 \
      --visibility-timeout 5 \
      --attribute-names All \
      --message-attribute-names All \
      --output json)"
    [[ -n "$response" ]] || response='{}'
    message_count="$(jq '(.Messages // []) | length' <<<"$response")"
    if [[ "$message_count" == '0' ]]; then
      continue
    fi
    [[ "$message_count" == '1' ]] ||
      fail "expected exactly one DLQ message, received $message_count"

    received_body="$(jq -er '.Messages[0].Body' <<<"$response")"
    [[ "$received_body" == "$expected_body" ]] ||
      fail 'the subscription DLQ contains an unexpected message; it was preserved'

    receipt_handle="$(jq -er '.Messages[0].ReceiptHandle' <<<"$response")"
    state_set_string receiptHandle "$receipt_handle"
    return
  done

  fail 'the expected marker did not reach the subscription DLQ within 90 seconds'
}

delete_matched_marker() {
  local subscription_dlq_url="$1"
  local receipt_handle
  receipt_handle="$(state_string receiptHandle)"
  [[ -n "$receipt_handle" ]] || fail 'matched marker has no receipt handle'

  if ! aws_call sqs sqs delete-message \
    --queue-url "$subscription_dlq_url" \
    --receipt-handle "$receipt_handle" >/dev/null; then
    return 1
  fi
  state_set_string receiptHandle ''
  state_set_boolean markerDeleted true
}

recover_marker_if_needed() {
  local marker_deleted
  local publish_attempted
  marker_deleted="$(state_boolean markerDeleted)"
  [[ "$marker_deleted" == 'false' ]] || return 0
  publish_attempted="$(state_boolean publishAttempted)"
  if [[ "$publish_attempted" == 'false' ]]; then
    state_set_boolean markerDeleted true
    return
  fi

  local subscription_dlq_url
  local expected_body
  local receipt_handle
  subscription_dlq_url="$(state_string subscriptionDlqUrl)"
  expected_body="$(state_string messageBody)"
  receipt_handle="$(state_string receiptHandle)"

  if [[ -n "$receipt_handle" ]]; then
    if delete_matched_marker "$subscription_dlq_url"; then
      return
    fi
    state_set_string receiptHandle ''
  fi

  receive_matching_marker "$subscription_dlq_url" "$expected_body"
  delete_matched_marker "$subscription_dlq_url"
}

assert_no_residual_drill_resources() {
  local topic_arn="$1"
  local queue_urls
  local subscriptions

  queue_urls="$(aws_call sqs sqs list-queues \
    --queue-name-prefix "$drill_queue_prefix" \
    --output json)"
  [[ -n "$queue_urls" ]] || queue_urls='{}'
  [[ "$(jq '(.QueueUrls // []) | length' <<<"$queue_urls")" == '0' ]] ||
    fail 'temporary drill queue remains after cleanup'

  subscriptions="$(aws_call sns sns list-subscriptions-by-topic \
    --topic-arn "$topic_arn" \
    --output json)"
  jq -e --arg prefix "$drill_queue_prefix" '
    [.Subscriptions[]? | select((.Endpoint // "") | contains($prefix))] | length == 0
  ' <<<"$subscriptions" >/dev/null ||
    fail 'temporary drill subscription remains after cleanup'
}

run_trap() {
  local exit_code="$1"
  trap - EXIT INT TERM
  set +e
  cleanup_temporary_resources
  if ((exit_code != 0)) && [[ -f "$state_file" ]]; then
    echo "Drill failed; recovery state retained at $state_file" >&2
    echo 'Run the cleanup mode after investigating any unexpected DLQ message.' >&2
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
  resolve_and_verify_stack_resources
  assert_subscription_dlq_policy
  assert_deployed_queues_empty \
    "$delivery_queue_url" \
    "$worker_dlq_url" \
    "$publisher_failure_queue_url" \
    "$subscription_dlq_url"
  assert_no_previous_drill_resources "$topic_arn"

  local suffix
  local queue_name
  local marker
  local message_body
  suffix="$(date +%s)-$$"
  queue_name="$drill_queue_prefix$suffix"
  marker="sns-dlq-drill-$suffix"
  message_body="$(jq -cn --arg marker "$marker" \
    '{drill: "sns-subscription-dlq", marker: $marker}')"

  state_create \
    "$marker" \
    "$message_body" \
    "$topic_arn" \
    "$delivery_queue_url" \
    "$subscription_dlq_url" \
    "$subscription_dlq_arn"
  trap 'run_trap $?' EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM

  local temporary_queue_url
  temporary_queue_url="$(aws_call sqs sqs create-queue \
    --queue-name "$queue_name" \
    --attributes MessageRetentionPeriod=300,SqsManagedSseEnabled=true \
    --tags \
      Project=serverless-order-integration,Environment=dev,Purpose=sns-dlq-drill \
    --query QueueUrl \
    --output text)"
  [[ "${temporary_queue_url##*/}" == "$queue_name" ]] ||
    fail "created queue URL does not match the requested drill name: $temporary_queue_url"
  state_set_string temporaryQueueUrl "$temporary_queue_url"

  local temporary_queue_attributes
  local temporary_queue_arn
  temporary_queue_attributes="$(queue_attributes "$temporary_queue_url")"
  temporary_queue_arn="$(jq -er '.Attributes.QueueArn' <<<"$temporary_queue_attributes")"
  state_set_string temporaryQueueArn "$temporary_queue_arn"
  jq -e '
    .Attributes.MessageRetentionPeriod == "300" and
    .Attributes.SqsManagedSseEnabled == "true" and
    ((.Attributes.Policy // "") == "")
  ' <<<"$temporary_queue_attributes" >/dev/null ||
    fail 'temporary target queue attributes violate the drill contract'

  local temporary_queue_tags
  temporary_queue_tags="$(aws_call sqs sqs list-queue-tags \
    --queue-url "$temporary_queue_url" \
    --output json)"
  jq -e '
    .Tags == {
      Environment: "dev",
      Project: "serverless-order-integration",
      Purpose: "sns-dlq-drill"
    }
  ' <<<"$temporary_queue_tags" >/dev/null ||
    fail 'temporary target queue tags violate the drill contract'

  local filter_policy
  local redrive_policy
  local subscription_attributes
  local temporary_subscription_arn
  filter_policy="$(jq -cn --arg eventType "$drill_event_type" \
    '{eventType: [$eventType]}')"
  redrive_policy="$(jq -cn --arg dlqArn "$subscription_dlq_arn" \
    '{deadLetterTargetArn: $dlqArn}')"
  subscription_attributes="$(jq -cn \
    --arg filterPolicy "$filter_policy" \
    --arg redrivePolicy "$redrive_policy" \
    '{
      RawMessageDelivery: "true",
      FilterPolicyScope: "MessageAttributes",
      FilterPolicy: $filterPolicy,
      RedrivePolicy: $redrivePolicy
    }')"

  temporary_subscription_arn="$(aws_call sns sns subscribe \
    --topic-arn "$topic_arn" \
    --protocol sqs \
    --notification-endpoint "$temporary_queue_arn" \
    --attributes "$subscription_attributes" \
    --return-subscription-arn \
    --query SubscriptionArn \
    --output text)"
  [[ "$temporary_subscription_arn" == "arn:aws:sns:$expected_region:$expected_account_id:"* ]] ||
    fail "temporary subscription was not confirmed: $temporary_subscription_arn"
  state_set_string temporarySubscriptionArn "$temporary_subscription_arn"

  local deployed_temporary_attributes
  deployed_temporary_attributes="$(aws_call sns sns get-subscription-attributes \
    --subscription-arn "$temporary_subscription_arn" \
    --output json)"
  jq -e \
    --arg filterPolicy "$filter_policy" \
    --arg redrivePolicy "$redrive_policy" '
      .Attributes.PendingConfirmation == "false" and
      .Attributes.RawMessageDelivery == "true" and
      .Attributes.FilterPolicyScope == "MessageAttributes" and
      (.Attributes.FilterPolicy | fromjson) == ($filterPolicy | fromjson) and
      (.Attributes.RedrivePolicy | fromjson) == ($redrivePolicy | fromjson)
    ' <<<"$deployed_temporary_attributes" >/dev/null ||
    fail 'temporary subscription attributes violate the drill contract'

  local message_attributes
  local message_id
  message_attributes="$(jq -cn --arg eventType "$drill_event_type" \
    '{eventType: {DataType: "String", StringValue: $eventType}}')"
  state_set_boolean publishAttempted true
  message_id="$(aws_call sns sns publish \
    --topic-arn "$topic_arn" \
    --message "$message_body" \
    --message-attributes "$message_attributes" \
    --query MessageId \
    --output text)"
  [[ -n "$message_id" && "$message_id" != 'None' ]] ||
    fail 'SNS publish did not return a message ID'
  state_set_string messageId "$message_id"

  receive_matching_marker "$subscription_dlq_url" "$message_body"
  assert_queue_empty "$temporary_queue_url"
  assert_queue_empty "$delivery_queue_url"
  delete_matched_marker "$subscription_dlq_url"
  cleanup_temporary_resources

  assert_deployed_queues_empty \
    "$delivery_queue_url" \
    "$worker_dlq_url" \
    "$publisher_failure_queue_url" \
    "$subscription_dlq_url"
  assert_no_residual_drill_resources "$topic_arn"
  assert_stack_status
  assert_stack_in_sync

  local sqs_calls
  local sns_calls
  sqs_calls="$(call_count sqs)"
  sns_calls="$(call_count sns)"
  ((sqs_calls <= sqs_call_cap)) || fail "SQS call count exceeded cap: $sqs_calls"
  ((sns_calls <= sns_call_cap)) || fail "SNS call count exceeded cap: $sns_calls"

  rm -f "$state_file"
  trap - EXIT INT TERM
  echo "SNS subscription-DLQ drill passed: messageId=$message_id, SQS calls=$sqs_calls, SNS calls=$sns_calls."
}

cleanup_drill() {
  : >"$call_log"
  assert_identity
  validate_recovery_state

  local stored_topic_arn
  local stored_delivery_queue_url
  local stored_subscription_dlq_url
  local stored_subscription_dlq_arn
  stored_topic_arn="$(state_string topicArn)"
  stored_delivery_queue_url="$(state_string deliveryQueueUrl)"
  stored_subscription_dlq_url="$(state_string subscriptionDlqUrl)"
  stored_subscription_dlq_arn="$(state_string subscriptionDlqArn)"

  assert_stack_status
  resolve_and_verify_stack_resources
  assert_subscription_dlq_policy
  [[ "$topic_arn" == "$stored_topic_arn" ]] ||
    fail 'recovery topic does not match the deployed topic'
  [[ "$delivery_queue_url" == "$stored_delivery_queue_url" ]] ||
    fail 'recovery delivery queue does not match the deployed queue'
  [[ "$subscription_dlq_url" == "$stored_subscription_dlq_url" ]] ||
    fail 'recovery DLQ URL does not match the deployed subscription DLQ'
  [[ "$subscription_dlq_arn" == "$stored_subscription_dlq_arn" ]] ||
    fail 'recovery DLQ does not match the deployed subscription DLQ'

  cleanup_temporary_resources
  recover_marker_if_needed
  assert_deployed_queues_empty \
    "$delivery_queue_url" \
    "$worker_dlq_url" \
    "$publisher_failure_queue_url" \
    "$subscription_dlq_url"
  assert_no_residual_drill_resources "$topic_arn"
  assert_stack_in_sync

  rm -f "$state_file"
  echo 'SNS subscription-DLQ drill cleanup completed.'
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
