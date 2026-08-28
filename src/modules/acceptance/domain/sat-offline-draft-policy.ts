import { payloadHash } from "@/modules/governance/domain/idempotency";

export const SAT_OFFLINE_DRAFT_STATUSES = [
  "PENDING_REVIEW",
  "CONFLICT",
  "ACCEPTED",
  "REJECTED"
] as const;
export type SatOfflineDraftStatus = (typeof SAT_OFFLINE_DRAFT_STATUSES)[number];

export const SAT_OFFLINE_DRAFT_REVIEW_DECISIONS = [
  "ACCEPT",
  "ACCEPT_WITH_CORRECTION",
  "REJECT"
] as const;
export type SatOfflineDraftReviewDecision = (typeof SAT_OFFLINE_DRAFT_REVIEW_DECISIONS)[number];

export type SatOfflineDraftInput = {
  clientDraftId: string;
  projectId: string;
  batchId: string;
  itemId: string;
  baselineBatchVersion: number;
  baselineResultRevisionId: string | null;
  decision: "PASS" | "FAIL" | "NA";
  measuredValue: string | null;
  measuredUnit: string | null;
  note: string | null;
  capturedAt: string;
};

export class AcceptanceOfflineDraftPolicyError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 422
  ) {
    super(message);
    this.name = "AcceptanceOfflineDraftPolicyError";
  }
}

function requireText(value: unknown, code: string, field: string, max = 191): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > max) {
    throw new AcceptanceOfflineDraftPolicyError(code, `${field} 无效。`);
  }
  return value.trim();
}

export function validateSatOfflineDraft(
  input: SatOfflineDraftInput & { acceptanceType?: unknown }
) {
  if (input.acceptanceType !== undefined && input.acceptanceType !== "SAT") {
    throw new AcceptanceOfflineDraftPolicyError(
      "ACCEPTANCE_OFFLINE_DRAFT_SAT_ONLY",
      "离线草稿只允许 SAT 批次。"
    );
  }
  requireText(input.clientDraftId, "ACCEPTANCE_OFFLINE_DRAFT_ID_INVALID", "clientDraftId");
  requireText(input.projectId, "ACCEPTANCE_PROJECT_INVALID", "projectId");
  requireText(input.batchId, "ACCEPTANCE_BATCH_INVALID", "batchId");
  requireText(input.itemId, "ACCEPTANCE_TEST_ITEM_INVALID", "itemId");
  if (!Number.isSafeInteger(input.baselineBatchVersion) || input.baselineBatchVersion < 1) {
    throw new AcceptanceOfflineDraftPolicyError(
      "ACCEPTANCE_OFFLINE_DRAFT_VERSION_INVALID",
      "离线草稿基准批次版本无效。"
    );
  }
  if (input.decision !== "PASS" && input.decision !== "FAIL" && input.decision !== "NA") {
    throw new AcceptanceOfflineDraftPolicyError(
      "ACCEPTANCE_DECISION_INVALID",
      "离线草稿判定必须为 PASS、FAIL 或 NA。"
    );
  }
  if (!Number.isFinite(Date.parse(input.capturedAt))) {
    throw new AcceptanceOfflineDraftPolicyError(
      "ACCEPTANCE_OFFLINE_DRAFT_CAPTURED_AT_INVALID",
      "客户端采集时间无效。"
    );
  }
  return input;
}

export function offlineDraftChecksum(input: SatOfflineDraftInput): string {
  return payloadHash({
    clientDraftId: input.clientDraftId,
    projectId: input.projectId,
    batchId: input.batchId,
    itemId: input.itemId,
    baselineBatchVersion: input.baselineBatchVersion,
    baselineResultRevisionId: input.baselineResultRevisionId,
    decision: input.decision,
    measuredValue: input.measuredValue,
    measuredUnit: input.measuredUnit,
    note: input.note,
    capturedAt: input.capturedAt
  }).hash;
}

export function compareOfflineDraftBaseline(input: {
  baselineRevisionId: string | null;
  currentRevisionId: string | null;
}): "PENDING_REVIEW" | "CONFLICT" {
  return input.baselineRevisionId === input.currentRevisionId ? "PENDING_REVIEW" : "CONFLICT";
}

export function assertOfflineDraftReviewTransition(
  status: SatOfflineDraftStatus,
  decision: SatOfflineDraftReviewDecision
): "ACCEPTED" | "REJECTED" {
  if (status !== "PENDING_REVIEW" && status !== "CONFLICT") {
    throw new AcceptanceOfflineDraftPolicyError(
      "ACCEPTANCE_OFFLINE_DRAFT_ALREADY_REVIEWED",
      "离线草稿已经完成复核。",
      409
    );
  }
  if (status === "CONFLICT" && decision === "ACCEPT") {
    throw new AcceptanceOfflineDraftPolicyError(
      "ACCEPTANCE_OFFLINE_DRAFT_CONFLICT",
      "存在服务器结果冲突，必须修正后接受或拒绝。",
      409
    );
  }
  return decision === "REJECT" ? "REJECTED" : "ACCEPTED";
}

export function resolveOfflineDraftReviewStatus(input: {
  submissionStatus: SatOfflineDraftStatus;
  baselineRevisionId: string | null;
  currentRevisionId: string | null;
  decision: SatOfflineDraftReviewDecision;
}): "ACCEPTED" | "REJECTED" {
  const currentStatus =
    input.submissionStatus === "PENDING_REVIEW" &&
    compareOfflineDraftBaseline({
      baselineRevisionId: input.baselineRevisionId,
      currentRevisionId: input.currentRevisionId
    }) === "CONFLICT"
      ? "CONFLICT"
      : input.submissionStatus;
  return assertOfflineDraftReviewTransition(currentStatus, input.decision);
}
