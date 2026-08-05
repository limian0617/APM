import { payloadHash, type JsonValue } from "@/modules/governance/domain/idempotency";

export class PlanningBaselineError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 409
  ) {
    super(message);
    this.name = "PlanningBaselineError";
  }
}

export type PlanningBaselineWbsNodeSource = {
  id: string;
  parentId: string | null;
  code: string;
  name: string;
  description: string | null;
  position: number;
  status: "ACTIVE" | "CLOSED";
  version: number;
};

export type PlanningBaselineTaskSource = {
  id: string;
  wbsNodeId: string;
  responsibilityPackageId: string | null;
  deliveryUnitId: string | null;
  moduleId: string | null;
  ownerMembershipId: string;
  code: string;
  name: string;
  description: string | null;
  position: number;
  plannedStartAt: Date;
  plannedFinishAt: Date;
  plannedDurationMinutes: number;
  weight: number;
  status: "NOT_STARTED" | "IN_PROGRESS" | "COMPLETED" | "CLOSED";
  version: number;
};

export type PlanningBaselineDependencySource = {
  id: string;
  predecessorTaskId: string;
  successorTaskId: string;
  dependencyType: "FS" | "SS" | "FF";
  lagMinutes: number;
  status: "ACTIVE" | "CLOSED";
  version: number;
};

export type PlanningBaselineMilestoneSource = {
  id: string;
  code: string;
  name: string;
  description: string | null;
  position: number;
  targetAt: Date | null;
  status: "PENDING" | "ACHIEVED" | "VOID";
  version: number;
};

export type PlanningBaselineMilestoneTaskLinkSource = {
  id: string;
  milestoneId: string;
  taskId: string;
  status: "ACTIVE" | "VOID";
};

export type PlanningBaselineCalendarSource = {
  id: string;
  status: "ACTIVE" | "CLOSED";
  version: number;
  revision: {
    id: string;
    revision: number;
    name: string;
    timeZone: string;
    weeklyRules: JsonValue;
    exceptions: JsonValue;
    checksum: string;
  };
};

export type PlanningBaselineSnapshotInput = {
  approvedG1SubmissionId: string | null;
  calendar: PlanningBaselineCalendarSource | null;
  wbsNodes: readonly PlanningBaselineWbsNodeSource[];
  tasks: readonly PlanningBaselineTaskSource[];
  dependencies: readonly PlanningBaselineDependencySource[];
  milestones: readonly PlanningBaselineMilestoneSource[];
  milestoneTaskLinks: readonly PlanningBaselineMilestoneTaskLinkSource[];
};

export type PlanningBaselineSnapshot = {
  approvedG1SubmissionId: string;
  calendar: {
    sourceCalendarId: string;
    sourceCalendarRevisionId: string;
    sourceCalendarVersion: number;
    revision: number;
    name: string;
    timeZone: string;
    weeklyRules: JsonValue;
    exceptions: JsonValue;
    sourceChecksum: string;
  };
  wbsNodes: Array<{
    sourceWbsNodeId: string;
    parentWbsNodeId: string | null;
    code: string;
    name: string;
    description: string | null;
    position: number;
    sourceVersion: number;
  }>;
  tasks: Array<{
    sourceTaskId: string;
    wbsNodeId: string;
    responsibilityPackageId: string | null;
    deliveryUnitId: string | null;
    moduleId: string | null;
    ownerMembershipId: string;
    code: string;
    name: string;
    description: string | null;
    position: number;
    plannedStartAt: string;
    plannedFinishAt: string;
    plannedDurationMinutes: number;
    weight: number;
    sourceVersion: number;
  }>;
  dependencies: Array<{
    sourceDependencyId: string;
    predecessorTaskId: string;
    successorTaskId: string;
    dependencyType: "FS" | "SS" | "FF";
    lagMinutes: number;
    sourceVersion: number;
  }>;
  milestones: Array<{
    sourceMilestoneId: string;
    code: string;
    name: string;
    description: string | null;
    position: number;
    targetAt: string | null;
    sourceVersion: number;
  }>;
  milestoneTaskLinks: Array<{
    sourceMilestoneTaskLinkId: string;
    milestoneId: string;
    taskId: string;
  }>;
  checksum: string;
};

export type PlanningBaselineSnapshotRows = Pick<
  PlanningBaselineSnapshot,
  "wbsNodes" | "tasks" | "dependencies" | "milestones" | "milestoneTaskLinks"
>;

type JsonRecord = { [key: string]: JsonValue };

function compareText(left: string, right: string) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function compareNumber(left: number, right: number) {
  return left - right;
}

export function canonicalizePlanningBaselineSnapshotRows(
  input: PlanningBaselineSnapshotRows
): PlanningBaselineSnapshotRows {
  const wbsNodes = [...input.wbsNodes].sort(
    (left, right) =>
      compareText(left.code, right.code) ||
      compareNumber(left.position, right.position) ||
      compareText(left.sourceWbsNodeId, right.sourceWbsNodeId)
  );
  const wbsCodeById = new Map(wbsNodes.map((node) => [node.sourceWbsNodeId, node.code]));
  const tasks = [...input.tasks].sort(
    (left, right) =>
      compareText(wbsCodeById.get(left.wbsNodeId) ?? "", wbsCodeById.get(right.wbsNodeId) ?? "") ||
      compareNumber(left.position, right.position) ||
      compareText(left.code, right.code) ||
      compareText(left.sourceTaskId, right.sourceTaskId)
  );
  const taskOrderById = new Map(
    tasks.map((task, index) => [task.sourceTaskId, String(index).padStart(12, "0")])
  );
  const dependencies = [...input.dependencies].sort(
    (left, right) =>
      compareText(
        taskOrderById.get(left.predecessorTaskId) ?? "",
        taskOrderById.get(right.predecessorTaskId) ?? ""
      ) ||
      compareText(
        taskOrderById.get(left.successorTaskId) ?? "",
        taskOrderById.get(right.successorTaskId) ?? ""
      ) ||
      compareText(left.sourceDependencyId, right.sourceDependencyId)
  );
  const milestones = [...input.milestones].sort(
    (left, right) =>
      compareNumber(left.position, right.position) ||
      compareText(left.code, right.code) ||
      compareText(left.sourceMilestoneId, right.sourceMilestoneId)
  );
  const milestoneOrderById = new Map(
    milestones.map((milestone, index) => [
      milestone.sourceMilestoneId,
      String(index).padStart(12, "0")
    ])
  );
  const milestoneTaskLinks = [...input.milestoneTaskLinks].sort(
    (left, right) =>
      compareText(
        milestoneOrderById.get(left.milestoneId) ?? "",
        milestoneOrderById.get(right.milestoneId) ?? ""
      ) ||
      compareText(taskOrderById.get(left.taskId) ?? "", taskOrderById.get(right.taskId) ?? "") ||
      compareText(left.sourceMilestoneTaskLinkId, right.sourceMilestoneTaskLinkId)
  );
  return { wbsNodes, tasks, dependencies, milestones, milestoneTaskLinks };
}

function isJsonRecord(value: JsonValue): value is JsonRecord {
  return value !== null && !Array.isArray(value) && typeof value === "object";
}

function sortIntervals(value: JsonValue): JsonValue {
  if (!Array.isArray(value)) return value;
  return [...value].sort((left, right) => {
    if (!isJsonRecord(left) || !isJsonRecord(right)) return 0;
    const start =
      typeof left.startMinute === "number" && typeof right.startMinute === "number"
        ? compareNumber(left.startMinute, right.startMinute)
        : 0;
    if (start !== 0) return start;
    return typeof left.endMinute === "number" && typeof right.endMinute === "number"
      ? compareNumber(left.endMinute, right.endMinute)
      : 0;
  });
}

function canonicalCalendarCollection(value: JsonValue, key: "dayOfWeek" | "date"): JsonValue {
  if (!Array.isArray(value)) return value;
  const entries: JsonValue[] = value.map((entry): JsonValue => {
    if (!isJsonRecord(entry)) return entry;
    return { ...entry, intervals: sortIntervals(entry.intervals ?? null) };
  });
  return entries.sort((left, right) => {
    if (!isJsonRecord(left) || !isJsonRecord(right)) return 0;
    const leftValue = left[key];
    const rightValue = right[key];
    if (typeof leftValue === "number" && typeof rightValue === "number") {
      return compareNumber(leftValue, rightValue);
    }
    if (typeof leftValue === "string" && typeof rightValue === "string") {
      return compareText(leftValue, rightValue);
    }
    return 0;
  });
}

function snapshotCalendar(calendar: PlanningBaselineCalendarSource) {
  return {
    sourceCalendarId: calendar.id,
    sourceCalendarRevisionId: calendar.revision.id,
    sourceCalendarVersion: calendar.version,
    revision: calendar.revision.revision,
    name: calendar.revision.name,
    timeZone: calendar.revision.timeZone,
    weeklyRules: canonicalCalendarCollection(calendar.revision.weeklyRules, "dayOfWeek"),
    exceptions: canonicalCalendarCollection(calendar.revision.exceptions, "date"),
    sourceChecksum: calendar.revision.checksum
  };
}

export function buildPlanningBaselineSnapshot(
  input: PlanningBaselineSnapshotInput
): PlanningBaselineSnapshot {
  if (!input.approvedG1SubmissionId) {
    throw new PlanningBaselineError(
      "G1_BASELINE_APPROVAL_REQUIRED",
      "冻结计划基线前必须存在已批准的项目级 G1 提交。"
    );
  }
  if (
    !input.calendar ||
    input.calendar.status !== "ACTIVE" ||
    input.calendar.revision.revision !== input.calendar.version
  ) {
    throw new PlanningBaselineError(
      "PLANNING_BASELINE_CALENDAR_REQUIRED",
      "冻结计划基线前必须配置启用的当前工作日历。"
    );
  }

  const wbsNodes = input.wbsNodes
    .filter((node) => node.status === "ACTIVE")
    .map((node) => ({
      sourceWbsNodeId: node.id,
      parentWbsNodeId: node.parentId,
      code: node.code,
      name: node.name,
      description: node.description,
      position: node.position,
      sourceVersion: node.version
    }));
  const activeWbsNodeIds = new Set(wbsNodes.map(({ sourceWbsNodeId }) => sourceWbsNodeId));

  const tasks = input.tasks
    .filter((task) => task.status !== "CLOSED" && activeWbsNodeIds.has(task.wbsNodeId))
    .map((task) => ({
      sourceTaskId: task.id,
      wbsNodeId: task.wbsNodeId,
      responsibilityPackageId: task.responsibilityPackageId,
      deliveryUnitId: task.deliveryUnitId,
      moduleId: task.moduleId,
      ownerMembershipId: task.ownerMembershipId,
      code: task.code,
      name: task.name,
      description: task.description,
      position: task.position,
      plannedStartAt: task.plannedStartAt.toISOString(),
      plannedFinishAt: task.plannedFinishAt.toISOString(),
      plannedDurationMinutes: task.plannedDurationMinutes,
      weight: task.weight,
      sourceVersion: task.version
    }));
  const activeTaskIds = new Set(tasks.map(({ sourceTaskId }) => sourceTaskId));

  const dependencies = input.dependencies
    .filter(
      (dependency) =>
        dependency.status === "ACTIVE" &&
        activeTaskIds.has(dependency.predecessorTaskId) &&
        activeTaskIds.has(dependency.successorTaskId)
    )
    .map((dependency) => ({
      sourceDependencyId: dependency.id,
      predecessorTaskId: dependency.predecessorTaskId,
      successorTaskId: dependency.successorTaskId,
      dependencyType: dependency.dependencyType,
      lagMinutes: dependency.lagMinutes,
      sourceVersion: dependency.version
    }));

  const milestones = input.milestones
    .filter((milestone) => milestone.status !== "VOID")
    .map((milestone) => ({
      sourceMilestoneId: milestone.id,
      code: milestone.code,
      name: milestone.name,
      description: milestone.description,
      position: milestone.position,
      targetAt: milestone.targetAt?.toISOString() ?? null,
      sourceVersion: milestone.version
    }));
  const activeMilestoneIds = new Set(milestones.map(({ sourceMilestoneId }) => sourceMilestoneId));

  const milestoneTaskLinks = input.milestoneTaskLinks
    .filter(
      (link) =>
        link.status === "ACTIVE" &&
        activeMilestoneIds.has(link.milestoneId) &&
        activeTaskIds.has(link.taskId)
    )
    .map((link) => ({
      sourceMilestoneTaskLinkId: link.id,
      milestoneId: link.milestoneId,
      taskId: link.taskId
    }));

  const rows = canonicalizePlanningBaselineSnapshotRows({
    wbsNodes,
    tasks,
    dependencies,
    milestones,
    milestoneTaskLinks
  });
  const canonical = {
    calendar: snapshotCalendar(input.calendar),
    ...rows
  };
  return {
    approvedG1SubmissionId: input.approvedG1SubmissionId,
    ...canonical,
    checksum: payloadHash(canonical).hash
  };
}
