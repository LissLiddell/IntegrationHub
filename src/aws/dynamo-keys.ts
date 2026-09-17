import { createHash } from "node:crypto";

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export const keys = {
  organization: (organizationId: string) => `ORG#${organizationId}`,
  workflow: (workflowId: string) => `WORKFLOW#${workflowId}`,
  connection: (connectionId: string) => `CONNECTION#${connectionId}`,
  roleAssignment: (actorId: string) => `ROLE#${actorId}`,
  run: (runId: string) => `RUN#${runId}`,
  attempt: (runId: string, number: number) =>
    `RUN#${runId}#ATTEMPT#${number.toString().padStart(6, "0")}`,
  outbox: (runId: string) => `OUTBOX#${runId}`,
  caseClosure: (runId: string) => `RUN#${runId}#CASE`,
  remediation: (runId: string) => `RUN#${runId}#REMEDIATION`,
  caseActivityPrefix: (runId: string) => `RUN#${runId}#ACTIVITY#`,
  caseActivity: (runId: string, createdAt: string, activityId: string) =>
    `RUN#${runId}#ACTIVITY#${createdAt}#${activityId}`,
  dedupe: (workflowId: string, eventId: string) => `DEDUPE#${workflowId}#${sha256(eventId)}`,
  webhookLookup: (token: string) => `WEBHOOK#${sha256(token)}`
};
