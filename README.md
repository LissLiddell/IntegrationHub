# IntegrationHub

IntegrationHub is an event-delivery control plane for receiving webhooks,
delivering them to HTTP destinations, inspecting every attempt, retrying
temporary failures, and preventing duplicate business operations.

The portfolio demo follows `Nébula Commerce`: an `order.created` event must
reach its fulfillment API. The fictional destination returns HTTP `503` the
first time. An operator inspects the failure in the web console and manually
retries it; the second attempt returns HTTP `202` while both attempts remain in
the audit history.

## Architecture

```text
Producer -> API Gateway -> Webhook Lambda -> DynamoDB transaction
                                             | run + dedupe + outbox
                                             v
                                      DynamoDB Stream
                                             v
                                      Dispatcher Lambda
                                             v
                                      SQS FIFO + DLQ
                                             v
                                      Delivery Lambda -> HTTPS destination

Next.js console -> protected control API -> inspect runs / retry eligible failure
```

The domain layer does not depend on AWS. DynamoDB stores tenant-scoped records,
conditional claims prevent concurrent execution, SQS preserves ordering per
organization, and immutable attempt records explain what happened on every
delivery.

## Included now

- Public webhook ingestion with schema validation and a hashed token lookup.
- Atomic deduplication, run creation, and durable outbox in DynamoDB.
- DynamoDB Streams dispatcher and SQS FIFO delivery queue with DLQ.
- HTTPS destination validation, bounded responses, timeouts, and secrets from
  AWS Secrets Manager.
- Manual retry only for `FAILED_RETRYABLE` runs, with a distinct SQS
  deduplication id for the new delivery.
- Protected operations API for run lists, run details, attempts, and retries.
- A deterministic demo destination that fails once and accepts the retry.
- Responsive Next.js operations console with a safe local-preview mode.
- Persistent DynamoDB role assignments, connection remediation metadata,
  audited case closure, and server-side permission checks for every mutation.
- Credential rotation through AWS Secrets Manager without returning or logging
  the stored value, followed by a safe authenticated connection probe that does
  not execute the business event. Only a successful probe enables the retry.
- A traffic simulator with shipping, invoicing, and a three-event burst so the
  console can demonstrate concurrent workflows without a live producer.

## Local verification

```bash
pnpm install
pnpm check
pnpm demo:first-flow
pnpm dev:web
```

Open `http://localhost:3000`. Without cloud configuration the console uses the
same Nébula scenario locally, so the visible retry can be tested without
creating AWS resources.

Without cloud configuration, the role selector and connection/case-management
actions remain local product demonstrations. With the AWS control API configured,
the same UI reads assigned roles from DynamoDB and persists connection remediation,
case closure, and audit activity across reloads.

## Seed the AWS demo

Generate the private demo values first:

```bash
pnpm demo:credentials
```

Pass `DEMO_ACCESS_KEY_SHA256` to the SAM stack and keep its matching
`DEMO_CONTROL_KEY` for the Next.js server. Then deploy `infra/template.yaml`,
copy its stack outputs into a local `.env`, and run:

```bash
pnpm seed:aws-demo
```

Required values are documented in `.env.example`. The script prints a new
webhook token when `DEMO_WEBHOOK_TOKEN` is omitted; save it because DynamoDB only
stores its SHA-256 lookup key.

The Next.js server needs these private runtime values to connect the panel:

```text
INTEGRATIONHUB_API_URL=https://.../api/demo
INTEGRATIONHUB_DEMO_KEY=the-original-demo-control-key
```

Only the SHA-256 digest of that control key is passed to the Lambda stack. The
browser never receives either private value; Next.js route handlers act as the
small backend-for-frontend boundary.

After updating an existing stack, run `pnpm seed:aws-demo` again. The seed is
idempotent for the portfolio tenant and now also creates the `user_lisset` demo
role assignment used by the operator, administrator, and auditor selector.

## Demo cost controls

The SAM template keeps DynamoDB in on-demand mode so an idle portfolio demo has
no provisioned throughput to pay for. It also leaves paid point-in-time recovery
and X-Ray tracing disabled, limits every Lambda to two concurrent invocations,
and keeps DynamoDB, Streams, SQS, and Lambda in the same Region. Secrets Manager
remains the only fixed-price component in this increment (currently USD 0.40 per
secret-month before applicable credits); it can be replaced by SSM Parameter
Store Standard when the credential adapter is migrated.

## Product walkthrough

See [`docs/FIRST_FLOW_ES.md`](docs/FIRST_FLOW_ES.md) for the business explanation,
test scenario, expected state changes, and the exact portfolio story.

For the real AWS connection, follow
[`docs/AWS_DEPLOY_ES.md`](docs/AWS_DEPLOY_ES.md). It covers the private demo
keys, SAM deployment, DynamoDB seed, web configuration, persistence smoke test,
and stack cleanup.
