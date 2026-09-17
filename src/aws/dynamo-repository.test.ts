import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { QueryCommand, TransactWriteCommand, UpdateCommand, type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import type { OutboxMessage, Run } from "../domain/model.ts";
import { DynamoIntegrationRepository } from "./dynamo-repository.ts";

class FakeDocumentClient {
  readonly commands: unknown[] = [];

  constructor(private readonly responses: unknown[]) {}

  async send(command: unknown): Promise<unknown> {
    this.commands.push(command);
    const response = this.responses.shift();
    if (response instanceof Error) throw response;
    return response ?? {};
  }
}

const run: Run = {
  id: "run_001",
  organizationId: "org_nebula",
  workflowId: "workflow_orders",
  connectionId: "connection_fulfillment",
  eventId: "evt_001",
  eventType: "order.created",
  payload: { orderId: "ORD-001" },
  correlationId: "correlation_001",
  status: "QUEUED",
  attemptCount: 0,
  createdAt: "2026-09-11T12:00:00.000Z",
  updatedAt: "2026-09-11T12:00:00.000Z"
};

const outbox: OutboxMessage = {
  id: "outbox_run_001",
  deliveryId: "outbox_run_001",
  runId: run.id,
  organizationId: run.organizationId,
  correlationId: run.correlationId,
  createdAt: run.createdAt
};

function repository(client: FakeDocumentClient) {
  return new DynamoIntegrationRepository(client as unknown as DynamoDBDocumentClient, "integrationhub-test");
}

describe("DynamoDB integration repository", () => {
  it("atomically writes dedupe marker, run, and outbox", async () => {
    const client = new FakeDocumentClient([{}, {}]);

    const result = await repository(client).createRunWithOutboxIfAbsent(run, outbox);

    assert.equal(result.created, true);
    assert.equal(client.commands.length, 2);
    const transaction = client.commands[1];
    assert.ok(transaction instanceof TransactWriteCommand);
    const writes = transaction.input.TransactItems ?? [];
    assert.equal(writes.length, 3);
    assert.equal(writes[0]?.Put?.Item?.entityType, "DEDUPE");
    assert.equal(writes[1]?.Put?.Item?.entityType, "RUN");
    assert.equal(writes[2]?.Put?.Item?.entityType, "OUTBOX");
    assert.equal(typeof writes[2]?.Put?.Item?.expiresAt, "number");
  });

  it("returns the original run when an event id is already registered", async () => {
    const client = new FakeDocumentClient([{ Item: { runId: run.id } }, { Item: { PK: "ignored", SK: "ignored", entityType: "RUN", ...run } }]);

    const result = await repository(client).createRunWithOutboxIfAbsent({ ...run, id: "run_new" }, outbox);

    assert.equal(result.created, false);
    assert.equal(result.run.id, "run_001");
    assert.equal(client.commands.length, 2);
  });

  it("claims a queued run with one conditional update", async () => {
    const client = new FakeDocumentClient([{ Attributes: { PK: "ignored", SK: "ignored", entityType: "RUN", ...run, status: "RUNNING", attemptCount: 1 } }]);

    const result = await repository(client).claimRun("org_nebula", run.id, "attempt_001", run.updatedAt);

    assert.equal(result?.run.status, "RUNNING");
    assert.equal(result?.attemptNumber, 1);
    assert.ok(client.commands[0] instanceof UpdateCommand);
    assert.match((client.commands[0] as UpdateCommand).input.ConditionExpression ?? "", /QUEUED|#status/);
  });

  it("ignores a competing worker that lost the conditional claim", async () => {
    const conflict = new Error("already claimed");
    conflict.name = "ConditionalCheckFailedException";
    const client = new FakeDocumentClient([conflict]);

    assert.equal(await repository(client).claimRun("org_nebula", run.id, "attempt_002", run.updatedAt), null);
  });

  it("lists the newest organization runs through the run index", async () => {
    const client = new FakeDocumentClient([{ Items: [{ PK: "ignored", SK: "ignored", ...run }] }]);

    const result = await repository(client).listRuns("org_nebula", 25);

    assert.equal(result[0]?.id, run.id);
    const query = client.commands[0];
    assert.ok(query instanceof QueryCommand);
    assert.equal(query.input.IndexName, "GSI2");
    assert.equal(query.input.ScanIndexForward, false);
    assert.equal(query.input.Limit, 25);
  });

  it("loads the persisted operator role assignment", async () => {
    const client = new FakeDocumentClient([
      {
        Item: {
          actorId: "user_lisset",
          organizationId: "org_nebula",
          displayName: "Lisset López",
          roles: ["operator", "admin", "auditor"],
          updatedAt: "2026-09-11T12:00:00.000Z"
        }
      }
    ]);

    const assignment = await repository(client).getRoleAssignment("org_nebula", "user_lisset");

    assert.equal(assignment?.displayName, "Lisset López");
    assert.deepEqual(assignment?.roles, ["operator", "admin", "auditor"]);
  });

  it("loads closure, remediation, and immutable case activity together", async () => {
    const client = new FakeDocumentClient([
      {
        Item: {
          runId: run.id,
          reason: "Pedido cancelado",
          closedAt: "2026-09-11T13:00:00.000Z",
          closedBy: "Operadora · Lisset López",
          closedByActorId: "user_lisset",
          closedByRole: "operator"
        }
      },
      { Item: { entityType: "CONNECTION_REMEDIATION" } },
      {
        Items: [
          {
            id: "activity_001",
            runId: run.id,
            title: "Caso cerrado sin entregar",
            detail: "Pedido cancelado",
            createdAt: "2026-09-11T13:00:00.000Z",
            actor: "Operadora · Lisset López",
            actorId: "user_lisset",
            actorRole: "operator"
          }
        ]
      }
    ]);

    const operations = await repository(client).getRunOperations("org_nebula", run.id);

    assert.equal(operations.closure?.reason, "Pedido cancelado");
    assert.equal(operations.connectionRemediated, true);
    assert.equal(operations.activities[0]?.id, "activity_001");
  });
});
