import { payloadHash } from "@/modules/governance/domain/idempotency";

export const RETROSPECTIVE_STATUS = {
  DRAFT: "DRAFT",
  IN_REVIEW: "IN_REVIEW",
  APPROVED: "APPROVED",
  REJECTED: "REJECTED",
  SUPERSEDED: "SUPERSEDED"
} as const;

export type RetrospectiveStatus = (typeof RETROSPECTIVE_STATUS)[keyof typeof RETROSPECTIVE_STATUS];
type TransitionAction = "SUBMIT" | "APPROVE" | "REJECT" | "SUPERSEDE";
export type RetrospectiveJson = unknown;

export class RetrospectiveDomainError extends Error {
  constructor(
    readonly code:
      | "RETROSPECTIVE_REQUIRED_CONTENT_MISSING"
      | "RETROSPECTIVE_DELIVERY_UNIT_REQUIRED"
      | "RETROSPECTIVE_VERSION_IMMUTABLE"
      | "RETROSPECTIVE_INDEPENDENT_REVIEW_REQUIRED",
    message: string
  ) {
    super(message);
    this.name = "RetrospectiveDomainError";
  }
}

const REQUIRED_GROUPS = [
  "deliverySummary",
  "successfulPractices",
  "shortcomings",
  "improvements",
  "knowledgeDisposition",
  "ipDeclaration"
] as const;

export type RetrospectiveContent = {
  deliverySummary: RetrospectiveJson;
  successfulPractices: RetrospectiveJson;
  shortcomings: RetrospectiveJson;
  improvements: RetrospectiveJson;
  knowledgeDisposition: RetrospectiveJson;
  ipDeclaration: RetrospectiveJson;
};

export function validateRetrospectiveContent(
  value: Partial<RetrospectiveContent>
): RetrospectiveContent {
  for (const field of REQUIRED_GROUPS) {
    if (value[field] === null || value[field] === undefined) {
      throw new RetrospectiveDomainError(
        "RETROSPECTIVE_REQUIRED_CONTENT_MISSING",
        `复盘内容 ${field} 必填。`
      );
    }
  }
  return value as RetrospectiveContent;
}

export type RetrospectiveContribution = {
  scopeType: "PROJECT" | "DELIVERY_UNIT";
  deliveryUnitId: string | null;
  discipline: string;
  contributorMembershipId: string;
  factText: string;
  impactText: string;
  reusable: boolean;
  required: boolean;
};

export function validateRetrospectiveContribution(
  value: RetrospectiveContribution
): RetrospectiveContribution {
  if (value.scopeType === "DELIVERY_UNIT" && !value.deliveryUnitId) {
    throw new RetrospectiveDomainError(
      "RETROSPECTIVE_DELIVERY_UNIT_REQUIRED",
      "交付单元范围贡献必须引用确切交付单元。"
    );
  }
  return value;
}

function stableSort<T extends Record<string, unknown>>(values: readonly T[], fields: string[]) {
  return [...values].sort((left, right) =>
    fields
      .map((field) => String(left[field] ?? ""))
      .join("\u0000")
      .localeCompare(fields.map((field) => String(right[field] ?? "")).join("\u0000"), "en")
  );
}

export function buildRetrospectiveContentSnapshot(input: {
  projectSnapshot: Record<string, unknown>;
  deliverySummary: RetrospectiveJson;
  successfulPractices: RetrospectiveJson;
  shortcomings: RetrospectiveJson;
  improvements: RetrospectiveJson;
  knowledgeDisposition: RetrospectiveJson;
  ipDeclaration: RetrospectiveJson;
  contributions: readonly RetrospectiveContribution[];
  participants: readonly Record<string, unknown>[];
  issueSources: readonly Record<string, unknown>[];
}) {
  const content = validateRetrospectiveContent(input);
  const snapshot = {
    projectSnapshot: payloadHash(input.projectSnapshot).value,
    deliverySummary: content.deliverySummary,
    successfulPractices: content.successfulPractices,
    shortcomings: content.shortcomings,
    improvements: content.improvements,
    knowledgeDisposition: content.knowledgeDisposition,
    ipDeclaration: content.ipDeclaration,
    contributions: stableSort(input.contributions, [
      "scopeType",
      "deliveryUnitId",
      "discipline",
      "contributorMembershipId"
    ]),
    participants: stableSort(input.participants, ["roleCode", "membershipId"]),
    issueSources: stableSort(input.issueSources, ["issueId", "issueHistorySequence"])
  };
  return { snapshot, contentChecksum: payloadHash(snapshot).hash };
}

export function assertRetrospectiveVersionTransition(
  status: RetrospectiveStatus,
  action: TransitionAction,
  review?: { submitterId: string; reviewerId: string }
): RetrospectiveStatus {
  if (action === "APPROVE" && review && review.submitterId === review.reviewerId) {
    throw new RetrospectiveDomainError(
      "RETROSPECTIVE_INDEPENDENT_REVIEW_REQUIRED",
      "复盘提交人不能作为独立审核人。"
    );
  }
  const next: Record<
    RetrospectiveStatus,
    Partial<Record<TransitionAction, RetrospectiveStatus>>
  > = {
    DRAFT: { SUBMIT: RETROSPECTIVE_STATUS.IN_REVIEW, SUPERSEDE: RETROSPECTIVE_STATUS.SUPERSEDED },
    IN_REVIEW: { APPROVE: RETROSPECTIVE_STATUS.APPROVED, REJECT: RETROSPECTIVE_STATUS.REJECTED },
    APPROVED: { SUPERSEDE: RETROSPECTIVE_STATUS.SUPERSEDED },
    REJECTED: { SUPERSEDE: RETROSPECTIVE_STATUS.SUPERSEDED },
    SUPERSEDED: {}
  };
  const result = next[status]?.[action];
  if (!result) {
    throw new RetrospectiveDomainError(
      "RETROSPECTIVE_VERSION_IMMUTABLE",
      `复盘版本 ${status} 不能执行 ${action}。`
    );
  }
  return result;
}

export function canUseRetrospectiveForClosure(input: {
  currentVersionId: string | null;
  latestApprovedVersionId: string | null;
  versionId: string;
  status: string;
  archiveBStatus: string;
  archiveBIntegrityStatus: string;
}) {
  return (
    input.currentVersionId === input.latestApprovedVersionId &&
    input.versionId === input.latestApprovedVersionId &&
    input.status === RETROSPECTIVE_STATUS.APPROVED &&
    input.archiveBStatus === "READY" &&
    input.archiveBIntegrityStatus === "PASSED"
  );
}
