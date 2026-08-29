import { Prisma, type AcceptanceDecision } from "@prisma/client";

import { db, inTransaction } from "@/lib/db";
import type { AuditContext } from "@/modules/audit/contracts/audit";
import {
  ACCEPTANCE_AUDIT_FIELDS,
  AUDIT_ACTIONS,
  AUDIT_OBJECT_TYPES
} from "@/modules/audit/domain/vocabulary";
import { writeAudit } from "@/modules/audit/infrastructure/write-audit";
import { payloadHash } from "@/modules/governance/domain/idempotency";
import { appendOutboxEvent } from "@/modules/governance/infrastructure/outbox";

import {
  AcceptanceOfflineDraftPolicyError,
  compareOfflineDraftBaseline,
  offlineDraftChecksum,
  resolveOfflineDraftReviewStatus,
  validateSatOfflineDraft,
  type SatOfflineDraftInput,
  type SatOfflineDraftReviewDecision
} from "../domain/sat-offline-draft-policy";
import { recordAcceptanceResultRevision } from "./acceptance-service";

export class SatOfflineDraftServiceError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 422
  ) {
    super(message);
    this.name = "SatOfflineDraftServiceError";
  }
}

type AuditInput = {
  actorId: string;
  auditContext: AuditContext;
  projectId: string;
};

function text(value: unknown, field: string, maximum = 191): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > maximum) {
    throw new SatOfflineDraftServiceError(
      "ACCEPTANCE_OFFLINE_DRAFT_INVALID_INPUT",
      `${field} 无效。`
    );
  }
  return value.trim();
}

function positiveVersion(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new SatOfflineDraftServiceError(
      "ACCEPTANCE_OFFLINE_DRAFT_VERSION_INVALID",
      "version 无效。",
      422
    );
  }
  return value as number;
}

function decision(value: unknown): AcceptanceDecision {
  if (value !== "PASS" && value !== "FAIL" && value !== "NA") {
    throw new SatOfflineDraftServiceError(
      "ACCEPTANCE_DECISION_INVALID",
      "判定必须为 PASS、FAIL 或 NA。",
      422
    );
  }
  return value;
}

function reviewDecision(value: unknown): SatOfflineDraftReviewDecision {
  if (value !== "ACCEPT" && value !== "ACCEPT_WITH_CORRECTION" && value !== "REJECT") {
    throw new SatOfflineDraftServiceError(
      "ACCEPTANCE_OFFLINE_DRAFT_REVIEW_DECISION_INVALID",
      "复核决定无效。",
      422
    );
  }
  return value;
}

function optionalText(value: unknown, field: string, maximum: number): string | null {
  if (value === undefined || value === null) return null;
  return text(value, field, maximum);
}

function normalizeEvidenceIds(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 100) {
    throw new SatOfflineDraftServiceError(
      "ACCEPTANCE_OFFLINE_DRAFT_EVIDENCE_INVALID",
      "证据文件列表无效。",
      422
    );
  }
  return [...new Set(value.map((id) => text(id, "evidenceFileIds", 191)))];
}

function policyError(error: unknown): never {
  if (error instanceof AcceptanceOfflineDraftPolicyError) {
    throw new SatOfflineDraftServiceError(error.code, error.message, error.status);
  }
  throw error;
}

async function databaseNow(client: Prisma.TransactionClient): Promise<Date> {
  const [clock] = await client.$queryRaw<Array<{ now: Date }>>`SELECT CURRENT_TIMESTAMP AS "now"`;
  if (!clock)
    throw new SatOfflineDraftServiceError(
      "DATABASE_CLOCK_UNAVAILABLE",
      "无法读取数据库时间。",
      503
    );
  return clock.now;
}

function auditContext(input: AuditInput): AuditContext {
  return { ...input.auditContext, actorId: input.actorId, projectId: input.projectId };
}

export function buildOfflineDraftServerSnapshot(input: {
  revision: {
    id: string;
    decision: AcceptanceDecision;
    measuredValue: string | null;
    measuredUnit: string | null;
    note: string | null;
  } | null;
  capturedAt: string;
  serverCapturedAt: Date;
  currentBatchVersion: number;
}) {
  return {
    currentRevisionId: input.revision?.id ?? null,
    currentDecision: input.revision?.decision ?? null,
    currentMeasuredValue: input.revision?.measuredValue ?? null,
    currentMeasuredUnit: input.revision?.measuredUnit ?? null,
    currentNote: input.revision?.note ?? null,
    currentBatchVersion: input.currentBatchVersion,
    capturedAt: input.capturedAt,
    serverCapturedAt: input.serverCapturedAt.toISOString()
  };
}

export async function submitSatOfflineDraft(
  input: SatOfflineDraftInput & AuditInput,
  transaction?: Prisma.TransactionClient
) {
  const normalized = (() => {
    try {
      return validateSatOfflineDraft(input);
    } catch (error) {
      return policyError(error);
    }
  })();
  const checksum = offlineDraftChecksum(normalized);

  return inTransaction(transaction, async (client) => {
    const existing = await client.offlineAcceptanceDraftSubmission.findUnique({
      where: {
        projectId_clientDraftId: {
          projectId: normalized.projectId,
          clientDraftId: normalized.clientDraftId
        }
      },
      include: { reviews: { orderBy: { reviewNo: "desc" }, take: 1 } }
    });
    if (existing) {
      if (existing.payloadChecksum !== checksum) {
        throw new SatOfflineDraftServiceError(
          "ACCEPTANCE_OFFLINE_DRAFT_IDEMPOTENCY_CONFLICT",
          "clientDraftId 已绑定到不同的草稿内容。",
          409
        );
      }
      return { submission: existing, status: existing.status, idempotent: true };
    }

    await client.$queryRaw`SELECT "id" FROM "acceptance_batches" WHERE "id" = ${normalized.batchId} AND "project_id" = ${normalized.projectId} FOR UPDATE`;
    const batch = await client.acceptanceBatch.findUnique({
      where: { id_projectId: { id: normalized.batchId, projectId: normalized.projectId } },
      include: {
        templateVersion: { include: { items: true } },
        results: { include: { revisions: { orderBy: { revisionNo: "desc" }, take: 1 } } }
      }
    });
    if (!batch)
      throw new SatOfflineDraftServiceError("ACCEPTANCE_BATCH_NOT_FOUND", "验收批次不存在。", 404);
    if (batch.acceptanceType !== "SAT") {
      throw new SatOfflineDraftServiceError(
        "ACCEPTANCE_OFFLINE_DRAFT_SAT_ONLY",
        "离线草稿只允许 SAT 批次。",
        422
      );
    }
    if (batch.status !== "IN_PROGRESS") {
      throw new SatOfflineDraftServiceError(
        "ACCEPTANCE_OFFLINE_DRAFT_BATCH_STATE",
        "只有进行中的 SAT 批次可以接收离线草稿。",
        409
      );
    }
    const item = batch.templateVersion.items.find(
      (candidate) => candidate.id === normalized.itemId
    );
    if (!item)
      throw new SatOfflineDraftServiceError(
        "ACCEPTANCE_OFFLINE_DRAFT_ITEM_SCOPE",
        "测试项不属于当前 SAT 批次。",
        422
      );
    if (normalized.measuredUnit !== (item.unit ?? null)) {
      throw new SatOfflineDraftServiceError(
        "ACCEPTANCE_OFFLINE_DRAFT_UNIT_MISMATCH",
        "实测单位必须使用冻结测试项单位。",
        422
      );
    }
    if (normalized.baselineResultRevisionId) {
      const baseline = await client.acceptanceTestResultRevision.findFirst({
        where: {
          id: normalized.baselineResultRevisionId,
          projectId: normalized.projectId,
          result: {
            batchId: normalized.batchId,
            itemId: normalized.itemId,
            projectId: normalized.projectId
          }
        },
        select: { id: true }
      });
      if (!baseline) {
        throw new SatOfflineDraftServiceError(
          "ACCEPTANCE_OFFLINE_DRAFT_BASELINE_SCOPE",
          "离线草稿的基准结果修订不属于当前项目、批次或测试项。",
          422
        );
      }
    }
    const currentResult = batch.results.find((result) => result.itemId === normalized.itemId);
    const currentRevision = currentResult?.revisions[0] ?? null;
    const status = compareOfflineDraftBaseline({
      baselineRevisionId: normalized.baselineResultRevisionId,
      currentRevisionId: currentRevision?.id ?? null
    });
    const now = await databaseNow(client);
    const serverSnapshot = buildOfflineDraftServerSnapshot({
      revision: currentRevision,
      capturedAt: normalized.capturedAt,
      serverCapturedAt: now,
      currentBatchVersion: batch.version
    });
    const submission = await client.offlineAcceptanceDraftSubmission.create({
      data: {
        projectId: normalized.projectId,
        batchId: normalized.batchId,
        itemId: normalized.itemId,
        clientDraftId: normalized.clientDraftId,
        baselineBatchVersion: normalized.baselineBatchVersion,
        baselineResultRevisionId: normalized.baselineResultRevisionId,
        decision: normalized.decision,
        measuredValue: normalized.measuredValue,
        measuredUnit: normalized.measuredUnit,
        note: normalized.note,
        capturedAt: new Date(normalized.capturedAt),
        submittedById: input.actorId,
        payloadChecksum: checksum,
        serverResultSnapshot: serverSnapshot,
        status
      }
    });
    const value = {
      projectId: normalized.projectId,
      batchId: normalized.batchId,
      itemId: normalized.itemId,
      clientDraftId: normalized.clientDraftId,
      baselineBatchVersion: normalized.baselineBatchVersion,
      baselineResultRevisionId: normalized.baselineResultRevisionId,
      payloadChecksum: checksum,
      status,
      submittedAt: now.toISOString()
    };
    const audit = await writeAudit(client, {
      action: AUDIT_ACTIONS.ACCEPTANCE_OFFLINE_DRAFT_SUBMITTED,
      objectType: AUDIT_OBJECT_TYPES.ACCEPTANCE_OFFLINE_DRAFT_SUBMISSION,
      objectId: submission.id,
      context: auditContext(input),
      after: { value, allowedFields: ACCEPTANCE_AUDIT_FIELDS }
    });
    const event = await appendOutboxEvent(client, {
      eventType: "acceptance.offline-draft.submitted",
      aggregateType: "OFFLINE_ACCEPTANCE_DRAFT_SUBMISSION",
      aggregateId: submission.id,
      idempotencyKey: `${normalized.projectId}:${normalized.clientDraftId}:submitted`,
      payload: { ...value, auditId: audit.id },
      traceId: input.auditContext.traceId ?? undefined
    });
    return { submission, status, idempotent: false, auditId: audit.id, outboxEventId: event.id };
  }).catch((error: unknown) => {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      throw new SatOfflineDraftServiceError(
        "ACCEPTANCE_OFFLINE_DRAFT_IDEMPOTENCY_CONFLICT",
        "离线草稿已被并发提交。",
        409
      );
    }
    throw error;
  });
}

export async function listSatOfflineDrafts(input: {
  projectId: string;
  status?: string;
  limit: number;
  cursor?: string;
  allowedActions?: readonly string[];
}) {
  const projectId = text(input.projectId, "projectId");
  const status =
    input.status && ["PENDING_REVIEW", "CONFLICT", "ACCEPTED", "REJECTED"].includes(input.status)
      ? (input.status as "PENDING_REVIEW" | "CONFLICT" | "ACCEPTED" | "REJECTED")
      : undefined;
  const rows = await db.offlineAcceptanceDraftSubmission.findMany({
    where: { projectId, ...(status ? { status } : {}) },
    include: {
      batch: {
        select: {
          id: true,
          acceptanceType: true,
          scopeType: true,
          scopeId: true,
          status: true,
          version: true
        }
      },
      item: { select: { id: true, code: true, name: true, unit: true } },
      reviews: { orderBy: { reviewNo: "desc" }, take: 1 }
    },
    orderBy: [{ submittedAt: "desc" }, { id: "desc" }],
    ...(input.cursor ? { cursor: { id: text(input.cursor, "cursor") }, skip: 1 } : {}),
    take: Math.min(Math.max(input.limit, 1), 100) + 1
  });
  const drafts = rows.slice(0, input.limit);
  return {
    projectId,
    drafts,
    allowedActions: input.allowedActions ?? [],
    nextCursor: rows.length > input.limit ? (drafts.at(-1)?.id ?? null) : null
  };
}

export async function reviewSatOfflineDraft(
  input: {
    projectId: string;
    submissionId: string;
    version: unknown;
    decision: unknown;
    reason: unknown;
    correctedDecision?: unknown;
    correctedMeasuredValue?: unknown;
    correctedMeasuredUnit?: unknown;
    correctedNote?: unknown;
    evidenceFileIds?: unknown;
    actorId: string;
    auditContext: AuditContext;
  },
  transaction?: Prisma.TransactionClient
) {
  const projectId = text(input.projectId, "projectId");
  const submissionId = text(input.submissionId, "submissionId");
  const expectedVersion = positiveVersion(input.version);
  const decisionValue = reviewDecision(input.decision);
  const reason = text(input.reason, "reason", 2048);
  const correctedDecision =
    input.correctedDecision === undefined ? undefined : decision(input.correctedDecision);
  const correctedMeasuredValue =
    input.correctedMeasuredValue === undefined
      ? undefined
      : optionalText(input.correctedMeasuredValue, "correctedMeasuredValue", 2000);
  const correctedMeasuredUnit =
    input.correctedMeasuredUnit === undefined
      ? undefined
      : optionalText(input.correctedMeasuredUnit, "correctedMeasuredUnit", 64);
  const correctedNote =
    input.correctedNote === undefined
      ? undefined
      : optionalText(input.correctedNote, "correctedNote", 4096);
  const evidenceFileIds = normalizeEvidenceIds(input.evidenceFileIds ?? []);
  if (decisionValue === "ACCEPT_WITH_CORRECTION" && correctedDecision === undefined) {
    throw new SatOfflineDraftServiceError(
      "ACCEPTANCE_OFFLINE_DRAFT_CORRECTION_REQUIRED",
      "修正后接受必须提供修正判定。",
      422
    );
  }
  return inTransaction(transaction, async (client) => {
    await client.$queryRaw`SELECT "id" FROM "offline_acceptance_draft_submissions" WHERE "id" = ${submissionId} AND "project_id" = ${projectId} FOR UPDATE`;
    const submission = await client.offlineAcceptanceDraftSubmission.findUnique({
      where: { id_projectId: { id: submissionId, projectId } },
      include: {
        batch: { include: { templateVersion: { include: { items: true } } } },
        item: true,
        reviews: { orderBy: { reviewNo: "desc" }, take: 1 }
      }
    });
    if (!submission)
      throw new SatOfflineDraftServiceError(
        "ACCEPTANCE_OFFLINE_DRAFT_NOT_FOUND",
        "离线草稿不存在。",
        404
      );
    if (submission.version !== expectedVersion) {
      throw new SatOfflineDraftServiceError(
        "ACCEPTANCE_OFFLINE_DRAFT_VERSION_CONFLICT",
        "离线草稿已发生变化，请刷新后重试。",
        409
      );
    }
    await client.$queryRaw`SELECT "id" FROM "acceptance_batches" WHERE "id" = ${submission.batchId} AND "project_id" = ${projectId} FOR UPDATE`;
    const currentResult = await client.acceptanceTestResult.findUnique({
      where: { batchId_itemId: { batchId: submission.batchId, itemId: submission.itemId } },
      select: { revisions: { orderBy: { revisionNo: "desc" }, take: 1, select: { id: true } } }
    });
    let targetStatus: "ACCEPTED" | "REJECTED";
    try {
      targetStatus = resolveOfflineDraftReviewStatus({
        submissionStatus: submission.status,
        baselineRevisionId: submission.baselineResultRevisionId,
        currentRevisionId: currentResult?.revisions[0]?.id ?? null,
        decision: decisionValue
      });
    } catch (error) {
      return policyError(error);
    }
    if (evidenceFileIds.length > 0) {
      const files = await client.fileObject.findMany({
        where: { id: { in: evidenceFileIds }, projectId },
        select: { id: true, status: true, storageArea: true, scannedAt: true, failureCode: true }
      });
      if (
        files.length !== evidenceFileIds.length ||
        files.some(
          (file) =>
            file.status !== "AVAILABLE" ||
            file.storageArea !== "CONTROLLED" ||
            !file.scannedAt ||
            file.failureCode
        )
      ) {
        throw new SatOfflineDraftServiceError(
          "ACCEPTANCE_OFFLINE_DRAFT_EVIDENCE_NOT_AVAILABLE",
          "复核证据文件不可用。",
          422
        );
      }
    }
    let reviewedResultRevisionId: string | null = null;
    if (decisionValue !== "REJECT") {
      const currentBatch = await client.acceptanceBatch.findUnique({
        where: { id_projectId: { id: submission.batchId, projectId } }
      });
      if (!currentBatch)
        throw new SatOfflineDraftServiceError(
          "ACCEPTANCE_BATCH_NOT_FOUND",
          "验收批次不存在。",
          404
        );
      const corrected = decisionValue === "ACCEPT_WITH_CORRECTION";
      const result = await recordAcceptanceResultRevision(
        {
          projectId,
          batchId: submission.batchId,
          itemId: submission.itemId,
          version: currentBatch.version,
          decision: corrected ? correctedDecision : submission.decision,
          measuredValue: corrected
            ? (correctedMeasuredValue ?? submission.measuredValue)
            : submission.measuredValue,
          measuredUnit: corrected
            ? (correctedMeasuredUnit ?? submission.measuredUnit)
            : submission.measuredUnit,
          note: corrected ? (correctedNote ?? submission.note) : submission.note,
          correctionReason: reason,
          evidenceFileIds,
          actorId: input.actorId,
          auditContext: input.auditContext
        },
        client
      );
      reviewedResultRevisionId = result.revision.id;
    }
    const lastReviewNo = submission.reviews[0]?.reviewNo ?? 0;
    const reviewChecksum = payloadHash({
      submissionId,
      reviewNo: lastReviewNo + 1,
      decision: decisionValue,
      reason,
      correctedDecision: correctedDecision ?? null,
      correctedMeasuredValue: correctedMeasuredValue ?? null,
      correctedMeasuredUnit: correctedMeasuredUnit ?? null,
      correctedNote: correctedNote ?? null,
      evidenceFileIds,
      reviewedResultRevisionId
    }).hash;
    const now = await databaseNow(client);
    const review = await client.offlineAcceptanceDraftReview.create({
      data: {
        projectId,
        submissionId,
        reviewNo: lastReviewNo + 1,
        decision: decisionValue,
        reason,
        correctedDecision: correctedDecision ?? null,
        correctedMeasuredValue: correctedMeasuredValue ?? null,
        correctedMeasuredUnit: correctedMeasuredUnit ?? null,
        correctedNote: correctedNote ?? null,
        evidenceFileIds,
        reviewedResultRevisionId,
        reviewChecksum,
        reviewedById: input.actorId,
        reviewedAt: now
      }
    });
    const updated = await client.offlineAcceptanceDraftSubmission.update({
      where: { id_projectId: { id: submissionId, projectId } },
      data: { status: targetStatus, version: { increment: 1 } }
    });
    const value = {
      projectId,
      submissionId,
      reviewNo: review.reviewNo,
      reviewDecision: decisionValue,
      reviewChecksum,
      reviewedResultRevisionId,
      status: targetStatus,
      version: updated.version
    };
    const audit = await writeAudit(client, {
      action: AUDIT_ACTIONS.ACCEPTANCE_OFFLINE_DRAFT_REVIEWED,
      objectType: AUDIT_OBJECT_TYPES.ACCEPTANCE_OFFLINE_DRAFT_REVIEW,
      objectId: review.id,
      context: { ...input.auditContext, actorId: input.actorId, projectId, reason },
      after: { value, allowedFields: ACCEPTANCE_AUDIT_FIELDS }
    });
    const event = await appendOutboxEvent(client, {
      eventType: "acceptance.offline-draft.reviewed",
      aggregateType: "OFFLINE_ACCEPTANCE_DRAFT_SUBMISSION",
      aggregateId: submissionId,
      idempotencyKey: `${submissionId}:review:${review.reviewNo}`,
      payload: { ...value, auditId: audit.id },
      traceId: input.auditContext.traceId ?? undefined
    });
    return {
      submission: updated,
      review,
      reviewedResultRevisionId,
      auditId: audit.id,
      outboxEventId: event.id
    };
  });
}
