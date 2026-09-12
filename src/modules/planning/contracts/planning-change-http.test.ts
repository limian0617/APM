import { describe, expect, it } from "vitest";

import { parseDto } from "@/modules/platform-api/contracts/dto";
import { ApiContractError } from "@/modules/platform-api/contracts/errors";
import {
  createPlanningChangeBodySchema,
  decidePlanningChangeBodySchema,
  planningChangePathSchema,
  submitPlanningChangeBodySchema
} from "@/modules/platform-api/contracts/internal-routes";

import { PlanningChangeError } from "../domain/planning-change";
import { planningChangeErrorResponse } from "./planning-http";

const changeBody = {
  classification: "FORMAL",
  planningInputVersion: 3,
  resultingPlanningInputVersion: 4,
  delta: { tasks: [{ id: "task-a", plannedFinishAt: "2026-09-20" }] },
  reason: "客户确认延长合同交期"
};

const submitBody = {
  version: 1,
  approvalMode: "ALL",
  approverProjectRoles: ["PROJECT_MANAGER", "QUALITY"],
  reason: "提交计划变更审批"
};

const decideBody = {
  version: 2,
  decision: "APPROVED",
  reason: "审批通过"
};

describe("APM-024 planning change HTTP contracts", () => {
  it("accepts exact create, submit, decide bodies and a project-scoped path", () => {
    expect(parseDto(createPlanningChangeBodySchema, changeBody, "body")).toEqual(changeBody);
    expect(parseDto(submitPlanningChangeBodySchema, submitBody, "body")).toEqual(submitBody);
    expect(parseDto(decidePlanningChangeBodySchema, decideBody, "body")).toEqual(decideBody);
    expect(
      parseDto(planningChangePathSchema, { projectId: "project-1", changeId: "change-1" }, "path")
    ).toEqual({ projectId: "project-1", changeId: "change-1" });
  });

  it("rejects classifications and approval modes outside the declared enums", () => {
    expect(() =>
      parseDto(createPlanningChangeBodySchema, { ...changeBody, classification: "DRAFT" }, "body")
    ).toThrowError(ApiContractError);
    expect(() =>
      parseDto(submitPlanningChangeBodySchema, { ...submitBody, approvalMode: "MAJORITY" }, "body")
    ).toThrowError(ApiContractError);
    expect(() =>
      parseDto(decidePlanningChangeBodySchema, { ...decideBody, decision: "ABSTAIN" }, "body")
    ).toThrowError(ApiContractError);
  });

  it("rejects non-positive input and resource versions", () => {
    for (const planningInputVersion of [0, -1]) {
      expect(() =>
        parseDto(createPlanningChangeBodySchema, { ...changeBody, planningInputVersion }, "body")
      ).toThrowError(ApiContractError);
    }
    expect(() =>
      parseDto(
        createPlanningChangeBodySchema,
        { ...changeBody, resultingPlanningInputVersion: 0 },
        "body"
      )
    ).toThrowError(ApiContractError);
    expect(() =>
      parseDto(submitPlanningChangeBodySchema, { ...submitBody, version: 0 }, "body")
    ).toThrowError(ApiContractError);
  });

  it("requires an explicit approval configuration and rejects unknown roles", () => {
    const { approvalMode, approverProjectRoles, ...withoutApproval } = submitBody;
    expect(() => parseDto(submitPlanningChangeBodySchema, withoutApproval, "body")).toThrowError(
      ApiContractError
    );
    expect(() =>
      parseDto(submitPlanningChangeBodySchema, { ...withoutApproval, approvalMode }, "body")
    ).toThrowError(ApiContractError);
    expect(() =>
      parseDto(submitPlanningChangeBodySchema, { ...withoutApproval, approverProjectRoles }, "body")
    ).toThrowError(ApiContractError);
    expect(() =>
      parseDto(submitPlanningChangeBodySchema, { ...submitBody, approverProjectRoles: [] }, "body")
    ).toThrowError(ApiContractError);
    expect(() =>
      parseDto(
        submitPlanningChangeBodySchema,
        { ...submitBody, approverProjectRoles: ["SUPER_ADMIN"] },
        "body"
      )
    ).toThrowError(ApiContractError);
  });

  it("rejects a delta that is not a JSON object and blank or overlong reasons", () => {
    for (const delta of [[], "delay", 3, null]) {
      expect(() =>
        parseDto(createPlanningChangeBodySchema, { ...changeBody, delta }, "body")
      ).toThrowError(ApiContractError);
    }
    for (const reason of ["   ", "x".repeat(1025)]) {
      expect(() =>
        parseDto(createPlanningChangeBodySchema, { ...changeBody, reason }, "body")
      ).toThrowError(ApiContractError);
      expect(() =>
        parseDto(decidePlanningChangeBodySchema, { ...decideBody, reason }, "body")
      ).toThrowError(ApiContractError);
    }
  });

  it("rejects unknown request and path fields", () => {
    expect(() =>
      parseDto(createPlanningChangeBodySchema, { ...changeBody, approverProjectRoles: [] }, "body")
    ).toThrowError(ApiContractError);
    expect(() =>
      parseDto(submitPlanningChangeBodySchema, { ...submitBody, approvedById: "user-1" }, "body")
    ).toThrowError(ApiContractError);
    expect(() =>
      parseDto(
        planningChangePathSchema,
        { projectId: "project-1", changeId: "change-1", submit: "true" },
        "path"
      )
    ).toThrowError(ApiContractError);
  });

  it("maps planning change errors to stable API errors", async () => {
    const response = planningChangeErrorResponse(
      new PlanningChangeError("PLANNING_CHANGE_NOT_FOUND", "计划变更不存在。", 404)
    );

    expect(response?.status).toBe(404);
    await expect(response?.json()).resolves.toMatchObject({
      error: { code: "PLANNING_CHANGE_NOT_FOUND", message: "计划变更不存在。" }
    });
  });

  it("leaves non-planning-change errors unmapped", () => {
    expect(planningChangeErrorResponse(new Error("其他错误"))).toBeNull();
  });
});
