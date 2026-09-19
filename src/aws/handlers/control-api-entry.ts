import { systemClock, uuidGenerator } from "../../domain/system.ts";
import { AwsDemoScenarioPreparer } from "../demo-scenario.ts";
import { loadAwsConfig } from "../config.ts";
import { secretsManagerClient } from "../clients.ts";
import { connectionCredentialStore, demoRunLimiter, repository, runQueue } from "../runtime.ts";
import { createControlApiHandler } from "./control-api.ts";

const accessKeySha256 = process.env.DEMO_ACCESS_KEY_SHA256?.trim();
if (!accessKeySha256 || !/^[a-f0-9]{64}$/i.test(accessKeySha256)) {
  throw new Error("DEMO_ACCESS_KEY_SHA256 must contain a SHA-256 hex digest.");
}

loadAwsConfig();

const demoConnectionSecretArn = process.env.DEMO_CONNECTION_SECRET_ARN?.trim();
const demoValidCredential = process.env.DEMO_VALID_CREDENTIAL?.trim();
if (!demoConnectionSecretArn) throw new Error("DEMO_CONNECTION_SECRET_ARN is required.");
if (!demoValidCredential) throw new Error("DEMO_VALID_CREDENTIAL is required.");

export const handler = createControlApiHandler({
  repository,
  queue: runQueue,
  credentialStore: connectionCredentialStore,
  organizationId: process.env.DEMO_ORGANIZATION_ID?.trim() || "org_nebula",
  actorId: process.env.DEMO_ACTOR_ID?.trim() || "user_lisset",
  accessKeySha256,
  demoRun: {
    workflow: {
      id: "workflow_orders",
      organizationId: process.env.DEMO_ORGANIZATION_ID?.trim() || "org_nebula",
      name: "Pedido creado -> Preparar envío",
      webhookToken: "[trusted-demo-generator]",
      connectionId: "connection_fulfillment",
      status: "ACTIVE"
    },
    clock: systemClock,
    ids: uuidGenerator,
    limiter: demoRunLimiter,
    dailyLimit: 50,
    scenarioPreparer: new AwsDemoScenarioPreparer(
      secretsManagerClient,
      demoConnectionSecretArn,
      demoValidCredential
    )
  }
});
