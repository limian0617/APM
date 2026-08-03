import { describe, expect, it } from "vitest";

import { parseDto } from "@/modules/platform-api/contracts/dto";
import { ApiContractError } from "@/modules/platform-api/contracts/errors";
import {
  createTaskDependencyBodySchema,
  saveProjectCalendarBodySchema,
  updateTaskDependencyBodySchema
} from "@/modules/platform-api/contracts/internal-routes";

const calendarBody = {
  version: 0,
  name: "项目标准工作日历",
  timeZone: "Asia/Shanghai",
  weeklyRules: [
    {
      dayOfWeek: 1,
      intervals: [
        { startMinute: 480, endMinute: 720 },
        { startMinute: 780, endMinute: 1020 }
      ]
    }
  ],
  exceptions: [{ date: "2026-10-01", intervals: [] }],
  reason: "配置项目工作日历"
};

describe("APM-021 schedule network HTTP contracts", () => {
  it("accepts strict calendar and FS/SS/FF dependency DTOs", () => {
    expect(parseDto(saveProjectCalendarBodySchema, calendarBody, "body")).toEqual(calendarBody);
    expect(
      parseDto(
        createTaskDependencyBodySchema,
        {
          predecessorTaskId: "task-a",
          successorTaskId: "task-b",
          dependencyType: "SS",
          lagMinutes: -480,
          reason: "建立任务依赖"
        },
        "body"
      )
    ).toMatchObject({ dependencyType: "SS", lagMinutes: -480 });
  });

  it("rejects unknown fields, SF dependencies, and future CPM output", () => {
    expect(() =>
      parseDto(saveProjectCalendarBodySchema, { ...calendarBody, workingHoursPerDay: 8 }, "body")
    ).toThrowError(ApiContractError);
    expect(() =>
      parseDto(
        createTaskDependencyBodySchema,
        {
          predecessorTaskId: "task-a",
          successorTaskId: "task-b",
          dependencyType: "SF",
          lagMinutes: 0,
          reason: "非法依赖"
        },
        "body"
      )
    ).toThrowError(ApiContractError);
    expect(() =>
      parseDto(
        updateTaskDependencyBodySchema,
        {
          version: 1,
          dependencyType: "FS",
          lagMinutes: 0,
          critical: true,
          reason: "不得提交计算结果"
        },
        "body"
      )
    ).toThrowError(ApiContractError);
  });
});
