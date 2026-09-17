import type { Run, RunAttempt, RunsResponse } from "./types";

export const sampleRuns: Run[] = [
  {
    id: "run_7K42Q",
    organizationId: "org_nebula",
    workflowId: "workflow_orders",
    connectionId: "connection_fulfillment",
    eventId: "evt_order_1042",
    eventType: "order.created",
    payload: {
      orderId: "ORD-1042",
      customer: "Amelia Ortega",
      total: 18900,
      currency: "MXN",
      items: 3,
      warehouse: "MEX-01"
    },
    correlationId: "corr_01J7H2M9XQ8A",
    status: "FAILED_RETRYABLE",
    attemptCount: 1,
    createdAt: "2026-09-11T19:42:11.000Z",
    updatedAt: "2026-09-11T19:42:11.286Z"
  },
  {
    id: "run_7K3ZM",
    organizationId: "org_nebula",
    workflowId: "workflow_orders",
    connectionId: "connection_fulfillment",
    eventId: "evt_order_1041",
    eventType: "order.created",
    payload: { orderId: "ORD-1041", total: 7460, currency: "MXN", items: 1, warehouse: "MEX-01" },
    correlationId: "corr_01J7H2G4N20V",
    status: "SUCCEEDED",
    attemptCount: 1,
    createdAt: "2026-09-11T19:38:04.000Z",
    updatedAt: "2026-09-11T19:38:04.194Z"
  },
  {
    id: "run_7JZ1B",
    organizationId: "org_nebula",
    workflowId: "workflow_orders",
    connectionId: "connection_fulfillment",
    eventId: "evt_order_1040",
    eventType: "order.created",
    payload: { orderId: "ORD-1040", total: 2310, currency: "MXN", items: 2, warehouse: "MEX-02" },
    correlationId: "corr_01J7H18KFF4S",
    status: "RUNNING",
    attemptCount: 1,
    createdAt: "2026-09-11T19:35:56.000Z",
    updatedAt: "2026-09-11T19:35:56.071Z"
  },
  {
    id: "run_7JYEC",
    organizationId: "org_nebula",
    workflowId: "workflow_orders",
    connectionId: "connection_fulfillment",
    eventId: "evt_order_1039",
    eventType: "order.created",
    payload: { orderId: "ORD-1039", total: 12450, currency: "MXN", items: 4, warehouse: "MEX-01" },
    correlationId: "corr_01J7H0WWDZ6R",
    status: "SUCCEEDED",
    attemptCount: 2,
    createdAt: "2026-09-11T19:31:23.000Z",
    updatedAt: "2026-09-11T19:32:02.242Z"
  },
  {
    id: "run_7JW8A",
    organizationId: "org_nebula",
    workflowId: "workflow_orders",
    connectionId: "connection_fulfillment",
    eventId: "evt_order_1038",
    eventType: "order.created",
    payload: { orderId: "ORD-1038", total: 999, currency: "MXN", items: 1, warehouse: "MEX-02" },
    correlationId: "corr_01J7GYV0P91H",
    status: "FAILED_FINAL",
    attemptCount: 1,
    createdAt: "2026-09-11T19:24:09.000Z",
    updatedAt: "2026-09-11T19:24:09.164Z"
  }
];

export const sampleAttempts: Record<string, RunAttempt[]> = {
  run_7K42Q: [
    {
      id: "attempt_7K42Q_01",
      runId: "run_7K42Q",
      number: 1,
      status: "FAILED_RETRYABLE",
      startedAt: "2026-09-11T19:42:11.000Z",
      finishedAt: "2026-09-11T19:42:11.286Z",
      durationMs: 286,
      httpStatus: 503,
      responseSummary: "El servicio de preparación de envíos está iniciando. Intenta nuevamente."
    }
  ],
  run_7K3ZM: [
    {
      id: "attempt_7K3ZM_01",
      runId: "run_7K3ZM",
      number: 1,
      status: "SUCCEEDED",
      startedAt: "2026-09-11T19:38:04.000Z",
      finishedAt: "2026-09-11T19:38:04.194Z",
      durationMs: 194,
      httpStatus: 202,
      responseSummary: "El destino aceptó preparar el envío."
    }
  ],
  run_7JYEC: [
    {
      id: "attempt_7JYEC_01",
      runId: "run_7JYEC",
      number: 1,
      status: "FAILED_RETRYABLE",
      startedAt: "2026-09-11T19:31:23.000Z",
      finishedAt: "2026-09-11T19:31:23.311Z",
      durationMs: 311,
      httpStatus: 503,
      responseSummary: "El servicio de preparación de envíos no estaba disponible temporalmente."
    },
    {
      id: "attempt_7JYEC_02",
      runId: "run_7JYEC",
      number: 2,
      status: "SUCCEEDED",
      startedAt: "2026-09-11T19:32:02.000Z",
      finishedAt: "2026-09-11T19:32:02.242Z",
      durationMs: 242,
      httpStatus: 202,
      responseSummary: "El destino aceptó preparar el envío en el segundo intento."
    }
  ],
  run_7JW8A: [
    {
      id: "attempt_7JW8A_01",
      runId: "run_7JW8A",
      number: 1,
      status: "FAILED_FINAL",
      startedAt: "2026-09-11T19:24:09.000Z",
      finishedAt: "2026-09-11T19:24:09.164Z",
      durationMs: 164,
      httpStatus: 401,
      responseSummary: "La credencial configurada para el destino fue rechazada."
    }
  ]
};

export const sampleRunsResponse: RunsResponse = {
  organizationId: "org_nebula",
  runs: sampleRuns,
  mode: "preview"
};

export function sampleDetail(runId: string) {
  const run = sampleRuns.find((candidate) => candidate.id === runId) ?? sampleRuns[0]!;
  return { run, attempts: sampleAttempts[run.id] ?? [] };
}
