import { Prisma } from "@prisma/client";

import { db, inTransaction } from "@/lib/db";
import type { AuditContext } from "@/modules/audit/contracts/audit";
import {
  AUDIT_ACTIONS,
  AUDIT_OBJECT_TYPES,
  KNOWLEDGE_REUSE_AUDIT_FIELDS
} from "@/modules/audit/domain/vocabulary";
import { writeAudit } from "@/modules/audit/infrastructure/write-audit";
import { appendOutboxEvent } from "@/modules/governance/infrastructure/outbox";
import { assertProjectWritable } from "@/modules/projects/domain/project-write-policy";

type Client = Prisma.TransactionClient | typeof db;

export class KnowledgeReuseServiceError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 422
  ) {
    super(message);
    this.name = "KnowledgeReuseServiceError";
  }
}

export type ConfirmKnowledgeReuseInput = {
  targetProjectId: string;
  targetDeliveryUnitId: string | null;
  entryCode: string;
  version: number;
  scenario: string;
  evidenceSummary: string;
  actorId: string;
  idempotencyKey: string;
  auditContext?: AuditContext;
  targetProjectAccess: boolean;
};

export type CorrectKnowledgeReuseInput = {
  targetProjectId: string;
  reuseRecordId: string;
  expectedReuseVersion: number;
  correctionType: "TEXT_CORRECTION" | "USAGE_WITHDRAWN" | "SCOPE_CORRECTION";
  reason: string;
  correctionText: string;
  actorId: string;
  idempotencyKey: string;
  auditContext?: AuditContext;
  targetProjectAccess: boolean;
};

function text(value: string, field: string, max = 4096) {
  const normalized = value.trim();
  if (!normalized || normalized.length > max) {
    throw new KnowledgeReuseServiceError("KNOWLEDGE_REUSE_INPUT_INVALID", `${field} 无效。`);
  }
  return normalized;
}

function positiveVersion(value: unknown, field: string) {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > 2_147_483_647) {
    throw new KnowledgeReuseServiceError("KNOWLEDGE_REUSE_INPUT_INVALID", `${field} 无效。`);
  }
  return value as number;
}

function auditContext(input: { actorId: string; projectId: string; auditContext?: AuditContext }) {
  return {
    ...(input.auditContext ?? {}),
    actorId: input.actorId,
    projectId: input.projectId
  } as AuditContext;
}

async function databaseNow(client: Client): Promise<Date> {
  const [clock] = await client.$queryRaw<Array<{ now: unknown }>>`
    SELECT CURRENT_TIMESTAMP AS "now"
  `;
  if (!(clock?.now instanceof Date) || Number.isNaN(clock.now.getTime())) {
    throw new KnowledgeReuseServiceError(
      "KNOWLEDGE_DATABASE_CLOCK_UNAVAILABLE",
      "无法读取知识复用所需的数据库时间。",
      503
    );
  }
  return clock.now;
}

type AdoptableKnowledgeVersion = {
  entryId: string;
  entryStatus: string;
  currentPublishedVersionId: string | null;
  knowledgeVersionId: string;
  knowledgeVersionStatus: string;
  internalReusable: boolean;
};

async function lockAdoptableKnowledgeVersion(
  client: Client,
  input: { entryCode: string; version: number }
): Promise<{ entryId: string; knowledgeVersionId: string }> {
  const entryCode = text(input.entryCode, "entryCode", 64).toUpperCase();
  const versionNo = positiveVersion(input.version, "version");
  const [candidate] = await client.$queryRaw<AdoptableKnowledgeVersion[]>`
    SELECT
      e."id" AS "entryId",
      e."status" AS "entryStatus",
      e."current_published_version_id" AS "currentPublishedVersionId",
      v."id" AS "knowledgeVersionId",
      v."status" AS "knowledgeVersionStatus",
      v."internal_reusable" AS "internalReusable"
    FROM "knowledge_entries" AS e
    INNER JOIN "knowledge_entry_versions" AS v ON v."entry_id" = e."id"
    WHERE e."code" = ${entryCode} AND v."version_no" = ${versionNo}
    FOR UPDATE OF e, v
  `;
  if (
    !candidate ||
    candidate.entryStatus !== "ACTIVE" ||
    candidate.knowledgeVersionStatus !== "PUBLISHED" ||
    candidate.internalReusable !== true ||
    candidate.currentPublishedVersionId !== candidate.knowledgeVersionId
  ) {
    throw new KnowledgeReuseServiceError(
      "KNOWLEDGE_REUSE_VERSION_NOT_ADOPTABLE",
      "只能确认已发布且内部可复用的确切知识版本。",
      409
    );
  }
  return { entryId: candidate.entryId, knowledgeVersionId: candidate.knowledgeVersionId };
}

export async function confirmKnowledgeReuse(
  input: ConfirmKnowledgeReuseInput,
  transaction?: Prisma.TransactionClient
) {
  return inTransaction(transaction, async (client: Client) => {
    if (!input.targetProjectAccess) {
      throw new KnowledgeReuseServiceError(
        "KNOWLEDGE_REUSE_TARGET_PROJECT_FORBIDDEN",
        "没有目标项目的知识复用确认权限。",
        403
      );
    }
    const targetProjectId = text(input.targetProjectId, "targetProjectId", 191);
    const idempotencyKey = text(input.idempotencyKey, "idempotencyKey", 191);
    const targetDeliveryUnitId = input.targetDeliveryUnitId
      ? text(input.targetDeliveryUnitId, "targetDeliveryUnitId", 191)
      : null;
    const project = await client.project.findUnique({
      where: { id: targetProjectId },
      select: { id: true, status: true }
    });
    if (!project) {
      throw new KnowledgeReuseServiceError(
        "KNOWLEDGE_REUSE_TARGET_PROJECT_NOT_FOUND",
        "目标项目不存在。",
        404
      );
    }
    assertProjectWritable(project.status);
    const membership = await client.projectMember.findFirst({
      where: { projectId: project.id, userId: input.actorId, leftAt: null },
      select: { id: true, projectId: true }
    });
    if (!membership) {
      throw new KnowledgeReuseServiceError(
        "KNOWLEDGE_REUSE_TARGET_MEMBERSHIP_REQUIRED",
        "确认人必须是目标项目的有效成员。",
        403
      );
    }
    const { entryId, knowledgeVersionId } = await lockAdoptableKnowledgeVersion(client, input);
    if (targetDeliveryUnitId) {
      const deliveryUnit = await client.deliveryUnit.findFirst({
        where: {
          id: targetDeliveryUnitId,
          projectId: project.id
        },
        select: { id: true }
      });
      if (!deliveryUnit) {
        throw new KnowledgeReuseServiceError(
          "KNOWLEDGE_REUSE_DELIVERY_UNIT_NOT_IN_TARGET_PROJECT",
          "交付单元必须属于目标项目。",
          409
        );
      }
    }
    const existing = await client.knowledgeReuseRecord.findUnique({
      where: {
        targetProjectId_knowledgeVersionId: { targetProjectId: project.id, knowledgeVersionId }
      }
    });
    if (existing) {
      if (existing.idempotencyKey === idempotencyKey) return { ...existing, idempotent: true };
      throw new KnowledgeReuseServiceError(
        "KNOWLEDGE_REUSE_ALREADY_CONFIRMED",
        "该目标项目已经确认采用此知识版本。",
        409
      );
    }
    const now = await databaseNow(client);
    const reuse = await client.knowledgeReuseRecord.create({
      data: {
        targetProjectId: project.id,
        targetDeliveryUnitId,
        knowledgeEntryId: entryId,
        knowledgeVersionId,
        scenario: text(input.scenario, "scenario", 4096),
        evidenceSummary: text(input.evidenceSummary, "evidenceSummary", 4096),
        confirmedById: membership.id,
        confirmedAt: now,
        idempotencyKey
      }
    });
    const audit = await writeAudit(client, {
      action: AUDIT_ACTIONS.KNOWLEDGE_REUSE_CONFIRMED,
      objectType: AUDIT_OBJECT_TYPES.KNOWLEDGE_REUSE_RECORD,
      objectId: reuse.id,
      context: auditContext({
        actorId: input.actorId,
        projectId: project.id,
        auditContext: input.auditContext
      }),
      after: {
        value: {
          reuseRecordId: reuse.id,
          targetProjectId: project.id,
          knowledgeEntryId: entryId,
          knowledgeVersionId
        },
        allowedFields: KNOWLEDGE_REUSE_AUDIT_FIELDS
      }
    });
    const outbox = await appendOutboxEvent(client, {
      eventType: "knowledge.reuse.confirmed",
      aggregateType: AUDIT_OBJECT_TYPES.KNOWLEDGE_REUSE_RECORD,
      aggregateId: reuse.id,
      idempotencyKey,
      payload: {
        reuseRecordId: reuse.id,
        targetProjectId: project.id,
        knowledgeEntryId: entryId,
        knowledgeVersionId,
        auditId: audit.id
      }
    });
    return { ...reuse, idempotent: false, auditId: audit.id, outboxEventId: outbox.id };
  });
}

export async function correctKnowledgeReuse(
  input: CorrectKnowledgeReuseInput,
  transaction?: Prisma.TransactionClient
) {
  return inTransaction(transaction, async (client: Client) => {
    if (!input.targetProjectAccess) {
      throw new KnowledgeReuseServiceError(
        "KNOWLEDGE_REUSE_TARGET_PROJECT_FORBIDDEN",
        "没有目标项目的知识复用更正权限。",
        403
      );
    }
    const targetProjectId = text(input.targetProjectId, "targetProjectId", 191);
    const project = await client.project.findUnique({
      where: { id: targetProjectId },
      select: { id: true, status: true }
    });
    if (!project) {
      throw new KnowledgeReuseServiceError(
        "KNOWLEDGE_REUSE_TARGET_PROJECT_NOT_FOUND",
        "目标项目不存在。",
        404
      );
    }
    assertProjectWritable(project.status);
    const membership = await client.projectMember.findFirst({
      where: { projectId: project.id, userId: input.actorId, leftAt: null },
      select: { id: true }
    });
    if (!membership) {
      throw new KnowledgeReuseServiceError(
        "KNOWLEDGE_REUSE_TARGET_MEMBERSHIP_REQUIRED",
        "更正人必须是目标项目的有效成员。",
        403
      );
    }
    const reuseRecordId = text(input.reuseRecordId, "reuseRecordId", 191);
    const reuse = await client.knowledgeReuseRecord.findUnique({
      where: { id_targetProjectId: { id: reuseRecordId, targetProjectId: project.id } }
    });
    if (!reuse) {
      throw new KnowledgeReuseServiceError(
        "KNOWLEDGE_REUSE_NOT_FOUND",
        "知识复用记录不存在。",
        404
      );
    }
    if (reuse.version !== input.expectedReuseVersion) {
      throw new KnowledgeReuseServiceError(
        "KNOWLEDGE_REUSE_VERSION_CONFLICT",
        "知识复用记录已发生变化。",
        409
      );
    }
    const correction = await client.knowledgeReuseCorrection.create({
      data: {
        targetProjectId: project.id,
        reuseRecordId: reuse.id,
        correctionType: input.correctionType,
        reason: text(input.reason, "reason", 4096),
        correctionText: text(input.correctionText, "correctionText", 4096),
        createdById: input.actorId
      }
    });
    const audit = await writeAudit(client, {
      action: AUDIT_ACTIONS.KNOWLEDGE_REUSE_CORRECTED,
      objectType: AUDIT_OBJECT_TYPES.KNOWLEDGE_REUSE_RECORD,
      objectId: reuse.id,
      context: auditContext({
        actorId: input.actorId,
        projectId: project.id,
        auditContext: input.auditContext
      }),
      after: {
        value: {
          reuseRecordId: reuse.id,
          targetProjectId: project.id,
          knowledgeEntryId: reuse.knowledgeEntryId,
          knowledgeVersionId: reuse.knowledgeVersionId,
          correctionId: correction.id,
          correctionType: input.correctionType,
          reason: input.reason
        },
        allowedFields: KNOWLEDGE_REUSE_AUDIT_FIELDS
      }
    });
    const outbox = await appendOutboxEvent(client, {
      eventType: "knowledge.reuse.corrected",
      aggregateType: AUDIT_OBJECT_TYPES.KNOWLEDGE_REUSE_RECORD,
      aggregateId: reuse.id,
      idempotencyKey: input.idempotencyKey,
      payload: {
        reuseRecordId: reuse.id,
        correctionId: correction.id,
        targetProjectId: project.id,
        correctionType: input.correctionType,
        auditId: audit.id
      }
    });
    return { ...correction, reuseRecordId: reuse.id, auditId: audit.id, outboxEventId: outbox.id };
  });
}
