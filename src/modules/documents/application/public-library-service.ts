import { Prisma } from "@prisma/client";

import { decideAuthorization, type AuthorizationActor } from "@/lib/auth/authorize";
import { PERMISSIONS } from "@/lib/auth/permissions";
import { db, inTransaction } from "@/lib/db";
import type { AuditContext } from "@/modules/audit/contracts/audit";
import {
  AUDIT_ACTIONS,
  AUDIT_OBJECT_TYPES,
  AUDIT_RESULTS,
  FILE_AUDIT_FIELDS,
  PUBLIC_LIBRARY_AUDIT_FIELDS
} from "@/modules/audit/domain/vocabulary";
import { writeAudit } from "@/modules/audit/infrastructure/write-audit";
import { appendOutboxEvent } from "@/modules/governance/infrastructure/outbox";

import {
  PUBLIC_LIBRARY_DOCUMENT_STATUSES,
  PublicLibraryDocumentError,
  validatePublicLibraryApplicability,
  validatePublicLibraryCode,
  validatePublicLibraryMaterialType,
  validatePublicLibraryReason,
  validatePublicLibraryReferenceVersion,
  validatePublicLibraryTitle,
  validatePublicLibraryVersion
} from "../domain/public-library-document";
import { recordFileAccessDenied } from "./file-download-service";

const sourceFileSelect = {
  id: true,
  projectId: true,
  uploadedById: true,
  sensitivity: true
} satisfies Prisma.FileObjectSelect;

const publicDocumentInclude = {
  currentPublishedVersion: { include: { sourceFile: { select: sourceFileSelect } } },
  versions: {
    orderBy: { version: "asc" },
    include: { sourceFile: { select: sourceFileSelect } }
  }
} satisfies Prisma.PublicLibraryDocumentInclude;

type PublicDocumentFact = Prisma.PublicLibraryDocumentGetPayload<{
  include: typeof publicDocumentInclude;
}>;
type PublicDocumentSourceFile = NonNullable<PublicDocumentFact["versions"][number]["sourceFile"]>;
type PublicDocumentVersionAuditFact = Omit<PublicDocumentFact["versions"][number], "sourceFile">;

export type PublicSourceFileAccess = {
  actor: AuthorizationActor;
  auditContext: AuditContext;
  method: string;
  path: string;
};

function assertDocumentActive(document: { status: string }) {
  if (document.status !== PUBLIC_LIBRARY_DOCUMENT_STATUSES.ACTIVE) {
    throw new PublicLibraryDocumentError(
      "PUBLIC_LIBRARY_DOCUMENT_VOIDED",
      "已作废公共资料不能修改。"
    );
  }
}

function assertProjectWritable(project: { status: string }) {
  if (project.status === "CLOSED" || project.status === "CANCELED") {
    throw new PublicLibraryDocumentError("PROJECT_READ_ONLY", "已关闭项目不能引用或退役公共资料。");
  }
}

function assertVersionTransition(from: string, to: string) {
  const valid =
    (from === "DRAFT" && ["PUBLISHED", "SUPERSEDED", "VOIDED"].includes(to)) ||
    (from === "PUBLISHED" && ["SUPERSEDED", "VOIDED"].includes(to)) ||
    (from === "SUPERSEDED" && to === "VOIDED");
  if (!valid) {
    throw new PublicLibraryDocumentError(
      "PUBLIC_LIBRARY_VERSION_TRANSITION_INVALID",
      "公共资料版本当前状态不允许该操作。"
    );
  }
}

async function databaseNow(transaction: Prisma.TransactionClient): Promise<Date> {
  const [clock] = await transaction.$queryRaw<Array<{ now: Date }>>`
    SELECT CURRENT_TIMESTAMP AS "now"
  `;
  if (!clock) throw new Error("无法读取数据库时间。");
  return clock.now;
}

async function lockDocument(transaction: Prisma.TransactionClient, documentId: string) {
  await transaction.$queryRaw`
    SELECT "id" FROM "public_library_documents" WHERE "id" = ${documentId} FOR UPDATE
  `;
  return transaction.publicLibraryDocument.findUnique({
    where: { id: documentId },
    include: publicDocumentInclude
  });
}

async function lockReference(
  transaction: Prisma.TransactionClient,
  projectId: string,
  referenceId: string
) {
  await transaction.$queryRaw`
    SELECT "id" FROM "project_public_library_references"
    WHERE "id" = ${referenceId} AND "project_id" = ${projectId}
    FOR UPDATE
  `;
  return transaction.projectPublicLibraryReference.findFirst({
    where: { id: referenceId, projectId }
  });
}

async function resolveSourceFile(transaction: Prisma.TransactionClient, sourceFileId: string) {
  const source = await transaction.fileObject.findUnique({
    where: { id: sourceFileId },
    select: {
      id: true,
      projectId: true,
      uploadedById: true,
      sensitivity: true,
      status: true,
      sha256: true,
      verifiedMimeType: true,
      verifiedSize: true
    }
  });
  if (!source) {
    throw new PublicLibraryDocumentError(
      "PUBLIC_LIBRARY_SOURCE_FILE_NOT_FOUND",
      "公共资料源文件不存在。",
      404
    );
  }
  if (source.status !== "AVAILABLE") {
    throw new PublicLibraryDocumentError(
      "PUBLIC_LIBRARY_SOURCE_FILE_NOT_AVAILABLE",
      "公共资料只能引用已扫描可用的文件。"
    );
  }
  if (!source.sha256 || !/^[0-9a-f]{64}$/u.test(source.sha256)) {
    throw new PublicLibraryDocumentError(
      "PUBLIC_LIBRARY_SOURCE_FILE_HASH_REQUIRED",
      "公共资料源文件必须具有有效的 SHA-256。"
    );
  }
  if (!source.verifiedMimeType || !source.verifiedSize || source.verifiedSize < 1n) {
    throw new PublicLibraryDocumentError(
      "PUBLIC_LIBRARY_SOURCE_FILE_VERIFICATION_REQUIRED",
      "公共资料源文件必须具有已验证的 MIME 和大小。"
    );
  }
  return {
    ...source,
    sha256: source.sha256,
    mimeType: source.verifiedMimeType,
    size: source.verifiedSize
  };
}

async function assertSensitiveSourceFileAccess(
  transaction: Prisma.TransactionClient,
  source: PublicDocumentSourceFile | Awaited<ReturnType<typeof resolveSourceFile>>,
  access: PublicSourceFileAccess | undefined,
  recordAllowedRead = false
) {
  if (source.sensitivity !== "RESTRICTED") return;

  const decision = access
    ? decideAuthorization(access.actor, PERMISSIONS.SENSITIVE_FILE_READ, {
        resourceDepartmentId: access.actor.departmentId,
        resourceOwnerId: source.uploadedById
      })
    : null;
  if (!decision?.allowed) {
    if (access) {
      await recordFileAccessDenied({
        fileId: source.id,
        context: access.auditContext,
        permission: PERMISSIONS.SENSITIVE_FILE_READ,
        method: access.method,
        path: access.path,
        reason: decision?.reason ?? "PERMISSION_NOT_GRANTED"
      });
    }
    throw new PublicLibraryDocumentError(
      "SENSITIVE_FILE_READ_REQUIRED",
      "当前角色无权读取或引用严格受限公共资料文件。",
      403
    );
  }

  if (recordAllowedRead && access) {
    await writeAudit(transaction, {
      action: AUDIT_ACTIONS.SENSITIVE_FILE_READ,
      objectType: AUDIT_OBJECT_TYPES.FILE_OBJECT,
      objectId: source.id,
      result: AUDIT_RESULTS.SUCCESS,
      context: { ...access.auditContext, actorId: access.actor.id, projectId: source.projectId },
      metadata: {
        value: {
          fileId: source.id,
          projectId: source.projectId,
          sensitivity: source.sensitivity,
          permission: PERMISSIONS.SENSITIVE_FILE_READ,
          method: access.method,
          path: access.path
        },
        allowedFields: FILE_AUDIT_FIELDS
      }
    });
  }
}

async function assertSensitiveDocumentReadAccess(
  document: PublicDocumentFact,
  access?: PublicSourceFileAccess
) {
  await db.$transaction(async (transaction) => {
    const sources = new Map<string, PublicDocumentSourceFile>(
      document.versions.map((version) => [version.sourceFile.id, version.sourceFile] as const)
    );
    for (const source of sources.values()) {
      await assertSensitiveSourceFileAccess(transaction, source, access, true);
    }
  });
}

function serializeVersion(value: PublicDocumentFact["versions"][number]) {
  return {
    id: value.id,
    documentId: value.documentId,
    version: value.version,
    status: value.status,
    sourceFileId: value.sourceFileId,
    sourceFileSha256: value.sourceFileSha256,
    sourceMimeType: value.sourceMimeType,
    sourceFileSize: Number(value.sourceFileSize),
    applicableModels: value.applicableModels,
    applicablePlatforms: value.applicablePlatforms,
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

function serializeDocument(value: PublicDocumentFact) {
  return {
    id: value.id,
    code: value.code,
    title: value.title,
    materialType: value.materialType,
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

function documentAuditValue(
  document: PublicDocumentFact,
  version?: PublicDocumentVersionAuditFact
) {
  const current = version ?? document.currentPublishedVersion;
  return {
    publicLibraryDocumentId: document.id,
    documentCode: document.code,
    documentTitle: document.title,
    materialType: document.materialType,
    documentStatus: document.status,
    publicDocumentVersionId: current?.id ?? null,
    documentVersion: current?.version ?? null,
    documentVersionStatus: current?.status ?? null,
    sourceFileId: current?.sourceFileId ?? null,
    sourceFileSha256: current?.sourceFileSha256 ?? null,
    sourceMimeType: current?.sourceMimeType ?? null,
    sourceFileSize: current ? Number(current.sourceFileSize) : null,
    applicableModels: current?.applicableModels ?? [],
    applicablePlatforms: current?.applicablePlatforms ?? [],
    currentPublishedVersionId: document.currentPublishedVersionId,
    version: document.version
  };
}

function commandAuditContext(
  input: { actorId: string; auditContext: AuditContext },
  reason: string,
  projectId: string | null = null
): AuditContext {
  return { ...input.auditContext, actorId: input.actorId, projectId, reason };
}

function serializeReference(
  value: Prisma.ProjectPublicLibraryReferenceGetPayload<Record<string, never>>
) {
  return {
    id: value.id,
    projectId: value.projectId,
    publicLibraryDocumentId: value.publicLibraryDocumentId,
    publicDocumentVersionId: value.publicDocumentVersionId,
    documentCode: value.documentCode,
    documentTitle: value.documentTitle,
    materialType: value.materialType,
    documentVersion: value.documentVersion,
    sourceFileSha256: value.sourceFileSha256,
    applicableModels: value.applicableModels,
    applicablePlatforms: value.applicablePlatforms,
    status: value.status,
    version: value.version,
    createdById: value.createdById,
    retiredById: value.retiredById,
    retiredAt: value.retiredAt?.toISOString() ?? null,
    retireReason: value.retireReason,
    createdAt: value.createdAt.toISOString(),
    updatedAt: value.updatedAt.toISOString(),
    resourceVersion: value.version,
    allowedActions: value.status === "ACTIVE" ? ["RETIRE"] : []
  };
}

function referenceAuditValue(
  value: Prisma.ProjectPublicLibraryReferenceGetPayload<Record<string, never>>
) {
  return {
    projectId: value.projectId,
    publicLibraryDocumentId: value.publicLibraryDocumentId,
    publicDocumentVersionId: value.publicDocumentVersionId,
    projectPublicLibraryReferenceId: value.id,
    documentCode: value.documentCode,
    documentTitle: value.documentTitle,
    materialType: value.materialType,
    documentVersion: value.documentVersion,
    sourceFileSha256: value.sourceFileSha256,
    applicableModels: value.applicableModels,
    applicablePlatforms: value.applicablePlatforms,
    referenceStatus: value.status,
    version: value.version
  };
}

function mapDatabaseError(error: unknown): never {
  if (error instanceof PublicLibraryDocumentError) throw error;
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
    throw new PublicLibraryDocumentError(
      "PUBLIC_LIBRARY_CONFLICT",
      "公共资料编号、版本或项目引用已被并发命令占用，请刷新后重试。"
    );
  }
  throw error;
}

export async function listPublicLibraryDocuments(input: {
  status?: "ACTIVE" | "VOIDED";
  materialType?: Prisma.PublicLibraryDocumentWhereInput["materialType"];
  cursor?: string;
  limit: number;
  sourceFileAccess?: PublicSourceFileAccess;
}) {
  const documents = await db.publicLibraryDocument.findMany({
    where: {
      ...(input.status ? { status: input.status } : {}),
      ...(input.materialType ? { materialType: input.materialType } : {})
    },
    include: publicDocumentInclude,
    orderBy: { id: "asc" },
    ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
    take: input.limit + 1
  });
  const page = documents.slice(0, input.limit);
  const accessible: PublicDocumentFact[] = [];
  for (const document of page) {
    try {
      await assertSensitiveDocumentReadAccess(document, input.sourceFileAccess);
      accessible.push(document);
    } catch (error) {
      if (
        !(error instanceof PublicLibraryDocumentError) ||
        error.code !== "SENSITIVE_FILE_READ_REQUIRED"
      ) {
        throw error;
      }
    }
  }
  return {
    documents: accessible.map(serializeDocument),
    nextCursor: documents.length > input.limit ? (page.at(-1)?.id ?? null) : null
  };
}

export async function getPublicLibraryDocument(input: {
  documentId: string;
  sourceFileAccess?: PublicSourceFileAccess;
}) {
  const document = await db.publicLibraryDocument.findUnique({
    where: { id: input.documentId },
    include: publicDocumentInclude
  });
  if (!document) {
    throw new PublicLibraryDocumentError(
      "PUBLIC_LIBRARY_DOCUMENT_NOT_FOUND",
      "公共资料不存在。",
      404
    );
  }
  await assertSensitiveDocumentReadAccess(document, input.sourceFileAccess);
  return { document: serializeDocument(document) };
}

export async function createPublicLibraryDocument(
  input: {
    code: unknown;
    title: unknown;
    materialType: unknown;
    sourceFileId: string;
    applicableModels?: unknown;
    applicablePlatforms?: unknown;
    reason: unknown;
    actorId: string;
    auditContext: AuditContext;
    sourceFileAccess?: PublicSourceFileAccess;
  },
  transaction?: Prisma.TransactionClient
) {
  const code = validatePublicLibraryCode(input.code);
  const title = validatePublicLibraryTitle(input.title);
  const materialType = validatePublicLibraryMaterialType(input.materialType);
  const applicability = validatePublicLibraryApplicability(input);
  const reason = validatePublicLibraryReason(input.reason);
  try {
    return await inTransaction(transaction, async (client) => {
      const source = await resolveSourceFile(client, input.sourceFileId);
      await assertSensitiveSourceFileAccess(client, source, input.sourceFileAccess, true);
      const document = await client.publicLibraryDocument.create({
        data: {
          code,
          title,
          materialType,
          createdById: input.actorId,
          versions: {
            create: {
              version: 1,
              sourceFileId: source.id,
              sourceFileSha256: source.sha256,
              sourceMimeType: source.mimeType,
              sourceFileSize: source.size,
              applicableModels: applicability.applicableModels,
              applicablePlatforms: applicability.applicablePlatforms,
              createdById: input.actorId
            }
          }
        },
        include: publicDocumentInclude
      });
      const draft = document.versions[0];
      if (!draft) throw new Error("创建公共资料草稿失败。");
      const audit = await writeAudit(client, {
        action: AUDIT_ACTIONS.PUBLIC_LIBRARY_DOCUMENT_CREATED,
        objectType: AUDIT_OBJECT_TYPES.PUBLIC_LIBRARY_DOCUMENT,
        objectId: document.id,
        context: commandAuditContext(input, reason),
        after: {
          value: documentAuditValue(document, draft),
          allowedFields: PUBLIC_LIBRARY_AUDIT_FIELDS
        }
      });
      const outbox = await appendOutboxEvent(client, {
        eventType: "public-library.document.created",
        aggregateType: "PUBLIC_LIBRARY_DOCUMENT",
        aggregateId: document.id,
        idempotencyKey: `${document.id}:v${document.version}`,
        payload: documentAuditValue(document, draft)
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

export async function createPublicLibraryDocumentDraft(
  input: {
    documentId: string;
    version: unknown;
    sourceFileId: string;
    applicableModels?: unknown;
    applicablePlatforms?: unknown;
    reason: unknown;
    actorId: string;
    auditContext: AuditContext;
    sourceFileAccess?: PublicSourceFileAccess;
  },
  transaction?: Prisma.TransactionClient
) {
  const expectedVersion = validatePublicLibraryVersion(input.version);
  const applicability = validatePublicLibraryApplicability(input);
  const reason = validatePublicLibraryReason(input.reason);
  try {
    return await inTransaction(transaction, async (client) => {
      const document = await lockDocument(client, input.documentId);
      if (!document) {
        throw new PublicLibraryDocumentError(
          "PUBLIC_LIBRARY_DOCUMENT_NOT_FOUND",
          "公共资料不存在。",
          404
        );
      }
      assertDocumentActive(document);
      if (document.version !== expectedVersion) {
        throw new PublicLibraryDocumentError(
          "VERSION_CONFLICT",
          "公共资料已发生变化，请刷新后重试。"
        );
      }
      const source = await resolveSourceFile(client, input.sourceFileId);
      await assertSensitiveSourceFileAccess(client, source, input.sourceFileAccess, true);
      const latestVersion = document.versions.at(-1)?.version ?? 0;
      await client.publicLibraryDocumentVersion.updateMany({
        where: { documentId: document.id, status: "DRAFT" },
        data: { status: "SUPERSEDED" }
      });
      const draft = await client.publicLibraryDocumentVersion.create({
        data: {
          documentId: document.id,
          version: latestVersion + 1,
          sourceFileId: source.id,
          sourceFileSha256: source.sha256,
          sourceMimeType: source.mimeType,
          sourceFileSize: source.size,
          applicableModels: applicability.applicableModels,
          applicablePlatforms: applicability.applicablePlatforms,
          createdById: input.actorId
        }
      });
      const updated = await client.publicLibraryDocument.updateMany({
        where: { id: document.id, version: expectedVersion, status: "ACTIVE" },
        data: { version: { increment: 1 } }
      });
      if (updated.count !== 1) {
        throw new PublicLibraryDocumentError(
          "VERSION_CONFLICT",
          "公共资料已发生变化，请刷新后重试。"
        );
      }
      const refreshed = await client.publicLibraryDocument.findUniqueOrThrow({
        where: { id: document.id },
        include: publicDocumentInclude
      });
      const audit = await writeAudit(client, {
        action: AUDIT_ACTIONS.PUBLIC_LIBRARY_VERSION_DRAFTED,
        objectType: AUDIT_OBJECT_TYPES.PUBLIC_LIBRARY_DOCUMENT_VERSION,
        objectId: draft.id,
        context: commandAuditContext(input, reason),
        after: {
          value: documentAuditValue(refreshed, draft),
          allowedFields: PUBLIC_LIBRARY_AUDIT_FIELDS
        }
      });
      const outbox = await appendOutboxEvent(client, {
        eventType: "public-library.document.version.drafted",
        aggregateType: "PUBLIC_LIBRARY_DOCUMENT_VERSION",
        aggregateId: draft.id,
        idempotencyKey: `${document.id}:v${refreshed.version}`,
        payload: documentAuditValue(refreshed, draft)
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

export async function publishPublicLibraryDocumentVersion(
  input: {
    documentId: string;
    documentVersionId: string;
    version: unknown;
    reason: unknown;
    actorId: string;
    auditContext: AuditContext;
  },
  transaction?: Prisma.TransactionClient
) {
  const expectedVersion = validatePublicLibraryVersion(input.version);
  const reason = validatePublicLibraryReason(input.reason);
  try {
    return await inTransaction(transaction, async (client) => {
      const document = await lockDocument(client, input.documentId);
      if (!document) {
        throw new PublicLibraryDocumentError(
          "PUBLIC_LIBRARY_DOCUMENT_NOT_FOUND",
          "公共资料不存在。",
          404
        );
      }
      assertDocumentActive(document);
      if (document.version !== expectedVersion) {
        throw new PublicLibraryDocumentError(
          "VERSION_CONFLICT",
          "公共资料已发生变化，请刷新后重试。"
        );
      }
      const target = document.versions.find(({ id }) => id === input.documentVersionId);
      if (!target) {
        throw new PublicLibraryDocumentError(
          "PUBLIC_LIBRARY_VERSION_NOT_FOUND",
          "公共资料版本不存在。",
          404
        );
      }
      if (target.status !== "DRAFT") {
        throw new PublicLibraryDocumentError(
          "PUBLIC_LIBRARY_VERSION_NOT_DRAFT",
          "只有草稿版本可以发布。"
        );
      }
      assertVersionTransition(target.status, "PUBLISHED");
      const now = await databaseNow(client);
      await client.publicLibraryDocumentVersion.updateMany({
        where: { documentId: document.id, status: "PUBLISHED" },
        data: { status: "SUPERSEDED" }
      });
      const published = await client.publicLibraryDocumentVersion.update({
        where: { id: target.id },
        data: { status: "PUBLISHED", publishedById: input.actorId, publishedAt: now }
      });
      const updated = await client.publicLibraryDocument.updateMany({
        where: { id: document.id, version: expectedVersion, status: "ACTIVE" },
        data: { currentPublishedVersionId: published.id, version: { increment: 1 } }
      });
      if (updated.count !== 1) {
        throw new PublicLibraryDocumentError(
          "VERSION_CONFLICT",
          "公共资料已发生变化，请刷新后重试。"
        );
      }
      const refreshed = await client.publicLibraryDocument.findUniqueOrThrow({
        where: { id: document.id },
        include: publicDocumentInclude
      });
      const audit = await writeAudit(client, {
        action: AUDIT_ACTIONS.PUBLIC_LIBRARY_VERSION_PUBLISHED,
        objectType: AUDIT_OBJECT_TYPES.PUBLIC_LIBRARY_DOCUMENT_VERSION,
        objectId: published.id,
        context: commandAuditContext(input, reason),
        before: {
          value: documentAuditValue(document, target),
          allowedFields: PUBLIC_LIBRARY_AUDIT_FIELDS
        },
        after: {
          value: documentAuditValue(refreshed, published),
          allowedFields: PUBLIC_LIBRARY_AUDIT_FIELDS
        }
      });
      const outbox = await appendOutboxEvent(client, {
        eventType: "public-library.document.version.published",
        aggregateType: "PUBLIC_LIBRARY_DOCUMENT_VERSION",
        aggregateId: published.id,
        idempotencyKey: `${document.id}:v${refreshed.version}`,
        payload: documentAuditValue(refreshed, published)
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

export async function voidPublicLibraryDocument(
  input: {
    documentId: string;
    version: unknown;
    reason: unknown;
    actorId: string;
    auditContext: AuditContext;
  },
  transaction?: Prisma.TransactionClient
) {
  const expectedVersion = validatePublicLibraryVersion(input.version);
  const reason = validatePublicLibraryReason(input.reason);
  try {
    return await inTransaction(transaction, async (client) => {
      const document = await lockDocument(client, input.documentId);
      if (!document) {
        throw new PublicLibraryDocumentError(
          "PUBLIC_LIBRARY_DOCUMENT_NOT_FOUND",
          "公共资料不存在。",
          404
        );
      }
      assertDocumentActive(document);
      if (document.version !== expectedVersion) {
        throw new PublicLibraryDocumentError(
          "VERSION_CONFLICT",
          "公共资料已发生变化，请刷新后重试。"
        );
      }
      const now = await databaseNow(client);
      await client.publicLibraryDocumentVersion.updateMany({
        where: { documentId: document.id, status: { in: ["DRAFT", "PUBLISHED"] } },
        data: { status: "VOIDED", voidedById: input.actorId, voidedAt: now, voidReason: reason }
      });
      const updated = await client.publicLibraryDocument.updateMany({
        where: { id: document.id, version: expectedVersion, status: "ACTIVE" },
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
        throw new PublicLibraryDocumentError(
          "VERSION_CONFLICT",
          "公共资料已发生变化，请刷新后重试。"
        );
      }
      const refreshed = await client.publicLibraryDocument.findUniqueOrThrow({
        where: { id: document.id },
        include: publicDocumentInclude
      });
      const audit = await writeAudit(client, {
        action: AUDIT_ACTIONS.PUBLIC_LIBRARY_DOCUMENT_VOIDED,
        objectType: AUDIT_OBJECT_TYPES.PUBLIC_LIBRARY_DOCUMENT,
        objectId: document.id,
        context: commandAuditContext(input, reason),
        before: { value: documentAuditValue(document), allowedFields: PUBLIC_LIBRARY_AUDIT_FIELDS },
        after: { value: documentAuditValue(refreshed), allowedFields: PUBLIC_LIBRARY_AUDIT_FIELDS }
      });
      const outbox = await appendOutboxEvent(client, {
        eventType: "public-library.document.voided",
        aggregateType: "PUBLIC_LIBRARY_DOCUMENT",
        aggregateId: document.id,
        idempotencyKey: `${document.id}:v${refreshed.version}`,
        payload: documentAuditValue(refreshed)
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

export async function listProjectPublicLibraryReferences(input: {
  projectId: string;
  status?: "ACTIVE" | "RETIRED";
  cursor?: string;
  limit: number;
}) {
  const references = await db.projectPublicLibraryReference.findMany({
    where: { projectId: input.projectId, ...(input.status ? { status: input.status } : {}) },
    orderBy: { id: "asc" },
    ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
    take: input.limit + 1
  });
  const page = references.slice(0, input.limit);
  return {
    references: page.map(serializeReference),
    nextCursor: references.length > input.limit ? (page.at(-1)?.id ?? null) : null
  };
}

export async function createProjectPublicLibraryReference(
  input: {
    projectId: string;
    publicDocumentVersionId: string;
    reason: unknown;
    actorId: string;
    auditContext: AuditContext;
    sourceFileAccess?: PublicSourceFileAccess;
  },
  transaction?: Prisma.TransactionClient
) {
  const reason = validatePublicLibraryReason(input.reason);
  try {
    return await inTransaction(transaction, async (client) => {
      const project = await client.project.findUnique({ where: { id: input.projectId } });
      if (!project) throw new PublicLibraryDocumentError("PROJECT_NOT_FOUND", "项目不存在。", 404);
      assertProjectWritable(project);
      const version = await client.publicLibraryDocumentVersion.findUnique({
        where: { id: input.publicDocumentVersionId },
        include: { document: true, sourceFile: { select: sourceFileSelect } }
      });
      if (!version) {
        throw new PublicLibraryDocumentError(
          "PUBLIC_LIBRARY_VERSION_NOT_FOUND",
          "公共资料版本不存在。",
          404
        );
      }
      validatePublicLibraryReferenceVersion(version.status);
      if (version.document.status !== "ACTIVE") {
        throw new PublicLibraryDocumentError(
          "PUBLIC_LIBRARY_DOCUMENT_VOIDED",
          "已作废公共资料不能被新项目引用。"
        );
      }
      await assertSensitiveSourceFileAccess(
        client,
        version.sourceFile,
        input.sourceFileAccess,
        true
      );
      const reference = await client.projectPublicLibraryReference.create({
        data: {
          projectId: input.projectId,
          publicLibraryDocumentId: version.documentId,
          publicDocumentVersionId: version.id,
          documentCode: version.document.code,
          documentTitle: version.document.title,
          materialType: version.document.materialType,
          documentVersion: version.version,
          sourceFileSha256: version.sourceFileSha256,
          applicableModels: version.applicableModels as Prisma.InputJsonValue,
          applicablePlatforms: version.applicablePlatforms as Prisma.InputJsonValue,
          createdById: input.actorId
        }
      });
      const audit = await writeAudit(client, {
        action: AUDIT_ACTIONS.PROJECT_PUBLIC_LIBRARY_REFERENCE_CREATED,
        objectType: AUDIT_OBJECT_TYPES.PROJECT_PUBLIC_LIBRARY_REFERENCE,
        objectId: reference.id,
        context: commandAuditContext(input, reason, input.projectId),
        after: { value: referenceAuditValue(reference), allowedFields: PUBLIC_LIBRARY_AUDIT_FIELDS }
      });
      const outbox = await appendOutboxEvent(client, {
        eventType: "project.public-library-reference.created",
        aggregateType: "PROJECT_PUBLIC_LIBRARY_REFERENCE",
        aggregateId: reference.id,
        idempotencyKey: `${reference.id}:v${reference.version}`,
        payload: referenceAuditValue(reference)
      });
      return {
        reference: serializeReference(reference),
        resourceVersion: reference.version,
        auditId: audit.id,
        outboxEventId: outbox.id
      };
    });
  } catch (error) {
    mapDatabaseError(error);
  }
}

export async function retireProjectPublicLibraryReference(
  input: {
    projectId: string;
    referenceId: string;
    version: unknown;
    reason: unknown;
    actorId: string;
    auditContext: AuditContext;
  },
  transaction?: Prisma.TransactionClient
) {
  const expectedVersion = validatePublicLibraryVersion(input.version);
  const reason = validatePublicLibraryReason(input.reason);
  try {
    return await inTransaction(transaction, async (client) => {
      const reference = await lockReference(client, input.projectId, input.referenceId);
      if (!reference) {
        throw new PublicLibraryDocumentError(
          "PROJECT_PUBLIC_LIBRARY_REFERENCE_NOT_FOUND",
          "项目公共资料引用不存在。",
          404
        );
      }
      const project = await client.project.findUniqueOrThrow({ where: { id: input.projectId } });
      assertProjectWritable(project);
      if (reference.status !== "ACTIVE") {
        throw new PublicLibraryDocumentError(
          "PROJECT_PUBLIC_LIBRARY_REFERENCE_RETIRED",
          "项目公共资料引用已经退役。"
        );
      }
      if (reference.version !== expectedVersion) {
        throw new PublicLibraryDocumentError(
          "VERSION_CONFLICT",
          "项目公共资料引用已发生变化，请刷新后重试。"
        );
      }
      const now = await databaseNow(client);
      const updated = await client.projectPublicLibraryReference.updateMany({
        where: {
          id: reference.id,
          projectId: input.projectId,
          status: "ACTIVE",
          version: expectedVersion
        },
        data: {
          status: "RETIRED",
          retiredById: input.actorId,
          retiredAt: now,
          retireReason: reason,
          version: { increment: 1 }
        }
      });
      if (updated.count !== 1) {
        throw new PublicLibraryDocumentError(
          "VERSION_CONFLICT",
          "项目公共资料引用已发生变化，请刷新后重试。"
        );
      }
      const refreshed = await client.projectPublicLibraryReference.findUniqueOrThrow({
        where: { id: reference.id }
      });
      const audit = await writeAudit(client, {
        action: AUDIT_ACTIONS.PROJECT_PUBLIC_LIBRARY_REFERENCE_RETIRED,
        objectType: AUDIT_OBJECT_TYPES.PROJECT_PUBLIC_LIBRARY_REFERENCE,
        objectId: reference.id,
        context: commandAuditContext(input, reason, input.projectId),
        before: {
          value: referenceAuditValue(reference),
          allowedFields: PUBLIC_LIBRARY_AUDIT_FIELDS
        },
        after: { value: referenceAuditValue(refreshed), allowedFields: PUBLIC_LIBRARY_AUDIT_FIELDS }
      });
      const outbox = await appendOutboxEvent(client, {
        eventType: "project.public-library-reference.retired",
        aggregateType: "PROJECT_PUBLIC_LIBRARY_REFERENCE",
        aggregateId: refreshed.id,
        idempotencyKey: `${refreshed.id}:v${refreshed.version}`,
        payload: referenceAuditValue(refreshed)
      });
      return {
        reference: serializeReference(refreshed),
        resourceVersion: refreshed.version,
        auditId: audit.id,
        outboxEventId: outbox.id
      };
    });
  } catch (error) {
    mapDatabaseError(error);
  }
}
