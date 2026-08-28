import {
  AcceptanceBatchStatus,
  AcceptanceDecision,
  AcceptanceScopeType,
  AcceptanceType,
  Prisma
} from "@prisma/client";

import { db, inTransaction } from "@/lib/db";
import type { AuditContext } from "@/modules/audit/contracts/audit";
import {
  ACCEPTANCE_AUDIT_FIELDS,
  AUDIT_ACTIONS,
  AUDIT_OBJECT_TYPES
} from "@/modules/audit/domain/vocabulary";
import { writeAudit } from "@/modules/audit/infrastructure/write-audit";
import { appendOutboxEvent } from "@/modules/governance/infrastructure/outbox";
import {
  assertProjectWritable,
  ProjectWritePolicyError
} from "@/modules/projects/domain/project-write-policy";

import {
  ACCEPTANCE_BATCH_STATUSES,
  ACCEPTANCE_DECISIONS,
  ACCEPTANCE_SCOPE_TYPES,
  ACCEPTANCE_TYPES,
  AcceptancePolicyError,
  assertBatchCanTransition,
  assertBatchMutable,
  assertFailureIssueLinksPresent,
  assertMeasuredUnitMatchesFrozenDefinition,
  assertRequiredEvidencePresent,
  assertRetestBatchCompatible,
  assertScopeBelongsToProject,
  calculateAcceptanceSummary,
  calculateAcceptanceTemplateChecksum,
  normalizeAcceptanceEvidenceFileIds,
  validateMeasuredValue,
  validateTemplateSnapshot,
  type AcceptanceSummary,
  type AcceptanceTemplateSnapshot
} from "../domain/acceptance-policy";

export class AcceptanceServiceError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 422
  ) {
    super(message);
    this.name = "AcceptanceServiceError";
  }
}

type AuditInput = {
  actorId: string;
  auditContext: AuditContext;
  projectId: string;
  reason?: string;
};

function text(value: unknown, field: string, maximum = 191): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > maximum) {
    throw new AcceptanceServiceError(
      "ACCEPTANCE_INVALID_INPUT",
      `${field} 必须是 1 到 ${maximum} 个字符。`
    );
  }
  return value.trim();
}

function version(value: unknown, allowZero = false): number {
  if (!Number.isSafeInteger(value) || (value as number) < (allowZero ? 0 : 1)) {
    throw new AcceptanceServiceError(
      "ACCEPTANCE_INVALID_VERSION",
      "version 不是有效的乐观锁版本。",
      422
    );
  }
  return value as number;
}

function acceptanceType(value: unknown): AcceptanceType {
  if (!ACCEPTANCE_TYPES.includes(value as AcceptanceType)) {
    throw new AcceptanceServiceError(
      "ACCEPTANCE_TYPE_INVALID",
      "acceptanceType 必须为 FAT 或 SAT。",
      422
    );
  }
  return value as AcceptanceType;
}

function scopeType(value: unknown): AcceptanceScopeType {
  if (!ACCEPTANCE_SCOPE_TYPES.includes(value as AcceptanceScopeType)) {
    throw new AcceptanceServiceError(
      "ACCEPTANCE_SCOPE_TYPE_INVALID",
      "scopeType 必须为 PROJECT、DELIVERY_UNIT 或 MACHINE。",
      422
    );
  }
  return value as AcceptanceScopeType;
}

function batchStatus(value: unknown): AcceptanceBatchStatus {
  if (!ACCEPTANCE_BATCH_STATUSES.includes(value as AcceptanceBatchStatus)) {
    throw new AcceptanceServiceError("ACCEPTANCE_BATCH_STATUS_INVALID", "验收批次状态无效。", 422);
  }
  return value as AcceptanceBatchStatus;
}

function decision(value: unknown): AcceptanceDecision {
  if (!ACCEPTANCE_DECISIONS.includes(value as AcceptanceDecision)) {
    throw new AcceptanceServiceError(
      "ACCEPTANCE_DECISION_INVALID",
      "判定必须为 PASS、FAIL 或 NA。",
      422
    );
  }
  return value as AcceptanceDecision;
}

function policyError(error: unknown): never {
  if (error instanceof AcceptancePolicyError) {
    throw new AcceptanceServiceError(error.code, error.message, error.status);
  }
  throw error;
}

function auditContext(input: AuditInput) {
  return {
    ...input.auditContext,
    actorId: input.actorId,
    projectId: input.projectId,
    reason: input.reason ?? input.auditContext.reason ?? null
  };
}

async function databaseNow(client: Prisma.TransactionClient): Promise<Date> {
  const [clock] = await client.$queryRaw<Array<{ now: Date }>>`SELECT CURRENT_TIMESTAMP AS "now"`;
  if (!clock) throw new Error("无法读取数据库时间。");
  return clock.now;
}

function templateAuditValue(
  template: {
    id: string;
    code: string;
    name: string;
    acceptanceType: AcceptanceType;
    version: number;
  },
  versionId: string,
  projectId: string | null
) {
  return {
    projectId,
    templateId: template.id,
    templateVersionId: versionId,
    templateCode: template.code,
    templateVersion: template.version,
    acceptanceType: template.acceptanceType
  };
}

function batchAuditValue(batch: {
  id: string;
  projectId: string;
  acceptanceType: AcceptanceType;
  scopeType: AcceptanceScopeType;
  scopeId: string;
  status: AcceptanceBatchStatus;
  version: number;
}) {
  return {
    projectId: batch.projectId,
    batchId: batch.id,
    acceptanceType: batch.acceptanceType,
    scopeType: batch.scopeType,
    scopeId: batch.scopeId,
    status: batch.status,
    version: batch.version
  };
}

export async function createAcceptanceTemplateVersion(
  input: {
    projectId?: string | null;
    template: AcceptanceTemplateSnapshot & { code: string; name: string; acceptanceType: unknown };
    actorId: string;
    auditContext: AuditContext;
  },
  transaction?: Prisma.TransactionClient
) {
  const code = text(input.template.code, "template.code", 64).toUpperCase();
  const name = text(input.template.name, "template.name", 512);
  const type = acceptanceType(input.template.acceptanceType);
  const snapshot = (() => {
    try {
      return validateTemplateSnapshot(input.template);
    } catch (error) {
      return policyError(error);
    }
  })();
  const checksum = calculateAcceptanceTemplateChecksum({
    acceptanceType: type,
    items: snapshot.items
  });

  return inTransaction(transaction, async (client) => {
    let existing = await client.acceptanceTemplate.findUnique({ where: { code } });
    if (existing) {
      await client.$queryRaw`SELECT "id" FROM "acceptance_templates" WHERE "id" = ${existing.id} FOR UPDATE`;
      existing = await client.acceptanceTemplate.findUniqueOrThrow({ where: { id: existing.id } });
    }
    if (existing && existing.acceptanceType !== type) {
      throw new AcceptanceServiceError(
        "ACCEPTANCE_TEMPLATE_TYPE_CONFLICT",
        "验收模板类型不能改变。",
        409
      );
    }
    const template =
      existing ??
      (await client.acceptanceTemplate.create({
        data: { code, name, acceptanceType: type, createdById: input.actorId }
      }));
    const nextVersion = template.currentVersion + 1;
    const updated = await client.acceptanceTemplate.updateMany({
      where: { id: template.id, version: template.version },
      data: { name, currentVersion: nextVersion, version: { increment: 1 } }
    });
    if (updated.count !== 1) {
      throw new AcceptanceServiceError(
        "ACCEPTANCE_TEMPLATE_VERSION_CONFLICT",
        "模板已发生变化，请刷新后重试。",
        409
      );
    }
    const templateVersion = await client.acceptanceTemplateVersion.create({
      data: {
        templateId: template.id,
        version: nextVersion,
        acceptanceType: type,
        snapshotChecksum: checksum,
        createdById: input.actorId,
        items: { create: snapshot.items.map((item) => ({ ...item })) }
      },
      include: { items: { orderBy: { position: "asc" } } }
    });
    const currentTemplate = await client.acceptanceTemplate.findUniqueOrThrow({
      where: { id: template.id }
    });
    const value = templateAuditValue(
      {
        ...currentTemplate,
        acceptanceType: currentTemplate.acceptanceType as AcceptanceType,
        version: templateVersion.version
      },
      templateVersion.id,
      null
    );
    const audit = await writeAudit(client, {
      action: AUDIT_ACTIONS.ACCEPTANCE_TEMPLATE_PUBLISHED,
      objectType: AUDIT_OBJECT_TYPES.ACCEPTANCE_TEMPLATE_VERSION,
      objectId: templateVersion.id,
      context: {
        ...input.auditContext,
        actorId: input.actorId,
        projectId: null,
        reason: "发布验收模板版本"
      },
      after: { value, allowedFields: ACCEPTANCE_AUDIT_FIELDS }
    });
    const event = await appendOutboxEvent(client, {
      eventType: "acceptance.template-version.published",
      aggregateType: "ACCEPTANCE_TEMPLATE_VERSION",
      aggregateId: templateVersion.id,
      idempotencyKey: `${template.id}:v${templateVersion.version}`,
      payload: { ...value, auditId: audit.id },
      traceId: input.auditContext.traceId ?? undefined
    });
    return {
      templateVersion,
      resourceVersion: templateVersion.version,
      auditId: audit.id,
      outboxEventId: event.id
    };
  }).catch((error: unknown) => {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      throw new AcceptanceServiceError(
        "ACCEPTANCE_TEMPLATE_VERSION_CONFLICT",
        "模板版本已由并发发布占用，请刷新后重试。",
        409
      );
    }
    throw error;
  });
}

export async function listAcceptanceTemplateVersions(input: {
  projectId: string;
  acceptanceType?: unknown;
  limit: number;
}) {
  const projectId = text(input.projectId, "projectId");
  const type =
    input.acceptanceType === undefined ? undefined : acceptanceType(input.acceptanceType);
  const rows = await db.acceptanceTemplateVersion.findMany({
    where: type ? { acceptanceType: type } : undefined,
    include: { template: true, items: { orderBy: { position: "asc" } } },
    orderBy: [{ publishedAt: "desc" }, { id: "desc" }],
    take: Math.min(Math.max(input.limit, 1), 100)
  });
  return { projectId, templates: rows };
}

async function loadBatchForWrite(
  client: Prisma.TransactionClient,
  projectId: string,
  batchId: string
) {
  const project = await client.project.findUnique({
    where: { id: projectId },
    select: { status: true }
  });
  if (!project) throw new AcceptanceServiceError("PROJECT_NOT_FOUND", "项目不存在。", 404);
  try {
    assertProjectWritable(project.status);
  } catch (error) {
    if (error instanceof ProjectWritePolicyError) {
      throw new AcceptanceServiceError(error.code, error.message, error.status);
    }
    throw error;
  }
  await client.$queryRaw`SELECT "id" FROM "acceptance_batches" WHERE "id" = ${batchId} AND "project_id" = ${projectId} FOR UPDATE`;
  const batch = await client.acceptanceBatch.findUnique({
    where: { id_projectId: { id: batchId, projectId } }
  });
  if (!batch)
    throw new AcceptanceServiceError("ACCEPTANCE_BATCH_NOT_FOUND", "验收批次不存在。", 404);
  return batch;
}

async function assertScope(
  client: Prisma.TransactionClient,
  projectId: string,
  type: AcceptanceScopeType,
  scopeId: string
) {
  const scope =
    type === "PROJECT"
      ? await client.project
          .findUnique({ where: { id: scopeId }, select: { id: true } })
          .then((row) => (row ? { id: row.id, projectId: row.id } : null))
      : await client.deliveryUnit.findFirst({
          where: { id: scopeId, projectId, ...(type === "MACHINE" ? { unitType: "MACHINE" } : {}) },
          select: { id: true, projectId: true }
        });
  try {
    assertScopeBelongsToProject({ projectId, scopeType: type, scopeId, scope });
  } catch (error) {
    return policyError(error);
  }
}

export async function createAcceptanceBatch(
  input: {
    projectId: string;
    acceptanceType: unknown;
    scopeType: unknown;
    scopeId: string;
    templateVersionId: string;
    retestOfBatchId?: string | null;
    version: unknown;
    actorId: string;
    auditContext: AuditContext;
  },
  transaction?: Prisma.TransactionClient
) {
  const projectId = text(input.projectId, "projectId");
  const type = acceptanceType(input.acceptanceType);
  const typeOfScope = scopeType(input.scopeType);
  const scopeId = text(input.scopeId, "scopeId");
  const templateVersionId = text(input.templateVersionId, "templateVersionId");
  if (version(input.version, true) !== 0) {
    throw new AcceptanceServiceError(
      "ACCEPTANCE_INVALID_VERSION",
      "创建验收批次的 version 必须为 0。",
      409
    );
  }
  return inTransaction(transaction, async (client) => {
    const project = await client.project.findUnique({
      where: { id: projectId },
      select: { id: true, status: true }
    });
    if (!project) throw new AcceptanceServiceError("PROJECT_NOT_FOUND", "项目不存在。", 404);
    try {
      assertProjectWritable(project.status);
    } catch (error) {
      if (error instanceof ProjectWritePolicyError) {
        throw new AcceptanceServiceError(error.code, error.message, error.status);
      }
      throw error;
    }
    const template = await client.acceptanceTemplateVersion.findUnique({
      where: { id: templateVersionId }
    });
    if (!template)
      throw new AcceptanceServiceError(
        "ACCEPTANCE_TEMPLATE_VERSION_NOT_FOUND",
        "验收模板版本不存在。",
        404
      );
    if (template.acceptanceType !== type) {
      throw new AcceptanceServiceError(
        "ACCEPTANCE_TEMPLATE_TYPE_MISMATCH",
        "批次类型必须与模板版本一致。",
        422
      );
    }
    await assertScope(client, projectId, typeOfScope, scopeId);
    if (input.retestOfBatchId) {
      const original = await client.acceptanceBatch.findUnique({
        where: { id_projectId: { id: text(input.retestOfBatchId, "retestOfBatchId"), projectId } },
        select: {
          projectId: true,
          acceptanceType: true,
          scopeType: true,
          scopeId: true,
          status: true
        }
      });
      try {
        assertRetestBatchCompatible({
          projectId,
          acceptanceType: type,
          scopeType: typeOfScope,
          scopeId,
          original
        });
      } catch (error) {
        return policyError(error);
      }
    }
    const batch = await client.acceptanceBatch.create({
      data: {
        projectId,
        acceptanceType: type,
        scopeType: typeOfScope,
        scopeId,
        templateVersionId,
        retestOfBatchId: input.retestOfBatchId ?? null,
        createdById: input.actorId
      }
    });
    const value = batchAuditValue(batch);
    const audit = await writeAudit(client, {
      action: AUDIT_ACTIONS.ACCEPTANCE_BATCH_CREATED,
      objectType: AUDIT_OBJECT_TYPES.ACCEPTANCE_BATCH,
      objectId: batch.id,
      context: auditContext({ ...input, projectId }),
      after: { value, allowedFields: ACCEPTANCE_AUDIT_FIELDS }
    });
    const event = await appendOutboxEvent(client, {
      eventType: "acceptance.batch.created",
      aggregateType: "ACCEPTANCE_BATCH",
      aggregateId: batch.id,
      idempotencyKey: `${batch.id}:created`,
      payload: { ...value, auditId: audit.id },
      traceId: input.auditContext.traceId ?? undefined
    });
    return { batch, resourceVersion: batch.version, auditId: audit.id, outboxEventId: event.id };
  });
}

async function transitionBatch(
  input: {
    projectId: string;
    batchId: string;
    version: unknown;
    to: AcceptanceBatchStatus;
    actorId: string;
    auditContext: AuditContext;
  },
  transaction?: Prisma.TransactionClient
) {
  const projectId = text(input.projectId, "projectId");
  const batchId = text(input.batchId, "batchId");
  const expected = version(input.version);
  return inTransaction(transaction, async (client) => {
    const batch = await loadBatchForWrite(client, projectId, batchId);
    if (batch.version !== expected)
      throw new AcceptanceServiceError(
        "ACCEPTANCE_VERSION_CONFLICT",
        "验收批次已发生变化，请刷新后重试。",
        409
      );
    try {
      assertBatchCanTransition(batch.status, input.to);
    } catch (error) {
      return policyError(error);
    }
    if (input.to === "LOCKED") {
      const details = await client.acceptanceBatch.findUnique({
        where: { id_projectId: { id: batch.id, projectId } },
        include: {
          templateVersion: { include: { items: true } },
          results: {
            include: {
              revisions: { include: { evidence: true }, orderBy: { revisionNo: "desc" }, take: 1 }
            }
          }
        }
      });
      if (!details)
        throw new AcceptanceServiceError("ACCEPTANCE_BATCH_NOT_FOUND", "验收批次不存在。", 404);
      const summary = summaryForBatch(details as BatchWithDetails);
      if (summary.unexecutedRequiredCount > 0) {
        throw new AcceptanceServiceError(
          "ACCEPTANCE_BATCH_INCOMPLETE",
          "必测项仍有未录入结果，验收批次不能锁定。",
          409
        );
      }
      try {
        assertRequiredEvidencePresent(
          details.templateVersion.items.map((item) => {
            const latest = details.results.find((result) => result.itemId === item.id)
              ?.revisions[0];
            return {
              evidenceRequired: item.evidenceRequired,
              decision: latest?.decision ?? null,
              evidenceCount: latest?.evidence.length ?? 0
            };
          })
        );
      } catch (error) {
        return policyError(error);
      }
      const latestRevisionIds = details.results
        .map((result) => result.revisions[0]?.id)
        .filter((id): id is string => Boolean(id));
      const linkedFailures =
        latestRevisionIds.length === 0
          ? []
          : await client.issueRelation.findMany({
              where: {
                projectId,
                relationType: "TEST_RESULT",
                status: "ACTIVE",
                targetId: { in: latestRevisionIds }
              },
              select: { targetId: true }
            });
      const linkedFailureIds = new Set(linkedFailures.map((relation) => relation.targetId));
      try {
        assertFailureIssueLinksPresent(
          details.results.map((result) => ({
            decision: result.revisions[0]?.decision ?? null,
            hasActiveIssueRelation: result.revisions[0]
              ? linkedFailureIds.has(result.revisions[0].id)
              : false
          }))
        );
      } catch (error) {
        return policyError(error);
      }
    }
    const now = await databaseNow(client);
    const updateData =
      input.to === "IN_PROGRESS"
        ? {
            status: "IN_PROGRESS" as const,
            startedById: input.actorId,
            startedAt: now,
            version: { increment: 1 }
          }
        : {
            status: "LOCKED" as const,
            lockedById: input.actorId,
            lockedAt: now,
            version: { increment: 1 }
          };
    const updated = await client.acceptanceBatch.update({
      where: { id_projectId: { id: batch.id, projectId } },
      data: updateData
    });
    const value = batchAuditValue(updated);
    const action =
      input.to === "LOCKED"
        ? AUDIT_ACTIONS.ACCEPTANCE_BATCH_LOCKED
        : AUDIT_ACTIONS.ACCEPTANCE_BATCH_STARTED;
    const audit = await writeAudit(client, {
      action,
      objectType: AUDIT_OBJECT_TYPES.ACCEPTANCE_BATCH,
      objectId: updated.id,
      context: auditContext({ ...input, projectId }),
      after: { value, allowedFields: ACCEPTANCE_AUDIT_FIELDS }
    });
    const event = await appendOutboxEvent(client, {
      eventType: input.to === "LOCKED" ? "acceptance.batch.locked" : "acceptance.batch.started",
      aggregateType: "ACCEPTANCE_BATCH",
      aggregateId: updated.id,
      idempotencyKey: `${updated.id}:v${updated.version}`,
      payload: { ...value, auditId: audit.id },
      traceId: input.auditContext.traceId ?? undefined
    });
    return {
      batch: updated,
      resourceVersion: updated.version,
      auditId: audit.id,
      outboxEventId: event.id
    };
  });
}

export function startAcceptanceBatch(
  input: Omit<Parameters<typeof transitionBatch>[0], "to">,
  transaction?: Prisma.TransactionClient
) {
  return transitionBatch({ ...input, to: "IN_PROGRESS" }, transaction);
}

export async function lockAcceptanceBatch(
  input: Omit<Parameters<typeof transitionBatch>[0], "to">,
  transaction?: Prisma.TransactionClient
) {
  const result = await transitionBatch({ ...input, to: "LOCKED" }, transaction);
  return result;
}

export async function recordAcceptanceResultRevision(
  input: {
    projectId: string;
    batchId: string;
    itemId: string;
    version: unknown;
    decision: unknown;
    measuredValue?: unknown;
    measuredUnit?: unknown;
    note?: unknown;
    correctionReason?: unknown;
    evidenceFileIds?: unknown;
    actorId: string;
    auditContext: AuditContext;
  },
  transaction?: Prisma.TransactionClient
) {
  const projectId = text(input.projectId, "projectId");
  const batchId = text(input.batchId, "batchId");
  const itemId = text(input.itemId, "itemId");
  const expected = version(input.version);
  const resultDecision = decision(input.decision);
  const measuredValue = validateMeasuredValue(input.measuredValue);
  const suppliedMeasuredUnit =
    input.measuredUnit == null ? null : text(input.measuredUnit, "measuredUnit", 64);
  const note = input.note == null ? null : text(input.note, "note", 4096);
  const correctionReason =
    input.correctionReason == null ? null : text(input.correctionReason, "correctionReason", 2048);
  const evidenceFileIds = normalizeAcceptanceEvidenceFileIds(input.evidenceFileIds ?? []);
  return inTransaction(transaction, async (client) => {
    const batch = await loadBatchForWrite(client, projectId, batchId);
    if (batch.version !== expected)
      throw new AcceptanceServiceError(
        "ACCEPTANCE_VERSION_CONFLICT",
        "验收批次已发生变化，请刷新后重试。",
        409
      );
    try {
      assertBatchMutable(batch.status);
    } catch (error) {
      return policyError(error);
    }
    const template = await client.acceptanceTemplateVersion.findUnique({
      where: { id: batch.templateVersionId },
      include: { items: true }
    });
    const item = template?.items.find((candidate) => candidate.id === itemId);
    if (!template || !item)
      throw new AcceptanceServiceError(
        "ACCEPTANCE_TEST_ITEM_NOT_FOUND",
        "测试项不属于当前验收模板。",
        404
      );
    try {
      assertMeasuredUnitMatchesFrozenDefinition(item.unit, suppliedMeasuredUnit);
    } catch (error) {
      return policyError(error);
    }
    if (item.evidenceRequired && evidenceFileIds.length === 0)
      throw new AcceptanceServiceError(
        "ACCEPTANCE_EVIDENCE_REQUIRED",
        "该测试项必须引用已授权证据文件。",
        422
      );
    if (evidenceFileIds.length > 0) {
      const files = await client.fileObject.findMany({
        where: { id: { in: [...evidenceFileIds] }, projectId },
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
        throw new AcceptanceServiceError(
          "ACCEPTANCE_EVIDENCE_NOT_AVAILABLE",
          "证据文件不存在、未完成扫描或不可用。",
          422
        );
      }
    }
    const current = await client.acceptanceTestResult.findUnique({
      where: { batchId_itemId: { batchId, itemId } },
      include: { revisions: { orderBy: { revisionNo: "desc" }, take: 1 } }
    });
    const result =
      current ??
      (await client.acceptanceTestResult.create({ data: { projectId, batchId, itemId } }));
    const previous = current?.revisions[0] ?? null;
    if (previous && !correctionReason)
      throw new AcceptanceServiceError(
        "ACCEPTANCE_CORRECTION_REASON_REQUIRED",
        "修订已有结果必须填写修订原因。",
        422
      );
    const revision = await client.acceptanceTestResultRevision.create({
      data: {
        projectId,
        resultId: result.id,
        revisionNo: (previous?.revisionNo ?? 0) + 1,
        supersedesRevisionId: previous?.id ?? null,
        decision: resultDecision,
        measuredValue,
        measuredUnit: item.unit,
        note,
        correctionReason,
        createdById: input.actorId
      }
    });
    if (evidenceFileIds.length > 0) {
      await client.acceptanceTestResultRevisionEvidence.createMany({
        data: evidenceFileIds.map((fileObjectId) => ({
          projectId,
          revisionId: revision.id,
          fileObjectId,
          createdById: input.actorId
        }))
      });
    }
    const updatedBatch = await client.acceptanceBatch.update({
      where: { id_projectId: { id: batch.id, projectId } },
      data: { version: { increment: 1 } }
    });
    const value = {
      projectId,
      batchId,
      itemId,
      resultId: result.id,
      resultRevisionId: revision.id,
      revisionNo: revision.revisionNo,
      supersedesRevisionId: revision.supersedesRevisionId,
      decision: revision.decision,
      measuredValue: revision.measuredValue,
      measuredUnit: revision.measuredUnit,
      evidenceFileIds,
      version: updatedBatch.version
    };
    const audit = await writeAudit(client, {
      action: previous
        ? AUDIT_ACTIONS.ACCEPTANCE_RESULT_CORRECTED
        : AUDIT_ACTIONS.ACCEPTANCE_RESULT_RECORDED,
      objectType: AUDIT_OBJECT_TYPES.ACCEPTANCE_TEST_RESULT_REVISION,
      objectId: revision.id,
      context: auditContext({ ...input, projectId, reason: correctionReason ?? undefined }),
      after: { value, allowedFields: ACCEPTANCE_AUDIT_FIELDS }
    });
    if (evidenceFileIds.length > 0) {
      await writeAudit(client, {
        action: AUDIT_ACTIONS.ACCEPTANCE_EVIDENCE_REFERENCED,
        objectType: AUDIT_OBJECT_TYPES.ACCEPTANCE_TEST_RESULT_REVISION,
        objectId: revision.id,
        context: auditContext({ ...input, projectId }),
        metadata: { value: { ...value, evidenceFileIds }, allowedFields: ACCEPTANCE_AUDIT_FIELDS }
      });
    }
    const event = await appendOutboxEvent(client, {
      eventType: previous ? "acceptance.result.corrected" : "acceptance.result.recorded",
      aggregateType: "ACCEPTANCE_TEST_RESULT",
      aggregateId: result.id,
      idempotencyKey: `${result.id}:r${revision.revisionNo}`,
      payload: { ...value, auditId: audit.id },
      traceId: input.auditContext.traceId ?? undefined
    });
    return {
      result,
      revision,
      batch: updatedBatch,
      resourceVersion: updatedBatch.version,
      auditId: audit.id,
      outboxEventId: event.id
    };
  });
}

type BatchWithDetails = Prisma.AcceptanceBatchGetPayload<{
  include: {
    templateVersion: { include: { items: true } };
    results: { include: { revisions: { orderBy: { revisionNo: "desc" }; take: 1 } } };
  };
}>;

function summaryForBatch(batch: BatchWithDetails): AcceptanceSummary {
  const current = new Map(
    batch.results.map((result) => [result.itemId, result.revisions[0]?.decision ?? null])
  );
  return calculateAcceptanceSummary(
    batch.templateVersion.items.map((item) => ({
      required: item.required,
      decision: current.get(item.id) as "PASS" | "FAIL" | "NA" | null
    }))
  );
}

export async function getAcceptanceBatch(
  projectId: string,
  batchId: string,
  allowedActions: readonly string[] = []
) {
  const batch = await db.acceptanceBatch.findUnique({
    where: {
      id_projectId: { id: text(batchId, "batchId"), projectId: text(projectId, "projectId") }
    },
    include: {
      templateVersion: { include: { items: { orderBy: { position: "asc" } } } },
      results: {
        include: { revisions: { include: { evidence: true }, orderBy: { revisionNo: "desc" } } }
      }
    }
  });
  if (!batch)
    throw new AcceptanceServiceError("ACCEPTANCE_BATCH_NOT_FOUND", "验收批次不存在。", 404);
  const revisionIds = batch.results.flatMap((result) =>
    result.revisions.map((revision) => revision.id)
  );
  const issueRelations = revisionIds.length
    ? await db.issueRelation.findMany({
        where: {
          projectId,
          relationType: "TEST_RESULT",
          status: "ACTIVE",
          targetId: { in: revisionIds }
        },
        include: {
          issue: {
            select: {
              id: true,
              projectId: true,
              title: true,
              category: true,
              severity: true,
              status: true,
              ownerMembershipId: true,
              verifierMembershipId: true,
              dueDate: true,
              version: true
            }
          }
        },
        orderBy: { createdAt: "asc" }
      })
    : [];
  const issueLinksByRevision = new Map<string, typeof issueRelations>();
  for (const relation of issueRelations) {
    const current = issueLinksByRevision.get(relation.targetId) ?? [];
    current.push(relation);
    issueLinksByRevision.set(relation.targetId, current);
  }
  const enrichedBatch = {
    ...batch,
    results: batch.results.map((result) => ({
      ...result,
      revisions: result.revisions.map((revision) => ({
        ...revision,
        issueLinks: (issueLinksByRevision.get(revision.id) ?? []).map((relation) => ({
          relationId: relation.id,
          issue: {
            ...relation.issue,
            dueDate: relation.issue.dueDate?.toISOString().slice(0, 10) ?? null
          }
        }))
      }))
    }))
  };
  const latestFailures = batch.results
    .map((result) => result.revisions[0])
    .filter((revision) => revision?.decision === "FAIL");
  const unlinkedFailureCount = latestFailures.filter(
    (revision) => !revision || (issueLinksByRevision.get(revision.id) ?? []).length === 0
  ).length;
  return {
    projectId: text(projectId, "projectId"),
    batch: enrichedBatch,
    summary: { ...summaryForBatch(batch as BatchWithDetails), unlinkedFailureCount },
    allowedActions
  };
}

export async function listAcceptanceBatches(input: {
  projectId: string;
  acceptanceType?: unknown;
  limit: number;
  cursor?: string;
  allowedActions?: readonly string[];
}) {
  const projectId = text(input.projectId, "projectId");
  const type =
    input.acceptanceType === undefined ? undefined : acceptanceType(input.acceptanceType);
  const rows = await db.acceptanceBatch.findMany({
    where: { projectId, ...(type ? { acceptanceType: type } : {}) },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    ...(input.cursor ? { cursor: { id: text(input.cursor, "cursor") }, skip: 1 } : {}),
    take: Math.min(Math.max(input.limit, 1), 100) + 1
  });
  const batches = rows.slice(0, input.limit).map((batch) => ({
    ...batch,
    allowedActions: input.allowedActions ?? []
  }));
  return {
    projectId,
    batches,
    nextCursor: rows.length > input.limit ? (batches.at(-1)?.id ?? null) : null
  };
}

export async function getAcceptanceSummary(projectId: string, batchId: string) {
  const result = await getAcceptanceBatch(projectId, batchId);
  return { projectId, batchId, ...result.summary };
}
