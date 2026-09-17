import type { OutboxMessage } from "./model.ts";
import type { RunQueue } from "./ports.ts";

export async function dispatchOutbox(outbox: OutboxMessage, queue: RunQueue): Promise<void> {
  await queue.publish({
    deliveryId: outbox.deliveryId,
    runId: outbox.runId,
    organizationId: outbox.organizationId,
    correlationId: outbox.correlationId
  });
}
