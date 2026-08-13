import { describe, expect, it, vi } from "vitest";

import { getArchiveSourceFormulaAdapter } from "./archive-source-formula-registry";
import { readProjectArchiveSourcesV2 } from "./archive-source-reader-v2";

describe("archive source reader V2", () => {
  it("excludes closure self-reference G9 facts while preserving non-G9 submissions", async () => {
    const sources = await readProjectArchiveSourcesV2({
      projectId: "project-1",
      client: {
        gateSubmission: { findMany: vi.fn().mockResolvedValue([{ id: "g9-sub" }]) }
      },
      readLegacySources: vi.fn().mockResolvedValue([
        {
          sourceType: "GATE_SUBMISSION",
          sourceId: "g8-sub",
          sourceVersion: 1,
          snapshotJson: { gateCode: "G8" }
        },
        {
          sourceType: "GATE_SUBMISSION",
          sourceId: "g9-sub",
          sourceVersion: 1,
          snapshotJson: { gateCode: "G9", closurePolicyVersionId: "policy-v1" }
        },
        {
          sourceType: "GATE_SUBMISSION_DOCUMENT_REFERENCE",
          sourceId: "g9-ref",
          sourceVersion: 1,
          snapshotJson: { gateSubmissionId: "g9-sub" }
        },
        {
          sourceType: "CONTROLLED_DOCUMENT_VERSION",
          sourceId: "doc-v1",
          sourceVersion: 1,
          snapshotJson: {}
        }
      ])
    });

    expect(sources.map((source) => source.sourceId)).toEqual(["g8-sub", "doc-v1"]);
  });

  it("keeps V2 current after closure facts but marks a non-G9 source change stale", async () => {
    const adapter = getArchiveSourceFormulaAdapter("ARCHIVE.SOURCE@2");
    const stableSources: Array<{
      sourceType: string;
      sourceId: string;
      sourceVersion: number;
      snapshotJson: Record<string, unknown>;
    }> = [
      {
        sourceType: "GATE_SUBMISSION",
        sourceId: "g8-sub",
        sourceVersion: 1,
        snapshotJson: { gateCode: "G8", status: "APPROVED" }
      },
      {
        sourceType: "CONTROLLED_DOCUMENT_VERSION",
        sourceId: "doc-v1",
        sourceVersion: 1,
        snapshotJson: { status: "PUBLISHED" }
      }
    ];
    const read = async (legacySources: typeof stableSources) =>
      readProjectArchiveSourcesV2({
        projectId: "project-1",
        client: {
          gateSubmission: { findMany: vi.fn().mockResolvedValue([{ id: "g9-sub" }]) }
        },
        readLegacySources: vi.fn().mockResolvedValue(legacySources)
      });
    const before = adapter.buildManifest({
      projectId: "project-1",
      items: await read(stableSources)
    });
    const afterClosure = adapter.buildManifest({
      projectId: "project-1",
      items: await read([
        ...stableSources,
        {
          sourceType: "GATE_SUBMISSION",
          sourceId: "g9-sub",
          sourceVersion: 1,
          snapshotJson: { gateCode: "G9", closurePolicyVersionId: "policy-v1" }
        },
        {
          sourceType: "GATE_SUBMISSION_DOCUMENT_REFERENCE",
          sourceId: "g9-doc-ref",
          sourceVersion: 1,
          snapshotJson: { gateSubmissionId: "g9-sub" }
        }
      ])
    });
    const afterDocumentChange = adapter.buildManifest({
      projectId: "project-1",
      items: await read([
        stableSources[0],
        { ...stableSources[1], sourceVersion: 2, snapshotJson: { status: "PUBLISHED" } }
      ])
    });

    expect(afterClosure.sourceWatermark).toBe(before.sourceWatermark);
    expect(afterDocumentChange.sourceWatermark).not.toBe(before.sourceWatermark);
  });
});
