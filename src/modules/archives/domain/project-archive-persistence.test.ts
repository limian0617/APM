import { ArchiveVersionStatus } from "@prisma/client";
import { describe, expect, it } from "vitest";

describe("project archive persistence contract", () => {
  it("exposes immutable archive version states to the database layer", () => {
    expect(ArchiveVersionStatus.VERIFYING).toBe("VERIFYING");
    expect(ArchiveVersionStatus.READY).toBe("READY");
    expect(ArchiveVersionStatus.FAILED).toBe("FAILED");
    expect(ArchiveVersionStatus.FINALIZED).toBe("FINALIZED");
  });
});
