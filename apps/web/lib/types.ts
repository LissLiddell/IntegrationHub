export type RunStatus = "QUEUED" | "RUNNING" | "SUCCEEDED" | "FAILED_RETRYABLE" | "FAILED_FINAL";
export type AttemptStatus = "SUCCEEDED" | "FAILED_RETRYABLE" | "FAILED_FINAL";
export type OperatorRole = "operator" | "admin" | "auditor";

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

export interface CaseClosure {
  runId: string;
  reason: string;
  note?: string;
  closedAt: string;
  closedBy: string;
  closedByActorId?: string;
  closedByRole?: OperatorRole;
}

export interface CaseActivity {
  id: string;
  runId: string;
  title: string;
  detail: string;
  createdAt: string;
  actor: string;
  actorId?: string;
  actorRole?: OperatorRole;
}

export interface RunOperations {
  closure: CaseClosure | null;
  connectionRemediated: boolean;
  activities: CaseActivity[];
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
  failureCode?: string;
}

export interface RunDetail {
  run: Run;
  attempts: RunAttempt[];
  operations?: RunOperations;
}

export interface RunsResponse {
  organizationId: string;
  runs: Run[];
  mode?: "connected" | "preview";
}

export interface RoleAssignment {
  actorId: string;
  organizationId: string;
  displayName: string;
  roles: OperatorRole[];
  updatedAt: string;
}

export interface RolesResponse {
  assignment: RoleAssignment;
  mode?: "connected" | "preview";
}
