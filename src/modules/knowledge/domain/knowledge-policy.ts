import { payloadHash } from "@/modules/governance/domain/idempotency";

export const KNOWLEDGE_VERSION_STATUS = {
  DRAFT: "DRAFT",
  IN_REVIEW: "IN_REVIEW",
  PUBLISHED: "PUBLISHED",
  REJECTED: "REJECTED",
  SUPERSEDED: "SUPERSEDED",
  REVOKED: "REVOKED"
} as const;

export type KnowledgeVersionStatus =
  (typeof KNOWLEDGE_VERSION_STATUS)[keyof typeof KNOWLEDGE_VERSION_STATUS];

export type KnowledgeDraft = {
  title: string;
  sanitizedSummary: string;
  experienceType: string;
  discipline: string;
  keywords: string[];
  applicableProjectTypes: string[];
  applicableStageCodes: string[];
  preconditions: string;
  recommendedPractice: string;
  antiPatterns: string;
  limitations: string;
  ipSanitizationDeclaration: string;
  internalReusable: boolean;
};

export type NormalizedKnowledgeDraft = Omit<KnowledgeDraft, "keywords"> & {
  normalizedKeywords: string[];
  normalizedKeywordsText: string;
};

export class KnowledgePolicyError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 422
  ) {
    super(message);
    this.name = "KnowledgePolicyError";
  }
}

export function assertKnowledgeSourceRead(input: {
  knowledgePermissionAllowed: boolean;
  sourceProjectReadAllowed: boolean;
}) {
  if (!input.knowledgePermissionAllowed || !input.sourceProjectReadAllowed) {
    throw new KnowledgePolicyError(
      "KNOWLEDGE_SOURCE_READ_FORBIDDEN",
      "读取知识来源需要知识权限和源项目读取权限。",
      403
    );
  }
}

function requiredText(value: unknown, field: string, max = 4096): string {
  if (typeof value !== "string") {
    throw new KnowledgePolicyError("KNOWLEDGE_CONTENT_INVALID", `${field} 必须是文本。`);
  }
  const normalized = value.trim();
  if (!normalized || normalized.length > max) {
    throw new KnowledgePolicyError("KNOWLEDGE_CONTENT_INVALID", `${field} 长度无效。`);
  }
  return normalized;
}

function normalizedValues(values: unknown, field: string, maxItems: number): string[] {
  if (!Array.isArray(values) || values.length === 0 || values.length > maxItems) {
    throw new KnowledgePolicyError("KNOWLEDGE_CONTENT_INVALID", `${field} 必须包含受限的非空项。`);
  }
  const normalized = values.map((value) => requiredText(value, field, 191).toLocaleLowerCase());
  return [...new Set(normalized)].sort((left, right) => left.localeCompare(right));
}

export function buildKnowledgeContent(input: KnowledgeDraft): {
  value: NormalizedKnowledgeDraft;
  contentChecksum: string;
} {
  if (typeof input.internalReusable !== "boolean") {
    throw new KnowledgePolicyError("KNOWLEDGE_CONTENT_INVALID", "internalReusable 必须是布尔值。");
  }
  const value: NormalizedKnowledgeDraft = {
    title: requiredText(input.title, "title", 191),
    sanitizedSummary: requiredText(input.sanitizedSummary, "sanitizedSummary", 4096),
    experienceType: requiredText(input.experienceType, "experienceType", 64).toUpperCase(),
    discipline: requiredText(input.discipline, "discipline", 64).toUpperCase(),
    normalizedKeywords: normalizedValues(input.keywords, "keywords", 32),
    normalizedKeywordsText: "",
    applicableProjectTypes: normalizedValues(
      input.applicableProjectTypes,
      "applicableProjectTypes",
      16
    ).map((value) => value.toUpperCase()),
    applicableStageCodes: normalizedValues(
      input.applicableStageCodes,
      "applicableStageCodes",
      32
    ).map((value) => value.toUpperCase()),
    preconditions: requiredText(input.preconditions, "preconditions", 8192),
    recommendedPractice: requiredText(input.recommendedPractice, "recommendedPractice", 8192),
    antiPatterns: requiredText(input.antiPatterns, "antiPatterns", 8192),
    limitations: requiredText(input.limitations, "limitations", 8192),
    ipSanitizationDeclaration: requiredText(
      input.ipSanitizationDeclaration,
      "ipSanitizationDeclaration",
      4096
    ),
    internalReusable: input.internalReusable
  };
  value.normalizedKeywordsText = value.normalizedKeywords.join(" ");
  return { value, contentChecksum: payloadHash(value).hash };
}

export function assertKnowledgeVersionTransition(
  from: KnowledgeVersionStatus,
  action: "SUBMIT" | "PUBLISH" | "REJECT" | "SUPERSEDE" | "REVOKE"
): KnowledgeVersionStatus {
  const transitions: Record<
    KnowledgeVersionStatus,
    Partial<Record<typeof action, KnowledgeVersionStatus>>
  > = {
    DRAFT: { SUBMIT: KNOWLEDGE_VERSION_STATUS.IN_REVIEW },
    IN_REVIEW: {
      PUBLISH: KNOWLEDGE_VERSION_STATUS.PUBLISHED,
      REJECT: KNOWLEDGE_VERSION_STATUS.REJECTED
    },
    PUBLISHED: {
      SUPERSEDE: KNOWLEDGE_VERSION_STATUS.SUPERSEDED,
      REVOKE: KNOWLEDGE_VERSION_STATUS.REVOKED
    },
    REJECTED: {},
    SUPERSEDED: { REVOKE: KNOWLEDGE_VERSION_STATUS.REVOKED },
    REVOKED: {}
  };
  const next = transitions[from][action];
  if (!next) {
    throw new KnowledgePolicyError(
      "KNOWLEDGE_VERSION_TRANSITION_INVALID",
      "知识版本当前状态不允许该操作。",
      409
    );
  }
  return next;
}
