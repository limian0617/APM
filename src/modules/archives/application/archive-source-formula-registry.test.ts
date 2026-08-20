import { describe, expect, it } from "vitest";

import { APM_054_ARCHIVE_V1 } from "../fixtures/apm-054-archive-v1.fixture";
import { getArchiveSourceFormulaAdapter } from "./archive-source-formula-registry";

describe("ArchiveSourceFormulaRegistry", () => {
  it("keeps V1 on the byte-compatible APM-054 hash payload", () => {
    const manifest = getArchiveSourceFormulaAdapter("ARCHIVE.SOURCE@1").buildManifest({
      projectId: APM_054_ARCHIVE_V1.projectId,
      items: APM_054_ARCHIVE_V1.sources
    });

    expect(manifest.manifestChecksum).toBe(APM_054_ARCHIVE_V1.manifestChecksum);
    expect(manifest.sourceWatermark).toBe(APM_054_ARCHIVE_V1.sourceWatermark);
    expect(JSON.stringify(manifest.snapshotJson)).not.toContain("archiveSourceFormulaVersion");
  });

  it("includes the V2 formula in the new hash context", () => {
    const manifest = getArchiveSourceFormulaAdapter("ARCHIVE.SOURCE@2").buildManifest({
      projectId: APM_054_ARCHIVE_V1.projectId,
      items: APM_054_ARCHIVE_V1.sources
    });

    expect(manifest.manifestChecksum).not.toBe(APM_054_ARCHIVE_V1.manifestChecksum);
    expect(manifest.sourceWatermark).not.toBe(APM_054_ARCHIVE_V1.sourceWatermark);
    expect(JSON.stringify(manifest.snapshotJson)).toContain("ARCHIVE.SOURCE@2");
  });
});
