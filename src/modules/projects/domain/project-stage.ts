export const PROJECT_STAGE_EXECUTION_STATUSES = {
  NOT_STARTED: "NOT_STARTED",
  AUTHORIZED: "AUTHORIZED",
  IN_PROGRESS: "IN_PROGRESS",
  AWAITING_GATE: "AWAITING_GATE",
  COMPLETED: "COMPLETED",
  CONDITIONALLY_RELEASED: "CONDITIONALLY_RELEASED",
  SKIPPED: "SKIPPED"
} as const;

export type ProjectStageExecutionStatus =
  (typeof PROJECT_STAGE_EXECUTION_STATUSES)[keyof typeof PROJECT_STAGE_EXECUTION_STATUSES];

export class ProjectStageError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 409
  ) {
    super(message);
    this.name = "ProjectStageError";
  }
}

const allowedTransitions: Record<
  ProjectStageExecutionStatus,
  readonly ProjectStageExecutionStatus[]
> = {
  NOT_STARTED: ["AUTHORIZED", "SKIPPED"],
  AUTHORIZED: ["IN_PROGRESS", "SKIPPED"],
  IN_PROGRESS: ["AWAITING_GATE"],
  AWAITING_GATE: ["COMPLETED", "CONDITIONALLY_RELEASED"],
  COMPLETED: [],
  CONDITIONALLY_RELEASED: ["COMPLETED"],
  SKIPPED: []
};

function exceptionalReason(reason: unknown): string {
  const normalized = typeof reason === "string" ? reason.trim() : "";
  if (!normalized || normalized.length > 1024) {
    throw new ProjectStageError(
      "STAGE_EXCEPTION_REASON_REQUIRED",
      "条件放行或跳过阶段必须提供 1 到 1024 个字符的原因。",
      422
    );
  }
  return normalized;
}

export function validateStageTransition(
  fromStatus: ProjectStageExecutionStatus,
  toStatus: ProjectStageExecutionStatus,
  reason?: unknown
): ProjectStageExecutionStatus {
  const transitions = allowedTransitions[fromStatus];
  if (!transitions || !Object.hasOwn(PROJECT_STAGE_EXECUTION_STATUSES, toStatus)) {
    throw new ProjectStageError(
      "STAGE_TRANSITION_INVALID",
      `不能从 ${String(fromStatus)} 推进到 ${String(toStatus)}。`
    );
  }
  if (!transitions.includes(toStatus)) {
    throw new ProjectStageError(
      "STAGE_TRANSITION_INVALID",
      `不能从 ${fromStatus} 推进到 ${toStatus}。`
    );
  }
  if (toStatus === "CONDITIONALLY_RELEASED" || toStatus === "SKIPPED") {
    exceptionalReason(reason);
  }
  return toStatus;
}

export function validateAdjacentStageRelease(input: {
  projectId: string;
  fromStage: { projectId: string; sequence: number };
  nextStage: { projectId: string; sequence: number };
}) {
  if (
    input.fromStage.projectId !== input.projectId ||
    input.nextStage.projectId !== input.projectId
  ) {
    throw new ProjectStageError(
      "STAGE_RELEASE_PROJECT_INVALID",
      "阶段放行必须关联同一项目的阶段。"
    );
  }
  if (input.nextStage.sequence !== input.fromStage.sequence + 1) {
    throw new ProjectStageError(
      "STAGE_RELEASE_NOT_ADJACENT",
      "阶段放行只能从当前阶段授权到相邻的下一阶段。"
    );
  }
}
