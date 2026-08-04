import { Prisma } from "@prisma/client";

import { decideAuthorization, type AuthorizationActor } from "@/lib/auth/authorize";
import { PERMISSIONS } from "@/lib/auth/permissions";
import type { ProjectAuthorizationTarget } from "@/lib/auth/repository";
import { db, inTransaction } from "@/lib/db";
import type { AuditContext } from "@/modules/audit/contracts/audit";
import {
  AUDIT_ACTIONS,
  AUDIT_OBJECT_TYPES,
  CONTROLLED_DOCUMENT_AUDIT_FIELDS
} from "@/modules/audit/domain/vocabulary";
import { writeAudit } from "@/modules/audit/infrastructure/write-audit";
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

const sourceFileSelect = {
  id: true,
  projectId: true,
  uploadedById: true,
  sensitivity: true
} satisfies Prisma.FileObjectSelect;

const documentInclude = {
  currentPublishedVersion: { include: { sourceFile: { select: sourceFileSelect } } },
  versions: {
    orderBy: { version: "asc" },
    include: { sourceFile: { select: sourceFileSelect } }
  }
} satisfies Prisma.ControlledDocumentInclude;

type DocumentFact = Prisma.ControlledDocumentGetPayload<{ include: typeof documentInclude }>;
type DocumentSourceFile = NonNullable<DocumentFact["versions"][number]["sourceFile"]>;
type DocumentVersionAuditFact = Omit<DocumentFact["versions"][number], "sourceFile">;

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
    allowedActions: value.status === "DRAFT" ? ["PUBLISH"] : []
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
