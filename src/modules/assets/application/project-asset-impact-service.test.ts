import { readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";

import {
  assertSnapshotReadAuthorized,
  buildProjectAssetImpactSnapshot
} from "./project-asset-impact-service";

const readActor = {
  id: "reader-a",
  name: "Reader",
  status: "ACTIVE" as const,
  departmentId: "department-a",
  systemRoles: ["PROJECT_MANAGER"],
  grants: [
    {
      permission: "CONTROLLED_DOCUMENT_READ",
      scope: "PROJECT" as const,
      systemRole: "PROJECT_MANAGER"
    }
  ]
};

function readSnapshot() {
  return {
    derivations: [
      {
        derivationId: "derivation-a",
        targetControlledDocumentVersionId: "document-version-a",
        targetFileId: "file-a",
        targetSourceFileSha256: "a".repeat(64)
      }
    ],
    reports: []
  };
}

function readClient(input?: { documents?: unknown[]; sensitivity?: "INTERNAL" | "RESTRICTED" }) {
  return {
    project: {
      findUnique: vi.fn().mockResolvedValue({
        departmentId: "department-a",
        members: [{ projectRole: "PROJECT_MANAGER" }]
      })
    },
    controlledDocumentVersion: {
      findMany: vi.fn().mockResolvedValue(
        input?.documents ?? [
          {
            id: "document-version-a",
            status: "PUBLISHED",
            document: { status: "ACTIVE", createdById: "owner-a" }
          }
        ]
      )
    },
    projectAssetDerivation: {
      findMany: vi.fn().mockResolvedValue([
        {
          id: "derivation-a",
          targetControlledDocumentVersionId: "document-version-a",
          targetFileId: "file-a",
          targetSourceFileSha256: "a".repeat(64)
        }
      ])
    },
    acceptanceReport: { findMany: vi.fn().mockResolvedValue([]) },
    fileObject: {
      findMany: vi.fn().mockResolvedValue([
        {
          id: "file-a",
          projectId: "project-a",
          status: "AVAILABLE",
          sensitivity: input?.sensitivity ?? "INTERNAL",
          sha256: "a".repeat(64),
          uploadedById: "owner-a",
          project: {
            departmentId: "department-a",
            members: [{ projectRole: "PROJECT_MANAGER" }]
          }
        }
      ])
    }
  };
}

describe("APM-064 project asset impact snapshot", () => {
  it("locks Project before source and impact rows for every non-refresh command", () => {
    const source = readFileSync(
      new URL("./project-asset-impact-service.ts", import.meta.url),
      "utf8"
    );
    const projectLock = 'SELECT "id" FROM "projects"';
    const commandLock = source.slice(
      source.indexOf("async function lockCommandImpact("),
      source.indexOf("async function lockImpactSource(")
    );
    const decisionLock = source.slice(
      source.indexOf("export async function decideProjectAssetImpactRiskAcceptance("),
      source.indexOf("export async function closeProjectAssetImpact(")
    );

    for (const block of [commandLock, decisionLock]) {
      expect(block.indexOf(projectLock)).toBeGreaterThanOrEqual(0);
      expect(block.indexOf(projectLock)).toBeLessThan(block.indexOf("await lockImpactSource("));
      expect(block.indexOf("await lockImpactSource(")).toBeLessThan(
        block.indexOf('SELECT "id" FROM "asset_project_impacts"')
      );
    }
  });

  it("replays the frozen usage version and binds only reports carrying the exact usage", () => {
    const frozenAt = new Date("2026-08-20T12:00:00.000Z");
    const retiredAt = new Date("2026-08-20T12:00:01.000Z");
    const result = buildProjectAssetImpactSnapshot({
      frozenAt,
      usages: [
        {
          id: "usage-a",
          usageKey: "USAGE-A",
          version: 2,
          status: "RETIRED",
          referenceId: "reference-a",
          technicalAssetId: "asset-a",
          assetReleaseId: "release-a",
          assetReleaseVersionId: "release-version-a",
          releaseRevision: 3,
          snapshotChecksum: "e".repeat(64),
          sourceWatermark: "watermark-a",
          componentSnapshotId: "component-a",
          quantity: "2.5",
          configurationJson: { purpose: "historic impact" },
          scopeType: "PROJECT",
          scopeId: "project-a",
          deliveryUnitId: null,
          moduleId: null,
          createdAt: new Date("2026-08-20T11:00:00.000Z"),
          retiredAt
        }
      ],
      reports: [
        {
          id: "report-exact",
          snapshotChecksum: "a".repeat(64),
          snapshotJson: {
            assetUsage: {
              frozenAt: "2026-08-20T11:30:00.000Z",
              usageSnapshotChecksum: "b".repeat(64),
              snapshot: {
                entries: [
                  {
                    usageId: "usage-a",
                    version: 1,
                    referenceId: "reference-a",
                    technicalAssetId: "asset-a",
                    assetReleaseId: "release-a",
                    assetReleaseVersionId: "release-version-a",
                    componentSnapshotId: "component-a",
                    revision: 3,
                    snapshotChecksum: "e".repeat(64),
                    sourceWatermark: "watermark-a"
                  }
                ]
              }
            }
          }
        },
        {
          id: "report-other",
          snapshotChecksum: "c".repeat(64),
          snapshotJson: {
            assetUsage: {
              frozenAt: "2026-08-20T11:30:00.000Z",
              usageSnapshotChecksum: "d".repeat(64),
              snapshot: { entries: [{ usageId: "usage-b", version: 1 }] }
            }
          }
        }
      ]
    });

    expect(result.snapshotJson).toMatchObject({
      usages: [
        {
          usageId: "usage-a",
          version: 1,
          status: "ACTIVE",
          retiredAt: null
        }
      ],
      reports: [
        {
          reportId: "report-exact",
          reportChecksum: "a".repeat(64),
          frozenAt: "2026-08-20T11:30:00.000Z",
          usageSnapshotChecksum: "b".repeat(64),
          usageBindings: [{ usageId: "usage-a", version: 1 }]
        }
      ]
    });
  });

  it("excludes a same-usage report when any exact frozen source fact drifts", () => {
    const result = buildProjectAssetImpactSnapshot({
      frozenAt: new Date("2026-08-20T12:00:00.000Z"),
      usages: [
        {
          id: "usage-a",
          usageKey: "USAGE-A",
          version: 1,
          status: "ACTIVE",
          referenceId: "reference-a",
          technicalAssetId: "asset-a",
          assetReleaseId: "release-a",
          assetReleaseVersionId: "release-version-a",
          releaseRevision: 3,
          snapshotChecksum: "e".repeat(64),
          sourceWatermark: "watermark-a",
          componentSnapshotId: "component-a",
          quantity: "1",
          configurationJson: { purpose: "exact" },
          scopeType: "PROJECT",
          scopeId: "project-a",
          deliveryUnitId: null,
          moduleId: null,
          createdAt: new Date("2026-08-20T11:00:00.000Z"),
          retiredAt: null
        }
      ],
      reports: [
        {
          id: "wrong-version",
          snapshotChecksum: "1".repeat(64),
          snapshotJson: {
            assetUsage: {
              frozenAt: "2026-08-20T11:30:00.000Z",
              usageSnapshotChecksum: "2".repeat(64),
              snapshot: {
                entries: [
                  {
                    usageId: "usage-a",
                    version: 2,
                    referenceId: "reference-a",
                    technicalAssetId: "asset-a",
                    assetReleaseId: "release-a",
                    assetReleaseVersionId: "release-version-a",
                    componentSnapshotId: "component-a",
                    revision: 3,
                    snapshotChecksum: "e".repeat(64),
                    sourceWatermark: "watermark-a"
                  }
                ]
              }
            }
          }
        },
        {
          id: "wrong-component-checksum",
          snapshotChecksum: "3".repeat(64),
          snapshotJson: {
            assetUsage: {
              frozenAt: "2026-08-20T11:30:00.000Z",
              usageSnapshotChecksum: "4".repeat(64),
              snapshot: {
                entries: [
                  {
                    usageId: "usage-a",
                    version: 1,
                    referenceId: "reference-a",
                    technicalAssetId: "asset-a",
                    assetReleaseId: "release-a",
                    assetReleaseVersionId: "release-version-a",
                    componentSnapshotId: "component-b",
                    revision: 3,
                    snapshotChecksum: "f".repeat(64),
                    sourceWatermark: "watermark-a"
                  }
                ]
              }
            }
          }
        }
      ]
    });

    expect(result.snapshotJson).toMatchObject({ reports: [] });
  });

  it("rejects an invalid retired version that cannot replay its ACTIVE fact", () => {
    expect(() =>
      buildProjectAssetImpactSnapshot({
        frozenAt: new Date("2026-08-20T12:00:00.000Z"),
        usages: [
          {
            id: "usage-invalid",
            usageKey: "USAGE-INVALID",
            version: 1,
            status: "RETIRED",
            referenceId: "reference-a",
            technicalAssetId: "asset-a",
            assetReleaseId: "release-a",
            assetReleaseVersionId: "release-version-a",
            releaseRevision: 1,
            snapshotChecksum: "a".repeat(64),
            sourceWatermark: "watermark-a",
            componentSnapshotId: "component-a",
            quantity: "1",
            configurationJson: { purpose: "invalid" },
            scopeType: "PROJECT",
            scopeId: "project-a",
            deliveryUnitId: null,
            moduleId: null,
            createdAt: new Date("2026-08-20T11:00:00.000Z"),
            retiredAt: new Date("2026-08-20T12:00:01.000Z")
          }
        ],
        reports: []
      })
    ).toThrowError(expect.objectContaining({ code: "PROJECT_ASSET_SNAPSHOT_VERSION_INVALID" }));
  });
});

describe("APM-064 project asset impact snapshot read authorization", () => {
  it("default-denies a missing frozen controlled document binding", async () => {
    await expect(
      assertSnapshotReadAuthorized(
        readClient({ documents: [] }) as never,
        readSnapshot(),
        readActor,
        "project-a"
      )
    ).rejects.toMatchObject({ code: "ASSET_PROJECT_IMPACT_SOURCE_NOT_FOUND", status: 404 });
  });

  it("does not accept a controlled document returned outside the requested project", async () => {
    const client = readClient({ documents: [] });
    await expect(
      assertSnapshotReadAuthorized(client as never, readSnapshot(), readActor, "project-a")
    ).rejects.toMatchObject({ code: "ASSET_PROJECT_IMPACT_SOURCE_NOT_FOUND", status: 404 });
    expect(client.controlledDocumentVersion.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: { in: ["document-version-a"] }, projectId: "project-a" }
      })
    );
  });

  it("default-denies a restricted exact file without SENSITIVE_FILE_READ", async () => {
    await expect(
      assertSnapshotReadAuthorized(
        readClient({ sensitivity: "RESTRICTED" }) as never,
        readSnapshot(),
        readActor,
        "project-a"
      )
    ).rejects.toMatchObject({ code: "PROJECT_ASSET_SENSITIVE_FILE_DENIED", status: 403 });
  });
});
