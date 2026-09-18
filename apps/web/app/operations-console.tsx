"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { sampleAttempts, sampleRuns } from "@/lib/sample-data";
import {
  closeDecision,
  connectionFixDecision,
  retryDecision,
  roleText,
  type OperatorRole
} from "@/lib/operations-rules";
import type {
  AwsDemoRunResponse,
  CaseActivity,
  CaseClosure,
  RolesResponse,
  Run,
  RunAttempt,
  RunDetail,
  RunsResponse,
  RunStatus
} from "@/lib/types";

const closeReasons = [
  "Pedido cancelado",
  "El proveedor lo procesó manualmente",
  "El aviso fue enviado por error",
  "La entrega ya no es necesaria",
  "Otro motivo"
];

type DemoScenario = "shipping-timeout" | "invoice-success";

const workflowText: Record<string, { event: string; action: string; connection: string }> = {
  workflow_orders: {
    event: "Pedido creado",
    action: "Preparar envío",
    connection: "API de preparación de envíos"
  },
  workflow_invoicing: {
    event: "Factura solicitada",
    action: "Emitir factura",
    connection: "API de facturación electrónica"
  }
};

function workflowFor(run: Run) {
  return workflowText[run.workflowId] ?? {
    event: eventLabel(run.eventType),
    action: "Entregar evento",
    connection: "API del proveedor"
  };
}

const statusText: Record<RunStatus, string> = {
  QUEUED: "En cola",
  RUNNING: "Procesando",
  SUCCEEDED: "Entregado",
  FAILED_RETRYABLE: "Se puede reintentar",
  FAILED_FINAL: "Necesita corrección"
};

const eventText: Record<string, string> = {
  "order.created": "Pedido creado",
  "invoice.requested": "Factura solicitada"
};

function eventLabel(eventType: string) {
  return eventText[eventType] ?? eventType;
}

function decisionFor(
  run: Run,
  attempts: RunAttempt[],
  options: { closure?: CaseClosure; connectionRemediated: boolean }
) {
  const latest = attempts.at(-1);
  if (options.closure) {
    return {
      tone: "neutral",
      title: "Caso cerrado sin entregar",
      explanation: `Una persona decidió no continuar después de ${run.attemptCount} intento${run.attemptCount === 1 ? "" : "s"}. Motivo: ${options.closure.reason}.${options.closure.note ? ` Historia: ${options.closure.note}` : ""}`,
      next: "No habrá más reintentos. La decisión y el historial permanecen disponibles para auditoría."
    };
  }
  if (options.connectionRemediated && run.status === "FAILED_RETRYABLE") {
    return {
      tone: "success",
      title: "Conexión corregida y verificada",
      explanation: "La credencial fue aceptada mediante una prueba segura que no ejecutó nuevamente el pedido.",
      next: "La operadora ya puede crear el segundo intento real sin borrar el fallo original."
    };
  }
  if (run.status === "FAILED_RETRYABLE") {
    return {
      tone: "warning",
      title: "Sí se puede reintentar",
      explanation: latest?.httpStatus
        ? `El destino respondió HTTP ${latest.httpStatus}. Es un problema temporal: el aviso sigue siendo válido y no hace falta corregir sus datos.`
        : "La entrega se interrumpió por tiempo de espera o por un problema temporal de red.",
      next: "El botón vuelve a enviar el mismo evento, conserva su ID de seguimiento y registra un intento nuevo."
    };
  }
  if (run.status === "FAILED_FINAL") {
    return {
      tone: "danger",
      title: "Todavía no se debe reintentar",
      explanation: latest?.httpStatus === 401
        ? "El destino rechazó la credencial con HTTP 401. Repetir exactamente la misma petición volvería a fallar."
        : "El destino rechazó la petición de forma definitiva; no parece una falla temporal.",
      next: "Primero se corrige la conexión o los datos. Después se podrá reprocesar la ejecución de forma consciente."
    };
  }
  if (run.status === "RUNNING") {
    return {
      tone: "info",
      title: "La entrega está trabajando",
      explanation: "Este estado debe durar sólo unos segundos. Mientras está activo no habilitamos otro intento para evitar enviar la operación dos veces.",
      next: "Si responde bien quedará Entregado; si vence el tiempo cambiará a Se puede reintentar."
    };
  }
  if (run.status === "QUEUED") {
    return {
      tone: "info",
      title: "Está esperando su turno",
      explanation: "El aviso ya fue guardado de forma segura y está esperando a que un procesador lo tome de la cola.",
      next: "Cuando empiece la entrega cambiará automáticamente a Procesando."
    };
  }
  return {
    tone: "success",
    title: run.attemptCount > 1 ? `Se recuperó en el intento ${run.attemptCount}` : "Funcionó al primer intento",
    explanation: run.attemptCount > 1
      ? "Un intento anterior falló temporalmente, pero la última entrega fue aceptada por el destino."
      : "El aviso entró, se protegió contra duplicados y el destino lo aceptó sin necesidad de repetirlo.",
    next: "No necesita ninguna acción adicional. El historial queda disponible para auditoría."
  };
}

function destinationDetail(
  run: Run,
  attempts: RunAttempt[],
  options: { closed: boolean; connectionRemediated: boolean }
) {
  if (options.closed) return "Caso cerrado";
  if (options.connectionRemediated && run.status === "FAILED_RETRYABLE") return "Conexión verificada";
  if (run.status === "QUEUED") return "Esperando";
  if (run.status === "RUNNING") return "Procesando";
  const latest = attempts.at(-1);
  if (latest?.httpStatus) return `HTTP ${latest.httpStatus}`;
  if (latest?.failureCode === "TIMEOUT") return "Tiempo agotado";
  return run.status === "SUCCEEDED" ? "Aceptado" : "No entregado";
}

function Icon({ name }: { name: "pulse" | "refresh" | "arrow" | "copy" | "bolt" | "box" }) {
  const paths = {
    pulse: <path d="M3 12h4l2.2-6 4.1 12L16 10l1.5 2H21" />,
    refresh: <><path d="M20 11a8.1 8.1 0 0 0-15.5-3M4 4v4h4" /><path d="M4 13a8.1 8.1 0 0 0 15.5 3M20 20v-4h-4" /></>,
    arrow: <><path d="M5 12h14" /><path d="m14 7 5 5-5 5" /></>,
    copy: <><rect x="9" y="9" width="10" height="10" rx="2" /><path d="M15 9V7a2 2 0 0 0-2-2H7a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h2" /></>,
    bolt: <path d="m13 2-8 12h7l-1 8 8-12h-7l1-8Z" />,
    box: <><path d="m21 8-9 5-9-5" /><path d="M3 8 12 3l9 5v8l-9 5-9-5Z" /><path d="M12 13v8" /></>
  };
  return <svg viewBox="0 0 24 24" aria-hidden="true">{paths[name]}</svg>;
}

function shortId(value: string) {
  return value.length > 16 ? `${value.slice(0, 10)}…${value.slice(-4)}` : value;
}

function time(value: string) {
  return new Intl.DateTimeFormat("es-MX", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    timeZone: "America/Mexico_City"
  }).format(new Date(value));
}

function updateRun(runs: Run[], runId: string, updater: (run: Run) => Run) {
  return runs.map((run) => (run.id === runId ? updater(run) : run));
}

function appendAttemptOnce(current: Record<string, RunAttempt[]>, attempt: RunAttempt) {
  const runAttempts = current[attempt.runId] ?? [];
  if (runAttempts.some((existing) => existing.id === attempt.id || existing.number === attempt.number)) {
    return current;
  }
  return { ...current, [attempt.runId]: [...runAttempts, attempt] };
}

export function OperationsConsole() {
  const [runs, setRuns] = useState<Run[]>(sampleRuns);
  const [attempts, setAttempts] = useState<Record<string, RunAttempt[]>>(sampleAttempts);
  const [selectedId, setSelectedId] = useState(sampleRuns[0]!.id);
  const [mode, setMode] = useState<"preview" | "connected">("preview");
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isRetrying, setIsRetrying] = useState(false);
  const [isGeneratingAwsDemo, setIsGeneratingAwsDemo] = useState(false);
  const [notice, setNotice] = useState("Vista local preparada con datos de Nébula Commerce.");
  const [role, setRole] = useState<OperatorRole>("operator");
  const [availableRoles, setAvailableRoles] = useState<OperatorRole[]>(["operator", "admin", "auditor"]);
  const [remediatedRunIds, setRemediatedRunIds] = useState<Set<string>>(() => new Set());
  const [caseClosures, setCaseClosures] = useState<Record<string, CaseClosure>>({});
  const [caseActivities, setCaseActivities] = useState<Record<string, CaseActivity[]>>({});
  const [connectionPanelOpen, setConnectionPanelOpen] = useState(false);
  const [credentialDraft, setCredentialDraft] = useState("");
  const [isTestingConnection, setIsTestingConnection] = useState(false);
  const [closePanelOpen, setClosePanelOpen] = useState(false);
  const [closeReason, setCloseReason] = useState(closeReasons[0]!);
  const [closeNote, setCloseNote] = useState("");
  const [demoPanelOpen, setDemoPanelOpen] = useState(false);
  const hasLoadedRuns = useRef(false);

  const selected = runs.find((run) => run.id === selectedId) ?? runs[0];
  const selectedAttempts = selected ? attempts[selected.id] ?? [] : [];
  const selectedClosure = selected ? caseClosures[selected.id] : undefined;
  const selectedRemediated = selected ? remediatedRunIds.has(selected.id) : false;
  const selectedActivity = selected ? caseActivities[selected.id] ?? [] : [];
  const selectedClosed = Boolean(selectedClosure) || selected?.caseStatus === "CLOSED";
  const operationContext = selected
    ? { status: selected.status, role, closed: selectedClosed, connectionRemediated: selectedRemediated }
    : null;
  const retryRule = operationContext ? retryDecision(operationContext) : null;
  const connectionRule = operationContext ? connectionFixDecision(operationContext) : null;
  const closeRule = operationContext ? closeDecision(operationContext) : null;
  const decision = selected
    ? decisionFor(selected, selectedAttempts, {
        ...(selectedClosure
          ? { closure: selectedClosure }
          : selectedClosed
            ? {
                closure: {
                  runId: selected.id,
                  reason: "Decisión operativa registrada",
                  closedAt: selected.updatedAt,
                  closedBy: "Operación registrada"
                }
              }
            : {}),
        connectionRemediated: selectedRemediated
      })
    : null;

  const loadRuns = useCallback(async (quiet = false) => {
    if (!quiet && hasLoadedRuns.current && mode === "preview") {
      setIsRefreshing(true);
      await new Promise((resolve) => window.setTimeout(resolve, 260));
      setNotice("Vista local sincronizada. Las ejecuciones siguen avanzando solas sin crear intentos nuevos.");
      setIsRefreshing(false);
      return;
    }
    if (!quiet) setIsRefreshing(true);
    try {
      const response = await fetch("/api/runs", { cache: "no-store" });
      if (!response.ok) throw new Error("Runs unavailable");
      const data = (await response.json()) as RunsResponse;
      if (data.runs.length) {
        setRuns(data.runs);
        setSelectedId((current) => (data.runs.some((run) => run.id === current) ? current : data.runs[0]!.id));
      }
      setMode(data.mode ?? "connected");
      hasLoadedRuns.current = true;
      if (!quiet) setNotice(data.mode === "preview" ? "Vista local actualizada." : "Ejecuciones sincronizadas con AWS.");
    } catch {
      if (!quiet) setNotice("No pudimos sincronizar; conservamos la última información visible.");
    } finally {
      if (!quiet) setIsRefreshing(false);
    }
  }, [mode]);

  const loadDetail = useCallback(async (runId: string) => {
    try {
      const response = await fetch(`/api/runs/${encodeURIComponent(runId)}`, { cache: "no-store" });
      if (!response.ok) return;
      const detail = (await response.json()) as RunDetail;
      setRuns((current) => updateRun(current, runId, () => detail.run));
      setAttempts((current) => ({ ...current, [runId]: detail.attempts }));
      if (detail.operations) {
        setCaseClosures((current) => {
          const next = { ...current };
          if (detail.operations?.closure) next[runId] = detail.operations.closure;
          else delete next[runId];
          return next;
        });
        setRemediatedRunIds((current) => {
          const next = new Set(current);
          if (detail.operations?.connectionRemediated) next.add(runId);
          else next.delete(runId);
          return next;
        });
        setCaseActivities((current) => ({
          ...current,
          [runId]: detail.operations?.activities ?? []
        }));
      }
    } catch {
      // The list remains usable with the last successful snapshot.
    }
  }, []);

  useEffect(() => {
    void loadRuns(true);
  }, [loadRuns]);

  useEffect(() => {
    if (mode === "connected" && selectedId) void loadDetail(selectedId);
  }, [loadDetail, mode, selectedId]);

  useEffect(() => {
    if (mode !== "connected") return;
    void fetch("/api/roles", { cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) return;
        const data = (await response.json()) as RolesResponse;
        if (!data.assignment.roles.length) return;
        setAvailableRoles(data.assignment.roles);
        setRole((current) => (data.assignment.roles.includes(current) ? current : data.assignment.roles[0]!));
      })
      .catch(() => undefined);
  }, [mode]);

  useEffect(() => {
    if (mode !== "preview" || selected?.status !== "RUNNING" || selected.id.startsWith("run_LOCAL_")) return;
    const runId = selected.id;
    setNotice("La entrega está procesándose; todavía no debe repetirse.");
    const timer = window.setTimeout(() => {
      const finishedAt = new Date().toISOString();
      setRuns((current) =>
        updateRun(current, runId, (run) => ({ ...run, status: "FAILED_RETRYABLE", updatedAt: finishedAt }))
      );
      setAttempts((current) =>
        appendAttemptOnce(current, {
          id: `attempt_${runId}_01`,
          runId,
          number: 1,
          status: "FAILED_RETRYABLE",
          startedAt: selected.updatedAt,
          finishedAt,
          durationMs: 3_000,
          failureCode: "TIMEOUT",
          responseSummary: "El destino tardó más de lo permitido en responder."
        })
      );
      setNotice("La entrega agotó su tiempo de espera. Ahora sí se puede reintentar.");
    }, 3_000);
    return () => window.clearTimeout(timer);
  }, [mode, selected?.id, selected?.status, selected?.updatedAt]);

  const metrics = useMemo(() => {
    const delivered = runs.filter((run) => run.status === "SUCCEEDED").length;
    const needsAction = runs.filter(
      (run) =>
        (run.status === "FAILED_RETRYABLE" || run.status === "FAILED_FINAL") &&
        !caseClosures[run.id] &&
        run.caseStatus !== "CLOSED"
    ).length;
    const active = runs.filter((run) => run.status === "QUEUED" || run.status === "RUNNING").length;
    return {
      total: runs.length,
      success: runs.length ? Math.round((delivered / runs.length) * 100) : 0,
      needsAction,
      active
    };
  }, [caseClosures, runs]);

  const addCaseActivity = useCallback((runId: string, activity: Omit<CaseActivity, "id" | "runId">) => {
    setCaseActivities((current) => ({
      ...current,
      [runId]: [
        ...(current[runId] ?? []),
        { ...activity, runId, id: `activity_${runId}_${Date.now().toString(36)}` }
      ]
    }));
  }, []);

  async function repairConnection() {
    if (!selected || !connectionRule?.allowed) {
      setNotice(connectionRule && !connectionRule.allowed ? connectionRule.reason : "No se puede corregir esta conexión.");
      return;
    }
    if (credentialDraft.trim().length < 8) {
      setNotice("Escribe una credencial de demostración de al menos 8 caracteres.");
      return;
    }

    setIsTestingConnection(true);
    setNotice("Guardando la credencial y verificando la conexión sin ejecutar el pedido…");
    try {
      if (mode === "connected") {
        const response = await fetch(
          `/api/connections/${encodeURIComponent(selected.connectionId)}/remediate`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ runId: selected.id, credential: credentialDraft.trim(), role })
          }
        );
        if (!response.ok) {
          const body = (await response.json()) as { error?: { message?: string } };
          throw new Error(body.error?.message || "No fue posible corregir la conexión.");
        }
        await Promise.all([loadDetail(selected.id), loadRuns(true)]);
      } else {
        await new Promise((resolve) => window.setTimeout(resolve, 900));
        const verifiedAt = new Date().toISOString();
        setRemediatedRunIds((current) => new Set(current).add(selected.id));
        setRuns((current) =>
          updateRun(current, selected.id, (run) => ({
            ...run,
            status: "FAILED_RETRYABLE",
            connectionRemediated: true,
            updatedAt: verifiedAt
          }))
        );
        addCaseActivity(selected.id, {
          title: "Conexión corregida y verificada",
          detail: "La credencial fue aceptada en una prueba segura; no se ejecutó la operación del pedido.",
          createdAt: verifiedAt,
          actor: `${roleText[role]} · Lisset López`
        });
      }
      setCredentialDraft("");
      setConnectionPanelOpen(false);
      setNotice("Conexión verificada. La operadora ya puede ejecutar el segundo intento real.");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "No fue posible corregir la conexión.");
    } finally {
      setIsTestingConnection(false);
    }
  }

  async function closeSelectedCase() {
    if (!selected || !closeRule?.allowed) {
      setNotice(closeRule && !closeRule.allowed ? closeRule.reason : "Este caso no puede cerrarse.");
      return;
    }
    if (closeReason === "Otro motivo" && !closeNote.trim()) {
      setNotice("Cuando eliges Otro motivo, escribe la historia del caso antes de cerrarlo.");
      return;
    }
    try {
      if (mode === "connected") {
        const response = await fetch(`/api/runs/${encodeURIComponent(selected.id)}/close`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ role, reason: closeReason, note: closeNote.trim() || undefined })
        });
        if (!response.ok) {
          const body = (await response.json()) as { error?: { message?: string } };
          throw new Error(body.error?.message || "No fue posible cerrar el caso.");
        }
        await Promise.all([loadDetail(selected.id), loadRuns(true)]);
      } else {
        const closedAt = new Date().toISOString();
        const closure: CaseClosure = {
          runId: selected.id,
          reason: closeReason,
          ...(closeNote.trim() ? { note: closeNote.trim() } : {}),
          closedAt,
          closedBy: `${roleText[role]} · Lisset López`
        };
        setCaseClosures((current) => ({ ...current, [selected.id]: closure }));
        setRuns((current) =>
          updateRun(current, selected.id, (run) => ({ ...run, caseStatus: "CLOSED", updatedAt: closedAt }))
        );
        addCaseActivity(selected.id, {
          title: "Caso cerrado sin entregar",
          detail: `${closeReason}${closeNote.trim() ? ` · ${closeNote.trim()}` : ""}`,
          createdAt: closedAt,
          actor: closure.closedBy
        });
      }
      setClosePanelOpen(false);
      setCloseReason(closeReasons[0]!);
      setCloseNote("");
      setNotice("Caso cerrado. El historial se conserva y ya no se permiten reintentos.");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "No fue posible cerrar el caso.");
    }
  }

  const retryRunById = useCallback(async (runId: string) => {
    const target = runs.find((run) => run.id === runId);
    if (!target) throw new Error("La ejecución solicitada no existe en la vista actual.");
    const rule = retryDecision({
      status: target.status,
      role,
      closed: Boolean(caseClosures[runId]) || target.caseStatus === "CLOSED",
      connectionRemediated: remediatedRunIds.has(runId)
    });
    if (!rule.allowed) throw new Error(rule.reason);
    setSelectedId(runId);
    setIsRetrying(true);
    setNotice(`Programando intento ${target.attemptCount + 1}…`);
    try {
      const response = await fetch(`/api/runs/${encodeURIComponent(target.id)}/retry`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ role })
      });
      if (!response.ok) {
        const body = (await response.json()) as { error?: { message?: string } };
        throw new Error(body.error?.message || "Retry failed");
      }
      setRuns((current) =>
        updateRun(current, target.id, (run) => ({ ...run, status: "RUNNING", updatedAt: new Date().toISOString() }))
      );
      setNotice("Reintento en cola. Conservamos el mismo ID de seguimiento.");

      if (mode === "preview") {
        await new Promise((resolve) => setTimeout(resolve, 720));
        const finishedAt = new Date().toISOString();
        setRuns((current) =>
          updateRun(current, target.id, (run) => ({
            ...run,
            status: "SUCCEEDED",
            attemptCount: run.attemptCount + 1,
            updatedAt: finishedAt
          }))
        );
        setAttempts((current) =>
          appendAttemptOnce(current, {
            id: `attempt_${target.id}_${(target.attemptCount + 1).toString().padStart(2, "0")}`,
            runId: target.id,
            number: target.attemptCount + 1,
            status: "SUCCEEDED",
            startedAt: finishedAt,
            finishedAt,
            durationMs: 184,
            httpStatus: 202,
            responseSummary: `El destino aceptó ${workflowFor(target).action.toLowerCase()}.`
          })
        );
        addCaseActivity(target.id, {
          title: `Intento ${target.attemptCount + 1} entregado`,
          detail: `${workflowFor(target).connection} aceptó la operación con HTTP 202.`,
          createdAt: finishedAt,
          actor: `${roleText[role]} · Lisset López`
        });
        setNotice(`Entrega aceptada con HTTP 202 en el intento ${target.attemptCount + 1}.`);
        return { runId: target.id, status: "SUCCEEDED" as const, attempt: target.attemptCount + 1 };
      } else {
        await new Promise((resolve) => setTimeout(resolve, 1_200));
        await loadDetail(target.id);
        setNotice("Reintento procesado; detalle sincronizado.");
        return { runId: target.id, status: "QUEUED" as const, attempt: target.attemptCount + 1 };
      }
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "No fue posible programar el reintento.");
      throw error;
    } finally {
      setIsRetrying(false);
    }
  }, [addCaseActivity, caseClosures, loadDetail, mode, remediatedRunIds, role, runs]);

  useEffect(() => {
    const modelContext = document.modelContext;
    if (!modelContext?.registerTool) return;
    const lifecycle = new AbortController();
    void Promise.resolve(
      modelContext.registerTool(
        {
          name: "retry_failed_delivery",
          title: "Reintentar entrega fallida",
          description: "Programa un nuevo intento para una ejecución con fallo temporal y actualiza el panel visible.",
          inputSchema: {
            type: "object",
            properties: { runId: { type: "string", description: "Identificador de la ejecución fallida." } },
            required: ["runId"],
            additionalProperties: false
          },
          annotations: { readOnlyHint: false, untrustedContentHint: false },
          async execute(input: unknown) {
            if (
              typeof input !== "object" ||
              input === null ||
              !("runId" in input) ||
              typeof input.runId !== "string" ||
              !input.runId.trim()
            ) {
              throw new Error("runId es obligatorio.");
            }
            return retryRunById(input.runId.trim());
          }
        },
        { signal: lifecycle.signal }
      )
    ).catch(() => undefined);
    return () => lifecycle.abort();
  }, [retryRunById]);

  function selectRun(runId: string) {
    setSelectedId(runId);
    setConnectionPanelOpen(false);
    setClosePanelOpen(false);
    setCredentialDraft("");
    if (mode === "connected") void loadDetail(runId);
  }

  function changeRole(nextRole: OperatorRole) {
    setRole(nextRole);
    setConnectionPanelOpen(false);
    setClosePanelOpen(false);
    setNotice(`Rol activo: ${roleText[nextRole]}. Las acciones disponibles fueron actualizadas.`);
  }

  function createDemoRun(scenario: DemoScenario, startDelay = 0, select = true) {
    const suffix = `${Date.now().toString(36).slice(-4)}${Math.random().toString(36).slice(2, 4)}`.toUpperCase();
    const runId = `run_LOCAL_${suffix}`;
    const createdAt = new Date().toISOString();
    const isInvoice = scenario === "invoice-success";
    const newRun: Run = {
      id: runId,
      organizationId: "org_nebula",
      workflowId: isInvoice ? "workflow_invoicing" : "workflow_orders",
      connectionId: isInvoice ? "connection_invoicing" : "connection_fulfillment",
      eventId: `${isInvoice ? "evt_invoice" : "evt_order"}_${suffix.toLowerCase()}`,
      eventType: isInvoice ? "invoice.requested" : "order.created",
      payload: isInvoice
        ? {
            invoiceId: `INV-${suffix.slice(-4)}`,
            orderId: `ORD-${suffix.slice(-4)}`,
            total: 12840,
            currency: "MXN",
            taxUse: "G03"
          }
        : {
            orderId: `ORD-${suffix.slice(-4)}`,
            total: 12840,
            currency: "MXN",
            items: 2,
            warehouse: "MEX-01"
          },
      correlationId: `corr_LOCAL_${suffix}`,
      status: "QUEUED",
      attemptCount: 0,
      createdAt,
      updatedAt: createdAt
    };
    setRuns((current) => [newRun, ...current]);
    setAttempts((current) => ({ ...current, [runId]: [] }));
    if (select) setSelectedId(runId);

    window.setTimeout(() => {
      const startedAt = new Date().toISOString();
      setRuns((current) =>
        updateRun(current, runId, (run) => ({ ...run, status: "RUNNING", attemptCount: 1, updatedAt: startedAt }))
      );
      if (select) setNotice(`El procesador tomó ${isInvoice ? "la factura" : "el pedido"} y está contactando al proveedor.`);
    }, 700 + startDelay);

    window.setTimeout(() => {
      const finishedAt = new Date().toISOString();
      const terminalStatus: RunStatus = isInvoice ? "SUCCEEDED" : "FAILED_RETRYABLE";
      setRuns((current) =>
        updateRun(current, runId, (run) => ({ ...run, status: terminalStatus, updatedAt: finishedAt }))
      );
      setAttempts((current) => ({
        ...current,
        [runId]: [
          {
            id: `attempt_${runId}_01`,
            runId,
            number: 1,
            status: terminalStatus,
            startedAt: new Date(new Date(finishedAt).getTime() - (isInvoice ? 328 : 3_000)).toISOString(),
            finishedAt,
            durationMs: isInvoice ? 328 : 3_000,
            ...(isInvoice
              ? { httpStatus: 202, responseSummary: "El proveedor fiscal aceptó emitir la factura." }
              : { failureCode: "TIMEOUT", responseSummary: "El proveedor de envíos tardó más de lo permitido en responder." })
          }
        ]
      }));
      if (select) {
        setNotice(
          isInvoice
            ? "La factura fue aceptada al primer intento."
            : "El proveedor de envíos agotó su tiempo. Ahora se puede reintentar o cerrar el caso."
        );
      }
    }, 3_700 + startDelay);

    return runId;
  }

  function launchDemoScenario(scenario: DemoScenario | "traffic-burst") {
    setDemoPanelOpen(false);
    if (scenario === "traffic-burst") {
      const firstRunId = createDemoRun("shipping-timeout", 0, true);
      createDemoRun("shipping-timeout", 350, false);
      createDemoRun("invoice-success", 700, false);
      setSelectedId(firstRunId);
      setNotice("Entraron tres avisos reales simulados: dos envíos y una factura. El dashboard seguirá cada uno.");
      return;
    }
    createDemoRun(scenario);
    setNotice(
      scenario === "invoice-success"
        ? "Entró una solicitud de factura; el dashboard seguirá su ejecución."
        : "Entró un pedido para envío; el dashboard seguirá su ejecución."
    );
  }

  async function generateAwsDemoRun() {
    if (role === "auditor") {
      setNotice("El rol Auditor es de sólo lectura. Cambia a Operador o Administrador para generar una prueba.");
      return;
    }

    setIsGeneratingAwsDemo(true);
    setNotice("Enviando un pedido nuevo al pipeline real de AWS…");
    try {
      const response = await fetch("/api/runs/demo", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ role })
      });
      const body = (await response.json()) as AwsDemoRunResponse & {
        error?: { code?: string; message?: string };
      };
      if (!response.ok) {
        if (body.error?.code === "DEMO_DAILY_LIMIT_REACHED") {
          throw new Error("La demo alcanzó su límite seguro de 50 pruebas por hoy. Mañana se reinicia automáticamente.");
        }
        throw new Error(body.error?.message || "No fue posible generar la prueba AWS.");
      }

      setRuns((current) => [body.run, ...current.filter((run) => run.id !== body.run.id)]);
      setAttempts((current) => ({ ...current, [body.run.id]: [] }));
      setSelectedId(body.run.id);
      setNotice(
        `Pedido aceptado por AWS. Sigue su recorrido en vivo; quedan ${body.remaining} pruebas disponibles hoy.`
      );

      void (async () => {
        for (const delay of [900, 1_500, 2_400]) {
          await new Promise((resolve) => window.setTimeout(resolve, delay));
          await Promise.all([loadDetail(body.run.id), loadRuns(true)]);
        }
        setNotice("La prueba AWS terminó su primer intento. Ya puedes revisar el resultado y su historial.");
      })();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "No fue posible generar la prueba AWS.");
    } finally {
      setIsGeneratingAwsDemo(false);
    }
  }

  async function copyCorrelation() {
    if (!selected) return;
    await navigator.clipboard?.writeText(selected.correlationId);
    setNotice("Correlation ID copiado.");
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <a className="brand" href="#main" aria-label="IntegrationHub, ir al panel">
          <span className="brand-mark" aria-hidden="true"><i /><i /><i /></span>
          <span>Integration<span>Hub</span></span>
        </a>
        <div className="topbar-context">
          <span className="workspace-mark">NC</span>
          <span><strong>Nébula Commerce</strong><small>Operaciones de integración</small></span>
        </div>
        <div className="topbar-status">
          <span className={`mode-pill ${mode}`}><i />{mode === "connected" ? "DEMO AWS" : "VISTA LOCAL"}</span>
          <span className="region">us-east-1</span>
          <label className="role-switcher">
            <span>ROL ACTUAL</span>
            <select
              value={role}
              onChange={(event) => changeRole(event.target.value as OperatorRole)}
              aria-label="Cambiar rol de demostración"
            >
              {availableRoles.map((availableRole) => (
                <option value={availableRole} key={availableRole}>{roleText[availableRole]}</option>
              ))}
            </select>
          </label>
          <span className="avatar" aria-label={`${roleText[role]} Lisset Lopez`}>LL</span>
        </div>
      </header>

      <main id="main" className="main-content">
        <section className="page-heading" aria-labelledby="page-title">
          <div>
            <p className="eyebrow"><Icon name="pulse" /> Control de entregas</p>
            <h1 id="page-title">Ejecuciones</h1>
          </div>
          <div className="heading-actions">
            {mode === "preview" ? (
              <button className="demo-button" type="button" onClick={() => setDemoPanelOpen((current) => !current)} aria-expanded={demoPanelOpen}>
                <Icon name="bolt" /> Simular entradas
              </button>
            ) : (
              <button
                className="demo-button"
                type="button"
                onClick={() => void generateAwsDemoRun()}
                disabled={isGeneratingAwsDemo || role === "auditor"}
                title={role === "auditor" ? "El rol Auditor es de sólo lectura" : "Crea un pedido real en AWS"}
              >
                <Icon name="bolt" /> {isGeneratingAwsDemo ? "Generando en AWS…" : "Generar prueba AWS"}
              </button>
            )}
            <button className="secondary-button" type="button" onClick={() => void loadRuns()} disabled={isRefreshing}>
              <Icon name="refresh" /> {isRefreshing ? "Actualizando…" : "Actualizar"}
            </button>
          </div>
        </section>

        {mode === "preview" && demoPanelOpen ? (
          <section className="demo-launcher" aria-labelledby="demo-launcher-title">
            <div className="demo-launcher-copy">
              <span className="section-kicker">LABORATORIO DE DEMOSTRACIÓN</span>
              <h2 id="demo-launcher-title">¿Qué tráfico quieres ver entrar?</h2>
              <p>En producción estos avisos llegarían automáticamente. Aquí los provocamos para observar su recorrido en vivo.</p>
            </div>
            <div className="demo-scenarios">
              <button type="button" onClick={() => launchDemoScenario("shipping-timeout")}>
                <span className="scenario-icon">01</span>
                <span><strong>Pedido para envío</strong><small>El proveedor tarda, aparece el fallo temporal y permite reintentar.</small></span>
                <Icon name="arrow" />
              </button>
              <button type="button" onClick={() => launchDemoScenario("invoice-success")}>
                <span className="scenario-icon">02</span>
                <span><strong>Solicitud de factura</strong><small>Recorre cola y proceso; el proveedor fiscal la acepta al primer intento.</small></span>
                <Icon name="arrow" />
              </button>
              <button className="scenario-burst" type="button" onClick={() => launchDemoScenario("traffic-burst")}>
                <span className="scenario-icon">03</span>
                <span><strong>Ráfaga de operación</strong><small>Entran dos envíos y una factura para ver tres ejecuciones trabajando juntas.</small></span>
                <Icon name="arrow" />
              </button>
            </div>
          </section>
        ) : null}

        <section className="metrics" aria-label="Resumen de ejecuciones">
          <article><span>Últimas ejecuciones</span><strong>{metrics.total}</strong><small>ventana visible</small></article>
          <article><span>Tasa de entrega</span><strong>{metrics.success}%</strong><small>en esta muestra</small></article>
          <article className={metrics.needsAction ? "metric-alert" : ""}><span>Requieren acción</span><strong>{metrics.needsAction}</strong><small>pendientes de decisión</small></article>
          <article><span>En movimiento</span><strong>{metrics.active}</strong><small>cola + proceso</small></article>
        </section>

        <section className="operations-grid" aria-label="Mesa de operaciones">
          <aside className="run-panel" aria-label="Lista de ejecuciones">
            <div className="panel-heading">
              <div><span>FLUJOS SUPERVISADOS</span><strong>Envíos + facturación</strong></div>
              <span className="event-chip">Tráfico automático</span>
            </div>
            <div className="run-list" role="list">
              {runs.map((run) => (
                <button
                  type="button"
                  role="listitem"
                  key={run.id}
                  className={`run-row ${run.id === selected?.id ? "selected" : ""}`}
                  onClick={() => selectRun(run.id)}
                  aria-pressed={run.id === selected?.id}
                >
                  <span className={`status-dot status-${caseClosures[run.id] || run.caseStatus === "CLOSED" ? "closed" : run.status.toLowerCase()}`} aria-hidden="true" />
                  <span className="run-copy">
                    <strong>{workflowFor(run).event}</strong>
                    <small>{shortId(run.eventId)}</small>
                  </span>
                  <span className="run-meta">
                    <strong>{time(run.createdAt)}</strong>
                    <small>{caseClosures[run.id] || run.caseStatus === "CLOSED" ? "caso cerrado" : `${run.attemptCount} intento${run.attemptCount === 1 ? "" : "s"}`}</small>
                  </span>
                </button>
              ))}
            </div>
          </aside>

          {selected ? (
            <article className="run-detail" aria-labelledby="run-title">
              <div className="detail-header">
                <div>
                  <span className="section-kicker">EJECUCIÓN {shortId(selected.id)}</span>
                  <h2 id="run-title">{workflowFor(selected).event}</h2>
                  <button className="copy-id" type="button" onClick={() => void copyCorrelation()}>
                    ID de seguimiento: {shortId(selected.correlationId)} <Icon name="copy" />
                  </button>
                </div>
                <span className={`status-badge status-${selectedClosed ? "closed" : selected.status.toLowerCase()}`}>
                  <i />{selectedClosed ? "Cerrado sin entregar" : statusText[selected.status]}
                </span>
              </div>

              <div className="route-map" aria-label="Ruta de la entrega">
                {[
                  ["01", "Recibido", "Aviso verificado"],
                  ["02", "Protegido", "Sin duplicados"],
                  ["03", "En cola", "SQS ordenada"],
                  [
                    "04",
                    "Destino",
                    destinationDetail(selected, selectedAttempts, {
                      closed: selectedClosed,
                      connectionRemediated: selectedRemediated
                    })
                  ]
                ].map(([number, title, detail], index) => (
                  <div className={`route-step ${index === 3 ? `route-${selectedClosed ? "closed" : selected.status.toLowerCase()}` : "route-complete"}`} key={number}>
                    <span>{number}</span><strong>{title}</strong><small>{detail}</small>
                  </div>
                ))}
              </div>

              {decision ? (
                <section className={`decision-card decision-${decision.tone}`} aria-label="Explicación del estado">
                  <div className="decision-icon" aria-hidden="true">{decision.tone === "success" ? "✓" : decision.tone === "danger" ? "!" : decision.tone === "warning" ? "↻" : "…"}</div>
                  <div>
                    <span className="section-kicker">QUÉ SIGNIFICA ESTE ESTADO</span>
                    <h3>{decision.title}</h3>
                    <p>{decision.explanation}</p>
                    <small><strong>Qué sigue:</strong> {decision.next}</small>
                  </div>
                </section>
              ) : null}

              {connectionPanelOpen && selected.status === "FAILED_FINAL" && !selectedClosed ? (
                <section className="connection-fix" aria-labelledby="connection-fix-title">
                  <div className="connection-fix-heading">
                    <div>
                      <span className="section-kicker">CONEXIÓN DEL PROVEEDOR</span>
                      <h3 id="connection-fix-title">{workflowFor(selected).connection}</h3>
                    </div>
                    <span className="connection-health connection-health-error"><i />Credencial rechazada</span>
                  </div>
                  <div className="connection-steps" aria-label="Proceso para corregir la conexión">
                    <span><b>1</b> Reemplazar credencial</span>
                    <span><b>2</b> Guardar de forma segura</span>
                    <span><b>3</b> Habilitar reproceso</span>
                  </div>
                  <label className="credential-field">
                    <span>Nueva credencial de demostración</span>
                    <input
                      type="password"
                      value={credentialDraft}
                      onChange={(event) => setCredentialDraft(event.target.value)}
                      placeholder="Mínimo 8 caracteres"
                      autoComplete="new-password"
                    />
                    <small>En producción se enviaría a un almacén de secretos; nunca se mostraría otra vez.</small>
                  </label>
                  <div className="form-actions">
                    <button className="text-button" type="button" onClick={() => setConnectionPanelOpen(false)}>Cancelar</button>
                    <button className="retry-button" type="button" onClick={() => void repairConnection()} disabled={isTestingConnection}>
                      {isTestingConnection ? "Guardando y verificando…" : "Guardar y probar conexión"}
                    </button>
                  </div>
                </section>
              ) : null}

              <section className="attempts-section" aria-labelledby="attempts-title">
                <div className="section-heading-row">
                  <div>
                    <span className="section-kicker">HISTORIAL INMUTABLE</span>
                    <h3 id="attempts-title">Intentos de entrega</h3>
                    <p className="section-help">Cada fila representa una petición HTTP enviada al proveedor.</p>
                  </div>
                  <span>{selectedAttempts.length} petición{selectedAttempts.length === 1 ? "" : "es"}</span>
                </div>
                <div className="attempt-list">
                  {selectedAttempts.length ? selectedAttempts.map((attempt) => (
                    <article className="attempt" key={attempt.id}>
                      <div className="attempt-number"><span>{attempt.number.toString().padStart(2, "0")}</span><i /></div>
                      <div className="attempt-body">
                        <div>
                          <strong>Entrega a {workflowFor(selected).connection}</strong>
                          <small>{time(attempt.startedAt)} · {attempt.durationMs} ms</small>
                        </div>
                        <p>{attempt.responseSummary ?? "El destino no devolvió contenido."}</p>
                      </div>
                      <span className={`http-code ${attempt.status === "SUCCEEDED" ? "code-ok" : "code-error"}`}>
                        HTTP {attempt.httpStatus ?? "—"}
                      </span>
                    </article>
                  )) : <div className="empty-attempts">La entrega está en curso; el intento aparecerá aquí cuando termine.</div>}
                </div>
              </section>

              {selectedActivity.length ? (
                <section className="case-activity" aria-labelledby="activity-title">
                  <div className="section-heading-row">
                    <div>
                      <span className="section-kicker">AUDITORÍA OPERATIVA</span>
                      <h3 id="activity-title">Actividad del caso</h3>
                      <p className="section-help">Son decisiones y cambios de estado; no equivalen necesariamente a nuevas peticiones.</p>
                    </div>
                    <span>{selectedActivity.length} movimiento{selectedActivity.length === 1 ? "" : "s"}</span>
                  </div>
                  <div className="activity-list">
                    {selectedActivity.map((activity) => (
                      <article key={activity.id}>
                        <i aria-hidden="true" />
                        <div><strong>{activity.title}</strong><p>{activity.detail}</p></div>
                        <small>{time(activity.createdAt)} · {activity.actor}</small>
                      </article>
                    ))}
                  </div>
                </section>
              ) : null}

              {closePanelOpen && closeRule?.allowed ? (
                <form
                  className="close-case-panel"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void closeSelectedCase();
                  }}
                >
                  <div>
                    <span className="section-kicker">DECISIÓN OPERATIVA</span>
                    <h3>Cerrar sin otro intento</h3>
                    <p>La entrega seguirá apareciendo como fallida, pero quedará documentado que no debe intentarse nuevamente.</p>
                  </div>
                  <label>
                    <span>Motivo obligatorio</span>
                    <select value={closeReason} onChange={(event) => setCloseReason(event.target.value)}>
                      {closeReasons.map((reason) => <option value={reason} key={reason}>{reason}</option>)}
                    </select>
                  </label>
                  <label>
                    <span>{closeReason === "Otro motivo" ? "Explica la historia (obligatorio)" : "Historia del caso (opcional)"}</span>
                    <textarea
                      value={closeNote}
                      onChange={(event) => setCloseNote(event.target.value)}
                      placeholder="Qué ocurrió, quién confirmó la decisión y por qué no debe reintentarse"
                      required={closeReason === "Otro motivo"}
                    />
                  </label>
                  <div className="form-actions">
                    <button className="text-button" type="button" onClick={() => setClosePanelOpen(false)}>Cancelar</button>
                    <button className="close-confirm-button" type="submit">Confirmar cierre</button>
                  </div>
                </form>
              ) : null}

              <div className="action-bar">
                <div><Icon name="bolt" /><span><strong>Control operativo</strong><small>Las acciones dependen del estado y del rol activo.</small></span></div>
                <div className="action-buttons">
                  {closeRule?.allowed ? (
                    <button className="close-case-button" type="button" onClick={() => setClosePanelOpen(true)}>
                      Cerrar caso
                    </button>
                  ) : null}
                  <button
                    className="retry-button"
                    type="button"
                    onClick={() => {
                      if (selected.status === "FAILED_FINAL") {
                        if (connectionRule?.allowed) setConnectionPanelOpen(true);
                        else setNotice(connectionRule && !connectionRule.allowed ? connectionRule.reason : "No se puede corregir la conexión.");
                        return;
                      }
                      void retryRunById(selected.id).catch((error: unknown) => {
                        setNotice(error instanceof Error ? error.message : "La acción no está disponible.");
                      });
                    }}
                    disabled={selectedClosed || isRetrying || role === "auditor" || (selected.status !== "FAILED_FINAL" && !retryRule?.allowed)}
                  >
                    {isRetrying
                      ? "Procesando…"
                      : selectedClosed
                        ? "Caso cerrado"
                        : role === "auditor"
                          ? "Sólo lectura"
                          : selected.status === "FAILED_RETRYABLE"
                            ? selectedRemediated ? "Reprocesar pedido" : "Reintentar entrega"
                            : selected.status === "RUNNING"
                              ? "Espera a que termine"
                              : selected.status === "FAILED_FINAL"
                                ? role === "admin" ? "Corregir conexión" : "Requiere administradora"
                                : selected.status === "QUEUED"
                                  ? "Esperando turno"
                                  : "Entrega completada"}
                    <Icon name="arrow" />
                  </button>
                </div>
              </div>
            </article>
          ) : <article className="run-detail empty-state">No hay ejecuciones para inspeccionar.</article>}

          {selected ? (
            <aside className="payload-panel" aria-label="Contexto de la ejecución">
              <div className="payload-title"><Icon name="box" /><span><strong>Contexto</strong><small>Evento original</small></span></div>
              <dl className="facts">
                <div><dt>Flujo</dt><dd>{workflowFor(selected).event} → {workflowFor(selected).action}</dd></div>
                <div><dt>Conexión</dt><dd>{workflowFor(selected).connection}</dd></div>
                <div><dt>Creado</dt><dd>{time(selected.createdAt)}</dd></div>
                <div><dt>Actualizado</dt><dd>{time(selected.updatedAt)}</dd></div>
              </dl>
              <div className="payload-block">
                <div><span>DATOS RECIBIDOS</span><span>{JSON.stringify(selected.payload).length} bytes</span></div>
                <pre>{JSON.stringify(selected.payload, null, 2)}</pre>
              </div>
              <div className="integrity-note"><i /><span><strong>Aviso protegido</strong><small>La clave de deduplicación evita procesar el mismo pedido dos veces.</small></span></div>
            </aside>
          ) : null}
        </section>
      </main>
      <div className="notice" role="status" aria-live="polite">{notice}</div>
    </div>
  );
}
