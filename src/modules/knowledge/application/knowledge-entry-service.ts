import { Prisma, type ArchiveSourceFormulaVersion } from "@prisma/client";

import { db, inTransaction } from "@/lib/db";
import type { AuditContext } from "@/modules/audit/contracts/audit";
import {
  AUDIT_ACTIONS,
  AUDIT_OBJECT_TYPES,
  KNOWLEDGE_ENTRY_AUDIT_FIELDS
} from "@/modules/audit/domain/vocabulary";
import { writeAudit } from "@/modules/audit/infrastructure/write-audit";
import { payloadHash, type JsonValue } from "@/modules/governance/domain/idempotency";
import { appendOutboxEvent } from "@/modules/governance/infrastructure/outbox";

import {
  assertKnowledgeSourceRead,
  assertKnowledgeVersionTransition,
  buildKnowledgeContent,
  KNOWLEDGE_VERSION_STATUS,
  type KnowledgeDraft
} from "../domain/knowledge-policy";

export class KnowledgeEntryServiceError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 422
  ) {
    super(message);
    this.name = "KnowledgeEntryServiceError";
  }
}

type Client = Prisma.TransactionClient | typeof db;

const ISSUE_CATEGORIES = new Set([
  "SAFETY",
  "FUNCTION",
  "PERFORMANCE",
  "APPEARANCE",
  "DELIVERY_COMPLETENESS"
]);
const ISSUE_SEVERITIES = new Set(["LOW", "MEDIUM", "HIGH", "CRITICAL"]);
const ISSUE_STATUSES = new Set([
  "PENDING_ACCEPTANCE",
  "ANALYZING",
  "PROCESSING",
  "PENDING_VERIFICATION",
  "CLOSED"
]);
const ISSUE_HISTORY_EVENT_TYPES = new Set([
  "CREATED",
  "DETAILS_UPDATED",
  "STARTED_ANALYSIS",
  "STARTED_PROCESSING",
  "VERIFICATION_SUBMITTED",
  "CLOSED",
  "REOPENED",
  "RESPONSIBILITY_ASSIGNED",
  "RELATION_ADDED",
  "RELATION_CLOSED"
]);

function auditContext(input: { actorId: string; projectId: string; auditContext?: AuditContext }) {
  return {
    ...(input.auditContext ?? {}),
    actorId: input.actorId,
    projectId: input.projectId
  } as AuditContext;
}

export type CreateKnowledgeEntryVersionInput = {
  code: string;
  sourceProjectId: string;
  finalArchiveVersionId: string;
  retrospectiveInputArchiveVersionId: string;
  retrospectiveVersionId: string;
  issueHistoryIds: string[];
  draft: KnowledgeDraft;
  actorId: string;
  idempotencyKey: string;
  auditContext?: AuditContext;
  entryId?: string;
  expectedEntryVersion: number | null;
  sourceRead: { knowledgePermissionAllowed: boolean; sourceProjectReadAllowed: boolean };
};

export type SubmitKnowledgeEntryVersionInput = {
  entryId: string;
  versionId: string;
  expectedEntryVersion: number;
  actorId: string;
  idempotencyKey: string;
  auditContext?: AuditContext;
  sourceRead: { knowledgePermissionAllowed: boolean; sourceProjectReadAllowed: boolean };
};

export type ReviewKnowledgeEntryVersionInput = {
  entryId: string;
  versionId: string;
  expectedEntryVersion: number;
  decision: "PUBLISH" | "REJECT";
  reason: string;
  ipConfirmed: boolean;
  sanitizationConfirmed: boolean;
  actorId: string;
  idempotencyKey: string;
  auditContext?: AuditContext;
  sourceRead: { knowledgePermissionAllowed: boolean; sourceProjectReadAllowed: boolean };
};

export type RevokeKnowledgeEntryVersionInput = {
  entryId: string;
  versionId: string;
  expectedEntryVersion: number;
  reason: string;
  actorId: string;
  idempotencyKey: string;
  auditContext?: AuditContext;
  sourceRead: { knowledgePermissionAllowed: boolean; sourceProjectReadAllowed: boolean };
};

function latestIntegrityPassed(archive: { integrityChecks?: Array<{ status: string }> }) {
  return archive.integrityChecks?.[0]?.status === "PASSED";
}

async function readSourceFacts(
  client: Client,
  input: CreateKnowledgeEntryVersionInput,
  project: { id: string; status: string; finalArchiveVersionId: string | null }
) {
  const [archiveA, archiveB, retrospective] = await Promise.all([
    client.projectArchiveVersion.findUnique({
      where: {
        id_projectId: { id: input.retrospectiveInputArchiveVersionId, projectId: project.id }
      },
      include: { integrityChecks: { orderBy: { sequence: "desc" }, take: 1 } }
    }),
    client.projectArchiveVersion.findUnique({
      where: { id_projectId: { id: input.finalArchiveVersionId, projectId: project.id } },
      include: { integrityChecks: { orderBy: { sequence: "desc" }, take: 1 } }
    }),
    client.projectRetrospectiveVersion.findUnique({
      where: {
        id_projectId: { id: input.retrospectiveVersionId, projectId: project.id }
      },
      include: { retrospective: true }
    })
  ]);
  if (
    !archiveA ||
    archiveA.projectId !== project.id ||
    archiveA.status !== "READY" ||
    archiveA.archiveSourceFormulaVersion !== "V2" ||
    archiveA.retrospectiveInputApplicability !== "APPLICABLE" ||
    archiveA.retrospectiveInputWatermarkVersion !== "RETROSPECTIVE.INPUT@1" ||
    !archiveA.retrospectiveInputSnapshotJson ||
    !archiveA.retrospectiveInputWatermark ||
    !latestIntegrityPassed(archiveA)
  ) {
    throw new KnowledgeEntryServiceError(
      "KNOWLEDGE_INPUT_ARCHIVE_NOT_READY",
      "知识来源必须引用已准备且完整性通过的 Archive A。",
      409
    );
  }
  const retrospectiveInputWatermark = archiveA.retrospectiveInputWatermark;
  if (
    !archiveB ||
    archiveB.projectId !== project.id ||
    archiveB.id !== project.finalArchiveVersionId ||
    archiveB.status !== "FINALIZED" ||
    archiveB.archiveSourceFormulaVersion !== "V2" ||
    !latestIntegrityPassed(archiveB)
  ) {
    throw new KnowledgeEntryServiceError(
      "KNOWLEDGE_FINAL_ARCHIVE_NOT_FINALIZED",
      "知识来源必须引用项目冻结且完整性通过的最终归档 B。",
      409
    );
  }
  if (
    !retrospective ||
    retrospective.projectId !== project.id ||
    retrospective.status !== "APPROVED" ||
    retrospective.retrospective?.currentVersionId !== retrospective.id ||
    retrospective.retrospective?.latestApprovedVersionId !== retrospective.id ||
    retrospective.retrospectiveInputArchiveVersionId !== archiveA.id ||
    retrospective.retrospectiveInputManifestChecksum !== archiveA.manifestChecksum ||
    retrospective.retrospectiveInputSourceWatermark !== archiveA.sourceWatermark ||
    retrospective.retrospectiveInputWatermark !== retrospectiveInputWatermark
  ) {
    throw new KnowledgeEntryServiceError(
      "KNOWLEDGE_APPROVED_RETROSPECTIVE_REQUIRED",
      "知识来源必须引用同项目当前且已批准的复盘版本。",
      409
    );
  }
  return {
    archiveA: { ...archiveA, retrospectiveInputWatermark },
    archiveB,
    retrospective
  };
}

function inputJson(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

function canonicalText(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 191) {
    throw new KnowledgeEntryServiceError("KNOWLEDGE_INPUT_INVALID", `${field} 无效。`);
  }
  return normalized;
}

async function databaseNow(client: Client): Promise<Date> {
  const [clock] = await client.$queryRaw<Array<{ now: unknown }>>`
    SELECT CURRENT_TIMESTAMP AS "now"
  `;
  if (!(clock?.now instanceof Date) || Number.isNaN(clock.now.getTime())) {
    throw new KnowledgeEntryServiceError(
      "KNOWLEDGE_DATABASE_CLOCK_UNAVAILABLE",
      "无法读取知识业务所需的数据库时间。",
      503
    );
  }
  return clock.now;
}

function sanitizedIssueHistoryFacts(input: {
  id: string;
  issueId: string;
  sequence: number;
  eventType: string;
  snapshotJson: unknown;
}) {
  const snapshot = input.snapshotJson;
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) {
    throw new KnowledgeEntryServiceError(
      "KNOWLEDGE_ISSUE_HISTORY_SNAPSHOT_INVALID",
      "知识来源问题历史缺少可脱敏的冻结快照。",
      409
    );
  }
  const record = snapshot as Record<string, unknown>;
  const category = record.category;
  const severity = record.severity;
  const status = record.status;
  if (
    typeof category !== "string" ||
    !ISSUE_CATEGORIES.has(category) ||
    typeof severity !== "string" ||
    !ISSUE_SEVERITIES.has(severity) ||
    typeof status !== "string" ||
    !ISSUE_STATUSES.has(status) ||
    !ISSUE_HISTORY_EVENT_TYPES.has(input.eventType) ||
    !Number.isSafeInteger(input.sequence) ||
    input.sequence < 1
  ) {
    throw new KnowledgeEntryServiceError(
      "KNOWLEDGE_ISSUE_HISTORY_SNAPSHOT_INVALID",
      "知识来源问题历史的受控字段无效。",
      409
    );
  }
  return {
    issueId: input.issueId,
    issueHistoryId: input.id,
    sequence: input.sequence,
    eventType: input.eventType,
    category,
    severity,
    status
  };
}

function assertActiveKnowledgeEntry(entry: { status: string }) {
  if (entry.status !== "ACTIVE") {
    throw new KnowledgeEntryServiceError(
      "KNOWLEDGE_ENTRY_REVOKED",
      "已撤销的知识条目不得提交或审核版本。",
      409
    );
  }
}

async function readIssueHistories(
  client: Client,
  projectId: string,
  issueHistoryIds: readonly string[]
) {
  const ids = [...new Set(issueHistoryIds.map((id) => canonicalText(id, "issueHistoryId")))];
  if (!ids.length) return [];
  const histories = await client.issueHistory.findMany({
    where: { projectId, id: { in: ids } },
    select: {
      id: true,
      projectId: true,
      issueId: true,
      sequence: true,
      eventType: true,
      snapshotJson: true
    }
  });
  if (histories.length !== ids.length) {
    throw new KnowledgeEntryServiceError(
      "KNOWLEDGE_ISSUE_HISTORY_NOT_IN_SOURCE_PROJECT",
      "知识来源问题历史必须同属源项目。",
      409
    );
  }
  return histories.map(sanitizedIssueHistoryFacts);
}

async function assertArchiveBContainsRetrospective(
  client: Client,
  sourceProjectId: string,
  archiveBId: string,
  retrospective: {
    id: string;
    versionNo: number;
    contentChecksum: string;
    retrospectiveInputArchiveVersionId: string;
    retrospectiveInputWatermark: string;
  }
) {
  const item = await client.projectArchiveManifestItem.findFirst({
    where: {
      projectId: sourceProjectId,
      archiveVersionId: archiveBId,
      sourceType: "PROJECT_RETROSPECTIVE_VERSION",
      sourceId: retrospective.id,
      sourceVersion: String(retrospective.versionNo)
    },
    select: { sourceChecksum: true, snapshotJson: true }
  });
  if (!item) {
    throw new KnowledgeEntryServiceError(
      "KNOWLEDGE_FINAL_ARCHIVE_RETROSPECTIVE_MISSING",
      "最终归档 B 未冻结该已批准复盘版本。",
      409
    );
  }
  const snapshot = item.snapshotJson as Record<string, unknown> | null;
  if (
    !snapshot ||
    snapshot.contentChecksum !== retrospective.contentChecksum ||
    snapshot.retrospectiveInputArchiveVersionId !==
      retrospective.retrospectiveInputArchiveVersionId ||
    snapshot.retrospectiveInputWatermark !== retrospective.retrospectiveInputWatermark
  ) {
    throw new KnowledgeEntryServiceError(
      "KNOWLEDGE_FINAL_ARCHIVE_RETROSPECTIVE_MISMATCH",
      "最终归档 B 的复盘清单快照与已批准复盘不一致。",
      409
    );
  }
  return item;
}

function entrySourceData(input: {
  versionId: string;
  sourceProjectId: string;
  archiveA: {
    id: string;
    archiveSourceFormulaVersion: ArchiveSourceFormulaVersion;
    manifestChecksum: string;
    sourceWatermark: string;
    retrospectiveInputWatermark: string;
  };
  archiveB: {
    id: string;
    archiveSourceFormulaVersion: ArchiveSourceFormulaVersion;
    manifestChecksum: string;
    sourceWatermark: string;
  };
  retrospective: {
    id: string;
    versionNo: number;
    contentChecksum: string;
  };
  archiveManifestSourceChecksum: string;
  issue?: {
    issueId: string;
    issueHistoryId: string;
    sequence: number;
    eventType: string;
    category: string;
    severity: string;
    status: string;
  };
}) {
  const snapshot = {
    finalArchive: {
      id: input.archiveB.id,
      formula: input.archiveB.archiveSourceFormulaVersion,
      manifestChecksum: input.archiveB.manifestChecksum,
      sourceWatermark: input.archiveB.sourceWatermark,
      retrospectiveManifestSourceChecksum: input.archiveManifestSourceChecksum
    },
    retrospectiveInputArchive: {
      id: input.archiveA.id,
      formula: input.archiveA.archiveSourceFormulaVersion,
      manifestChecksum: input.archiveA.manifestChecksum,
      sourceWatermark: input.archiveA.sourceWatermark,
      retrospectiveInputWatermark: input.archiveA.retrospectiveInputWatermark
    },
    retrospective: {
      id: input.retrospective.id,
      versionNo: input.retrospective.versionNo,
      contentChecksum: input.retrospective.contentChecksum
    },
    issueHistory: input.issue
      ? {
          issueId: input.issue.issueId,
          issueHistoryId: input.issue.issueHistoryId,
          sequence: input.issue.sequence,
          eventType: input.issue.eventType,
          category: input.issue.category,
          severity: input.issue.severity,
          status: input.issue.status
        }
      : null
  };
  return {
    knowledgeVersionId: input.versionId,
    sourceProjectId: input.sourceProjectId,
    finalArchiveVersionId: input.archiveB.id,
    finalArchiveFormula: input.archiveB.archiveSourceFormulaVersion,
    finalArchiveManifestChecksum: input.archiveB.manifestChecksum,
    finalArchiveSourceWatermark: input.archiveB.sourceWatermark,
    retrospectiveInputArchiveVersionId: input.archiveA.id,
    retrospectiveInputFormula: input.archiveA.archiveSourceFormulaVersion,
    retrospectiveInputManifestChecksum: input.archiveA.manifestChecksum,
    retrospectiveInputSourceWatermark: input.archiveA.sourceWatermark,
    retrospectiveInputWatermark: input.archiveA.retrospectiveInputWatermark,
    retrospectiveVersionId: input.retrospective.id,
    retrospectiveVersionNo: input.retrospective.versionNo,
    retrospectiveContentChecksum: input.retrospective.contentChecksum,
    issueId: input.issue?.issueId ?? null,
    issueHistoryId: input.issue?.issueHistoryId ?? null,
    issueHistorySequence: input.issue?.sequence ?? null,
    sourceChecksum: payloadHash(snapshot).hash,
    sanitizedSnapshotJson: inputJson(snapshot)
  };
}

export async function createKnowledgeEntryVersion(
  input: CreateKnowledgeEntryVersionInput,
  transaction?: Prisma.TransactionClient
) {
  return inTransaction(transaction, async (client: Client) => {
    assertKnowledgeSourceRead(input.sourceRead);
    const project = await client.project.findUnique({
      where: { id: input.sourceProjectId },
      select: { id: true, status: true, finalArchiveVersionId: true }
    });
    if (!project || project.status !== "CLOSED") {
      throw new KnowledgeEntryServiceError(
        "KNOWLEDGE_SOURCE_PROJECT_CLOSED_REQUIRED",
        "知识来源项目必须已关闭。",
        409
      );
    }
    if (
      !project.finalArchiveVersionId ||
      project.finalArchiveVersionId !== input.finalArchiveVersionId
    ) {
      throw new KnowledgeEntryServiceError(
        "KNOWLEDGE_FINAL_ARCHIVE_REQUIRED",
        "知识来源必须引用项目冻结的最终归档版本。",
        409
      );
    }
    const { archiveA, archiveB, retrospective } = await readSourceFacts(client, input, project);
    const archivedRetrospective = await assertArchiveBContainsRetrospective(
      client,
      project.id,
      archiveB.id,
      retrospective
    );
    const histories = await readIssueHistories(client, project.id, input.issueHistoryIds);
    const entryCode = canonicalText(input.code, "code").toUpperCase();
    const content = buildKnowledgeContent(input.draft);
    const existing = input.entryId
      ? await client.knowledgeEntry.findUnique({
          where: { id: canonicalText(input.entryId, "entryId") }
        })
      : await client.knowledgeEntry.findUnique({ where: { code: entryCode } });
    if (input.entryId && !existing) {
      throw new KnowledgeEntryServiceError("KNOWLEDGE_ENTRY_NOT_FOUND", "知识条目不存在。", 404);
    }
    if (existing && !input.entryId) {
      throw new KnowledgeEntryServiceError(
        "KNOWLEDGE_ENTRY_CODE_CONFLICT",
        "知识编码已存在。",
        409
      );
    }
    if (existing?.status === "REVOKED") {
      throw new KnowledgeEntryServiceError(
        "KNOWLEDGE_ENTRY_REVOKED",
        "已撤销的知识条目不得通过新草稿重新启用。",
        409
      );
    }
    if (existing && input.expectedEntryVersion !== existing.version) {
      throw new KnowledgeEntryServiceError(
        "KNOWLEDGE_ENTRY_VERSION_CONFLICT",
        "知识条目已发生变化。",
        409
      );
    }
    if (!existing && input.expectedEntryVersion !== null) {
      throw new KnowledgeEntryServiceError(
        "KNOWLEDGE_ENTRY_VERSION_CONFLICT",
        "新知识条目不得携带既有聚合版本。",
        409
      );
    }
    if (existing) {
      const claimed = await client.knowledgeEntry.updateMany({
        where: { id: existing.id, version: existing.version },
        data: { version: { increment: 1 }, updatedById: input.actorId }
      });
      if (claimed.count !== 1) {
        throw new KnowledgeEntryServiceError(
          "KNOWLEDGE_ENTRY_VERSION_CONFLICT",
          "知识条目已发生变化。",
          409
        );
      }
    }
    const entry =
      existing ??
      (await client.knowledgeEntry.create({
        data: {
          code: entryCode,
          status: "ACTIVE",
          createdById: input.actorId,
          updatedById: input.actorId
        }
      }));
    const entryVersion = existing ? existing.version + 1 : entry.version;
    const latestVersion = await client.knowledgeEntryVersion.findFirst({
      where: { entryId: entry.id },
      orderBy: { versionNo: "desc" },
      select: { versionNo: true }
    });
    const version = await client.knowledgeEntryVersion.create({
      data: {
        entryId: entry.id,
        sourceProjectId: project.id,
        versionNo: (latestVersion?.versionNo ?? 0) + 1,
        supersedesVersionId: entry.currentPublishedVersionId ?? null,
        status: KNOWLEDGE_VERSION_STATUS.DRAFT,
        title: content.value.title,
        sanitizedSummary: content.value.sanitizedSummary,
        experienceType: content.value.experienceType,
        discipline: content.value.discipline,
        normalizedKeywordsJson: inputJson(content.value.normalizedKeywords),
        normalizedKeywordsText: content.value.normalizedKeywordsText,
        applicableProjectTypesJson: inputJson(content.value.applicableProjectTypes),
        applicableStageCodesJson: inputJson(content.value.applicableStageCodes),
        preconditions: content.value.preconditions,
        recommendedPractice: content.value.recommendedPractice,
        antiPatterns: content.value.antiPatterns,
        limitations: content.value.limitations,
        ipSanitizationDeclaration: content.value.ipSanitizationDeclaration,
        internalReusable: content.value.internalReusable,
        contentChecksum: content.contentChecksum,
        createdById: input.actorId
      }
    });
    const sourceInputs = histories.length ? histories : [undefined];
    await client.knowledgeEntrySource.createMany({
      data: sourceInputs.map((history) =>
        entrySourceData({
          versionId: version.id,
          sourceProjectId: project.id,
          archiveA,
          archiveB,
          retrospective,
          archiveManifestSourceChecksum: archivedRetrospective.sourceChecksum,
          ...(history ? { issue: history } : {})
        })
      )
    });
    const audit = await writeAudit(client, {
      action: AUDIT_ACTIONS.KNOWLEDGE_ENTRY_VERSION_CREATED,
      objectType: AUDIT_OBJECT_TYPES.KNOWLEDGE_ENTRY_VERSION,
      objectId: version.id,
      context: auditContext({
        actorId: input.actorId,
        projectId: project.id,
        auditContext: input.auditContext
      }),
      after: {
        value: {
          knowledgeEntryId: entry.id,
          knowledgeVersionId: version.id,
          sourceProjectId: project.id,
          finalArchiveVersionId: archiveB.id,
          retrospectiveInputArchiveVersionId: archiveA.id,
          retrospectiveVersionId: retrospective.id,
          contentChecksum: content.contentChecksum,
          status: version.status
        },
        allowedFields: KNOWLEDGE_ENTRY_AUDIT_FIELDS
      }
    });
    const outbox = await appendOutboxEvent(client, {
      eventType: "knowledge.entry-version.created",
      aggregateType: AUDIT_OBJECT_TYPES.KNOWLEDGE_ENTRY_VERSION,
      aggregateId: version.id,
      idempotencyKey: input.idempotencyKey,
      payload: {
        knowledgeEntryId: entry.id,
        knowledgeVersionId: version.id,
        sourceProjectId: project.id,
        contentChecksum: content.contentChecksum,
        auditId: audit.id
      }
    });
    return {
      entryId: entry.id,
      versionId: version.id,
      entryVersion,
      status: version.status,
      contentChecksum: content.contentChecksum,
      auditId: audit.id,
      outboxEventId: outbox.id
    };
  });
}

export async function submitKnowledgeEntryVersion(
  input: SubmitKnowledgeEntryVersionInput,
  transaction?: Prisma.TransactionClient
) {
  return inTransaction(transaction, async (client: Client) => {
    assertKnowledgeSourceRead(input.sourceRead);
    const entryId = canonicalText(input.entryId, "entryId");
    const version = await client.knowledgeEntryVersion.findUnique({
      where: { id_entryId: { id: canonicalText(input.versionId, "versionId"), entryId } },
      include: { entry: true }
    });
    if (!version || !version.entry) {
      throw new KnowledgeEntryServiceError("KNOWLEDGE_VERSION_NOT_FOUND", "知识版本不存在。", 404);
    }
    assertActiveKnowledgeEntry(version.entry);
    if (version.sourceProjectId === "") {
      throw new KnowledgeEntryServiceError(
        "KNOWLEDGE_SOURCE_PROJECT_REQUIRED",
        "知识来源项目无效。",
        409
      );
    }
    if (version.createdById !== input.actorId) {
      throw new KnowledgeEntryServiceError(
        "KNOWLEDGE_VERSION_OWNER_REQUIRED",
        "仅草稿创建人可提交。",
        403
      );
    }
    if (version.entry.version !== input.expectedEntryVersion) {
      throw new KnowledgeEntryServiceError(
        "KNOWLEDGE_ENTRY_VERSION_CONFLICT",
        "知识条目已发生变化。",
        409
      );
    }
    const status = assertKnowledgeVersionTransition(version.status, "SUBMIT");
    const now = await databaseNow(client);
    const updatedVersion = await client.knowledgeEntryVersion.updateMany({
      where: {
        id: version.id,
        entryId,
        status: version.status,
        entry: { is: { status: "ACTIVE" } }
      },
      data: { status, submittedById: input.actorId, submittedAt: now }
    });
    if (updatedVersion.count !== 1) {
      throw new KnowledgeEntryServiceError(
        "KNOWLEDGE_ENTRY_VERSION_CONFLICT",
        "知识版本已发生变化。",
        409
      );
    }
    const updatedEntry = await client.knowledgeEntry.updateMany({
      where: { id: entryId, version: input.expectedEntryVersion, status: "ACTIVE" },
      data: { version: { increment: 1 }, updatedById: input.actorId }
    });
    if (updatedEntry.count !== 1) {
      throw new KnowledgeEntryServiceError(
        "KNOWLEDGE_ENTRY_VERSION_CONFLICT",
        "知识条目已发生变化。",
        409
      );
    }
    const audit = await writeAudit(client, {
      action: AUDIT_ACTIONS.KNOWLEDGE_ENTRY_REVIEWED,
      objectType: AUDIT_OBJECT_TYPES.KNOWLEDGE_ENTRY_VERSION,
      objectId: version.id,
      context: auditContext({
        actorId: input.actorId,
        projectId: version.sourceProjectId,
        auditContext: input.auditContext
      }),
      after: {
        value: {
          knowledgeEntryId: entryId,
          knowledgeVersionId: version.id,
          sourceProjectId: version.sourceProjectId,
          status
        },
        allowedFields: KNOWLEDGE_ENTRY_AUDIT_FIELDS
      }
    });
    const outbox = await appendOutboxEvent(client, {
      eventType: "knowledge.entry-version.submitted",
      aggregateType: AUDIT_OBJECT_TYPES.KNOWLEDGE_ENTRY_VERSION,
      aggregateId: version.id,
      idempotencyKey: input.idempotencyKey,
      payload: {
        knowledgeEntryId: entryId,
        knowledgeVersionId: version.id,
        status,
        auditId: audit.id
      }
    });
    return {
      entryId,
      versionId: version.id,
      entryVersion: input.expectedEntryVersion + 1,
      status,
      auditId: audit.id,
      outboxEventId: outbox.id
    };
  });
}

export async function reviewKnowledgeEntryVersion(
  input: ReviewKnowledgeEntryVersionInput,
  transaction?: Prisma.TransactionClient
) {
  return inTransaction(transaction, async (client: Client) => {
    assertKnowledgeSourceRead(input.sourceRead);
    const entryId = canonicalText(input.entryId, "entryId");
    const version = await client.knowledgeEntryVersion.findUnique({
      where: { id_entryId: { id: canonicalText(input.versionId, "versionId"), entryId } },
      include: { entry: true }
    });
    if (!version || !version.entry) {
      throw new KnowledgeEntryServiceError("KNOWLEDGE_VERSION_NOT_FOUND", "知识版本不存在。", 404);
    }
    assertActiveKnowledgeEntry(version.entry);
    if (version.entry.version !== input.expectedEntryVersion) {
      throw new KnowledgeEntryServiceError(
        "KNOWLEDGE_ENTRY_VERSION_CONFLICT",
        "知识条目已发生变化。",
        409
      );
    }
    if (version.submittedById === input.actorId) {
      throw new KnowledgeEntryServiceError(
        "KNOWLEDGE_INDEPENDENT_REVIEW_REQUIRED",
        "知识提交人不能审核自己的版本。",
        403
      );
    }
    if (input.decision === "PUBLISH" && (!input.ipConfirmed || !input.sanitizationConfirmed)) {
      throw new KnowledgeEntryServiceError(
        "KNOWLEDGE_IP_SANITIZATION_CONFIRMATION_REQUIRED",
        "发布知识前必须人工确认知识产权和脱敏。",
        409
      );
    }
    const sources = await client.knowledgeEntrySource.findMany({
      where: { knowledgeVersionId: version.id, sourceProjectId: version.sourceProjectId },
      select: { sourceChecksum: true }
    });
    if (!sources.length) {
      throw new KnowledgeEntryServiceError(
        "KNOWLEDGE_SOURCE_REQUIRED",
        "知识版本缺少冻结来源。",
        409
      );
    }
    const status = assertKnowledgeVersionTransition(
      version.status,
      input.decision === "PUBLISH" ? "PUBLISH" : "REJECT"
    );
    const sourceChecksum = payloadHash({
      knowledgeVersionId: version.id,
      sourceChecksums: sources.map((source) => source.sourceChecksum).sort()
    }).hash;
    const now = await databaseNow(client);
    const updatedVersion = await client.knowledgeEntryVersion.updateMany({
      where: {
        id: version.id,
        entryId,
        status: version.status,
        entry: { is: { status: "ACTIVE" } }
      },
      data: {
        status,
        ...(input.decision === "PUBLISH" ? { publishedById: input.actorId, publishedAt: now } : {})
      }
    });
    if (updatedVersion.count !== 1) {
      throw new KnowledgeEntryServiceError(
        "KNOWLEDGE_ENTRY_VERSION_CONFLICT",
        "知识版本已发生变化。",
        409
      );
    }
    if (input.decision === "PUBLISH" && version.entry.currentPublishedVersionId) {
      const superseded = await client.knowledgeEntryVersion.updateMany({
        where: {
          id: version.entry.currentPublishedVersionId,
          entryId,
          status: KNOWLEDGE_VERSION_STATUS.PUBLISHED
        },
        data: { status: KNOWLEDGE_VERSION_STATUS.SUPERSEDED }
      });
      if (superseded.count !== 1) {
        throw new KnowledgeEntryServiceError(
          "KNOWLEDGE_ENTRY_VERSION_CONFLICT",
          "当前已发布知识版本已发生变化。",
          409
        );
      }
    }
    const updatedEntry = await client.knowledgeEntry.updateMany({
      where: { id: entryId, version: input.expectedEntryVersion, status: "ACTIVE" },
      data: {
        ...(input.decision === "PUBLISH" ? { currentPublishedVersionId: version.id } : {}),
        version: { increment: 1 },
        updatedById: input.actorId
      }
    });
    if (updatedEntry.count !== 1) {
      throw new KnowledgeEntryServiceError(
        "KNOWLEDGE_ENTRY_VERSION_CONFLICT",
        "知识条目已发生变化。",
        409
      );
    }
    const review = await client.knowledgeEntryReview.create({
      data: {
        projectId: version.sourceProjectId,
        knowledgeEntryId: entryId,
        knowledgeVersionId: version.id,
        decision: input.decision,
        reason: canonicalText(input.reason, "reason"),
        ipConfirmed: input.ipConfirmed,
        sanitizationConfirmed: input.sanitizationConfirmed,
        reviewerId: input.actorId,
        reviewedAt: now,
        sourceChecksum
      }
    });
    const action =
      input.decision === "PUBLISH"
        ? AUDIT_ACTIONS.KNOWLEDGE_ENTRY_PUBLISHED
        : AUDIT_ACTIONS.KNOWLEDGE_ENTRY_REVIEWED;
    const audit = await writeAudit(client, {
      action,
      objectType: AUDIT_OBJECT_TYPES.KNOWLEDGE_ENTRY_VERSION,
      objectId: version.id,
      context: {
        ...auditContext({
          actorId: input.actorId,
          projectId: version.sourceProjectId,
          auditContext: input.auditContext
        }),
        reason: input.reason
      },
      after: {
        value: {
          knowledgeEntryId: entryId,
          knowledgeVersionId: version.id,
          sourceProjectId: version.sourceProjectId,
          status,
          decision: input.decision,
          reason: input.reason
        },
        allowedFields: KNOWLEDGE_ENTRY_AUDIT_FIELDS
      }
    });
    const outbox = await appendOutboxEvent(client, {
      eventType:
        input.decision === "PUBLISH"
          ? "knowledge.entry-version.published"
          : "knowledge.entry-version.rejected",
      aggregateType: AUDIT_OBJECT_TYPES.KNOWLEDGE_ENTRY_VERSION,
      aggregateId: version.id,
      idempotencyKey: input.idempotencyKey,
      payload: {
        knowledgeEntryId: entryId,
        knowledgeVersionId: version.id,
        reviewId: review.id,
        status,
        decision: input.decision,
        auditId: audit.id
      }
    });
    return {
      entryId,
      versionId: version.id,
      status,
      reviewId: review.id,
      auditId: audit.id,
      outboxEventId: outbox.id
    };
  });
}

export async function revokeKnowledgeEntryVersion(
  input: RevokeKnowledgeEntryVersionInput,
  transaction?: Prisma.TransactionClient
) {
  return inTransaction(transaction, async (client: Client) => {
    assertKnowledgeSourceRead(input.sourceRead);
    const entryId = canonicalText(input.entryId, "entryId");
    const version = await client.knowledgeEntryVersion.findUnique({
      where: { id_entryId: { id: canonicalText(input.versionId, "versionId"), entryId } },
      include: { entry: true }
    });
    if (!version || !version.entry) {
      throw new KnowledgeEntryServiceError("KNOWLEDGE_VERSION_NOT_FOUND", "知识版本不存在。", 404);
    }
    if (version.entry.version !== input.expectedEntryVersion) {
      throw new KnowledgeEntryServiceError(
        "KNOWLEDGE_ENTRY_VERSION_CONFLICT",
        "知识条目已发生变化。",
        409
      );
    }
    const status = assertKnowledgeVersionTransition(version.status, "REVOKE");
    const updatedVersion = await client.knowledgeEntryVersion.updateMany({
      where: { id: version.id, entryId, status: version.status },
      data: { status }
    });
    if (updatedVersion.count !== 1) {
      throw new KnowledgeEntryServiceError(
        "KNOWLEDGE_ENTRY_VERSION_CONFLICT",
        "知识版本已发生变化。",
        409
      );
    }
    const revokesCurrentVersion = version.entry.currentPublishedVersionId === version.id;
    const updatedEntry = await client.knowledgeEntry.updateMany({
      where: { id: entryId, version: input.expectedEntryVersion },
      data: {
        ...(revokesCurrentVersion ? { status: "REVOKED", currentPublishedVersionId: null } : {}),
        version: { increment: 1 },
        updatedById: input.actorId
      }
    });
    if (updatedEntry.count !== 1) {
      throw new KnowledgeEntryServiceError(
        "KNOWLEDGE_ENTRY_VERSION_CONFLICT",
        "知识条目已发生变化。",
        409
      );
    }
    const reason = canonicalText(input.reason, "reason");
    const audit = await writeAudit(client, {
      action: AUDIT_ACTIONS.KNOWLEDGE_ENTRY_REVIEWED,
      objectType: AUDIT_OBJECT_TYPES.KNOWLEDGE_ENTRY_VERSION,
      objectId: version.id,
      context: {
        ...auditContext({
          actorId: input.actorId,
          projectId: version.sourceProjectId,
          auditContext: input.auditContext
        }),
        reason
      },
      after: {
        value: {
          knowledgeEntryId: entryId,
          knowledgeVersionId: version.id,
          sourceProjectId: version.sourceProjectId,
          status,
          decision: "REVOKE",
          reason
        },
        allowedFields: KNOWLEDGE_ENTRY_AUDIT_FIELDS
      }
    });
    const outbox = await appendOutboxEvent(client, {
      eventType: "knowledge.entry-version.revoked",
      aggregateType: AUDIT_OBJECT_TYPES.KNOWLEDGE_ENTRY_VERSION,
      aggregateId: version.id,
      idempotencyKey: input.idempotencyKey,
      payload: {
        knowledgeEntryId: entryId,
        knowledgeVersionId: version.id,
        status,
        reason,
        auditId: audit.id
      }
    });
    return { entryId, versionId: version.id, status, auditId: audit.id, outboxEventId: outbox.id };
  });
}
