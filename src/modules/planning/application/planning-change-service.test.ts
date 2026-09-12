import { describe, expect, it } from "vitest";

import { PlanningChangeError } from "../domain/planning-change";

import {
  createPlanningChange,
  decidePlanningChange,
  parsePlanningChangeApprovalConfiguration,
  submitPlanningChange
} from "./planning-change-service";

function expectError(error: unknown, code: string, status: number) {
  expect(error).toBeInstanceOf(PlanningChangeError);
  const failure = error as PlanningChangeError;
  expect(failure.code).toBe(code);
  expect(failure.status).toBe(status);
}

const command = {
  projectId: "project-1",
  actorId: "user-1",
  auditContext: {
    actorId: "user-1",
    requestId: "request-1",
    traceId: "trace-1",
    source: "API",
    sourceIp: "127.0.0.1",
    userAgent: "Vitest",
    reason: null,
    projectId: null,
    departmentId: "engineering",
    operationId: "operation-1"
  }
} as const;

describe("APM-024 planning change approval configuration", () => {
  it("accepts an explicit ALL/ANY mode with unique declared project roles", () => {
    expect(
      parsePlanningChangeApprovalConfiguration({
        mode: "ALL",
        projectRoles: ["PROJECT_MANAGER", "QUALITY"]
      })
    ).toEqual({ mode: "ALL", projectRoles: ["PROJECT_MANAGER", "QUALITY"] });
    expect(
      parsePlanningChangeApprovalConfiguration({ mode: "ANY", projectRoles: ["QUALITY"] })
    ).toEqual({ mode: "ANY", projectRoles: ["QUALITY"] });
  });

  it("rejects a missing approval configuration without inventing defaults", () => {
    for (const value of [undefined, null, "ALL", 42, []]) {
      try {
        parsePlanningChangeApprovalConfiguration(value);
        throw new Error("expected a rejection");
      } catch (error) {
        expectError(error, "PLANNING_CHANGE_APPROVER_CONFIGURATION_MISSING", 422);
      }
    }
  });

  it("rejects an unknown approval mode", () => {
    for (const mode of ["MAJORITY", "all", "", 1, null]) {
      try {
        parsePlanningChangeApprovalConfiguration({ mode, projectRoles: ["QUALITY"] });
        throw new Error("expected a rejection");
      } catch (error) {
        expectError(error, "PLANNING_CHANGE_APPROVER_CONFIGURATION_INVALID", 422);
      }
    }
  });

  it("rejects empty, duplicated, unknown or non-string approval roles", () => {
    for (const projectRoles of [
      [],
      ["QUALITY", "QUALITY"],
      ["SUPER_ADMIN"],
      ["QUALITY", 7],
      "QUALITY",
      null
    ]) {
      try {
        parsePlanningChangeApprovalConfiguration({ mode: "ANY", projectRoles });
        throw new Error("expected a rejection");
      } catch (error) {
        expectError(error, "PLANNING_CHANGE_APPROVER_CONFIGURATION_INVALID", 422);
      }
    }
  });
});

describe("APM-024 planning change command validation", () => {
  it("rejects an invalid classification before touching the database", async () => {
    await expect(
      createPlanningChange({
        ...command,
        classification: "DRAFT" as never,
        reason: "创建变更",
        planningInputVersion: 1,
        resultingPlanningInputVersion: 1,
        delta: {}
      })
    ).rejects.toSatisfy((error: unknown) => {
      expectError(error, "PLANNING_CHANGE_CLASSIFICATION_INVALID", 422);
      return true;
    });
  });

  it("rejects blank and overlong reasons before touching the database", async () => {
    for (const reason of ["   ", "x".repeat(1025)]) {
      await expect(
        createPlanningChange({
          ...command,
          classification: "FORMAL",
          reason,
          planningInputVersion: 1,
          resultingPlanningInputVersion: 1,
          delta: {}
        })
      ).rejects.toSatisfy((error: unknown) => {
        expectError(error, "REASON_REQUIRED", 422);
        return true;
      });
    }
  });

  it("rejects a non-positive version for submit and decide", async () => {
    for (const version of [0, -1, 1.5]) {
      await expect(
        submitPlanningChange({
          ...command,
          changeId: "change-1",
          version,
          reason: "提交变更",
          approvalMode: "ALL",
          approverProjectRoles: ["QUALITY"]
        })
      ).rejects.toSatisfy((error: unknown) => {
        expectError(error, "PLANNING_CHANGE_VERSION_INVALID", 422);
        return true;
      });
      await expect(
        decidePlanningChange({
          ...command,
          changeId: "change-1",
          version,
          decision: "APPROVED",
          reason: "审批通过"
        })
      ).rejects.toSatisfy((error: unknown) => {
        expectError(error, "PLANNING_CHANGE_VERSION_INVALID", 422);
        return true;
      });
    }
  });

  it("rejects an approval configuration that makes submit unsatisfiable", async () => {
    await expect(
      submitPlanningChange({
        ...command,
        changeId: "change-1",
        version: 1,
        reason: "提交变更",
        approvalMode: "ANY",
        approverProjectRoles: ["SUPER_ADMIN"]
      })
    ).rejects.toSatisfy((error: unknown) => {
      expectError(error, "PLANNING_CHANGE_APPROVER_CONFIGURATION_INVALID", 422);
      return true;
    });
  });
});
