import { beforeEach, describe, expect, it, vi } from "vitest";

const projectGuard = vi.hoisted(() => ({ authorizeProjectRequest: vi.fn() }));
const readinessService = vi.hoisted(() => ({ readProjectProcurementOverview: vi.fn() }));

vi.mock("@/lib/auth/project-guard", () => projectGuard);
vi.mock("@/modules/procurement/application/readiness-service", () => readinessService);

import { GET } from "./route";

describe("GET /api/projects/[projectId]/procurement/overview", () => {
  beforeEach(() => {
    projectGuard.authorizeProjectRequest.mockReset();
    readinessService.readProjectProcurementOverview.mockReset();
  });

  it("requires project procurement read permission before reading", async () => {
    projectGuard.authorizeProjectRequest.mockResolvedValue({
      authorized: false,
      response: Response.json({ error: { code: "FORBIDDEN" } }, { status: 403 })
    });

    const response = await GET(
      new Request("http://localhost/api/projects/project-1/procurement/overview"),
      { params: Promise.resolve({ projectId: "project-1" }) }
    );

    expect(projectGuard.authorizeProjectRequest).toHaveBeenCalledWith(
      expect.any(Request),
      "project-1",
      "PROJECT_PROCUREMENT_READ"
    );
    expect(readinessService.readProjectProcurementOverview).not.toHaveBeenCalled();
    expect(response.status).toBe(403);
  });

  it("returns the current project overview and preserves stale status", async () => {
    projectGuard.authorizeProjectRequest.mockResolvedValue({
      authorized: true,
      actor: { id: "manager-1" },
      project: { departmentId: "engineering" }
    });
    readinessService.readProjectProcurementOverview.mockResolvedValue({
      projectId: "project-1",
      projectName: "装配线升级项目",
      projectCode: "APM-001",
      mode: "ERP",
      overallReadinessRate: "0.75",
      criticalReadinessRate: "0.5",
      criticalGapLines: 2,
      notOrderedCount: 3,
      overdueCount: 4,
      pendingAcceptanceCount: 5,
      changePendingCount: 6,
      blockingCount: 7,
      sourceSyncedAt: "2026-08-07T01:00:00.000Z",
      calculatedAt: "2026-08-07T02:00:00.000Z",
      sourceTimestamps: {
        requirements: "2026-08-07T00:00:00.000Z",
        tracking: "2026-08-07T00:30:00.000Z",
        fulfillment: "2026-08-07T01:00:00.000Z",
        readiness: "2026-08-07T02:00:00.000Z"
      },
      stale: true,
      readiness: {
        projectId: "project-1",
        scopeType: "PROJECT",
        scopeId: "project-1",
        status: "STALE",
        sourceMode: "ERP",
        sourceSyncedAt: "2026-08-07T01:00:00.000Z",
        calculatedAt: "2026-08-07T02:00:00.000Z"
      }
    });

    const response = await GET(
      new Request("http://localhost/api/projects/project-1/procurement/overview?view=overview"),
      { params: Promise.resolve({ projectId: "project-1" }) }
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      projectId: "project-1",
      projectName: "装配线升级项目",
      projectCode: "APM-001",
      status: "STALE",
      mode: "ERP",
      stale: true,
      overallReadinessRate: "0.75",
      criticalReadinessRate: "0.5",
      criticalGapLines: 2,
      notOrderedCount: 3,
      overdueCount: 4,
      pendingAcceptanceCount: 5,
      changePendingCount: 6,
      blockingCount: 7,
      sourceSyncedAt: "2026-08-07T01:00:00.000Z",
      calculatedAt: "2026-08-07T02:00:00.000Z",
      sourceTimestamps: {
        requirements: "2026-08-07T00:00:00.000Z",
        tracking: "2026-08-07T00:30:00.000Z",
        fulfillment: "2026-08-07T01:00:00.000Z",
        readiness: "2026-08-07T02:00:00.000Z"
      }
    });
  });
});
