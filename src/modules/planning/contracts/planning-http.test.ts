import { describe, expect, it } from "vitest";

import { parseDto } from "@/modules/platform-api/contracts/dto";
import { ApiContractError } from "@/modules/platform-api/contracts/errors";
import {
  createPlanningTaskBodySchema,
  createWbsNodeBodySchema,
  planningTaskProgressBodySchema,
  updatePlanningTaskBodySchema
} from "@/modules/platform-api/contracts/internal-routes";

const taskBody = {
  code: "MECH.DESIGN.01",
  name: "机械详细设计",
  description: null,
  wbsNodeId: "wbs-design",
  responsibilityPackageId: "package-design",
  deliveryUnitId: "machine-01",
  moduleId: "module-01",
  ownerMembershipId: "membership-owner",
  position: 0,
  plannedStartAt: "2026-08-03T00:00:00.000Z",
  plannedFinishAt: "2026-08-10T00:00:00.000Z",
  plannedDurationMinutes: 2400,
  weight: 25,
  reason: "创建机械设计任务"
};

describe("APM-020 planning HTTP contracts", () => {
  it("accepts strict WBS and task definitions", () => {
    expect(
      parseDto(
        createWbsNodeBodySchema,
        { code: "DESIGN", name: "详细设计", parentId: null, position: 0, reason: "创建WBS" },
        "body"
      )
    ).toMatchObject({ code: "DESIGN", position: 0 });
    expect(parseDto(createPlanningTaskBodySchema, taskBody, "body")).toEqual(taskBody);
    const { code: _code, ...updateBody } = taskBody;
    expect(
      parseDto(updatePlanningTaskBodySchema, { ...updateBody, version: 1 }, "body")
    ).toMatchObject({ version: 1, weight: 25 });
  });

  it("rejects unknown future-package and derived progress fields", () => {
    expect(() =>
      parseDto(createPlanningTaskBodySchema, { ...taskBody, dependencyIds: [] }, "body")
    ).toThrowError(ApiContractError);
    expect(() =>
      parseDto(createPlanningTaskBodySchema, { ...taskBody, critical: true }, "body")
    ).toThrowError(ApiContractError);
    expect(() =>
      parseDto(
        planningTaskProgressBodySchema,
        {
          version: 1,
          actualStartAt: taskBody.plannedStartAt,
          remainingDurationMinutes: 1200,
          forecastFinishAt: taskBody.plannedFinishAt,
          status: "IN_PROGRESS",
          reason: "更新进度"
        },
        "body"
      )
    ).toThrowError(ApiContractError);
  });
});
