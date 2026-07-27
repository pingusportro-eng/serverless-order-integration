# SNS subscription-DLQ deployment review

Status: preflight complete; deployment approval pending

Reviewed: 2026-07-27

Stack: `serverless-order-integration-dev`

Region: `eu-central-1`

Required AWS CLI profile: `pingusportro-admin`

## Approval boundary

This review does not authorize a stack update. It records the live baseline,
the expected CloudFormation change set, cost exposure, rollback behavior, and
verification gates for adding the approved SNS subscription DLQ.

No stack resource, S3 artifact, change set, application API request, or test
message was created during this preflight. All AWS calls were read-only
control-plane checks.

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

## Expected stack changes

The next SAM deployment is expected to produce this change set:

| Logical resource | Action | Expected interruption |
| --- | --- | --- |
| `DeliverySubscriptionDeadLetterQueue` | Add one standard, SQS-encrypted queue with one-day retention | None to existing resources |
| `DeliverySubscriptionDeadLetterQueuePolicy` | Add the topic-and-account-scoped `sqs:SendMessage` policy | None to existing resources |
| `DeliverySubscription` | Add the DLQ `RedrivePolicy` and creation dependency | No interruption |
| `StreamPublisherFunction` | Update the bundle with the already-reviewed safe failure logging added after the previous deployment | No interruption |
| `DeliverySubscriptionDeadLetterQueueUrl` | Add a non-secret stack output | Not a resource |

The redrive update does not change the subscription endpoint, protocol, topic,
raw-message setting, or filter. CloudFormation documents `RedrivePolicy` as a
no-interruption subscription update:
<https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-resource-sns-subscription.html>.

No resource deletion or replacement is expected. No API throttle, Lambda
memory, timeout, concurrency, DynamoDB throughput control, message retention,
log retention, vendor endpoint, authentication resource, or secret parameter
changes.

This is an expectation derived from the committed template and code. Before
execution, SAM must create a no-execute change set. Execution must stop for a
new review if that change set contains anything beyond the actions above,
especially a replacement, deletion, IAM broadening, or cost-setting change.

## Cost review

- SQS has no per-queue hourly charge; the additional queue is billed only for
  requests and retained payload usage.
- Successful SNS deliveries do not write to the subscription DLQ.
- The queue reuses the approved one-day failure retention and SQS-owned
  encryption, with no customer-managed KMS key or KMS request cost.
- The existing SAM prefix currently contains 40 objects totalling 17,753,944
  bytes.
- A conservative deployment estimate assumes SAM uploads all four bundles
  again. Using the previous four-bundle total of 4,436,520 bytes gives a
  temporary peak of 22,190,464 bytes.
- That peak exceeds the earlier 20 MB artifact cap. The recommended deployment
  cap is therefore 25 MB until step 5.6 removes the project artifacts.
- Even if all 25 MB remained for a full month, its storage and small number of
  packaging requests would remain below the existing `$0.001` S3 allowance.
- The deployment and bounded failure campaign still fit inside the approved
  incremental `$0.02` ceiling.

AWS pricing remains usage-based:
<https://aws.amazon.com/sqs/pricing/>.

## Deployment gate

Deployment is paused until the owner explicitly approves both the stack update
and the temporary S3 artifact-cap increase from 20 MB to 25 MB. After approval:

1. Re-run the local checks and cloud SAM build.
2. Package to the existing project SAM prefix without printing secret values.
3. Create but do not execute the CloudFormation change set.
4. Verify it contains only the reviewed additions and no-interruption
   modifications above.
5. Execute it only if the verification passes.
6. Wait for `UPDATE_COMPLETE`; stop if CloudFormation begins rollback.

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
