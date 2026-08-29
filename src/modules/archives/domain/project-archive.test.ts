import { describe, expect, it } from "vitest";

import {
  ARCHIVE_VERSION_STATUSES,
  ArchiveDomainError,
  assertArchiveVersionCanBeFinalized,
  nextArchiveVersionStatus
} from "./project-archive";

describe("project archive version policy", () => {
  it("moves a verified archive version to READY", () => {
    expect(nextArchiveVersionStatus(ARCHIVE_VERSION_STATUSES.VERIFYING, "INTEGRITY_PASSED")).toBe(
      ARCHIVE_VERSION_STATUSES.READY
    );
  });

  it("allows a failed version to enter a fresh verification check", () => {
    expect(nextArchiveVersionStatus(ARCHIVE_VERSION_STATUSES.FAILED, "RECHECK_REQUESTED")).toBe(
      ARCHIVE_VERSION_STATUSES.VERIFYING
    );
  });

  it("allows finalization only from READY", () => {
    expect(() => assertArchiveVersionCanBeFinalized(ARCHIVE_VERSION_STATUSES.FAILED)).toThrowError(
      new ArchiveDomainError("ARCHIVE_NOT_READY", "只有完整性检查通过的归档版本可以结项固定。")
    );
    expect(() => assertArchiveVersionCanBeFinalized(ARCHIVE_VERSION_STATUSES.READY)).not.toThrow();
  });
});
