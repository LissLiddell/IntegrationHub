import { randomBytes } from "node:crypto";
import { PutCommand } from "@aws-sdk/lib-dynamodb";
import { dynamoDocumentClient } from "../src/aws/clients.ts";
import { keys } from "../src/aws/dynamo-keys.ts";

function required(name: "INTEGRATION_TABLE_NAME" | "DEMO_DESTINATION_URL" | "DEMO_DESTINATION_SECRET_ARN"): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

const tableName = required("INTEGRATION_TABLE_NAME");
const destinationUrl = required("DEMO_DESTINATION_URL");
const destinationSecretArn = required("DEMO_DESTINATION_SECRET_ARN");
const webhookToken = process.env.DEMO_WEBHOOK_TOKEN?.trim() || `wh_${randomBytes(24).toString("base64url")}`;
const now = new Date().toISOString();
const organizationId = "org_nebula";
const workflowId = "workflow_orders";
const connectionId = "connection_fulfillment";
const PK = keys.organization(organizationId);

await Promise.all([
  dynamoDocumentClient.send(
    new PutCommand({
      TableName: tableName,
      Item: {
        PK,
        SK: "PROFILE",
        entityType: "ORGANIZATION",
        id: organizationId,
        name: "Nébula Commerce",
        environment: "DEMO",
        createdAt: now,
        updatedAt: now
      }
    })
  ),
  dynamoDocumentClient.send(
    new PutCommand({
      TableName: tableName,
      Item: {
        PK,
        SK: keys.roleAssignment("user_lisset"),
        entityType: "ROLE_ASSIGNMENT",
        actorId: "user_lisset",
        organizationId,
        displayName: "Lisset López",
        roles: ["operator", "admin", "auditor"],
        createdAt: now,
        updatedAt: now
      }
    })
  ),
  dynamoDocumentClient.send(
    new PutCommand({
      TableName: tableName,
      Item: {
        PK,
        SK: keys.connection(connectionId),
        entityType: "CONNECTION",
        id: connectionId,
        organizationId,
        name: "Fulfillment API",
        endpointUrl: destinationUrl,
        verificationUrl: `${destinationUrl.replace(/\/$/, "")}/verify`,
        timeoutMs: 5_000,
        secretArn: destinationSecretArn,
        createdAt: now,
        updatedAt: now
      }
    })
  ),
  dynamoDocumentClient.send(
    new PutCommand({
      TableName: tableName,
      Item: {
        PK,
        SK: keys.workflow(workflowId),
        entityType: "WORKFLOW",
        GSI1PK: keys.webhookLookup(webhookToken),
        GSI1SK: keys.workflow(workflowId),
        id: workflowId,
        organizationId,
        name: "Pedido creado -> Preparar envío",
        connectionId,
        status: "ACTIVE",
        eventType: "order.created",
        createdAt: now,
        updatedAt: now
      }
    })
  )
]);

console.log("Nébula Commerce demo data is ready.");
console.log(`Webhook token (save it now): ${webhookToken}`);
const apiBaseUrl = process.env.DEMO_API_BASE_URL?.trim().replace(/\/$/, "");
if (apiBaseUrl) console.log(`Webhook URL: ${apiBaseUrl}/hooks/${webhookToken}`);
