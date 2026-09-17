import { timingSafeEqual } from "node:crypto";
import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from "aws-lambda";
import type { DemoInvocationCounter } from "../dynamo-demo-counter.ts";

export interface DemoDestinationDependencies {
  counter: DemoInvocationCounter;
  getExpectedToken(): Promise<string>;
  now(): Date;
}

function json(statusCode: number, body: unknown): APIGatewayProxyStructuredResultV2 {
  return {
    statusCode,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store"
    },
    body: JSON.stringify(body)
  };
}

function authorized(header: string | undefined, expectedToken: string): boolean {
  const prefix = "Bearer ";
  if (!header?.startsWith(prefix)) return false;
  const received = Buffer.from(header.slice(prefix.length), "utf8");
  const expected = Buffer.from(expectedToken, "utf8");
  return received.length === expected.length && timingSafeEqual(received, expected);
}

export function createDemoDestinationHandler(dependencies: DemoDestinationDependencies) {
  return async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyStructuredResultV2> => {
    try {
      const expectedToken = await dependencies.getExpectedToken();
      if (!authorized(event.headers.authorization, expectedToken)) {
        return json(401, { error: { code: "UNAUTHORIZED", message: "Destination credential is invalid." } });
      }

      if (
        event.requestContext.http.method === "GET" &&
        event.rawPath.endsWith("/demo/fulfillment/verify")
      ) {
        return json(200, {
          status: "connected",
          message: "Credential accepted. No shipment was created."
        });
      }

      const correlationId = event.headers["x-integrationhub-correlation-id"]?.trim();
      if (!correlationId || correlationId.length > 128) {
        return json(400, { error: { code: "INVALID_CORRELATION", message: "A correlation id is required." } });
      }
      if (!event.body) {
        return json(400, { error: { code: "INVALID_PAYLOAD", message: "A JSON payload is required." } });
      }
      const rawBody = event.isBase64Encoded ? Buffer.from(event.body, "base64").toString("utf8") : event.body;
      try {
        JSON.parse(rawBody);
      } catch {
        return json(400, { error: { code: "INVALID_PAYLOAD", message: "Payload must be valid JSON." } });
      }

      const invocation = await dependencies.counter.increment(correlationId, dependencies.now().toISOString());
      if (invocation === 1) {
        return {
          ...json(503, {
            status: "temporarily_unavailable",
            message: "Fulfillment is warming up. Retry this delivery."
          }),
          headers: {
            "content-type": "application/json; charset=utf-8",
            "cache-control": "no-store",
            "retry-after": "1"
          }
        };
      }
      return json(202, {
        status: "accepted",
        message: "Shipment preparation accepted.",
        receipt: `FUL-${correlationId.slice(-8).toUpperCase()}`
      });
    } catch (error) {
      console.error("Demo destination failed", { error: error instanceof Error ? error.name : "UnknownError" });
      return json(500, { error: { code: "INTERNAL_ERROR", message: "Destination could not process the event." } });
    }
  };
}
