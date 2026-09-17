import type { Run } from "./model.ts";
import type { IntegrationRepository, RunQueue } from "./ports.ts";

export type RetryRunResult =
  | { outcome: "QUEUED"; run: Run }
  | { outcome: "NOT_FOUND" }
  | { outcome: "NOT_RETRYABLE"; run: Run };

export async function retryRun(
  organizationId: string,
  runId: string,
  repository: IntegrationRepository,
  queue: RunQueue
): Promise<RetryRunResult> {
  const run = await repository.getRun(organizationId, runId);
  if (!run) return { outcome: "NOT_FOUND" };
  if (run.status !== "FAILED_RETRYABLE") return { outcome: "NOT_RETRYABLE", run };

  await queue.publish({
    deliveryId: `retry_${run.id}_${run.attemptCount + 1}`,
    runId: run.id,
    organizationId: run.organizationId,
    correlationId: run.correlationId
  });
  return { outcome: "QUEUED", run };
}
