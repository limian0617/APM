export type ExecutionDate = string | null;

export const EXECUTION_FIXTURES = [
  "normal",
  "loading",
  "empty",
  "error",
  "denied",
  "stale",
  "pending",
  "failed",
  "archived"
] as const;

export type ExecutionFixture = (typeof EXECUTION_FIXTURES)[number];

export function isExecutionFixture(value: string | undefined): value is ExecutionFixture {
  return value !== undefined && EXECUTION_FIXTURES.includes(value as ExecutionFixture);
}

export type ExecutionTask = {
  taskId: string;
  code: string;
  name: string;
  status: string;
  position: number;
  plannedStartAt: ExecutionDate;
  plannedFinishAt: ExecutionDate;
  actualStartAt: ExecutionDate;
  actualFinishAt: ExecutionDate;
  forecastFinishAt: ExecutionDate;
  predictedStartAt: ExecutionDate;
  predictedFinishAt: ExecutionDate;
  isCritical: boolean;
  responsibilityPackage: {
    packageId: string;
    code: string;
    name: string;
    status: string;
  } | null;
  owner: { userId: string; name: string };
};

export type ExecutionException = {
  kind: "CRITICAL_PATH_DELAY";
  taskId: string;
  code: string;
  name: string;
  plannedFinishAt: ExecutionDate;
  predictedFinishAt: ExecutionDate;
};

export type ExecutionResponsibilityPackage = {
  packageId: string;
  code: string;
  name: string;
  status: string;
  acceptedAt: ExecutionDate;
  closedAt: ExecutionDate;
  effectiveTaskCount: number;
};

export type ExecutionMilestone = {
  milestoneId: string;
  code: string;
  name: string;
  description: string | null;
  position: number;
  targetAt: ExecutionDate;
  status: string;
  achievementSource: string | null;
  achievedAt: ExecutionDate;
  voidedAt: ExecutionDate;
  resourceVersion: number;
  links: Array<{
    linkId: string;
    taskId: string;
    task: { code: string; name: string; status: string };
  }>;
};

export type ProjectExecutionDto = {
  project: { projectId: string; code: string; name: string; status: string };
  progress:
    | { status: "EMPTY"; calculatedAt: string }
    | {
        status: "READY";
        completedWorkdays: number;
        totalWorkdays: number;
        percent: number;
        calculatedAt: string;
      };
  schedule: {
    status: string;
    stale: boolean;
    inputVersion: number;
    publishedInputVersion: number | null;
    requestedAt: ExecutionDate;
    calculatedAt: ExecutionDate;
    algorithmVersion: string;
    projectFinishAt: ExecutionDate;
    error: { code: string | null; message: string | null } | null;
  };
  tasks: ExecutionTask[];
  criticalExceptions: ExecutionException[];
  responsibilityPackages: ExecutionResponsibilityPackage[];
  milestones: ExecutionMilestone[];
};

export type ExecutionFetchResult =
  | { kind: "loading" }
  | { kind: "error"; status: number; message: string }
  | { kind: "success"; data: ProjectExecutionDto };

export type ExecutionNotice =
  | { kind: "STALE"; timestamp: string | null }
  | { kind: "CALCULATION_PENDING" }
  | { kind: "CALCULATION_FAILED"; message: string }
  | { kind: "ARCHIVED" };

export type PopulatedExecutionState = {
  kind: "populated";
  project: ProjectExecutionDto["project"];
  progress: {
    completedWorkdays: number;
    totalWorkdays: number;
    percent: number;
    calculatedAt: string;
  };
  schedule: ProjectExecutionDto["schedule"];
  exceptions: ExecutionException[];
  nextMilestone: ExecutionMilestone | null;
  criticalTasks: ExecutionTask[];
  responsibilityPackages: ExecutionResponsibilityPackage[];
  milestones: ExecutionMilestone[];
  tasks: ExecutionTask[];
  notices: ExecutionNotice[];
  isReadOnly: boolean;
};

export type ExecutionPageState =
  | { kind: "loading" }
  | { kind: "denied" }
  | { kind: "error"; message: string; retryable: boolean }
  | { kind: "empty"; project: ProjectExecutionDto["project"]; calculatedAt: string }
  | PopulatedExecutionState;

function nextPendingMilestone(milestones: ExecutionMilestone[]) {
  return (
    milestones
      .filter((milestone) => milestone.status === "PENDING")
      .sort((left, right) => {
        const leftTarget = left.targetAt ?? "9999-12-31T23:59:59.999Z";
        const rightTarget = right.targetAt ?? "9999-12-31T23:59:59.999Z";
        return leftTarget.localeCompare(rightTarget) || left.position - right.position;
      })[0] ?? null
  );
}

function notices(data: ProjectExecutionDto): ExecutionNotice[] {
  const result: ExecutionNotice[] = [];
  if (data.schedule.stale) {
    result.push({
      kind: "STALE",
      timestamp: data.schedule.calculatedAt ?? data.schedule.requestedAt
    });
  }
  if (data.schedule.status === "PENDING" || data.schedule.status === "RUNNING") {
    result.push({ kind: "CALCULATION_PENDING" });
  }
  if (data.schedule.status === "FAILED") {
    result.push({
      kind: "CALCULATION_FAILED",
      message: data.schedule.error?.message ?? "预测计算失败。"
    });
  }
  if (data.project.status === "CLOSED" || data.project.status === "CANCELED") {
    result.push({ kind: "ARCHIVED" });
  }
  return result;
}

export function buildExecutionPageState(input: ExecutionFetchResult): ExecutionPageState {
  if (input.kind === "loading") return { kind: "loading" };
  if (input.kind === "error") {
    if (input.status === 401 || input.status === 403) return { kind: "denied" };
    return { kind: "error", message: input.message, retryable: input.status >= 500 };
  }
  const { data } = input;
  if (data.progress.status === "EMPTY") {
    return { kind: "empty", project: data.project, calculatedAt: data.progress.calculatedAt };
  }
  return {
    kind: "populated",
    project: data.project,
    progress: data.progress,
    schedule: data.schedule,
    exceptions: data.criticalExceptions,
    nextMilestone: nextPendingMilestone(data.milestones),
    criticalTasks: data.tasks.filter((task) => task.isCritical),
    responsibilityPackages: data.responsibilityPackages,
    milestones: data.milestones,
    tasks: data.tasks,
    notices: notices(data),
    isReadOnly: data.project.status === "CLOSED" || data.project.status === "CANCELED"
  };
}
