import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  ACCEPTANCE_CONFIRMATION_DECISIONS,
  ACCEPTANCE_CONFIRMATION_CHANNELS,
  ACCEPTANCE_REPORT_STATUSES,
  buildAcceptanceReportSnapshot,
  calculateSnapshotChecksum,
  matchesExistingAcceptanceReportSnapshot,
  assertReportCanGenerate,
  assertConfirmationEvidence
} from "./acceptance-report-policy";

describe("APM-102 acceptance report policy", () => {
  it("only generates a report from a locked batch", () => {
    expect(() => assertReportCanGenerate("IN_PROGRESS")).toThrowError(
      expect.objectContaining({ code: "ACCEPTANCE_REPORT_BATCH_NOT_LOCKED", status: 409 })
    );
    expect(() => assertReportCanGenerate("LOCKED")).not.toThrow();
  });

  it("normalizes snapshots deterministically and preserves source facts", () => {
    const first = buildAcceptanceReportSnapshot({
      project: { id: "p-1", name: "示例", code: "P-001" },
      batch: { id: "b-1", acceptanceType: "FAT", scopeType: "PROJECT", scopeId: "p-1" },
      template: { id: "tv-1", version: 2, checksum: "template-hash" },
      items: [
        {
          code: "T-02",
          position: 2,
          name: "电压",
          method: "测量",
          acceptanceCriteria: "220V",
          unit: "V",
          required: true,
          decision: "PASS",
          measuredValue: "220",
          measuredUnit: "V",
          note: "ok",
          resultRevisionId: "rev-2",
          evidence: [{ fileId: "f-2", sha256: "file-hash-2" }]
        },
        {
          code: "T-01",
          position: 1,
          name: "外观",
          method: "目测",
          acceptanceCriteria: "无缺陷",
          unit: null,
          required: false,
          decision: "NA",
          measuredValue: null,
          measuredUnit: null,
          note: null,
          resultRevisionId: null,
          evidence: []
        }
      ],
      issues: [{ issueId: "i-1", resultRevisionId: "rev-2", status: "OPEN", severity: "HIGH" }],
      gate: { status: "HARD_FAILED", warnings: ["i-1"], residualItemIds: ["r-1"] },
      retestOfBatchId: null,
      frozenAt: "2026-08-09T00:00:00.000Z",
      rendererVersion: "pdf-v1"
    });

    const second = buildAcceptanceReportSnapshot({
      project: { id: "p-1", name: "示例", code: "P-001" },
      batch: { id: "b-1", acceptanceType: "FAT", scopeType: "PROJECT", scopeId: "p-1" },
      template: { id: "tv-1", version: 2, checksum: "template-hash" },
      items: [...first.items].reverse(),
      issues: [{ severity: "HIGH", status: "OPEN", issueId: "i-1", resultRevisionId: "rev-2" }],
      gate: { residualItemIds: ["r-1"], warnings: ["i-1"], status: "HARD_FAILED" },
      retestOfBatchId: null,
      frozenAt: "2026-08-09T00:00:00.000Z",
      rendererVersion: "pdf-v1"
    });

    expect(first).toEqual(second);
    expect(calculateSnapshotChecksum(first)).toBe(calculateSnapshotChecksum(second));
    expect(calculateSnapshotChecksum(first)).toMatch(/^[a-f0-9]{64}$/);

    const refreshedAtDifferentTime = buildAcceptanceReportSnapshot({
      ...second,
      frozenAt: "2026-08-09T01:00:00.000Z"
    });
    expect(
      matchesExistingAcceptanceReportSnapshot({
        existingSnapshot: first,
        existingSnapshotChecksum: calculateSnapshotChecksum(first),
        currentSnapshot: refreshedAtDifferentTime
      })
    ).toBe(true);
    expect(
      matchesExistingAcceptanceReportSnapshot({
        existingSnapshot: first,
        existingSnapshotChecksum: calculateSnapshotChecksum(first),
        currentSnapshot: buildAcceptanceReportSnapshot({
          ...refreshedAtDifferentTime,
          gate: { ...refreshedAtDifferentTime.gate, status: "WARNING" }
        })
      })
    ).toBe(false);
  });

  it("rejects unsafe confirmation evidence", () => {
    expect(() =>
      assertConfirmationEvidence({
        projectId: "p-1",
        file: {
          projectId: "p-1",
          status: "PENDING_SCAN",
          storageArea: "CONTROLLED",
          sensitivity: "RESTRICTED",
          scannedAt: null,
          sha256: "hash"
        }
      })
    ).toThrowError(expect.objectContaining({ code: "CONFIRMATION_EVIDENCE_NOT_AVAILABLE" }));

    expect(() =>
      assertConfirmationEvidence({
        projectId: "p-1",
        file: {
          projectId: "p-2",
          status: "AVAILABLE",
          storageArea: "CONTROLLED",
          sensitivity: "RESTRICTED",
          scannedAt: new Date(),
          sha256: "hash"
        }
      })
    ).toThrowError(expect.objectContaining({ code: "CONFIRMATION_EVIDENCE_PROJECT_MISMATCH" }));
  });

  it("normalizes nested asset-usage frozen facts before reusing a report", () => {
    const frozenAt = "2026-08-09T00:00:00.000Z";
    const assetUsageSnapshot = {
      acceptanceType: "FAT",
      entries: [],
      frozenAt,
      projectId: "p-1",
      scopeId: "p-1",
      scopeType: "PROJECT"
    };
    const usageSnapshotChecksum = createHash("sha256")
      .update(JSON.stringify(assetUsageSnapshot), "utf8")
      .digest("hex");
    const first = buildAcceptanceReportSnapshot({
      project: { id: "p-1", name: "示例", code: "P-001" },
      batch: { id: "b-1", acceptanceType: "FAT", scopeType: "PROJECT", scopeId: "p-1" },
      template: { id: "tv-1", version: 2, checksum: "template-hash" },
      items: [],
      issues: [],
      gate: { status: "NOT_RUN", warnings: [], residualItemIds: [] },
      assetUsage: { frozenAt, snapshot: assetUsageSnapshot, usageSnapshotChecksum },
      retestOfBatchId: null,
      frozenAt,
      rendererVersion: "pdf-v1"
    });
    const laterFrozenAt = "2026-08-09T01:00:00.000Z";
    const laterAssetUsageSnapshot = { ...assetUsageSnapshot, frozenAt: laterFrozenAt };
    const refreshed = buildAcceptanceReportSnapshot({
      ...first,
      assetUsage: {
        frozenAt: laterFrozenAt,
        snapshot: laterAssetUsageSnapshot,
        usageSnapshotChecksum: createHash("sha256")
          .update(JSON.stringify(laterAssetUsageSnapshot), "utf8")
          .digest("hex")
      },
      frozenAt: laterFrozenAt
    });

    expect(
      matchesExistingAcceptanceReportSnapshot({
        existingSnapshot: first,
        existingSnapshotChecksum: calculateSnapshotChecksum(first),
        currentSnapshot: refreshed
      })
    ).toBe(true);
  });

  it("exposes only the versioned states and confirmation enums", () => {
    expect(ACCEPTANCE_REPORT_STATUSES).toEqual([
      "GENERATING",
      "FAILED",
      "READY",
      "PUBLISHED",
      "SUPERSEDED"
    ]);
    expect(ACCEPTANCE_CONFIRMATION_DECISIONS).toEqual([
      "ACCEPTED",
      "ACCEPTED_WITH_RESERVATIONS",
      "REJECTED"
    ]);
    expect(ACCEPTANCE_CONFIRMATION_CHANNELS).toEqual([
      "SIGNED_DOCUMENT",
      "EMAIL",
      "MEETING_MINUTES",
      "OTHER"
    ]);
  });
});
