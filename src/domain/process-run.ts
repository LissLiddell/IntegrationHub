import type {
  AttemptStatus,
  DeliveryFailure,
  DeliveryResult,
  Run,
  RunAttempt,
  QueueMessage,
  WebhookEvent
} from "./model.ts";
import type { Clock, HttpDelivery, IdGenerator, IntegrationRepository } from "./ports.ts";

const RESPONSE_SUMMARY_LIMIT = 1_000;

export interface ProcessDependencies {
  repository: IntegrationRepository;
  delivery: HttpDelivery;
  clock: Clock;
  ids: IdGenerator;
}

function isFailure(result: DeliveryResult | DeliveryFailure): result is DeliveryFailure {
  return "code" in result;
}

function classifyStatus(result: DeliveryResult | DeliveryFailure): AttemptStatus {
  if (isFailure(result)) return result.retryable ? "FAILED_RETRYABLE" : "FAILED_FINAL";
  if (result.httpStatus >= 200 && result.httpStatus < 300) return "SUCCEEDED";
  if (result.httpStatus === 408 || result.httpStatus === 429 || result.httpStatus >= 500) {
    return "FAILED_RETRYABLE";
  }
  return "FAILED_FINAL";
}

function summarize(body: string | undefined): string | undefined {
  if (!body) return undefined;
  return body.replace(/[\r\n\t]+/g, " ").slice(0, RESPONSE_SUMMARY_LIMIT);
}

export async function processRun(
  message: QueueMessage,
  dependencies: ProcessDependencies
): Promise<{ outcome: "PROCESSED"; run: Run; attempt: RunAttempt } | { outcome: "IGNORED" }> {
  const attemptId = dependencies.ids.next("attempt");
  const startedAt = dependencies.clock.now();
  const claim = await dependencies.repository.claimRun(
    message.organizationId,
    message.runId,
    attemptId,
    startedAt.toISOString()
  );
  if (!claim) return { outcome: "IGNORED" };

  const event: WebhookEvent = {
    eventId: claim.run.eventId,
    eventType: claim.run.eventType,
    payload: claim.run.payload
  };
  const result = await dependencies.delivery.deliver({
    organizationId: claim.run.organizationId,
    connectionId: claim.run.connectionId,
    correlationId: claim.run.correlationId,
    event
  });
  const finishedAt = dependencies.clock.now();
  const status = classifyStatus(result);
  const responseSummary = summarize(isFailure(result) ? result.message : result.responseBody);
  const deliveryDetails = isFailure(result)
    ? { failureCode: result.code, ...(responseSummary ? { responseSummary } : {}) }
    : { httpStatus: result.httpStatus, ...(responseSummary ? { responseSummary } : {}) };
  const attempt: RunAttempt = {
    id: attemptId,
    runId: claim.run.id,
    number: claim.attemptNumber,
    status,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: Math.max(0, finishedAt.getTime() - startedAt.getTime()),
    ...deliveryDetails
  };
  const updatedRun: Run = {
    ...claim.run,
    status,
    attemptCount: claim.attemptNumber,
    updatedAt: finishedAt.toISOString()
  };

  await dependencies.repository.completeAttempt(claim.run.id, attempt, updatedRun);
  return { outcome: "PROCESSED", run: updatedRun, attempt };
}
