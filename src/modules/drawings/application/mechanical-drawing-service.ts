import { Prisma } from "@prisma/client";

import { decideAuthorization, type AuthorizationActor } from "@/lib/auth/authorize";
import { PERMISSIONS } from "@/lib/auth/permissions";
import type { ProjectAuthorizationTarget } from "@/lib/auth/repository";
import { db, inTransaction } from "@/lib/db";
import type { AuditContext } from "@/modules/audit/contracts/audit";
import {
  AUDIT_ACTIONS,
  AUDIT_OBJECT_TYPES,
  MECHANICAL_DRAWING_AUDIT_FIELDS
} from "@/modules/audit/domain/vocabulary";
import {
  createControlledDocument,
  createControlledDocumentDraft,
  publishControlledDocumentVersion
} from "@/modules/documents/application/controlled-document-service";
import {
  recordFileAccessDenied,
  recordSensitiveFileRead
} from "@/modules/documents/application/file-download-service";
import {
  ControlledDocumentError,
  validateDocumentTitle
} from "@/modules/documents/domain/controlled-document";
import { appendOutboxEvent } from "@/modules/governance/infrastructure/outbox";
import { writeAudit } from "@/modules/audit/infrastructure/write-audit";

import {
  DrawingError,
  DRAWING_FILE_ROLES,
  inferDrawingFileRole,
  normalizeDrawingFilenameStem,
  pairDrawingFiles,
  validateDrawingNumber,
  validateDrawingType,
  type DrawingFileRole
} from "../domain/mechanical-drawing";

const fileSelect = {
  id: true,
  projectId: true,
  uploadedById: true,
  originalName: true,
  status: true,
  sensitivity: true,
  sha256: true,
  verifiedMimeType: true,
  verifiedSize: true
} satisfies Prisma.FileObjectSelect;

const drawingInclude = {
  document: {
    include: {
      versions: {
        orderBy: { version: "asc" },
        include: { sourceFile: { select: fileSelect } }
      },
      currentPublishedVersion: { include: { sourceFile: { select: fileSelect } } }
    }
  },
  versionFiles: {
    orderBy: [{ documentVersion: { version: "asc" } }, { role: "asc" }],
    include: {
      documentVersion: { select: { id: true, version: true } },
      file: { select: fileSelect }
    }
  }
} satisfies Prisma.MechanicalDrawingInclude;

const importBatchInclude = {
  items: {
    orderBy: { filenameStem: "asc" },
    include: {
      files: { orderBy: { id: "asc" }, include: { file: { select: fileSelect } } },
      confirmedDrawing: { select: { id: true, drawingNumber: true, drawingType: true } }
    }
  }
} satisfies Prisma.MechanicalDrawingImportBatchInclude;

type DrawingFact = Prisma.MechanicalDrawingGetPayload<{ include: typeof drawingInclude }>;
type ImportBatchFact = Prisma.MechanicalDrawingImportBatchGetPayload<{
  include: typeof importBatchInclude;
}>;
type SourceFileAccess = {
  actor: AuthorizationActor;
  project: ProjectAuthorizationTarget;
  auditContext?: AuditContext;
  method?: string;
  path?: string;
};

type SensitiveDrawingFile = {
  id: string;
  projectId: string;
  uploadedById: string;
  sensitivity: string;
};

function commandReason(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > 1024) {
    throw new DrawingError("REASON_REQUIRED", "操作原因必须是 1 到 1024 个字符。");
  }
  return value.trim();
}

function positiveVersion(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new DrawingError("INVALID_VERSION", "version 必须是正整数。");
  }
  return value as number;
}

function drawingError(error: unknown): never {
  if (error instanceof DrawingError || error instanceof ControlledDocumentError) throw error;
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
    throw new DrawingError("DRAWING_CONFLICT", "图号、图纸版本或导入确认已被并发命令占用。", 409);
  }
  throw error;
}

async function lockDrawing(
  transaction: Prisma.TransactionClient,
  projectId: string,
  drawingId: string
) {
  await transaction.$queryRaw`
    SELECT "id" FROM "mechanical_drawings"
    WHERE "id" = ${drawingId} AND "project_id" = ${projectId}
    FOR UPDATE
  `;
  return transaction.mechanicalDrawing.findFirst({
    where: { id: drawingId, projectId },
    include: drawingInclude
  });
}

async function lockImportBatch(
  transaction: Prisma.TransactionClient,
  projectId: string,
  batchId: string
) {
  await transaction.$queryRaw`
    SELECT "id" FROM "mechanical_drawing_import_batches"
    WHERE "id" = ${batchId} AND "project_id" = ${projectId}
    FOR UPDATE
  `;
  return transaction.mechanicalDrawingImportBatch.findFirst({
    where: { id: batchId, projectId },
    include: importBatchInclude
  });
}

async function availableFile(
  transaction: Prisma.TransactionClient,
  projectId: string,
  fileId: string
) {
  const file = await transaction.fileObject.findFirst({
    where: { id: fileId, projectId },
    select: fileSelect
  });
  if (!file) throw new DrawingError("DRAWING_FILE_NOT_FOUND", "图纸文件不存在。", 404);
  if (
    file.status !== "AVAILABLE" ||
    !file.sha256 ||
    !file.verifiedMimeType ||
    !file.verifiedSize ||
    file.verifiedSize < 1n
  ) {
    throw new DrawingError("DRAWING_FILE_NOT_AVAILABLE", "图纸只能引用已扫描可用的文件。", 409);
  }
  return file;
}

async function availableFiles(
  transaction: Prisma.TransactionClient,
  projectId: string,
  fileIds: string[]
) {
  if (!fileIds.length || new Set(fileIds).size !== fileIds.length) {
    throw new DrawingError("DRAWING_FILES_INVALID", "图纸文件列表不能为空且不得重复。", 422);
  }
  const files = await Promise.all(
    fileIds.map((fileId) => availableFile(transaction, projectId, fileId))
  );
  return new Map(files.map((file) => [file.id, file] as const));
}

function sensitiveFileDecision(file: SensitiveDrawingFile, access?: SourceFileAccess) {
  if (!access) return null;
  return decideAuthorization(access.actor, PERMISSIONS.SENSITIVE_FILE_READ, {
    projectId: access.project.id,
    resourceDepartmentId: access.project.departmentId,
    resourceOwnerId: file.uploadedById,
    memberRoles: access.project.memberRoles
  });
}

async function assertSensitiveFileAccess(
  files: Iterable<SensitiveDrawingFile>,
  access?: SourceFileAccess,
  recordAllowedRead = false
) {
  const uniqueFiles = new Map([...files].map((file) => [file.id, file] as const));
  for (const file of uniqueFiles.values()) {
    if (file.sensitivity !== "RESTRICTED") continue;
    const decision = sensitiveFileDecision(file, access);
    if (!decision?.allowed) {
      if (access?.auditContext && access.method && access.path) {
        await recordFileAccessDenied({
          fileId: file.id,
          context: access.auditContext,
          permission: PERMISSIONS.SENSITIVE_FILE_READ,
          method: access.method,
          path: access.path,
          reason: decision?.reason ?? "PERMISSION_NOT_GRANTED"
        });
      }
      throw new DrawingError("SENSITIVE_FILE_READ_REQUIRED", "当前角色无权读取严格受限图纸。", 403);
    }
    if (recordAllowedRead && access?.auditContext && access.method && access.path) {
      await recordSensitiveFileRead({
        file,
        context: access.auditContext,
        method: access.method,
        path: access.path
      });
    }
  }
}

async function assertReadAccess(drawing: DrawingFact, access?: SourceFileAccess) {
  await assertSensitiveFileAccess(
    [
      ...drawing.document.versions.map((version) => version.sourceFile),
      ...drawing.versionFiles.map((versionFile) => versionFile.file)
    ],
    access,
    true
  );
}

async function assertSensitiveFileWriteAccess(
  files: Iterable<Awaited<ReturnType<typeof availableFile>>>,
  access?: SourceFileAccess
) {
  await assertSensitiveFileAccess(files, access);
}

function serializeDocument(document: DrawingFact["document"]) {
  const serializeVersion = (version: (typeof document.versions)[number]) => ({
    id: version.id,
    documentId: version.documentId,
    projectId: version.projectId,
    version: version.version,
    status: version.status,
    sourceFileId: version.sourceFileId,
    sourceFileSha256: version.sourceFileSha256,
    sourceMimeType: version.sourceMimeType,
    sourceFileSize: Number(version.sourceFileSize),
    createdAt: version.createdAt.toISOString(),
    publishedAt: version.publishedAt?.toISOString() ?? null
  });
  return {
    id: document.id,
    projectId: document.projectId,
    code: document.code,
    title: document.title,
    status: document.status,
    currentPublishedVersionId: document.currentPublishedVersionId,
    version: document.version,
    versions: document.versions.map(serializeVersion)
  };
}

function serializeDrawing(drawing: DrawingFact) {
  return {
    id: drawing.id,
    projectId: drawing.projectId,
    documentId: drawing.documentId,
    drawingNumber: drawing.drawingNumber,
    drawingType: drawing.drawingType,
    version: drawing.version,
    createdById: drawing.createdById,
    createdAt: drawing.createdAt.toISOString(),
    updatedAt: drawing.updatedAt.toISOString(),
    document: serializeDocument(drawing.document),
    versionFiles: drawing.versionFiles.map((file) => ({
      id: file.id,
      drawingId: file.drawingId,
      documentVersionId: file.documentVersionId,
      documentVersion: file.documentVersion.version,
      fileId: file.fileId,
      role: file.role,
      fileSha256: file.fileSha256,
      fileMimeType: file.fileMimeType,
      fileSize: Number(file.fileSize),
      createdAt: file.createdAt.toISOString()
    })),
    resourceVersion: drawing.version,
    allowedActions: drawing.document.status === "ACTIVE" ? ["CREATE_DRAFT", "PUBLISH"] : []
  };
}

function serializeImportBatch(batch: ImportBatchFact) {
  return {
    id: batch.id,
    projectId: batch.projectId,
    status: batch.status,
    version: batch.version,
    createdById: batch.createdById,
    createdAt: batch.createdAt.toISOString(),
    updatedAt: batch.updatedAt.toISOString(),
    items: batch.items.map((item) => ({
      id: item.id,
      filenameStem: item.filenameStem,
      pairingStatus: item.pairingStatus,
      status: item.status,
      confirmedDrawingId: item.confirmedDrawingId,
      drawingNumber: item.drawingNumber,
      title: item.title,
      drawingType: item.drawingType,
      files: item.files.map((file) => ({
        fileId: file.fileId,
        inferredRole: file.inferredRole,
        originalName: file.file.originalName
      }))
    }))
  };
}

function auditValue(drawing: DrawingFact, extra: Record<string, unknown> = {}) {
  return {
    projectId: drawing.projectId,
    drawingId: drawing.id,
    drawingNumber: drawing.drawingNumber,
    drawingType: drawing.drawingType,
    drawingVersion: drawing.version,
    documentId: drawing.documentId,
    documentVersionId: drawing.document.currentPublishedVersionId,
    documentVersion: drawing.document.versions.at(-1)?.version ?? null,
    ...extra
  };
}

function auditContext(
  input: { actorId: string; auditContext: AuditContext },
  reason: string
): AuditContext {
  return { ...input.auditContext, actorId: input.actorId, reason };
}

async function createVersionFiles(
  transaction: Prisma.TransactionClient,
  input: {
    projectId: string;
    drawingId: string;
    documentVersionId: string;
    cadSourceFileId: string;
    pdfPreviewFileId: string | null;
    stepExchangeFileIds: string[];
  }
) {
  const fileIds = [
    input.cadSourceFileId,
    ...(input.pdfPreviewFileId ? [input.pdfPreviewFileId] : []),
    ...input.stepExchangeFileIds
  ];
  const files = await availableFiles(transaction, input.projectId, fileIds);
  const entries: Array<{ fileId: string; role: DrawingFileRole }> = [
    { fileId: input.cadSourceFileId, role: DRAWING_FILE_ROLES.CAD_SOURCE },
    ...(input.pdfPreviewFileId
      ? [{ fileId: input.pdfPreviewFileId, role: DRAWING_FILE_ROLES.PDF_PREVIEW }]
      : []),
    ...input.stepExchangeFileIds.map((fileId) => ({
      fileId,
      role: DRAWING_FILE_ROLES.STEP_EXCHANGE
    }))
  ];
  if (input.stepExchangeFileIds.length > 1) {
    throw new DrawingError(
      "DRAWING_STEP_FILE_LIMIT",
      "每个图纸版本最多关联一个 STEP 交换文件。",
      422
    );
  }
  await transaction.mechanicalDrawingVersionFile.createMany({
    data: entries.map(({ fileId, role }) => {
      const file = files.get(fileId);
      if (!file?.sha256 || !file.verifiedMimeType || !file.verifiedSize) {
        throw new DrawingError("DRAWING_FILE_NOT_AVAILABLE", "图纸文件缺少验证快照。", 409);
      }
      return {
        projectId: input.projectId,
        drawingId: input.drawingId,
        documentVersionId: input.documentVersionId,
        fileId,
        role,
        fileSha256: file.sha256,
        fileMimeType: file.verifiedMimeType,
        fileSize: file.verifiedSize
      };
    })
  });
}

async function refreshDrawing(transaction: Prisma.TransactionClient, drawingId: string) {
  return transaction.mechanicalDrawing.findUniqueOrThrow({
    where: { id: drawingId },
    include: drawingInclude
  });
}

export async function listMechanicalDrawings(input: {
  projectId: string;
  cursor?: string;
  limit: number;
  sourceFileAccess?: SourceFileAccess;
}) {
  const drawings = await db.mechanicalDrawing.findMany({
    where: { projectId: input.projectId },
    include: drawingInclude,
    orderBy: { drawingNumber: "asc" },
    ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
    take: input.limit + 1
  });
  const page = drawings.slice(0, input.limit);
  const accessible: DrawingFact[] = [];
  for (const drawing of page) {
    try {
      await assertReadAccess(drawing, input.sourceFileAccess);
      accessible.push(drawing);
    } catch (error) {
      if (!(error instanceof DrawingError) || error.code !== "SENSITIVE_FILE_READ_REQUIRED")
        throw error;
    }
  }
  return {
    drawings: accessible.map(serializeDrawing),
    nextCursor: drawings.length > input.limit ? (page.at(-1)?.id ?? null) : null
  };
}

export async function getMechanicalDrawing(input: {
  projectId: string;
  drawingId: string;
  sourceFileAccess?: SourceFileAccess;
}) {
  const drawing = await db.mechanicalDrawing.findFirst({
    where: { id: input.drawingId, projectId: input.projectId },
    include: drawingInclude
  });
  if (!drawing) throw new DrawingError("MECHANICAL_DRAWING_NOT_FOUND", "机械图纸不存在。", 404);
  await assertReadAccess(drawing, input.sourceFileAccess);
  return { drawing: serializeDrawing(drawing) };
}

export async function createMechanicalDrawing(
  input: {
    projectId: string;
    drawingNumber: unknown;
    title: unknown;
    drawingType: unknown;
    cadSourceFileId: string;
    pdfPreviewFileId: string | null;
    stepExchangeFileIds: string[];
    reason: unknown;
    actorId: string;
    auditContext: AuditContext;
    sourceFileAccess?: SourceFileAccess;
  },
  transaction?: Prisma.TransactionClient
) {
  const drawingNumber = validateDrawingNumber(input.drawingNumber);
  const title = validateDocumentTitle(input.title);
  const drawingType = validateDrawingType(input.drawingType);
  const reason = commandReason(input.reason);
  try {
    return await inTransaction(transaction, async (client) => {
      const files = await availableFiles(client, input.projectId, [
        input.cadSourceFileId,
        ...(input.pdfPreviewFileId ? [input.pdfPreviewFileId] : []),
        ...input.stepExchangeFileIds
      ]);
      await assertSensitiveFileWriteAccess(files.values(), input.sourceFileAccess);
      const documentResult = await createControlledDocument(
        {
          projectId: input.projectId,
          code: drawingNumber,
          title,
          sourceFileId: input.cadSourceFileId,
          reason,
          actorId: input.actorId,
          auditContext: auditContext(input, reason)
        },
        client
      );
      const documentVersion = documentResult.document.versions[0];
      if (!documentVersion) throw new Error("创建图纸版本失败。");
      const drawing = await client.mechanicalDrawing.create({
        data: {
          projectId: input.projectId,
          documentId: documentResult.document.id,
          drawingNumber,
          drawingType,
          createdById: input.actorId
        }
      });
      await createVersionFiles(client, {
        projectId: input.projectId,
        drawingId: drawing.id,
        documentVersionId: documentVersion.id,
        cadSourceFileId: input.cadSourceFileId,
        pdfPreviewFileId: input.pdfPreviewFileId,
        stepExchangeFileIds: input.stepExchangeFileIds
      });
      const refreshed = await refreshDrawing(client, drawing.id);
      const audit = await writeAudit(client, {
        action: AUDIT_ACTIONS.MECHANICAL_DRAWING_CREATED,
        objectType: AUDIT_OBJECT_TYPES.MECHANICAL_DRAWING,
        objectId: drawing.id,
        context: auditContext(input, reason),
        after: { value: auditValue(refreshed), allowedFields: MECHANICAL_DRAWING_AUDIT_FIELDS }
      });
      const outbox = await appendOutboxEvent(client, {
        eventType: "drawing.created",
        aggregateType: "MECHANICAL_DRAWING",
        aggregateId: drawing.id,
        idempotencyKey: `${drawing.id}:v${drawing.version}`,
        payload: auditValue(refreshed)
      });
      return {
        drawing: serializeDrawing(refreshed),
        resourceVersion: refreshed.version,
        auditId: audit.id,
        outboxEventId: outbox.id
      };
    });
  } catch (error) {
    drawingError(error);
  }
}

export async function createMechanicalDrawingDraft(
  input: {
    projectId: string;
    drawingId: string;
    version: unknown;
    cadSourceFileId: string;
    pdfPreviewFileId: string | null;
    stepExchangeFileIds: string[];
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
      const drawing = await lockDrawing(client, input.projectId, input.drawingId);
      if (!drawing) throw new DrawingError("MECHANICAL_DRAWING_NOT_FOUND", "机械图纸不存在。", 404);
      if (drawing.version !== expectedVersion) {
        throw new DrawingError("VERSION_CONFLICT", "机械图纸已发生变化，请刷新后重试。", 409);
      }
      const files = await availableFiles(client, input.projectId, [
        input.cadSourceFileId,
        ...(input.pdfPreviewFileId ? [input.pdfPreviewFileId] : []),
        ...input.stepExchangeFileIds
      ]);
      await assertSensitiveFileWriteAccess(files.values(), input.sourceFileAccess);
      const drafted = await createControlledDocumentDraft(
        {
          projectId: input.projectId,
          documentId: drawing.documentId,
          version: drawing.document.version,
          sourceFileId: input.cadSourceFileId,
          reason,
          actorId: input.actorId,
          auditContext: auditContext(input, reason)
        },
        client
      );
      const documentVersion = drafted.document.versions.at(-1);
      if (!documentVersion) throw new Error("创建图纸草稿版本失败。");
      await createVersionFiles(client, {
        projectId: input.projectId,
        drawingId: drawing.id,
        documentVersionId: documentVersion.id,
        cadSourceFileId: input.cadSourceFileId,
        pdfPreviewFileId: input.pdfPreviewFileId,
        stepExchangeFileIds: input.stepExchangeFileIds
      });
      const updated = await client.mechanicalDrawing.updateMany({
        where: { id: drawing.id, projectId: input.projectId, version: expectedVersion },
        data: { version: { increment: 1 } }
      });
      if (updated.count !== 1)
        throw new DrawingError("VERSION_CONFLICT", "机械图纸已发生变化，请刷新后重试。", 409);
      const refreshed = await refreshDrawing(client, drawing.id);
      const audit = await writeAudit(client, {
        action: AUDIT_ACTIONS.MECHANICAL_DRAWING_VERSION_DRAFTED,
        objectType: AUDIT_OBJECT_TYPES.MECHANICAL_DRAWING_VERSION_FILE,
        objectId: documentVersion.id,
        context: auditContext(input, reason),
        after: { value: auditValue(refreshed), allowedFields: MECHANICAL_DRAWING_AUDIT_FIELDS }
      });
      const outbox = await appendOutboxEvent(client, {
        eventType: "drawing.version.drafted",
        aggregateType: "MECHANICAL_DRAWING",
        aggregateId: drawing.id,
        idempotencyKey: `${drawing.id}:v${refreshed.version}`,
        payload: auditValue(refreshed)
      });
      return {
        drawing: serializeDrawing(refreshed),
        resourceVersion: refreshed.version,
        auditId: audit.id,
        outboxEventId: outbox.id
      };
    });
  } catch (error) {
    drawingError(error);
  }
}

export async function publishMechanicalDrawingVersion(
  input: {
    projectId: string;
    drawingId: string;
    documentVersionId: string;
    version: unknown;
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
      const drawing = await lockDrawing(client, input.projectId, input.drawingId);
      if (!drawing) throw new DrawingError("MECHANICAL_DRAWING_NOT_FOUND", "机械图纸不存在。", 404);
      if (drawing.version !== expectedVersion) {
        throw new DrawingError("VERSION_CONFLICT", "机械图纸已发生变化，请刷新后重试。", 409);
      }
      const target = drawing.document.versions.find(
        (version) => version.id === input.documentVersionId
      );
      if (!target)
        throw new DrawingError("DRAWING_DOCUMENT_VERSION_NOT_FOUND", "图纸版本不存在。", 404);
      const versionFiles = drawing.versionFiles.filter(
        (file) => file.documentVersionId === input.documentVersionId
      );
      await assertSensitiveFileWriteAccess(
        [target.sourceFile, ...versionFiles.map((versionFile) => versionFile.file)],
        input.sourceFileAccess
      );
      if (versionFiles.filter((file) => file.role === DRAWING_FILE_ROLES.CAD_SOURCE).length !== 1) {
        throw new DrawingError(
          "DRAWING_CAD_SOURCE_REQUIRED",
          "发布图纸版本必须保留一个 CAD 源文件。",
          409
        );
      }
      await publishControlledDocumentVersion(
        {
          projectId: input.projectId,
          documentId: drawing.documentId,
          documentVersionId: target.id,
          version: drawing.document.version,
          reason,
          actorId: input.actorId,
          auditContext: auditContext(input, reason)
        },
        client
      );
      const updated = await client.mechanicalDrawing.updateMany({
        where: { id: drawing.id, projectId: input.projectId, version: expectedVersion },
        data: { version: { increment: 1 } }
      });
      if (updated.count !== 1)
        throw new DrawingError("VERSION_CONFLICT", "机械图纸已发生变化，请刷新后重试。", 409);
      const refreshed = await refreshDrawing(client, drawing.id);
      const audit = await writeAudit(client, {
        action: AUDIT_ACTIONS.MECHANICAL_DRAWING_VERSION_PUBLISHED,
        objectType: AUDIT_OBJECT_TYPES.MECHANICAL_DRAWING,
        objectId: drawing.id,
        context: auditContext(input, reason),
        after: { value: auditValue(refreshed), allowedFields: MECHANICAL_DRAWING_AUDIT_FIELDS }
      });
      const outbox = await appendOutboxEvent(client, {
        eventType: "drawing.version.published",
        aggregateType: "MECHANICAL_DRAWING",
        aggregateId: drawing.id,
        idempotencyKey: `${drawing.id}:v${refreshed.version}`,
        payload: auditValue(refreshed)
      });
      return {
        drawing: serializeDrawing(refreshed),
        resourceVersion: refreshed.version,
        auditId: audit.id,
        outboxEventId: outbox.id
      };
    });
  } catch (error) {
    drawingError(error);
  }
}

export async function createMechanicalDrawingImportBatch(
  input: {
    projectId: string;
    fileIds: string[];
    reason: unknown;
    actorId: string;
    auditContext: AuditContext;
    sourceFileAccess?: SourceFileAccess;
  },
  transaction?: Prisma.TransactionClient
) {
  const reason = commandReason(input.reason);
  try {
    return await inTransaction(transaction, async (client) => {
      const fileMap = await availableFiles(client, input.projectId, input.fileIds);
      await assertSensitiveFileWriteAccess(fileMap.values(), input.sourceFileAccess);
      const pairs = pairDrawingFiles(
        [...fileMap.values()].map((file) => ({ id: file.id, originalName: file.originalName }))
      );
      if (!pairs.length) {
        throw new DrawingError(
          "DRAWING_IMPORT_NO_RECOGNIZED_FILES",
          "未识别到 CAD、PDF 或 STEP 图纸文件。",
          422
        );
      }
      const batch = await client.mechanicalDrawingImportBatch.create({
        data: {
          projectId: input.projectId,
          createdById: input.actorId,
          items: {
            create: pairs.map((pair) => {
              const files = [...fileMap.values()].filter(
                (file) => normalizeDrawingFilenameStem(file.originalName) === pair.filenameStem
              );
              return {
                filenameStem: pair.filenameStem,
                pairingStatus: pair.pairingStatus,
                files: {
                  create: files.map((file) => ({
                    projectId: input.projectId,
                    fileId: file.id,
                    inferredRole: inferDrawingFileRole(file.originalName)
                  }))
                }
              };
            })
          }
        },
        include: importBatchInclude
      });
      const audit = await writeAudit(client, {
        action: AUDIT_ACTIONS.MECHANICAL_DRAWING_IMPORT_CREATED,
        objectType: AUDIT_OBJECT_TYPES.MECHANICAL_DRAWING_IMPORT_BATCH,
        objectId: batch.id,
        context: auditContext(input, reason),
        after: {
          value: {
            projectId: batch.projectId,
            batchId: batch.id,
            batchStatus: batch.status,
            batchVersion: batch.version
          },
          allowedFields: MECHANICAL_DRAWING_AUDIT_FIELDS
        }
      });
      const outbox = await appendOutboxEvent(client, {
        eventType: "drawing.import.created",
        aggregateType: "MECHANICAL_DRAWING_IMPORT_BATCH",
        aggregateId: batch.id,
        idempotencyKey: `${batch.id}:v${batch.version}`,
        payload: { projectId: batch.projectId, batchId: batch.id, itemCount: batch.items.length }
      });
      return {
        batch: serializeImportBatch(batch),
        resourceVersion: batch.version,
        auditId: audit.id,
        outboxEventId: outbox.id
      };
    });
  } catch (error) {
    drawingError(error);
  }
}

type ImportDecision =
  | {
      itemId: string;
      action: "CONFIRM";
      drawingNumber: unknown;
      title: unknown;
      drawingType: unknown;
    }
  | { itemId: string; action: "REJECT" };

export async function confirmMechanicalDrawingImportBatch(
  input: {
    projectId: string;
    batchId: string;
    version: unknown;
    decisions: ImportDecision[];
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
      const batch = await lockImportBatch(client, input.projectId, input.batchId);
      if (!batch)
        throw new DrawingError("DRAWING_IMPORT_BATCH_NOT_FOUND", "图纸导入批次不存在。", 404);
      if (batch.status !== "PENDING_CONFIRMATION") {
        throw new DrawingError("DRAWING_IMPORT_BATCH_FINALIZED", "图纸导入批次已完成确认。", 409);
      }
      if (batch.version !== expectedVersion) {
        throw new DrawingError("VERSION_CONFLICT", "图纸导入批次已发生变化，请刷新后重试。", 409);
      }
      const pending = batch.items.filter((item) => item.status === "PENDING");
      if (
        input.decisions.length !== pending.length ||
        new Set(input.decisions.map((decision) => decision.itemId)).size !== pending.length ||
        input.decisions.some((decision) => !pending.some((item) => item.id === decision.itemId))
      ) {
        throw new DrawingError(
          "DRAWING_IMPORT_DECISIONS_INVALID",
          "必须为批次中的每个待确认项提交唯一决定。",
          422
        );
      }
      for (const decision of input.decisions) {
        const item = pending.find((candidate) => candidate.id === decision.itemId);
        if (!item)
          throw new DrawingError("DRAWING_IMPORT_ITEM_NOT_FOUND", "图纸导入项不存在。", 404);
        if (decision.action === "REJECT") {
          await client.mechanicalDrawingImportItem.update({
            where: { id: item.id },
            data: { status: "REJECTED" }
          });
          continue;
        }
        const cadFiles = item.files.filter(
          (file) => file.inferredRole === DRAWING_FILE_ROLES.CAD_SOURCE
        );
        const pdfFiles = item.files.filter(
          (file) => file.inferredRole === DRAWING_FILE_ROLES.PDF_PREVIEW
        );
        const stepFiles = item.files.filter(
          (file) => file.inferredRole === DRAWING_FILE_ROLES.STEP_EXCHANGE
        );
        if (cadFiles.length !== 1 || pdfFiles.length > 1 || stepFiles.length > 1) {
          throw new DrawingError(
            "DRAWING_IMPORT_PAIRING_UNRESOLVED",
            "确认图纸前必须人工解决文件配对歧义。",
            409
          );
        }
        const created = await createMechanicalDrawing(
          {
            projectId: input.projectId,
            drawingNumber: decision.drawingNumber,
            title: decision.title,
            drawingType: decision.drawingType,
            cadSourceFileId: cadFiles[0]!.fileId,
            pdfPreviewFileId: pdfFiles[0]?.fileId ?? null,
            stepExchangeFileIds: stepFiles.map((file) => file.fileId),
            reason,
            actorId: input.actorId,
            auditContext: auditContext(input, reason),
            sourceFileAccess: input.sourceFileAccess
          },
          client
        );
        await client.mechanicalDrawingImportItem.update({
          where: { id: item.id },
          data: {
            status: "CONFIRMED",
            confirmedDrawingId: created.drawing.id,
            drawingNumber: validateDrawingNumber(decision.drawingNumber),
            title: validateDocumentTitle(decision.title),
            drawingType: validateDrawingType(decision.drawingType)
          }
        });
      }
      const updated = await client.mechanicalDrawingImportBatch.updateMany({
        where: {
          id: batch.id,
          projectId: input.projectId,
          version: expectedVersion,
          status: "PENDING_CONFIRMATION"
        },
        data: { status: "CONFIRMED", version: { increment: 1 } }
      });
      if (updated.count !== 1)
        throw new DrawingError("VERSION_CONFLICT", "图纸导入批次已发生变化，请刷新后重试。", 409);
      const refreshed = await client.mechanicalDrawingImportBatch.findUniqueOrThrow({
        where: { id: batch.id },
        include: importBatchInclude
      });
      const audit = await writeAudit(client, {
        action: AUDIT_ACTIONS.MECHANICAL_DRAWING_IMPORT_CONFIRMED,
        objectType: AUDIT_OBJECT_TYPES.MECHANICAL_DRAWING_IMPORT_BATCH,
        objectId: batch.id,
        context: auditContext(input, reason),
        after: {
          value: {
            projectId: refreshed.projectId,
            batchId: refreshed.id,
            batchStatus: refreshed.status,
            batchVersion: refreshed.version
          },
          allowedFields: MECHANICAL_DRAWING_AUDIT_FIELDS
        }
      });
      const outbox = await appendOutboxEvent(client, {
        eventType: "drawing.import.confirmed",
        aggregateType: "MECHANICAL_DRAWING_IMPORT_BATCH",
        aggregateId: refreshed.id,
        idempotencyKey: `${refreshed.id}:v${refreshed.version}`,
        payload: { projectId: refreshed.projectId, batchId: refreshed.id, status: refreshed.status }
      });
      return {
        batch: serializeImportBatch(refreshed),
        resourceVersion: refreshed.version,
        auditId: audit.id,
        outboxEventId: outbox.id
      };
    });
  } catch (error) {
    drawingError(error);
  }
}
