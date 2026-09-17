import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from "aws-lambda";
import { z } from "zod";
import { DomainError } from "../../domain/errors.ts";
import { ingestWebhook, type IngestDependencies } from "../../domain/ingest-webhook.ts";

const WebhookBody = z
  .object({
    id: z.string().trim().min(1).max(200),
    type: z.string().trim().min(1).max(100),
    data: z.unknown()
  })
  .strict();

function json(statusCode: number, body: unknown): APIGatewayProxyStructuredResultV2 {
  return {
    statusCode,
    headers: { "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify(body)
  };
}

function parseBody(event: APIGatewayProxyEventV2): unknown {
  if (!event.body) throw new DomainError("INVALID_EVENT", "A JSON body is required.");
  const raw = event.isBase64Encoded ? Buffer.from(event.body, "base64").toString("utf8") : event.body;
  if (Buffer.byteLength(raw, "utf8") > 256 * 1024) {
    throw new DomainError("INVALID_EVENT", "Webhook body exceeds 256 KiB.");
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw new DomainError("INVALID_EVENT", "Webhook body must be valid JSON.");
  }
}

export function createWebhookHandler(dependencies: IngestDependencies) {
  return async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyStructuredResultV2> => {
    try {
      const token = event.pathParameters?.token?.trim();
      if (!token || token.length > 200) {
        return json(404, { error: { code: "WORKFLOW_NOT_FOUND", message: "Webhook not found." } });
      }
      const parsed = WebhookBody.safeParse(parseBody(event));
      if (!parsed.success) {
        return json(400, {
          error: { code: "INVALID_EVENT", message: "Use { id, type, data } with valid string identifiers." }
        });
      }
      const result = await ingestWebhook(
        token,
        { eventId: parsed.data.id, eventType: parsed.data.type, payload: parsed.data.data },
        dependencies
      );
      return json(result.outcome === "ACCEPTED" ? 202 : 200, {
        outcome: result.outcome,
        runId: result.run.id,
        correlationId: result.run.correlationId
      });
    } catch (error) {
      if (error instanceof DomainError) {
        const statusCode = error.code === "WORKFLOW_NOT_FOUND" ? 404 : error.code === "WORKFLOW_INACTIVE" ? 409 : 400;
        return json(statusCode, { error: { code: error.code, message: error.message } });
      }
      console.error("Webhook ingestion failed", { error: error instanceof Error ? error.name : "UnknownError" });
      return json(500, { error: { code: "INTERNAL_ERROR", message: "The event could not be accepted." } });
    }
  };
}
