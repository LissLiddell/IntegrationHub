import {
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
  type DynamoDBDocumentClient
} from "@aws-sdk/lib-dynamodb";
import type {
  CaseActivity,
  CaseClosure,
  ClaimedRun,
  DeliveryFailureCode,
  OperatorRole,
  OutboxMessage,
  RoleAssignment,
  Run,
  RunAttempt,
  RunOperations,
  Workflow
} from "../domain/model.ts";
import type { IntegrationRepository } from "../domain/ports.ts";
import { keys } from "./dynamo-keys.ts";

type DocumentClient = Pick<DynamoDBDocumentClient, "send">;
type Item = Record<string, unknown>;

function text(item: Item, name: string): string {
  const value = item[name];
  if (typeof value !== "string") throw new Error(`DynamoDB item is missing string ${name}.`);
  return value;
}

function integer(item: Item, name: string): number {
  const value = item[name];
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new Error(`DynamoDB item is missing integer ${name}.`);
  }
  return value;
}

function isOperatorRole(value: unknown): value is OperatorRole {
  return value === "operator" || value === "admin" || value === "auditor";
}

function toRoleAssignment(item: Item): RoleAssignment {
  const roles = item.roles;
  if (!Array.isArray(roles) || !roles.length || !roles.every(isOperatorRole)) {
    throw new Error("DynamoDB role assignment has invalid roles.");
  }
  return {
    actorId: text(item, "actorId"),
    organizationId: text(item, "organizationId"),
    displayName: text(item, "displayName"),
    roles,
    updatedAt: text(item, "updatedAt")
  };
}

function toCaseClosure(item: Item): CaseClosure {
  const closedByRole = item.closedByRole;
  if (!isOperatorRole(closedByRole)) throw new Error("DynamoDB case closure has an invalid role.");
  return {
    runId: text(item, "runId"),
    reason: text(item, "reason"),
    ...(typeof item.note === "string" ? { note: item.note } : {}),
    closedAt: text(item, "closedAt"),
    closedBy: text(item, "closedBy"),
    closedByActorId: text(item, "closedByActorId"),
    closedByRole
  };
}

function toCaseActivity(item: Item): CaseActivity {
  const actorRole = item.actorRole;
  if (!isOperatorRole(actorRole)) throw new Error("DynamoDB case activity has an invalid role.");
  return {
    id: text(item, "id"),
    runId: text(item, "runId"),
    title: text(item, "title"),
    detail: text(item, "detail"),
    createdAt: text(item, "createdAt"),
    actor: text(item, "actor"),
    actorId: text(item, "actorId"),
    actorRole
  };
}

function toWorkflow(item: Item): Workflow {
  const status = text(item, "status");
  if (status !== "DRAFT" && status !== "ACTIVE" && status !== "PAUSED") {
    throw new Error("DynamoDB workflow has an invalid status.");
  }
  return {
    id: text(item, "id"),
    organizationId: text(item, "organizationId"),
    name: text(item, "name"),
    webhookToken: "[masked]",
    connectionId: text(item, "connectionId"),
    status
  };
}

function toRun(item: Item): Run {
  const status = text(item, "status");
  if (
    status !== "QUEUED" &&
    status !== "RUNNING" &&
    status !== "SUCCEEDED" &&
    status !== "FAILED_RETRYABLE" &&
    status !== "FAILED_FINAL"
  ) {
    throw new Error("DynamoDB run has an invalid status.");
  }
  return {
    id: text(item, "id"),
    organizationId: text(item, "organizationId"),
    workflowId: text(item, "workflowId"),
    connectionId: text(item, "connectionId"),
    eventId: text(item, "eventId"),
    eventType: text(item, "eventType"),
    payload: item.payload,
    correlationId: text(item, "correlationId"),
    status,
    attemptCount: integer(item, "attemptCount"),
    createdAt: text(item, "createdAt"),
    updatedAt: text(item, "updatedAt"),
    ...(item.caseStatus === "OPEN" || item.caseStatus === "CLOSED" ? { caseStatus: item.caseStatus } : {}),
    ...(typeof item.connectionRemediated === "boolean"
      ? { connectionRemediated: item.connectionRemediated }
      : {})
  };
}

function isConditionalFailure(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === "ConditionalCheckFailedException" || error.name === "TransactionCanceledException")
  );
}

function isDeliveryFailureCode(value: unknown): value is DeliveryFailureCode {
  return (
    value === "NETWORK_ERROR" ||
    value === "TIMEOUT" ||
    value === "CONNECTION_NOT_FOUND" ||
    value === "UNSAFE_DESTINATION" ||
    value === "SECRET_UNAVAILABLE"
  );
}

export class DynamoIntegrationRepository implements IntegrationRepository {
  constructor(
    private readonly client: DocumentClient,
    private readonly tableName: string
  ) {}

  async findWorkflowByWebhookToken(token: string): Promise<Workflow | null> {
    const response = await this.client.send(
      new QueryCommand({
        TableName: this.tableName,
        IndexName: "GSI1",
        KeyConditionExpression: "GSI1PK = :pk",
        ExpressionAttributeValues: { ":pk": keys.webhookLookup(token) },
        Limit: 1,
        ConsistentRead: false
      })
    );
    const item = response.Items?.[0] as Item | undefined;
    return item ? toWorkflow(item) : null;
  }

  async createRunWithOutboxIfAbsent(
    run: Run,
    outbox: OutboxMessage
  ): Promise<{ created: boolean; run: Run }> {
    const PK = keys.organization(run.organizationId);
    const dedupeKey = { PK, SK: keys.dedupe(run.workflowId, run.eventId) };
    const existing = await this.client.send(
      new GetCommand({ TableName: this.tableName, Key: dedupeKey, ConsistentRead: true })
    );
    if (existing.Item) return { created: false, run: await this.loadExistingRun(run.organizationId, existing.Item) };

    const expiresAt = Math.floor(new Date(outbox.createdAt).getTime() / 1_000) + 7 * 24 * 60 * 60;
    try {
      await this.client.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Put: {
                TableName: this.tableName,
                Item: {
                  ...dedupeKey,
                  entityType: "DEDUPE",
                  organizationId: run.organizationId,
                  workflowId: run.workflowId,
                  eventId: run.eventId,
                  runId: run.id,
                  createdAt: run.createdAt
                },
                ConditionExpression: "attribute_not_exists(PK) AND attribute_not_exists(SK)"
              }
            },
            {
              Put: {
                TableName: this.tableName,
                Item: {
                  PK,
                  SK: keys.run(run.id),
                  entityType: "RUN",
                  GSI2PK: `${PK}#RUNS`,
                  GSI2SK: `${run.createdAt}#${run.id}`,
                  ...run
                },
                ConditionExpression: "attribute_not_exists(PK) AND attribute_not_exists(SK)"
              }
            },
            {
              Put: {
                TableName: this.tableName,
                Item: {
                  PK,
                  SK: keys.outbox(run.id),
                  entityType: "OUTBOX",
                  ...outbox,
                  expiresAt
                },
                ConditionExpression: "attribute_not_exists(PK) AND attribute_not_exists(SK)"
              }
            }
          ]
        })
      );
      return { created: true, run };
    } catch (error) {
      if (!isConditionalFailure(error)) throw error;
      const raced = await this.client.send(
        new GetCommand({ TableName: this.tableName, Key: dedupeKey, ConsistentRead: true })
      );
      if (!raced.Item) throw error;
      return { created: false, run: await this.loadExistingRun(run.organizationId, raced.Item) };
    }
  }

  async claimRun(
    organizationId: string,
    runId: string,
    attemptId: string,
    startedAt: string
  ): Promise<ClaimedRun | null> {
    try {
      const response = await this.client.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: { PK: keys.organization(organizationId), SK: keys.run(runId) },
          UpdateExpression:
            "SET #status = :running, attemptCount = if_not_exists(attemptCount, :zero) + :one, currentAttemptId = :attemptId, updatedAt = :updatedAt",
          ConditionExpression:
            "#status IN (:queued, :retryable) AND (attribute_not_exists(caseStatus) OR caseStatus <> :closed)",
          ExpressionAttributeNames: { "#status": "status" },
          ExpressionAttributeValues: {
            ":running": "RUNNING",
            ":queued": "QUEUED",
            ":retryable": "FAILED_RETRYABLE",
            ":closed": "CLOSED",
            ":zero": 0,
            ":one": 1,
            ":attemptId": attemptId,
            ":updatedAt": startedAt
          },
          ReturnValues: "ALL_NEW"
        })
      );
      const run = toRun(response.Attributes as Item);
      return { run, attemptNumber: run.attemptCount, startedAt };
    } catch (error) {
      if (isConditionalFailure(error)) return null;
      throw error;
    }
  }

  async completeAttempt(runId: string, attempt: RunAttempt, updatedRun: Run): Promise<void> {
    if (runId !== updatedRun.id || runId !== attempt.runId) throw new Error("Attempt and run ids do not match.");
    const PK = keys.organization(updatedRun.organizationId);
    await this.client.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Put: {
              TableName: this.tableName,
              Item: {
                PK,
                SK: keys.attempt(runId, attempt.number),
                entityType: "RUN_ATTEMPT",
                organizationId: updatedRun.organizationId,
                ...attempt
              },
              ConditionExpression: "attribute_not_exists(PK) AND attribute_not_exists(SK)"
            }
          },
          {
            Update: {
              TableName: this.tableName,
              Key: { PK, SK: keys.run(runId) },
              UpdateExpression: "SET #status = :status, updatedAt = :updatedAt REMOVE currentAttemptId",
              ConditionExpression: "#status = :running AND currentAttemptId = :attemptId",
              ExpressionAttributeNames: { "#status": "status" },
              ExpressionAttributeValues: {
                ":status": updatedRun.status,
                ":updatedAt": updatedRun.updatedAt,
                ":running": "RUNNING",
                ":attemptId": attempt.id
              }
            }
          }
        ]
      })
    );
  }

  async getRun(organizationId: string, runId: string): Promise<Run | null> {
    const response = await this.client.send(
      new GetCommand({
        TableName: this.tableName,
        Key: { PK: keys.organization(organizationId), SK: keys.run(runId) },
        ConsistentRead: true
      })
    );
    return response.Item ? toRun(response.Item as Item) : null;
  }

  async listRuns(organizationId: string, limit: number): Promise<Run[]> {
    const response = await this.client.send(
      new QueryCommand({
        TableName: this.tableName,
        IndexName: "GSI2",
        KeyConditionExpression: "GSI2PK = :pk",
        ExpressionAttributeValues: { ":pk": `${keys.organization(organizationId)}#RUNS` },
        ScanIndexForward: false,
        Limit: Math.min(Math.max(limit, 1), 100)
      })
    );
    return (response.Items ?? []).map((item) => toRun(item as Item));
  }

  async listAttempts(organizationId: string, runId: string): Promise<RunAttempt[]> {
    const response = await this.client.send(
      new QueryCommand({
        TableName: this.tableName,
        KeyConditionExpression: "PK = :pk AND begins_with(SK, :prefix)",
        ExpressionAttributeValues: {
          ":pk": keys.organization(organizationId),
          ":prefix": `${keys.run(runId)}#ATTEMPT#`
        },
        ScanIndexForward: true
      })
    );
    return (response.Items ?? []).map((item) => {
      const typed = item as Item;
      const status = text(typed, "status") as RunAttempt["status"];
      return {
        id: text(typed, "id"),
        runId: text(typed, "runId"),
        number: integer(typed, "number"),
        status,
        startedAt: text(typed, "startedAt"),
        finishedAt: text(typed, "finishedAt"),
        durationMs: integer(typed, "durationMs"),
        ...(typeof typed.httpStatus === "number" ? { httpStatus: typed.httpStatus } : {}),
        ...(typeof typed.responseSummary === "string" ? { responseSummary: typed.responseSummary } : {}),
        ...(isDeliveryFailureCode(typed.failureCode) ? { failureCode: typed.failureCode } : {})
      };
    });
  }

  async getRoleAssignment(organizationId: string, actorId: string): Promise<RoleAssignment | null> {
    const response = await this.client.send(
      new GetCommand({
        TableName: this.tableName,
        Key: { PK: keys.organization(organizationId), SK: keys.roleAssignment(actorId) },
        ConsistentRead: true
      })
    );
    return response.Item ? toRoleAssignment(response.Item as Item) : null;
  }

  async getRunOperations(organizationId: string, runId: string): Promise<RunOperations> {
    const PK = keys.organization(organizationId);
    const closureResponse = await this.client.send(
      new GetCommand({
        TableName: this.tableName,
        Key: { PK, SK: keys.caseClosure(runId) },
        ConsistentRead: true
      })
    );
    const remediationResponse = await this.client.send(
      new GetCommand({
        TableName: this.tableName,
        Key: { PK, SK: keys.remediation(runId) },
        ConsistentRead: true
      })
    );
    const activityResponse = await this.client.send(
      new QueryCommand({
        TableName: this.tableName,
        KeyConditionExpression: "PK = :pk AND begins_with(SK, :prefix)",
        ExpressionAttributeValues: {
          ":pk": PK,
          ":prefix": keys.caseActivityPrefix(runId)
        },
        ScanIndexForward: true
      })
    );
    return {
      closure: closureResponse.Item ? toCaseClosure(closureResponse.Item as Item) : null,
      connectionRemediated: Boolean(remediationResponse.Item),
      activities: (activityResponse.Items ?? []).map((item) => toCaseActivity(item as Item))
    };
  }

  async remediateConnection(input: {
    organizationId: string;
    runId: string;
    connectionId: string;
    actor: { id: string; displayName: string; role: OperatorRole };
    remediatedAt: string;
  }): Promise<"REMEDIATED" | "NOT_FOUND" | "CASE_CLOSED" | "STATUS_NOT_ELIGIBLE"> {
    const run = await this.getRun(input.organizationId, input.runId);
    if (!run || run.connectionId !== input.connectionId) return "NOT_FOUND";
    const operations = await this.getRunOperations(input.organizationId, input.runId);
    if (operations.closure) return "CASE_CLOSED";
    if (run.status !== "FAILED_FINAL") return "STATUS_NOT_ELIGIBLE";

    const PK = keys.organization(input.organizationId);
    const activityId = `activity_remediation_${input.runId}_${Date.parse(input.remediatedAt)}`;
    const actor = `${roleLabel(input.actor.role)} · ${input.actor.displayName}`;
    try {
      await this.client.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Update: {
                TableName: this.tableName,
                Key: { PK, SK: keys.run(input.runId) },
                UpdateExpression:
                  "SET #status = :retryable, connectionRemediated = :yes, remediatedAt = :at, updatedAt = :at",
                ConditionExpression:
                  "#status = :failedFinal AND (attribute_not_exists(caseStatus) OR caseStatus <> :closed)",
                ExpressionAttributeNames: { "#status": "status" },
                ExpressionAttributeValues: {
                  ":retryable": "FAILED_RETRYABLE",
                  ":failedFinal": "FAILED_FINAL",
                  ":yes": true,
                  ":at": input.remediatedAt,
                  ":closed": "CLOSED"
                }
              }
            },
            {
              Update: {
                TableName: this.tableName,
                Key: { PK, SK: keys.connection(input.connectionId) },
                UpdateExpression:
                  "SET credentialUpdatedAt = :at, credentialUpdatedBy = :actor, credentialUpdatedByRole = :role, lastVerifiedAt = :at, lastVerifiedBy = :actor, lastVerifiedByRole = :role",
                ConditionExpression: "attribute_exists(PK) AND attribute_exists(SK)",
                ExpressionAttributeValues: {
                  ":at": input.remediatedAt,
                  ":actor": input.actor.displayName,
                  ":role": input.actor.role
                }
              }
            },
            {
              Put: {
                TableName: this.tableName,
                Item: {
                  PK,
                  SK: keys.remediation(input.runId),
                  entityType: "CONNECTION_REMEDIATION",
                  organizationId: input.organizationId,
                  runId: input.runId,
                  connectionId: input.connectionId,
                  remediatedAt: input.remediatedAt,
                  remediatedByActorId: input.actor.id,
                  remediatedBy: input.actor.displayName,
                  remediatedByRole: input.actor.role
                },
                ConditionExpression: "attribute_not_exists(PK) AND attribute_not_exists(SK)"
              }
            },
            {
              Put: {
                TableName: this.tableName,
                Item: {
                  PK,
                  SK: keys.caseActivity(input.runId, input.remediatedAt, activityId),
                  entityType: "CASE_ACTIVITY",
                  id: activityId,
                  runId: input.runId,
                  title: "Conexión corregida y verificada",
                  detail: "La credencial fue reemplazada y aceptada mediante una prueba segura sin ejecutar la operación del pedido.",
                  createdAt: input.remediatedAt,
                  actor,
                  actorId: input.actor.id,
                  actorRole: input.actor.role
                },
                ConditionExpression: "attribute_not_exists(PK) AND attribute_not_exists(SK)"
              }
            }
          ]
        })
      );
      return "REMEDIATED";
    } catch (error) {
      if (!isConditionalFailure(error)) throw error;
      const latestRun = await this.getRun(input.organizationId, input.runId);
      const latestOperations = await this.getRunOperations(input.organizationId, input.runId);
      if (!latestRun) return "NOT_FOUND";
      if (latestOperations.closure) return "CASE_CLOSED";
      return "STATUS_NOT_ELIGIBLE";
    }
  }

  async closeCase(input: {
    organizationId: string;
    runId: string;
    reason: string;
    note?: string;
    actor: { id: string; displayName: string; role: OperatorRole };
    closedAt: string;
  }): Promise<
    | { outcome: "CLOSED"; closure: CaseClosure }
    | { outcome: "NOT_FOUND" | "ALREADY_CLOSED" | "STATUS_NOT_ELIGIBLE" }
  > {
    const run = await this.getRun(input.organizationId, input.runId);
    if (!run) return { outcome: "NOT_FOUND" };
    const operations = await this.getRunOperations(input.organizationId, input.runId);
    if (operations.closure) return { outcome: "ALREADY_CLOSED" };
    if (run.status !== "FAILED_RETRYABLE" && run.status !== "FAILED_FINAL") {
      return { outcome: "STATUS_NOT_ELIGIBLE" };
    }

    const PK = keys.organization(input.organizationId);
    const closedBy = `${roleLabel(input.actor.role)} · ${input.actor.displayName}`;
    const closure: CaseClosure = {
      runId: input.runId,
      reason: input.reason,
      ...(input.note ? { note: input.note } : {}),
      closedAt: input.closedAt,
      closedBy,
      closedByActorId: input.actor.id,
      closedByRole: input.actor.role
    };
    const activityId = `activity_closure_${input.runId}_${Date.parse(input.closedAt)}`;
    try {
      await this.client.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Update: {
                TableName: this.tableName,
                Key: { PK, SK: keys.run(input.runId) },
                UpdateExpression: "SET caseStatus = :closed, updatedAt = :at",
                ConditionExpression:
                  "#status IN (:retryable, :failedFinal) AND (attribute_not_exists(caseStatus) OR caseStatus <> :closed)",
                ExpressionAttributeNames: { "#status": "status" },
                ExpressionAttributeValues: {
                  ":retryable": "FAILED_RETRYABLE",
                  ":failedFinal": "FAILED_FINAL",
                  ":closed": "CLOSED",
                  ":at": input.closedAt
                }
              }
            },
            {
              Put: {
                TableName: this.tableName,
                Item: {
                  PK,
                  SK: keys.caseClosure(input.runId),
                  entityType: "CASE_CLOSURE",
                  ...closure
                },
                ConditionExpression: "attribute_not_exists(PK) AND attribute_not_exists(SK)"
              }
            },
            {
              Put: {
                TableName: this.tableName,
                Item: {
                  PK,
                  SK: keys.caseActivity(input.runId, input.closedAt, activityId),
                  entityType: "CASE_ACTIVITY",
                  id: activityId,
                  runId: input.runId,
                  title: "Caso cerrado sin entregar",
                  detail: `${input.reason}${input.note ? ` · ${input.note}` : ""}`,
                  createdAt: input.closedAt,
                  actor: closedBy,
                  actorId: input.actor.id,
                  actorRole: input.actor.role
                },
                ConditionExpression: "attribute_not_exists(PK) AND attribute_not_exists(SK)"
              }
            }
          ]
        })
      );
      return { outcome: "CLOSED", closure };
    } catch (error) {
      if (!isConditionalFailure(error)) throw error;
      const latestRun = await this.getRun(input.organizationId, input.runId);
      const latestOperations = await this.getRunOperations(input.organizationId, input.runId);
      if (!latestRun) return { outcome: "NOT_FOUND" };
      if (latestOperations.closure) return { outcome: "ALREADY_CLOSED" };
      return { outcome: "STATUS_NOT_ELIGIBLE" };
    }
  }

  private async loadExistingRun(organizationId: string, marker: Item): Promise<Run> {
    const existingRunId = text(marker, "runId");
    const run = await this.getRun(organizationId, existingRunId);
    if (!run) throw new Error("Dedupe marker exists without its run.");
    return run;
  }
}

function roleLabel(role: OperatorRole): string {
  if (role === "admin") return "Administradora";
  if (role === "auditor") return "Auditora";
  return "Operadora";
}
