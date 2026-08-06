import { describe, expect, it } from "vitest";

import {
  COCKPIT_DASHBOARD_FIXTURES,
  COCKPIT_DASHBOARD_VIEWS,
  buildCockpitDashboardPageState,
  cockpitDashboardApiPaths,
  developmentCockpitDashboardFixture,
  fetchCockpitDashboardSource,
  isCockpitDashboardFixture,
  parseCockpitDashboardResponse,
  cockpitDashboardHref,
  riskCellQuery,
  safeProjectDrilldownPath,
  selectRiskCell,
  selectedCockpitView,
  type AlertsResponseDto,
  type CockpitDashboardSources,
  type CockpitProjectionDto,
  type ExecutionDashboardDto,
  type IssuesResponseDto,
  type StagesResponseDto
} from "./cockpit-dashboard-page-state";

const projectId = "project-1";
const calculatedAt = "2026-08-06T08:00:00.000Z";

function cockpitData(overrides: Partial<CockpitProjectionDto> = {}): CockpitProjectionDto {
  return {
    projectionId: "projection-1",
    projectId,
    sourceChecksum: "a".repeat(64),
    health: "HEALTHY",
    calculatedAt,
    exceptions: [],
    ...overrides
  };
}

function executionData(overrides: Partial<ExecutionDashboardDto> = {}): ExecutionDashboardDto {
  return {
    project: { projectId, code: "APM-041", name: "驾驶舱状态合同", status: "ACTIVE" },
    progress: {
      status: "READY",
      completedWorkdays: 20,
      totalWorkdays: 100,
      percent: 20,
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
      projectFinishAt: "2026-11-14T00:00:00.000Z",
      error: null
    },
    tasks: [],
    criticalExceptions: [],
    responsibilityPackages: [],
    milestones: [],
    ...overrides
  };
}

function stagesData(overrides: Partial<StagesResponseDto> = {}): StagesResponseDto {
  return {
    projectStages: [
      {
        projectId,
        projectStageId: "stage-s0",
        code: "S0",
        name: "项目启动",
        sequence: 0,
        status: "IN_PROGRESS",
        exceptionalReason: null,
        statusChangedAt: "2026-08-05T09:00:00.000Z",
        version: 2,
        allowedActions: ["AWAIT_GATE"]
      }
    ],
    deliveryUnitStages: [],
    releases: [],
    ...overrides
  };
}

function alertsData(overrides: Partial<AlertsResponseDto> = {}): AlertsResponseDto {
  return {
    items: [],
    todos: [],
    freshness: {
      status: "SUCCEEDED",
      requestedAt: "2026-08-06T07:55:00.000Z",
      completedAt: "2026-08-06T07:56:00.000Z",
      errorCode: null,
      errorMessage: null
    },
    ...overrides
  };
}

function issuesData(overrides: Partial<IssuesResponseDto> = {}): IssuesResponseDto {
  return { issues: [], nextCursor: null, ...overrides };
}

function readySources(overrides: Partial<CockpitDashboardSources> = {}): CockpitDashboardSources {
  return {
    projectId,
    cockpit: { kind: "success", data: { status: "READY", projection: cockpitData() } },
    execution: { kind: "success", data: executionData() },
    stages: { kind: "success", data: stagesData() },
    alerts: { kind: "success", data: alertsData() },
    issues: { kind: "success", data: issuesData() },
    ...overrides
  };
}

describe("APM-041 cockpit dashboard page state", () => {
  it("accepts only the named development fixtures", () => {
    expect(COCKPIT_DASHBOARD_FIXTURES).toEqual([
      "normal",
      "loading",
      "empty",
      "error",
      "denied",
      "stale",
      "pending",
      "failed",
      "partial-denied"
    ]);
    expect(isCockpitDashboardFixture("normal")).toBe(true);
    expect(isCockpitDashboardFixture("partial-denied")).toBe(true);
    expect(isCockpitDashboardFixture("project-42")).toBe(false);
    expect(developmentCockpitDashboardFixture(projectId, "normal", "production")).toBeNull();
    expect(developmentCockpitDashboardFixture(projectId, "project-42", "development")).toBeNull();
    expect(developmentCockpitDashboardFixture(projectId, "normal", "development")).not.toBeNull();
  });

  it("constructs all five project-local API paths from the current project ID", () => {
    expect(cockpitDashboardApiPaths("project/1")).toEqual({
      cockpit: "/api/projects/project%2F1/cockpit",
      execution: "/api/projects/project%2F1/execution",
      stages: "/api/projects/project%2F1/stages",
      alerts: "/api/projects/project%2F1/alerts?limit=100",
      issues: "/api/projects/project%2F1/issues?limit=100"
    });
  });

  it("maps HTTP, JSON and network failures without exposing internal details", async () => {
    await expect(
      parseCockpitDashboardResponse<{ ok: true }>(
        new Response(JSON.stringify({ ok: true }), { status: 200 }),
        "驾驶舱读取失败。"
      )
    ).resolves.toEqual({ kind: "success", data: { ok: true } });
    await expect(
      parseCockpitDashboardResponse(
        new Response(JSON.stringify({ error: { message: "服务暂不可用。", stack: "secret" } }), {
          status: 503
        }),
        "驾驶舱读取失败。"
      )
    ).resolves.toEqual({ kind: "error", status: 503, message: "服务暂不可用。" });
    await expect(
      parseCockpitDashboardResponse(new Response("not-json", { status: 200 }), "驾驶舱读取失败。")
    ).resolves.toEqual({ kind: "error", status: 502, message: "驾驶舱读取失败。" });
    await expect(
      fetchCockpitDashboardSource(
        "/api/projects/project-1/cockpit",
        "网络连接不可用。",
        async () => {
          throw new Error("internal stack");
        }
      )
    ).resolves.toEqual({ kind: "error", status: 503, message: "网络连接不可用。" });
  });

  it("uses no-store when reading a source", async () => {
    let requestInit: RequestInit | undefined;
    await fetchCockpitDashboardSource(
      "/api/projects/project-1/cockpit",
      "驾驶舱读取失败。",
      async (_input, init) => {
        requestInit = init;
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
    );
    expect(requestInit).toMatchObject({ cache: "no-store" });
  });

  it("maps loading of a primary source to page-level loading", () => {
    expect(
      buildCockpitDashboardPageState({ ...readySources(), cockpit: { kind: "loading" } })
    ).toEqual({ kind: "loading" });
  });

  it("maps a missing cockpit projection to explicit not-available", () => {
    expect(
      buildCockpitDashboardPageState({
        ...readySources(),
        cockpit: { kind: "success", data: { status: "NOT_AVAILABLE", projection: null } }
      })
    ).toEqual({ kind: "not-available" });
  });

  it.each(["cockpit", "execution", "stages"] as const)(
    "maps %s 401/403 to page-level denied",
    (source) => {
      expect(
        buildCockpitDashboardPageState({
          ...readySources(),
          [source]: { kind: "error", status: 403, message: "无权读取。" }
        })
      ).toEqual({ kind: "denied" });
    }
  );

  it("restricts forbidden optional sources without retaining their response data", () => {
    const state = buildCockpitDashboardPageState({
      ...readySources(),
      alerts: { kind: "error", status: 403, message: "无权读取预警。" },
      issues: { kind: "error", status: 401, message: "未登录。" }
    });

    expect(state).toMatchObject({
      kind: "populated",
      alerts: { kind: "restricted" },
      issues: { kind: "restricted" }
    });
    if (state.kind !== "populated") throw new Error("expected populated dashboard");
    expect(state.alerts).toEqual({ kind: "restricted" });
    expect(state.issues).toEqual({ kind: "restricted" });
    expect(state.risk).toBeNull();
    expect(state.issueSummary).toBeNull();
  });

  it("keeps optional ordinary errors local and marks retryable failures", () => {
    const state = buildCockpitDashboardPageState({
      ...readySources(),
      alerts: { kind: "error", status: 503, message: "扫描服务暂不可用。" },
      issues: { kind: "error", status: 422, message: "请求参数无效。" }
    });

    expect(state).toMatchObject({ kind: "populated" });
    if (state.kind !== "populated") throw new Error("expected populated dashboard");
    expect(state.alerts).toEqual({
      kind: "error",
      message: "扫描服务暂不可用。",
      retryable: true
    });
    expect(state.issues).toEqual({ kind: "error", message: "请求参数无效。", retryable: false });
  });

  it("accepts an authorized alert todo without rule details", () => {
    const state = buildCockpitDashboardPageState({
      ...readySources(),
      alerts: { kind: "success", data: alertsData({ todos: [{ projectId }] }) }
    });

    expect(state.kind).toBe("populated");
  });

  it.each([
    ["stale", { schedule: { ...executionData().schedule, stale: true } }],
    ["pending", { schedule: { ...executionData().schedule, status: "PENDING" } }],
    [
      "failed",
      {
        schedule: {
          ...executionData().schedule,
          status: "FAILED",
          error: { code: "CPM_FAILED", message: "计算失败。" }
        }
      }
    ]
  ] as const)("maps execution %s to a distinct page state", (kind, execution) => {
    const state = buildCockpitDashboardPageState({
      ...readySources(),
      execution: { kind: "success", data: executionData(execution) }
    });
    expect(state.kind).toBe(kind);
  });

  it("maps an execution response without effective work to page-level empty", () => {
    const state = buildCockpitDashboardPageState({
      ...readySources(),
      execution: {
        kind: "success",
        data: executionData({ progress: { status: "EMPTY", calculatedAt } })
      }
    });

    expect(state.kind).toBe("empty");
  });

  it("keeps an authorized empty risk matrix as all nine cells", () => {
    const state = buildCockpitDashboardPageState(readySources());
    expect(state).toMatchObject({ kind: "populated", risk: { cells: expect.any(Array) } });
    if (state.kind !== "populated" || !state.risk) throw new Error("expected risk matrix");
    expect(state.risk.cells).toHaveLength(9);
    expect(state.risk.cells.every((cell) => cell.count === 0)).toBe(true);
  });

  it("groups active alerts in HIGH/HIGH and rejects an invalid cell", () => {
    const state = buildCockpitDashboardPageState({
      ...readySources(),
      alerts: {
        kind: "success",
        data: alertsData({
          items: [
            {
              id: "alert-high-high",
              projectId,
              sourceType: "GATE_HARD_FAILURE",
              sourceKey: "gate-1",
              status: "TRIGGERED",
              probability: "HIGH",
              impact: "HIGH",
              lastObservedAt: calculatedAt,
              rule: { code: "GATE.HARD_FAILURE", name: "Gate硬失败", status: "ACTIVE" }
            },
            {
              id: "alert-closed",
              projectId,
              sourceType: "MILESTONE_OVERDUE",
              sourceKey: "milestone-1",
              status: "CLOSED",
              probability: "HIGH",
              impact: "HIGH",
              lastObservedAt: calculatedAt,
              rule: { code: "MILESTONE.OVERDUE", name: "里程碑逾期", status: "ACTIVE" }
            }
          ]
        })
      }
    });

    expect(state).toMatchObject({ kind: "populated", risk: { cells: expect.any(Array) } });
    if (state.kind !== "populated") throw new Error("expected populated dashboard");
    expect(state.risk?.cells.find((cell) => cell.key === "HIGH:HIGH")?.count).toBe(1);
    expect(selectRiskCell(state, "HIGH:HIGH")?.items).toHaveLength(1);
    expect(selectRiskCell(state, "UNKNOWN:HIGH")).toBeNull();
  });

  it("summarizes only authorized severe and overdue issues using real fields", () => {
    const state = buildCockpitDashboardPageState({
      ...readySources(),
      issues: {
        kind: "success",
        data: issuesData({
          issues: [
            {
              id: "issue-severe",
              projectId,
              title: "安全联锁异常",
              severity: "CRITICAL",
              status: "PROCESSING",
              dueDate: "2026-08-05",
              isOverdue: true,
              ownerMembershipId: "member-1",
              owner: { membershipId: "member-1", userId: "user-1", name: "王工", active: true },
              updatedAt: calculatedAt
            },
            {
              id: "issue-normal",
              projectId,
              title: "外观待确认",
              severity: "LOW",
              status: "PROCESSING",
              dueDate: "2026-08-05",
              isOverdue: true,
              ownerMembershipId: "member-2",
              owner: null,
              updatedAt: calculatedAt
            },
            {
              id: "issue-closed-severe",
              projectId,
              title: "已关闭的严重问题",
              severity: "HIGH",
              status: "CLOSED",
              dueDate: "2026-08-05",
              isOverdue: false,
              ownerMembershipId: null,
              owner: null,
              updatedAt: calculatedAt
            }
          ]
        })
      }
    });

    expect(state).toMatchObject({ kind: "populated" });
    if (state.kind !== "populated") throw new Error("expected populated dashboard");
    expect(state.issueSummary?.severe.map((issue) => issue.id)).toEqual([
      "issue-severe",
      "issue-closed-severe"
    ]);
    expect(state.issueSummary?.overdue.map((issue) => issue.id)).toEqual([
      "issue-severe",
      "issue-normal"
    ]);
  });

  it("falls back to overview for an unknown view and excludes resource-load", () => {
    expect(COCKPIT_DASHBOARD_VIEWS).toEqual(["overview", "progress", "risks"]);
    expect(selectedCockpitView(null)).toBe("overview");
    expect(selectedCockpitView("risks")).toBe("risks");
    expect(selectedCockpitView("resource-load")).toBe("overview");
    expect(selectedCockpitView("not-a-view")).toBe("overview");
  });

  it("builds stable project-local view URLs and clears risk selection outside risks", () => {
    expect(cockpitDashboardHref(projectId, "overview", "HIGH:HIGH")).toBe(
      "/projects/project-1/cockpit?view=overview"
    );
    expect(cockpitDashboardHref(projectId, "progress", "HIGH:HIGH")).toBe(
      "/projects/project-1/cockpit?view=progress"
    );
    expect(cockpitDashboardHref(projectId, "risks", "HIGH:HIGH")).toBe(
      "/projects/project-1/cockpit?view=risks&risk=HIGH%3AHIGH"
    );
    expect(cockpitDashboardHref(projectId, "risks", "HIGH:HIGH", "normal")).toBe(
      "/projects/project-1/cockpit?view=risks&risk=HIGH%3AHIGH&fixture=normal"
    );
    expect(cockpitDashboardHref(projectId, "risks", "HIGH:HIGH", "untrusted")).toBe(
      "/projects/project-1/cockpit?view=risks&risk=HIGH%3AHIGH"
    );
    expect(riskCellQuery("HIGH:HIGH")).toBe("risk=HIGH%3AHIGH");
    expect(riskCellQuery("UNKNOWN:HIGH")).toBeNull();
  });

  it("keeps source timestamps separate instead of inventing a global timestamp", () => {
    const state = buildCockpitDashboardPageState({
      ...readySources(),
      cockpit: {
        kind: "success",
        data: {
          status: "READY",
          projection: cockpitData({ calculatedAt: "2026-08-06T08:01:00.000Z" })
        }
      },
      execution: {
        kind: "success",
        data: executionData({
          progress: { ...executionData().progress, calculatedAt: "2026-08-06T08:02:00.000Z" },
          schedule: { ...executionData().schedule, calculatedAt: "2026-08-06T08:03:00.000Z" }
        })
      },
      alerts: {
        kind: "success",
        data: alertsData({
          freshness: {
            status: "SUCCEEDED",
            requestedAt: "2026-08-06T08:04:00.000Z",
            completedAt: "2026-08-06T08:05:00.000Z",
            errorCode: null,
            errorMessage: null
          }
        })
      },
      issues: {
        kind: "success",
        data: issuesData({
          issues: [
            {
              id: "issue-1",
              projectId,
              title: "问题",
              severity: "LOW",
              status: "PROCESSING",
              dueDate: null,
              isOverdue: false,
              ownerMembershipId: null,
              owner: null,
              updatedAt: "2026-08-06T08:06:00.000Z"
            }
          ]
        })
      }
    });

    expect(state).toMatchObject({
      kind: "populated",
      sourceTimestamps: {
        cockpit: "2026-08-06T08:01:00.000Z",
        execution: {
          progressCalculatedAt: "2026-08-06T08:02:00.000Z",
          scheduleCalculatedAt: "2026-08-06T08:03:00.000Z"
        },
        alerts: { completedAt: "2026-08-06T08:05:00.000Z" }
      }
    });
    if (state.kind !== "populated") throw new Error("expected populated dashboard");
    expect(state.sourceTimestamps).not.toHaveProperty("global");
    expect(state.sourceTimestamps.issues).toEqual(["2026-08-06T08:06:00.000Z"]);
    expect(state.sourceTimestamps.stages).toEqual(["2026-08-05T09:00:00.000Z"]);
  });

  it("allows only current-project relative drill-down paths", () => {
    expect(safeProjectDrilldownPath(projectId, "/projects/{projectId}/issues/issue-1")).toBe(
      "/projects/project-1/issues/issue-1"
    );
    expect(safeProjectDrilldownPath(projectId, "/api/projects/{projectId}/alerts")).toBe(
      "/api/projects/project-1/alerts"
    );
    expect(safeProjectDrilldownPath(projectId, "/projects/project-2/issues/issue-1")).toBeNull();
    expect(
      safeProjectDrilldownPath(projectId, "https://example.com/projects/project-1")
    ).toBeNull();
    expect(safeProjectDrilldownPath(projectId, "//example.com/projects/project-1")).toBeNull();
  });
});
