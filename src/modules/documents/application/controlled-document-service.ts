import { Prisma } from "@prisma/client";

import { decideAuthorization, type AuthorizationActor } from "@/lib/auth/authorize";
import { PERMISSIONS } from "@/lib/auth/permissions";
import type { ProjectAuthorizationTarget } from "@/lib/auth/repository";
import { db, inTransaction } from "@/lib/db";
import type { AuditContext } from "@/modules/audit/contracts/audit";
import {
  AUDIT_ACTIONS,
  AUDIT_OBJECT_TYPES,
  CONTROLLED_DOCUMENT_AUDIT_FIELDS,
  DOCUMENT_REVIEW_AUDIT_FIELDS,
  DOCUMENT_VERSION_RELATION_AUDIT_FIELDS
} from "@/modules/audit/domain/vocabulary";
import { writeAudit } from "@/modules/audit/infrastructure/write-audit";
import { payloadHash } from "@/modules/governance/domain/idempotency";
import { appendOutboxEvent } from "@/modules/governance/infrastructure/outbox";

import { recordFileAccessDenied, recordSensitiveFileRead } from "./file-download-service";

import {
  assertDocumentVersionTransition,
  canCreateDraftVersion,
  canVoidControlledDocument,
  ControlledDocumentError,
  validateDocumentCode,
  validateDocumentTitle,
  validateDocumentVersionSource,
  type ControlledDocumentVersionStatus
} from "../domain/controlled-document";
import {
  assertRequiredReviewClosure,
  assertReviewDecision,
  DocumentReviewError,
  validateDocumentVersionRelationTarget,
  type DocumentReviewStatus,
  type DocumentVersionRelationTargetType
} from "../domain/document-review";

const sourceFileSelect = {
  id: true,
  projectId: true,
  uploadedById: true,
  sensitivity: true
} satisfies Prisma.FileObjectSelect;

const documentVersionInclude = {
  sourceFile: { select: sourceFileSelect },
  reviews: {
    orderBy: { requestedAt: "asc" },
    include: {
      comments: {
        orderBy: { createdAt: "asc" },
        include: { resolution: true }
      }
    }
  },
  relations: { orderBy: { createdAt: "asc" } }
} satisfies Prisma.ControlledDocumentVersionInclude;

const documentInclude = {
  currentPublishedVersion: { include: documentVersionInclude },
  versions: {
    orderBy: { version: "asc" },
    include: documentVersionInclude
  }
} satisfies Prisma.ControlledDocumentInclude;

type DocumentFact = Prisma.ControlledDocumentGetPayload<{ include: typeof documentInclude }>;
type DocumentSourceFile = NonNullable<DocumentFact["versions"][number]["sourceFile"]>;
type DocumentVersionAuditFact = Omit<
  DocumentFact["versions"][number],
  "sourceFile" | "reviews" | "relations"
>;

type SourceFileAccess = {
  actor: AuthorizationActor;
  project: ProjectAuthorizationTarget;
  auditContext?: AuditContext;
  method?: string;
  path?: string;
};

function commandReason(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > 1024) {
    throw new ControlledDocumentError("REASON_REQUIRED", "操作原因必须是 1 到 1024 个字符。", 422);
  }
  return value.trim();
}

function positiveVersion(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new ControlledDocumentError("INVALID_VERSION", "version 必须是正整数。", 422);
  }
  return value as number;
}

async function databaseNow(transaction: Prisma.TransactionClient): Promise<Date> {
  const [clock] = await transaction.$queryRaw<Array<{ now: Date }>>`
    SELECT CURRENT_TIMESTAMP AS "now"
  `;
  if (!clock) throw new Error("无法读取数据库时间。");
  return clock.now;
}

async function lockDocument(
  transaction: Prisma.TransactionClient,
  projectId: string,
  documentId: string
) {
  await transaction.$queryRaw`
    SELECT "id" FROM "controlled_documents"
    WHERE "id" = ${documentId} AND "project_id" = ${projectId}
    FOR UPDATE
  `;
  return transaction.controlledDocument.findFirst({
    where: { id: documentId, projectId },
    include: documentInclude
  });
}

async function resolveSourceFile(
  transaction: Prisma.TransactionClient,
  projectId: string,
  sourceFileId: string
) {
  const file = await transaction.fileObject.findFirst({
    where: { id: sourceFileId, projectId },
    select: {
      id: true,
      projectId: true,
      uploadedById: true,
      status: true,
      sensitivity: true,
      sha256: true,
      verifiedMimeType: true,
      verifiedSize: true
    }
  });
  if (!file) {
    throw new ControlledDocumentError("DOCUMENT_FILE_NOT_FOUND", "文档源文件不存在。", 404);
  }
  return {
    id: file.id,
    projectId: file.projectId,
    uploadedById: file.uploadedById,
    sensitivity: file.sensitivity,
    ...validateDocumentVersionSource({
      projectId,
      fileProjectId: file.projectId,
      fileStatus: file.status,
      sha256: file.sha256,
      verifiedMimeType: file.verifiedMimeType,
      verifiedSize: file.verifiedSize
    })
  };
}

function sensitiveFileDecision(source: DocumentSourceFile, access?: SourceFileAccess) {
  if (!access) return null;
  return decideAuthorization(access.actor, PERMISSIONS.SENSITIVE_FILE_READ, {
    projectId: access.project.id,
    resourceDepartmentId: access.project.departmentId,
    resourceOwnerId: source.uploadedById,
    memberRoles: access.project.memberRoles
  });
}

async function assertSensitiveSourceFileAccess(
  source: DocumentSourceFile,
  access: SourceFileAccess | undefined,
  recordAllowedRead = false
) {
  if (source.sensitivity !== "RESTRICTED") return;

  const decision = sensitiveFileDecision(source, access);
  if (!decision?.allowed) {
    if (access?.auditContext && access.method && access.path) {
      await recordFileAccessDenied({
        fileId: source.id,
        context: access.auditContext,
        permission: PERMISSIONS.SENSITIVE_FILE_READ,
        method: access.method,
        path: access.path,
        reason: decision?.reason ?? "PERMISSION_NOT_GRANTED"
      });
    }
    throw new ControlledDocumentError(
      "SENSITIVE_FILE_READ_REQUIRED",
      "当前角色无权读取或引用严格受限文件。",
      403
    );
  }

  if (recordAllowedRead && access && access.auditContext && access.method && access.path) {
    await recordSensitiveFileRead({
      file: source,
      context: access.auditContext,
      method: access.method,
      path: access.path
    });
  }
}

async function assertSensitiveDocumentReadAccess(
  document: DocumentFact,
  access?: SourceFileAccess
) {
  const sources = new Map<string, DocumentSourceFile>(
    document.versions.map((version) => [version.sourceFile.id, version.sourceFile] as const)
  );
  for (const source of sources.values()) {
    await assertSensitiveSourceFileAccess(source, access, true);
  }
}

type ReviewFact = DocumentFact["versions"][number]["reviews"][number];
type RelationFact = DocumentFact["versions"][number]["relations"][number];

function serializeReview(value: ReviewFact) {
  return {
    id: value.id,
    documentVersionId: value.documentVersionId,
    reviewerId: value.reviewerId,
    required: value.required,
    status: value.status,
    version: value.version,
    requestedById: value.requestedById,
    requestedAt: value.requestedAt.toISOString(),
    decidedById: value.decidedById,
    decidedAt: value.decidedAt?.toISOString() ?? null,
    comments: value.comments.map((comment) => ({
      id: comment.id,
      body: comment.body,
      required: comment.required,
      createdById: comment.createdById,
      createdAt: comment.createdAt.toISOString(),
      resolution: comment.resolution
        ? {
            id: comment.resolution.id,
            resolution: comment.resolution.resolution,
            resolvedById: comment.resolution.resolvedById,
            resolvedAt: comment.resolution.resolvedAt.toISOString()
          }
        : null
    }))
  };
}

function serializeRelation(value: RelationFact) {
  return {
    id: value.id,
    documentVersionId: value.documentVersionId,
    targetType: value.targetType,
    targetId: value.targetId,
    status: value.status,
    version: value.version,
    createdById: value.createdById,
    createdAt: value.createdAt.toISOString(),
    voidedById: value.voidedById,
    voidedAt: value.voidedAt?.toISOString() ?? null,
    voidReason: value.voidReason
  };
}

function serializeVersion(value: DocumentFact["versions"][number]) {
  return {
    id: value.id,
    documentId: value.documentId,
    projectId: value.projectId,
    version: value.version,
    status: value.status,
    sourceFileId: value.sourceFileId,
    sourceFileSha256: value.sourceFileSha256,
    sourceMimeType: value.sourceMimeType,
    sourceFileSize: Number(value.sourceFileSize),
    createdById: value.createdById,
    publishedById: value.publishedById,
    publishedAt: value.publishedAt?.toISOString() ?? null,
    voidedById: value.voidedById,
    voidedAt: value.voidedAt?.toISOString() ?? null,
    voidReason: value.voidReason,
    createdAt: value.createdAt.toISOString(),
    reviews: value.reviews.map(serializeReview),
    relations: value.relations.map(serializeRelation),
    allowedActions:
      value.status === "DRAFT"
        ? ["PUBLISH", "REQUEST_REVIEW", "RELATE"]
        : value.status === "PUBLISHED"
          ? ["RELATE"]
          : []
  };
}

function serializeDocument(value: DocumentFact) {
  return {
    id: value.id,
    projectId: value.projectId,
    code: value.code,
    title: value.title,
    status: value.status,
    currentPublishedVersionId: value.currentPublishedVersionId,
    currentPublishedVersion: value.currentPublishedVersion
      ? serializeVersion(value.currentPublishedVersion)
      : null,
    version: value.version,
    createdById: value.createdById,
    voidedById: value.voidedById,
    voidedAt: value.voidedAt?.toISOString() ?? null,
    voidReason: value.voidReason,
    createdAt: value.createdAt.toISOString(),
    updatedAt: value.updatedAt.toISOString(),
    versions: value.versions.map(serializeVersion),
    resourceVersion: value.version,
    allowedActions: value.status === "ACTIVE" ? ["CREATE_DRAFT", "VOID"] : []
  };
}

function auditValue(document: DocumentFact, version?: DocumentVersionAuditFact) {
  const current = version ?? document.currentPublishedVersion;
  return {
    projectId: document.projectId,
    documentId: document.id,
    documentCode: document.code,
    documentTitle: document.title,
    documentStatus: document.status,
    documentVersionId: current?.id ?? null,
    documentVersion: current?.version ?? null,
    documentVersionStatus: current?.status ?? null,
    sourceFileId: current?.sourceFileId ?? null,
    sourceFileSha256: current?.sourceFileSha256 ?? null,
    sourceMimeType: current?.sourceMimeType ?? null,
    sourceFileSize: current ? Number(current.sourceFileSize) : null,
    currentPublishedVersionId: document.currentPublishedVersionId,
    version: document.version
  };
}

function commandAuditContext(
  input: { actorId: string; auditContext: AuditContext },
  project: { id: string; departmentId: string | null },
  reason: string
): AuditContext {
  return {
    ...input.auditContext,
    actorId: input.actorId,
    projectId: project.id,
    departmentId: project.departmentId,
    reason
  };
}

function mapDatabaseError(error: unknown): never {
  if (error instanceof ControlledDocumentError) throw error;
  if (error instanceof DocumentReviewError) throw error;
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
    throw new ControlledDocumentError(
      "DOCUMENT_CONFLICT",
      "文档编号或版本已被并发命令占用，请刷新后重试。"
    );
  }
  throw error;
}

function assertDocumentActive(document: { status: string }) {
  if (!canCreateDraftVersion(document.status as "ACTIVE" | "VOIDED")) {
    throw new ControlledDocumentError("DOCUMENT_VOIDED", "已作废文档不能创建或发布版本。");
  }
}

export async function listControlledDocuments(input: {
  projectId: string;
  status?: "ACTIVE" | "VOIDED";
  cursor?: string;
  limit: number;
  sourceFileAccess?: SourceFileAccess;
}) {
  const documents = await db.controlledDocument.findMany({
    where: { projectId: input.projectId, ...(input.status ? { status: input.status } : {}) },
    include: documentInclude,
    orderBy: { id: "asc" },
    ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
    take: input.limit + 1
  });
  const hasMore = documents.length > input.limit;
  const page = hasMore ? documents.slice(0, input.limit) : documents;
  const accessibleDocuments: DocumentFact[] = [];
  for (const document of page) {
    try {
      await assertSensitiveDocumentReadAccess(document, input.sourceFileAccess);
      accessibleDocuments.push(document);
    } catch (error) {
      if (
        !(error instanceof ControlledDocumentError) ||
        error.code !== "SENSITIVE_FILE_READ_REQUIRED"
      ) {
        throw error;
      }
    }
  }
  return {
    documents: accessibleDocuments.map(serializeDocument),
    nextCursor: hasMore ? (page.at(-1)?.id ?? null) : null
  };
}

export async function getControlledDocument(input: {
  projectId: string;
  documentId: string;
  sourceFileAccess?: SourceFileAccess;
}) {
  const document = await db.controlledDocument.findFirst({
    where: { id: input.documentId, projectId: input.projectId },
    include: documentInclude
  });
  if (!document) {
    throw new ControlledDocumentError("CONTROLLED_DOCUMENT_NOT_FOUND", "受控文档不存在。", 404);
  }
  await assertSensitiveDocumentReadAccess(document, input.sourceFileAccess);
  return { document: serializeDocument(document) };
}

export async function createControlledDocument(
  input: {
    projectId: string;
    code: unknown;
    title: unknown;
    sourceFileId: string;
    reason: unknown;
    actorId: string;
    auditContext: AuditContext;
    sourceFileAccess?: SourceFileAccess;
  },
  transaction?: Prisma.TransactionClient
) {
  const code = validateDocumentCode(input.code);
  const title = validateDocumentTitle(input.title);
  const reason = commandReason(input.reason);
  try {
    return await inTransaction(transaction, async (client) => {
      const project = await client.project.findUnique({ where: { id: input.projectId } });
      if (!project) throw new ControlledDocumentError("PROJECT_NOT_FOUND", "项目不存在。", 404);
      if (project.status === "CLOSED" || project.status === "CANCELED") {
        throw new ControlledDocumentError("PROJECT_READ_ONLY", "已关闭项目不能创建受控文档。");
      }
      const source = await resolveSourceFile(client, input.projectId, input.sourceFileId);
      await assertSensitiveSourceFileAccess(source, input.sourceFileAccess);
      const document = await client.controlledDocument.create({
        data: {
          code,
          title,
          project: { connect: { id: input.projectId } },
          createdBy: { connect: { id: input.actorId } },
          versions: {
            create: {
              version: 1,
              sourceFileSha256: source.sha256,
              sourceMimeType: source.mimeType,
              sourceFileSize: source.size,
              project: { connect: { id: input.projectId } },
              sourceFile: {
                connect: { id_projectId: { id: source.id, projectId: input.projectId } }
              },
              createdBy: { connect: { id: input.actorId } }
            }
          }
        },
        include: documentInclude
      });
      const draft = document.versions[0];
      if (!draft) throw new Error("创建受控文档草稿失败。");
      const audit = await writeAudit(client, {
        action: AUDIT_ACTIONS.CONTROLLED_DOCUMENT_CREATED,
        objectType: AUDIT_OBJECT_TYPES.CONTROLLED_DOCUMENT,
        objectId: document.id,
        context: commandAuditContext(input, project, reason),
        after: {
          value: auditValue(document, draft),
          allowedFields: CONTROLLED_DOCUMENT_AUDIT_FIELDS
        }
      });
      const outbox = await appendOutboxEvent(client, {
        eventType: "document.created",
        aggregateType: "CONTROLLED_DOCUMENT",
        aggregateId: document.id,
        idempotencyKey: `${document.id}:v${document.version}`,
        payload: auditValue(document, draft)
      });
      return {
        document: serializeDocument(document),
        resourceVersion: document.version,
        auditId: audit.id,
        outboxEventId: outbox.id
      };
    });
  } catch (error) {
    mapDatabaseError(error);
  }
}

export async function createControlledDocumentDraft(
  input: {
    projectId: string;
    documentId: string;
    version: unknown;
    sourceFileId: string;
    reason: unknown;
    actorId: string;
    auditContext: AuditContext;
    sourceFileAccess?: SourceFileAccess;
  },
  transaction?: Prisma.TransactionClient
) {
  const expectedVersion = positiveVersion(input.version);
  const reason = commandReason(input.reason);
  try {
    return await inTransaction(transaction, async (client) => {
      const document = await lockDocument(client, input.projectId, input.documentId);
      if (!document) {
        throw new ControlledDocumentError("CONTROLLED_DOCUMENT_NOT_FOUND", "受控文档不存在。", 404);
      }
      assertDocumentActive(document);
      if (document.version !== expectedVersion) {
        throw new ControlledDocumentError("VERSION_CONFLICT", "受控文档已发生变化，请刷新后重试。");
      }
      const project = await client.project.findUniqueOrThrow({ where: { id: input.projectId } });
      if (project.status === "CLOSED" || project.status === "CANCELED") {
        throw new ControlledDocumentError("PROJECT_READ_ONLY", "已关闭项目不能创建文档草稿。");
      }
      const source = await resolveSourceFile(client, input.projectId, input.sourceFileId);
      await assertSensitiveSourceFileAccess(source, input.sourceFileAccess);
      const latestVersion = document.versions.at(-1)?.version ?? 0;
      await client.controlledDocumentVersion.updateMany({
        where: { documentId: document.id, status: "DRAFT" },
        data: { status: "SUPERSEDED" }
      });
      const draft = await client.controlledDocumentVersion.create({
        data: {
          documentId: document.id,
          projectId: input.projectId,
          version: latestVersion + 1,
          sourceFileId: source.id,
          sourceFileSha256: source.sha256,
          sourceMimeType: source.mimeType,
          sourceFileSize: source.size,
          createdById: input.actorId
        }
      });
      const updated = await client.controlledDocument.updateMany({
        where: {
          id: document.id,
          projectId: input.projectId,
          version: expectedVersion,
          status: "ACTIVE"
        },
        data: { version: { increment: 1 } }
      });
      if (updated.count !== 1) {
        throw new ControlledDocumentError("VERSION_CONFLICT", "受控文档已发生变化，请刷新后重试。");
      }
      const refreshed = await client.controlledDocument.findUniqueOrThrow({
        where: { id: document.id },
        include: documentInclude
      });
      const audit = await writeAudit(client, {
        action: AUDIT_ACTIONS.CONTROLLED_DOCUMENT_VERSION_DRAFTED,
        objectType: AUDIT_OBJECT_TYPES.CONTROLLED_DOCUMENT_VERSION,
        objectId: draft.id,
        context: commandAuditContext(input, project, reason),
        after: {
          value: auditValue(refreshed, draft),
          allowedFields: CONTROLLED_DOCUMENT_AUDIT_FIELDS
        }
      });
      const outbox = await appendOutboxEvent(client, {
        eventType: "document.version.drafted",
        aggregateType: "CONTROLLED_DOCUMENT_VERSION",
        aggregateId: draft.id,
        idempotencyKey: `${document.id}:v${refreshed.version}`,
        payload: auditValue(refreshed, draft)
      });
      return {
        document: serializeDocument(refreshed),
        resourceVersion: refreshed.version,
        auditId: audit.id,
        outboxEventId: outbox.id
      };
    });
  } catch (error) {
    mapDatabaseError(error);
  }
}

export async function publishControlledDocumentVersion(
  input: {
    projectId: string;
    documentId: string;
    documentVersionId: string;
    version: unknown;
    reason: unknown;
    actorId: string;
    auditContext: AuditContext;
  },
  transaction?: Prisma.TransactionClient
) {
  const expectedVersion = positiveVersion(input.version);
  const reason = commandReason(input.reason);
  try {
    return await inTransaction(transaction, async (client) => {
      const document = await lockDocument(client, input.projectId, input.documentId);
      if (!document) {
        throw new ControlledDocumentError("CONTROLLED_DOCUMENT_NOT_FOUND", "受控文档不存在。", 404);
      }
      assertDocumentActive(document);
      if (document.version !== expectedVersion) {
        throw new ControlledDocumentError("VERSION_CONFLICT", "受控文档已发生变化，请刷新后重试。");
      }
      const target = document.versions.find(({ id }) => id === input.documentVersionId);
      if (!target) {
        throw new ControlledDocumentError(
          "CONTROLLED_DOCUMENT_VERSION_NOT_FOUND",
          "文档版本不存在。",
          404
        );
      }
      if (target.status !== "DRAFT") {
        throw new ControlledDocumentError("DOCUMENT_VERSION_NOT_DRAFT", "只有草稿版本可以发布。");
      }
      await loadReviewClosure(client, input.projectId, target.id);
      assertDocumentVersionTransition(
        target.status as ControlledDocumentVersionStatus,
        "PUBLISHED"
      );
      const project = await client.project.findUniqueOrThrow({ where: { id: input.projectId } });
      if (project.status === "CLOSED" || project.status === "CANCELED") {
        throw new ControlledDocumentError("PROJECT_READ_ONLY", "已关闭项目不能发布文档版本。");
      }
      const now = await databaseNow(client);
      await client.controlledDocumentVersion.updateMany({
        where: { documentId: document.id, status: "PUBLISHED" },
        data: { status: "SUPERSEDED" }
      });
      const published = await client.controlledDocumentVersion.update({
        where: { id: target.id },
        data: { status: "PUBLISHED", publishedById: input.actorId, publishedAt: now }
      });
      const updated = await client.controlledDocument.updateMany({
        where: {
          id: document.id,
          projectId: input.projectId,
          version: expectedVersion,
          status: "ACTIVE"
        },
        data: { currentPublishedVersionId: published.id, version: { increment: 1 } }
      });
      if (updated.count !== 1) {
        throw new ControlledDocumentError("VERSION_CONFLICT", "受控文档已发生变化，请刷新后重试。");
      }
      const refreshed = await client.controlledDocument.findUniqueOrThrow({
        where: { id: document.id },
        include: documentInclude
      });
      const audit = await writeAudit(client, {
        action: AUDIT_ACTIONS.CONTROLLED_DOCUMENT_VERSION_PUBLISHED,
        objectType: AUDIT_OBJECT_TYPES.CONTROLLED_DOCUMENT_VERSION,
        objectId: published.id,
        context: commandAuditContext(input, project, reason),
        before: {
          value: auditValue(document, target),
          allowedFields: CONTROLLED_DOCUMENT_AUDIT_FIELDS
        },
        after: {
          value: auditValue(refreshed, published),
          allowedFields: CONTROLLED_DOCUMENT_AUDIT_FIELDS
        }
      });
      const outbox = await appendOutboxEvent(client, {
        eventType: "document.version.published",
        aggregateType: "CONTROLLED_DOCUMENT_VERSION",
        aggregateId: published.id,
        idempotencyKey: `${document.id}:v${refreshed.version}`,
        payload: auditValue(refreshed, published)
      });
      return {
        document: serializeDocument(refreshed),
        resourceVersion: refreshed.version,
        auditId: audit.id,
        outboxEventId: outbox.id
      };
    });
  } catch (error) {
    mapDatabaseError(error);
  }
}

export async function voidControlledDocument(
  input: {
    projectId: string;
    documentId: string;
    version: unknown;
    reason: unknown;
    actorId: string;
    auditContext: AuditContext;
  },
  transaction?: Prisma.TransactionClient
) {
  const expectedVersion = positiveVersion(input.version);
  const reason = commandReason(input.reason);
  try {
    return await inTransaction(transaction, async (client) => {
      const document = await lockDocument(client, input.projectId, input.documentId);
      if (!document) {
        throw new ControlledDocumentError("CONTROLLED_DOCUMENT_NOT_FOUND", "受控文档不存在。", 404);
      }
      if (!canVoidControlledDocument(document.status)) {
        throw new ControlledDocumentError("DOCUMENT_ALREADY_VOIDED", "受控文档已经作废。");
      }
      if (document.version !== expectedVersion) {
        throw new ControlledDocumentError("VERSION_CONFLICT", "受控文档已发生变化，请刷新后重试。");
      }
      const project = await client.project.findUniqueOrThrow({ where: { id: input.projectId } });
      const now = await databaseNow(client);
      await client.controlledDocumentVersion.updateMany({
        where: { documentId: document.id, status: { in: ["DRAFT", "PUBLISHED"] } },
        data: {
          status: "VOIDED",
          voidedById: input.actorId,
          voidedAt: now,
          voidReason: reason
        }
      });
      const updated = await client.controlledDocument.updateMany({
        where: {
          id: document.id,
          projectId: input.projectId,
          version: expectedVersion,
          status: "ACTIVE"
        },
        data: {
          status: "VOIDED",
          currentPublishedVersionId: null,
          voidedById: input.actorId,
          voidedAt: now,
          voidReason: reason,
          version: { increment: 1 }
        }
      });
      if (updated.count !== 1) {
        throw new ControlledDocumentError("VERSION_CONFLICT", "受控文档已发生变化，请刷新后重试。");
      }
      const refreshed = await client.controlledDocument.findUniqueOrThrow({
        where: { id: document.id },
        include: documentInclude
      });
      const audit = await writeAudit(client, {
        action: AUDIT_ACTIONS.CONTROLLED_DOCUMENT_VOIDED,
        objectType: AUDIT_OBJECT_TYPES.CONTROLLED_DOCUMENT,
        objectId: document.id,
        context: commandAuditContext(input, project, reason),
        before: {
          value: auditValue(document),
          allowedFields: CONTROLLED_DOCUMENT_AUDIT_FIELDS
        },
        after: {
          value: auditValue(refreshed),
          allowedFields: CONTROLLED_DOCUMENT_AUDIT_FIELDS
        }
      });
      const outbox = await appendOutboxEvent(client, {
        eventType: "document.voided",
        aggregateType: "CONTROLLED_DOCUMENT",
        aggregateId: document.id,
        idempotencyKey: `${document.id}:v${refreshed.version}`,
        payload: auditValue(refreshed)
      });
      return {
        document: serializeDocument(refreshed),
        resourceVersion: refreshed.version,
        auditId: audit.id,
        outboxEventId: outbox.id
      };
    });
  } catch (error) {
    mapDatabaseError(error);
  }
}

function requireDocumentReviewStatus(value: unknown): "APPROVED" | "CHANGES_REQUESTED" {
  if (value === "APPROVED" || value === "CHANGES_REQUESTED") return value;
  throw new DocumentReviewError("DOCUMENT_REVIEW_STATUS_INVALID", "评审决定状态无效。", 422);
}

function requireReviewRequired(value: unknown): boolean {
  if (typeof value !== "boolean") {
    throw new DocumentReviewError(
      "DOCUMENT_REVIEW_REQUIRED_INVALID",
      "required 必须是布尔值。",
      422
    );
  }
  return value;
}

function requireRelationTarget(input: { targetType: unknown; targetId: unknown }): {
  targetType: DocumentVersionRelationTargetType;
  targetId: string;
} {
  if (
    typeof input.targetId !== "string" ||
    !input.targetId.trim() ||
    input.targetId.trim().length > 191
  ) {
    throw new DocumentReviewError(
      "DOCUMENT_RELATION_TARGET_INVALID",
      "文档关联目标格式无效。",
      422
    );
  }
  const targetIds =
    input.targetType === "DELIVERY_UNIT"
      ? { deliveryUnitId: input.targetId }
      : input.targetType === "MODULE"
        ? { moduleId: input.targetId }
        : input.targetType === "RESPONSIBILITY_PACKAGE"
          ? { responsibilityPackageId: input.targetId }
          : input.targetType === "PLANNING_TASK"
            ? { planningTaskId: input.targetId }
            : input.targetType === "MILESTONE"
              ? { milestoneId: input.targetId }
              : input.targetType === "GATE_INSTANCE"
                ? { gateInstanceId: input.targetId }
                : null;
  if (!targetIds) {
    throw new DocumentReviewError("DOCUMENT_RELATION_TARGET_INVALID", "文档关联类型无效。", 422);
  }
  const target = validateDocumentVersionRelationTarget({
    targetType: input.targetType as DocumentVersionRelationTargetType,
    targetIds
  });
  const targetId = Object.values(target.targetIds).find(Boolean);
  if (!targetId) throw new Error("文档关联目标不能为空。");
  return { targetType: target.targetType, targetId };
}

async function lockDocumentReview(
  client: Prisma.TransactionClient,
  projectId: string,
  reviewId: string
) {
  await client.$queryRaw`
    SELECT "id" FROM "document_reviews"
    WHERE "id" = ${reviewId} AND "project_id" = ${projectId}
    FOR UPDATE
  `;
  return client.documentReview.findFirst({
    where: { id: reviewId, projectId },
    include: {
      comments: { orderBy: { createdAt: "asc" }, include: { resolution: true } }
    }
  });
}

async function loadReviewClosure(
  client: Prisma.TransactionClient,
  projectId: string,
  documentVersionId: string
) {
  const reviews = await client.documentReview.findMany({
    where: { projectId, documentVersionId },
    include: { comments: { include: { resolution: true } } },
    orderBy: { requestedAt: "asc" }
  });
  assertRequiredReviewClosure({
    reviews: reviews.map((review) => ({
      id: review.id,
      required: review.required,
      status: review.status as DocumentReviewStatus
    })),
    comments: reviews.flatMap((review) =>
      review.comments.map((comment) => ({
        id: comment.id,
        required: comment.required,
        resolvedAt: comment.resolution?.resolvedAt ?? null
      }))
    )
  });
  return reviews;
}

function reviewAuditValue(input: {
  document: DocumentFact;
  documentVersionId: string;
  reviewId: string;
  reviewerId: string;
  required: boolean;
  status: string;
  version: number;
  commentId?: string;
  resolutionId?: string;
  openRequiredCommentCount?: number;
}) {
  const version = input.document.versions.find(({ id }) => id === input.documentVersionId);
  return {
    projectId: input.document.projectId,
    documentId: input.document.id,
    documentVersionId: input.documentVersionId,
    documentVersion: version?.version ?? null,
    reviewId: input.reviewId,
    reviewerId: input.reviewerId,
    required: input.required,
    status: input.status,
    commentId: input.commentId ?? null,
    resolutionId: input.resolutionId ?? null,
    openRequiredCommentCount: input.openRequiredCommentCount ?? 0,
    version: input.version
  };
}

function relationAuditValue(input: { document: DocumentFact; relation: RelationFact }) {
  const version = input.document.versions.find(({ id }) => id === input.relation.documentVersionId);
  return {
    projectId: input.document.projectId,
    documentId: input.document.id,
    documentVersionId: input.relation.documentVersionId,
    documentVersion: version?.version ?? null,
    relationId: input.relation.id,
    targetType: input.relation.targetType,
    targetId: input.relation.targetId,
    status: input.relation.status,
    voidReason: input.relation.voidReason,
    version: input.relation.version
  };
}

async function appendReviewEvent(
  client: Prisma.TransactionClient,
  input: {
    review: Awaited<ReturnType<typeof lockDocumentReview>> & {};
    eventType: "REQUESTED" | "APPROVED" | "CHANGES_REQUESTED";
    fromStatus: DocumentReviewStatus | null;
    reason: string;
    actorId: string;
  }
) {
  if (!input.review) throw new Error("文档评审不存在。");
  const sequence =
    (await client.documentReviewEvent.count({ where: { reviewId: input.review.id } })) + 1;
  return client.documentReviewEvent.create({
    data: {
      projectId: input.review.projectId,
      reviewId: input.review.id,
      sequence,
      eventType: input.eventType,
      fromStatus: input.fromStatus,
      toStatus: input.review.status,
      reason: input.reason,
      snapshotJson: serializeReview(input.review) as Prisma.InputJsonValue,
      actorId: input.actorId
    }
  });
}

async function assertActiveProjectReviewer(
  client: Prisma.TransactionClient,
  projectId: string,
  reviewerId: string
) {
  const membership = await client.projectMember.findFirst({
    where: { projectId, userId: reviewerId, leftAt: null, user: { status: "ACTIVE" } },
    select: { id: true }
  });
  if (!membership) {
    throw new DocumentReviewError(
      "DOCUMENT_REVIEWER_INVALID",
      "评审人必须是当前有效项目成员。",
      409
    );
  }
}

export async function createDocumentReview(
  input: {
    projectId: string;
    documentId: string;
    documentVersionId: string;
    version: unknown;
    reviewerId: unknown;
    required: unknown;
    reason: unknown;
    actorId: string;
    auditContext: AuditContext;
  },
  transaction?: Prisma.TransactionClient
) {
  const expectedVersion = positiveVersion(input.version);
  const reason = commandReason(input.reason);
  if (
    typeof input.reviewerId !== "string" ||
    !input.reviewerId.trim() ||
    input.reviewerId.length > 191
  ) {
    throw new DocumentReviewError("DOCUMENT_REVIEWER_INVALID", "评审人标识无效。", 422);
  }
  const reviewerId = input.reviewerId.trim();
  const required = requireReviewRequired(input.required);
  try {
    return await inTransaction(transaction, async (client) => {
      const document = await lockDocument(client, input.projectId, input.documentId);
      if (!document)
        throw new ControlledDocumentError("CONTROLLED_DOCUMENT_NOT_FOUND", "受控文档不存在。", 404);
      assertDocumentActive(document);
      if (document.version !== expectedVersion) {
        throw new ControlledDocumentError("VERSION_CONFLICT", "受控文档已发生变化，请刷新后重试。");
      }
      const documentVersion = document.versions.find(({ id }) => id === input.documentVersionId);
      if (!documentVersion) {
        throw new ControlledDocumentError(
          "CONTROLLED_DOCUMENT_VERSION_NOT_FOUND",
          "文档版本不存在。",
          404
        );
      }
      if (documentVersion.status !== "DRAFT") {
        throw new DocumentReviewError(
          "DOCUMENT_REVIEW_VERSION_NOT_DRAFT",
          "只能对草稿文档版本发起评审。"
        );
      }
      const project = await client.project.findUniqueOrThrow({ where: { id: input.projectId } });
      if (project.status === "CLOSED" || project.status === "CANCELED") {
        throw new DocumentReviewError("PROJECT_READ_ONLY", "已关闭项目不能发起文档评审。");
      }
      await assertActiveProjectReviewer(client, input.projectId, reviewerId);
      const review = await client.documentReview.create({
        data: {
          projectId: input.projectId,
          documentVersionId: documentVersion.id,
          reviewerId,
          required,
          requestedById: input.actorId
        },
        include: { comments: { include: { resolution: true } } }
      });
      const advanced = await client.controlledDocument.updateMany({
        where: {
          id: document.id,
          projectId: input.projectId,
          version: expectedVersion,
          status: "ACTIVE"
        },
        data: { version: { increment: 1 } }
      });
      if (advanced.count !== 1) {
        throw new ControlledDocumentError("VERSION_CONFLICT", "受控文档已发生变化，请刷新后重试。");
      }
      const refreshed = await client.controlledDocument.findUniqueOrThrow({
        where: { id: document.id },
        include: documentInclude
      });
      const refreshedReview = refreshed.versions
        .find(({ id }) => id === documentVersion.id)
        ?.reviews.find(({ id }) => id === review.id);
      if (!refreshedReview) throw new Error("文档评审创建后无法读取。");
      const event = await appendReviewEvent(client, {
        review: refreshedReview,
        eventType: "REQUESTED",
        fromStatus: null,
        reason,
        actorId: input.actorId
      });
      const auditValue = reviewAuditValue({
        document: refreshed,
        documentVersionId: documentVersion.id,
        reviewId: review.id,
        reviewerId: review.reviewerId,
        required: review.required,
        status: review.status,
        version: review.version
      });
      const audit = await writeAudit(client, {
        action: AUDIT_ACTIONS.DOCUMENT_REVIEW_REQUESTED,
        objectType: AUDIT_OBJECT_TYPES.DOCUMENT_REVIEW,
        objectId: review.id,
        context: commandAuditContext(input, project, reason),
        after: { value: auditValue, allowedFields: DOCUMENT_REVIEW_AUDIT_FIELDS }
      });
      const outbox = await appendOutboxEvent(client, {
        eventType: "document.review.requested",
        aggregateType: "DOCUMENT_REVIEW",
        aggregateId: review.id,
        idempotencyKey: review.id,
        payload: auditValue
      });
      return {
        document: serializeDocument(refreshed),
        review: serializeReview(refreshedReview),
        resourceVersion: refreshed.version,
        reviewEventId: event.id,
        auditId: audit.id,
        outboxEventId: outbox.id
      };
    });
  } catch (error) {
    mapDatabaseError(error);
  }
}

export async function decideDocumentReview(
  input: {
    projectId: string;
    documentId: string;
    documentVersionId: string;
    reviewId: string;
    version: unknown;
    status: unknown;
    reason: unknown;
    actorId: string;
    auditContext: AuditContext;
  },
  transaction?: Prisma.TransactionClient
) {
  const expectedVersion = positiveVersion(input.version);
  const status = requireDocumentReviewStatus(input.status);
  const reason = commandReason(input.reason);
  try {
    return await inTransaction(transaction, async (client) => {
      const document = await lockDocument(client, input.projectId, input.documentId);
      if (!document)
        throw new ControlledDocumentError("CONTROLLED_DOCUMENT_NOT_FOUND", "受控文档不存在。", 404);
      const documentVersion = document.versions.find(({ id }) => id === input.documentVersionId);
      if (!documentVersion)
        throw new ControlledDocumentError(
          "CONTROLLED_DOCUMENT_VERSION_NOT_FOUND",
          "文档版本不存在。",
          404
        );
      if (documentVersion.status !== "DRAFT") {
        throw new DocumentReviewError(
          "DOCUMENT_REVIEW_VERSION_NOT_DRAFT",
          "已冻结版本不能再提交评审决定。"
        );
      }
      const review = await lockDocumentReview(client, input.projectId, input.reviewId);
      if (!review || review.documentVersionId !== documentVersion.id) {
        throw new DocumentReviewError("DOCUMENT_REVIEW_NOT_FOUND", "文档评审不存在。", 404);
      }
      if (review.reviewerId !== input.actorId) {
        throw new DocumentReviewError(
          "DOCUMENT_REVIEW_FORBIDDEN",
          "只有被指派的评审人可以提交评审决定。",
          403
        );
      }
      if (review.version !== expectedVersion) {
        throw new DocumentReviewError(
          "DOCUMENT_REVIEW_VERSION_CONFLICT",
          "文档评审已发生变化，请刷新后重试。"
        );
      }
      assertReviewDecision({
        currentStatus: review.status as DocumentReviewStatus,
        nextStatus: status,
        openRequiredCommentCount: review.comments.filter(
          (comment) => comment.required && !comment.resolution
        ).length
      });
      const project = await client.project.findUniqueOrThrow({ where: { id: input.projectId } });
      const now = await databaseNow(client);
      const changed = await client.documentReview.updateMany({
        where: { id: review.id, projectId: input.projectId, version: expectedVersion },
        data: { status, decidedById: input.actorId, decidedAt: now, version: { increment: 1 } }
      });
      if (changed.count !== 1) {
        throw new DocumentReviewError(
          "DOCUMENT_REVIEW_VERSION_CONFLICT",
          "文档评审已发生变化，请刷新后重试。"
        );
      }
      const updated = await lockDocumentReview(client, input.projectId, review.id);
      if (!updated) throw new Error("文档评审决定后无法读取。");
      const refreshed = await client.controlledDocument.findUniqueOrThrow({
        where: { id: document.id },
        include: documentInclude
      });
      const event = await appendReviewEvent(client, {
        review: updated,
        eventType: status,
        fromStatus: review.status as DocumentReviewStatus,
        reason,
        actorId: input.actorId
      });
      const auditValue = reviewAuditValue({
        document: refreshed,
        documentVersionId: documentVersion.id,
        reviewId: updated.id,
        reviewerId: updated.reviewerId,
        required: updated.required,
        status: updated.status,
        version: updated.version,
        openRequiredCommentCount: updated.comments.filter(
          (comment) => comment.required && !comment.resolution
        ).length
      });
      const audit = await writeAudit(client, {
        action: AUDIT_ACTIONS.DOCUMENT_REVIEW_DECIDED,
        objectType: AUDIT_OBJECT_TYPES.DOCUMENT_REVIEW,
        objectId: updated.id,
        context: commandAuditContext(input, project, reason),
        before: {
          value: reviewAuditValue({
            document: refreshed,
            documentVersionId: documentVersion.id,
            reviewId: review.id,
            reviewerId: review.reviewerId,
            required: review.required,
            status: review.status,
            version: review.version
          }),
          allowedFields: DOCUMENT_REVIEW_AUDIT_FIELDS
        },
        after: { value: auditValue, allowedFields: DOCUMENT_REVIEW_AUDIT_FIELDS }
      });
      const outbox = await appendOutboxEvent(client, {
        eventType: "document.review.decided",
        aggregateType: "DOCUMENT_REVIEW",
        aggregateId: updated.id,
        idempotencyKey: `${updated.id}:v${updated.version}`,
        payload: auditValue
      });
      return {
        review: serializeReview(updated),
        resourceVersion: updated.version,
        reviewEventId: event.id,
        auditId: audit.id,
        outboxEventId: outbox.id
      };
    });
  } catch (error) {
    mapDatabaseError(error);
  }
}

export async function createDocumentReviewComment(
  input: {
    projectId: string;
    documentId: string;
    documentVersionId: string;
    reviewId: string;
    body: unknown;
    required: unknown;
    reason: unknown;
    actorId: string;
    auditContext: AuditContext;
  },
  transaction?: Prisma.TransactionClient
) {
  const reason = commandReason(input.reason);
  if (typeof input.body !== "string" || !input.body.trim() || input.body.trim().length > 4096) {
    throw new DocumentReviewError(
      "DOCUMENT_REVIEW_COMMENT_INVALID",
      "评审意见必须是 1 到 4096 个字符。",
      422
    );
  }
  const body = input.body.trim();
  const required = requireReviewRequired(input.required);
  try {
    return await inTransaction(transaction, async (client) => {
      const document = await lockDocument(client, input.projectId, input.documentId);
      if (!document)
        throw new ControlledDocumentError("CONTROLLED_DOCUMENT_NOT_FOUND", "受控文档不存在。", 404);
      const documentVersion = document.versions.find(({ id }) => id === input.documentVersionId);
      if (!documentVersion)
        throw new ControlledDocumentError(
          "CONTROLLED_DOCUMENT_VERSION_NOT_FOUND",
          "文档版本不存在。",
          404
        );
      if (documentVersion.status !== "DRAFT") {
        throw new DocumentReviewError(
          "DOCUMENT_REVIEW_VERSION_NOT_DRAFT",
          "已冻结版本不能新增评审意见。"
        );
      }
      const review = await lockDocumentReview(client, input.projectId, input.reviewId);
      if (!review || review.documentVersionId !== documentVersion.id) {
        throw new DocumentReviewError("DOCUMENT_REVIEW_NOT_FOUND", "文档评审不存在。", 404);
      }
      if (review.reviewerId !== input.actorId || review.status === "APPROVED") {
        throw new DocumentReviewError(
          "DOCUMENT_REVIEW_FORBIDDEN",
          "只有待处理评审的被指派评审人可以新增意见。",
          403
        );
      }
      const project = await client.project.findUniqueOrThrow({ where: { id: input.projectId } });
      const comment = await client.documentReviewComment.create({
        data: {
          projectId: input.projectId,
          documentVersionId: documentVersion.id,
          reviewId: review.id,
          body,
          required,
          createdById: input.actorId
        }
      });
      const openRequiredCommentCount =
        review.comments.filter((entry) => entry.required && !entry.resolution).length +
        (required ? 1 : 0);
      const auditValue = reviewAuditValue({
        document,
        documentVersionId: documentVersion.id,
        reviewId: review.id,
        reviewerId: review.reviewerId,
        required: review.required,
        status: review.status,
        version: review.version,
        commentId: comment.id,
        openRequiredCommentCount
      });
      const audit = await writeAudit(client, {
        action: AUDIT_ACTIONS.DOCUMENT_REVIEW_COMMENTED,
        objectType: AUDIT_OBJECT_TYPES.DOCUMENT_REVIEW_COMMENT,
        objectId: comment.id,
        context: commandAuditContext(input, project, reason),
        after: { value: auditValue, allowedFields: DOCUMENT_REVIEW_AUDIT_FIELDS }
      });
      const outbox = await appendOutboxEvent(client, {
        eventType: "document.review.commented",
        aggregateType: "DOCUMENT_REVIEW_COMMENT",
        aggregateId: comment.id,
        idempotencyKey: comment.id,
        payload: auditValue
      });
      return {
        comment: { ...comment, createdAt: comment.createdAt.toISOString() },
        auditId: audit.id,
        outboxEventId: outbox.id
      };
    });
  } catch (error) {
    mapDatabaseError(error);
  }
}

export async function resolveDocumentReviewComment(
  input: {
    projectId: string;
    documentId: string;
    documentVersionId: string;
    reviewId: string;
    commentId: string;
    resolution: unknown;
    reason: unknown;
    actorId: string;
    auditContext: AuditContext;
  },
  transaction?: Prisma.TransactionClient
) {
  const reason = commandReason(input.reason);
  if (
    typeof input.resolution !== "string" ||
    !input.resolution.trim() ||
    input.resolution.trim().length > 1024
  ) {
    throw new DocumentReviewError(
      "DOCUMENT_REVIEW_RESOLUTION_INVALID",
      "意见处理说明必须是 1 到 1024 个字符。",
      422
    );
  }
  const resolutionText = input.resolution.trim();
  try {
    return await inTransaction(transaction, async (client) => {
      const document = await lockDocument(client, input.projectId, input.documentId);
      if (!document)
        throw new ControlledDocumentError("CONTROLLED_DOCUMENT_NOT_FOUND", "受控文档不存在。", 404);
      const documentVersion = document.versions.find(({ id }) => id === input.documentVersionId);
      if (!documentVersion)
        throw new ControlledDocumentError(
          "CONTROLLED_DOCUMENT_VERSION_NOT_FOUND",
          "文档版本不存在。",
          404
        );
      if (documentVersion.status !== "DRAFT") {
        throw new DocumentReviewError(
          "DOCUMENT_REVIEW_VERSION_NOT_DRAFT",
          "已冻结版本不能处理评审意见。"
        );
      }
      const review = await lockDocumentReview(client, input.projectId, input.reviewId);
      if (!review || review.documentVersionId !== documentVersion.id) {
        throw new DocumentReviewError("DOCUMENT_REVIEW_NOT_FOUND", "文档评审不存在。", 404);
      }
      const comment = review.comments.find(({ id }) => id === input.commentId);
      if (!comment)
        throw new DocumentReviewError("DOCUMENT_REVIEW_COMMENT_NOT_FOUND", "评审意见不存在。", 404);
      if (comment.resolution) {
        throw new DocumentReviewError(
          "DOCUMENT_REVIEW_COMMENT_ALREADY_RESOLVED",
          "评审意见已闭环。",
          409
        );
      }
      if (review.reviewerId !== input.actorId) {
        throw new DocumentReviewError(
          "DOCUMENT_REVIEW_FORBIDDEN",
          "只有被指派评审人可以确认意见闭环。",
          403
        );
      }
      const project = await client.project.findUniqueOrThrow({ where: { id: input.projectId } });
      const now = await databaseNow(client);
      const resolution = await client.documentReviewCommentResolution.create({
        data: {
          projectId: input.projectId,
          commentId: comment.id,
          reviewId: review.id,
          resolution: resolutionText,
          resolvedById: input.actorId,
          resolvedAt: now
        }
      });
      const auditValue = reviewAuditValue({
        document,
        documentVersionId: documentVersion.id,
        reviewId: review.id,
        reviewerId: review.reviewerId,
        required: review.required,
        status: review.status,
        version: review.version,
        commentId: comment.id,
        resolutionId: resolution.id,
        openRequiredCommentCount: review.comments.filter(
          (entry) => entry.required && !entry.resolution && entry.id !== comment.id
        ).length
      });
      const audit = await writeAudit(client, {
        action: AUDIT_ACTIONS.DOCUMENT_REVIEW_COMMENT_RESOLVED,
        objectType: AUDIT_OBJECT_TYPES.DOCUMENT_REVIEW_COMMENT,
        objectId: comment.id,
        context: commandAuditContext(input, project, reason),
        after: { value: auditValue, allowedFields: DOCUMENT_REVIEW_AUDIT_FIELDS }
      });
      const outbox = await appendOutboxEvent(client, {
        eventType: "document.review.comment-resolved",
        aggregateType: "DOCUMENT_REVIEW_COMMENT",
        aggregateId: comment.id,
        idempotencyKey: resolution.id,
        payload: auditValue
      });
      return {
        resolution: { ...resolution, resolvedAt: resolution.resolvedAt.toISOString() },
        auditId: audit.id,
        outboxEventId: outbox.id
      };
    });
  } catch (error) {
    mapDatabaseError(error);
  }
}

export async function createDocumentVersionRelation(
  input: {
    projectId: string;
    documentId: string;
    documentVersionId: string;
    version: unknown;
    targetType: unknown;
    targetId: unknown;
    reason: unknown;
    actorId: string;
    auditContext: AuditContext;
  },
  transaction?: Prisma.TransactionClient
) {
  const expectedVersion = positiveVersion(input.version);
  const target = requireRelationTarget({ targetType: input.targetType, targetId: input.targetId });
  const reason = commandReason(input.reason);
  try {
    return await inTransaction(transaction, async (client) => {
      const document = await lockDocument(client, input.projectId, input.documentId);
      if (!document)
        throw new ControlledDocumentError("CONTROLLED_DOCUMENT_NOT_FOUND", "受控文档不存在。", 404);
      assertDocumentActive(document);
      if (document.version !== expectedVersion) {
        throw new ControlledDocumentError("VERSION_CONFLICT", "受控文档已发生变化，请刷新后重试。");
      }
      const documentVersion = document.versions.find(({ id }) => id === input.documentVersionId);
      if (!documentVersion)
        throw new ControlledDocumentError(
          "CONTROLLED_DOCUMENT_VERSION_NOT_FOUND",
          "文档版本不存在。",
          404
        );
      if (documentVersion.status !== "DRAFT" && documentVersion.status !== "PUBLISHED") {
        throw new DocumentReviewError(
          "DOCUMENT_RELATION_VERSION_INVALID",
          "只能关联草稿或已发布文档版本。",
          409
        );
      }
      const project = await client.project.findUniqueOrThrow({ where: { id: input.projectId } });
      if (project.status === "CLOSED" || project.status === "CANCELED") {
        throw new DocumentReviewError("PROJECT_READ_ONLY", "已关闭项目不能关联文档版本。");
      }
      const relation = await client.documentVersionRelation.create({
        data: {
          projectId: input.projectId,
          documentVersionId: documentVersion.id,
          targetType: target.targetType,
          targetId: target.targetId,
          createdById: input.actorId
        }
      });
      const advanced = await client.controlledDocument.updateMany({
        where: {
          id: document.id,
          projectId: input.projectId,
          version: expectedVersion,
          status: "ACTIVE"
        },
        data: { version: { increment: 1 } }
      });
      if (advanced.count !== 1) {
        throw new ControlledDocumentError("VERSION_CONFLICT", "受控文档已发生变化，请刷新后重试。");
      }
      const refreshed = await client.controlledDocument.findUniqueOrThrow({
        where: { id: document.id },
        include: documentInclude
      });
      const refreshedRelation = refreshed.versions
        .find(({ id }) => id === documentVersion.id)
        ?.relations.find(({ id }) => id === relation.id);
      if (!refreshedRelation) throw new Error("文档关联创建后无法读取。");
      const auditValue = relationAuditValue({ document: refreshed, relation: refreshedRelation });
      const audit = await writeAudit(client, {
        action: AUDIT_ACTIONS.DOCUMENT_VERSION_RELATED,
        objectType: AUDIT_OBJECT_TYPES.DOCUMENT_VERSION_RELATION,
        objectId: relation.id,
        context: commandAuditContext(input, project, reason),
        after: { value: auditValue, allowedFields: DOCUMENT_VERSION_RELATION_AUDIT_FIELDS }
      });
      const outbox = await appendOutboxEvent(client, {
        eventType: "document.version.related",
        aggregateType: "DOCUMENT_VERSION_RELATION",
        aggregateId: relation.id,
        idempotencyKey: relation.id,
        payload: auditValue
      });
      return {
        document: serializeDocument(refreshed),
        relation: serializeRelation(refreshedRelation),
        resourceVersion: refreshed.version,
        auditId: audit.id,
        outboxEventId: outbox.id
      };
    });
  } catch (error) {
    mapDatabaseError(error);
  }
}

export async function voidDocumentVersionRelation(
  input: {
    projectId: string;
    documentId: string;
    documentVersionId: string;
    relationId: string;
    version: unknown;
    reason: unknown;
    actorId: string;
    auditContext: AuditContext;
  },
  transaction?: Prisma.TransactionClient
) {
  const expectedVersion = positiveVersion(input.version);
  const reason = commandReason(input.reason);
  try {
    return await inTransaction(transaction, async (client) => {
      const document = await lockDocument(client, input.projectId, input.documentId);
      if (!document)
        throw new ControlledDocumentError("CONTROLLED_DOCUMENT_NOT_FOUND", "受控文档不存在。", 404);
      const documentVersion = document.versions.find(({ id }) => id === input.documentVersionId);
      if (!documentVersion)
        throw new ControlledDocumentError(
          "CONTROLLED_DOCUMENT_VERSION_NOT_FOUND",
          "文档版本不存在。",
          404
        );
      await client.$queryRaw`
        SELECT "id" FROM "document_version_relations"
        WHERE "id" = ${input.relationId} AND "project_id" = ${input.projectId}
        FOR UPDATE
      `;
      const relation = await client.documentVersionRelation.findFirst({
        where: {
          id: input.relationId,
          projectId: input.projectId,
          documentVersionId: documentVersion.id
        }
      });
      if (!relation)
        throw new DocumentReviewError("DOCUMENT_RELATION_NOT_FOUND", "文档版本关联不存在。", 404);
      if (relation.status !== "ACTIVE" || relation.version !== expectedVersion) {
        throw new DocumentReviewError(
          "DOCUMENT_RELATION_VERSION_CONFLICT",
          "文档关联已发生变化，请刷新后重试。"
        );
      }
      const project = await client.project.findUniqueOrThrow({ where: { id: input.projectId } });
      const now = await databaseNow(client);
      const changed = await client.documentVersionRelation.updateMany({
        where: {
          id: relation.id,
          projectId: input.projectId,
          version: expectedVersion,
          status: "ACTIVE"
        },
        data: {
          status: "VOIDED",
          version: { increment: 1 },
          voidedById: input.actorId,
          voidedAt: now,
          voidReason: reason
        }
      });
      if (changed.count !== 1) {
        throw new DocumentReviewError(
          "DOCUMENT_RELATION_VERSION_CONFLICT",
          "文档关联已发生变化，请刷新后重试。"
        );
      }
      const updated = await client.documentVersionRelation.findUniqueOrThrow({
        where: { id: relation.id }
      });
      const refreshed = await client.controlledDocument.findUniqueOrThrow({
        where: { id: document.id },
        include: documentInclude
      });
      const currentRelation = refreshed.versions
        .find(({ id }) => id === documentVersion.id)
        ?.relations.find(({ id }) => id === updated.id);
      if (!currentRelation) throw new Error("文档关联作废后无法读取。");
      const before = relationAuditValue({
        document: refreshed,
        relation: relation as RelationFact
      });
      const after = relationAuditValue({ document: refreshed, relation: currentRelation });
      const audit = await writeAudit(client, {
        action: AUDIT_ACTIONS.DOCUMENT_VERSION_RELATION_VOIDED,
        objectType: AUDIT_OBJECT_TYPES.DOCUMENT_VERSION_RELATION,
        objectId: updated.id,
        context: commandAuditContext(input, project, reason),
        before: { value: before, allowedFields: DOCUMENT_VERSION_RELATION_AUDIT_FIELDS },
        after: { value: after, allowedFields: DOCUMENT_VERSION_RELATION_AUDIT_FIELDS }
      });
      const outbox = await appendOutboxEvent(client, {
        eventType: "document.version.relation-voided",
        aggregateType: "DOCUMENT_VERSION_RELATION",
        aggregateId: updated.id,
        idempotencyKey: `${updated.id}:v${updated.version}`,
        payload: after
      });
      return {
        relation: serializeRelation(currentRelation),
        resourceVersion: updated.version,
        auditId: audit.id,
        outboxEventId: outbox.id
      };
    });
  } catch (error) {
    mapDatabaseError(error);
  }
}

export async function createGateSubmissionDocumentReferences(input: {
  client: Prisma.TransactionClient;
  projectId: string;
  gateInstanceId: string;
  gateSubmissionId: string;
}) {
  const relations = await input.client.documentVersionRelation.findMany({
    where: {
      projectId: input.projectId,
      targetType: "GATE_INSTANCE",
      targetId: input.gateInstanceId,
      status: "ACTIVE"
    },
    include: {
      documentVersion: {
        include: {
          document: true,
          reviews: {
            orderBy: { requestedAt: "asc" },
            include: { comments: { orderBy: { createdAt: "asc" }, include: { resolution: true } } }
          }
        }
      }
    },
    orderBy: { id: "asc" }
  });
  const references = relations.map((relation) => {
    const documentVersion = relation.documentVersion;
    if (documentVersion.status !== "PUBLISHED") {
      throw new DocumentReviewError(
        "DOCUMENT_GATE_VERSION_NOT_PUBLISHED",
        "Gate 只能引用已发布的精确文档版本。"
      );
    }
    assertRequiredReviewClosure({
      reviews: documentVersion.reviews.map((review) => ({
        id: review.id,
        required: review.required,
        status: review.status as DocumentReviewStatus
      })),
      comments: documentVersion.reviews.flatMap((review) =>
        review.comments.map((comment) => ({
          id: comment.id,
          required: comment.required,
          resolvedAt: comment.resolution?.resolvedAt ?? null
        }))
      )
    });
    const reviewEvidence = {
      documentVersionId: documentVersion.id,
      reviews: documentVersion.reviews.map((review) => ({
        reviewId: review.id,
        reviewerId: review.reviewerId,
        required: review.required,
        status: review.status,
        version: review.version,
        requestedAt: review.requestedAt.toISOString(),
        decidedById: review.decidedById,
        decidedAt: review.decidedAt?.toISOString() ?? null,
        comments: review.comments.map((comment) => ({
          commentId: comment.id,
          required: comment.required,
          createdAt: comment.createdAt.toISOString(),
          resolutionId: comment.resolution?.id ?? null,
          resolvedAt: comment.resolution?.resolvedAt.toISOString() ?? null
        }))
      }))
    };
    return {
      projectId: input.projectId,
      gateSubmissionId: input.gateSubmissionId,
      documentVersionId: documentVersion.id,
      documentVersionRelationId: relation.id,
      documentCode: documentVersion.document.code,
      documentTitle: documentVersion.document.title,
      documentVersion: documentVersion.version,
      sourceFileSha256: documentVersion.sourceFileSha256,
      reviewEvidenceJson: reviewEvidence as Prisma.InputJsonValue,
      reviewEvidenceChecksum: payloadHash(reviewEvidence).hash
    };
  });
  if (references.length > 0) {
    await input.client.gateSubmissionDocumentReference.createMany({ data: references });
  }
  return input.client.gateSubmissionDocumentReference.findMany({
    where: { gateSubmissionId: input.gateSubmissionId, projectId: input.projectId },
    orderBy: [{ documentCode: "asc" }, { documentVersion: "asc" }]
  });
}
