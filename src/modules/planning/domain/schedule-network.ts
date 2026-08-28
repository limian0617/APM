import { payloadHash } from "@/modules/governance/domain/idempotency";

import { PlanningError } from "./planning-task";

export const TASK_DEPENDENCY_TYPES = {
  FS: "FS",
  SS: "SS",
  FF: "FF"
} as const;

export type TaskDependencyTypeCode =
  (typeof TASK_DEPENDENCY_TYPES)[keyof typeof TASK_DEPENDENCY_TYPES];

export type WorkInterval = { startMinute: number; endMinute: number };
export type WeeklyWorkRule = { dayOfWeek: number; intervals: WorkInterval[] };
export type CalendarException = { date: string; intervals: WorkInterval[] };

export type ProjectCalendarRules = {
  name: string;
  timeZone: string;
  weeklyRules: WeeklyWorkRule[];
  exceptions: CalendarException[];
  checksum: string;
};

function requiredText(value: unknown, field: string, maximum: number): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized || normalized.length > maximum) {
    throw new PlanningError("INVALID_CALENDAR_CONTENT", `${field} 必须是 1 到 ${maximum} 个字符。`);
  }
  return normalized;
}

function boundedInteger(value: unknown, field: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new PlanningError(
      "INVALID_SCHEDULE_NUMBER",
      `${field} 必须是 ${minimum} 到 ${maximum} 的整数。`
    );
  }
  return value as number;
}

function identifier(value: unknown, field: string): string {
  return requiredText(value, field, 191);
}

function normalizeIntervals(value: unknown, field: string, allowEmpty: boolean): WorkInterval[] {
  if (!Array.isArray(value) || value.length > 8 || (!allowEmpty && value.length === 0)) {
    throw new PlanningError(
      "INVALID_WORK_INTERVALS",
      `${field} 必须包含${allowEmpty ? " 0 到" : " 1 到"} 8 个工作时段。`
    );
  }
  const intervals = value
    .map((interval, index) => {
      if (!interval || typeof interval !== "object" || Array.isArray(interval)) {
        throw new PlanningError("INVALID_WORK_INTERVALS", `${field}[${index}] 必须是工作时段。`);
      }
      const candidate = interval as Record<string, unknown>;
      const startMinute = boundedInteger(
        candidate.startMinute,
        `${field}[${index}].startMinute`,
        0,
        1439
      );
      const endMinute = boundedInteger(
        candidate.endMinute,
        `${field}[${index}].endMinute`,
        1,
        1440
      );
      if (endMinute <= startMinute) {
        throw new PlanningError(
          "INVALID_WORK_INTERVALS",
          `${field}[${index}] 的结束分钟必须晚于开始分钟。`
        );
      }
      return { startMinute, endMinute };
    })
    .sort(
      (left, right) => left.startMinute - right.startMinute || left.endMinute - right.endMinute
    );

  for (let index = 1; index < intervals.length; index += 1) {
    if (intervals[index]!.startMinute < intervals[index - 1]!.endMinute) {
      throw new PlanningError("WORK_INTERVAL_OVERLAP", `${field} 中的工作时段不能重叠。`, 409);
    }
  }
  return intervals;
}

function validCalendarDate(value: unknown, field: string): string {
  const normalized = typeof value === "string" ? value : "";
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(normalized)) {
    throw new PlanningError("INVALID_CALENDAR_DATE", `${field} 必须是 YYYY-MM-DD。`);
  }
  const parsed = new Date(`${normalized}T00:00:00.000Z`);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== normalized) {
    throw new PlanningError("INVALID_CALENDAR_DATE", `${field} 必须是有效日期。`);
  }
  return normalized;
}

function validTimeZone(value: unknown): string {
  const timeZone = requiredText(value, "timeZone", 100);
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format(new Date(0));
  } catch {
    throw new PlanningError("INVALID_TIME_ZONE", "timeZone 必须是有效的 IANA 时区。", 422);
  }
  return timeZone;
}

export function buildProjectCalendarRules(input: {
  name: unknown;
  timeZone: unknown;
  weeklyRules: unknown;
  exceptions: unknown;
}): ProjectCalendarRules {
  if (
    !Array.isArray(input.weeklyRules) ||
    input.weeklyRules.length < 1 ||
    input.weeklyRules.length > 7
  ) {
    throw new PlanningError("INVALID_WEEKLY_RULES", "weeklyRules 必须包含 1 到 7 个工作日规则。");
  }
  const seenDays = new Set<number>();
  const weeklyRules = input.weeklyRules
    .map((rule, index) => {
      if (!rule || typeof rule !== "object" || Array.isArray(rule)) {
        throw new PlanningError("INVALID_WEEKLY_RULES", `weeklyRules[${index}] 必须是工作日规则。`);
      }
      const candidate = rule as Record<string, unknown>;
      const dayOfWeek = boundedInteger(
        candidate.dayOfWeek,
        `weeklyRules[${index}].dayOfWeek`,
        1,
        7
      );
      if (seenDays.has(dayOfWeek)) {
        throw new PlanningError("DUPLICATE_WEEKDAY", "weeklyRules 不能包含重复星期。", 409);
      }
      seenDays.add(dayOfWeek);
      return {
        dayOfWeek,
        intervals: normalizeIntervals(candidate.intervals, `weeklyRules[${index}].intervals`, false)
      };
    })
    .sort((left, right) => left.dayOfWeek - right.dayOfWeek);

  if (!Array.isArray(input.exceptions) || input.exceptions.length > 3660) {
    throw new PlanningError("INVALID_CALENDAR_EXCEPTIONS", "exceptions 最多包含 3660 个日期规则。");
  }
  const seenDates = new Set<string>();
  const exceptions = input.exceptions
    .map((exception, index) => {
      if (!exception || typeof exception !== "object" || Array.isArray(exception)) {
        throw new PlanningError(
          "INVALID_CALENDAR_EXCEPTIONS",
          `exceptions[${index}] 必须是日期规则。`
        );
      }
      const candidate = exception as Record<string, unknown>;
      const date = validCalendarDate(candidate.date, `exceptions[${index}].date`);
      if (seenDates.has(date)) {
        throw new PlanningError("DUPLICATE_CALENDAR_DATE", "exceptions 不能包含重复日期。", 409);
      }
      seenDates.add(date);
      return {
        date,
        intervals: normalizeIntervals(candidate.intervals, `exceptions[${index}].intervals`, true)
      };
    })
    .sort((left, right) => left.date.localeCompare(right.date));

  const canonical = {
    name: requiredText(input.name, "name", 200),
    timeZone: validTimeZone(input.timeZone),
    weeklyRules,
    exceptions
  };
  return { ...canonical, checksum: payloadHash(canonical).hash };
}

export type TaskDependencyDefinition = {
  predecessorTaskId: string;
  successorTaskId: string;
  dependencyType: TaskDependencyTypeCode;
  lagMinutes: number;
};

export function buildTaskDependencyDefinition(input: {
  predecessorTaskId: unknown;
  successorTaskId: unknown;
  dependencyType: unknown;
  lagMinutes: unknown;
}): TaskDependencyDefinition {
  const predecessorTaskId = identifier(input.predecessorTaskId, "predecessorTaskId");
  const successorTaskId = identifier(input.successorTaskId, "successorTaskId");
  if (predecessorTaskId === successorTaskId) {
    throw new PlanningError("TASK_DEPENDENCY_SELF_REFERENCE", "任务不能依赖自身。", 409);
  }
  if (
    typeof input.dependencyType !== "string" ||
    !Object.hasOwn(TASK_DEPENDENCY_TYPES, input.dependencyType)
  ) {
    throw new PlanningError("INVALID_DEPENDENCY_TYPE", "dependencyType 必须是 FS、SS 或 FF。");
  }
  return {
    predecessorTaskId,
    successorTaskId,
    dependencyType: input.dependencyType as TaskDependencyTypeCode,
    lagMinutes: boundedInteger(input.lagMinutes, "lagMinutes", -5_256_000, 5_256_000)
  };
}

export type DependencyGraphEdge = {
  predecessorTaskId: string;
  successorTaskId: string;
};

export function assertDependencyGraphAcyclic(
  existing: DependencyGraphEdge[],
  candidate: DependencyGraphEdge
) {
  if (candidate.predecessorTaskId === candidate.successorTaskId) {
    throw new PlanningError("TASK_DEPENDENCY_CYCLE", "任务依赖图不能形成循环。", 409);
  }
  const outgoing = new Map<string, string[]>();
  for (const edge of [...existing, candidate]) {
    const successors = outgoing.get(edge.predecessorTaskId) ?? [];
    successors.push(edge.successorTaskId);
    outgoing.set(edge.predecessorTaskId, successors);
  }
  const pending = [candidate.successorTaskId];
  const visited = new Set<string>();
  while (pending.length > 0) {
    const taskId = pending.pop()!;
    if (taskId === candidate.predecessorTaskId) {
      throw new PlanningError("TASK_DEPENDENCY_CYCLE", "任务依赖图不能形成循环。", 409);
    }
    if (visited.has(taskId)) continue;
    visited.add(taskId);
    pending.push(...(outgoing.get(taskId) ?? []));
  }
}

export function projectCalendarAllowedActions(status: "ACTIVE" | "CLOSED") {
  return status === "ACTIVE" ? (["UPDATE", "CLOSE"] as const) : ([] as const);
}

export function taskDependencyAllowedActions(status: "ACTIVE" | "CLOSED") {
  return status === "ACTIVE" ? (["UPDATE", "CLOSE"] as const) : ([] as const);
}
