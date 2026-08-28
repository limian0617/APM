import { describe, expect, it } from "vitest";

import { deriveResourceLoad, plannedLoadDays, type ResourceLoadSourceRow } from "./resource-load";

const sourceRows: ResourceLoadSourceRow[] = [
  {
    ownerMembershipId: "member-mechanical",
    personId: "user-mechanical",
    personName: "Mechanical Engineer",
    departmentId: "engineering",
    discipline: "ENGINEER",
    taskId: "task-design",
    taskCode: "DESIGN",
    taskName: "Mechanical design",
    plannedStartAt: new Date("2026-08-03T09:00:00.000Z"),
    plannedFinishAt: new Date("2026-08-05T17:00:00.000Z")
  },
  {
    ownerMembershipId: "member-mechanical",
    personId: "user-mechanical",
    personName: "Mechanical Engineer",
    departmentId: "engineering",
    discipline: "ENGINEER",
    taskId: "task-review",
    taskCode: "REVIEW",
    taskName: "Design review",
    plannedStartAt: new Date("2026-08-06T09:00:00.000Z"),
    plannedFinishAt: new Date("2026-08-07T17:00:00.000Z")
  },
  {
    ownerMembershipId: "member-software",
    personId: "user-software",
    personName: "Software Engineer",
    departmentId: "engineering",
    discipline: "ENGINEER",
    taskId: "task-program",
    taskCode: "PROGRAM",
    taskName: "PLC program",
    plannedStartAt: new Date("2026-08-10T09:00:00.000Z"),
    plannedFinishAt: new Date("2026-08-10T17:00:00.000Z")
  },
  {
    ownerMembershipId: "member-quality",
    personId: "user-quality",
    personName: "Quality Engineer",
    departmentId: null,
    discipline: "QUALITY",
    taskId: "task-check",
    taskCode: "CHECK",
    taskName: "Quality check",
    plannedStartAt: new Date("2026-08-11T09:00:00.000Z"),
    plannedFinishAt: new Date("2026-08-12T17:00:00.000Z")
  }
];

describe("APM-042 resource-load policy", () => {
  it("aggregates planned day load from department to discipline without person identities", () => {
    expect(deriveResourceLoad(sourceRows, false)).toEqual([
      {
        departmentId: "engineering",
        plannedDays: 6,
        activeTaskCount: 3,
        disciplines: [
          {
            discipline: "ENGINEER",
            plannedDays: 6,
            activeTaskCount: 3,
            people: []
          }
        ]
      },
      {
        departmentId: "UNASSIGNED",
        plannedDays: 2,
        activeTaskCount: 1,
        disciplines: [
          {
            discipline: "QUALITY",
            plannedDays: 2,
            activeTaskCount: 1,
            people: []
          }
        ]
      }
    ]);
  });

  it("reveals each person's immutable task drilldown only when requested", () => {
    expect(deriveResourceLoad(sourceRows, true)[0]).toEqual({
      departmentId: "engineering",
      plannedDays: 6,
      activeTaskCount: 3,
      disciplines: [
        {
          discipline: "ENGINEER",
          plannedDays: 6,
          activeTaskCount: 3,
          people: [
            {
              ownerMembershipId: "member-mechanical",
              personId: "user-mechanical",
              personName: "Mechanical Engineer",
              plannedDays: 5,
              activeTaskCount: 2,
              tasks: [
                {
                  taskId: "task-design",
                  taskCode: "DESIGN",
                  taskName: "Mechanical design",
                  plannedStartAt: "2026-08-03T09:00:00.000Z",
                  plannedFinishAt: "2026-08-05T17:00:00.000Z",
                  plannedDays: 3
                },
                {
                  taskId: "task-review",
                  taskCode: "REVIEW",
                  taskName: "Design review",
                  plannedStartAt: "2026-08-06T09:00:00.000Z",
                  plannedFinishAt: "2026-08-07T17:00:00.000Z",
                  plannedDays: 2
                }
              ]
            },
            {
              ownerMembershipId: "member-software",
              personId: "user-software",
              personName: "Software Engineer",
              plannedDays: 1,
              activeTaskCount: 1,
              tasks: [
                {
                  taskId: "task-program",
                  taskCode: "PROGRAM",
                  taskName: "PLC program",
                  plannedStartAt: "2026-08-10T09:00:00.000Z",
                  plannedFinishAt: "2026-08-10T17:00:00.000Z",
                  plannedDays: 1
                }
              ]
            }
          ]
        }
      ]
    });
  });

  it("uses positive calendar-date spans as planned days", () => {
    expect(
      plannedLoadDays(new Date("2026-08-03T09:00:00.000Z"), new Date("2026-08-05T17:00:00.000Z"))
    ).toBe(3);
    expect(
      plannedLoadDays(new Date("2026-08-03T09:00:00.000Z"), new Date("2026-08-03T09:01:00.000Z"))
    ).toBe(1);
    expect(() =>
      plannedLoadDays(new Date("2026-08-04T09:00:00.000Z"), new Date("2026-08-03T17:00:00.000Z"))
    ).toThrow("planned finish cannot precede planned start");
  });
});
