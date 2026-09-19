import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { marshall } from "@aws-sdk/util-dynamodb";
import type { APIGatewayProxyEventV2, DynamoDBStreamEvent, SQSEvent } from "aws-lambda";
import { ingestWebhook } from "../../domain/ingest-webhook.ts";
import { processRun } from "../../domain/process-run.ts";
import {
  activeDemoWorkflow,
  FixedClock,
  InMemoryIntegrationRepository,
  InMemoryQueue,
  SequenceDelivery,
  SequentialIds
} from "../../testing/in-memory-adapters.ts";
import { createDeliveryWorker } from "./delivery-worker.ts";
import { createControlApiHandler } from "./control-api.ts";
import { createDemoDestinationHandler } from "./demo-destination.ts";
import { createOutboxDispatcher } from "./outbox-dispatcher.ts";
import { createWebhookHandler } from "./webhook.ts";
import { sha256 } from "../dynamo-keys.ts";

function webhookEvent(body: string): APIGatewayProxyEventV2 {
  return {
    version: "2.0",
    routeKey: "POST /hooks/{token}",
    rawPath: "/hooks/wh_demo_orders",
    rawQueryString: "",
    headers: { "content-type": "application/json" },
    requestContext: {} as APIGatewayProxyEventV2["requestContext"],
    isBase64Encoded: false,
    pathParameters: { token: "wh_demo_orders" },
    body
  };
}

function sqsEvent(body: string): SQSEvent {
  return {
    Records: [
      {
        messageId: "message-001",
        receiptHandle: "receipt",
        body,
        attributes: {} as SQSEvent["Records"][number]["attributes"],
        messageAttributes: {},
        md5OfBody: "hash",
        eventSource: "aws:sqs",
        eventSourceARN: "arn:aws:sqs:us-east-1:123:delivery.fifo",
        awsRegion: "us-east-1"
      }
    ]
  };
}

function apiEvent(
  method: string,
  options: {
    headers?: Record<string, string>;
    body?: string;
    runId?: string;
    connectionId?: string;
    path?: string;
  } = {}
): APIGatewayProxyEventV2 {
  const path = options.path ?? "/api/demo/runs";
  return {
    version: "2.0",
    routeKey: `${method} ${path}`,
    rawPath: path,
    rawQueryString: "",
    headers: options.headers ?? {},
    requestContext: {
      http: { method, path, protocol: "HTTP/1.1", sourceIp: "127.0.0.1", userAgent: "test" }
    } as APIGatewayProxyEventV2["requestContext"],
    isBase64Encoded: false,
    ...(options.runId || options.connectionId
      ? {
          pathParameters: {
            ...(options.runId ? { runId: options.runId } : {}),
            ...(options.connectionId ? { connectionId: options.connectionId } : {})
          }
        }
      : {}),
    ...(options.body ? { body: options.body } : {})
  };
}

const demoRoleAssignment = {
  actorId: "user_lisset",
  organizationId: "org_nebula",
  displayName: "Lisset López",
  roles: ["operator", "admin", "auditor"] as const,
  updatedAt: "2026-09-11T12:00:00.000Z"
};

const credentialStore = {
  values: [] as string[],
  async replaceCredentialAndVerify(_organizationId: string, _connectionId: string, credential: string) {
    this.values.push(credential);
    return { verified: true } as const;
  }
};

describe("Lambda handlers", () => {
  it("accepts a public webhook once and reports the repeated event as duplicate", async () => {
    const repository = new InMemoryIntegrationRepository();
    repository.addWorkflow(activeDemoWorkflow);
    const handler = createWebhookHandler({
      repository,
      clock: new FixedClock("2026-09-11T12:00:00.000Z"),
      ids: new SequentialIds()
    });
    const event = webhookEvent(
      JSON.stringify({ id: "evt_order_1042", type: "order.created", data: { orderId: "ORD-1042" } })
    );

    const accepted = await handler(event);
    const duplicate = await handler(event);

    assert.equal(accepted.statusCode, 202);
    assert.equal(JSON.parse(accepted.body ?? "{}").outcome, "ACCEPTED");
    assert.equal(duplicate.statusCode, 200);
    assert.equal(JSON.parse(duplicate.body ?? "{}").outcome, "DUPLICATE");
    assert.equal(repository.outboxMessages.length, 1);
  });

  it("returns a small validation error instead of leaking parser details", async () => {
    const repository = new InMemoryIntegrationRepository();
    repository.addWorkflow(activeDemoWorkflow);
    const handler = createWebhookHandler({
      repository,
      clock: new FixedClock("2026-09-11T12:00:00.000Z"),
      ids: new SequentialIds()
    });

    const response = await handler(webhookEvent("{broken"));

    assert.equal(response.statusCode, 400);
    assert.deepEqual(JSON.parse(response.body ?? "{}"), {
      error: { code: "INVALID_EVENT", message: "Webhook body must be valid JSON." }
    });
  });

  it("publishes only OUTBOX inserts from the DynamoDB stream", async () => {
    const queue = new InMemoryQueue();
    const handler = createOutboxDispatcher(queue);
    const streamEvent = {
      Records: [
        {
          eventID: "stream-001",
          eventName: "INSERT",
          dynamodb: {
            NewImage: marshall({
              entityType: "OUTBOX",
              id: "outbox_run_001",
              runId: "run_001",
              organizationId: "org_nebula",
              correlationId: "correlation_001",
              createdAt: "2026-09-11T12:00:00.000Z"
            })
          }
        }
      ]
    } as DynamoDBStreamEvent;

    const result = await handler(streamEvent);

    assert.deepEqual(result, { batchItemFailures: [] });
    assert.deepEqual(queue.messages, [
      {
        deliveryId: "outbox_run_001",
        runId: "run_001",
        organizationId: "org_nebula",
        correlationId: "correlation_001"
      }
    ]);
  });

  it("processes the SQS message and records a successful delivery", async () => {
    const repository = new InMemoryIntegrationRepository();
    repository.addWorkflow(activeDemoWorkflow);
    const clock = new FixedClock("2026-09-11T12:00:00.000Z");
    const ids = new SequentialIds();
    const accepted = await ingestWebhook(
      "wh_demo_orders",
      { eventId: "evt_order_1042", eventType: "order.created", payload: { orderId: "ORD-1042" } },
      { repository, clock, ids }
    );
    const delivery = new SequenceDelivery([{ httpStatus: 202, responseBody: "accepted" }]);
    const handler = createDeliveryWorker({ repository, delivery, clock, ids });
    const outbox = repository.outboxMessages[0]!;

    const result = await handler(
      sqsEvent(
        JSON.stringify({
          deliveryId: outbox.id,
          runId: outbox.runId,
          organizationId: outbox.organizationId,
          correlationId: outbox.correlationId
        })
      )
    );

    assert.deepEqual(result, { batchItemFailures: [] });
    assert.equal((await repository.getRun("org_nebula", accepted.run.id))?.status, "SUCCEEDED");
    assert.equal(delivery.calls.length, 1);
  });

  it("returns only the malformed SQS record for retry", async () => {
    const repository = new InMemoryIntegrationRepository();
    const handler = createDeliveryWorker({
      repository,
      delivery: new SequenceDelivery([]),
      clock: new FixedClock("2026-09-11T12:00:00.000Z"),
      ids: new SequentialIds()
    });

    assert.deepEqual(await handler(sqsEvent("not-json")), {
      batchItemFailures: [{ itemIdentifier: "message-001" }]
    });
  });

  it("queues a retry through the protected control API", async () => {
    const repository = new InMemoryIntegrationRepository();
    repository.addWorkflow(activeDemoWorkflow);
    repository.addRoleAssignment({ ...demoRoleAssignment, roles: [...demoRoleAssignment.roles] });
    const clock = new FixedClock("2026-09-11T12:00:00.000Z");
    const ids = new SequentialIds();
    const accepted = await ingestWebhook(
      "wh_demo_orders",
      { eventId: "evt_retry", eventType: "order.created", payload: { orderId: "ORD-RETRY" } },
      { repository, clock, ids }
    );
    await processRun(repository.outboxMessages[0]!, {
      repository,
      clock,
      ids,
      delivery: new SequenceDelivery([{ httpStatus: 503 }])
    });
    const queue = new InMemoryQueue();
    const handler = createControlApiHandler({
      repository,
      queue,
      credentialStore,
      organizationId: "org_nebula",
      actorId: "user_lisset",
      accessKeySha256: sha256("demo-control-key")
    });

    const response = await handler(
      apiEvent("POST", {
        runId: accepted.run.id,
        path: `/api/demo/runs/${accepted.run.id}/retry`,
        headers: {
          "x-integrationhub-demo-key": "demo-control-key",
          "x-integrationhub-role": "operator"
        }
      })
    );

    assert.equal(response.statusCode, 202);
    assert.equal(queue.messages[0]?.deliveryId, `retry_${accepted.run.id}_2`);
  });

  it("creates a rate-limited AWS demo run through the protected control API", async () => {
    const repository = new InMemoryIntegrationRepository();
    repository.addRoleAssignment({ ...demoRoleAssignment, roles: [...demoRoleAssignment.roles] });
    const clock = new FixedClock("2026-09-11T12:00:00.000Z");
    const preparedScenarios: string[] = [];
    const handler = createControlApiHandler({
      repository,
      queue: new InMemoryQueue(),
      credentialStore,
      organizationId: "org_nebula",
      actorId: "user_lisset",
      accessKeySha256: sha256("demo-control-key"),
      now: () => new Date("2026-09-11T12:00:00.000Z"),
      demoRun: {
        workflow: activeDemoWorkflow,
        clock,
        ids: new SequentialIds(),
        limiter: {
          async consume() {
            return { allowed: true, remaining: 49 };
          }
        },
        dailyLimit: 50,
        scenarioPreparer: {
          async prepare(scenario) {
            preparedScenarios.push(scenario);
          }
        }
      }
    });

    const response = await handler(
      apiEvent("POST", {
        path: "/api/demo/runs/demo",
        headers: {
          "x-integrationhub-demo-key": "demo-control-key",
          "x-integrationhub-role": "operator"
        },
        body: JSON.stringify({ scenario: "shipping-timeout" })
      })
    );
    const body = JSON.parse(response.body ?? "{}");

    assert.equal(response.statusCode, 202);
    assert.equal(body.outcome, "ACCEPTED");
    assert.equal(body.run.status, "QUEUED");
    assert.equal(body.scenario, "shipping-timeout");
    assert.equal(body.run.payload.demoScenario, "shipping-timeout");
    assert.equal(body.remaining, 49);
    assert.deepEqual(preparedScenarios, ["shipping-timeout"]);
    assert.equal(repository.outboxMessages.length, 1);
  });

  it("rejects an unsupported AWS demo scenario before changing credentials", async () => {
    const repository = new InMemoryIntegrationRepository();
    repository.addRoleAssignment({ ...demoRoleAssignment, roles: [...demoRoleAssignment.roles] });
    let prepared = false;
    const handler = createControlApiHandler({
      repository,
      queue: new InMemoryQueue(),
      credentialStore,
      organizationId: "org_nebula",
      actorId: "user_lisset",
      accessKeySha256: sha256("demo-control-key"),
      demoRun: {
        workflow: activeDemoWorkflow,
        clock: new FixedClock("2026-09-11T12:00:00.000Z"),
        ids: new SequentialIds(),
        limiter: { async consume() { return { allowed: true, remaining: 49 }; } },
        dailyLimit: 50,
        scenarioPreparer: { async prepare() { prepared = true; } }
      }
    });

    const response = await handler(
      apiEvent("POST", {
        path: "/api/demo/runs/demo",
        headers: {
          "x-integrationhub-demo-key": "demo-control-key",
          "x-integrationhub-role": "operator"
        },
        body: JSON.stringify({ scenario: "invented-scenario" })
      })
    );

    assert.equal(response.statusCode, 400);
    assert.equal(prepared, false);
  });

  it("persists a case closure and blocks later retries", async () => {
    const repository = new InMemoryIntegrationRepository();
    repository.addWorkflow(activeDemoWorkflow);
    repository.addRoleAssignment({ ...demoRoleAssignment, roles: [...demoRoleAssignment.roles] });
    const clock = new FixedClock("2026-09-11T12:00:00.000Z");
    const ids = new SequentialIds();
    const accepted = await ingestWebhook(
      "wh_demo_orders",
      { eventId: "evt_close", eventType: "order.created", payload: { orderId: "ORD-CLOSE" } },
      { repository, clock, ids }
    );
    await processRun(repository.outboxMessages[0]!, {
      repository,
      clock,
      ids,
      delivery: new SequenceDelivery([{ httpStatus: 503 }])
    });
    const handler = createControlApiHandler({
      repository,
      queue: new InMemoryQueue(),
      credentialStore,
      organizationId: "org_nebula",
      actorId: "user_lisset",
      accessKeySha256: sha256("demo-control-key"),
      now: () => new Date("2026-09-11T13:00:00.000Z")
    });
    const headers = {
      "x-integrationhub-demo-key": "demo-control-key",
      "x-integrationhub-role": "operator"
    };

    const closed = await handler(
      apiEvent("POST", {
        runId: accepted.run.id,
        path: `/api/demo/runs/${accepted.run.id}/close`,
        headers,
        body: JSON.stringify({ reason: "Pedido cancelado", note: "Cliente confirmó la cancelación." })
      })
    );
    const retried = await handler(
      apiEvent("POST", {
        runId: accepted.run.id,
        path: `/api/demo/runs/${accepted.run.id}/retry`,
        headers
      })
    );
    const lateDelivery = new SequenceDelivery([{ httpStatus: 202 }]);
    const staleQueueResult = await processRun(
      {
        deliveryId: `retry_${accepted.run.id}_2`,
        runId: accepted.run.id,
        organizationId: "org_nebula",
        correlationId: accepted.run.correlationId
      },
      { repository, clock, ids, delivery: lateDelivery }
    );

    assert.equal(closed.statusCode, 200);
    assert.equal((await repository.getRunOperations("org_nebula", accepted.run.id)).closure?.reason, "Pedido cancelado");
    assert.equal(retried.statusCode, 409);
    assert.deepEqual(staleQueueResult, { outcome: "IGNORED" });
    assert.equal(lateDelivery.calls.length, 0);
  });

  it("requires the case history when the operator selects Otro motivo", async () => {
    const repository = new InMemoryIntegrationRepository();
    repository.addWorkflow(activeDemoWorkflow);
    repository.addRoleAssignment({ ...demoRoleAssignment, roles: [...demoRoleAssignment.roles] });
    const clock = new FixedClock("2026-09-11T12:00:00.000Z");
    const ids = new SequentialIds();
    const accepted = await ingestWebhook(
      "wh_demo_orders",
      { eventId: "evt_other_reason", eventType: "order.created", payload: { orderId: "ORD-OTHER" } },
      { repository, clock, ids }
    );
    await processRun(repository.outboxMessages[0]!, {
      repository,
      clock,
      ids,
      delivery: new SequenceDelivery([{ httpStatus: 503 }])
    });
    const handler = createControlApiHandler({
      repository,
      queue: new InMemoryQueue(),
      credentialStore,
      organizationId: "org_nebula",
      actorId: "user_lisset",
      accessKeySha256: sha256("demo-control-key")
    });

    const response = await handler(
      apiEvent("POST", {
        runId: accepted.run.id,
        path: `/api/demo/runs/${accepted.run.id}/close`,
        headers: {
          "x-integrationhub-demo-key": "demo-control-key",
          "x-integrationhub-role": "operator"
        },
        body: JSON.stringify({ reason: "Otro motivo", note: "" })
      })
    );

    assert.equal(response.statusCode, 400);
    assert.equal((await repository.getRunOperations("org_nebula", accepted.run.id)).closure, null);
  });

  it("requires an assigned administrator and persists connection remediation", async () => {
    const repository = new InMemoryIntegrationRepository();
    repository.addWorkflow(activeDemoWorkflow);
    repository.addRoleAssignment({ ...demoRoleAssignment, roles: [...demoRoleAssignment.roles] });
    const clock = new FixedClock("2026-09-11T12:00:00.000Z");
    const ids = new SequentialIds();
    const accepted = await ingestWebhook(
      "wh_demo_orders",
      { eventId: "evt_remediate", eventType: "order.created", payload: { orderId: "ORD-FIX" } },
      { repository, clock, ids }
    );
    await processRun(repository.outboxMessages[0]!, {
      repository,
      clock,
      ids,
      delivery: new SequenceDelivery([{ httpStatus: 401 }])
    });
    credentialStore.values.length = 0;
    const handler = createControlApiHandler({
      repository,
      queue: new InMemoryQueue(),
      credentialStore,
      organizationId: "org_nebula",
      actorId: "user_lisset",
      accessKeySha256: sha256("demo-control-key"),
      now: () => new Date("2026-09-11T13:05:00.000Z")
    });
    const path = `/api/demo/connections/${accepted.run.connectionId}/remediate`;
    const body = JSON.stringify({ runId: accepted.run.id, credential: "new-demo-token" });

    const denied = await handler(
      apiEvent("POST", {
        connectionId: accepted.run.connectionId,
        path,
        body,
        headers: {
          "x-integrationhub-demo-key": "demo-control-key",
          "x-integrationhub-role": "operator"
        }
      })
    );
    const remediated = await handler(
      apiEvent("POST", {
        connectionId: accepted.run.connectionId,
        path,
        body,
        headers: {
          "x-integrationhub-demo-key": "demo-control-key",
          "x-integrationhub-role": "admin"
        }
      })
    );

    assert.equal(denied.statusCode, 403);
    assert.equal(remediated.statusCode, 200);
    assert.deepEqual(credentialStore.values, ["new-demo-token"]);
    assert.equal((await repository.getRun("org_nebula", accepted.run.id))?.status, "FAILED_RETRYABLE");
    assert.equal((await repository.getRunOperations("org_nebula", accepted.run.id)).connectionRemediated, true);
  });

  it("keeps the run blocked when the provider rejects the replacement credential", async () => {
    const repository = new InMemoryIntegrationRepository();
    repository.addWorkflow(activeDemoWorkflow);
    repository.addRoleAssignment({ ...demoRoleAssignment, roles: [...demoRoleAssignment.roles] });
    const clock = new FixedClock("2026-09-11T12:00:00.000Z");
    const ids = new SequentialIds();
    const accepted = await ingestWebhook(
      "wh_demo_orders",
      { eventId: "evt_bad_fix", eventType: "order.created", payload: { orderId: "ORD-BAD-FIX" } },
      { repository, clock, ids }
    );
    await processRun(repository.outboxMessages[0]!, {
      repository,
      clock,
      ids,
      delivery: new SequenceDelivery([{ httpStatus: 401 }])
    });
    const handler = createControlApiHandler({
      repository,
      queue: new InMemoryQueue(),
      credentialStore: {
        async replaceCredentialAndVerify() {
          return { verified: false, code: "REJECTED" } as const;
        }
      },
      organizationId: "org_nebula",
      actorId: "user_lisset",
      accessKeySha256: sha256("demo-control-key")
    });

    const response = await handler(
      apiEvent("POST", {
        connectionId: accepted.run.connectionId,
        path: `/api/demo/connections/${accepted.run.connectionId}/remediate`,
        body: JSON.stringify({ runId: accepted.run.id, credential: "rejected-demo-token" }),
        headers: {
          "x-integrationhub-demo-key": "demo-control-key",
          "x-integrationhub-role": "admin"
        }
      })
    );

    assert.equal(response.statusCode, 422);
    assert.equal((await repository.getRun("org_nebula", accepted.run.id))?.status, "FAILED_FINAL");
    assert.equal((await repository.getRunOperations("org_nebula", accepted.run.id)).connectionRemediated, false);
  });

  it("keeps the control API private when the demo key is missing", async () => {
    const handler = createControlApiHandler({
      repository: new InMemoryIntegrationRepository(),
      queue: new InMemoryQueue(),
      credentialStore,
      organizationId: "org_nebula",
      actorId: "user_lisset",
      accessKeySha256: sha256("demo-control-key")
    });

    assert.equal((await handler(apiEvent("GET"))).statusCode, 401);
  });

  it("makes the fictional destination fail once and accept the retry", async () => {
    let invocation = 0;
    const handler = createDemoDestinationHandler({
      counter: { increment: async () => ++invocation },
      getExpectedToken: async () => "destination-token",
      now: () => new Date("2026-09-11T12:00:00.000Z")
    });
    const event = apiEvent("POST", {
      headers: {
        authorization: "Bearer destination-token",
        "x-integrationhub-correlation-id": "correlation_001"
      },
      body: JSON.stringify({ orderId: "ORD-1042" })
    });

    const first = await handler(event);
    const second = await handler(event);

    assert.equal(first.statusCode, 503);
    assert.equal(second.statusCode, 202);
    assert.equal(JSON.parse(second.body ?? "{}").status, "accepted");
  });

  it("accepts the direct-success AWS scenario without consuming the retry counter", async () => {
    let invocation = 0;
    const handler = createDemoDestinationHandler({
      counter: { increment: async () => ++invocation },
      getExpectedToken: async () => "destination-token",
      now: () => new Date("2026-09-11T12:00:00.000Z")
    });

    const response = await handler(
      apiEvent("POST", {
        headers: {
          authorization: "Bearer destination-token",
          "x-integrationhub-correlation-id": "correlation_success"
        },
        body: JSON.stringify({ orderId: "ORD-SUCCESS", demoScenario: "shipping-success" })
      })
    );

    assert.equal(response.statusCode, 202);
    assert.equal(invocation, 0);
  });

  it("rejects the credential scenario first and accepts its delivery only after valid authentication", async () => {
    let invocation = 0;
    const handler = createDemoDestinationHandler({
      counter: { increment: async () => ++invocation },
      getExpectedToken: async () => "destination-token",
      now: () => new Date("2026-09-11T12:00:00.000Z")
    });
    const event = {
      headers: {
        authorization: "Bearer invalid-token",
        "x-integrationhub-correlation-id": "correlation_credentials"
      },
      body: JSON.stringify({ orderId: "ORD-CREDENTIALS", demoScenario: "credential-failure" })
    };

    const rejected = await handler(apiEvent("POST", event));
    const accepted = await handler(
      apiEvent("POST", {
        ...event,
        headers: { ...event.headers, authorization: "Bearer destination-token" }
      })
    );

    assert.equal(rejected.statusCode, 401);
    assert.equal(accepted.statusCode, 202);
    assert.equal(invocation, 0);
  });

  it("verifies the fictional destination without creating a delivery invocation", async () => {
    let invocation = 0;
    const handler = createDemoDestinationHandler({
      counter: { increment: async () => ++invocation },
      getExpectedToken: async () => "destination-token",
      now: () => new Date("2026-09-11T12:00:00.000Z")
    });

    const response = await handler(
      apiEvent("GET", {
        path: "/demo/fulfillment/verify",
        headers: { authorization: "Bearer destination-token" }
      })
    );

    assert.equal(response.statusCode, 200);
    assert.equal(JSON.parse(response.body ?? "{}").status, "connected");
    assert.equal(invocation, 0);
  });

  it("reports AWS health without reading credentials or creating a delivery", async () => {
    let secretReads = 0;
    let invocation = 0;
    const handler = createDemoDestinationHandler({
      counter: { increment: async () => ++invocation },
      getExpectedToken: async () => {
        secretReads += 1;
        return "destination-token";
      },
      now: () => new Date("2026-09-11T12:00:00.000Z")
    });

    const response = await handler(apiEvent("GET", { path: "/health" }));

    assert.equal(response.statusCode, 200);
    assert.deepEqual(JSON.parse(response.body ?? "{}"), {
      status: "ok",
      service: "integrationhub-aws"
    });
    assert.equal(secretReads, 0);
    assert.equal(invocation, 0);
  });
});
