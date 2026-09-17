import type {
  CaseActivity,
  CaseClosure,
  ClaimedRun,
  DeliveryFailure,
  DeliveryResult,
  OperatorRole,
  OutboxMessage,
  QueueMessage,
  RoleAssignment,
  Run,
  RunAttempt,
  RunOperations,
  Workflow
} from "../domain/model.ts";
import type { Clock, HttpDelivery, IdGenerator, IntegrationRepository, RunQueue } from "../domain/ports.ts";

export class FixedClock implements Clock {
  private current: Date;

  constructor(iso: string) {
    this.current = new Date(iso);
  }

  now(): Date {
    const result = new Date(this.current);
    this.current = new Date(this.current.getTime() + 25);
    return result;
  }
}

export class SequentialIds implements IdGenerator {
  private sequence = 0;

  next(prefix: "run" | "attempt" | "correlation"): string {
    this.sequence += 1;
    return `${prefix}_${this.sequence.toString().padStart(4, "0")}`;
  }
}

export class InMemoryQueue implements RunQueue {
  readonly messages: QueueMessage[] = [];
  shouldFail = false;

  async publish(message: QueueMessage): Promise<void> {
    if (this.shouldFail) throw new Error("Queue unavailable");
    this.messages.push(structuredClone(message));
  }
}

export class SequenceDelivery implements HttpDelivery {
  readonly calls: Array<{ connectionId: string; correlationId: string }> = [];
  private readonly results: Array<DeliveryResult | DeliveryFailure>;

  constructor(results: Array<DeliveryResult | DeliveryFailure>) {
    this.results = results;
  }

  async deliver(input: {
    organizationId: string;
    connectionId: string;
    correlationId: string;
  }): Promise<DeliveryResult | DeliveryFailure> {
    this.calls.push({ connectionId: input.connectionId, correlationId: input.correlationId });
    const result = this.results.shift();
    if (!result) throw new Error("No delivery result configured");
    return result;
  }
}

export class InMemoryIntegrationRepository implements IntegrationRepository {
  private readonly workflowsByToken = new Map<string, Workflow>();
  private readonly runsById = new Map<string, Run>();
  private readonly runIdByDedupeKey = new Map<string, string>();
  private readonly attemptsByRunId = new Map<string, RunAttempt[]>();
  private readonly rolesByActorId = new Map<string, RoleAssignment>();
  private readonly closuresByRunId = new Map<string, CaseClosure>();
  private readonly remediatedRunIds = new Set<string>();
  private readonly activitiesByRunId = new Map<string, CaseActivity[]>();
  readonly outboxMessages: OutboxMessage[] = [];

  addWorkflow(workflow: Workflow): void {
    this.workflowsByToken.set(workflow.webhookToken, structuredClone(workflow));
  }

  addRoleAssignment(assignment: RoleAssignment): void {
    this.rolesByActorId.set(assignment.actorId, structuredClone(assignment));
  }

  async findWorkflowByWebhookToken(token: string): Promise<Workflow | null> {
    return structuredClone(this.workflowsByToken.get(token) ?? null);
  }

  async createRunWithOutboxIfAbsent(
    run: Run,
    outbox: OutboxMessage
  ): Promise<{ created: boolean; run: Run }> {
    const key = `${run.organizationId}:${run.workflowId}:${run.eventId}`;
    const existingId = this.runIdByDedupeKey.get(key);
    if (existingId) {
      return { created: false, run: structuredClone(this.runsById.get(existingId)!) };
    }
    this.runIdByDedupeKey.set(key, run.id);
    this.runsById.set(run.id, structuredClone(run));
    this.outboxMessages.push(structuredClone(outbox));
    return { created: true, run: structuredClone(run) };
  }

  async claimRun(
    _organizationId: string,
    runId: string,
    _attemptId: string,
    startedAt: string
  ): Promise<ClaimedRun | null> {
    const run = this.runsById.get(runId);
    if (
      !run ||
      run.caseStatus === "CLOSED" ||
      (run.status !== "QUEUED" && run.status !== "FAILED_RETRYABLE")
    ) {
      return null;
    }
    const claimed = { ...run, status: "RUNNING" as const, updatedAt: startedAt };
    this.runsById.set(runId, claimed);
    return { run: structuredClone(claimed), attemptNumber: run.attemptCount + 1, startedAt };
  }

  async completeAttempt(runId: string, attempt: RunAttempt, updatedRun: Run): Promise<void> {
    const attempts = this.attemptsByRunId.get(runId) ?? [];
    attempts.push(structuredClone(attempt));
    this.attemptsByRunId.set(runId, attempts);
    this.runsById.set(runId, structuredClone(updatedRun));
  }

  async getRun(_organizationId: string, runId: string): Promise<Run | null> {
    return structuredClone(this.runsById.get(runId) ?? null);
  }

  async listRuns(organizationId: string, limit: number): Promise<Run[]> {
    return structuredClone(
      [...this.runsById.values()]
        .filter((run) => run.organizationId === organizationId)
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
        .slice(0, limit)
    );
  }

  async listAttempts(_organizationId: string, runId: string): Promise<RunAttempt[]> {
    return structuredClone(this.attemptsByRunId.get(runId) ?? []);
  }

  async getRoleAssignment(organizationId: string, actorId: string): Promise<RoleAssignment | null> {
    const assignment = this.rolesByActorId.get(actorId);
    return structuredClone(assignment?.organizationId === organizationId ? assignment : null);
  }

  async getRunOperations(_organizationId: string, runId: string): Promise<RunOperations> {
    return structuredClone({
      closure: this.closuresByRunId.get(runId) ?? null,
      connectionRemediated: this.remediatedRunIds.has(runId),
      activities: this.activitiesByRunId.get(runId) ?? []
    });
  }

  async remediateConnection(input: {
    organizationId: string;
    runId: string;
    connectionId: string;
    actor: { id: string; displayName: string; role: OperatorRole };
    remediatedAt: string;
  }): Promise<"REMEDIATED" | "NOT_FOUND" | "CASE_CLOSED" | "STATUS_NOT_ELIGIBLE"> {
    const run = this.runsById.get(input.runId);
    if (!run || run.organizationId !== input.organizationId || run.connectionId !== input.connectionId) {
      return "NOT_FOUND";
    }
    if (this.closuresByRunId.has(input.runId)) return "CASE_CLOSED";
    if (run.status !== "FAILED_FINAL") return "STATUS_NOT_ELIGIBLE";
    this.remediatedRunIds.add(input.runId);
    this.runsById.set(input.runId, {
      ...run,
      status: "FAILED_RETRYABLE",
      connectionRemediated: true,
      updatedAt: input.remediatedAt
    });
    this.addActivity(input.runId, {
      id: `activity_remediation_${input.runId}`,
      runId: input.runId,
      title: "Conexión corregida y verificada",
      detail: "La credencial fue reemplazada y aceptada mediante una prueba segura sin ejecutar la operación del pedido.",
      createdAt: input.remediatedAt,
      actor: `${roleLabel(input.actor.role)} · ${input.actor.displayName}`,
      actorId: input.actor.id,
      actorRole: input.actor.role
    });
    return "REMEDIATED";
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
    const run = this.runsById.get(input.runId);
    if (!run || run.organizationId !== input.organizationId) return { outcome: "NOT_FOUND" };
    if (this.closuresByRunId.has(input.runId)) return { outcome: "ALREADY_CLOSED" };
    if (run.status !== "FAILED_RETRYABLE" && run.status !== "FAILED_FINAL") {
      return { outcome: "STATUS_NOT_ELIGIBLE" };
    }
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
    this.closuresByRunId.set(input.runId, closure);
    this.runsById.set(input.runId, { ...run, caseStatus: "CLOSED", updatedAt: input.closedAt });
    this.addActivity(input.runId, {
      id: `activity_closure_${input.runId}`,
      runId: input.runId,
      title: "Caso cerrado sin entregar",
      detail: `${input.reason}${input.note ? ` · ${input.note}` : ""}`,
      createdAt: input.closedAt,
      actor: closedBy,
      actorId: input.actor.id,
      actorRole: input.actor.role
    });
    return { outcome: "CLOSED", closure: structuredClone(closure) };
  }

  private addActivity(runId: string, activity: CaseActivity): void {
    this.activitiesByRunId.set(runId, [...(this.activitiesByRunId.get(runId) ?? []), activity]);
  }
}

function roleLabel(role: OperatorRole): string {
  if (role === "admin") return "Administradora";
  if (role === "auditor") return "Auditora";
  return "Operadora";
}

export const activeDemoWorkflow: Workflow = {
  id: "workflow_orders",
  organizationId: "org_nebula",
  name: "Pedido creado -> Preparar envío",
  webhookToken: "wh_demo_orders",
  connectionId: "connection_fulfillment",
  status: "ACTIVE"
};
