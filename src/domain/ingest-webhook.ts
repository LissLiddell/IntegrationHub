import { DomainError } from "./errors.ts";
import type { OutboxMessage, Run, WebhookEvent, Workflow } from "./model.ts";
import type { Clock, IdGenerator, IntegrationRepository } from "./ports.ts";

const EVENT_ID_LIMIT = 200;
const EVENT_TYPE_LIMIT = 100;

export interface IngestDependencies {
  repository: IntegrationRepository;
  clock: Clock;
  ids: IdGenerator;
}

export type IngestResult =
  | { outcome: "ACCEPTED"; run: Run }
  | { outcome: "DUPLICATE"; run: Run };

function normalizeEvent(event: WebhookEvent): WebhookEvent {
  const eventId = event.eventId.trim();
  const eventType = event.eventType.trim();

  if (!eventId || eventId.length > EVENT_ID_LIMIT) {
    throw new DomainError("INVALID_EVENT", "eventId is required and must be at most 200 characters.");
  }
  if (!eventType || eventType.length > EVENT_TYPE_LIMIT) {
    throw new DomainError("INVALID_EVENT", "eventType is required and must be at most 100 characters.");
  }

  return { ...event, eventId, eventType };
}

async function storeWorkflowEvent(
  workflow: Workflow,
  event: WebhookEvent,
  dependencies: IngestDependencies
): Promise<IngestResult> {
  if (workflow.status !== "ACTIVE") {
    throw new DomainError("WORKFLOW_INACTIVE", "The workflow is not accepting events.");
  }

  const now = dependencies.clock.now().toISOString();
  const run: Run = {
    id: dependencies.ids.next("run"),
    organizationId: workflow.organizationId,
    workflowId: workflow.id,
    connectionId: workflow.connectionId,
    eventId: event.eventId,
    eventType: event.eventType,
    payload: event.payload,
    correlationId: dependencies.ids.next("correlation"),
    status: "QUEUED",
    attemptCount: 0,
    createdAt: now,
    updatedAt: now
  };

  const outboxId = `outbox_${run.id}`;
  const outbox: OutboxMessage = {
    id: outboxId,
    deliveryId: outboxId,
    runId: run.id,
    organizationId: run.organizationId,
    correlationId: run.correlationId,
    createdAt: now
  };
  const stored = await dependencies.repository.createRunWithOutboxIfAbsent(run, outbox);
  if (!stored.created) {
    return { outcome: "DUPLICATE", run: stored.run };
  }

  return { outcome: "ACCEPTED", run: stored.run };
}

export async function ingestWorkflowEvent(
  workflow: Workflow,
  incomingEvent: WebhookEvent,
  dependencies: IngestDependencies
): Promise<IngestResult> {
  const event = normalizeEvent(incomingEvent);
  return storeWorkflowEvent(workflow, event, dependencies);
}

export async function ingestWebhook(
  webhookToken: string,
  incomingEvent: WebhookEvent,
  dependencies: IngestDependencies
): Promise<IngestResult> {
  const event = normalizeEvent(incomingEvent);
  const workflow = await dependencies.repository.findWorkflowByWebhookToken(webhookToken);

  if (!workflow) {
    throw new DomainError("WORKFLOW_NOT_FOUND", "The webhook endpoint does not exist.");
  }
  return storeWorkflowEvent(workflow, event, dependencies);
}
