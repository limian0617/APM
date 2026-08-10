import { randomUUID } from "node:crypto";

import { Prisma } from "@prisma/client";
import { beforeAll, describe, expect, it } from "vitest";

import { db } from "@/lib/db";

const describeDatabase = process.env.RUN_DATABASE_INTEGRATION === "1" ? describe : describe.skip;
const suffix = randomUUID().slice(0, 8).toUpperCase();
const ids = {
  actor: `manufacturing-classification-actor-${suffix}`,
  projectA: `manufacturing-classification-project-a-${suffix}`,
  projectB: `manufacturing-classification-project-b-${suffix}`
};
let sequence = 0;

function nextCode(prefix: string) {
  sequence += 1;
  return `${prefix}.${suffix}.${sequence}`;
}

async function availableCadFile(projectId: string, label: string) {
  return db.fileObject.create({
    data: {
      projectId,
      uploadedById: ids.actor,
      originalName: `${label}.dwg`,
      declaredMimeType: "application/octet-stream",
      verifiedMimeType: "application/octet-stream",
      declaredSize: 1024n,
      verifiedSize: 1024n,
      sha256: randomUUID().replaceAll("-", "").padEnd(64, "a"),
      objectKey: randomUUID(),
      storageArea: "CONTROLLED",
      status: "AVAILABLE",
      sensitivity: "INTERNAL",
      scannedAt: new Date()
    }
  });
}

async function unavailableDrawingFile(
  projectId: string,
  label: string,
  storageArea: "CONTROLLED" | "QUARANTINE",
  scannedAt: Date | null
) {
  return db.fileObject.create({
    data: {
      projectId,
      uploadedById: ids.actor,
      originalName: `${label}.pdf`,
      declaredMimeType: "application/pdf",
      verifiedMimeType: "application/pdf",
      declaredSize: 1024n,
      verifiedSize: 1024n,
      sha256: randomUUID().replaceAll("-", "").padEnd(64, "a"),
      objectKey: randomUUID(),
      storageArea,
      status: "PENDING_SCAN",
      sensitivity: "INTERNAL",
      scannedAt
    }
  });
}

async function createPublishedDocument(
  tx: Prisma.TransactionClient,
  projectId: string,
  code: string,
  sourceFile: Awaited<ReturnType<typeof availableCadFile>>
) {
  const document = await tx.controlledDocument.create({
    data: {
      projectId,
      code,
      title: `${code} drawing`,
      createdById: ids.actor
    }
  });
  const draft = await tx.controlledDocumentVersion.create({
    data: {
      documentId: document.id,
      projectId,
      version: 1,
      sourceFileId: sourceFile.id,
      sourceFileSha256: sourceFile.sha256!,
      sourceMimeType: sourceFile.verifiedMimeType!,
      sourceFileSize: sourceFile.verifiedSize!,
      createdById: ids.actor
    }
  });
  const version = await tx.controlledDocumentVersion.update({
    where: { id: draft.id },
    data: {
      status: "PUBLISHED",
      publishedById: ids.actor,
      publishedAt: new Date()
    }
  });
  await tx.controlledDocument.update({
    where: { id: document.id },
    data: {
      currentPublishedVersionId: version.id,
      version: { increment: 1 }
    }
  });
  return { document, version };
}

async function createPublishedDrawing(projectId: string, label: string) {
  const [category, cad] = await Promise.all([
    db.manufacturingCategory.findUniqueOrThrow({ where: { code: "MACHINING" } }),
    availableCadFile(projectId, label)
  ]);
  const drawingNumber = nextCode("DWG");

  return db.$transaction(async (tx) => {
    const { document, version } = await createPublishedDocument(tx, projectId, drawingNumber, cad);
    const drawing = await tx.mechanicalDrawing.create({
      data: {
        projectId,
        documentId: document.id,
        drawingNumber,
        drawingType: "PART",
        manufacturingCategoryId: category.id,
        createdById: ids.actor
      }
    });
    await tx.mechanicalDrawingVersionFile.create({
      data: {
        projectId,
        drawingId: drawing.id,
        documentVersionId: version.id,
        fileId: cad.id,
        role: "CAD_SOURCE",
        fileSha256: cad.sha256!,
        fileMimeType: cad.verifiedMimeType!,
        fileSize: cad.verifiedSize!
      }
    });
    return { cad, document, drawing, version };
  });
}

async function createSelectionSet(projectId: string) {
  return db.drawingSelectionSet.create({
    data: {
      projectId,
      code: nextCode("SET"),
      title: "Manufacturing classification integration selection",
      createdById: ids.actor
    }
  });
}

function selectionItemData(
  selectionSetId: string,
  drawing: Awaited<ReturnType<typeof createPublishedDrawing>>,
  documentVersionId = drawing.version.id,
  documentVersion = drawing.version.version
) {
  return {
    projectId: drawing.drawing.projectId,
    selectionSetId,
    drawingId: drawing.drawing.id,
    documentVersionId,
    manufacturingCategoryCodeSnapshot: "MACHINING",
    processTagCodesSnapshotJson: [],
    drawingNumberSnapshot: drawing.drawing.drawingNumber,
    drawingVersionSnapshot: documentVersion,
    quantity: new Prisma.Decimal("1"),
    spareQuantity: new Prisma.Decimal("0"),
    requiredOn: new Date("2026-08-11"),
    purpose: "INQUIRY" as const,
    supplierMatchState: "NO_MATCH" as const,
    createdById: ids.actor
  };
}

async function assertLegacyNullCategoryUpdateIsAllowed() {
  const tableName = `apm053_legacy_drawings_${suffix.toLowerCase()}`;

  return db.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(
      `CREATE TEMP TABLE "${tableName}" (
        "id" TEXT PRIMARY KEY,
        "manufacturing_category_id" TEXT,
        "marker" INTEGER NOT NULL DEFAULT 0
      ) ON COMMIT DROP`
    );
    await tx.$executeRawUnsafe(
      `CREATE TRIGGER legacy_null_category_guard
        BEFORE INSERT OR UPDATE ON "${tableName}"
        FOR EACH ROW EXECUTE FUNCTION validate_active_manufacturing_category_assignment()`
    );
    await tx.$executeRawUnsafe(
      `ALTER TABLE "${tableName}" DISABLE TRIGGER legacy_null_category_guard`
    );
    await tx.$executeRawUnsafe(
      `INSERT INTO "${tableName}" ("id", "manufacturing_category_id") VALUES ('legacy', NULL)`
    );
    await tx.$executeRawUnsafe(
      `ALTER TABLE "${tableName}" ENABLE TRIGGER legacy_null_category_guard`
    );
    return tx.$executeRawUnsafe(`UPDATE "${tableName}" SET "marker" = 1 WHERE "id" = 'legacy'`);
  });
}

async function expectInvalidDrawingFileSelectionToFail(
  selectionSetId: string,
  drawing: Awaited<ReturnType<typeof createPublishedDrawing>>,
  file: Awaited<ReturnType<typeof unavailableDrawingFile>>
) {
  await expect(
    db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(
        'ALTER TABLE "mechanical_drawing_version_files" DISABLE TRIGGER mechanical_drawing_version_files_validate'
      );
      await tx.mechanicalDrawingVersionFile.create({
        data: {
          projectId: drawing.drawing.projectId,
          drawingId: drawing.drawing.id,
          documentVersionId: drawing.version.id,
          fileId: file.id,
          role: "PDF_PREVIEW",
          fileSha256: file.sha256!,
          fileMimeType: file.verifiedMimeType!,
          fileSize: file.verifiedSize!
        }
      });
      await tx.$executeRawUnsafe(
        'ALTER TABLE "mechanical_drawing_version_files" ENABLE TRIGGER mechanical_drawing_version_files_validate'
      );
      return tx.drawingSelectionItem.create({ data: selectionItemData(selectionSetId, drawing) });
    })
  ).rejects.toThrow(/requires scanned controlled drawing files/u);
}

describeDatabase("APM-053 PostgreSQL manufacturing classification persistence", () => {
  beforeAll(async () => {
    await db.user.create({
      data: {
        id: ids.actor,
        employeeNo: `MANUFACTURING-CLASSIFICATION-${suffix}`,
        name: "Manufacturing classification database tester",
        departmentId: "engineering"
      }
    });
    await db.project.createMany({
      data: [
        {
          id: ids.projectA,
          code: `MC-A-${suffix}`,
          name: "Manufacturing classification project A",
          departmentId: "engineering",
          createdById: ids.actor
        },
        {
          id: ids.projectB,
          code: `MC-B-${suffix}`,
          name: "Manufacturing classification project B",
          departmentId: "engineering",
          createdById: ids.actor
        }
      ]
    });
  });

  it("rejects new or cleared null categories while allowing an unchanged legacy null update", async () => {
    const drawing = await createPublishedDrawing(ids.projectA, "legacy-null-category");
    const source = await availableCadFile(ids.projectA, "new-null-category");

    await expect(
      db.mechanicalDrawing.update({
        where: { id: drawing.drawing.id },
        data: { manufacturingCategoryId: null, version: { increment: 1 } }
      })
    ).rejects.toThrow(/require a manufacturing category/u);

    await expect(
      db.$transaction(async (tx) => {
        const code = nextCode("DWG");
        const { document } = await createPublishedDocument(tx, ids.projectA, code, source);
        return tx.mechanicalDrawing.create({
          data: {
            projectId: ids.projectA,
            documentId: document.id,
            drawingNumber: code,
            drawingType: "PART",
            manufacturingCategoryId: null,
            createdById: ids.actor
          }
        });
      })
    ).rejects.toThrow(/require a manufacturing category/u);

    await expect(assertLegacyNullCategoryUpdateIsAllowed()).resolves.toBe(1);
  });

  it("rejects cross-project, mismatched, and unpublished drawing versions", async () => {
    const [drawingA, drawingAOther, drawingB] = await Promise.all([
      createPublishedDrawing(ids.projectA, "same-project-primary"),
      createPublishedDrawing(ids.projectA, "same-project-other"),
      createPublishedDrawing(ids.projectB, "foreign-project")
    ]);
    const selectionSet = await createSelectionSet(ids.projectA);

    await expect(
      db.drawingSelectionItem.create({
        data: {
          ...selectionItemData(selectionSet.id, drawingA),
          drawingId: drawingB.drawing.id
        }
      })
    ).rejects.toThrow();
    await expect(
      db.drawingSelectionItem.create({
        data: selectionItemData(
          selectionSet.id,
          drawingA,
          drawingAOther.version.id,
          drawingAOther.version.version
        )
      })
    ).rejects.toThrow(/exact published drawing version/u);
    await expect(
      db.$transaction(async (tx) => {
        const draft = await tx.controlledDocumentVersion.create({
          data: {
            documentId: drawingA.document.id,
            projectId: ids.projectA,
            version: 2,
            sourceFileId: drawingA.cad.id,
            sourceFileSha256: drawingA.cad.sha256!,
            sourceMimeType: drawingA.cad.verifiedMimeType!,
            sourceFileSize: drawingA.cad.verifiedSize!,
            createdById: ids.actor
          }
        });
        return tx.drawingSelectionItem.create({
          data: selectionItemData(selectionSet.id, drawingA, draft.id, draft.version)
        });
      })
    ).rejects.toThrow(/exact published drawing version/u);
  });

  it("rejects unscanned, non-controlled, and missing-CAD drawing-file variants", async () => {
    const drawing = await createPublishedDrawing(ids.projectA, "file-variants");
    const selectionSet = await createSelectionSet(ids.projectA);
    const [unscanned, nonControlled] = await Promise.all([
      unavailableDrawingFile(ids.projectA, "unscanned", "CONTROLLED", null),
      unavailableDrawingFile(ids.projectA, "non-controlled", "QUARANTINE", new Date())
    ]);

    await expectInvalidDrawingFileSelectionToFail(selectionSet.id, drawing, unscanned);
    await expectInvalidDrawingFileSelectionToFail(selectionSet.id, drawing, nonControlled);

    const cad = await availableCadFile(ids.projectA, "missing-cad");
    await expect(
      db.$transaction(async (tx) => {
        const category = await tx.manufacturingCategory.findUniqueOrThrow({
          where: { code: "MACHINING" }
        });
        const drawingNumber = nextCode("DWG");
        const { document, version } = await createPublishedDocument(
          tx,
          ids.projectA,
          drawingNumber,
          cad
        );
        const drawingWithoutCad = await tx.mechanicalDrawing.create({
          data: {
            projectId: ids.projectA,
            documentId: document.id,
            drawingNumber,
            drawingType: "PART",
            manufacturingCategoryId: category.id,
            createdById: ids.actor
          }
        });
        return tx.drawingSelectionItem.create({
          data: {
            ...selectionItemData(selectionSet.id, drawing),
            drawingId: drawingWithoutCad.id,
            documentVersionId: version.id,
            drawingNumberSnapshot: drawingWithoutCad.drawingNumber,
            drawingVersionSnapshot: version.version
          }
        });
      })
    ).rejects.toThrow(/requires scanned controlled drawing files/u);
  });

  it("prevents locked selection-set and selection-item mutation, deletion, and truncation", async () => {
    const drawing = await createPublishedDrawing(ids.projectA, "locked-selection");
    const selectionSet = await createSelectionSet(ids.projectA);
    const item = await db.drawingSelectionItem.create({
      data: selectionItemData(selectionSet.id, drawing)
    });
    const locked = await db.drawingSelectionSet.update({
      where: { id: selectionSet.id },
      data: { status: "LOCKED", version: { increment: 1 } }
    });

    await expect(
      db.drawingSelectionSet.update({
        where: { id: locked.id },
        data: { version: { increment: 1 } }
      })
    ).rejects.toThrow(/locked drawing selection sets are immutable/u);
    await expect(db.drawingSelectionSet.delete({ where: { id: locked.id } })).rejects.toThrow(
      /locked drawing selection sets are immutable/u
    );
    await expect(
      db.drawingSelectionItem.update({
        where: { id: item.id },
        data: { version: { increment: 1 } }
      })
    ).rejects.toThrow(/locked drawing selection items are immutable/u);
    await expect(db.drawingSelectionItem.delete({ where: { id: item.id } })).rejects.toThrow(
      /locked drawing selection items are immutable/u
    );
    await expect(db.$executeRawUnsafe('TRUNCATE TABLE "drawing_selection_items"')).rejects.toThrow(
      /drawing selection facts must be retained instead of removed/u
    );
    await expect(
      db.$executeRawUnsafe('TRUNCATE TABLE "drawing_selection_sets" CASCADE')
    ).rejects.toThrow(/drawing selection facts must be retained instead of removed/u);
  });

  it("rejects configuration deletion and plain or cascading capability truncation", async () => {
    const [category, processTag] = await Promise.all([
      db.manufacturingCategory.create({
        data: { code: nextCode("CATEGORY"), name: "Test category" }
      }),
      db.processTag.create({ data: { code: nextCode("PROCESS"), name: "Test process" } })
    ]);
    const [machining, milling] = await Promise.all([
      db.manufacturingCategory.findUniqueOrThrow({ where: { code: "MACHINING" } }),
      db.processTag.findUniqueOrThrow({ where: { code: "MILLING" } })
    ]);
    const supplier = await db.supplierReference.create({
      data: {
        projectId: ids.projectA,
        source: "LOCAL",
        code: nextCode("SUPPLIER"),
        name: "Manufacturing capability supplier",
        createdById: ids.actor,
        updatedById: ids.actor
      }
    });
    const capability = await db.supplierReferenceManufacturingCapability.create({
      data: {
        projectId: ids.projectA,
        supplierReferenceId: supplier.id,
        manufacturingCategoryId: machining.id
      }
    });
    await db.supplierReferenceProcessCapability.create({
      data: {
        projectId: ids.projectA,
        supplierCapabilityId: capability.id,
        processTagId: milling.id
      }
    });

    await expect(db.manufacturingCategory.delete({ where: { id: category.id } })).rejects.toThrow(
      /must be disabled instead of removed/u
    );
    await expect(db.processTag.delete({ where: { id: processTag.id } })).rejects.toThrow(
      /must be disabled instead of removed/u
    );
    await expect(
      db.$executeRawUnsafe('TRUNCATE TABLE "supplier_reference_manufacturing_capabilities"')
    ).rejects.toThrow(/must be disabled instead of removed/u);
    await expect(
      db.$executeRawUnsafe('TRUNCATE TABLE "supplier_reference_manufacturing_capabilities" CASCADE')
    ).rejects.toThrow(/must be disabled instead of removed/u);
    await expect(
      db.$executeRawUnsafe('TRUNCATE TABLE "supplier_reference_process_capabilities"')
    ).rejects.toThrow(/must be disabled instead of removed/u);
    await expect(
      db.$executeRawUnsafe('TRUNCATE TABLE "supplier_reference_process_capabilities" CASCADE')
    ).rejects.toThrow(/must be disabled instead of removed/u);
  });
});
