import { ExecutionPageClient } from "./execution-page-client";
import { isExecutionFixture } from "@/modules/planning/contracts/execution-page-state";
import type {
  ExecutionFetchResult,
  ProjectExecutionDto
} from "@/modules/planning/contracts/execution-page-state";

type PageProps = {
  params: Promise<{ projectId: string }>;
  searchParams: Promise<{ fixture?: string }>;
};

const fixtureTimestamp = "2026-08-04T09:30:00.000Z";

function developmentExecutionFixture(
  projectId: string,
  fixture: string | undefined
): ExecutionFetchResult {
  const data: ProjectExecutionDto = {
    project: {
      projectId,
      code: "DEMO-EXECUTION",
      name: "装配线升级项目",
      status: fixture === "archived" ? "CLOSED" : "IN_PROGRESS"
    },
    progress: {
      status: "READY",
      completedWorkdays: 20,
      totalWorkdays: 100,
      percent: 20,
      calculatedAt: fixtureTimestamp
    },
    schedule: {
      status: "SUCCEEDED",
      stale: false,
      inputVersion: 4,
      publishedInputVersion: 4,
      requestedAt: fixtureTimestamp,
      calculatedAt: fixtureTimestamp,
      algorithmVersion: "cpm-v1",
      projectFinishAt: "2026-09-20T08:00:00.000Z",
      error: null
    },
    tasks: [
      {
        taskId: "demo-critical-task",
        code: "COMMISSIONING.SAFETY",
        name: "安全门联锁调试",
        status: "IN_PROGRESS",
        position: 10,
        plannedStartAt: "2026-08-01T08:00:00.000Z",
        plannedFinishAt: "2026-08-10T08:00:00.000Z",
        actualStartAt: "2026-08-02T08:00:00.000Z",
        actualFinishAt: null,
        forecastFinishAt: "2026-08-13T08:00:00.000Z",
        predictedStartAt: "2026-08-02T08:00:00.000Z",
        predictedFinishAt: "2026-08-13T08:00:00.000Z",
        isCritical: true,
        responsibilityPackage: {
          packageId: "demo-package",
          code: "COMMISSIONING",
          name: "现场联调责任包",
          status: "ACCEPTED"
        },
        owner: { userId: "demo-owner", name: "王工" }
      }
    ],
    criticalExceptions: [
      {
        kind: "CRITICAL_PATH_DELAY",
        taskId: "demo-critical-task",
        code: "COMMISSIONING.SAFETY",
        name: "安全门联锁调试",
        plannedFinishAt: "2026-08-10T08:00:00.000Z",
        predictedFinishAt: "2026-08-13T08:00:00.000Z"
      }
    ],
    responsibilityPackages: [
      {
        packageId: "demo-package",
        code: "COMMISSIONING",
        name: "现场联调责任包",
        status: "ACCEPTED",
        acceptedAt: "2026-08-02T08:00:00.000Z",
        closedAt: null,
        effectiveTaskCount: 1
      }
    ],
    milestones: [
      {
        milestoneId: "demo-milestone-next",
        code: "FAT.READY",
        name: "FAT 准备",
        description: "客户验收前置条件确认。",
        position: 10,
        targetAt: "2026-08-14T08:00:00.000Z",
        status: "PENDING",
        achievementSource: null,
        achievedAt: null,
        voidedAt: null,
        resourceVersion: 1,
        links: []
      },
      {
        milestoneId: "demo-milestone-achieved",
        code: "DESIGN.FREEZE",
        name: "设计冻结",
        description: null,
        position: 0,
        targetAt: "2026-07-24T08:00:00.000Z",
        status: "ACHIEVED",
        achievementSource: "MANUAL",
        achievedAt: "2026-07-24T08:00:00.000Z",
        voidedAt: null,
        resourceVersion: 2,
        links: []
      }
    ]
  };
  if (fixture === "loading") return { kind: "loading" };
  if (fixture === "denied") {
    return { kind: "error", status: 403, message: "当前角色无权查看项目。" };
  }
  if (fixture === "error") return { kind: "error", status: 503, message: "执行查询暂不可用。" };
  if (fixture === "empty") {
    return {
      kind: "success",
      data: {
        ...data,
        progress: { status: "EMPTY", calculatedAt: fixtureTimestamp },
        tasks: [],
        criticalExceptions: [],
        responsibilityPackages: [{ ...data.responsibilityPackages[0]!, effectiveTaskCount: 0 }]
      }
    };
  }
  if (fixture === "stale") {
    data.schedule = {
      ...data.schedule,
      status: "PENDING",
      stale: true,
      publishedInputVersion: 3
    };
  }
  if (fixture === "pending") data.schedule = { ...data.schedule, status: "PENDING" };
  if (fixture === "failed") {
    data.schedule = {
      ...data.schedule,
      status: "FAILED",
      stale: true,
      error: { code: "SCHEDULE_RECALCULATION_FAILED", message: "预测计算失败。" }
    };
  }
  return { kind: "success", data };
}

export default async function ProjectExecutionPage({ params, searchParams }: PageProps) {
  const { projectId } = await params;
  const { fixture } = await searchParams;
  const initialResult =
    process.env.NODE_ENV === "production" || !isExecutionFixture(fixture)
      ? null
      : developmentExecutionFixture(projectId, fixture);

  return <ExecutionPageClient projectId={projectId} initialResult={initialResult} />;
}
