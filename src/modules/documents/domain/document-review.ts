export const DOCUMENT_REVIEW_STATUSES = {
  PENDING: "PENDING",
  APPROVED: "APPROVED",
  CHANGES_REQUESTED: "CHANGES_REQUESTED"
} as const;

export type DocumentReviewStatus =
  (typeof DOCUMENT_REVIEW_STATUSES)[keyof typeof DOCUMENT_REVIEW_STATUSES];

export const DOCUMENT_VERSION_RELATION_TARGET_TYPES = {
  DELIVERY_UNIT: "DELIVERY_UNIT",
  MODULE: "MODULE",
  RESPONSIBILITY_PACKAGE: "RESPONSIBILITY_PACKAGE",
  PLANNING_TASK: "PLANNING_TASK",
  MILESTONE: "MILESTONE",
  GATE_INSTANCE: "GATE_INSTANCE"
} as const;

export type DocumentVersionRelationTargetType =
  (typeof DOCUMENT_VERSION_RELATION_TARGET_TYPES)[keyof typeof DOCUMENT_VERSION_RELATION_TARGET_TYPES];

export type DocumentVersionRelationTargetIds = {
  deliveryUnitId?: string;
  moduleId?: string;
  responsibilityPackageId?: string;
  planningTaskId?: string;
  milestoneId?: string;
  gateInstanceId?: string;
};

export class DocumentReviewError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 409
  ) {
    super(message);
    this.name = "DocumentReviewError";
  }
}

const targetFieldByType: Record<
  DocumentVersionRelationTargetType,
  keyof DocumentVersionRelationTargetIds
> = {
  DELIVERY_UNIT: "deliveryUnitId",
  MODULE: "moduleId",
  RESPONSIBILITY_PACKAGE: "responsibilityPackageId",
  PLANNING_TASK: "planningTaskId",
  MILESTONE: "milestoneId",
  GATE_INSTANCE: "gateInstanceId"
};

export function assertReviewDecision(input: {
  currentStatus: DocumentReviewStatus;
  nextStatus: "APPROVED" | "CHANGES_REQUESTED";
  openRequiredCommentCount: number;
}) {
  if (!Number.isSafeInteger(input.openRequiredCommentCount) || input.openRequiredCommentCount < 0) {
    throw new DocumentReviewError(
      "DOCUMENT_REVIEW_COMMENT_COUNT_INVALID",
      "评审意见统计无效。",
      422
    );
  }
  if (input.currentStatus === "APPROVED") {
    throw new DocumentReviewError(
      "DOCUMENT_REVIEW_ALREADY_APPROVED",
      "已批准的文档评审不能重复决定。"
    );
  }
  if (input.nextStatus === "APPROVED" && input.openRequiredCommentCount > 0) {
    throw new DocumentReviewError(
      "DOCUMENT_REVIEW_FEEDBACK_UNRESOLVED",
      "仍有必要评审意见未闭环，不能批准文档版本。"
    );
  }
  return true;
}

export function assertRequiredReviewClosure(input: {
  reviews: ReadonlyArray<{ id: string; required: boolean; status: DocumentReviewStatus }>;
  comments: ReadonlyArray<{ id: string; required: boolean; resolvedAt: Date | null }>;
}) {
  if (input.reviews.some((review) => review.required && review.status !== "APPROVED")) {
    throw new DocumentReviewError(
      "DOCUMENT_REVIEW_REQUIRED",
      "必要文档评审尚未全部批准，不能发布或用于 Gate。"
    );
  }
  if (input.comments.some((comment) => comment.required && !comment.resolvedAt)) {
    throw new DocumentReviewError(
      "DOCUMENT_REVIEW_FEEDBACK_UNRESOLVED",
      "仍有必要评审意见未闭环，不能发布或用于 Gate。"
    );
  }
  return true;
}

export function validateDocumentVersionRelationTarget(input: {
  targetType: DocumentVersionRelationTargetType;
  targetIds: DocumentVersionRelationTargetIds;
}) {
  const targetField = targetFieldByType[input.targetType];
  const supplied = Object.entries(input.targetIds).filter(
    ([, value]) => typeof value === "string" && value.trim().length > 0
  );
  if (supplied.length !== 1 || supplied[0]?.[0] !== targetField) {
    throw new DocumentReviewError(
      "DOCUMENT_RELATION_TARGET_INVALID",
      "文档版本业务关联必须且只能指定一个与关联类型匹配的目标。",
      422
    );
  }
  return {
    targetType: input.targetType,
    targetIds: { [targetField]: supplied[0][1].trim() } as DocumentVersionRelationTargetIds
  };
}
