import { timingSafeEqual } from "node:crypto";
import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from "aws-lambda";
import { retryRun } from "../../domain/retry-run.ts";
import type { OperatorRole, OperationsActor } from "../../domain/model.ts";
import type {
  ConnectionCredentialStore,
  IntegrationRepository,
  RunQueue
} from "../../domain/ports.ts";
import { sha256 } from "../dynamo-keys.ts";

export interface ControlApiDependencies {
  repository: IntegrationRepository;
  queue: RunQueue;
  credentialStore: ConnectionCredentialStore;
  organizationId: string;
  actorId: string;
  accessKeySha256: string;
  now?: () => Date;
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

function authorized(event: APIGatewayProxyEventV2, expectedHash: string): boolean {
  const key = event.headers["x-integrationhub-demo-key"]?.trim();
  if (!key) return false;
  const received = Buffer.from(sha256(key), "hex");
  const expected = Buffer.from(expectedHash, "hex");
  return received.length === expected.length && timingSafeEqual(received, expected);
}

function limitFrom(event: APIGatewayProxyEventV2): number {
  const parsed = Number(event.queryStringParameters?.limit ?? "25");
  return Number.isInteger(parsed) ? Math.min(Math.max(parsed, 1), 50) : 25;
}

function isOperatorRole(value: unknown): value is OperatorRole {
  return value === "operator" || value === "admin" || value === "auditor";
}

function routeEndsWith(event: APIGatewayProxyEventV2, suffix: string): boolean {
  return event.routeKey.endsWith(suffix) || event.rawPath.endsWith(suffix);
}

function parseBody(event: APIGatewayProxyEventV2): Record<string, unknown> | null {
  if (!event.body) return {};
  try {
    const parsed: unknown = JSON.parse(event.body);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

async function actorFor(
  event: APIGatewayProxyEventV2,
  dependencies: ControlApiDependencies
): Promise<OperationsActor | null> {
  const role = event.headers["x-integrationhub-role"]?.trim();
  if (!isOperatorRole(role)) return null;
  const assignment = await dependencies.repository.getRoleAssignment(
    dependencies.organizationId,
    dependencies.actorId
  );
  if (!assignment?.roles.includes(role)) return null;
  return { id: assignment.actorId, displayName: assignment.displayName, role };
}

function roleForbidden() {
  return json(403, {
    error: {
      code: "ROLE_FORBIDDEN",
      message: "The selected role is not assigned to this operator or cannot perform this action."
    }
  });
}

export function createControlApiHandler(dependencies: ControlApiDependencies) {
  const now = dependencies.now ?? (() => new Date());
  return async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyStructuredResultV2> => {
    if (!authorized(event, dependencies.accessKeySha256)) {
      return json(401, { error: { code: "UNAUTHORIZED", message: "Demo access key is invalid." } });
    }

    try {
      const method = event.requestContext.http.method;
      const runId = event.pathParameters?.runId?.trim();
      const connectionId = event.pathParameters?.connectionId?.trim();

      if (method === "GET" && routeEndsWith(event, "/roles")) {
        const assignment = await dependencies.repository.getRoleAssignment(
          dependencies.organizationId,
          dependencies.actorId
        );
        if (!assignment) {
          return json(404, {
            error: { code: "ROLE_ASSIGNMENT_NOT_FOUND", message: "Demo role assignment was not found." }
          });
        }
        return json(200, { assignment });
      }

      if (method === "GET" && !runId) {
        const runs = await dependencies.repository.listRuns(dependencies.organizationId, limitFrom(event));
        return json(200, { organizationId: dependencies.organizationId, runs });
      }

      if (method === "GET" && runId) {
        const run = await dependencies.repository.getRun(dependencies.organizationId, runId);
        if (!run) return json(404, { error: { code: "RUN_NOT_FOUND", message: "Run was not found." } });
        const [attempts, operations] = await Promise.all([
          dependencies.repository.listAttempts(dependencies.organizationId, runId),
          dependencies.repository.getRunOperations(dependencies.organizationId, runId)
        ]);
        return json(200, { run, attempts, operations });
      }

      if (method === "POST" && runId && routeEndsWith(event, "/close")) {
        const actor = await actorFor(event, dependencies);
        if (!actor || actor.role === "auditor") return roleForbidden();
        const body = parseBody(event);
        const reason = body?.reason;
        const note = body?.note;
        if (
          !body ||
          typeof reason !== "string" ||
          !reason.trim() ||
          reason.trim().length > 120 ||
          (note !== undefined && (typeof note !== "string" || note.trim().length > 1_000)) ||
          (reason.trim() === "Otro motivo" && (typeof note !== "string" || !note.trim()))
        ) {
          return json(400, {
            error: { code: "INVALID_CASE_CLOSURE", message: "A valid closure reason and note are required." }
          });
        }
        const result = await dependencies.repository.closeCase({
          organizationId: dependencies.organizationId,
          runId,
          reason: reason.trim(),
          ...(typeof note === "string" && note.trim() ? { note: note.trim() } : {}),
          actor,
          closedAt: now().toISOString()
        });
        if (result.outcome === "NOT_FOUND") {
          return json(404, { error: { code: "RUN_NOT_FOUND", message: "Run was not found." } });
        }
        if (result.outcome !== "CLOSED") {
          return json(409, {
            error: {
              code: result.outcome,
              message:
                result.outcome === "ALREADY_CLOSED"
                  ? "The case was already closed."
                  : "Only a failed delivery can be closed."
            }
          });
        }
        return json(200, { outcome: "CLOSED", closure: result.closure });
      }

      if (method === "POST" && connectionId && routeEndsWith(event, "/remediate")) {
        const actor = await actorFor(event, dependencies);
        if (!actor || actor.role !== "admin") return roleForbidden();
        const body = parseBody(event);
        const bodyRunId = body?.runId;
        const credential = body?.credential;
        if (
          !body ||
          typeof bodyRunId !== "string" ||
          !bodyRunId.trim() ||
          typeof credential !== "string" ||
          credential.trim().length < 8 ||
          credential.trim().length > 4_096
        ) {
          return json(400, {
            error: {
              code: "INVALID_CONNECTION_REMEDIATION",
              message: "A run id and a credential between 8 and 4096 characters are required."
            }
          });
        }
        const run = await dependencies.repository.getRun(dependencies.organizationId, bodyRunId.trim());
        if (!run || run.connectionId !== connectionId) {
          return json(404, { error: { code: "RUN_NOT_FOUND", message: "Run or connection was not found." } });
        }
        const operations = await dependencies.repository.getRunOperations(dependencies.organizationId, run.id);
        if (operations.closure) {
          return json(409, { error: { code: "CASE_CLOSED", message: "The case is already closed." } });
        }
        if (run.status !== "FAILED_FINAL") {
          return json(409, {
            error: { code: "STATUS_NOT_ELIGIBLE", message: "This run does not require connection remediation." }
          });
        }

        const verification = await dependencies.credentialStore.replaceCredentialAndVerify(
          dependencies.organizationId,
          connectionId,
          credential.trim()
        );
        if (!verification.verified) {
          const unsafe = verification.code === "UNSAFE_DESTINATION";
          const rollbackFailed = verification.code === "ROLLBACK_FAILED";
          return json(rollbackFailed ? 500 : unsafe ? 400 : 422, {
            error: {
              code: `CONNECTION_VERIFICATION_${verification.code}`,
              message: rollbackFailed
                ? "The new credential was rejected and the previous credential could not be restored."
                : unsafe
                  ? "The configured verification destination is not allowed."
                  : verification.code === "REJECTED"
                    ? "The provider rejected the new credential. The previous credential remains active."
                    : "The provider could not be reached for verification. The previous credential remains active."
            }
          });
        }
        const result = await dependencies.repository.remediateConnection({
          organizationId: dependencies.organizationId,
          runId: run.id,
          connectionId,
          actor,
          remediatedAt: now().toISOString()
        });
        if (result !== "REMEDIATED") {
          return json(result === "NOT_FOUND" ? 404 : 409, {
            error: { code: result, message: "Connection remediation could not be completed." }
          });
        }
        return json(200, { outcome: "REMEDIATED", runId: run.id, connectionId });
      }

      if (method === "POST" && runId && routeEndsWith(event, "/retry")) {
        const actor = await actorFor(event, dependencies);
        if (!actor || actor.role === "auditor") return roleForbidden();
        const operations = await dependencies.repository.getRunOperations(dependencies.organizationId, runId);
        if (operations.closure) {
          return json(409, {
            error: { code: "CASE_CLOSED", message: "The case is closed and cannot be retried." }
          });
        }
        const result = await retryRun(dependencies.organizationId, runId, dependencies.repository, dependencies.queue);
        if (result.outcome === "NOT_FOUND") {
          return json(404, { error: { code: "RUN_NOT_FOUND", message: "Run was not found." } });
        }
        if (result.outcome === "NOT_RETRYABLE") {
          return json(409, {
            error: {
              code: "RUN_NOT_RETRYABLE",
              message: `Run with status ${result.run.status} cannot be retried.`
            }
          });
        }
        return json(202, { outcome: "QUEUED", runId: result.run.id, nextAttempt: result.run.attemptCount + 1 });
      }

      return json(404, { error: { code: "NOT_FOUND", message: "The requested operation was not found." } });
    } catch (error) {
      console.error("Control API failed", { error: error instanceof Error ? error.name : "UnknownError" });
      return json(500, { error: { code: "INTERNAL_ERROR", message: "The operation could not be completed." } });
    }
  };
}
