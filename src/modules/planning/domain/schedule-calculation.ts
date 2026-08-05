import { Temporal } from "@js-temporal/polyfill";

import type {
  CalendarException,
  TaskDependencyTypeCode,
  WeeklyWorkRule,
  WorkInterval
} from "./schedule-network";

const MILLISECONDS_PER_MINUTE = 60_000;
const MAX_CALENDAR_SCAN_DAYS = 36_600;

export const SCHEDULE_ALGORITHM_VERSION = "cpm.v1";

export class ScheduleCalculationError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message);
  }
}

export type ScheduleCalendarInput = {
  timeZone: string;
  weeklyRules: WeeklyWorkRule[];
  exceptions: CalendarException[];
};

export type ScheduleTaskInput = {
  taskId: string;
  status: "NOT_STARTED" | "IN_PROGRESS" | "COMPLETED";
  plannedStartAt: Date;
  plannedDurationMinutes: number;
  actualStartAt: Date | null;
  actualFinishAt: Date | null;
  remainingDurationMinutes: number;
};

export type ScheduleDependencyInput = {
  predecessorTaskId: string;
  successorTaskId: string;
  dependencyType: TaskDependencyTypeCode;
  lagMinutes: number;
};

export type ScheduleTaskResult = {
  taskId: string;
  position: number;
  durationMinutes: number;
  predictedStartAt: Date;
  predictedFinishAt: Date;
  latestStartAt: Date;
  latestFinishAt: Date;
  totalFloatMinutes: number;
  isCritical: boolean;
};

type InstantInterval = { start: Temporal.Instant; end: Temporal.Instant };

function instant(value: Date): Temporal.Instant {
  if (!(value instanceof Date) || Number.isNaN(value.valueOf())) {
    throw new ScheduleCalculationError("INVALID_SCHEDULE_DATE", "计划日期必须有效。");
  }
  return Temporal.Instant.fromEpochMilliseconds(value.getTime());
}

function date(value: Temporal.Instant): Date {
  return new Date(value.epochMilliseconds);
}

function compare(left: Temporal.Instant, right: Temporal.Instant): number {
  return Temporal.Instant.compare(left, right);
}

function maximum(left: Temporal.Instant, right: Temporal.Instant): Temporal.Instant {
  return compare(left, right) >= 0 ? left : right;
}

function minimum(left: Temporal.Instant, right: Temporal.Instant): Temporal.Instant {
  return compare(left, right) <= 0 ? left : right;
}

function assertInteger(value: number, field: string, minimum: number, maximum: number) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new ScheduleCalculationError(
      "INVALID_SCHEDULE_NUMBER",
      `${field} 必须是 ${minimum} 到 ${maximum} 的整数。`
    );
  }
}

function intervalInstant(
  localDate: Temporal.PlainDate,
  minute: number,
  timeZone: string
): Temporal.Instant {
  const targetDate = minute === 1440 ? localDate.add({ days: 1 }) : localDate;
  const minuteOfDay = minute === 1440 ? 0 : minute;
  return Temporal.ZonedDateTime.from(
    {
      timeZone,
      year: targetDate.year,
      month: targetDate.month,
      day: targetDate.day,
      hour: Math.floor(minuteOfDay / 60),
      minute: minuteOfDay % 60
    },
    { disambiguation: "compatible" }
  ).toInstant();
}

export function createScheduleCalendarOperations(input: ScheduleCalendarInput) {
  const weekly = new Map<number, WorkInterval[]>(
    input.weeklyRules.map((rule) => [rule.dayOfWeek, rule.intervals])
  );
  const exceptions = new Map<string, WorkInterval[]>(
    input.exceptions.map((exception) => [exception.date, exception.intervals])
  );
  let timeZone: string;
  try {
    timeZone = Temporal.ZonedDateTime.from({
      timeZone: input.timeZone,
      year: 1970,
      month: 1,
      day: 1
    }).timeZoneId;
  } catch {
    throw new ScheduleCalculationError("INVALID_TIME_ZONE", "项目日历时区无效。");
  }

  function intervalsOn(localDate: Temporal.PlainDate): InstantInterval[] {
    const values = exceptions.get(localDate.toString()) ?? weekly.get(localDate.dayOfWeek) ?? [];
    return values.map((value) => ({
      start: intervalInstant(localDate, value.startMinute, timeZone),
      end: intervalInstant(localDate, value.endMinute, timeZone)
    }));
  }

  function localDateAt(value: Temporal.Instant): Temporal.PlainDate {
    return value.toZonedDateTimeISO(timeZone).toPlainDate();
  }

  function alignForward(value: Temporal.Instant): Temporal.Instant {
    let cursor = value;
    let localDate = localDateAt(cursor);
    for (let day = 0; day < MAX_CALENDAR_SCAN_DAYS; day += 1) {
      for (const interval of intervalsOn(localDate)) {
        if (compare(cursor, interval.start) <= 0) return interval.start;
        if (compare(cursor, interval.end) < 0) return cursor;
      }
      localDate = localDate.add({ days: 1 });
      cursor = intervalInstant(localDate, 0, timeZone);
    }
    throw new ScheduleCalculationError("CALENDAR_RANGE_EXCEEDED", "工作日历向前扫描超出范围。");
  }

  function alignBackward(value: Temporal.Instant): Temporal.Instant {
    let cursor = value;
    let localDate = localDateAt(cursor);
    for (let day = 0; day < MAX_CALENDAR_SCAN_DAYS; day += 1) {
      const intervals = intervalsOn(localDate);
      for (let index = intervals.length - 1; index >= 0; index -= 1) {
        const interval = intervals[index]!;
        if (compare(cursor, interval.end) >= 0) return interval.end;
        if (compare(cursor, interval.start) > 0) return cursor;
      }
      localDate = localDate.subtract({ days: 1 });
      cursor = intervalInstant(localDate.add({ days: 1 }), 0, timeZone);
    }
    throw new ScheduleCalculationError("CALENDAR_RANGE_EXCEEDED", "工作日历向后扫描超出范围。");
  }

  function addForward(value: Temporal.Instant, minutes: number): Temporal.Instant {
    let remaining = minutes * MILLISECONDS_PER_MINUTE;
    let cursor = alignForward(value);
    for (let day = 0; remaining > 0 && day < MAX_CALENDAR_SCAN_DAYS; day += 1) {
      const localDate = localDateAt(cursor);
      const interval = intervalsOn(localDate).find(
        (candidate) => compare(cursor, candidate.start) >= 0 && compare(cursor, candidate.end) < 0
      );
      if (!interval) {
        cursor = alignForward(cursor.add({ nanoseconds: 1 }));
        continue;
      }
      const available = interval.end.epochMilliseconds - cursor.epochMilliseconds;
      if (remaining <= available) return cursor.add({ milliseconds: remaining });
      remaining -= available;
      cursor = alignForward(interval.end);
    }
    if (remaining === 0) return cursor;
    throw new ScheduleCalculationError("CALENDAR_RANGE_EXCEEDED", "工作日历加法超出范围。");
  }

  function addBackward(value: Temporal.Instant, minutes: number): Temporal.Instant {
    let remaining = -minutes * MILLISECONDS_PER_MINUTE;
    let cursor = alignBackward(value);
    for (let day = 0; remaining > 0 && day < MAX_CALENDAR_SCAN_DAYS; day += 1) {
      const localDate = localDateAt(cursor.subtract({ nanoseconds: 1 }));
      const interval = intervalsOn(localDate).find(
        (candidate) => compare(cursor, candidate.start) > 0 && compare(cursor, candidate.end) <= 0
      );
      if (!interval) {
        cursor = alignBackward(cursor.subtract({ nanoseconds: 1 }));
        continue;
      }
      const available = cursor.epochMilliseconds - interval.start.epochMilliseconds;
      if (remaining <= available) return cursor.subtract({ milliseconds: remaining });
      remaining -= available;
      cursor = alignBackward(interval.start);
    }
    if (remaining === 0) return cursor;
    throw new ScheduleCalculationError("CALENDAR_RANGE_EXCEEDED", "工作日历减法超出范围。");
  }

  function addWorkingMinutes(value: Date | Temporal.Instant, minutes: number): Temporal.Instant {
    assertInteger(minutes, "minutes", -5_256_000, 5_256_000);
    const source = value instanceof Date ? instant(value) : value;
    if (minutes === 0) return source;
    return minutes > 0 ? addForward(source, minutes) : addBackward(source, minutes);
  }

  function workingMinutesBetween(left: Temporal.Instant, right: Temporal.Instant): number {
    if (compare(left, right) === 0) return 0;
    if (compare(left, right) > 0) return -workingMinutesBetween(right, left);
    let milliseconds = 0;
    let localDate = localDateAt(left);
    const lastDate = localDateAt(right);
    for (let day = 0; Temporal.PlainDate.compare(localDate, lastDate) <= 0; day += 1) {
      if (day >= MAX_CALENDAR_SCAN_DAYS) {
        throw new ScheduleCalculationError("CALENDAR_RANGE_EXCEEDED", "工作日历区间超出范围。");
      }
      for (const interval of intervalsOn(localDate)) {
        const start = maximum(left, interval.start);
        const end = minimum(right, interval.end);
        if (compare(start, end) < 0)
          milliseconds += end.epochMilliseconds - start.epochMilliseconds;
      }
      localDate = localDate.add({ days: 1 });
    }
    return Math.round(milliseconds / MILLISECONDS_PER_MINUTE);
  }

  return { alignForward, alignBackward, addWorkingMinutes, workingMinutesBetween };
}

type WorkingTask = {
  input: ScheduleTaskInput;
  durationMinutes: number;
  predictedStart: Temporal.Instant;
  predictedFinish: Temporal.Instant;
  latestStart?: Temporal.Instant;
  latestFinish?: Temporal.Instant;
};

function topologicalOrder(tasks: ScheduleTaskInput[], dependencies: ScheduleDependencyInput[]) {
  const ids = new Set<string>();
  for (const task of tasks) {
    if (!task.taskId || ids.has(task.taskId)) {
      throw new ScheduleCalculationError("DUPLICATE_SCHEDULE_TASK", "计划输入包含重复任务。");
    }
    assertInteger(task.plannedDurationMinutes, "plannedDurationMinutes", 1, 5_256_000);
    assertInteger(task.remainingDurationMinutes, "remainingDurationMinutes", 0, 5_256_000);
    ids.add(task.taskId);
  }
  const incoming = new Map([...ids].map((id) => [id, 0]));
  const outgoing = new Map([...ids].map((id) => [id, [] as string[]]));
  const seenEdges = new Set<string>();
  for (const dependency of dependencies) {
    if (!ids.has(dependency.predecessorTaskId) || !ids.has(dependency.successorTaskId)) {
      throw new ScheduleCalculationError(
        "SCHEDULE_DEPENDENCY_TASK_MISSING",
        "任务依赖引用了不在计算输入中的任务。"
      );
    }
    const key = `${dependency.predecessorTaskId}\u0000${dependency.successorTaskId}`;
    if (seenEdges.has(key)) {
      throw new ScheduleCalculationError("DUPLICATE_SCHEDULE_DEPENDENCY", "计划输入包含重复依赖。");
    }
    seenEdges.add(key);
    incoming.set(dependency.successorTaskId, incoming.get(dependency.successorTaskId)! + 1);
    outgoing.get(dependency.predecessorTaskId)!.push(dependency.successorTaskId);
  }
  const ready = [...ids].filter((id) => incoming.get(id) === 0).sort();
  const order: string[] = [];
  while (ready.length > 0) {
    const id = ready.shift()!;
    order.push(id);
    for (const successor of outgoing.get(id)!.sort()) {
      const count = incoming.get(successor)! - 1;
      incoming.set(successor, count);
      if (count === 0) {
        ready.push(successor);
        ready.sort();
      }
    }
  }
  if (order.length !== tasks.length) {
    throw new ScheduleCalculationError("SCHEDULE_DEPENDENCY_CYCLE", "任务依赖图包含循环。");
  }
  return order;
}

export function calculateSchedule(input: {
  asOf: Date;
  calendar: ScheduleCalendarInput;
  tasks: ScheduleTaskInput[];
  dependencies: ScheduleDependencyInput[];
}): { projectFinishAt: Date | null; tasks: ScheduleTaskResult[] } {
  const calendar = createScheduleCalendarOperations(input.calendar);
  const asOf = instant(input.asOf);
  const order = topologicalOrder(input.tasks, input.dependencies);
  if (order.length === 0) return { projectFinishAt: null, tasks: [] };
  const taskInputs = new Map(input.tasks.map((task) => [task.taskId, task]));
  const predecessors = new Map(order.map((id) => [id, [] as ScheduleDependencyInput[]]));
  const successors = new Map(order.map((id) => [id, [] as ScheduleDependencyInput[]]));
  for (const dependency of input.dependencies) {
    predecessors.get(dependency.successorTaskId)!.push(dependency);
    successors.get(dependency.predecessorTaskId)!.push(dependency);
  }

  const working = new Map<string, WorkingTask>();
  for (const taskId of order) {
    const task = taskInputs.get(taskId)!;
    let predictedStart: Temporal.Instant;
    let predictedFinish: Temporal.Instant;
    if (task.status === "COMPLETED" && task.actualFinishAt) {
      predictedStart = instant(task.actualStartAt ?? task.plannedStartAt);
      predictedFinish = instant(task.actualFinishAt);
    } else if (task.status === "IN_PROGRESS") {
      predictedStart = instant(task.actualStartAt ?? task.plannedStartAt);
      const remainingStart = maximum(asOf, predictedStart);
      predictedFinish = calendar.addWorkingMinutes(
        remainingStart,
        Math.max(1, task.remainingDurationMinutes)
      );
    } else {
      let earliestStart = maximum(instant(task.plannedStartAt), asOf);
      for (const dependency of predecessors.get(taskId)!) {
        const predecessor = working.get(dependency.predecessorTaskId)!;
        let candidate: Temporal.Instant;
        if (dependency.dependencyType === "FS") {
          candidate = calendar.addWorkingMinutes(
            predecessor.predictedFinish,
            dependency.lagMinutes
          );
        } else if (dependency.dependencyType === "SS") {
          candidate = calendar.addWorkingMinutes(predecessor.predictedStart, dependency.lagMinutes);
        } else {
          const requiredFinish = calendar.addWorkingMinutes(
            predecessor.predictedFinish,
            dependency.lagMinutes
          );
          candidate = calendar.addWorkingMinutes(requiredFinish, -task.plannedDurationMinutes);
        }
        earliestStart = maximum(earliestStart, candidate);
      }
      predictedStart = calendar.alignForward(earliestStart);
      predictedFinish = calendar.addWorkingMinutes(predictedStart, task.plannedDurationMinutes);
    }
    const calculatedDuration = Math.max(
      1,
      calendar.workingMinutesBetween(predictedStart, predictedFinish)
    );
    working.set(taskId, {
      input: task,
      durationMinutes: calculatedDuration,
      predictedStart,
      predictedFinish
    });
  }

  const projectFinish = order
    .map((id) => working.get(id)!.predictedFinish)
    .reduce((left, right) => maximum(left, right));
  for (const taskId of [...order].reverse()) {
    const task = working.get(taskId)!;
    let latestFinish = projectFinish;
    const outgoing = successors.get(taskId)!;
    if (outgoing.length > 0) {
      const candidates = outgoing.map((dependency) => {
        const successor = working.get(dependency.successorTaskId)!;
        if (!successor.latestStart || !successor.latestFinish) {
          throw new ScheduleCalculationError("CPM_ORDER_INVALID", "关键路径后推顺序无效。");
        }
        if (dependency.dependencyType === "FS") {
          return calendar.addWorkingMinutes(successor.latestStart, -dependency.lagMinutes);
        }
        if (dependency.dependencyType === "SS") {
          const latestStart = calendar.addWorkingMinutes(
            successor.latestStart,
            -dependency.lagMinutes
          );
          return calendar.addWorkingMinutes(latestStart, task.durationMinutes);
        }
        return calendar.addWorkingMinutes(successor.latestFinish, -dependency.lagMinutes);
      });
      latestFinish = candidates.reduce((left, right) => minimum(left, right));
    }
    task.latestFinish = latestFinish;
    task.latestStart = calendar.addWorkingMinutes(latestFinish, -task.durationMinutes);
  }

  return {
    projectFinishAt: date(projectFinish),
    tasks: order.map((taskId, position) => {
      const task = working.get(taskId)!;
      const totalFloatMinutes = calendar.workingMinutesBetween(
        task.predictedStart,
        task.latestStart!
      );
      return {
        taskId,
        position,
        durationMinutes: task.durationMinutes,
        predictedStartAt: date(task.predictedStart),
        predictedFinishAt: date(task.predictedFinish),
        latestStartAt: date(task.latestStart!),
        latestFinishAt: date(task.latestFinish!),
        totalFloatMinutes,
        isCritical: totalFloatMinutes <= 0
      };
    })
  };
}
