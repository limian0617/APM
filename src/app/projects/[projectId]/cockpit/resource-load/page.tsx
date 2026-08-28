import { ResourceLoadPageClient } from "./resource-load-page-client";
import {
  isResourceLoadFixture,
  type ResourceLoadDto,
  type ResourceLoadFetchResult
} from "@/modules/cockpit/contracts/resource-load-page-state";

type PageProps = {
  params: Promise<{ projectId: string }>;
  searchParams: Promise<{ fixture?: string }>;
};

const calculatedAt = "2026-08-05T10:30:00.000Z";

function developmentResourceLoadFixture(
  projectId: string,
  fixture: string | undefined
): ResourceLoadFetchResult {
  const normal: ResourceLoadDto = {
    status: fixture === "stale" ? "STALE" : "READY",
    peopleIncluded: fixture !== "aggregate-only",
    projection: {
      projectionId: "demo-resource-load-projection",
      projectId,
      sourceChecksum: "a".repeat(64),
      calculatedAt,
      peopleCount: fixture === "aggregate-only" ? 0 : 3,
      departments: [
        {
          departmentId: "engineering",
          plannedDays: 11,
          activeTaskCount: 4,
          disciplines: [
            {
              discipline: "MECHANICAL_ENGINEER",
              plannedDays: 7,
              activeTaskCount: 3,
              people:
                fixture === "aggregate-only"
                  ? []
                  : [
                      {
                        ownerMembershipId: "demo-member-wang",
                        personId: "demo-user-wang",
                        personName: "王工",
                        plannedDays: 5,
                        activeTaskCount: 2,
                        tasks: [
                          {
                            taskId: "demo-task-design",
                            taskCode: "DESIGN.STRUCTURE",
                            taskName: "结构设计",
                            plannedStartAt: "2026-08-03T09:00:00.000Z",
                            plannedFinishAt: "2026-08-05T17:00:00.000Z",
                            plannedDays: 3
                          },
                          {
                            taskId: "demo-task-review",
                            taskCode: "DESIGN.REVIEW",
                            taskName: "结构评审",
                            plannedStartAt: "2026-08-06T09:00:00.000Z",
                            plannedFinishAt: "2026-08-07T17:00:00.000Z",
                            plannedDays: 2
                          }
                        ]
                      },
                      {
                        ownerMembershipId: "demo-member-li",
                        personId: "demo-user-li",
                        personName: "李工",
                        plannedDays: 2,
                        activeTaskCount: 1,
                        tasks: [
                          {
                            taskId: "demo-task-support",
                            taskCode: "DESIGN.SUPPORT",
                            taskName: "方案支持",
                            plannedStartAt: "2026-08-04T09:00:00.000Z",
                            plannedFinishAt: "2026-08-05T17:00:00.000Z",
                            plannedDays: 2
                          }
                        ]
                      }
                    ]
            },
            {
              discipline: "ELECTRICAL_ENGINEER",
              plannedDays: 4,
              activeTaskCount: 1,
              people:
                fixture === "aggregate-only"
                  ? []
                  : [
                      {
                        ownerMembershipId: "demo-member-chen",
                        personId: "demo-user-chen",
                        personName: "陈工",
                        plannedDays: 4,
                        activeTaskCount: 1,
                        tasks: [
                          {
                            taskId: "demo-task-panel",
                            taskCode: "ELECTRICAL.PANEL",
                            taskName: "电柜设计",
                            plannedStartAt: "2026-08-03T09:00:00.000Z",
                            plannedFinishAt: "2026-08-06T17:00:00.000Z",
                            plannedDays: 4
                          }
                        ]
                      }
                    ]
            }
          ]
        },
        {
          departmentId: "UNASSIGNED",
          plannedDays: 2,
          activeTaskCount: 1,
          disciplines: [
            {
              discipline: "PROJECT_MANAGER",
              plannedDays: 2,
              activeTaskCount: 1,
              people: []
            }
          ]
        }
      ]
    }
  };

  if (fixture === "loading") return { kind: "loading" };
  if (fixture === "denied") {
    return { kind: "error", status: 403, message: "当前身份无权查看项目资源负荷。" };
  }
  if (fixture === "error") {
    return { kind: "error", status: 503, message: "资源负荷数据暂不可用。" };
  }
  if (fixture === "not-available") {
    return {
      kind: "success",
      data: { status: "NOT_AVAILABLE", projection: null, peopleIncluded: false }
    };
  }
  if (fixture === "empty") {
    return {
      kind: "success",
      data: {
        ...normal,
        projection: { ...normal.projection, departments: [], peopleCount: 0 }
      }
    };
  }
  return { kind: "success", data: normal };
}

export default async function ResourceLoadPage({ params, searchParams }: PageProps) {
  const { projectId } = await params;
  const { fixture } = await searchParams;
  const initialResult =
    process.env.NODE_ENV === "production" || !isResourceLoadFixture(fixture)
      ? null
      : developmentResourceLoadFixture(projectId, fixture);

  return <ResourceLoadPageClient projectId={projectId} initialResult={initialResult} />;
}
