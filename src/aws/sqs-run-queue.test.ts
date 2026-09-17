import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SendMessageCommand, type SQSClient } from "@aws-sdk/client-sqs";
import { SqsRunQueue } from "./sqs-run-queue.ts";

describe("SQS run queue", () => {
  it("uses the organization as the FIFO group and delivery id for deduplication", async () => {
    let captured: unknown;
    const client = {
      send: async (command: unknown) => {
        captured = command;
        return {};
      }
    };
    const queue = new SqsRunQueue(client as unknown as SQSClient, "https://sqs.us-east-1.amazonaws.com/123/delivery.fifo");

    await queue.publish({
      deliveryId: "retry_run_001_2",
      runId: "run_001",
      organizationId: "org_nebula",
      correlationId: "correlation_001"
    });

    assert.ok(captured instanceof SendMessageCommand);
    assert.equal(captured.input.MessageGroupId, "org_nebula");
    assert.equal(captured.input.MessageDeduplicationId, "retry_run_001_2");
  });
});
