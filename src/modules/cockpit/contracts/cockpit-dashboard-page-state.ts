import type { ProjectExecutionDto } from "@/modules/planning/contracts/execution-page-state";

export const COCKPIT_DASHBOARD_VIEWS = ["overview", "progress", "risks"] as const;
export type CockpitDashboardView = (typeof COCKPIT_DASHBOARD_VIEWS)[number];

export const RISK_LEVELS = ["LOW", "MEDIUM", "HIGH"] as const;
export type RiskLevel = (typeof RISK_LEVELS)[number];
export type RiskCellKey = `${RiskLevel}:${RiskLevel}`;

export type CockpitProjectionDto = {
  projectionId: string;
  projectId: string;
  sourceChecksum: string;
  health: "UNKNOWN" | "HEALTHY" | "ATTENTION" | "CRITICAL";
  calculatedAt: string;
  exceptions: Array<{
    exceptionId: string;
    kind: string;
    sourceKey: string;
    severity: string;
    summary: string;
    occurredAt: string | null;
    drilldownPath: string;
    position: number;
  }>;
};

export type CockpitResponseDto =
  | { status: "READY"; projection: CockpitProjectionDto }
  | { status: "NOT_AVAILABLE"; projection: null };

export type ExecutionDashboardDto = ProjectExecutionDto;

export type StageDashboardDto = {
  projectId: string;
  projectStageId: string;
  deliveryUnitStageId?: string;
  deliveryUnitId?: string;
  sourceSnapshotComponentId?: string;
  code?: string;
  name?: string;
  description?: string;
  sequence?: number;
  status: string;
  exceptionalReason: string | null;
  statusChangedAt: string;
  version: number;
  allowedActions: string[];
};

export type StagesResponseDto = {
  projectStages: StageDashboardDto[];
  deliveryUnitStages: StageDashboardDto[];
  releases: Array<{
    projectId: string;
    stageReleaseAuthorizationId: string;
    scope: string;
    status: string;
    fromProjectStageId: string;
    toProjectStageId: string;
    deliveryUnitId: string | null;
    reason: string;
    authorizedById: string;
    authorizedAt: string;
    revokedAt: string | null;
  }>;
};

export type AlertDashboardDto = {
  id: string;
  projectId: string;
  sourceType: string;
  sourceKey: string;
  status: string;
  probability: string;
  impact: string;
  lastObservedAt: string | null;
  rule: { code: string; name: string; status: string };
};

export type AlertFreshnessDto = {
  status: string;
  requestedAt: string | null;
  completedAt: string | null;
  errorCode: string | null;
  errorMessage: string | null;
};

export type AlertTodoDashboardDto = Pick<AlertDashboardDto, "projectId">;

export type AlertsResponseDto = {
  items: AlertDashboardDto[];
  todos: AlertTodoDashboardDto[];
  freshness: AlertFreshnessDto;
};

export type IssueDashboardDto = {
  id: string;
  projectId: string;
  title: string;
  severity: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  status: "PENDING_ACCEPTANCE" | "ANALYZING" | "PROCESSING" | "PENDING_VERIFICATION" | "CLOSED";
  dueDate: string | null;
  isOverdue: boolean;
  ownerMembershipId: string | null;
  owner: {
    membershipId: string;
    userId: string;
    name: string;
    active: boolean;
  } | null;
  updatedAt: string;
};

export type IssuesResponseDto = {
  issues: IssueDashboardDto[];
  nextCursor: string | null;
};

export type DashboardFetchResult<T> =
  | { kind: "loading" }
  | { kind: "error"; status: number; message: string }
  | { kind: "success"; data: T };

export const COCKPIT_DASHBOARD_FIXTURES = [
  "normal",
  "loading",
  "empty",
  "error",
  "denied",
  "stale",
  "pending",
  "failed",
  "partial-denied"
] as const;

export type CockpitDashboardFixture = (typeof COCKPIT_DASHBOARD_FIXTURES)[number];

export function isCockpitDashboardFixture(
  value: string | undefined
): value is CockpitDashboardFixture {
  return (
    value !== undefined && COCKPIT_DASHBOARD_FIXTURES.includes(value as CockpitDashboardFixture)
  );
}

export type CockpitDashboardApiPaths = {
  cockpit: string;
  execution: string;
  stages: string;
  alerts: string;
  issues: string;
};

export function cockpitDashboardApiPaths(projectId: string): CockpitDashboardApiPaths {
  const encodedProjectId = encodeURIComponent(projectId);
  const root = `/api/projects/${encodedProjectId}`;
  return {
    cockpit: `${root}/cockpit`,
    execution: `${root}/execution`,
    stages: `${root}/stages`,
    alerts: `${root}/alerts?limit=100`,
    issues: `${root}/issues?limit=100`
  };
}

function errorMessage(payload: unknown, fallbackMessage: string): string {
  if (typeof payload !== "object" || payload === null || !("error" in payload)) {
    return fallbackMessage;
  }
  const error = payload.error;
  if (typeof error !== "object" || error === null || !("message" in error)) {
    return fallbackMessage;
  }
  return typeof error.message === "string" && error.message.trim()
    ? error.message
    : fallbackMessage;
}

export async function parseCockpitDashboardResponse<T>(
  response: Response,
  fallbackMessage: string
): Promise<DashboardFetchResult<T>> {
  const payload = await response.json().catch(() => undefined);
  if (!response.ok) {
    return {
      kind: "error",
      status: response.status,
      message: errorMessage(payload, fallbackMessage)
    };
  }
  if (payload === undefined) {
    return { kind: "error", status: 502, message: fallbackMessage };
  }
  return { kind: "success", data: payload as T };
}

export async function fetchCockpitDashboardSource<T>(
  path: string,
  fallbackMessage: string,
  fetcher: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> = fetch
): Promise<DashboardFetchResult<T>> {
  try {
    const response = await fetcher(path, { cache: "no-store" });
    return await parseCockpitDashboardResponse<T>(response, fallbackMessage);
  } catch {
    return { kind: "error", status: 503, message: fallbackMessage };
  }
}

export async function loadCockpitDashboardSources(
  projectId: string,
  fetcher: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> = fetch
): Promise<CockpitDashboardSources> {
  const paths = cockpitDashboardApiPaths(projectId);
  const [cockpit, execution, stages, alerts, issues] = await Promise.all([
    fetchCockpitDashboardSource<CockpitResponseDto>(paths.cockpit, "驾驶舱读取失败。", fetcher),
    fetchCockpitDashboardSource<ExecutionDashboardDto>(
      paths.execution,
      "计划执行读取失败。",
      fetcher
    ),
    fetchCockpitDashboardSource<StagesResponseDto>(paths.stages, "项目阶段读取失败。", fetcher),
    fetchCockpitDashboardSource<AlertsResponseDto>(paths.alerts, "项目预警读取失败。", fetcher),
    fetchCockpitDashboardSource<IssuesResponseDto>(paths.issues, "项目问题读取失败。", fetcher)
  ]);
  return { projectId, cockpit, execution, stages, alerts, issues };
}

export type CockpitDashboardSources = {
  projectId: string;
  cockpit: DashboardFetchResult<CockpitResponseDto>;
  execution: DashboardFetchResult<ExecutionDashboardDto>;
  stages: DashboardFetchResult<StagesResponseDto>;
  alerts: DashboardFetchResult<AlertsResponseDto>;
  issues: DashboardFetchResult<IssuesResponseDto>;
};

function developmentCockpitDashboardSources(projectId: string): CockpitDashboardSources {
  const calculatedAt = "2026-08-06T08:00:00.000Z";
  const execution: ExecutionDashboardDto = {
    project: { projectId, code: "DEMO-COCKPIT", name: "驾驶舱演示项目", status: "IN_PROGRESS" },
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
    criticalExceptions: [
      {
        kind: "CRITICAL_PATH_DELAY",
        taskId: "demo-task-critical",
        code: "COMMISSIONING.SAFETY",
        name: "安全联锁调试",
        plannedFinishAt: "2026-08-10T00:00:00.000Z",
        predictedFinishAt: "2026-08-13T00:00:00.000Z"
      }
    ],
    responsibilityPackages: [],
    milestones: [
      {
        milestoneId: "demo-milestone-next",
        code: "FAT.READY",
        name: "FAT 准备",
        description: "客户验收前置条件确认。",
        position: 10,
        targetAt: "2026-08-14T00:00:00.000Z",
        status: "PENDING",
        achievementSource: null,
        achievedAt: null,
        voidedAt: null,
        resourceVersion: 1,
        links: []
      }
    ]
  };
  const sources: CockpitDashboardSources = {
    projectId,
    cockpit: {
      kind: "success",
      data: {
        status: "READY",
        projection: {
          projectionId: "demo-cockpit-projection",
          projectId,
          sourceChecksum: "a".repeat(64),
          health: "CRITICAL",
          calculatedAt,
          exceptions: [
            {
              exceptionId: "demo-exception-gate",
              kind: "GATE_HARD_FAILURE",
              sourceKey: "gate-1",
              severity: "CRITICAL",
              summary: "Gate G1 存在硬失败检查项。",
              occurredAt: calculatedAt,
              drilldownPath: "/api/projects/{projectId}/gates",
              position: 1
            }
          ]
        }
      }
    },
    execution: { kind: "success", data: execution },
    stages: {
      kind: "success",
      data: {
        projectStages: [
          {
            projectId,
            projectStageId: "stage-s0",
            code: "S0",
            name: "项目启动",
            sequence: 0,
            status: "IN_PROGRESS",
            exceptionalReason: null,
            statusChangedAt: calculatedAt,
            version: 2,
            allowedActions: ["AWAIT_GATE"]
          }
        ],
        deliveryUnitStages: [],
        releases: []
      }
    },
    alerts: {
      kind: "success",
      data: {
        items: [
          {
            id: "demo-alert-high-high",
            projectId,
            sourceType: "GATE_HARD_FAILURE",
            sourceKey: "gate-1",
            status: "TRIGGERED",
            probability: "HIGH",
            impact: "HIGH",
            lastObservedAt: calculatedAt,
            rule: { code: "GATE.HARD_FAILURE", name: "Gate 硬失败", status: "ACTIVE" }
          }
        ],
        todos: [{ projectId }],
        freshness: {
          status: "SUCCEEDED",
          requestedAt: "2026-08-06T07:55:00.000Z",
          completedAt: "2026-08-06T07:56:00.000Z",
          errorCode: null,
          errorMessage: null
        }
      }
    },
    issues: {
      kind: "success",
      data: {
        issues: [
          {
            id: "demo-issue-severe",
            projectId,
            title: "安全联锁异常",
            severity: "CRITICAL",
            status: "PROCESSING",
            dueDate: "2026-08-05",
            isOverdue: true,
            ownerMembershipId: "demo-member-1",
            owner: {
              membershipId: "demo-member-1",
              userId: "demo-user-1",
              name: "王工",
              active: true
            },
            updatedAt: calculatedAt
          }
        ],
        nextCursor: null
      }
    }
  };
  return sources;
}

export function developmentCockpitDashboardFixture(
  projectId: string,
  fixture: string | undefined,
  environment = process.env.NODE_ENV
): CockpitDashboardSources | null {
  if (environment !== "development" || !isCockpitDashboardFixture(fixture)) return null;
  const sources = developmentCockpitDashboardSources(projectId);
  if (fixture === "loading") return { ...sources, cockpit: { kind: "loading" } };
  if (fixture === "error") {
    return {
      ...sources,
      cockpit: { kind: "error", status: 503, message: "驾驶舱读取暂不可用。" }
    };
  }
  if (fixture === "denied") {
    return {
      ...sources,
      cockpit: { kind: "error", status: 403, message: "当前角色无权查看项目驾驶舱。" }
    };
  }
  if (fixture === "empty") {
    const execution = successfulData(sources.execution);
    return {
      ...sources,
      execution: {
        kind: "success",
        data: {
          ...execution,
          progress: { status: "EMPTY", calculatedAt: execution.progress.calculatedAt }
        }
      }
    };
  }
  if (fixture === "stale") {
    const execution = successfulData(sources.execution);
    return {
      ...sources,
      execution: {
        kind: "success",
        data: { ...execution, schedule: { ...execution.schedule, stale: true } }
      }
    };
  }
  if (fixture === "pending") {
    const execution = successfulData(sources.execution);
    return {
      ...sources,
      execution: {
        kind: "success",
        data: { ...execution, schedule: { ...execution.schedule, status: "PENDING" } }
      }
    };
  }
  if (fixture === "failed") {
    const execution = successfulData(sources.execution);
    return {
      ...sources,
      execution: {
        kind: "success",
        data: {
          ...execution,
          schedule: {
            ...execution.schedule,
            status: "FAILED",
            error: { code: "SCHEDULE_RECALCULATION_FAILED", message: "预测计算失败。" }
          }
        }
      }
    };
  }
  if (fixture === "partial-denied") {
    return {
      ...sources,
      alerts: { kind: "error", status: 403, message: "无权读取项目预警。" },
      issues: { kind: "error", status: 403, message: "无权读取项目问题。" }
    };
  }
  return sources;
}

export type OptionalDashboardSection<T> =
  | { kind: "loading" }
  | { kind: "ready"; data: T }
  | { kind: "restricted" }
  | { kind: "error"; message: string; retryable: boolean };

export type RiskCellItem = {
  alertId: string;
  projectId: string;
  sourceType: string;
  sourceKey: string;
  status: "TRIGGERED" | "ACKNOWLEDGED" | "IN_PROGRESS";
  probability: RiskLevel;
  impact: RiskLevel;
  observedAt: string | null;
  ruleCode: string;
};

export type RiskCell = {
  key: RiskCellKey;
  probability: RiskLevel;
  impact: RiskLevel;
  count: number;
  items: RiskCellItem[];
};

export type RiskMatrix = { cells: RiskCell[] };

export type IssueSummaryItem = {
  id: string;
  projectId: string;
  title: string;
  severity: IssueDashboardDto["severity"];
  status: IssueDashboardDto["status"];
  dueDate: string | null;
  isOverdue: boolean;
  ownerMembershipId: string | null;
  owner: IssueDashboardDto["owner"];
  updatedAt: string;
};

export type IssueSummary = {
  severe: IssueSummaryItem[];
  overdue: IssueSummaryItem[];
};

export type DashboardSourceTimestamps = {
  cockpit: string;
  execution: {
    progressCalculatedAt: string;
    scheduleRequestedAt: string | null;
    scheduleCalculatedAt: string | null;
  };
  stages: string[];
  alerts: AlertFreshnessDto | null;
  issues: string[] | null;
};

type DashboardData = {
  projectId: string;
  cockpit: {
    projectionId: string;
    health: CockpitProjectionDto["health"];
    calculatedAt: string;
    exceptions: Array<{
      exceptionId: string;
      kind: string;
      sourceKey: string;
      severity: string;
      summary: string;
      occurredAt: string | null;
      drilldownPath: string | null;
      position: number;
    }>;
  };
  execution: {
    project: ExecutionDashboardDto["project"];
    progress: ExecutionDashboardDto["progress"];
    schedule: ExecutionDashboardDto["schedule"];
    criticalExceptions: ExecutionDashboardDto["criticalExceptions"];
    milestones: ExecutionDashboardDto["milestones"];
  };
  stages: {
    projectStages: StageDashboardDto[];
    deliveryUnitStages: StageDashboardDto[];
  };
  alerts: OptionalDashboardSection<{ freshness: AlertFreshnessDto }>;
  issues: OptionalDashboardSection<{ updatedAt: string[] }>;
  risk: RiskMatrix | null;
  issueSummary: IssueSummary | null;
  sourceTimestamps: DashboardSourceTimestamps;
};

export type CockpitDashboardDataState =
  | (DashboardData & { kind: "populated" })
  | (DashboardData & { kind: "empty" })
  | (DashboardData & { kind: "stale" })
  | (DashboardData & { kind: "pending" })
  | (DashboardData & { kind: "failed"; message: string });

export type CockpitDashboardPageState =
  | { kind: "loading" }
  | { kind: "denied" }
  | { kind: "error"; message: string; retryable: boolean }
  | { kind: "not-available" }
  | { kind: "failed"; message: string }
  | CockpitDashboardDataState;

const ACTIVE_ALERT_STATUSES = ["TRIGGERED", "ACKNOWLEDGED", "IN_PROGRESS"] as const;
const ISSUE_SEVERE_LEVELS = ["HIGH", "CRITICAL"] as const;

function isRiskLevel(value: string): value is RiskLevel {
  return RISK_LEVELS.includes(value as RiskLevel);
}

function isActiveAlertStatus(value: string): value is RiskCellItem["status"] {
  return ACTIVE_ALERT_STATUSES.includes(value as RiskCellItem["status"]);
}

function isSevereIssue(value: IssueDashboardDto["severity"]): boolean {
  return ISSUE_SEVERE_LEVELS.includes(value as (typeof ISSUE_SEVERE_LEVELS)[number]);
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

function isProjectScopedPath(path: string, projectId: string): boolean {
  const encodedProjectId = encodeURIComponent(projectId);
  const roots = [`/projects/${encodedProjectId}`, `/api/projects/${encodedProjectId}`];
  return roots.some((root) => path === root || path.startsWith(`${root}/`));
}

export function safeProjectDrilldownPath(projectId: string, target: string): string | null {
  if (!projectId || !target || target.includes("\\") || target.startsWith("//")) return null;
  const replaced = target.replaceAll("{projectId}", encodeURIComponent(projectId));
  if (!replaced.startsWith("/")) return null;

  let url: URL;
  try {
    url = new URL(replaced, "http://apm-dashboard.local");
  } catch {
    return null;
  }
  if (
    url.origin !== "http://apm-dashboard.local" ||
    !isProjectScopedPath(url.pathname, projectId)
  ) {
    return null;
  }
  return `${url.pathname}${url.search}`;
}

function optionalSection<T>(
  result: DashboardFetchResult<T>,
  projectId: string,
  valid: (data: T) => boolean
): OptionalDashboardSection<T> {
  if (result.kind === "loading") return { kind: "loading" };
  if (result.kind === "error") {
    if (result.status === 401 || result.status === 403) return { kind: "restricted" };
    return {
      kind: "error",
      message: result.message,
      retryable: isRetryableStatus(result.status)
    };
  }
  if (!valid(result.data)) {
    return { kind: "error", message: `项目 ${projectId} 的读取范围无效。`, retryable: false };
  }
  return { kind: "ready", data: result.data };
}

function allProjectIdsMatch(projectId: string, values: readonly string[]): boolean {
  return values.every((value) => value === projectId);
}

function buildRiskMatrix(projectId: string, data: AlertsResponseDto): RiskMatrix {
  const cells = RISK_LEVELS.flatMap((probability) =>
    RISK_LEVELS.map((impact) => {
      const items = data.items.flatMap((alert): RiskCellItem[] => {
        if (
          alert.projectId !== projectId ||
          !isActiveAlertStatus(alert.status) ||
          !isRiskLevel(alert.probability) ||
          !isRiskLevel(alert.impact) ||
          alert.probability !== probability ||
          alert.impact !== impact
        ) {
          return [];
        }
        return [
          {
            alertId: alert.id,
            projectId: alert.projectId,
            sourceType: alert.sourceType,
            sourceKey: alert.sourceKey,
            status: alert.status,
            probability: alert.probability,
            impact: alert.impact,
            observedAt: alert.lastObservedAt,
            ruleCode: alert.rule.code
          }
        ];
      });
      return {
        key: `${probability}:${impact}` as RiskCellKey,
        probability,
        impact,
        count: items.length,
        items
      };
    })
  );
  return { cells };
}

function issueSummary(projectId: string, data: IssuesResponseDto): IssueSummary {
  const items = data.issues
    .filter((issue) => issue.projectId === projectId)
    .map((issue) => ({
      id: issue.id,
      projectId: issue.projectId,
      title: issue.title,
      severity: issue.severity,
      status: issue.status,
      dueDate: issue.dueDate,
      isOverdue: issue.isOverdue,
      ownerMembershipId: issue.ownerMembershipId,
      owner: issue.owner,
      updatedAt: issue.updatedAt
    }));
  return {
    severe: items.filter((issue) => isSevereIssue(issue.severity)),
    overdue: items.filter((issue) => issue.isOverdue)
  };
}

function timestampList(values: readonly { statusChangedAt: string }[]): string[] {
  return values.map((value) => value.statusChangedAt);
}

function primaryFailure(
  result: DashboardFetchResult<unknown>
):
  | { kind: "loading" }
  | { kind: "denied" }
  | { kind: "error"; message: string; retryable: boolean }
  | null {
  if (result.kind === "loading") return { kind: "loading" };
  if (result.kind === "error") {
    if (result.status === 401 || result.status === 403) return { kind: "denied" };
    return { kind: "error", message: result.message, retryable: isRetryableStatus(result.status) };
  }
  return null;
}

function successfulData<T>(result: DashboardFetchResult<T>): T {
  if (result.kind !== "success") throw new Error("主要驾驶舱来源未成功返回。");
  return result.data;
}

function buildDashboardData(
  projectId: string,
  cockpit: CockpitProjectionDto,
  execution: ExecutionDashboardDto,
  stages: StagesResponseDto,
  alerts: OptionalDashboardSection<AlertsResponseDto>,
  issues: OptionalDashboardSection<IssuesResponseDto>
): DashboardData {
  const risk = alerts.kind === "ready" ? buildRiskMatrix(projectId, alerts.data) : null;
  const summary = issues.kind === "ready" ? issueSummary(projectId, issues.data) : null;
  const safeExceptions = cockpit.exceptions.map((exception) => ({
    ...exception,
    drilldownPath: safeProjectDrilldownPath(projectId, exception.drilldownPath)
  }));
  return {
    projectId,
    cockpit: {
      projectionId: cockpit.projectionId,
      health: cockpit.health,
      calculatedAt: cockpit.calculatedAt,
      exceptions: safeExceptions
    },
    execution: {
      project: execution.project,
      progress: execution.progress,
      schedule: execution.schedule,
      criticalExceptions: execution.criticalExceptions,
      milestones: execution.milestones
    },
    stages: {
      projectStages: stages.projectStages,
      deliveryUnitStages: stages.deliveryUnitStages
    },
    alerts:
      alerts.kind === "ready"
        ? { kind: "ready", data: { freshness: alerts.data.freshness } }
        : alerts,
    issues:
      issues.kind === "ready"
        ? {
            kind: "ready",
            data: { updatedAt: issues.data.issues.map((issue) => issue.updatedAt) }
          }
        : issues,
    risk,
    issueSummary: summary,
    sourceTimestamps: {
      cockpit: cockpit.calculatedAt,
      execution: {
        progressCalculatedAt: execution.progress.calculatedAt,
        scheduleRequestedAt: execution.schedule.requestedAt,
        scheduleCalculatedAt: execution.schedule.calculatedAt
      },
      stages: timestampList([...stages.projectStages, ...stages.deliveryUnitStages]),
      alerts: alerts.kind === "ready" ? alerts.data.freshness : null,
      issues: issues.kind === "ready" ? issues.data.issues.map((issue) => issue.updatedAt) : null
    }
  };
}

export function buildCockpitDashboardPageState(
  input: CockpitDashboardSources
): CockpitDashboardPageState {
  for (const result of [input.cockpit, input.execution, input.stages]) {
    const failure = primaryFailure(result);
    if (failure) return failure;
  }

  const cockpitResponse = successfulData(input.cockpit);
  if (cockpitResponse.status === "NOT_AVAILABLE") return { kind: "not-available" };

  const execution = successfulData(input.execution);
  const stages = successfulData(input.stages);
  if (cockpitResponse.projection.projectId !== input.projectId) {
    return { kind: "failed", message: "驾驶舱投影不属于当前项目。" };
  }
  if (execution.project.projectId !== input.projectId) {
    return { kind: "failed", message: "计划执行数据不属于当前项目。" };
  }
  if (
    !allProjectIdsMatch(input.projectId, [
      ...stages.projectStages.map((stage) => stage.projectId),
      ...stages.deliveryUnitStages.map((stage) => stage.projectId),
      ...stages.releases.map((release) => release.projectId)
    ])
  ) {
    return { kind: "failed", message: "阶段数据不属于当前项目。" };
  }

  const alerts = optionalSection(
    input.alerts,
    input.projectId,
    (data) =>
      data.items.every((item) => item.projectId === input.projectId) &&
      data.todos.every((item) => item.projectId === input.projectId)
  );
  const issues = optionalSection(input.issues, input.projectId, (data) =>
    data.issues.every((issue) => issue.projectId === input.projectId)
  );
  const data = buildDashboardData(
    input.projectId,
    cockpitResponse.projection,
    execution,
    stages,
    alerts,
    issues
  );

  if (execution.progress.status === "EMPTY") return { kind: "empty", ...data };
  if (execution.schedule.status === "FAILED") {
    return {
      kind: "failed",
      message: execution.schedule.error?.message ?? "计划预测计算失败。",
      ...data
    };
  }
  if (execution.schedule.status === "PENDING" || execution.schedule.status === "RUNNING") {
    return { kind: "pending", ...data };
  }
  if (execution.schedule.stale) return { kind: "stale", ...data };
  return { kind: "populated", ...data };
}

export function selectedCockpitView(value: string | null | undefined): CockpitDashboardView {
  return value && COCKPIT_DASHBOARD_VIEWS.includes(value as CockpitDashboardView)
    ? (value as CockpitDashboardView)
    : "overview";
}

function riskCellKey(value: string | null | undefined): RiskCellKey | null {
  if (!value) return null;
  const [probability, impact] = value.split(":");
  if (!probability || !impact || !isRiskLevel(probability) || !isRiskLevel(impact)) return null;
  return `${probability}:${impact}`;
}

export function riskCellQuery(value: string): string | null {
  const key = riskCellKey(value);
  return key ? `risk=${encodeURIComponent(key)}` : null;
}

export function cockpitDashboardHref(
  projectId: string,
  view: CockpitDashboardView,
  risk: string | null = null,
  fixture?: string
): string {
  const params = new URLSearchParams({ view });
  if (view === "risks") {
    const query = riskCellQuery(risk ?? "");
    if (query) {
      const [key, value] = query.split("=");
      params.set(key!, decodeURIComponent(value!));
    }
  }
  if (isCockpitDashboardFixture(fixture)) params.set("fixture", fixture);
  return `/projects/${encodeURIComponent(projectId)}/cockpit?${params.toString()}`;
}

export function selectRiskCell(state: CockpitDashboardPageState, key: string): RiskCell | null {
  if (!("risk" in state) || !state.risk) return null;
  const cell = state.risk.cells.find((candidate) => candidate.key === key);
  return cell ?? null;
}
