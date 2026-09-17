import { loadAwsConfig } from "../config.ts";
import { connectionCredentialStore, repository, runQueue } from "../runtime.ts";
import { createControlApiHandler } from "./control-api.ts";

const accessKeySha256 = process.env.DEMO_ACCESS_KEY_SHA256?.trim();
if (!accessKeySha256 || !/^[a-f0-9]{64}$/i.test(accessKeySha256)) {
  throw new Error("DEMO_ACCESS_KEY_SHA256 must contain a SHA-256 hex digest.");
}

loadAwsConfig();

export const handler = createControlApiHandler({
  repository,
  queue: runQueue,
  credentialStore: connectionCredentialStore,
  organizationId: process.env.DEMO_ORGANIZATION_ID?.trim() || "org_nebula",
  actorId: process.env.DEMO_ACTOR_ID?.trim() || "user_lisset",
  accessKeySha256
});
