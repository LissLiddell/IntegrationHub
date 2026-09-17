import type { AttributeValue } from "@aws-sdk/client-dynamodb";
import { unmarshall } from "@aws-sdk/util-dynamodb";
import type { DynamoDBBatchResponse, DynamoDBStreamEvent, DynamoDBRecord } from "aws-lambda";
import { dispatchOutbox } from "../../domain/dispatch-outbox.ts";
import type { OutboxMessage } from "../../domain/model.ts";
import type { RunQueue } from "../../domain/ports.ts";

export function outboxFromRecord(record: DynamoDBRecord): OutboxMessage | null {
  if (record.eventName !== "INSERT" || !record.dynamodb?.NewImage) return null;
  const item = unmarshall(record.dynamodb.NewImage as Record<string, AttributeValue>);
  if (item.entityType !== "OUTBOX") return null;
  if (
    typeof item.id !== "string" ||
    typeof item.runId !== "string" ||
    typeof item.organizationId !== "string" ||
    typeof item.correlationId !== "string" ||
    typeof item.createdAt !== "string"
  ) {
    throw new Error("Outbox stream record is invalid.");
  }
  return {
    id: item.id,
    deliveryId: typeof item.deliveryId === "string" ? item.deliveryId : item.id,
    runId: item.runId,
    organizationId: item.organizationId,
    correlationId: item.correlationId,
    createdAt: item.createdAt
  };
}

export function createOutboxDispatcher(queue: RunQueue) {
  return async (event: DynamoDBStreamEvent): Promise<DynamoDBBatchResponse> => {
    const batchItemFailures: DynamoDBBatchResponse["batchItemFailures"] = [];
    for (const [index, record] of event.Records.entries()) {
      try {
        const outbox = outboxFromRecord(record);
        if (outbox) await dispatchOutbox(outbox, queue);
      } catch (error) {
        console.error("Outbox dispatch failed", {
          eventId: record.eventID,
          error: error instanceof Error ? error.name : "UnknownError"
        });
        batchItemFailures.push({ itemIdentifier: record.eventID ?? `record-${index}` });
      }
    }
    return { batchItemFailures };
  };
}
