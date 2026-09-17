import { SendMessageCommand, type SQSClient } from "@aws-sdk/client-sqs";
import type { QueueMessage } from "../domain/model.ts";
import type { RunQueue } from "../domain/ports.ts";

type QueueClient = Pick<SQSClient, "send">;

export class SqsRunQueue implements RunQueue {
  constructor(
    private readonly client: QueueClient,
    private readonly queueUrl: string
  ) {}

  async publish(message: QueueMessage): Promise<void> {
    await this.client.send(
      new SendMessageCommand({
        QueueUrl: this.queueUrl,
        MessageBody: JSON.stringify(message),
        MessageGroupId: message.organizationId,
        MessageDeduplicationId: message.deliveryId
      })
    );
  }
}
