import type {
  CaseClosure,
  ClaimedRun,
  DeliveryFailure,
  DeliveryResult,
  OperationsActor,
  OutboxMessage,
  QueueMessage,
  RoleAssignment,
  Run,
  RunAttempt,
  RunOperations,
  WebhookEvent,
  Workflow
} from "./model.ts";

export interface Clock {
  now(): Date;
}

export interface IdGenerator {
  next(prefix: "run" | "attempt" | "correlation"): string;
}

export interface IntegrationRepository {
  findWorkflowByWebhookToken(token: string): Promise<Workflow | null>;
  createRunWithOutboxIfAbsent(run: Run, outbox: OutboxMessage): Promise<{ created: boolean; run: Run }>;
  claimRun(
    organizationId: string,
    runId: string,
    attemptId: string,
    startedAt: string
  ): Promise<ClaimedRun | null>;
  completeAttempt(runId: string, attempt: RunAttempt, updatedRun: Run): Promise<void>;
  getRun(organizationId: string, runId: string): Promise<Run | null>;
  listRuns(organizationId: string, limit: number): Promise<Run[]>;
  listAttempts(organizationId: string, runId: string): Promise<RunAttempt[]>;
  getRoleAssignment(organizationId: string, actorId: string): Promise<RoleAssignment | null>;
  getRunOperations(organizationId: string, runId: string): Promise<RunOperations>;
  remediateConnection(input: {
    organizationId: string;
    runId: string;
    connectionId: string;
    actor: OperationsActor;
    remediatedAt: string;
  }): Promise<"REMEDIATED" | "NOT_FOUND" | "CASE_CLOSED" | "STATUS_NOT_ELIGIBLE">;
  closeCase(input: {
    organizationId: string;
    runId: string;
    reason: string;
    note?: string;
    actor: OperationsActor;
    closedAt: string;
  }): Promise<
    | { outcome: "CLOSED"; closure: CaseClosure }
    | { outcome: "NOT_FOUND" | "ALREADY_CLOSED" | "STATUS_NOT_ELIGIBLE" }
  >;
}

export interface ConnectionCredentialStore {
  replaceCredentialAndVerify(
    organizationId: string,
    connectionId: string,
    credential: string
  ): Promise<
    | { verified: true }
    | {
        verified: false;
        code: "UNSAFE_DESTINATION" | "REJECTED" | "UNAVAILABLE" | "ROLLBACK_FAILED";
      }
  >;
}

export interface RunQueue {
  publish(message: QueueMessage): Promise<void>;
}

export interface HttpDelivery {
  deliver(input: {
    organizationId: string;
    connectionId: string;
    correlationId: string;
    event: WebhookEvent;
  }): Promise<DeliveryResult | DeliveryFailure>;
}
