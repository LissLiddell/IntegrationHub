import type { OperatorRole, RunStatus } from "./types";

export type { OperatorRole } from "./types";

export const roleText: Record<OperatorRole, string> = {
  operator: "Operadora",
  admin: "Administradora",
  auditor: "Auditora"
};

export interface OperationContext {
  status: RunStatus;
  role: OperatorRole;
  closed: boolean;
  connectionRemediated?: boolean;
}

export type RuleDecision =
  | { allowed: true; code: "ALLOWED" }
  | {
      allowed: false;
      code: "CASE_CLOSED" | "READ_ONLY" | "REMEDIATION_REQUIRED" | "STATUS_NOT_ELIGIBLE";
      reason: string;
    };

export function retryDecision(context: OperationContext): RuleDecision {
  if (context.closed) {
    return { allowed: false, code: "CASE_CLOSED", reason: "El caso está cerrado y no admite más entregas." };
  }
  if (context.role === "auditor") {
    return { allowed: false, code: "READ_ONLY", reason: "El rol de auditoría sólo puede consultar el historial." };
  }
  if (context.status === "FAILED_RETRYABLE") return { allowed: true, code: "ALLOWED" };
  if (context.status === "FAILED_FINAL" && context.connectionRemediated) {
    return { allowed: true, code: "ALLOWED" };
  }
  if (context.status === "FAILED_FINAL") {
    return {
      allowed: false,
      code: "REMEDIATION_REQUIRED",
      reason: "Primero debe reemplazarse y verificarse la credencial del proveedor."
    };
  }
  return {
    allowed: false,
    code: "STATUS_NOT_ELIGIBLE",
    reason: "La ejecución todavía está activa o ya terminó correctamente."
  };
}

export function connectionFixDecision(context: OperationContext): RuleDecision {
  if (context.closed) {
    return { allowed: false, code: "CASE_CLOSED", reason: "El caso está cerrado." };
  }
  if (context.role !== "admin") {
    return {
      allowed: false,
      code: "READ_ONLY",
      reason: "Sólo una administradora puede cambiar credenciales y verificar conexiones."
    };
  }
  if (context.status !== "FAILED_FINAL") {
    return {
      allowed: false,
      code: "STATUS_NOT_ELIGIBLE",
      reason: "Esta ejecución no necesita corregir su conexión."
    };
  }
  return { allowed: true, code: "ALLOWED" };
}

export function closeDecision(context: OperationContext): RuleDecision {
  if (context.closed) {
    return { allowed: false, code: "CASE_CLOSED", reason: "El caso ya está cerrado." };
  }
  if (context.role === "auditor") {
    return { allowed: false, code: "READ_ONLY", reason: "El rol de auditoría no puede cerrar casos." };
  }
  if (context.status !== "FAILED_RETRYABLE" && context.status !== "FAILED_FINAL") {
    return {
      allowed: false,
      code: "STATUS_NOT_ELIGIBLE",
      reason: "Sólo puede cerrarse una entrega que terminó con fallo."
    };
  }
  return { allowed: true, code: "ALLOWED" };
}
