import { UpdateCommand, type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";

type DocumentClient = Pick<DynamoDBDocumentClient, "send">;

export interface DemoRunLimiter {
  consume(occurredAt: string, limit: number): Promise<{ allowed: boolean; remaining: number }>;
}

function isConditionalFailure(error: unknown): boolean {
  return error instanceof Error && error.name === "ConditionalCheckFailedException";
}

export class DynamoDemoRunLimiter implements DemoRunLimiter {
  constructor(
    private readonly client: DocumentClient,
    private readonly tableName: string
  ) {}

  async consume(occurredAt: string, limit: number): Promise<{ allowed: boolean; remaining: number }> {
    const current = new Date(occurredAt);
    const day = current.toISOString().slice(0, 10);
    const expiresAt = Math.floor(current.getTime() / 1_000) + 2 * 24 * 60 * 60;

    try {
      const response = await this.client.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: { PK: "DEMO#RUN_GENERATOR", SK: `DAY#${day}` },
          UpdateExpression:
            "SET entityType = if_not_exists(entityType, :entityType), updatedAt = :now, expiresAt = :expiresAt ADD requestCount :one",
          ConditionExpression: "attribute_not_exists(requestCount) OR requestCount < :limit",
          ExpressionAttributeValues: {
            ":entityType": "DEMO_RUN_LIMIT",
            ":now": occurredAt,
            ":expiresAt": expiresAt,
            ":one": 1,
            ":limit": limit
          },
          ReturnValues: "UPDATED_NEW"
        })
      );
      const count = response.Attributes?.requestCount;
      if (typeof count !== "number") throw new Error("Demo run limiter did not return a count.");
      return { allowed: true, remaining: Math.max(limit - count, 0) };
    } catch (error) {
      if (isConditionalFailure(error)) return { allowed: false, remaining: 0 };
      throw error;
    }
  }
}
