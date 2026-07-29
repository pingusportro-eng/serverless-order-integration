# Exercise postmortem: delivery-provider rate limit and worker DLQ

| Field | Value |
| --- | --- |
| Date | 2026-07-29 |
| Environment | Development |
| Classification | Deliberate failure exercise; no customer impact |
| Affected workflow | Asynchronous order submission to the delivery provider |
| Status | Resolved and cleaned up |

## Executive summary

A controlled exercise configured the mock delivery provider to return HTTP
`429` responses. One synthetic `order.created` event reached the Delivery Queue
and was attempted three times by the delivery worker. Each attempt failed with
the expected retryable `VendorSubmissionError`. After the queue's configured
maximum receive count was reached, Amazon SQS moved the message to the worker
dead-letter queue (DLQ).

The operator restored the mock provider's successful behavior and started one
rate-limited SQS managed-redrive task. AWS moved the message back to its source
queue, the worker submitted it successfully, and the order reached the expected
durable state. The provider recorded one successful external effect. The
application stack, deployment artifacts, local processes, and synthetic data
were subsequently removed.

The runtime system behaved as designed. Two separate deployment-tooling defects
were discovered during the wider exercise and corrected; neither caused the
delivery failure.

## Impact and scope

- No production environment or real customer was affected.
- The exercise used one synthetic order, one domain event, and one SQS message.
- The synthetic order was inserted directly into DynamoDB to isolate the
  asynchronous path from the public Orders API.
- Recovery latency was intentionally influenced by the 90-second visibility
  timeout and the redrive policy's maximum receive count of three.
- The provider performed the external delivery-creation effect once, during
  recovery.

## What happened

The automatic runtime path was:

```text
Synthetic DynamoDB order
  -> DynamoDB Stream
  -> Publisher Lambda
  -> SNS
  -> Delivery SQS queue
  -> Lambda event-source mapping
  -> Delivery Worker Lambda
  -> Mock delivery provider
```

While the provider returned `429`, the worker reported each message as failed.
The Lambda event-source mapping therefore did not acknowledge it as complete.
SQS made the message visible again after each visibility timeout. Once its
receive count exceeded the configured threshold, SQS moved it to the worker
DLQ.

Changing the mock provider to success did not itself move the message. The
operator deliberately started SQS managed redrive after verifying the message
and the recovery conditions. AWS then moved it from the DLQ to the source
queue, where normal polling and worker processing resumed.

## Timeline

All timestamps are UTC. Vendor observations come from the append-only drill
journal; worker observations come from structured CloudWatch logs.

| Time | Observation |
| --- | --- |
| Before 07:42:42 | The mock provider was set to the rate-limit scenario and the synthetic order was inserted. |
| 07:42:42.725 | The provider returned the first `429`. |
| 07:42:44.657 | The worker logged `delivery.message.failed`, aggregate version 1, attempt 1. |
| 07:44:11.705 | The provider returned the second `429`. |
| 07:44:11.726 | The worker logged `delivery.message.failed`, aggregate version 1, attempt 2. |
| 07:45:41.218 | The provider returned the third `429`. |
| 07:45:41.337 | The worker logged `delivery.message.failed`, aggregate version 1, attempt 3. |
| After 07:45:41 | SQS moved the message to the worker DLQ after the configured receive threshold. The drill verified a DLQ visible-message count of one. |
| Before 07:47:20 | The operator restored provider success and started one managed-redrive task at one message per second. |
| 07:47:20.983 | The provider returned `201` for the redriven message. |
| 07:47:21.158 | The worker logged `delivery.message.processed` with `outcome=submitted`. |
| After recovery | The managed-redrive task reported `COMPLETED`, one message moved, and the queues, synthetic data, stack, artifacts, and local processes were cleaned up. |

The exercise identifiers were:

```text
correlationId: corr.vendor429drill.1785310860841814
orderId:       ord_vendor429drill1785310860841814
```

## Detection and evidence

The failure and recovery were established from independent signals:

- structured worker logs tied every attempt to the same correlation ID, order,
  event type, aggregate version, and exception;
- the append-only mock-provider journal showed three `429` responses followed
  by one `201`;
- SQS metrics showed the message leave the source queue and a visible-message
  peak of one in the worker DLQ;
- the source queue configuration showed `Maximum receives: 3`;
- the managed-redrive task showed `Successfully completed`, 100 percent
  processed, with the source queue as its destination; and
- the final worker record showed successful processing of the redriven event.

No single log line was treated as sufficient proof. The conclusion required
agreement between application logs, provider evidence, queue state, and the
durable order outcome.

## Root cause

The immediate cause was intentional: the mock delivery dependency returned
HTTP `429` for every delivery-creation request during the failure phase.

The worker correctly classified that provider response as a retryable
`VendorSubmissionError` and returned a partial-batch failure. SQS and the
Lambda event-source mapping then applied their configured at-least-once retry
behavior. Movement to the DLQ after three receives was an expected protection,
not a defect.

The exercise demonstrates that a healthy application cannot prevent an
external provider from rate-limiting it. It can bound each attempt, preserve
the failed work, correlate the evidence, avoid duplicate external effects, and
support controlled recovery.

## Response and recovery

The operator:

1. correlated the three failures across worker logs and the provider journal;
2. verified that exactly one expected message was present in the worker DLQ;
3. restored the DLQ message's visibility after controlled inspection;
4. changed the mock provider from rate-limit to success and verified its
   health;
5. started one SQS managed-redrive task limited to one message per second;
6. verified that the task completed and moved one message;
7. confirmed the provider `201`, worker success, and durable submitted order;
   and
8. removed the synthetic and temporary resources.

## What went well

- One correlation ID made the asynchronous journey traceable.
- Partial-batch failure preserved the failed message instead of losing it.
- The DLQ isolated the repeatedly failing message.
- A stable provider idempotency key protected the external operation during
  at-least-once delivery.
- Managed redrive reused the normal source-queue processing path.
- Evidence was available at the worker, provider, SQS, and durable-state
  boundaries.
- The recovery affected exactly one reviewed message.
- Cleanup verification showed no remaining application stack or deployment
  artifacts, and the budget view remained at `$0.00` actual and forecast.

## What could be improved

- Restarting the mock vendor truncated its ordinary console log. The
  append-only attempt journal preserved the evidence, but the distinction was
  not initially obvious.
- The drill was quiet during long visibility-timeout waits, making healthy
  waiting look similar to a stalled script.
- CloudFormation drift inspection initially lacked
  `logs:DescribeIndexPolicies`.
- Teardown recovery initially tied a destroy run to a branch head that had
  advanced after deployment.

The last two items were deployment-control defects discovered by the exercise.
They were not contributing causes of the provider `429` or the message's DLQ
journey.

## Follow-up actions

| Action | Owner | Status | Evidence or completion criterion |
| --- | --- | --- | --- |
| Permit read-only CloudWatch Logs index-policy inspection during drift checks. | Project maintainer | Complete | Commit `7018b08` adds `logs:DescribeIndexPolicies`. |
| Allow idempotent destroy-run recovery after the branch head advances, while keeping prepare and execute commit-bound. | Project maintainer | Complete | Commit `10aa8c0` updates destroy-run matching. |
| Document safe queue inspection, decision gates, managed redrive, and recovery proof. | Project maintainer | Complete | [Delivery-worker incident runbook](delivery-worker-incident-runbook.md). |
| Make the append-only provider-attempt journal explicit in drill output and evidence instructions. | Project maintainer | Planned | A future drill clearly distinguishes durable attempt evidence from restartable console logs. |
| Print progress milestones while waiting for visibility-timeout and DLQ transitions. | Project maintainer | Planned | A future drill reports its current wait condition without increasing polling or AWS cost materially. |

Paid custom metrics or alarms are not introduced by this postmortem. Any such
change requires a separate cost review under the project's `$5` monthly
budget.

## Lessons

- A Lambda success or explicit empty partial-batch-failure response
  acknowledges work; a reported failed item remains eligible for retry.
- The SQS visibility timeout delays the next receive but does not represent a
  separate copy of the message.
- A DLQ preserves exhausted work; restoring the dependency does not
  automatically redrive that work.
- Managed redrive is a controlled mutation and must follow message
  identification, dependency recovery, and blast-radius review.
- At-least-once delivery makes idempotency and durable deduplication part of
  correctness, not optional optimizations.
- Recovery is proven across boundaries, not merely by an empty queue or a
  successful Lambda invocation.

## Closure

The exercise closed only after:

- the managed-redrive task completed and moved one message;
- the worker successfully processed the same correlated event;
- the order reached the expected submitted state;
- source and dead-letter queues were empty;
- synthetic data was conditionally deleted;
- the CloudFormation application stack and artifact prefix were absent;
- the mock vendor and tunnel processes were stopped; and
- the AWS budget showed `$0.00` actual and forecast.

Related material:

- [Delivery-worker backlog and DLQ incident runbook](delivery-worker-incident-runbook.md)
- [Vendor rate-limit and worker-DLQ drill](../testing/vendor-rate-limit-dlq-drill.md)
- [Phase 7.2 failure-drill inventory](../testing/phase-7-failure-drill-inventory.md)
- [CloudWatch query cookbook](cloudwatch-query-cookbook.md)
