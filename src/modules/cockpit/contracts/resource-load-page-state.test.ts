import { describe, expect, it } from "vitest";

import {
  buildResourceLoadPageState,
  findResourceLoadDiscipline,
  findResourceLoadPerson,
  isResourceLoadFixture,
  type ResourceLoadDto
} from "./resource-load-page-state";

const calculatedAt = "2026-08-05T10:30:00.000Z";

function resourceLoadData(overrides: Partial<ResourceLoadDto> = {}): ResourceLoadDto {
  return {
    status: "READY",
    peopleIncluded: true,
    projection: {
      projectionId: "projection-1",
      projectId: "project-1",
      sourceChecksum: "a".repeat(64),
      calculatedAt,
      peopleCount: 1,
      departments: [
        {
          departmentId: "engineering",
          plannedDays: 5,
          activeTaskCount: 2,
          disciplines: [
            {
              discipline: "ENGINEER",
              plannedDays: 5,
              activeTaskCount: 2,
              people: [
                {
                  ownerMembershipId: "member-1",
                  personId: "user-1",
                  personName: "王工",
                  plannedDays: 5,
                  activeTaskCount: 2,
                  tasks: [
                    {
                      taskId: "task-1",
                      taskCode: "DESIGN",
                      taskName: "机械设计",
                      plannedStartAt: "2026-08-03T09:00:00.000Z",
                      plannedFinishAt: "2026-08-05T17:00:00.000Z",
                      plannedDays: 3
                    }
                  ]
                }
              ]
            }
          ]
        }
      ]
    },
    ...overrides
  };
}

describe("APM-042 resource-load page state", () => {
  it("recognizes only the explicit development fixtures", () => {
    expect(isResourceLoadFixture(undefined)).toBe(false);
    expect(isResourceLoadFixture("normal")).toBe(true);
    expect(isResourceLoadFixture("denied")).toBe(true);
    expect(isResourceLoadFixture("member-1")).toBe(false);
  });

  it("keeps people and task rows out of the default aggregate state", () => {
    const state = buildResourceLoadPageState({
      kind: "success",
      data: resourceLoadData({
        peopleIncluded: false,
        projection: {
          ...resourceLoadData().projection!,
          departments: [
            {
              ...resourceLoadData().projection!.departments[0]!,
              disciplines: [
                {
                  ...resourceLoadData().projection!.departments[0]!.disciplines[0]!,
                  people: []
                }
              ]
            }
          ]
        }
      })
    });

    expect(state).toMatchObject({ kind: "populated", peopleIncluded: false });
    if (state.kind !== "populated") throw new Error("expected populated resource load");
    expect(state.departments[0]?.disciplines[0]?.people).toEqual([]);
    expect(
      findResourceLoadPerson(state, {
        departmentId: "engineering",
        discipline: "ENGINEER",
        ownerMembershipId: "member-1"
      })
    ).toBeNull();
  });

  it("keeps a stale snapshot visible while labeling it as stale", () => {
    const state = buildResourceLoadPageState({
      kind: "success",
      data: resourceLoadData({ status: "STALE" })
    });

    expect(state).toMatchObject({
      kind: "populated",
      freshness: "STALE",
      departments: [{ departmentId: "engineering", plannedDays: 5 }]
    });
  });

  it("maps unavailable, empty, denied, and retryable states without inventing people", () => {
    expect(
      buildResourceLoadPageState({
        kind: "success",
        data: { status: "NOT_AVAILABLE", projection: null, peopleIncluded: false }
      })
    ).toEqual({ kind: "not-available" });
    expect(
      buildResourceLoadPageState({
        kind: "success",
        data: resourceLoadData({
          projection: { ...resourceLoadData().projection!, departments: [], peopleCount: 0 }
        })
      })
    ).toMatchObject({ kind: "empty", peopleIncluded: true, calculatedAt });
    expect(
      buildResourceLoadPageState({ kind: "error", status: 403, message: "无权查看项目。" })
    ).toEqual({ kind: "denied" });
    expect(
      buildResourceLoadPageState({ kind: "error", status: 503, message: "读取失败。" })
    ).toEqual({ kind: "error", message: "读取失败。", retryable: true });
  });

  it("only selects a person already included in the authorized response hierarchy", () => {
    const state = buildResourceLoadPageState({ kind: "success", data: resourceLoadData() });
    if (state.kind !== "populated") throw new Error("expected populated resource load");

    expect(
      findResourceLoadPerson(state, {
        departmentId: "engineering",
        discipline: "ENGINEER",
        ownerMembershipId: "member-1"
      })
    ).toMatchObject({ personName: "王工", tasks: [{ taskId: "task-1" }] });
    expect(
      findResourceLoadPerson(state, {
        departmentId: "engineering",
        discipline: "ENGINEER",
        ownerMembershipId: "other-project-member"
      })
    ).toBeNull();
  });

  it("only expands an authorized department and discipline from the loaded hierarchy", () => {
    const state = buildResourceLoadPageState({ kind: "success", data: resourceLoadData() });
    if (state.kind !== "populated") throw new Error("expected populated resource load");

    expect(
      findResourceLoadDiscipline(state, {
        departmentId: "engineering",
        discipline: "ENGINEER"
      })
    ).toMatchObject({ discipline: "ENGINEER", people: [{ personName: "王工" }] });
    expect(
      findResourceLoadDiscipline(state, {
        departmentId: "engineering",
        discipline: "QUALITY"
      })
    ).toBeNull();
    expect(
      findResourceLoadDiscipline(
        buildResourceLoadPageState({
          kind: "success",
          data: resourceLoadData({
            peopleIncluded: false,
            projection: {
              ...resourceLoadData().projection!,
              departments: [
                {
                  ...resourceLoadData().projection!.departments[0]!,
                  disciplines: [
                    {
                      ...resourceLoadData().projection!.departments[0]!.disciplines[0]!,
                      people: []
                    }
                  ]
                }
              ]
            }
          })
        }),
        { departmentId: "engineering", discipline: "ENGINEER" }
      )
    ).toBeNull();
  });
});
