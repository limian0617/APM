import { describe, expect, it } from "vitest";

import { assertProjectCanClose, ProjectCloseError } from "./project-close-service";

describe("project close contract", () => {
  it("rejects stale closure facts as a conflict", () => {
    expect(() =>
      assertProjectCanClose({
        projectId: "p1",
        projectStatus: "IN_PROGRESS",
        projectVersion: 3,
        expectedProjectVersion: 2,
        g9Approved: true,
        g9ArchiveVersionId: "av1",
        archiveVersionId: "av1",
        archiveStatus: "READY",
        manifestChecksum: "m",
        g9ManifestChecksum: "m",
        sourceWatermark: "w",
        g9SourceWatermark: "w",
        sourceFactsCurrent: true,
        openResidualItemIds: []
      })
    ).toThrowError(
      expect.objectContaining({
        code: "PROJECT_VERSION_CONFLICT",
        status: 409
      } satisfies Partial<ProjectCloseError>)
    );
  });
});
