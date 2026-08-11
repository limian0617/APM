import { randomUUID } from "node:crypto";

import { beforeAll, describe, expect, it } from "vitest";

import { db } from "@/lib/db";
import type { AuditContext } from "@/modules/audit/contracts/audit";
import {
  addDrawingSelectionItem,
  createDrawingSelectionSet,
  lockDrawingSelectionSet
} from "@/modules/drawings/application/drawing-selection-service";

const describeDatabase = process.env.RUN_DATABASE_INTEGRATION === "1" ? describe : describe.skip;
const suffix = randomUUID().slice(0, 8).toUpperCase();
const ids = {
  actor: `drawing-selection-actor-${suffix}`,
  project: `drawing-selection-project-${suffix}`
};
const auditContext: AuditContext = {
  actorId: null,
  requestId: `drawing-selection-request-${suffix}`,
  traceId: null,
  source: "API",
  sourceIp: null,
  userAgent: null,
  reason: null,
  projectId: ids.project,
  departmentId: null,
  operationId: `drawing-selection-operation-${suffix}`
};

describeDatabase("APM-053 drawing-selection transactional integration", () => {
  let drawingId = "";
  let documentVersionId = "";

  beforeAll(async () => {
    await db.user.create({
      data: {
        id: ids.actor,
        employeeNo: `DRAWING-SELECTION-${suffix}`,
        name: "Drawing selection integration tester",
        departmentId: "engineering"
      }
    });
    await db.project.create({
      data: {
        id: ids.project,
        code: `DS-${suffix}`,
        name: "Drawing selection integration project",
        departmentId: "engineering",
        createdById: ids.actor
      }
    });

    const category = await db.manufacturingCategory.findUniqueOrThrow({
      where: { code: "MACHINING" }
    });
    const file = await db.fileObject.create({
      data: {
        projectId: ids.project,
        uploadedById: ids.actor,
        originalName: "DS-001.dwg",
        declaredMimeType: "application/octet-stream",
        verifiedMimeType: "application/octet-stream",
        declaredSize: 1024n,
        verifiedSize: 1024n,
        sha256: "b".repeat(64),
        objectKey: randomUUID(),
        storageArea: "CONTROLLED",
        status: "AVAILABLE",
        sensitivity: "INTERNAL",
        scannedAt: new Date()
      }
    });

    await db.$transaction(async (tx) => {
      const document = await tx.controlledDocument.create({
        data: {
          projectId: ids.project,
          code: `DS-001-${suffix}`,
          title: "DS-001",
          createdById: ids.actor
        }
      });
      const version = await tx.controlledDocumentVersion.create({
        data: {
          documentId: document.id,
          projectId: ids.project,
          version: 1,
          sourceFileId: file.id,
          sourceFileSha256: file.sha256!,
          sourceMimeType: file.verifiedMimeType!,
          sourceFileSize: file.verifiedSize!,
          createdById: ids.actor,
          status: "PUBLISHED",
          publishedById: ids.actor,
          publishedAt: new Date()
        }
      });
      await tx.controlledDocument.update({
        where: { id: document.id },
        data: { currentPublishedVersionId: version.id, version: { increment: 1 } }
      });
      const drawing = await tx.mechanicalDrawing.create({
        data: {
          projectId: ids.project,
          documentId: document.id,
          drawingNumber: "DS-001",
          drawingType: "PART",
          manufacturingCategoryId: category.id,
          createdById: ids.actor
        }
      });
      await tx.mechanicalDrawingVersionFile.create({
        data: {
          projectId: ids.project,
          drawingId: drawing.id,
          documentVersionId: version.id,
          fileId: file.id,
          role: "CAD_SOURCE",
          fileSha256: file.sha256!,
          fileMimeType: file.verifiedMimeType!,
          fileSize: file.verifiedSize!
        }
      });
      drawingId = drawing.id;
      documentVersionId = version.id;
    });
  });

  it("creates, populates, and locks an exact-version selection set atomically", async () => {
    const selection = await createDrawingSelectionSet({
      projectId: ids.project,
      code: `SET-${suffix}`,
      title: "Internal inquiry",
      actorId: ids.actor,
      reason: "integration setup",
      auditContext
    });
    await addDrawingSelectionItem({
      projectId: ids.project,
      selectionSetId: selection.selectionSet.id,
      drawingId,
      documentVersionId,
      quantity: 1,
      spareQuantity: 0,
      requiredOn: new Date("2026-09-01"),
      supplierReferenceId: null,
      purpose: "INQUIRY",
      exceptionReason: null,
      version: selection.resourceVersion,
      actorId: ids.actor,
      reason: "add exact released drawing",
      auditContext
    });
    const locked = await lockDrawingSelectionSet({
      projectId: ids.project,
      selectionSetId: selection.selectionSet.id,
      version: selection.resourceVersion + 1,
      actorId: ids.actor,
      reason: "review complete",
      auditContext
    });
    expect(locked.selectionSet.status).toBe("LOCKED");
    expect(locked.selectionSet.items).toHaveLength(1);
  });
});
