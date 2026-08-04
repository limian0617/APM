import { describe, expect, it } from "vitest";

import { parseDto } from "@/modules/platform-api/contracts/dto";
import { ApiContractError } from "@/modules/platform-api/contracts/errors";
import {
  createPlanningBaselineBodySchema,
  planningBaselinePathSchema
} from "@/modules/platform-api/contracts/internal-routes";

import { PlanningBaselineError } from "../domain/planning-baseline";
import { planningBaselineErrorResponse } from "./planning-http";

describe("APM-023 planning baseline HTTP contracts", () => {
  const body = {
    planningInputVersion: 3,
    reason: "G1 已批准，冻结项目执行基线"
  };

  it("accepts an exact baseline-freeze request and project-scoped path", () => {
    expect(parseDto(createPlanningBaselineBodySchema, body, "body")).toEqual(body);
    expect(
      parseDto(
        planningBaselinePathSchema,
        { projectId: "project-1", baselineId: "baseline-1" },
        "path"
      )
    ).toEqual({ projectId: "project-1", baselineId: "baseline-1" });
  });

  it("rejects non-positive planning input versions", () => {
    for (const planningInputVersion of [0, -1]) {
      expect(() =>
        parseDto(createPlanningBaselineBodySchema, { ...body, planningInputVersion }, "body")
      ).toThrowError(ApiContractError);
    }
  });

  it("rejects blank and overlong baseline-freeze reasons", () => {
    for (const reason of ["   ", "x".repeat(1025)]) {
      expect(() =>
        parseDto(createPlanningBaselineBodySchema, { ...body, reason }, "body")
      ).toThrowError(ApiContractError);
    }
  });

  it("rejects unknown request and path fields", () => {
    expect(() =>
      parseDto(
        createPlanningBaselineBodySchema,
        { ...body, sourceGateSubmissionId: "gate-1" },
        "body"
      )
    ).toThrowError(ApiContractError);
    expect(() =>
      parseDto(
        planningBaselinePathSchema,
        { projectId: "project-1", baselineId: "baseline-1", version: "1" },
        "path"
      )
    ).toThrowError(ApiContractError);
  });

  it("maps planning baseline errors to stable API errors", async () => {
    const response = planningBaselineErrorResponse(
      new PlanningBaselineError("PLANNING_BASELINE_NOT_FOUND", "计划基线不存在。", 404)
    );

    expect(response?.status).toBe(404);
    await expect(response?.json()).resolves.toMatchObject({
      error: { code: "PLANNING_BASELINE_NOT_FOUND", message: "计划基线不存在。" }
    });
  });
});
