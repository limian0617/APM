import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  client: {
    projectAssetDerivation: { findMany: vi.fn() },
    auditLog: { create: vi.fn() }
  },
  writeAudit: vi.fn()
}));

vi.mock("@/lib/db", () => ({
  db: { $transaction: async (operation: (client: unknown) => unknown) => operation(mocks.client) },
  inTransaction: (transaction: unknown, operation: (client: unknown) => unknown) =>
    operation(transaction ?? mocks.client)
}));
vi.mock("@/modules/audit/infrastructure/write-audit", () => ({ writeAudit: mocks.writeAudit }));

import { listProjectAssetDerivations } from "./project-asset-usage-service";

const derivation = {
  id: "derivation-1",
  projectId: "project-1",
  sourceReferenceId: "reference-1",
  sourceUsageId: "usage-1",
  sourceTechnicalAssetId: "asset-1",
  sourceAssetReleaseId: "release-1",
  sourceAssetReleaseVersionId: "version-1",
  sourceComponentSnapshotId: "component-1",
  sourceReleaseRevision: 3,
  sourceSnapshotChecksum: "a".repeat(64),
  sourceWatermark: "watermark-1",
  targetType: "CONTROLLED_DOCUMENT_VERSION",
  targetControlledDocumentVersionId: "document-version-1",
  targetMechanicalDrawingId: null,
  targetFileId: "file-1",
  targetSourceFileSha256: "b".repeat(64),
  targetDocumentVersion: 2,
  targetDocumentVersionStatus: "PUBLISHED",
  targetFileStatus: "AVAILABLE",
  reason: "derive",
  createdAt: new Date("2026-08-20T00:00:00.000Z")
};

describe("APM-063 derivation response contract", () => {
  beforeEach(() => {
    mocks.client.projectAssetDerivation.findMany.mockReset().mockResolvedValue([derivation]);
    mocks.writeAudit.mockReset().mockResolvedValue({ id: "audit-1" });
  });

  it("uses the frozen external targetSourceFileId and omits the internal targetFileId", async () => {
    const result = await listProjectAssetDerivations({
      projectId: "project-1",
      usageId: "usage-1",
      actorId: "actor-1",
      auditContext: {
        actorId: "actor-1",
        requestId: null,
        traceId: null,
        source: "API",
        sourceIp: null,
        userAgent: null,
        reason: null,
        projectId: "project-1",
        departmentId: null,
        operationId: null
      },
      canManage: true
    });

    expect(result).toMatchObject({
      nextCursor: null,
      allowedActions: ["CREATE"],
      auditId: "audit-1",
      outboxEventId: null
    });
    expect(result.items[0]).toMatchObject({ targetSourceFileId: "file-1", allowedActions: [] });
    expect(result.items[0]).not.toHaveProperty("targetFileId");
    expect(mocks.writeAudit).toHaveBeenCalledWith(
      mocks.client,
      expect.objectContaining({ action: "PROJECT_ASSET_DERIVATION_READ", objectId: "usage-1" })
    );
  });
});
