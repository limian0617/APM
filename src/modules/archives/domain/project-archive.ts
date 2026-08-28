export const ARCHIVE_VERSION_STATUSES = {
  VERIFYING: "VERIFYING",
  READY: "READY",
  FAILED: "FAILED",
  FINALIZED: "FINALIZED"
} as const;

export type ArchiveVersionStatus =
  (typeof ARCHIVE_VERSION_STATUSES)[keyof typeof ARCHIVE_VERSION_STATUSES];

export type ArchiveVersionAction =
  "INTEGRITY_PASSED" | "INTEGRITY_FAILED" | "RECHECK_REQUESTED" | "FINALIZE";

export class ArchiveDomainError extends Error {
  constructor(
    readonly code: "ARCHIVE_INVALID_STATUS_TRANSITION" | "ARCHIVE_NOT_READY",
    message: string
  ) {
    super(message);
    this.name = "ArchiveDomainError";
  }
}

const transitions: Readonly<
  Record<
    ArchiveVersionStatus,
    Readonly<Partial<Record<ArchiveVersionAction, ArchiveVersionStatus>>>
  >
> = {
  VERIFYING: {
    INTEGRITY_PASSED: ARCHIVE_VERSION_STATUSES.READY,
    INTEGRITY_FAILED: ARCHIVE_VERSION_STATUSES.FAILED
  },
  READY: {
    RECHECK_REQUESTED: ARCHIVE_VERSION_STATUSES.VERIFYING,
    FINALIZE: ARCHIVE_VERSION_STATUSES.FINALIZED
  },
  FAILED: {
    RECHECK_REQUESTED: ARCHIVE_VERSION_STATUSES.VERIFYING
  },
  FINALIZED: {}
};

export function nextArchiveVersionStatus(
  current: ArchiveVersionStatus,
  action: ArchiveVersionAction
): ArchiveVersionStatus {
  const next = transitions[current][action];
  if (!next) {
    throw new ArchiveDomainError(
      "ARCHIVE_INVALID_STATUS_TRANSITION",
      `归档版本当前状态 ${current} 不能执行 ${action}。`
    );
  }
  return next;
}

export function assertArchiveVersionCanBeFinalized(status: ArchiveVersionStatus) {
  if (status !== ARCHIVE_VERSION_STATUSES.READY) {
    throw new ArchiveDomainError("ARCHIVE_NOT_READY", "只有完整性检查通过的归档版本可以结项固定。");
  }
}
