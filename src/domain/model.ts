export type WorkflowStatus = "DRAFT" | "ACTIVE" | "PAUSED";

export type RunStatus =
  | "QUEUED"
  | "RUNNING"
  | "SUCCEEDED"
  | "FAILED_RETRYABLE"
  | "FAILED_FINAL";

export type AttemptStatus = "SUCCEEDED" | "FAILED_RETRYABLE" | "FAILED_FINAL";

export type OperatorRole = "operator" | "admin" | "auditor";

export interface Workflow {
  id: string;
  organizationId: string;
  name: string;
  webhookToken: string;
  connectionId: string;
  status: WorkflowStatus;
}

export interface WebhookEvent {
  eventId: string;
  eventType: string;
  payload: unknown;
}

export interface Run {
  id: string;
  organizationId: string;
  workflowId: string;
  connectionId: string;
  eventId: string;
  eventType: string;
  payload: unknown;
  correlationId: string;
  status: RunStatus;
  attemptCount: number;
  createdAt: string;
  updatedAt: string;
  caseStatus?: "OPEN" | "CLOSED";
  connectionRemediated?: boolean;
}

export interface RoleAssignment {
  actorId: string;
  organizationId: string;
  displayName: string;
  roles: OperatorRole[];
  updatedAt: string;
}

export interface CaseClosure {
  runId: string;
  reason: string;
  note?: string;
  closedAt: string;
  closedBy: string;
  closedByActorId: string;
  closedByRole: OperatorRole;
}

export interface CaseActivity {
  id: string;
  runId: string;
  title: string;
  detail: string;
  createdAt: string;
  actor: string;
  actorId: string;
  actorRole: OperatorRole;
}

export interface RunOperations {
  closure: CaseClosure | null;
  connectionRemediated: boolean;
  activities: CaseActivity[];
}

export interface OperationsActor {
  id: string;
  displayName: string;
  role: OperatorRole;
}

export interface RunAttempt {
  id: string;
  runId: string;
  number: number;
  status: AttemptStatus;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  httpStatus?: number;
  responseSummary?: string;
  failureCode?: DeliveryFailureCode;
}

export interface QueueMessage {
  deliveryId: string;
  runId: string;
  organizationId: string;
  correlationId: string;
}

export interface OutboxMessage extends QueueMessage {
  id: string;
  createdAt: string;
}

export interface DeliveryResult {
  httpStatus: number;
  responseBody?: string;
}

export interface DeliveryFailure {
  code: DeliveryFailureCode;
  message: string;
  retryable: boolean;
}

export type DeliveryFailureCode =
  | "NETWORK_ERROR"
  | "TIMEOUT"
  | "CONNECTION_NOT_FOUND"
  | "UNSAFE_DESTINATION"
  | "SECRET_UNAVAILABLE";

export interface ClaimedRun {
  run: Run;
  attemptNumber: number;
  startedAt: string;
}
