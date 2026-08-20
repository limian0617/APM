import { Prisma } from "@prisma/client";

import { db, inTransaction } from "@/lib/db";
import type { AuditContext } from "@/modules/audit/contracts/audit";
import {
  AUDIT_ACTIONS,
  AUDIT_OBJECT_TYPES,
  PROJECT_RETROSPECTIVE_AUDIT_FIELDS
} from "@/modules/audit/domain/vocabulary";
import { writeAudit } from "@/modules/audit/infrastructure/write-audit";
import { payloadHash, type JsonValue } from "@/modules/governance/domain/idempotency";
import { appendOutboxEvent } from "@/modules/governance/infrastructure/outbox";
import { assertProjectWritable } from "@/modules/projects/domain/project-write-policy";

import {
  archiveSourceFormulaFromPersistence,
  type ArchiveSourceFormulaPersistenceValue
} from "@/modules/archives/domain/archive-source-formula";
import {
  assertRetrospectiveInputArchive,
  RETROSPECTIVE_INPUT_FORMULA_VERSION
} from "@/modules/archives/application/retrospective-input-reader";
import {
  assertRetrospectiveVersionTransition,
  buildRetrospectiveContentSnapshot,
  RETROSPECTIVE_STATUS,
  validateRetrospectiveContribution,
  validateRetrospectiveContent,
  type RetrospectiveContent,
  type RetrospectiveContribution
} from "../domain/project-retrospective";

type Client = Prisma.TransactionClient | typeof db;

export class ProjectRetrospectiveServiceError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 422
  ) {
    super(message);
    this.name = "ProjectRetrospectiveServiceError";
  }
}

function text(value: unknown, field: string, max = 191): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > max) {
    throw new ProjectRetrospectiveServiceError("RETROSPECTIVE_INPUT_INVALID", `${field} 无效。`);
  }
  return value.trim();
}

function reason(value: unknown): string {
  return text(value, "reason", 1024);
}

function auditContext(input: { actorId: string; projectId: string; auditContext?: AuditContext }) {
  return {
    ...(input.auditContext ?? {}),
    actorId: input.actorId,
    projectId: input.projectId
  } as AuditContext;
}

async function writeFacts(
  client: Prisma.TransactionClient,
  input: {
    action: (typeof AUDIT_ACTIONS)[keyof typeof AUDIT_ACTIONS];
    objectType: (typeof AUDIT_OBJECT_TYPES)[keyof typeof AUDIT_OBJECT_TYPES];
    objectId: string;
    projectId: string;
    actorId: string;
    auditContext?: AuditContext;
    idempotencyKey: string;
    payload: Record<string, JsonValue>;
    reason?: string;
  }
) {
  const audit = await writeAudit(client, {
    action: input.action,
    objectType: input.objectType,
    objectId: input.objectId,
    context: { ...auditContext(input), reason: input.reason ?? null },
    after: { value: input.payload, allowedFields: PROJECT_RETROSPECTIVE_AUDIT_FIELDS }
  });
  const outbox = await appendOutboxEvent(client, {
    eventType: `project.retrospective.${input.action.toLowerCase()}`,
    aggregateType: input.objectType,
    aggregateId: input.objectId,
    idempotencyKey: input.idempotencyKey,
    payload: { ...input.payload, auditId: audit.id }
  });
  return { auditId: audit.id, outboxEventId: outbox.id };
}

function archiveError(code: string, message: string, status = 409): never {
  throw new ProjectRetrospectiveServiceError(code, message, status);
}

function jsonInput(value: unknown): Prisma.InputJsonValue | Prisma.NullTypes.JsonNull {
  if (value === null) return Prisma.JsonNull;
  return value as Prisma.InputJsonValue;
}

async function readProject(client: Client, projectId: string) {
  const project = await client.project.findUnique({ where: { id: projectId } });
  if (!project) archiveError("PROJECT_NOT_FOUND", "项目不存在。", 404);
  assertProjectWritable(project.status);
  return project;
}

async function assertActiveActor(client: Client, projectId: string, actorId: string) {
  const membership = await client.projectMember.findFirst({
    where: { projectId, userId: actorId, leftAt: null },
    select: { id: true }
  });
  if (!membership) {
    archiveError("RETROSPECTIVE_ACTIVE_MEMBERSHIP_REQUIRED", "操作者必须是当前项目有效成员。", 403);
  }
}

async function readArchiveA(client: Client, projectId: string, archiveVersionId: string) {
  const archive = await client.projectArchiveVersion.findFirst({
    where: { id: archiveVersionId, projectId },
    include: { integrityChecks: { orderBy: { sequence: "desc" }, take: 1 } }
  });
  if (!archive || archive.projectId !== projectId) {
    archiveError("RETROSPECTIVE_INPUT_ARCHIVE_NOT_APPLICABLE", "归档 A 不属于当前项目。", 409);
  }
  const formula = archiveSourceFormulaFromPersistence(
    archive.archiveSourceFormulaVersion as ArchiveSourceFormulaPersistenceValue
  );
  assertRetrospectiveInputArchive({
    archiveSourceFormulaVersion: formula,
    retrospectiveInputApplicability: archive.retrospectiveInputApplicability
  });
  if (
    archive.status !== "READY" ||
    archive.retrospectiveInputWatermarkVersion !== RETROSPECTIVE_INPUT_FORMULA_VERSION ||
    !archive.retrospectiveInputSnapshotJson ||
    !archive.retrospectiveInputWatermark ||
    archive.integrityChecks?.[0]?.status !== "PASSED"
  ) {
    archiveError(
      "RETROSPECTIVE_INPUT_ARCHIVE_NOT_READY",
      "归档 A 必须已 READY 且完整性检查通过。",
      409
    );
  }
  if (!archive.retrospectiveInputWatermarkVersion || !archive.retrospectiveInputWatermark) {
    archiveError("RETROSPECTIVE_INPUT_ARCHIVE_NOT_READY", "归档 A 缺少复盘输入水位。", 409);
  }
  return {
    ...archive,
    archiveSourceFormulaVersion: formula,
    retrospectiveInputWatermarkVersion: archive.retrospectiveInputWatermarkVersion,
    retrospectiveInputWatermark: archive.retrospectiveInputWatermark,
    retrospectiveInputSnapshotJson: archive.retrospectiveInputSnapshotJson
  };
}

function normalizeContributions(values: readonly RetrospectiveContribution[]) {
  return values.map((value) => validateRetrospectiveContribution(value));
}

function unique(values: readonly string[]) {
  return [...new Set(values)];
}

async function assertContributionSources(
  client: Client,
  projectId: string,
  contributions: readonly RetrospectiveContribution[]
) {
  const membershipIds = unique(contributions.map((value) => value.contributorMembershipId));
  const deliveryUnitIds = unique(
    contributions.flatMap((value) => (value.deliveryUnitId ? [value.deliveryUnitId] : []))
  );
  const [memberships, deliveryUnits] = await Promise.all([
    membershipIds.length
      ? client.projectMember.findMany({
          where: { projectId, id: { in: membershipIds }, leftAt: null },
          select: { id: true }
        })
      : [],
    deliveryUnitIds.length
      ? client.deliveryUnit.findMany({
          where: { projectId, id: { in: deliveryUnitIds } },
          select: { id: true }
        })
      : []
  ]);
  if (
    memberships.length !== membershipIds.length ||
    deliveryUnits.length !== deliveryUnitIds.length
  ) {
    archiveError(
      "RETROSPECTIVE_SOURCE_NOT_IN_PROJECT",
      "复盘贡献人和交付单元必须属于当前项目。",
      409
    );
  }
}

export type RetrospectiveContentInput = RetrospectiveContent & {
  projectSnapshot?: Record<string, unknown>;
};

export async function createRetrospectiveVersion(
  input: {
    projectId: string;
    retrospectiveInputArchiveVersionId: string;
    expectedAggregateVersion: number | null;
    content: RetrospectiveContentInput;
    contributionInputs: RetrospectiveContribution[];
    participantMembershipIds: string[];
    issueHistoryIds: string[];
    actorId: string;
    idempotencyKey: string;
    auditContext?: AuditContext;
  },
  transaction?: Prisma.TransactionClient
) {
  const projectId = text(input.projectId, "projectId");
  const actorId = text(input.actorId, "actorId");
  const idempotencyKey = text(input.idempotencyKey, "idempotencyKey");
  return inTransaction(transaction, async (client) => {
    const project = await readProject(client, projectId);
    await assertActiveActor(client, projectId, actorId);
    const archive = await readArchiveA(
      client,
      projectId,
      text(input.retrospectiveInputArchiveVersionId, "archiveVersionId")
    );
    const aggregate = await client.projectRetrospective.upsert({
      where: { projectId },
      create: { projectId, version: 1, createdById: actorId, updatedById: actorId },
      update: {}
    });
    if (
      input.expectedAggregateVersion !== null &&
      aggregate.version !== input.expectedAggregateVersion
    ) {
      archiveError("RETROSPECTIVE_VERSION_CONFLICT", "复盘已发生变化，请刷新后重试。", 409);
    }
    if (aggregate.version > 1 && input.expectedAggregateVersion === null) {
      archiveError("RETROSPECTIVE_VERSION_CONFLICT", "创建复盘草稿需要当前聚合版本。", 409);
    }
    const content = validateRetrospectiveContent(input.content);
    const contributions = normalizeContributions(input.contributionInputs);
    await assertContributionSources(client, projectId, contributions);
    const membershipIds = unique(
      input.participantMembershipIds.map((membershipId) => text(membershipId, "membershipId"))
    );
    const memberships = membershipIds.length
      ? await client.projectMember.findMany({
          where: { projectId, id: { in: membershipIds }, leftAt: null }
        })
      : [];
    if (memberships.length !== membershipIds.length) {
      archiveError("RETROSPECTIVE_SOURCE_NOT_IN_PROJECT", "复盘参与人必须属于当前项目。", 409);
    }
    const participants = membershipIds.map((membershipId) => ({
      membershipId: text(membershipId, "membershipId"),
      roleCode: "CONTRIBUTOR",
      responsibilityText: "参与项目复盘事实提供。"
    }));
    const issueHistoryIds = input.issueHistoryIds.map((issueHistoryId) =>
      text(issueHistoryId, "issueHistoryId")
    );
    const historyRows = issueHistoryIds.length
      ? await client.issueHistory.findMany({ where: { projectId, id: { in: issueHistoryIds } } })
      : [];
    if (historyRows.length !== issueHistoryIds.length) {
      archiveError("RETROSPECTIVE_SOURCE_NOT_IN_PROJECT", "复盘问题历史必须属于当前项目。", 409);
    }
    const historyById = new Map(historyRows.map((row) => [row.id, row]));
    const issueSources = issueHistoryIds.map((issueHistoryId) => {
      const row = historyById.get(issueHistoryId);
      if (!row) archiveError("RETROSPECTIVE_SOURCE_NOT_IN_PROJECT", "复盘问题历史不存在。", 409);
      return {
        issueId: row.issueId,
        issueHistoryId: row.id,
        issueHistorySequence: row.sequence,
        sourceChecksum: payloadHash(row.snapshotJson).hash,
        snapshotJson: jsonInput(row.snapshotJson)
      };
    });
    const projectSnapshot = {
      id: project.id,
      code: project.code,
      name: project.name,
      type: project.projectType,
      status: project.status,
      mainControlStageCode: project.mainControlStageCode
    };
    const built = buildRetrospectiveContentSnapshot({
      ...content,
      projectSnapshot,
      contributions,
      participants,
      issueSources
    });
    const versionNo =
      ((
        await client.projectRetrospectiveVersion.findFirst({
          where: { retrospectiveId: aggregate.id, projectId },
          orderBy: { versionNo: "desc" },
          select: { versionNo: true }
        })
      )?.versionNo ?? 0) + 1;
    const previous = await client.projectRetrospectiveVersion.findFirst({
      where: { retrospectiveId: aggregate.id, projectId },
      orderBy: { versionNo: "desc" },
      select: { id: true, status: true }
    });
    if (previous?.status === RETROSPECTIVE_STATUS.DRAFT) {
      const superseded = await client.projectRetrospectiveVersion.updateMany({
        where: { id: previous.id, projectId, status: RETROSPECTIVE_STATUS.DRAFT },
        data: { status: RETROSPECTIVE_STATUS.SUPERSEDED }
      });
      if (superseded.count !== 1) {
        archiveError("RETROSPECTIVE_VERSION_CONFLICT", "复盘草稿已发生变化，请重试。", 409);
      }
    }
    const version = await client.projectRetrospectiveVersion.create({
      data: {
        projectId,
        retrospectiveId: aggregate.id,
        versionNo,
        supersedesVersionId: previous?.id ?? null,
        status: RETROSPECTIVE_STATUS.DRAFT,
        retrospectiveInputArchiveVersionId: archive.id,
        retrospectiveInputManifestChecksum: archive.manifestChecksum,
        retrospectiveInputSourceWatermark: archive.sourceWatermark,
        retrospectiveInputWatermarkVersion: archive.retrospectiveInputWatermarkVersion,
        retrospectiveInputWatermark: archive.retrospectiveInputWatermark,
        projectSnapshotJson: jsonInput(built.snapshot.projectSnapshot),
        deliverySummaryJson: jsonInput(built.snapshot.deliverySummary),
        successfulPracticesJson: jsonInput(built.snapshot.successfulPractices),
        shortcomingsJson: jsonInput(built.snapshot.shortcomings),
        improvementsJson: jsonInput(built.snapshot.improvements),
        knowledgeDispositionJson: jsonInput(built.snapshot.knowledgeDisposition),
        ipDeclarationJson: jsonInput(built.snapshot.ipDeclaration),
        contentChecksum: built.contentChecksum,
        createdById: actorId,
        contributions: { create: contributions.map((value) => ({ ...value })) },
        participants: { create: participants },
        issueSources: {
          create: issueSources
        }
      },
      select: { id: true, projectId: true, versionNo: true, status: true }
    });
    const updatedAggregate = await client.projectRetrospective.updateMany({
      where: { id: aggregate.id, projectId, version: aggregate.version },
      data: { currentVersionId: version.id, version: { increment: 1 }, updatedById: actorId }
    });
    if (updatedAggregate.count !== 1)
      archiveError("RETROSPECTIVE_VERSION_CONFLICT", "复盘已发生变化，请重试。", 409);
    const facts = await writeFacts(client, {
      action: AUDIT_ACTIONS.PROJECT_RETROSPECTIVE_DRAFT_CREATED,
      objectType: AUDIT_OBJECT_TYPES.PROJECT_RETROSPECTIVE_VERSION,
      objectId: version.id,
      projectId,
      actorId,
      auditContext: input.auditContext,
      idempotencyKey,
      payload: {
        projectId,
        retrospectiveId: aggregate.id,
        retrospectiveVersionId: version.id,
        archiveVersionId: archive.id,
        contentChecksum: built.contentChecksum
      }
    });
    return { ...version, contentChecksum: built.contentChecksum, ...facts };
  });
}

async function readVersion(client: Client, projectId: string, versionId: string) {
  const version = await client.projectRetrospectiveVersion.findUnique({
    where: { id_projectId: { id: versionId, projectId } },
    include: { retrospective: true }
  });
  if (!version) archiveError("RETROSPECTIVE_VERSION_NOT_FOUND", "复盘版本不存在。", 404);
  return version;
}

export async function submitRetrospectiveVersion(
  input: {
    projectId: string;
    versionId: string;
    expectedAggregateVersion: number;
    actorId: string;
    idempotencyKey: string;
    auditContext?: AuditContext;
  },
  transaction?: Prisma.TransactionClient
) {
  return inTransaction(transaction, async (client) => {
    await readProject(client, text(input.projectId, "projectId"));
    await assertActiveActor(client, input.projectId, text(input.actorId, "actorId"));
    const version = await readVersion(client, input.projectId, text(input.versionId, "versionId"));
    const aggregateVersion = version.retrospective?.version ?? input.expectedAggregateVersion;
    if (version.retrospective && aggregateVersion !== input.expectedAggregateVersion)
      archiveError("RETROSPECTIVE_VERSION_CONFLICT", "复盘已发生变化，请刷新后重试。", 409);
    const status = assertRetrospectiveVersionTransition(version.status, "SUBMIT");
    const updated = await client.projectRetrospectiveVersion.update({
      where: { id: version.id },
      data: { status, submittedById: input.actorId, submittedAt: new Date() }
    });
    const aggregateUpdate = await client.projectRetrospective.updateMany({
      where: {
        id: version.retrospectiveId,
        projectId: input.projectId,
        version: input.expectedAggregateVersion,
        currentVersionId: version.id
      },
      data: { version: { increment: 1 }, updatedById: input.actorId }
    });
    if (aggregateUpdate.count !== 1) {
      archiveError("RETROSPECTIVE_VERSION_CONFLICT", "复盘已发生变化，请重试。", 409);
    }
    const facts = await writeFacts(client, {
      action: AUDIT_ACTIONS.PROJECT_RETROSPECTIVE_SUBMITTED,
      objectType: AUDIT_OBJECT_TYPES.PROJECT_RETROSPECTIVE_VERSION,
      objectId: version.id,
      projectId: input.projectId,
      actorId: input.actorId,
      auditContext: input.auditContext,
      idempotencyKey: input.idempotencyKey,
      payload: { projectId: input.projectId, retrospectiveVersionId: version.id, status }
    });
    return { ...updated, ...facts };
  });
}

export async function reviewRetrospectiveVersion(
  input: {
    projectId: string;
    versionId: string;
    decision: "APPROVED" | "REJECTED";
    reason: string;
    expectedAggregateVersion: number;
    actorId: string;
    idempotencyKey: string;
    auditContext?: AuditContext;
  },
  transaction?: Prisma.TransactionClient
) {
  return inTransaction(transaction, async (client) => {
    await readProject(client, text(input.projectId, "projectId"));
    await assertActiveActor(client, input.projectId, text(input.actorId, "actorId"));
    const version = await readVersion(client, input.projectId, text(input.versionId, "versionId"));
    if (version.retrospective?.version !== input.expectedAggregateVersion)
      archiveError("RETROSPECTIVE_VERSION_CONFLICT", "复盘已发生变化，请刷新后重试。", 409);
    if (input.actorId === version.submittedById)
      archiveError(
        "RETROSPECTIVE_INDEPENDENT_REVIEW_REQUIRED",
        "复盘提交人不能审核自己的版本。",
        403
      );
    const status = assertRetrospectiveVersionTransition(
      version.status,
      input.decision === "APPROVED" ? "APPROVE" : "REJECT"
    );
    const updated = await client.projectRetrospectiveVersion.update({
      where: { id: version.id },
      data: { status }
    });
    await client.projectRetrospectiveReview.create({
      data: {
        projectId: input.projectId,
        retrospectiveId: version.retrospectiveId,
        retrospectiveVersionId: version.id,
        decision: input.decision,
        reason: reason(input.reason),
        reviewerId: input.actorId,
        reviewedAt: new Date()
      }
    });
    const aggregateUpdate = await client.projectRetrospective.updateMany({
      where: {
        id: version.retrospectiveId,
        projectId: input.projectId,
        version: input.expectedAggregateVersion,
        currentVersionId: version.id
      },
      data: {
        ...(input.decision === "APPROVED" ? { latestApprovedVersionId: version.id } : {}),
        version: { increment: 1 },
        updatedById: input.actorId
      }
    });
    if (aggregateUpdate.count !== 1) {
      archiveError("RETROSPECTIVE_VERSION_CONFLICT", "复盘已发生变化，请重试。", 409);
    }
    const facts = await writeFacts(client, {
      action: AUDIT_ACTIONS.PROJECT_RETROSPECTIVE_REVIEWED,
      objectType: AUDIT_OBJECT_TYPES.PROJECT_RETROSPECTIVE_VERSION,
      objectId: version.id,
      projectId: input.projectId,
      actorId: input.actorId,
      auditContext: input.auditContext,
      idempotencyKey: input.idempotencyKey,
      reason: input.reason,
      payload: {
        projectId: input.projectId,
        retrospectiveVersionId: version.id,
        decision: input.decision,
        status
      }
    });
    return { ...updated, ...facts };
  });
}
