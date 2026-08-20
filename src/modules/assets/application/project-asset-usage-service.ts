import { Prisma } from "@prisma/client";
import { createHash } from "node:crypto";

import { decideAuthorization, type AuthorizationActor } from "@/lib/auth/authorize";
import { PERMISSIONS } from "@/lib/auth/permissions";
import { db, inTransaction } from "@/lib/db";
import type { AuditContext } from "@/modules/audit/contracts/audit";
import {
  AUDIT_ACTIONS,
  AUDIT_OBJECT_TYPES,
  AUDIT_RESULTS,
  PROJECT_ASSET_AUDIT_FIELDS
} from "@/modules/audit/domain/vocabulary";
import { writeAudit } from "@/modules/audit/infrastructure/write-audit";
import { appendOutboxEvent } from "@/modules/governance/infrastructure/outbox";

import {
  assertActiveProjectAssetUsage,
  assertActiveReference,
  assertReferenceCanRetire,
  assertRetireVersion,
  assertProjectAssetUsageScope,
  canonicalProjectAssetConfiguration,
  parseProjectAssetQuantity,
  ProjectAssetUsageError
} from "../domain/project-asset-usage";
import { canonicalJson } from "@/modules/governance/domain/idempotency";

type Client = Prisma.TransactionClient;
type UsageSnapshotRow = {
  id: string;
  scopeType: string;
  scopeId: string;
  deliveryUnitId: string | null;
  moduleId: string | null;
};

export function selectAssetUsageSnapshotRows<T extends UsageSnapshotRow>(input: {
  rows: T[];
  projectId: string;
  scopeType: "PROJECT" | "DELIVERY_UNIT" | "MACHINE" | "MODULE";
  scopeId: string;
  parentDeliveryUnitId?: string | null;
}): T[] {
  if (input.scopeType === "PROJECT") {
    if (input.scopeId !== input.projectId)
      throw new ProjectAssetUsageError(
        "PROJECT_ASSET_SNAPSHOT_SCOPE_INVALID",
        "PROJECT 范围必须使用当前项目 ID。",
        404
      );
    return input.rows;
  }
  if (input.scopeType === "MODULE") {
    return input.rows.filter(
      (row) =>
        row.scopeType === "PROJECT" ||
        (row.scopeType === "DELIVERY_UNIT" && row.scopeId === input.parentDeliveryUnitId) ||
        (row.scopeType === "MODULE" && row.scopeId === input.scopeId)
    );
  }
  return input.rows.filter(
    (row) =>
      row.scopeType === "PROJECT" ||
      (row.scopeType === "DELIVERY_UNIT" && row.scopeId === input.scopeId) ||
      (row.scopeType === "MODULE" && row.deliveryUnitId === input.scopeId)
  );
}

function frozenUsageVersion(
  row: { version: number; status: string; retiredAt: Date | null },
  frozenAt: Date
) {
  if (row.status !== "RETIRED" || !row.retiredAt || row.retiredAt <= frozenAt) return row.version;
  if (!Number.isSafeInteger(row.version) || row.version <= 1) {
    throw new ProjectAssetUsageError(
      "PROJECT_ASSET_SNAPSHOT_VERSION_INVALID",
      "退役使用记录缺少可重放的 ACTIVE 版本。",
      409
    );
  }
  return row.version - 1;
}

async function databaseNow(client: Client) {
  const [row] = await client.$queryRaw<Array<{ now: Date }>>`SELECT CURRENT_TIMESTAMP AS "now"`;
  if (!row) throw new Error("无法读取数据库时间。");
  return row.now;
}

function text(value: unknown, field: string) {
  if (typeof value !== "string" || !value.trim())
    throw new ProjectAssetUsageError("INVALID_INPUT", `${field}不能为空。`);
  return value.trim();
}

async function lockReference(client: Client, projectId: string, referenceId: string) {
  await client.$queryRaw`SELECT "id" FROM "project_asset_references" WHERE "id" = ${referenceId} AND "project_id" = ${projectId} FOR UPDATE`;
  return client.projectAssetReference.findFirst({ where: { id: referenceId, projectId } });
}

async function lockProject(client: Client, projectId: string) {
  await client.$queryRaw`SELECT "id" FROM "projects" WHERE "id" = ${projectId} FOR UPDATE`;
  return client.project.findUnique({
    where: { id: projectId },
    select: { id: true, status: true, version: true }
  });
}

async function lockUsage(client: Client, projectId: string, usageId: string) {
  await client.$queryRaw`SELECT "id" FROM "project_asset_usages" WHERE "id" = ${usageId} AND "project_id" = ${projectId} FOR UPDATE`;
  return client.projectAssetUsage.findFirst({ where: { id: usageId, projectId } });
}

async function lockSourceFacts(
  client: Client,
  input: {
    technicalAssetId: string;
    assetReleaseId: string;
    assetReleaseVersionId: string;
    componentSnapshotId?: string;
  }
) {
  await client.$queryRaw`SELECT "id" FROM "technical_assets" WHERE "id" = ${input.technicalAssetId} FOR UPDATE`;
  await client.$queryRaw`SELECT "id" FROM "rnd_projects" WHERE "id" = (SELECT "rnd_project_id" FROM "technical_assets" WHERE "id" = ${input.technicalAssetId}) FOR UPDATE`;
  await client.$queryRaw`SELECT "id" FROM "asset_releases" WHERE "id" = ${input.assetReleaseId} AND "technical_asset_id" = ${input.technicalAssetId} FOR UPDATE`;
  await client.$queryRaw`SELECT "id" FROM "asset_release_versions" WHERE "id" = ${input.assetReleaseVersionId} AND "release_id" = ${input.assetReleaseId} AND "technical_asset_id" = ${input.technicalAssetId} FOR UPDATE`;
  await client.$queryRaw`SELECT "id" FROM "asset_component_snapshots" WHERE "release_version_id" = ${input.assetReleaseVersionId} AND "technical_asset_id" = ${input.technicalAssetId} FOR UPDATE`;
  if (input.componentSnapshotId) {
    await client.$queryRaw`SELECT "id" FROM "asset_component_snapshots" WHERE "id" = ${input.componentSnapshotId} AND "release_version_id" = ${input.assetReleaseVersionId} AND "technical_asset_id" = ${input.technicalAssetId} FOR UPDATE`;
  }
}

type SourceFileFact = { fileId: string; sha256: string };

function sourceFileFacts(component: {
  sourceFileId: string;
  sourceFileSha256: string;
  snapshotJson: unknown;
}): SourceFileFact[] {
  const invalid = () =>
    new ProjectAssetUsageError("PROJECT_ASSET_SOURCE_FILE_INVALID", "组件来源文件快照无效。", 409);
  if (!component.sourceFileId.trim() || !/^[0-9a-f]{64}$/iu.test(component.sourceFileSha256)) {
    throw invalid();
  }
  if (
    !component.snapshotJson ||
    typeof component.snapshotJson !== "object" ||
    Array.isArray(component.snapshotJson)
  ) {
    throw invalid();
  }
  const files = (component.snapshotJson as { files?: unknown }).files;
  if (!Array.isArray(files)) {
    throw invalid();
  }
  const facts: SourceFileFact[] = [
    { fileId: component.sourceFileId, sha256: component.sourceFileSha256.toLowerCase() }
  ];
  for (const file of files) {
    if (!file || typeof file !== "object") throw invalid();
    const { fileId, sha256 } = file as { fileId?: unknown; sha256?: unknown };
    if (
      typeof fileId !== "string" ||
      !fileId.trim() ||
      typeof sha256 !== "string" ||
      !/^[0-9a-f]{64}$/iu.test(sha256)
    ) {
      throw invalid();
    }
    facts.push({ fileId: fileId.trim(), sha256: sha256.toLowerCase() });
  }
  const unique = new Map<string, string>();
  for (const fact of facts) {
    const existing = unique.get(fact.fileId);
    if (existing && existing !== fact.sha256) throw invalid();
    unique.set(fact.fileId, fact.sha256);
  }
  return [...unique].map(([fileId, sha256]) => ({ fileId, sha256 }));
}

function fileAuthorizationSelect(actorId: string) {
  return {
    id: true,
    projectId: true,
    status: true,
    sensitivity: true,
    sha256: true,
    uploadedById: true,
    project: {
      select: {
        departmentId: true,
        members: {
          where: { userId: actorId, leftAt: null },
          select: { projectRole: true }
        }
      }
    }
  } as const;
}

type AuthorizedFile = {
  id: string;
  projectId: string;
  status: string;
  sensitivity: string;
  sha256: string | null;
  uploadedById: string;
  project: { departmentId: string | null; members: Array<{ projectRole: string }> };
};

export function assertSensitiveFileReadAuthorized(file: AuthorizedFile, actor: AuthorizationActor) {
  if (file.sensitivity !== "RESTRICTED") return;
  const decision = decideAuthorization(actor, PERMISSIONS.SENSITIVE_FILE_READ, {
    projectId: file.projectId,
    resourceDepartmentId: file.project.departmentId,
    resourceOwnerId: file.uploadedById,
    memberRoles: file.project.members.map(({ projectRole }) => projectRole),
    requireProjectMembership: true
  });
  if (!decision.allowed) {
    throw new ProjectAssetUsageError(
      "PROJECT_ASSET_SENSITIVE_FILE_DENIED",
      "无权读取受限资产来源或派生目标文件。",
      403
    );
  }
}

export async function assertSourceFilesAvailableAndAuthorized(
  client: Client,
  input: {
    technicalAssetId: string;
    assetReleaseVersionId: string;
    authorizationActor: AuthorizationActor;
  }
) {
  const components = await client.assetComponentSnapshot.findMany({
    where: {
      releaseVersionId: input.assetReleaseVersionId,
      technicalAssetId: input.technicalAssetId
    },
    select: {
      sourceProjectId: true,
      sourceFileId: true,
      sourceFileSha256: true,
      snapshotJson: true
    }
  });
  if (!components.length) {
    throw new ProjectAssetUsageError(
      "PROJECT_ASSET_COMPONENT_NOT_FOUND",
      "Release 版本不含可引用组件快照。",
      409
    );
  }
  for (const component of components) {
    for (const sourceFile of sourceFileFacts(component)) {
      const file = await client.fileObject.findFirst({
        where: { id: sourceFile.fileId, projectId: component.sourceProjectId },
        select: fileAuthorizationSelect(input.authorizationActor.id)
      });
      if (!file || file.status !== "AVAILABLE") {
        throw new ProjectAssetUsageError(
          "PROJECT_ASSET_SOURCE_FILE_UNAVAILABLE",
          "资产来源文件不可用。",
          409
        );
      }
      if (file.sha256?.toLowerCase() !== sourceFile.sha256) {
        throw new ProjectAssetUsageError(
          "PROJECT_ASSET_SOURCE_FILE_INVALID",
          "资产来源文件与冻结 SHA-256 不一致。",
          409
        );
      }
      assertSensitiveFileReadAuthorized(file, input.authorizationActor);
    }
  }
}

export async function assertSourceFilesSensitiveReadAuthorized(
  client: Client,
  input: {
    technicalAssetId: string;
    assetReleaseVersionId: string;
    authorizationActor: AuthorizationActor;
  }
) {
  const components = await client.assetComponentSnapshot.findMany({
    where: {
      releaseVersionId: input.assetReleaseVersionId,
      technicalAssetId: input.technicalAssetId
    },
    select: {
      sourceProjectId: true,
      sourceFileId: true,
      sourceFileSha256: true,
      snapshotJson: true
    }
  });
  if (!components.length) {
    throw new ProjectAssetUsageError(
      "PROJECT_ASSET_COMPONENT_NOT_FOUND",
      "Release 版本不含可引用组件快照。",
      409
    );
  }
  for (const component of components) {
    for (const sourceFile of sourceFileFacts(component)) {
      const file = await client.fileObject.findFirst({
        where: { id: sourceFile.fileId, projectId: component.sourceProjectId },
        select: fileAuthorizationSelect(input.authorizationActor.id)
      });
      if (!file) {
        throw new ProjectAssetUsageError(
          "PROJECT_ASSET_SOURCE_FILE_INVALID",
          "资产来源文件不再可识别。",
          409
        );
      }
      assertSensitiveFileReadAuthorized(file, input.authorizationActor);
    }
  }
}

async function lockDerivationTarget(
  client: Client,
  input: { projectId: string; documentVersionId: string; fileId: string; drawingId?: string | null }
) {
  await client.$queryRaw`SELECT "id" FROM "controlled_document_versions" WHERE "id" = ${input.documentVersionId} AND "project_id" = ${input.projectId} FOR UPDATE`;
  await client.$queryRaw`SELECT "id" FROM "controlled_documents" WHERE "id" = (SELECT "document_id" FROM "controlled_document_versions" WHERE "id" = ${input.documentVersionId} AND "project_id" = ${input.projectId}) AND "project_id" = ${input.projectId} FOR UPDATE`;
  await client.$queryRaw`SELECT "id" FROM "file_objects" WHERE "id" = ${input.fileId} AND "project_id" = ${input.projectId} FOR UPDATE`;
  if (input.drawingId) {
    await client.$queryRaw`SELECT "id" FROM "mechanical_drawings" WHERE "id" = ${input.drawingId} AND "project_id" = ${input.projectId} FOR UPDATE`;
    await client.$queryRaw`SELECT "id" FROM "mechanical_drawing_version_files" WHERE "project_id" = ${input.projectId} AND "drawing_id" = ${input.drawingId} AND "document_version_id" = ${input.documentVersionId} AND "file_id" = ${input.fileId} FOR UPDATE`;
  }
}

async function lockUsageScope(
  client: Client,
  input: { projectId: string; deliveryUnitId?: string | null; moduleId?: string | null }
) {
  if (input.deliveryUnitId) {
    await client.$queryRaw`SELECT "id" FROM "delivery_units" WHERE "id" = ${input.deliveryUnitId} AND "project_id" = ${input.projectId} FOR UPDATE`;
  }
  if (input.moduleId) {
    await client.$queryRaw`SELECT "id" FROM "project_modules" WHERE "id" = ${input.moduleId} AND "project_id" = ${input.projectId} AND "delivery_unit_id" = ${input.deliveryUnitId ?? ""} FOR UPDATE`;
  }
}

function auditContext(input: {
  auditContext: AuditContext;
  actorId: string;
  projectId: string;
  reason: string;
}) {
  return {
    ...input.auditContext,
    actorId: input.actorId,
    projectId: input.projectId,
    reason: input.reason
  };
}

function valueOf(record: Record<string, unknown>) {
  return record;
}

function serializeReference(
  reference: Prisma.ProjectAssetReferenceGetPayload<Record<string, never>>,
  canManage = false
) {
  return {
    id: reference.id,
    projectId: reference.projectId,
    technicalAssetId: reference.technicalAssetId,
    assetReleaseId: reference.assetReleaseId,
    assetReleaseVersionId: reference.assetReleaseVersionId,
    releaseCode: reference.releaseCode,
    releaseRevision: reference.releaseRevision,
    snapshotChecksum: reference.snapshotChecksum,
    sourceWatermark: reference.sourceWatermark,
    status: reference.status,
    version: reference.version,
    resourceVersion: reference.version,
    createdAt: reference.createdAt.toISOString(),
    retiredAt: reference.retiredAt?.toISOString() ?? null,
    retiredById: reference.retiredById,
    retireReason: reference.retireReason,
    allowedActions: canManage && reference.status === "ACTIVE" ? ["RETIRE"] : []
  };
}

function serializeUsage(
  usage: Prisma.ProjectAssetUsageGetPayload<Record<string, never>>,
  canManage = false
) {
  return {
    id: usage.id,
    projectId: usage.projectId,
    usageKey: usage.usageKey,
    referenceId: usage.referenceId,
    technicalAssetId: usage.technicalAssetId,
    assetReleaseId: usage.assetReleaseId,
    assetReleaseVersionId: usage.assetReleaseVersionId,
    componentSnapshotId: usage.componentSnapshotId,
    releaseRevision: usage.releaseRevision,
    snapshotChecksum: usage.snapshotChecksum,
    sourceWatermark: usage.sourceWatermark,
    quantity: usage.quantity.toString(),
    configuration: usage.configurationJson,
    scopeType: usage.scopeType,
    scopeId: usage.scopeId,
    deliveryUnitId: usage.deliveryUnitId,
    moduleId: usage.moduleId,
    status: usage.status,
    version: usage.version,
    resourceVersion: usage.version,
    createdAt: usage.createdAt.toISOString(),
    retiredAt: usage.retiredAt?.toISOString() ?? null,
    retiredById: usage.retiredById,
    retireReason: usage.retireReason,
    allowedActions: canManage && usage.status === "ACTIVE" ? ["RETIRE", "CREATE_DERIVATION"] : []
  };
}

function serializeDerivation(
  derivation: Prisma.ProjectAssetDerivationGetPayload<Record<string, never>>
) {
  return {
    id: derivation.id,
    projectId: derivation.projectId,
    sourceReferenceId: derivation.sourceReferenceId,
    sourceUsageId: derivation.sourceUsageId,
    sourceTechnicalAssetId: derivation.sourceTechnicalAssetId,
    sourceAssetReleaseId: derivation.sourceAssetReleaseId,
    sourceAssetReleaseVersionId: derivation.sourceAssetReleaseVersionId,
    sourceComponentSnapshotId: derivation.sourceComponentSnapshotId,
    sourceReleaseRevision: derivation.sourceReleaseRevision,
    sourceSnapshotChecksum: derivation.sourceSnapshotChecksum,
    sourceWatermark: derivation.sourceWatermark,
    targetType: derivation.targetType,
    targetControlledDocumentVersionId: derivation.targetControlledDocumentVersionId,
    targetMechanicalDrawingId: derivation.targetMechanicalDrawingId,
    targetSourceFileId: derivation.targetFileId,
    targetSourceFileSha256: derivation.targetSourceFileSha256,
    targetDocumentVersion: derivation.targetDocumentVersion,
    targetDocumentVersionStatus: derivation.targetDocumentVersionStatus,
    targetFileStatus: derivation.targetFileStatus,
    reason: derivation.reason,
    createdAt: derivation.createdAt.toISOString(),
    allowedActions: [] as string[]
  };
}

async function writeFactAudit(
  client: Client,
  input: {
    action: string;
    objectType: string;
    objectId: string;
    context: AuditContext;
    value: Record<string, unknown>;
    eventType: string;
    aggregateType: string;
  }
) {
  const audit = await writeAudit(client, {
    action: input.action as never,
    objectType: input.objectType as never,
    objectId: input.objectId,
    context: input.context,
    after: { value: input.value, allowedFields: PROJECT_ASSET_AUDIT_FIELDS }
  });
  const outbox = await appendOutboxEvent(client, {
    eventType: input.eventType,
    aggregateType: input.aggregateType,
    aggregateId: input.objectId,
    idempotencyKey: `${input.aggregateType}:${input.objectId}:${input.action}`,
    payload: input.value
  });
  return { auditId: audit.id, outboxEventId: outbox.id };
}

export async function recordProjectAssetCommandFailure(input: {
  action: string;
  objectType: string;
  objectId: string;
  projectId: string;
  context: AuditContext;
  error: unknown;
}) {
  if (
    !(input.error instanceof ProjectAssetUsageError) &&
    !(input.error instanceof Prisma.PrismaClientKnownRequestError)
  )
    return;
  const reason =
    input.error instanceof ProjectAssetUsageError ? input.error.code : `PRISMA_${input.error.code}`;
  await writeAudit(db, {
    action: input.action as never,
    objectType: input.objectType as never,
    objectId: input.objectId,
    result: AUDIT_RESULTS.FAILURE,
    context: { ...input.context, projectId: input.projectId, reason },
    after: {
      value: { projectId: input.projectId, reason },
      allowedFields: PROJECT_ASSET_AUDIT_FIELDS
    }
  });
}

export async function listProjectAssetReferences(input: {
  projectId: string;
  status?: "ACTIVE" | "RETIRED";
  cursor?: string;
  limit: number;
  actorId: string;
  auditContext: AuditContext;
  canManage: boolean;
}) {
  return inTransaction(undefined, async (client) => {
    const rows = await client.projectAssetReference.findMany({
      where: { projectId: input.projectId, ...(input.status ? { status: input.status } : {}) },
      orderBy: { id: "asc" },
      ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
      take: input.limit + 1
    });
    const page = rows.slice(0, input.limit);
    const audit = await writeAudit(client, {
      action: AUDIT_ACTIONS.PROJECT_ASSET_REFERENCE_READ,
      objectType: AUDIT_OBJECT_TYPES.PROJECT_ASSET_REFERENCE,
      objectId: input.projectId,
      context: { ...input.auditContext, actorId: input.actorId, projectId: input.projectId },
      after: {
        value: { projectId: input.projectId, count: page.length },
        allowedFields: PROJECT_ASSET_AUDIT_FIELDS
      }
    });
    const items = page.map((row) => serializeReference(row, input.canManage));
    return {
      items,
      references: items,
      nextCursor: rows.length > input.limit ? (page.at(-1)?.id ?? null) : null,
      allowedActions: input.canManage ? ["CREATE"] : [],
      auditId: audit.id,
      outboxEventId: null
    };
  });
}

export async function listProjectAssetUsages(input: {
  projectId: string;
  referenceId?: string;
  status?: "ACTIVE" | "RETIRED";
  cursor?: string;
  limit: number;
  actorId: string;
  auditContext: AuditContext;
  canManage: boolean;
}) {
  return inTransaction(undefined, async (client) => {
    const rows = await client.projectAssetUsage.findMany({
      where: {
        projectId: input.projectId,
        ...(input.referenceId ? { referenceId: input.referenceId } : {}),
        ...(input.status ? { status: input.status } : {})
      },
      orderBy: { id: "asc" },
      ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
      take: input.limit + 1
    });
    const page = rows.slice(0, input.limit);
    const audit = await writeAudit(client, {
      action: AUDIT_ACTIONS.PROJECT_ASSET_USAGE_READ,
      objectType: AUDIT_OBJECT_TYPES.PROJECT_ASSET_USAGE,
      objectId: input.referenceId ?? input.projectId,
      context: { ...input.auditContext, actorId: input.actorId, projectId: input.projectId },
      after: {
        value: {
          projectId: input.projectId,
          referenceId: input.referenceId ?? null,
          count: page.length
        },
        allowedFields: PROJECT_ASSET_AUDIT_FIELDS
      }
    });
    const items = page.map((row) => serializeUsage(row, input.canManage));
    return {
      items,
      usages: items,
      nextCursor: rows.length > input.limit ? (page.at(-1)?.id ?? null) : null,
      allowedActions: input.canManage ? ["CREATE"] : [],
      auditId: audit.id,
      outboxEventId: null
    };
  });
}

export async function createProjectAssetReference(
  input: {
    projectId: string;
    assetReleaseId: string;
    assetReleaseVersionId: string;
    projectVersion: number;
    actorId: string;
    reason: string;
    auditContext: AuditContext;
    authorizationActor: AuthorizationActor;
  },
  transaction?: Client
) {
  return inTransaction(transaction, async (client) => {
    const project = await lockProject(client, input.projectId);
    if (!project) throw new ProjectAssetUsageError("PROJECT_NOT_FOUND", "项目不存在。", 404);
    if (project.status === "CLOSED" || project.status === "CANCELED")
      throw new ProjectAssetUsageError("PROJECT_READ_ONLY", "已关闭或取消项目不可引用资产。", 409);
    assertRetireVersion({ expectedVersion: input.projectVersion, actualVersion: project.version });
    const releaseCandidate = await client.assetRelease.findUnique({
      where: { id: input.assetReleaseId },
      select: { technicalAssetId: true }
    });
    if (!releaseCandidate)
      throw new ProjectAssetUsageError(
        "ASSET_RELEASE_VERSION_NOT_FOUND",
        "Release 版本不存在。",
        404
      );
    await lockSourceFacts(client, {
      technicalAssetId: releaseCandidate.technicalAssetId,
      assetReleaseId: input.assetReleaseId,
      assetReleaseVersionId: input.assetReleaseVersionId
    });
    const release = await client.assetRelease.findUnique({
      where: { id: input.assetReleaseId },
      include: { technicalAsset: { include: { rndProject: true } } }
    });
    const version = await client.assetReleaseVersion.findFirst({
      where: {
        id: input.assetReleaseVersionId,
        releaseId: input.assetReleaseId,
        technicalAssetId: release?.technicalAssetId
      },
      include: { release: true }
    });
    if (!release || !version)
      throw new ProjectAssetUsageError(
        "ASSET_RELEASE_VERSION_NOT_FOUND",
        "Release 版本不存在。",
        404
      );
    if (version.status !== "PUBLISHED")
      throw new ProjectAssetUsageError(
        "ASSET_RELEASE_VERSION_NOT_PUBLISHED",
        "只能引用已发布的 Release 版本。",
        409
      );
    if (
      release.technicalAsset.status !== "VALIDATED" ||
      release.technicalAsset.rndProject.status === "CANCELED"
    )
      throw new ProjectAssetUsageError(
        "ASSET_SOURCE_NOT_READY",
        "来源资产项目不可用于项目引用。",
        409
      );
    await assertSourceFilesAvailableAndAuthorized(client, {
      technicalAssetId: release.technicalAssetId,
      assetReleaseVersionId: version.id,
      authorizationActor: input.authorizationActor
    });
    const now = await databaseNow(client);
    const reference = await client.projectAssetReference.create({
      data: {
        projectId: input.projectId,
        technicalAssetId: release.technicalAssetId,
        assetReleaseId: release.id,
        assetReleaseVersionId: version.id,
        releaseCode: release.releaseCode,
        releaseRevision: version.revision,
        snapshotChecksum: version.snapshotChecksum,
        sourceWatermark: version.sourceWatermark,
        createdById: input.actorId,
        createdAt: now,
        updatedAt: now
      }
    });
    const audit = await writeFactAudit(client, {
      action: AUDIT_ACTIONS.PROJECT_ASSET_REFERENCE_CREATED,
      objectType: AUDIT_OBJECT_TYPES.PROJECT_ASSET_REFERENCE,
      objectId: reference.id,
      context: auditContext(input),
      value: valueOf(serializeReference(reference, true)),
      eventType: "project.asset-reference.created",
      aggregateType: "PROJECT_ASSET_REFERENCE"
    });
    return {
      reference: serializeReference(reference, true),
      resourceVersion: reference.version,
      ...audit
    };
  });
}

export async function retireProjectAssetReference(
  input: {
    projectId: string;
    referenceId: string;
    version: number;
    actorId: string;
    reason: string;
    auditContext: AuditContext;
    authorizationActor: AuthorizationActor;
  },
  transaction?: Client
) {
  return inTransaction(transaction, async (client) => {
    const project = await lockProject(client, input.projectId);
    if (!project) throw new ProjectAssetUsageError("PROJECT_NOT_FOUND", "项目不存在。", 404);
    if (project.status === "CLOSED" || project.status === "CANCELED")
      throw new ProjectAssetUsageError(
        "PROJECT_READ_ONLY",
        "已关闭或取消项目不可修改资产引用。",
        409
      );
    const reference = await lockReference(client, input.projectId, input.referenceId);
    if (!reference)
      throw new ProjectAssetUsageError(
        "PROJECT_ASSET_REFERENCE_NOT_FOUND",
        "资产引用不存在。",
        404
      );
    assertRetireVersion({ expectedVersion: input.version, actualVersion: reference.version });
    assertActiveReference(reference.status);
    await lockSourceFacts(client, {
      technicalAssetId: reference.technicalAssetId,
      assetReleaseId: reference.assetReleaseId,
      assetReleaseVersionId: reference.assetReleaseVersionId
    });
    await assertSourceFilesSensitiveReadAuthorized(client, {
      technicalAssetId: reference.technicalAssetId,
      assetReleaseVersionId: reference.assetReleaseVersionId,
      authorizationActor: input.authorizationActor
    });
    const active = await client.projectAssetUsage.count({
      where: { projectId: input.projectId, referenceId: reference.id, status: "ACTIVE" }
    });
    assertReferenceCanRetire({ activeUsageCount: active });
    const now = await databaseNow(client);
    const retired = await client.projectAssetReference.update({
      where: { id: reference.id },
      data: {
        status: "RETIRED",
        version: { increment: 1 },
        retiredById: input.actorId,
        retiredAt: now,
        retireReason: text(input.reason, "reason")
      }
    });
    const audit = await writeFactAudit(client, {
      action: AUDIT_ACTIONS.PROJECT_ASSET_REFERENCE_RETIRED,
      objectType: AUDIT_OBJECT_TYPES.PROJECT_ASSET_REFERENCE,
      objectId: retired.id,
      context: auditContext(input),
      value: valueOf(serializeReference(retired, true)),
      eventType: "project.asset-reference.retired",
      aggregateType: "PROJECT_ASSET_REFERENCE"
    });
    return {
      reference: serializeReference(retired, true),
      resourceVersion: retired.version,
      ...audit
    };
  });
}

export async function createProjectAssetUsage(
  input: {
    projectId: string;
    referenceId: string;
    usageKey: string;
    referenceVersion: number;
    componentSnapshotId: string;
    quantity: string;
    configuration: unknown;
    scopeType: string;
    scopeId: string;
    deliveryUnitId?: string | null;
    moduleId?: string | null;
    actorId: string;
    reason: string;
    auditContext: AuditContext;
    authorizationActor: AuthorizationActor;
  },
  transaction?: Client
) {
  return inTransaction(transaction, async (client) => {
    const project = await lockProject(client, input.projectId);
    if (!project) throw new ProjectAssetUsageError("PROJECT_NOT_FOUND", "项目不存在。", 404);
    if (project.status === "CLOSED" || project.status === "CANCELED")
      throw new ProjectAssetUsageError(
        "PROJECT_READ_ONLY",
        "已关闭或取消项目不可记录实际使用。",
        409
      );
    const reference = await lockReference(client, input.projectId, input.referenceId);
    if (!reference)
      throw new ProjectAssetUsageError(
        "PROJECT_ASSET_REFERENCE_NOT_FOUND",
        "资产引用不存在。",
        404
      );
    assertRetireVersion({
      expectedVersion: input.referenceVersion,
      actualVersion: reference.version
    });
    assertActiveReference(reference.status);
    await lockSourceFacts(client, {
      technicalAssetId: reference.technicalAssetId,
      assetReleaseId: reference.assetReleaseId,
      assetReleaseVersionId: reference.assetReleaseVersionId,
      componentSnapshotId: input.componentSnapshotId
    });
    const releaseVersion = await client.assetReleaseVersion.findFirst({
      where: {
        id: reference.assetReleaseVersionId,
        releaseId: reference.assetReleaseId,
        technicalAssetId: reference.technicalAssetId
      },
      include: { technicalAsset: { include: { rndProject: true } } }
    });
    if (
      !releaseVersion ||
      releaseVersion.status !== "PUBLISHED" ||
      releaseVersion.technicalAsset.status !== "VALIDATED" ||
      releaseVersion.technicalAsset.rndProject.status === "CANCELED"
    )
      throw new ProjectAssetUsageError(
        "ASSET_RELEASE_VERSION_NOT_PUBLISHED",
        "引用的精确 Release 版本当前不可用。",
        409
      );
    await assertSourceFilesAvailableAndAuthorized(client, {
      technicalAssetId: reference.technicalAssetId,
      assetReleaseVersionId: reference.assetReleaseVersionId,
      authorizationActor: input.authorizationActor
    });
    const quantity = parseProjectAssetQuantity(input.quantity);
    const configuration = canonicalProjectAssetConfiguration(input.configuration);
    const component = await client.assetComponentSnapshot.findFirst({
      where: {
        id: input.componentSnapshotId,
        releaseVersionId: reference.assetReleaseVersionId,
        technicalAssetId: reference.technicalAssetId
      }
    });
    if (!component)
      throw new ProjectAssetUsageError(
        "PROJECT_ASSET_COMPONENT_NOT_FOUND",
        "组件快照不属于引用的精确 Release 版本。",
        409
      );
    assertProjectAssetUsageScope({
      projectId: input.projectId,
      scopeType: input.scopeType,
      scopeId: input.scopeId,
      deliveryUnitId: input.deliveryUnitId,
      moduleId: input.moduleId
    });
    await lockUsageScope(client, {
      projectId: input.projectId,
      deliveryUnitId: input.deliveryUnitId,
      moduleId: input.moduleId
    });
    if (input.deliveryUnitId) {
      const deliveryUnit = await client.deliveryUnit.findFirst({
        where: { id: input.deliveryUnitId, projectId: input.projectId },
        select: { status: true }
      });
      if (!deliveryUnit || deliveryUnit.status !== "ACTIVE")
        throw new ProjectAssetUsageError(
          "PROJECT_ASSET_SCOPE_NOT_ACTIVE",
          "交付单元不存在、越权或已停用。",
          409
        );
    }
    if (input.moduleId) {
      const projectModule = await client.projectModule.findFirst({
        where: {
          id: input.moduleId,
          projectId: input.projectId,
          deliveryUnitId: input.deliveryUnitId ?? undefined
        },
        select: { status: true }
      });
      if (!projectModule || projectModule.status !== "ACTIVE")
        throw new ProjectAssetUsageError(
          "PROJECT_ASSET_SCOPE_NOT_ACTIVE",
          "项目模块不存在、越权或已停用。",
          409
        );
    }
    const now = await databaseNow(client);
    const usage = await client.projectAssetUsage.create({
      data: {
        usageKey: text(input.usageKey, "usageKey"),
        projectId: input.projectId,
        referenceId: reference.id,
        technicalAssetId: reference.technicalAssetId,
        assetReleaseId: reference.assetReleaseId,
        assetReleaseVersionId: reference.assetReleaseVersionId,
        componentSnapshotId: component.id,
        releaseRevision: reference.releaseRevision,
        snapshotChecksum: reference.snapshotChecksum,
        sourceWatermark: reference.sourceWatermark,
        quantity: new Prisma.Decimal(quantity),
        configurationJson: configuration.value as Prisma.InputJsonValue,
        scopeType: input.scopeType as never,
        scopeId: input.scopeId,
        deliveryUnitId: input.deliveryUnitId ?? null,
        moduleId: input.moduleId ?? null,
        createdById: input.actorId,
        createdAt: now,
        updatedAt: now
      }
    });
    const audit = await writeFactAudit(client, {
      action: AUDIT_ACTIONS.PROJECT_ASSET_USAGE_CREATED,
      objectType: AUDIT_OBJECT_TYPES.PROJECT_ASSET_USAGE,
      objectId: usage.id,
      context: auditContext(input),
      value: valueOf(serializeUsage(usage, true)),
      eventType: "project.asset-usage.recorded",
      aggregateType: "PROJECT_ASSET_USAGE"
    });
    return { usage: serializeUsage(usage, true), resourceVersion: usage.version, ...audit };
  });
}

export async function retireProjectAssetUsage(
  input: {
    projectId: string;
    usageId: string;
    version: number;
    actorId: string;
    reason: string;
    auditContext: AuditContext;
    authorizationActor: AuthorizationActor;
  },
  transaction?: Client
) {
  return inTransaction(transaction, async (client) => {
    const project = await lockProject(client, input.projectId);
    if (!project) throw new ProjectAssetUsageError("PROJECT_NOT_FOUND", "项目不存在。", 404);
    if (project.status === "CLOSED" || project.status === "CANCELED")
      throw new ProjectAssetUsageError(
        "PROJECT_READ_ONLY",
        "已关闭或取消项目不可退役实际使用。",
        409
      );
    const identified = await client.projectAssetUsage.findFirst({
      where: { id: input.usageId, projectId: input.projectId },
      select: { referenceId: true }
    });
    if (!identified)
      throw new ProjectAssetUsageError(
        "PROJECT_ASSET_USAGE_NOT_FOUND",
        "实际使用记录不存在。",
        404
      );
    const reference = await lockReference(client, input.projectId, identified.referenceId);
    if (!reference)
      throw new ProjectAssetUsageError(
        "PROJECT_ASSET_REFERENCE_NOT_FOUND",
        "资产引用不存在。",
        404
      );
    const usage = await lockUsage(client, input.projectId, input.usageId);
    if (!usage)
      throw new ProjectAssetUsageError(
        "PROJECT_ASSET_USAGE_NOT_FOUND",
        "实际使用记录不存在。",
        404
      );
    assertRetireVersion({ expectedVersion: input.version, actualVersion: usage.version });
    assertActiveProjectAssetUsage(usage.status);
    await lockSourceFacts(client, {
      technicalAssetId: reference.technicalAssetId,
      assetReleaseId: reference.assetReleaseId,
      assetReleaseVersionId: reference.assetReleaseVersionId
    });
    await assertSourceFilesSensitiveReadAuthorized(client, {
      technicalAssetId: reference.technicalAssetId,
      assetReleaseVersionId: reference.assetReleaseVersionId,
      authorizationActor: input.authorizationActor
    });
    const now = await databaseNow(client);
    const retired = await client.projectAssetUsage.update({
      where: { id: usage.id },
      data: {
        status: "RETIRED",
        version: { increment: 1 },
        retiredById: input.actorId,
        retiredAt: now,
        retireReason: text(input.reason, "reason")
      }
    });
    const audit = await writeFactAudit(client, {
      action: AUDIT_ACTIONS.PROJECT_ASSET_USAGE_RETIRED,
      objectType: AUDIT_OBJECT_TYPES.PROJECT_ASSET_USAGE,
      objectId: retired.id,
      context: auditContext(input),
      value: valueOf(serializeUsage(retired, true)),
      eventType: "project.asset-usage.retired",
      aggregateType: "PROJECT_ASSET_USAGE"
    });
    return { usage: serializeUsage(retired, true), resourceVersion: retired.version, ...audit };
  });
}

export async function createProjectAssetDerivation(
  input: {
    projectId: string;
    usageId: string;
    usageVersion: number;
    targetType: "CONTROLLED_DOCUMENT_VERSION" | "MECHANICAL_DRAWING_VERSION";
    targetControlledDocumentVersionId: string;
    targetMechanicalDrawingId?: string | null;
    targetSourceFileId: string;
    targetSourceFileSha256: string;
    targetDocumentVersion: number;
    targetDocumentVersionStatus: "DRAFT" | "PUBLISHED" | "SUPERSEDED";
    targetFileStatus: "UPLOADING" | "PENDING_SCAN" | "AVAILABLE" | "QUARANTINED" | "FAILED";
    actorId: string;
    reason: string;
    auditContext: AuditContext;
    authorizationActor: AuthorizationActor;
  },
  transaction?: Client
) {
  return inTransaction(transaction, async (client) => {
    const project = await lockProject(client, input.projectId);
    if (!project) throw new ProjectAssetUsageError("PROJECT_NOT_FOUND", "项目不存在。", 404);
    if (project.status === "CLOSED" || project.status === "CANCELED")
      throw new ProjectAssetUsageError(
        "PROJECT_READ_ONLY",
        "已关闭或取消项目不可创建派生事实。",
        409
      );
    const identified = await client.projectAssetUsage.findFirst({
      where: { id: input.usageId, projectId: input.projectId },
      select: { referenceId: true }
    });
    if (!identified)
      throw new ProjectAssetUsageError(
        "PROJECT_ASSET_USAGE_NOT_FOUND",
        "实际使用记录不存在。",
        404
      );
    const reference = await lockReference(client, input.projectId, identified.referenceId);
    if (!reference)
      throw new ProjectAssetUsageError(
        "PROJECT_ASSET_REFERENCE_NOT_FOUND",
        "资产引用不存在。",
        404
      );
    const usage = await lockUsage(client, input.projectId, input.usageId);
    if (!usage)
      throw new ProjectAssetUsageError(
        "PROJECT_ASSET_USAGE_NOT_FOUND",
        "实际使用记录不存在。",
        404
      );
    assertRetireVersion({ expectedVersion: input.usageVersion, actualVersion: usage.version });
    assertActiveReference(reference.status);
    assertActiveProjectAssetUsage(usage.status);
    await lockSourceFacts(client, {
      technicalAssetId: usage.technicalAssetId,
      assetReleaseId: usage.assetReleaseId,
      assetReleaseVersionId: usage.assetReleaseVersionId,
      componentSnapshotId: usage.componentSnapshotId
    });
    const releaseVersion = await client.assetReleaseVersion.findFirst({
      where: {
        id: usage.assetReleaseVersionId,
        releaseId: usage.assetReleaseId,
        technicalAssetId: usage.technicalAssetId
      },
      include: { technicalAsset: { include: { rndProject: true } } }
    });
    const component = await client.assetComponentSnapshot.findFirst({
      where: {
        id: usage.componentSnapshotId,
        releaseVersionId: usage.assetReleaseVersionId,
        technicalAssetId: usage.technicalAssetId
      }
    });
    if (
      !releaseVersion ||
      !component ||
      releaseVersion.status !== "PUBLISHED" ||
      releaseVersion.technicalAsset.status !== "VALIDATED" ||
      releaseVersion.technicalAsset.rndProject.status === "CANCELED"
    )
      throw new ProjectAssetUsageError(
        "ASSET_RELEASE_VERSION_NOT_PUBLISHED",
        "派生来源的精确 Release 版本当前不可用。",
        409
      );
    await assertSourceFilesAvailableAndAuthorized(client, {
      technicalAssetId: usage.technicalAssetId,
      assetReleaseVersionId: usage.assetReleaseVersionId,
      authorizationActor: input.authorizationActor
    });
    await lockDerivationTarget(client, {
      projectId: input.projectId,
      documentVersionId: input.targetControlledDocumentVersionId,
      fileId: input.targetSourceFileId,
      drawingId: input.targetMechanicalDrawingId
    });
    const target = await client.controlledDocumentVersion.findFirst({
      where: { id: input.targetControlledDocumentVersionId, projectId: input.projectId },
      include: { document: { select: { id: true, status: true } } }
    });
    const file = await client.fileObject.findFirst({
      where: { id: input.targetSourceFileId, projectId: input.projectId },
      select: fileAuthorizationSelect(input.authorizationActor.id)
    });
    if (
      !target ||
      target.document.status !== "ACTIVE" ||
      target.status === "VOIDED" ||
      target.version !== input.targetDocumentVersion ||
      target.status !== input.targetDocumentVersionStatus ||
      !file ||
      file.status !== "AVAILABLE" ||
      file.status !== input.targetFileStatus ||
      file.sha256 !== input.targetSourceFileSha256
    )
      throw new ProjectAssetUsageError(
        "PROJECT_ASSET_DERIVATION_TARGET_INVALID",
        "派生目标不是项目内可用的精确文档/文件事实。",
        409
      );
    assertSensitiveFileReadAuthorized(file, input.authorizationActor);
    const drawingId = input.targetMechanicalDrawingId ?? null;
    if (input.targetType === "CONTROLLED_DOCUMENT_VERSION" && drawingId)
      throw new ProjectAssetUsageError(
        "PROJECT_ASSET_DERIVATION_TARGET_INVALID",
        "ControlledDocumentVersion 目标不能带图纸。",
        422
      );
    if (input.targetType === "MECHANICAL_DRAWING_VERSION" && !drawingId)
      throw new ProjectAssetUsageError(
        "PROJECT_ASSET_DERIVATION_TARGET_INVALID",
        "机械图纸版本目标必须带图纸。",
        422
      );
    if (drawingId) {
      const drawing = await client.mechanicalDrawing.findFirst({
        where: { id: drawingId, projectId: input.projectId },
        select: { documentId: true }
      });
      const drawingFile = await client.mechanicalDrawingVersionFile.findFirst({
        where: {
          projectId: input.projectId,
          drawingId,
          documentVersionId: target.id,
          fileId: file.id,
          fileSha256: file.sha256 ?? ""
        }
      });
      if (!drawing || drawing.documentId !== target.documentId || !drawingFile)
        throw new ProjectAssetUsageError(
          "PROJECT_ASSET_DERIVATION_TARGET_INVALID",
          "图纸与目标文档版本/文件不一致。",
          409
        );
    }
    const targetBindingKey = `${input.targetType}:${target.id}:${drawingId ?? "-"}:${file.id}`;
    const now = await databaseNow(client);
    const derivation = await client.projectAssetDerivation.create({
      data: {
        projectId: input.projectId,
        sourceReferenceId: reference.id,
        sourceUsageId: usage.id,
        sourceTechnicalAssetId: usage.technicalAssetId,
        sourceAssetReleaseId: usage.assetReleaseId,
        sourceAssetReleaseVersionId: usage.assetReleaseVersionId,
        sourceComponentSnapshotId: usage.componentSnapshotId,
        sourceReleaseRevision: usage.releaseRevision,
        sourceSnapshotChecksum: usage.snapshotChecksum,
        sourceWatermark: usage.sourceWatermark,
        targetControlledDocumentVersionId: target.id,
        targetMechanicalDrawingId: drawingId,
        targetFileId: file.id,
        targetSourceFileSha256: file.sha256!,
        targetType: input.targetType,
        targetDocumentVersion: target.version,
        targetDocumentVersionStatus: target.status,
        targetFileStatus: file.status,
        targetBindingKey,
        reason: text(input.reason, "reason"),
        createdById: input.actorId,
        createdAt: now
      }
    });
    const audit = await writeFactAudit(client, {
      action: AUDIT_ACTIONS.PROJECT_ASSET_DERIVATION_CREATED,
      objectType: AUDIT_OBJECT_TYPES.PROJECT_ASSET_DERIVATION,
      objectId: derivation.id,
      context: auditContext(input),
      value: valueOf({
        derivationId: derivation.id,
        projectId: derivation.projectId,
        sourceUsageId: derivation.sourceUsageId,
        targetType: derivation.targetType,
        targetControlledDocumentVersionId: derivation.targetControlledDocumentVersionId,
        targetMechanicalDrawingId: derivation.targetMechanicalDrawingId,
        targetSourceFileId: derivation.targetFileId,
        targetSourceFileSha256: derivation.targetSourceFileSha256,
        targetDocumentVersion: derivation.targetDocumentVersion,
        targetDocumentVersionStatus: derivation.targetDocumentVersionStatus,
        targetFileStatus: derivation.targetFileStatus
      }),
      eventType: "project.asset-derivation.created",
      aggregateType: "PROJECT_ASSET_DERIVATION"
    });
    return { derivation: serializeDerivation(derivation), resourceVersion: 1, ...audit };
  });
}

export async function listProjectAssetDerivations(input: {
  projectId: string;
  usageId?: string;
  actorId: string;
  auditContext: AuditContext;
  canManage: boolean;
}) {
  return inTransaction(undefined, async (client) => {
    const rows = await client.projectAssetDerivation.findMany({
      where: {
        projectId: input.projectId,
        ...(input.usageId ? { sourceUsageId: input.usageId } : {})
      },
      orderBy: { id: "asc" }
    });
    const audit = await writeAudit(client, {
      action: AUDIT_ACTIONS.PROJECT_ASSET_DERIVATION_READ,
      objectType: AUDIT_OBJECT_TYPES.PROJECT_ASSET_DERIVATION,
      objectId: input.usageId ?? input.projectId,
      context: { ...input.auditContext, actorId: input.actorId, projectId: input.projectId },
      after: {
        value: { projectId: input.projectId, usageId: input.usageId ?? null, count: rows.length },
        allowedFields: PROJECT_ASSET_AUDIT_FIELDS
      }
    });
    const items = rows.map(serializeDerivation);
    return {
      items,
      derivations: items,
      nextCursor: null,
      allowedActions: input.canManage ? ["CREATE"] : [],
      auditId: audit.id,
      outboxEventId: null
    };
  });
}

export async function getAssetUsageSnapshotForAcceptance(
  input: {
    projectId: string;
    acceptanceType: "FAT" | "SAT";
    scopeType: "PROJECT" | "DELIVERY_UNIT" | "MACHINE" | "MODULE";
    scopeId: string;
    frozenAt: Date;
    readAudit?: { actorId: string; auditContext: AuditContext };
  },
  transaction?: Client
) {
  return inTransaction(transaction, async (client) => {
    if (input.scopeType === "PROJECT" && input.scopeId !== input.projectId)
      throw new ProjectAssetUsageError(
        "PROJECT_ASSET_SNAPSHOT_SCOPE_INVALID",
        "PROJECT 范围必须使用当前项目 ID。",
        404
      );
    if (input.scopeType === "DELIVERY_UNIT" || input.scopeType === "MACHINE") {
      const unit = await client.deliveryUnit.findFirst({
        where: { id: input.scopeId, projectId: input.projectId },
        select: { unitType: true, status: true }
      });
      if (
        !unit ||
        unit.status !== "ACTIVE" ||
        (input.scopeType === "MACHINE" && unit.unitType !== "MACHINE")
      )
        throw new ProjectAssetUsageError(
          "PROJECT_ASSET_SNAPSHOT_SCOPE_INVALID",
          "验收范围不属于当前项目或未处于活动状态。",
          404
        );
    }
    if (input.scopeType === "MODULE") {
      const projectModule = await client.projectModule.findFirst({
        where: { id: input.scopeId, projectId: input.projectId },
        select: {
          deliveryUnitId: true,
          status: true,
          deliveryUnit: { select: { projectId: true, status: true } }
        }
      });
      if (
        !projectModule ||
        projectModule.status !== "ACTIVE" ||
        projectModule.deliveryUnit.projectId !== input.projectId ||
        projectModule.deliveryUnit.status !== "ACTIVE"
      )
        throw new ProjectAssetUsageError(
          "PROJECT_ASSET_SNAPSHOT_SCOPE_INVALID",
          "模块范围不属于当前项目或未处于活动状态。",
          404
        );
    }
    const rows = await client.projectAssetUsage.findMany({
      where: {
        projectId: input.projectId,
        createdAt: { lte: input.frozenAt },
        OR: [{ status: "ACTIVE" }, { status: "RETIRED", retiredAt: { gt: input.frozenAt } }]
      },
      orderBy: [{ usageKey: "asc" }, { id: "asc" }]
    });
    const projectModule =
      input.scopeType === "MODULE"
        ? await client.projectModule.findFirst({
            where: { id: input.scopeId, projectId: input.projectId },
            select: { deliveryUnitId: true }
          })
        : null;
    const scoped = selectAssetUsageSnapshotRows({
      rows,
      projectId: input.projectId,
      scopeType: input.scopeType,
      scopeId: input.scopeId,
      parentDeliveryUnitId: projectModule?.deliveryUnitId
    });
    const entries = scoped.map((row) => {
      const version = frozenUsageVersion(row, input.frozenAt);
      return {
        usageId: row.id,
        version,
        usageVersion: version,
        usageKey: row.usageKey,
        quantity: row.quantity.toString(),
        purpose: (row.configurationJson as { purpose?: unknown }).purpose ?? null,
        configuration: row.configurationJson,
        scopeType: row.scopeType,
        scopeId: row.scopeId,
        deliveryUnitId: row.deliveryUnitId,
        moduleId: row.moduleId,
        referenceId: row.referenceId,
        technicalAssetId: row.technicalAssetId,
        assetReleaseId: row.assetReleaseId,
        assetReleaseVersionId: row.assetReleaseVersionId,
        revision: row.releaseRevision,
        snapshotChecksum: row.snapshotChecksum,
        sourceWatermark: row.sourceWatermark,
        componentSnapshotId: row.componentSnapshotId
      };
    });
    const canonical = canonicalJson({
      acceptanceType: input.acceptanceType,
      projectId: input.projectId,
      scopeType: input.scopeType,
      scopeId: input.scopeId,
      frozenAt: input.frozenAt.toISOString(),
      entries
    });
    const snapshot = canonical.value;
    const usageSnapshotChecksum = createHash("sha256")
      .update(canonical.serialized, "utf8")
      .digest("hex");
    const audit = input.readAudit
      ? await writeAudit(client, {
          action: AUDIT_ACTIONS.PROJECT_ASSET_USAGE_SNAPSHOT_READ,
          objectType: AUDIT_OBJECT_TYPES.PROJECT_ASSET_USAGE_SNAPSHOT,
          objectId: input.scopeId,
          context: {
            ...input.readAudit.auditContext,
            actorId: input.readAudit.actorId,
            projectId: input.projectId
          },
          after: {
            value: {
              projectId: input.projectId,
              acceptanceType: input.acceptanceType,
              scopeType: input.scopeType,
              scopeId: input.scopeId,
              frozenAt: input.frozenAt.toISOString(),
              usageSnapshotChecksum,
              returnedCount: entries.length
            },
            allowedFields: PROJECT_ASSET_AUDIT_FIELDS
          }
        })
      : null;
    return {
      frozenAt: input.frozenAt.toISOString(),
      snapshot,
      usageSnapshotChecksum,
      auditId: audit?.id ?? null,
      outboxEventId: null
    };
  });
}
