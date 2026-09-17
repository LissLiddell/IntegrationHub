import type { SQSBatchResponse, SQSEvent } from "aws-lambda";
import { z } from "zod";
import { processRun, type ProcessDependencies } from "../../domain/process-run.ts";

const QueueMessageSchema = z
  .object({
    deliveryId: z.string().min(1),
    runId: z.string().min(1),
    organizationId: z.string().min(1),
    correlationId: z.string().min(1)
  })
  .strict();

export function createDeliveryWorker(dependencies: ProcessDependencies) {
  return async (event: SQSEvent): Promise<SQSBatchResponse> => {
    const batchItemFailures: SQSBatchResponse["batchItemFailures"] = [];
    for (const record of event.Records) {
      try {
        const message = QueueMessageSchema.parse(JSON.parse(record.body));
        await processRun(message, dependencies);
      } catch (error) {
        console.error("Delivery worker failed", {
          messageId: record.messageId,
          error: error instanceof Error ? error.name : "UnknownError"
        });
        batchItemFailures.push({ itemIdentifier: record.messageId });
      }
    }
    return { batchItemFailures };
  };
}
