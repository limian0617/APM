import { beforeEach, describe, expect, it, vi } from "vitest";

const projectGuard = vi.hoisted(() => ({ authorizeProjectRequest: vi.fn() }));
const readinessService = vi.hoisted(() => ({ readProcurementReadinessTree: vi.fn() }));

vi.mock("@/lib/auth/project-guard", () => projectGuard);
vi.mock("@/modules/procurement/application/readiness-service", () => readinessService);

import { GET } from "./route";

describe("GET /api/projects/[projectId]/procurement/readiness", () => {
  beforeEach(() => {
    projectGuard.authorizeProjectRequest.mockReset();
    readinessService.readProcurementReadinessTree.mockReset();
  });

  it("rejects an invalid view before calling the read service", async () => {
    projectGuard.authorizeProjectRequest.mockResolvedValue({
      authorized: true,
      actor: { id: "manager-1" },
      project: { departmentId: "engineering" }
    });

    const response = await GET(
      new Request("http://localhost/api/projects/project-1/procurement/readiness?view=tracking"),
      { params: Promise.resolve({ projectId: "project-1" }) }
    );

    expect(response.status).toBe(400);
    expect(readinessService.readProcurementReadinessTree).not.toHaveBeenCalled();
  });

  it("returns formula, watermark, calculation and source freshness metadata", async () => {
    projectGuard.authorizeProjectRequest.mockResolvedValue({
      authorized: true,
      actor: { id: "manager-1" },
      project: { departmentId: "engineering" }
    });
    readinessService.readProcurementReadinessTree.mockResolvedValue({
      projectId: "project-1",
      inputWatermark: "wm-1",
      stale: false,
      scopes: [
        {
          scopeType: "PROJECT",
          scopeId: "project-1",
          status: "READY",
          formulaVersion: "PROC-READINESS-1",
          calculatedAt: "2026-08-08T01:00:00.000Z",
          sourceSyncedAt: "2026-08-08T00:00:00.000Z"
        }
      ]
    });

    const response = await GET(
      new Request("http://localhost/api/projects/project-1/procurement/readiness?view=readiness"),
      { params: Promise.resolve({ projectId: "project-1" }) }
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      projectId: "project-1",
      status: "READY",
      formulaVersion: "PROC-READINESS-1",
      inputWatermark: "wm-1",
      calculatedAt: "2026-08-08T01:00:00.000Z",
      sourceSyncedAt: "2026-08-08T00:00:00.000Z"
    });
  });
});
