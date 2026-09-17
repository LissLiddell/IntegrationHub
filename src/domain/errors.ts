export class DomainError extends Error {
  readonly code: "INVALID_EVENT" | "WORKFLOW_NOT_FOUND" | "WORKFLOW_INACTIVE";

  constructor(
    code: "INVALID_EVENT" | "WORKFLOW_NOT_FOUND" | "WORKFLOW_INACTIVE",
    message: string
  ) {
    super(message);
    this.name = "DomainError";
    this.code = code;
  }
}
