import { describe, expect, it } from "vitest";

import { ProjectMilestoneError } from "@/modules/projects/application/milestone-service";
import { parseDto } from "@/modules/platform-api/contracts/dto";
import {
  milestoneAchieveBodySchema,
  milestoneCommandPathSchema,
  milestoneLinkTaskBodySchema,
  milestoneVoidBodySchema,
  milestoneVoidTaskLinkBodySchema
} from "@/modules/platform-api/contracts/internal-routes";

import { projectExecutionErrorResponse } from "./project-execution-http";

describe("APM-025 project execution HTTP contract", () => {
  const path = { projectId: "project-1", milestoneId: "milestone-1" };

  it("accepts only explicit milestone command paths and bodies", () => {
    expect(
      parseDto(milestoneCommandPathSchema, { ...path, command: "achieve" }, "path")
    ).toMatchObject({ command: "achieve" });
    expect(
      parseDto(milestoneCommandPathSchema, { ...path, command: "void" }, "path")
    ).toMatchObject({ command: "void" });
    expect(
      parseDto(milestoneCommandPathSchema, { ...path, command: "link-task" }, "path")
    ).toMatchObject({ command: "link-task" });
    expect(
      parseDto(milestoneCommandPathSchema, { ...path, command: "void-task-link" }, "path")
    ).toMatchObject({ command: "void-task-link" });
    expect(() =>
      parseDto(milestoneCommandPathSchema, { ...path, command: "ACHIEVED" }, "path")
    ).toThrow(/请求参数/u);

    expect(
      parseDto(milestoneAchieveBodySchema, { version: 1, reason: "手动确认" }, "body")
    ).toEqual({
      version: 1,
      reason: "手动确认"
    });
    expect(parseDto(milestoneVoidBodySchema, { version: 1, reason: "范围作废" }, "body")).toEqual({
      version: 1,
      reason: "范围作废"
    });
    expect(
      parseDto(
        milestoneLinkTaskBodySchema,
        { version: 1, taskId: "task-1", reason: "关联任务" },
        "body"
      )
    ).toEqual({ version: 1, taskId: "task-1", reason: "关联任务" });
    expect(
      parseDto(
        milestoneVoidTaskLinkBodySchema,
        { version: 1, linkId: "link-1", reason: "关联作废" },
        "body"
      )
    ).toEqual({ version: 1, linkId: "link-1", reason: "关联作废" });
    expect(() =>
      parseDto(
        milestoneAchieveBodySchema,
        { version: 1, status: "ACHIEVED", reason: "绕过命令" },
        "body"
      )
    ).toThrow(/请求参数/u);
  });

  it("maps milestone domain errors to a stable public response", async () => {
    const response = projectExecutionErrorResponse(
      new ProjectMilestoneError("MILESTONE_STATE_INVALID", "当前状态不允许手动达成。", 409)
    );

    expect(response?.status).toBe(409);
    await expect(response?.json()).resolves.toMatchObject({
      error: { code: "MILESTONE_STATE_INVALID", message: "当前状态不允许手动达成。" }
    });
  });
});
