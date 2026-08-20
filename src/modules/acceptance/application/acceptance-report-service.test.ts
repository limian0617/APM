import { describe, expect, it } from "vitest";

import type { AuditContext } from "@/modules/audit/contracts/audit";

import { createControlledReportObjectKey, snapshotReadAudit } from "./acceptance-report-service";

function auditContext(operationId: string): AuditContext {
  return {
    actorId: "actor-1",
    requestId: "request-1",
    traceId: "trace-1",
    source: "API",
    sourceIp: null,
    userAgent: null,
    reason: null,
    projectId: "project-1",
    departmentId: null,
    operationId
  };
}

describe("APM-102 controlled report storage", () => {
  it("generates an opaque UUID file-object key for each generated report", () => {
    const objectKey = createControlledReportObjectKey();

    expect(objectKey).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
    );
    expect(objectKey).not.toContain("/");
  });

  it("derives non-colliding auditable snapshot phases without exceeding the audit limit", () => {
    const sameBase = "report-snapshot-operation";
    const replay = snapshotReadAudit(
      { actorId: "actor-1", auditContext: auditContext(sameBase) },
      "historical-replay"
    ).auditContext.operationId;
    const current = snapshotReadAudit(
      { actorId: "actor-1", auditContext: auditContext(sameBase) },
      "current-authoritative"
    ).auditContext.operationId;
    const sharedPrefix = "x".repeat(220);
    const historicalFirst = snapshotReadAudit(
      { actorId: "actor-1", auditContext: auditContext(`${sharedPrefix}first`) },
      "historical-replay"
    ).auditContext.operationId;
    const historicalSecond = snapshotReadAudit(
      { actorId: "actor-1", auditContext: auditContext(`${sharedPrefix}second`) },
      "historical-replay"
    ).auditContext.operationId;
    const authoritativeFirst = snapshotReadAudit(
      { actorId: "actor-1", auditContext: auditContext(`${sharedPrefix}first`) },
      "current-authoritative"
    ).auditContext.operationId;
    const authoritativeSecond = snapshotReadAudit(
      { actorId: "actor-1", auditContext: auditContext(`${sharedPrefix}second`) },
      "current-authoritative"
    ).auditContext.operationId;

    expect(replay).toBe(`${sameBase}:historical-replay`);
    expect(current).toBe(`${sameBase}:current-authoritative`);
    expect(replay).not.toBe(current);
    expect(historicalFirst).toMatch(/:historical-replay$/u);
    expect(historicalSecond).toMatch(/:historical-replay$/u);
    expect(historicalFirst).not.toBe(historicalSecond);
    expect(authoritativeFirst).toMatch(/:current-authoritative$/u);
    expect(authoritativeSecond).toMatch(/:current-authoritative$/u);
    expect(authoritativeFirst).not.toBe(authoritativeSecond);
    for (const operationId of [
      historicalFirst,
      historicalSecond,
      authoritativeFirst,
      authoritativeSecond
    ]) {
      expect(operationId?.length).toBeLessThanOrEqual(191);
    }
  });
});
