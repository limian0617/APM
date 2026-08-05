import { describe, expect, it } from "vitest";

import {
  buildExecutionPageState,
  isExecutionFixture,
  type ProjectExecutionDto
} from "./execution-page-state";

const calculatedAt = "2026-08-04T09:30:00.000Z";

function executionData(overrides: Partial<ProjectExecutionDto> = {}): ProjectExecutionDto {
  return {
    project: {
      projectId: "project-1",
      code: "APM-025",
      name: "项目执行页",
      status: "ACTIVE"
    },
    progress: {
      status: "READY",
      completedWorkdays: 2,
      totalWorkdays: 5,
      percent: 40,
      calculatedAt
    },
    schedule: {
      status: "SUCCEEDED",
      stale: false,
      inputVersion: 3,
      publishedInputVersion: 3,
      requestedAt: calculatedAt,
      calculatedAt,
      algorithmVersion: "cpm-v1",
      projectFinishAt: "2026-08-15T00:00:00.000Z",
      error: null
    },
    tasks: [
      {
        taskId: "task-critical",
        code: "COMMISSIONING.SAFETY",
        name: "安全联锁调试",
        status: "IN_PROGRESS",
        position: 10,
        plannedStartAt: "2026-08-01T00:00:00.000Z",
        plannedFinishAt: "2026-08-10T00:00:00.000Z",
        actualStartAt: "2026-08-02T00:00:00.000Z",
        actualFinishAt: null,
        forecastFinishAt: "2026-08-13T00:00:00.000Z",
        predictedStartAt: "2026-08-02T00:00:00.000Z",
        predictedFinishAt: "2026-08-13T00:00:00.000Z",
        isCritical: true,
        responsibilityPackage: {
          packageId: "package-1",
          code: "MECH.DEBUG",
          name: "机械调试",
          status: "ACCEPTED"
        },
        owner: { userId: "user-1", name: "王工" }
      }
    ],
    criticalExceptions: [
      {
        kind: "CRITICAL_PATH_DELAY",
        taskId: "task-critical",
        code: "COMMISSIONING.SAFETY",
        name: "安全联锁调试",
        plannedFinishAt: "2026-08-10T00:00:00.000Z",
        predictedFinishAt: "2026-08-13T00:00:00.000Z"
      }
    ],
    responsibilityPackages: [
      {
        packageId: "package-1",
        code: "MECH.DEBUG",
        name: "机械调试",
        status: "ACCEPTED",
        acceptedAt: calculatedAt,
        closedAt: null,
        effectiveTaskCount: 1
      }
    ],
    milestones: [
      {
        milestoneId: "milestone-next",
        code: "FAT.READY",
        name: "FAT 准备",
        description: null,
        position: 10,
        targetAt: "2026-08-14T00:00:00.000Z",
        status: "PENDING",
        achievementSource: null,
        achievedAt: null,
        voidedAt: null,
        resourceVersion: 1,
        links: []
      },
      {
        milestoneId: "milestone-done",
        code: "DESIGN.FREEZE",
        name: "设计冻结",
        description: null,
        position: 0,
        targetAt: "2026-08-01T00:00:00.000Z",
        status: "ACHIEVED",
        achievementSource: "MANUAL",
        achievedAt: calculatedAt,
        voidedAt: null,
        resourceVersion: 2,
        links: []
      }
    ],
    ...overrides
  } as ProjectExecutionDto;
}

describe("APM-025 execution page state", () => {
  it("only recognizes explicit development fixtures", () => {
    expect(isExecutionFixture(undefined)).toBe(false);
    expect(isExecutionFixture("normal")).toBe(true);
    expect(isExecutionFixture("denied")).toBe(true);
    expect(isExecutionFixture("secret-project")).toBe(false);
  });

  it("maps loading, denied, and retryable errors without a data DTO", () => {
    expect(buildExecutionPageState({ kind: "loading" })).toEqual({ kind: "loading" });
    expect(
      buildExecutionPageState({ kind: "error", status: 403, message: "当前角色无权查看项目。" })
    ).toEqual({ kind: "denied" });
    expect(
      buildExecutionPageState({ kind: "error", status: 503, message: "预测服务暂不可用。" })
    ).toEqual({ kind: "error", message: "预测服务暂不可用。", retryable: true });
  });

  it("maps an execution DTO with no effective tasks to the empty state", () => {
    const state = buildExecutionPageState({
      kind: "success",
      data: executionData({ progress: { status: "EMPTY", calculatedAt }, tasks: [] })
    });

    expect(state).toMatchObject({ kind: "empty", calculatedAt });
  });

  it("keeps task rows while exposing stale and calculation-pending notices", () => {
    const state = buildExecutionPageState({
      kind: "success",
      data: executionData({
        schedule: {
          ...executionData().schedule,
          status: "PENDING",
          stale: true,
          calculatedAt
        }
      })
    });

    expect(state).toMatchObject({
      kind: "populated",
      tasks: [{ taskId: "task-critical" }],
      notices: [{ kind: "STALE", timestamp: calculatedAt }, { kind: "CALCULATION_PENDING" }]
    });
  });

  it("surfaces failed calculations and archived read-only state without hiding details", () => {
    const state = buildExecutionPageState({
      kind: "success",
      data: executionData({
        project: { ...executionData().project, status: "CLOSED" },
        schedule: {
          ...executionData().schedule,
          status: "FAILED",
          error: { code: "SCHEDULE_FAILED", message: "预测计算失败。" }
        }
      })
    });

    expect(state).toMatchObject({
      kind: "populated",
      isReadOnly: true,
      criticalTasks: [{ taskId: "task-critical" }],
      nextMilestone: { milestoneId: "milestone-next" },
      notices: [{ kind: "CALCULATION_FAILED", message: "预测计算失败。" }, { kind: "ARCHIVED" }]
    });
  });

  it("keeps normal populated content in exception-first order", () => {
    const state = buildExecutionPageState({ kind: "success", data: executionData() });

    expect(state).toMatchObject({
      kind: "populated",
      progress: { completedWorkdays: 2, totalWorkdays: 5, percent: 40, calculatedAt },
      exceptions: [{ taskId: "task-critical" }],
      nextMilestone: { milestoneId: "milestone-next" },
      criticalTasks: [{ taskId: "task-critical" }],
      responsibilityPackages: [{ packageId: "package-1" }],
      notices: []
    });
    if (state.kind !== "populated") throw new Error("期望已加载的项目执行状态。");
    expect(state.milestones).toEqual(
      expect.arrayContaining([expect.objectContaining({ milestoneId: "milestone-next" })])
    );
  });
});
