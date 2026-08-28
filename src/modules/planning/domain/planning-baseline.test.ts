import { describe, expect, it } from "vitest";

import {
  buildPlanningBaselineSnapshot,
  canonicalizePlanningBaselineSnapshotRows,
  PlanningBaselineError,
  type PlanningBaselineSnapshotInput
} from "./planning-baseline";

function source(): PlanningBaselineSnapshotInput {
  return {
    approvedG1SubmissionId: "submission-g1",
    calendar: {
      id: "calendar-1",
      status: "ACTIVE",
      version: 2,
      revision: {
        id: "calendar-revision-2",
        revision: 2,
        name: "标准项目日历",
        timeZone: "Asia/Shanghai",
        weeklyRules: [
          { dayOfWeek: 2, intervals: [{ startMinute: 480, endMinute: 1020 }] },
          { dayOfWeek: 1, intervals: [{ startMinute: 480, endMinute: 1020 }] }
        ],
        exceptions: [
          { date: "2026-08-02", intervals: [] },
          { date: "2026-08-01", intervals: [{ startMinute: 480, endMinute: 720 }] }
        ],
        checksum: "calendar-checksum"
      }
    },
    wbsNodes: [
      {
        id: "wbs-design",
        parentId: null,
        code: "DESIGN",
        name: "详细设计",
        description: "输出设计资料",
        position: 10,
        status: "ACTIVE",
        version: 3
      },
      {
        id: "wbs-closed",
        parentId: null,
        code: "CLOSED",
        name: "已关闭工作包",
        description: null,
        position: 30,
        status: "CLOSED",
        version: 1
      },
      {
        id: "wbs-assembly",
        parentId: null,
        code: "ASSEMBLY",
        name: "装配",
        description: null,
        position: 20,
        status: "ACTIVE",
        version: 2
      }
    ],
    tasks: [
      {
        id: "task-design-second",
        wbsNodeId: "wbs-design",
        responsibilityPackageId: null,
        deliveryUnitId: "unit-1",
        moduleId: null,
        ownerMembershipId: "member-1",
        code: "DESIGN.02",
        name: "设计评审",
        description: null,
        position: 2,
        plannedStartAt: new Date("2026-08-05T00:00:00.000Z"),
        plannedFinishAt: new Date("2026-08-08T00:00:00.000Z"),
        plannedDurationMinutes: 1440,
        weight: 30,
        status: "NOT_STARTED",
        version: 1
      },
      {
        id: "task-closed",
        wbsNodeId: "wbs-closed",
        responsibilityPackageId: null,
        deliveryUnitId: null,
        moduleId: null,
        ownerMembershipId: "member-1",
        code: "CLOSED.01",
        name: "关闭任务",
        description: null,
        position: 1,
        plannedStartAt: new Date("2026-08-01T00:00:00.000Z"),
        plannedFinishAt: new Date("2026-08-02T00:00:00.000Z"),
        plannedDurationMinutes: 480,
        weight: 1,
        status: "CLOSED",
        version: 1
      },
      {
        id: "task-assembly",
        wbsNodeId: "wbs-assembly",
        responsibilityPackageId: "package-1",
        deliveryUnitId: "unit-1",
        moduleId: "module-1",
        ownerMembershipId: "member-2",
        code: "ASSEMBLY.01",
        name: "机械装配",
        description: "安装模块",
        position: 1,
        plannedStartAt: new Date("2026-08-09T00:00:00.000Z"),
        plannedFinishAt: new Date("2026-08-12T00:00:00.000Z"),
        plannedDurationMinutes: 1440,
        weight: 40,
        status: "NOT_STARTED",
        version: 4
      },
      {
        id: "task-design-first",
        wbsNodeId: "wbs-design",
        responsibilityPackageId: null,
        deliveryUnitId: "unit-1",
        moduleId: null,
        ownerMembershipId: "member-1",
        code: "DESIGN.01",
        name: "机械设计",
        description: "输出图纸",
        position: 1,
        plannedStartAt: new Date("2026-08-01T00:00:00.000Z"),
        plannedFinishAt: new Date("2026-08-04T00:00:00.000Z"),
        plannedDurationMinutes: 1440,
        weight: 30,
        status: "NOT_STARTED",
        version: 2
      }
    ],
    dependencies: [
      {
        id: "dependency-closed",
        predecessorTaskId: "task-closed",
        successorTaskId: "task-assembly",
        dependencyType: "FS",
        lagMinutes: 0,
        status: "CLOSED",
        version: 1
      },
      {
        id: "dependency-active",
        predecessorTaskId: "task-design-second",
        successorTaskId: "task-assembly",
        dependencyType: "FS",
        lagMinutes: 480,
        status: "ACTIVE",
        version: 2
      }
    ],
    milestones: [
      {
        id: "milestone-g2",
        code: "G2",
        name: "设计冻结",
        description: null,
        position: 20,
        targetAt: new Date("2026-08-08T00:00:00.000Z"),
        status: "PENDING",
        version: 1
      },
      {
        id: "milestone-void",
        code: "VOID",
        name: "废弃里程碑",
        description: null,
        position: 5,
        targetAt: null,
        status: "VOID",
        version: 1
      },
      {
        id: "milestone-g1",
        code: "G1",
        name: "方案评审",
        description: "审批计划基线",
        position: 10,
        targetAt: new Date("2026-08-04T00:00:00.000Z"),
        status: "ACHIEVED",
        version: 3
      }
    ],
    milestoneTaskLinks: [
      {
        id: "link-void",
        milestoneId: "milestone-g1",
        taskId: "task-design-first",
        status: "VOID"
      },
      {
        id: "link-g2",
        milestoneId: "milestone-g2",
        taskId: "task-design-second",
        status: "ACTIVE"
      },
      {
        id: "link-closed-task",
        milestoneId: "milestone-g2",
        taskId: "task-closed",
        status: "ACTIVE"
      },
      {
        id: "link-g1",
        milestoneId: "milestone-g1",
        taskId: "task-design-first",
        status: "ACTIVE"
      }
    ]
  };
}

describe("APM-023 G1 planning baseline snapshot", () => {
  it("canonicalizes effective planning data independently of source return order", () => {
    const first = buildPlanningBaselineSnapshot(source());
    const unordered = source();
    const calendar = unordered.calendar;
    if (
      !calendar ||
      !Array.isArray(calendar.revision.weeklyRules) ||
      !Array.isArray(calendar.revision.exceptions)
    ) {
      throw new Error("Expected calendar rules and exceptions to be arrays.");
    }
    const second = buildPlanningBaselineSnapshot({
      ...unordered,
      wbsNodes: [...unordered.wbsNodes].reverse(),
      tasks: [...unordered.tasks].reverse(),
      dependencies: [...unordered.dependencies].reverse(),
      milestones: [...unordered.milestones].reverse(),
      milestoneTaskLinks: [...unordered.milestoneTaskLinks].reverse(),
      calendar: {
        ...calendar,
        revision: {
          ...calendar.revision,
          weeklyRules: [...calendar.revision.weeklyRules].reverse(),
          exceptions: [...calendar.revision.exceptions].reverse()
        }
      }
    });

    expect(first.checksum).toBe(second.checksum);
    expect(first.wbsNodes.map(({ sourceWbsNodeId }) => sourceWbsNodeId)).toEqual([
      "wbs-assembly",
      "wbs-design"
    ]);
    expect(first.tasks.map(({ sourceTaskId }) => sourceTaskId)).toEqual([
      "task-assembly",
      "task-design-first",
      "task-design-second"
    ]);
    expect(first.dependencies).toEqual([
      {
        sourceDependencyId: "dependency-active",
        predecessorTaskId: "task-design-second",
        successorTaskId: "task-assembly",
        dependencyType: "FS",
        lagMinutes: 480,
        sourceVersion: 2
      }
    ]);
    expect(first.milestones.map(({ sourceMilestoneId }) => sourceMilestoneId)).toEqual([
      "milestone-g1",
      "milestone-g2"
    ]);
    expect(first.milestoneTaskLinks).toEqual([
      {
        sourceMilestoneTaskLinkId: "link-g1",
        milestoneId: "milestone-g1",
        taskId: "task-design-first"
      },
      {
        sourceMilestoneTaskLinkId: "link-g2",
        milestoneId: "milestone-g2",
        taskId: "task-design-second"
      }
    ]);
    expect(first.calendar).toMatchObject({
      sourceCalendarId: "calendar-1",
      sourceCalendarRevisionId: "calendar-revision-2",
      revision: 2,
      weeklyRules: [
        { dayOfWeek: 1, intervals: [{ startMinute: 480, endMinute: 1020 }] },
        { dayOfWeek: 2, intervals: [{ startMinute: 480, endMinute: 1020 }] }
      ],
      exceptions: [
        { date: "2026-08-01", intervals: [{ startMinute: 480, endMinute: 720 }] },
        { date: "2026-08-02", intervals: [] }
      ]
    });
  });

  it("requires an active calendar revision and approved G1 submission", () => {
    const noCalendar = { ...source(), calendar: null };
    expectBaselineError(
      () => buildPlanningBaselineSnapshot(noCalendar),
      "PLANNING_BASELINE_CALENDAR_REQUIRED"
    );

    const noG1 = { ...source(), approvedG1SubmissionId: null };
    expectBaselineError(() => buildPlanningBaselineSnapshot(noG1), "G1_BASELINE_APPROVAL_REQUIRED");
  });

  it("requires the active calendar revision to match the calendar version", () => {
    const staleCalendar = source();
    if (!staleCalendar.calendar) throw new Error("Expected an active calendar.");
    staleCalendar.calendar.revision.revision = staleCalendar.calendar.version - 1;

    expectBaselineError(
      () => buildPlanningBaselineSnapshot(staleCalendar),
      "PLANNING_BASELINE_CALENDAR_REQUIRED"
    );
  });

  it("normalizes arbitrary persisted snapshot row order into the canonical planning order", () => {
    const canonical = buildPlanningBaselineSnapshot(source());
    const additionalDependency = {
      ...canonical.dependencies[0]!,
      sourceDependencyId: "dependency-earlier",
      predecessorTaskId: "task-assembly",
      successorTaskId: "task-design-first"
    };

    const normalized = canonicalizePlanningBaselineSnapshotRows({
      wbsNodes: [...canonical.wbsNodes].reverse(),
      tasks: [...canonical.tasks].reverse(),
      dependencies: [additionalDependency, ...canonical.dependencies].reverse(),
      milestones: [...canonical.milestones].reverse(),
      milestoneTaskLinks: [...canonical.milestoneTaskLinks].reverse()
    });

    expect(normalized.wbsNodes).toEqual(canonical.wbsNodes);
    expect(normalized.tasks).toEqual(canonical.tasks);
    expect(normalized.dependencies.map(({ sourceDependencyId }) => sourceDependencyId)).toEqual([
      "dependency-earlier",
      "dependency-active"
    ]);
    expect(normalized.milestones).toEqual(canonical.milestones);
    expect(normalized.milestoneTaskLinks).toEqual(canonical.milestoneTaskLinks);
  });
});

function expectBaselineError(action: () => void, code: string) {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(PlanningBaselineError);
    expect((error as PlanningBaselineError).code).toBe(code);
    return;
  }
  throw new Error("Expected a PlanningBaselineError.");
}
