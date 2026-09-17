import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { closeDecision, connectionFixDecision, retryDecision } from "./operations-rules.ts";

describe("operations permissions", () => {
  it("allows an operator to retry a temporary failure", () => {
    assert.equal(
      retryDecision({ status: "FAILED_RETRYABLE", role: "operator", closed: false }).allowed,
      true
    );
  });

  it("requires connection remediation before a permanent failure can be retried", () => {
    const blocked = retryDecision({ status: "FAILED_FINAL", role: "admin", closed: false });
    assert.equal(blocked.allowed, false);
    if (!blocked.allowed) assert.equal(blocked.code, "REMEDIATION_REQUIRED");

    assert.equal(
      retryDecision({
        status: "FAILED_FINAL",
        role: "admin",
        closed: false,
        connectionRemediated: true
      }).allowed,
      true
    );
  });

  it("only lets administrators repair provider credentials", () => {
    assert.equal(
      connectionFixDecision({ status: "FAILED_FINAL", role: "operator", closed: false }).allowed,
      false
    );
    assert.equal(
      connectionFixDecision({ status: "FAILED_FINAL", role: "admin", closed: false }).allowed,
      true
    );
  });

  it("lets operators close a failed case but never lets auditors mutate it", () => {
    assert.equal(
      closeDecision({ status: "FAILED_RETRYABLE", role: "operator", closed: false }).allowed,
      true
    );
    assert.equal(
      closeDecision({ status: "FAILED_RETRYABLE", role: "auditor", closed: false }).allowed,
      false
    );
  });

  it("blocks every retry after a case is closed", () => {
    const decision = retryDecision({ status: "FAILED_RETRYABLE", role: "admin", closed: true });
    assert.equal(decision.allowed, false);
    if (!decision.allowed) assert.equal(decision.code, "CASE_CLOSED");
  });
});
