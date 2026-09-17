import { ingestWebhook } from "../src/domain/ingest-webhook.ts";
import { dispatchOutbox } from "../src/domain/dispatch-outbox.ts";
import { processRun } from "../src/domain/process-run.ts";
import {
  activeDemoWorkflow,
  FixedClock,
  InMemoryIntegrationRepository,
  InMemoryQueue,
  SequenceDelivery,
  SequentialIds
} from "../src/testing/in-memory-adapters.ts";

const repository = new InMemoryIntegrationRepository();
repository.addWorkflow(activeDemoWorkflow);
const queue = new InMemoryQueue();
const clock = new FixedClock("2026-09-10T18:00:00.000Z");
const ids = new SequentialIds();
const event = {
  eventId: "evt_order_1042",
  eventType: "order.created",
  payload: { orderId: "ORD-1042", total: 18900, currency: "MXN" }
};

const accepted = await ingestWebhook("wh_demo_orders", event, { repository, clock, ids });
const outbox = repository.outboxMessages[0]!;
await dispatchOutbox(outbox, queue);
const delivery = new SequenceDelivery([
  { httpStatus: 503, responseBody: "Fulfillment temporarily unavailable" },
  { httpStatus: 202, responseBody: "Shipment preparation accepted" }
]);
const failed = await processRun(outbox, { repository, delivery, clock, ids });
const succeeded = await processRun(outbox, { repository, delivery, clock, ids });
const duplicate = await ingestWebhook("wh_demo_orders", event, { repository, clock, ids });

console.log(
  JSON.stringify(
    {
      accepted: accepted.outcome,
      firstDelivery: failed.outcome === "PROCESSED" ? failed.run.status : failed.outcome,
      retry: succeeded.outcome === "PROCESSED" ? succeeded.run.status : succeeded.outcome,
      duplicate: duplicate.outcome,
      publishedMessages: queue.messages.length,
      attempts: await repository.listAttempts("org_nebula", accepted.run.id)
    },
    null,
    2
  )
);
