# 0002: Use DynamoDB on-demand capacity

- Status: Accepted
- Date: 2026-07-21

## Context

The workload begins with almost no traffic, can be idle for long periods, and
may receive brief bursts during demonstrations. The project must avoid paying
for an always-running database and should not require capacity forecasting.

DynamoDB supports provisioned and on-demand capacity. Provisioned capacity can
be economical for stable, predictable workloads but requires read/write capacity
planning. On-demand bills the read and write requests that actually occur and
does not charge for throughput when traffic is zero.

Reference: [DynamoDB on-demand capacity](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/on-demand-capacity-mode.html)

## Decision

Use one DynamoDB Standard table in `PAY_PER_REQUEST` mode in `eu-central-1`.

- Keep the table single-region; do not enable global tables.
- Use AWS-owned or AWS-managed encryption rather than a customer-managed KMS
  key.
- Enable DynamoDB Streams only when the asynchronous cloud slice is introduced.
- Do not enable DAX, point-in-time recovery, on-demand backups, or exports for
  the initial development environment.
- Review conservative maximum on-demand throughput settings before deployment
  so unexpected traffic is throttled before it threatens the budget.
- Destroy the development table with the stack unless retention is explicitly
  approved.

## Alternatives considered

### Provisioned capacity

Very low provisioned capacity may fit within DynamoDB's free allowance and can
cost less for stable traffic. It also introduces capacity tuning and intentional
throttling behavior that distract from the first implementation. It remains a
valid later optimization after measuring a predictable workload.

### A local or managed relational database

The order access patterns do not require joins or ad hoc relational queries.
Managed relational databases also introduce instance or capacity concerns that
are not needed for this serverless learning project.

### DynamoDB Standard-Infrequent Access

The MVP has little stored data and proportionally more access than archival
storage, so the Standard table class is a better fit.

## Consequences

### Positive

- There is no database instance to run or patch.
- Idle periods incur no read/write throughput charge.
- Capacity automatically adapts to an irregular learning workload.
- The same API and data model work with the official DynamoDB Local container.

### Trade-offs

- Every request is metered, so an accidental request loop can generate cost.
- On-demand can cost more than well-utilized provisioned capacity at steady,
  predictable scale.
- Storage, optional backups, Streams reads beyond allowances, and data transfer
  have separate pricing considerations.
- Good key design remains essential; on-demand capacity does not fix scans, hot
  partitions, or inefficient item sizes.

## Cost effect

There is no idle throughput charge. The small request count and dataset should
cost approximately zero, but the table is still pay-per-use. Maximum throughput,
alarms, and the planned test request count will be reviewed before deployment.

## Reconsider when

Re-evaluate provisioned capacity after traffic becomes steady enough to forecast,
or if measured on-demand costs make capacity management worthwhile.

