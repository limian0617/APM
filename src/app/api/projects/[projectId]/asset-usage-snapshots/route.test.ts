import { beforeEach, describe, expect, it, vi } from "vitest";

import { ProjectAssetUsageError } from "@/modules/assets/domain/project-asset-usage";

const projectGuard = vi.hoisted(() => ({ authorizeProjectRequest: vi.fn() }));
const snapshotService = vi.hoisted(() => ({ getAssetUsageSnapshotForAcceptance: vi.fn() }));

vi.mock("@/lib/auth/project-guard", () => projectGuard);
vi.mock("@/modules/assets/application/project-asset-usage-service", () => snapshotService);

import { GET } from "./route";

const context = { params: Promise.resolve({ projectId: "project-1" }) };

function request(
  query = "acceptanceType=FAT&scopeType=PROJECT&scopeId=project-1&frozenAt=2026-08-19T10%3A00%3A00.000Z"
) {
  return new Request(`http://localhost/api/projects/project-1/asset-usage-snapshots?${query}`, {
    headers: { "x-apm-user-id": "reader-1" }
  });
}

describe("GET /api/projects/[projectId]/asset-usage-snapshots", () => {
  beforeEach(() => {
    projectGuard.authorizeProjectRequest.mockReset();
    snapshotService.getAssetUsageSnapshotForAcceptance.mockReset();
    projectGuard.authorizeProjectRequest.mockResolvedValue({
      authorized: true,
      actor: { id: "reader-1" },
      project: { id: "project-1", departmentId: "engineering", memberRoles: ["ENGINEER"] }
    });
    snapshotService.getAssetUsageSnapshotForAcceptance.mockResolvedValue({
      frozenAt: "2026-08-19T10:00:00.000Z",
      snapshot: { entries: [] },
      usageSnapshotChecksum: "a".repeat(64),
      auditId: "audit-1",
      outboxEventId: null
    });
  });

  it("stops unauthenticated or denied calls before the snapshot port", async () => {
    projectGuard.authorizeProjectRequest.mockResolvedValue({
      authorized: false,
      response: Response.json({ error: { code: "UNAUTHENTICATED" } }, { status: 401 })
    });

    expect((await GET(request(), context)).status).toBe(401);
    expect(snapshotService.getAssetUsageSnapshotForAcceptance).not.toHaveBeenCalled();
  });

  it.each(["PROJECT", "DELIVERY_UNIT", "MACHINE", "MODULE"])(
    "requires active project membership/read authority and returns the fixed %s snapshot response contract",
    async (scopeType) => {
      const scopeId = scopeType === "PROJECT" ? "project-1" : "unit-or-module-1";
      const response = await GET(
        request(
          `acceptanceType=FAT&scopeType=${scopeType}&scopeId=${scopeId}&frozenAt=2026-08-19T10%3A00%3A00.000Z`
        ),
        context
      );

      expect(projectGuard.authorizeProjectRequest).toHaveBeenCalledWith(
        expect.any(Request),
        "project-1",
        "PROJECT_ASSET_USAGE_READ",
        { requireProjectMembership: true }
      );
      expect(snapshotService.getAssetUsageSnapshotForAcceptance).toHaveBeenCalledWith(
        expect.objectContaining({
          projectId: "project-1",
          scopeType,
          scopeId,
          acceptanceType: "FAT",
          frozenAt: new Date("2026-08-19T10:00:00.000Z"),
          readAudit: expect.objectContaining({ actorId: "reader-1" })
        })
      );
      await expect(response.json()).resolves.toEqual({
        frozenAt: "2026-08-19T10:00:00.000Z",
        snapshot: { entries: [] },
        usageSnapshotChecksum: "a".repeat(64),
        auditId: "audit-1",
        outboxEventId: null,
        allowedActions: []
      });
    }
  );

  it("maps invalid or cross-project scope decisions without exposing a different object", async () => {
    snapshotService.getAssetUsageSnapshotForAcceptance.mockRejectedValue(
      new ProjectAssetUsageError("PROJECT_ASSET_SNAPSHOT_SCOPE_INVALID", "范围不存在。", 404)
    );

    const response = await GET(
      request(
        "acceptanceType=FAT&scopeType=PROJECT&scopeId=other-project&frozenAt=2026-08-19T10%3A00%3A00.000Z"
      ),
      context
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "PROJECT_ASSET_SNAPSHOT_SCOPE_INVALID" }
    });
  });

  it("rejects malformed or future replay timestamps before the read port", async () => {
    for (const frozenAt of ["not-a-time", "2999-01-01T00:00:00.000Z"]) {
      const response = await GET(
        request(
          `acceptanceType=FAT&scopeType=PROJECT&scopeId=project-1&frozenAt=${encodeURIComponent(frozenAt)}`
        ),
        context
      );
      expect(response.status).toBe(400);
    }
    expect(snapshotService.getAssetUsageSnapshotForAcceptance).not.toHaveBeenCalled();
  });
});
