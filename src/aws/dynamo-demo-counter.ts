import { UpdateCommand, type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { sha256 } from "./dynamo-keys.ts";

type DocumentClient = Pick<DynamoDBDocumentClient, "send">;

export interface DemoInvocationCounter {
  increment(correlationId: string, occurredAt: string): Promise<number>;
}

export class DynamoDemoInvocationCounter implements DemoInvocationCounter {
  constructor(
    private readonly client: DocumentClient,
    private readonly tableName: string
  ) {}

  async increment(correlationId: string, occurredAt: string): Promise<number> {
    const response = await this.client.send(
      new UpdateCommand({
        TableName: this.tableName,
        Key: {
          PK: "DEMO#DESTINATION#NEBULA_FULFILLMENT",
          SK: `CORRELATION#${sha256(correlationId)}`
        },
        UpdateExpression:
          "SET entityType = if_not_exists(entityType, :entityType), firstSeenAt = if_not_exists(firstSeenAt, :now), updatedAt = :now ADD invocationCount :one",
        ExpressionAttributeValues: {
          ":entityType": "DEMO_DESTINATION_INVOCATION",
          ":now": occurredAt,
          ":one": 1
        },
        ReturnValues: "UPDATED_NEW"
      })
    );
    const count = response.Attributes?.invocationCount;
    if (typeof count !== "number") throw new Error("Demo invocation counter did not return a count.");
    return count;
  }
}
