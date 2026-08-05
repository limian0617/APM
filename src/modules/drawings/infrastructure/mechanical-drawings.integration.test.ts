import { randomUUID } from "node:crypto";

import { beforeAll, describe, expect, it } from "vitest";

import { GET as getMechanicalDrawingRoute } from "@/app/api/projects/[projectId]/drawings/[drawingId]/route";
import { POST as createMechanicalDrawingRoute } from "@/app/api/projects/[projectId]/drawings/route";
import { db } from "@/lib/db";
import type { AuditContext } from "@/modules/audit/contracts/audit";
import {
  confirmMechanicalDrawingImportBatch,
  createMechanicalDrawing,
  createMechanicalDrawingDraft,
  createMechanicalDrawingImportBatch,
  publishMechanicalDrawingVersion
} from "@/modules/drawings/application/mechanical-drawing-service";

const describeDatabase = process.env.RUN_DATABASE_INTEGRATION === "1" ? describe : describe.skip;
const suffix = randomUUID().slice(0, 8);
const ids = {
  admin: `drawing-admin-${suffix}`,
  projectA: `drawing-project-a-${suffix}`,
  projectB: `drawing-project-b-${suffix}`
};

function context(actorId: string, operationId: string, projectId = ids.projectA): AuditContext {
  return {
    actorId,
    requestId: `request-${operationId}`,
    traceId: `trace-${operationId}`,
    source: "API",
    sourceIp: "127.0.0.1",
    userAgent: "Vitest",
    reason: null,
    projectId,
    departmentId: "engineering",
    operationId
  };
}

function commandRequest(url: string, body: unknown, key: string) {
  return new Request(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "idempotency-key": key,
      "x-apm-user-id": ids.admin,
      "x-request-id": `request-${key}`
    },
    body: JSON.stringify(body)
  });
}

async function availableFile(projectId: string, originalName: string) {
  return db.fileObject.create({
    data: {
      projectId,
      uploadedById: ids.admin,
      originalName,
      declaredMimeType: originalName.endsWith(".pdf")
        ? "application/pdf"
        : "application/octet-stream",
      verifiedMimeType: originalName.endsWith(".pdf")
        ? "application/pdf"
        : "application/octet-stream",
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

describeDatabase("APM-052 PostgreSQL mechanical drawings", () => {
  beforeAll(async () => {
    await db.user.create({
      data: {
        id: ids.admin,
        employeeNo: `DRAWING-ADMIN-${suffix}`,
        name: "Drawing administrator",
        departmentId: "engineering"
      }
    });
    await db.userRole.create({
      data: { id: `drawing-admin-role-${suffix}`, userId: ids.admin, roleId: "role-admin" }
    });
    await db.project.createMany({
      data: [
        {
          id: ids.projectA,
          code: `DRAWING-A-${suffix}`.toUpperCase(),
          name: "机械图纸测试项目 A",
          departmentId: "engineering",
          createdById: ids.admin
        },
        {
          id: ids.projectB,
          code: `DRAWING-B-${suffix}`.toUpperCase(),
          name: "机械图纸测试项目 B",
          departmentId: "engineering",
          createdById: ids.admin
        }
      ]
    });
  });

  it("freezes exact CAD, PDF, and STEP files on each drawing document version", async () => {
    const cadOne = await availableFile(ids.projectA, "DWG-100.dwg");
    const pdfOne = await availableFile(ids.projectA, "DWG-100.pdf");
    const stepOne = await availableFile(ids.projectA, "DWG-100.step");
    const created = await createMechanicalDrawing({
      projectId: ids.projectA,
      drawingNumber: "dwg-100",
      title: "总装图",
      drawingType: "assembly",
      cadSourceFileId: cadOne.id,
      pdfPreviewFileId: pdfOne.id,
      stepExchangeFileIds: [stepOne.id],
      reason: "创建首版总装图",
      actorId: ids.admin,
      auditContext: context(ids.admin, `create-${suffix}`)
    });
    const firstVersion = created.drawing.document.versions[0]!;
    expect(created.drawing).toMatchObject({
      drawingNumber: "DWG-100",
      drawingType: "ASSEMBLY",
      versionFiles: [
        { role: "CAD_SOURCE", fileId: cadOne.id, fileSha256: cadOne.sha256 },
        { role: "PDF_PREVIEW", fileId: pdfOne.id, fileSha256: pdfOne.sha256 },
        { role: "STEP_EXCHANGE", fileId: stepOne.id, fileSha256: stepOne.sha256 }
      ]
    });

    const published = await publishMechanicalDrawingVersion({
      projectId: ids.projectA,
      drawingId: created.drawing.id,
      documentVersionId: firstVersion.id,
      version: created.resourceVersion,
      reason: "发布首版总装图",
      actorId: ids.admin,
      auditContext: context(ids.admin, `publish-one-${suffix}`)
    });
    const cadTwo = await availableFile(ids.projectA, "DWG-100-R2.dwg");
    const pdfTwo = await availableFile(ids.projectA, "DWG-100-R2.pdf");
    const drafted = await createMechanicalDrawingDraft({
      projectId: ids.projectA,
      drawingId: created.drawing.id,
      version: published.resourceVersion,
      cadSourceFileId: cadTwo.id,
      pdfPreviewFileId: pdfTwo.id,
      stepExchangeFileIds: [],
      reason: "设计修订建立第二版",
      actorId: ids.admin,
      auditContext: context(ids.admin, `draft-two-${suffix}`)
    });

    expect(drafted.drawing.versionFiles).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ documentVersion: 1, role: "CAD_SOURCE", fileId: cadOne.id }),
        expect.objectContaining({ documentVersion: 1, role: "PDF_PREVIEW", fileId: pdfOne.id }),
        expect.objectContaining({ documentVersion: 2, role: "CAD_SOURCE", fileId: cadTwo.id }),
        expect.objectContaining({ documentVersion: 2, role: "PDF_PREVIEW", fileId: pdfTwo.id })
      ])
    );
    await expect(
      db.mechanicalDrawingVersionFile.update({
        where: {
          documentVersionId_role: { documentVersionId: firstVersion.id, role: "CAD_SOURCE" }
        },
        data: { fileSha256: "b".repeat(64) }
      })
    ).rejects.toThrow(/immutable/u);
  });

  it("requires human confirmation for filename pairs and rejects cross-project attachment", async () => {
    const cad = await availableFile(ids.projectA, "DWG-200.dwg");
    const pdf = await availableFile(ids.projectA, "DWG-200.pdf");
    const unmatched = await availableFile(ids.projectA, "DWG-201.pdf");
    const foreign = await availableFile(ids.projectB, "DWG-202.dwg");
    const batch = await createMechanicalDrawingImportBatch({
      projectId: ids.projectA,
      fileIds: [cad.id, pdf.id, unmatched.id],
      reason: "识别待确认的图纸文件",
      actorId: ids.admin,
      auditContext: context(ids.admin, `import-${suffix}`)
    });
    expect(batch.batch.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ filenameStem: "DWG-200", pairingStatus: "PAIRED" }),
        expect.objectContaining({ filenameStem: "DWG-201", pairingStatus: "UNPAIRED" })
      ])
    );
    await expect(
      createMechanicalDrawing({
        projectId: ids.projectA,
        drawingNumber: "DWG-202",
        title: "跨项目文件",
        drawingType: "PART",
        cadSourceFileId: foreign.id,
        pdfPreviewFileId: null,
        stepExchangeFileIds: [],
        reason: "不得引用其他项目文件",
        actorId: ids.admin,
        auditContext: context(ids.admin, `foreign-${suffix}`)
      })
    ).rejects.toMatchObject({ code: "DRAWING_FILE_NOT_FOUND", status: 404 });

    const paired = batch.batch.items.find(({ filenameStem }) => filenameStem === "DWG-200")!;
    const unpaired = batch.batch.items.find(({ filenameStem }) => filenameStem === "DWG-201")!;
    const confirmed = await confirmMechanicalDrawingImportBatch({
      projectId: ids.projectA,
      batchId: batch.batch.id,
      version: batch.resourceVersion,
      decisions: [
        {
          itemId: paired.id,
          action: "CONFIRM",
          drawingNumber: "DWG-200",
          title: "批量确认总装图",
          drawingType: "ASSEMBLY"
        },
        { itemId: unpaired.id, action: "REJECT" }
      ],
      reason: "人工确认批量导入结果",
      actorId: ids.admin,
      auditContext: context(ids.admin, `confirm-${suffix}`)
    });
    expect(confirmed.batch).toMatchObject({ status: "CONFIRMED" });
    expect(confirmed.batch.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: paired.id, status: "CONFIRMED", drawingNumber: "DWG-200" }),
        expect.objectContaining({ id: unpaired.id, status: "REJECTED" })
      ])
    );
    await expect(
      db.outboxEvent.count({ where: { aggregateType: "MECHANICAL_DRAWING" } })
    ).resolves.toBeGreaterThanOrEqual(1);
  });

  it("enforces command idempotency and project-scoped drawing reads at the API boundary", async () => {
    const cad = await availableFile(ids.projectA, "DWG-300.dwg");
    const pdf = await availableFile(ids.projectA, "DWG-300.pdf");
    const url = `http://localhost/api/projects/${ids.projectA}/drawings`;
    const body = {
      drawingNumber: "DWG-300",
      title: "接口验收图",
      drawingType: "ASSEMBLY",
      cadSourceFileId: cad.id,
      pdfPreviewFileId: pdf.id,
      stepExchangeFileIds: [],
      reason: "验证 API 幂等和项目隔离"
    };
    const key = `drawing-create-${suffix}`;
    const first = await createMechanicalDrawingRoute(commandRequest(url, body, key), {
      params: Promise.resolve({ projectId: ids.projectA })
    });
    const replay = await createMechanicalDrawingRoute(commandRequest(url, body, key), {
      params: Promise.resolve({ projectId: ids.projectA })
    });
    expect(first.status).toBe(201);
    expect(replay.status).toBe(201);
    expect(replay.headers.get("idempotency-replayed")).toBe("true");
    const created = (await first.json()) as { drawing: { id: string } };
    const foreignRead = await getMechanicalDrawingRoute(
      new Request(`http://localhost/api/projects/${ids.projectB}/drawings/${created.drawing.id}`, {
        headers: { "x-apm-user-id": ids.admin, "x-request-id": `read-${suffix}` }
      }),
      { params: Promise.resolve({ projectId: ids.projectB, drawingId: created.drawing.id }) }
    );
    expect(foreignRead.status).toBe(404);
  });
});
