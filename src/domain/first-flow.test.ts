import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DomainError } from "./errors.ts";
import { dispatchOutbox } from "./dispatch-outbox.ts";
import { ingestWebhook } from "./ingest-webhook.ts";
import { processRun } from "./process-run.ts";
import { retryRun } from "./retry-run.ts";
import {
  activeDemoWorkflow,
  FixedClock,
  InMemoryIntegrationRepository,
  InMemoryQueue,
  SequenceDelivery,
  SequentialIds
} from "../testing/in-memory-adapters.ts";

function setup() {
  const repository = new InMemoryIntegrationRepository();
  repository.addWorkflow(activeDemoWorkflow);
  const queue = new InMemoryQueue();
  const clock = new FixedClock("2026-09-10T18:00:00.000Z");
  const ids = new SequentialIds();
  return { repository, queue, clock, ids };
}

const event = {
  eventId: "evt_order_1042",
  eventType: "order.created",
  payload: { orderId: "ORD-1042", total: 18900, currency: "MXN" }
};

describe("first event-delivery flow", () => {
  it("accepts one event, creates a queued run, and publishes it once", async () => {
    const context = setup();

    const result = await ingestWebhook("wh_demo_orders", event, context);

    assert.equal(result.outcome, "ACCEPTED");
    assert.equal(result.run.status, "QUEUED");
    assert.equal(result.run.organizationId, "org_nebula");
    assert.equal(context.repository.outboxMessages.length, 1);
    assert.deepEqual(context.repository.outboxMessages[0], {
      id: `outbox_${result.run.id}`,
      deliveryId: `outbox_${result.run.id}`,
      runId: result.run.id,
      organizationId: "org_nebula",
      correlationId: result.run.correlationId,
      createdAt: result.run.createdAt
    });
  });

  it("recognizes the same organization, workflow, and event id as a duplicate", async () => {
    const context = setup();
    const first = await ingestWebhook("wh_demo_orders", event, context);
    const duplicate = await ingestWebhook("wh_demo_orders", event, context);

    assert.equal(first.outcome, "ACCEPTED");
    assert.equal(duplicate.outcome, "DUPLICATE");
    assert.equal(duplicate.run.id, first.run.id);
    assert.equal(context.repository.outboxMessages.length, 1);
  });

  it("rejects an inactive workflow before storing or publishing an event", async () => {
    const context = setup();
    context.repository.addWorkflow({ ...activeDemoWorkflow, webhookToken: "paused", status: "PAUSED" });

    await assert.rejects(
      ingestWebhook("paused", event, context),
      (error: unknown) => error instanceof DomainError && error.code === "WORKFLOW_INACTIVE"
    );
    assert.equal(context.repository.outboxMessages.length, 0);
  });

  it("keeps a 503 retryable, then preserves both attempts when retry succeeds", async () => {
    const context = setup();
    const accepted = await ingestWebhook("wh_demo_orders", event, context);
    const delivery = new SequenceDelivery([
      { httpStatus: 503, responseBody: "Fulfillment temporarily unavailable" },
      { httpStatus: 202, responseBody: "Shipment preparation accepted" }
    ]);

    const message = context.repository.outboxMessages[0]!;
    const first = await processRun(message, { ...context, delivery });
    const retry = await processRun(message, { ...context, delivery });

    assert.equal(first.outcome, "PROCESSED");
    assert.equal(first.outcome === "PROCESSED" && first.run.status, "FAILED_RETRYABLE");
    assert.equal(retry.outcome, "PROCESSED");
    assert.equal(retry.outcome === "PROCESSED" && retry.run.status, "SUCCEEDED");
    const attempts = await context.repository.listAttempts("org_nebula", accepted.run.id);
    assert.deepEqual(
      attempts.map(({ number, status, httpStatus }) => ({ number, status, httpStatus })),
      [
        { number: 1, status: "FAILED_RETRYABLE", httpStatus: 503 },
        { number: 2, status: "SUCCEEDED", httpStatus: 202 }
      ]
    );
    assert.equal(delivery.calls[0]?.correlationId, delivery.calls[1]?.correlationId);
  });

  it("does not execute a successfully completed run again", async () => {
    const context = setup();
    const accepted = await ingestWebhook("wh_demo_orders", event, context);
    const delivery = new SequenceDelivery([{ httpStatus: 204 }, { httpStatus: 204 }]);

    const message = context.repository.outboxMessages[0]!;
    await processRun(message, { ...context, delivery });
    const repeatedQueueDelivery = await processRun(message, { ...context, delivery });

    assert.deepEqual(repeatedQueueDelivery, { outcome: "IGNORED" });
    assert.equal(delivery.calls.length, 1);
  });

  it("marks a client error final and refuses blind retries", async () => {
    const context = setup();
    const accepted = await ingestWebhook("wh_demo_orders", event, context);
    const delivery = new SequenceDelivery([{ httpStatus: 401, responseBody: "Invalid token" }]);

    const message = context.repository.outboxMessages[0]!;
    const result = await processRun(message, { ...context, delivery });
    const retry = await processRun(message, { ...context, delivery });

    assert.equal(result.outcome === "PROCESSED" && result.run.status, "FAILED_FINAL");
    assert.deepEqual(retry, { outcome: "IGNORED" });
  });

  it("keeps the durable outbox available when queue publication fails", async () => {
    const context = setup();
    const accepted = await ingestWebhook("wh_demo_orders", event, context);
    const outbox = context.repository.outboxMessages[0]!;
    context.queue.shouldFail = true;

    await assert.rejects(dispatchOutbox(outbox, context.queue), /Queue unavailable/);
    assert.equal(context.repository.outboxMessages.length, 1);
    assert.equal((await context.repository.getRun("org_nebula", accepted.run.id))?.status, "QUEUED");

    const recoveredQueue = new InMemoryQueue();
    await dispatchOutbox(outbox, recoveredQueue);
    assert.deepEqual(recoveredQueue.messages, [
      {
        deliveryId: outbox.id,
        runId: accepted.run.id,
        organizationId: "org_nebula",
        correlationId: accepted.run.correlationId
      }
    ]);
  });

  it("publishes a distinct queue delivery when an operator retries a temporary failure", async () => {
    const context = setup();
    const accepted = await ingestWebhook("wh_demo_orders", event, context);
    const outbox = context.repository.outboxMessages[0]!;
    await processRun(outbox, {
      ...context,
      delivery: new SequenceDelivery([{ httpStatus: 503, responseBody: "Try again" }])
    });

    const retryQueue = new InMemoryQueue();
    const result = await retryRun("org_nebula", accepted.run.id, context.repository, retryQueue);

    assert.equal(result.outcome, "QUEUED");
    assert.deepEqual(retryQueue.messages, [
      {
        deliveryId: `retry_${accepted.run.id}_2`,
        runId: accepted.run.id,
        organizationId: "org_nebula",
        correlationId: accepted.run.correlationId
      }
    ]);
  });

  it("does not queue a manual retry for a successful run", async () => {
    const context = setup();
    const accepted = await ingestWebhook("wh_demo_orders", event, context);
    const outbox = context.repository.outboxMessages[0]!;
    await processRun(outbox, {
      ...context,
      delivery: new SequenceDelivery([{ httpStatus: 202 }])
    });

    const retryQueue = new InMemoryQueue();
    const result = await retryRun("org_nebula", accepted.run.id, context.repository, retryQueue);

    assert.equal(result.outcome, "NOT_RETRYABLE");
    assert.equal(retryQueue.messages.length, 0);
  });

  it("truncates response details kept for inspection", async () => {
    const context = setup();
    const accepted = await ingestWebhook("wh_demo_orders", event, context);
    const delivery = new SequenceDelivery([{ httpStatus: 500, responseBody: "x".repeat(2_000) }]);

    const result = await processRun(context.repository.outboxMessages[0]!, { ...context, delivery });

    assert.equal(result.outcome === "PROCESSED" && result.attempt.responseSummary?.length, 1_000);
  });
});
