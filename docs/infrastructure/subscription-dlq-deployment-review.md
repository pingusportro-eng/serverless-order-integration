# SNS subscription-DLQ deployment review

Status: deployed and verified

Reviewed: 2026-07-27

Stack: `serverless-order-integration-dev`

Region: `eu-central-1`

Required AWS CLI profile: `pingusportro-admin`

## Approval boundary

This review records the live baseline, actual no-execute CloudFormation change
set, cost exposure, rollback behavior, and verification gates for adding the
approved SNS subscription DLQ.

The initial preflight used only read-only control-plane checks. After approval,
SAM packaging added five project-prefix objects and created a no-execute change
set. No stack resource, application API request, or test message was created,
and the deployed stack remains unchanged.

## Live baseline

Read-only checks on 2026-07-27 found:

- the explicit profile resolves to account `454921778743`;
- the stack is `UPDATE_COMPLETE` with 32 complete resources;
- its most recent drift result is `IN_SYNC`;
- the DynamoDB Stream mapping is `Enabled` with
  `LastProcessingResult=OK`;
- the delivery SQS mapping is `Enabled`;
- the delivery queue, worker DLQ, and publisher failure queue each report zero
  visible, in-flight, and delayed messages;
- the delivery SNS subscription is confirmed, retains the exact two-event
  filter, and currently has no `RedrivePolicy`;
- the `$1` Zero-Spend Budget reports `$0.00` actual and forecast spend; and
- the local mock vendor and Cloudflare tunnel are stopped.

Budget and queue counters are delayed or approximate observations, not hard
spending or consistency guarantees.

## Reviewed stack changes

The corrected no-execute change set contains:

| Logical resource | Action | Expected interruption |
| --- | --- | --- |
| `DeliverySubscriptionDeadLetterQueue` | Add one standard, SQS-encrypted queue with one-day retention | None to existing resources |
| `DeliverySubscriptionDeadLetterQueuePolicy` | Add the topic-and-account-scoped `sqs:SendMessage` policy | None to existing resources |
| `DeliverySubscription` | Add the DLQ `RedrivePolicy` and creation dependency | No interruption |
| `OrdersApiFunction` | Update the rebuilt code artifact | No interruption |
| `VendorWebhookFunction` | Update the rebuilt code artifact | No interruption |
| `StreamPublisherFunction` | Update the rebuilt bundle containing its reviewed safe failure logging | No interruption |
| `DeliveryWorkerFunction` | Update the rebuilt code artifact | No interruption |
| `SynchronousHttpApi` | Dynamically refresh its body because it references the API and webhook Lambda ARNs | No interruption |
| `DeliverySubscriptionDeadLetterQueueUrl` | Add a non-secret stack output | Not a resource |

The redrive update does not change the subscription endpoint, protocol, topic,
raw-message setting, or filter. CloudFormation documents `RedrivePolicy` as a
no-interruption subscription update:
<https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-resource-sns-subscription.html>.

The HTTP API change is dependency propagation from the Lambda resources; it
does not alter routes, authorization, throttling, or logging. All four Lambda
changes modify only their S3 code keys.

No resource deletion, replacement, IAM change, stack-tag change, or parameter
change is present. No Lambda memory, timeout, concurrency, DynamoDB throughput
control, message retention, log retention, vendor endpoint, authentication
resource, or secret changes are present.

The first no-execute change set was rejected because the SAM command omitted
the two existing stack tags and therefore proposed removing them from most
resources. It was never executed and was deleted. The corrected command
preserves `Project=serverless-order-integration` and `Environment=dev`; its
change set contains no tag modifications.

## Cost review

- SQS has no per-queue hourly charge; the additional queue is billed only for
  requests and retained payload usage.
- Successful SNS deliveries do not write to the subscription DLQ.
- The queue reuses the approved one-day failure retention and SQS-owned
  encryption, with no customer-managed KMS key or KMS request cost.
- Before packaging, the existing SAM prefix contained 40 objects totalling
  17,753,944 bytes.
- Packaging added four rebuilt bundles and one template. The prefix now
  contains 45 objects totalling 19,978,053 bytes.
- This remains well below the permanently approved 50 MB project cap.
- Even if all 50 MB remained for a full month, its storage and small number of
  packaging requests are conservatively bounded below `$0.003`.
- The deployment and bounded failure campaign still fit inside the approved
  incremental `$0.02` ceiling.

AWS pricing remains usage-based:
<https://aws.amazon.com/sqs/pricing/>.

## Deployment gate

On 2026-07-27, the owner approved the subscription-DLQ update and permanently
increased the project SAM artifact cap from 20 MB to 50 MB.

The local checks, packaging, and corrected no-execute change-set review passed.
The owner then explicitly approved its four Lambda code updates and resulting
dynamic HTTP API body update. The saved change set was reconfirmed, executed
without rebuilding, and reached `UPDATE_COMPLETE` without rollback.

CloudFormation should return the subscription to its previous configuration
and remove the new queue and policy if the update fails. After any rollback,
verify the stack status, subscription attributes, queue inventory, and backlog
before another attempt.

## Post-deployment verification

Before sending test traffic:

- the stack contains 34 resources and reports `UPDATE_COMPLETE`;
- the new queue output resolves to the expected account and Region;
- the queue has one-day retention and SQS-managed encryption;
- its policy grants only `sns.amazonaws.com`, the deployed topic ARN, and this
  account as source;
- the existing subscription has the new queue ARN in `RedrivePolicy`;
- the actionable-event filter remains unchanged;
- all four queues are empty;
- both event-source mappings remain enabled; and
- a fresh drift check returns `IN_SYNC`.

Starting the vendor and tunnel and deliberately breaking SNS delivery belong to
the later bounded failure campaign, not to the deployment itself.

## Deployment result

Post-deployment checks on 2026-07-27 confirmed:

- the stack is `UPDATE_COMPLETE` with 34 complete resources;
- the two stack tags remain present;
- the new queue has one-day retention, SQS-managed encryption, and no backlog;
- its policy grants `sqs:SendMessage` only to `sns.amazonaws.com` when the
  source is this account and the deployed domain-events topic;
- the confirmed SNS subscription points its `RedrivePolicy` to the new queue;
- its raw-delivery setting and exact two-event filter are unchanged;
- all four Lambdas are `Active` with `LastUpdateStatus=Successful`;
- both event-source mappings remain `Enabled`;
- all four SQS queues report zero visible, in-flight, and delayed messages;
- the HTTP API still exposes the same five routes, authorization modes,
  one-request-per-second rate, and burst limit of two;
- the SAM prefix contains 45 objects totalling 19,978,053 bytes, below the
  permanent 50 MB cap;
- the budget view remains `$0.00` actual and forecast; and
- fresh drift detection returned `IN_SYNC` with zero drifted resources.

No application API request or test message was sent during deployment
verification.
