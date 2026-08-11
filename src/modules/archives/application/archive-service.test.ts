import { describe, expect, it } from "vitest";

import { ArchiveServiceError, archiveServiceErrorResponse } from "./archive-service";

describe("archive service HTTP error mapping", () => {
  it("maps archive conflicts to a structured 409 response", async () => {
    const response = archiveServiceErrorResponse(
      new ArchiveServiceError("ARCHIVE_VERSION_CONFLICT", "归档版本已变化，请刷新后重试。", 409)
    );

    expect(response).not.toBeNull();
    expect(response?.status).toBe(409);
    await expect(response?.json()).resolves.toMatchObject({
      error: { code: "ARCHIVE_VERSION_CONFLICT", message: "归档版本已变化，请刷新后重试。" }
    });
  });

  it("does not map unrelated errors", () => {
    expect(archiveServiceErrorResponse(new Error("unexpected"))).toBeNull();
  });
});
