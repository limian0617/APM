import { randomUUID } from "node:crypto";

import { beforeAll, describe, expect, it } from "vitest";

import { GET as getMechanicalDrawingRoute } from "@/app/api/projects/[projectId]/drawings/[drawingId]/route";
import {
  GET as listMechanicalDrawingsRoute,
  POST as createMechanicalDrawingRoute
} from "@/app/api/projects/[projectId]/drawings/route";
import { POST as confirmMechanicalDrawingImportRoute } from "@/app/api/projects/[projectId]/drawing-imports/[batchId]/confirm/route";
import { POST as createMechanicalDrawingImportRoute } from "@/app/api/projects/[projectId]/drawing-imports/route";
import { POST as publishMechanicalDrawingVersionRoute } from "@/app/api/projects/[projectId]/drawings/[drawingId]/versions/[documentVersionId]/publish/route";
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
  engineer: `drawing-engineer-${suffix}`,
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

function commandRequest(url: string, body: unknown, key: string, actorId = ids.admin) {
  return new Request(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "idempotency-key": key,
      "x-apm-user-id": actorId,
      "x-request-id": `request-${key}`
    },
    body: JSON.stringify(body)
  });
}

async function availableFile(
  projectId: string,
  originalName: string,
  sensitivity: "INTERNAL" | "RESTRICTED" = "INTERNAL"
) {
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
      sensitivity,
      scannedAt: new Date()
    }
  });
}

describeDatabase("APM-052 PostgreSQL mechanical drawings", () => {
  beforeAll(async () => {
    await db.user.createMany({
      data: [
        {
          id: ids.admin,
          employeeNo: `DRAWING-ADMIN-${suffix}`,
          name: "Drawing administrator",
          departmentId: "engineering"
        },
        {
          id: ids.engineer,
          employeeNo: `DRAWING-ENGINEER-${suffix}`,
          name: "Drawing engineer",
          departmentId: "engineering"
        }
      ]
    });
    await db.userRole.createMany({
      data: [
        { id: `drawing-admin-role-${suffix}`, userId: ids.admin, roleId: "role-admin" },
        { id: `drawing-engineer-role-${suffix}`, userId: ids.engineer, roleId: "role-engineer" }
      ]
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
    await db.projectMember.create({
      data: {
        id: `drawing-membership-engineer-${suffix}`,
        projectId: ids.projectA,
        userId: ids.engineer,
        projectRole: "ENGINEER",
        departmentId: "engineering",
        assignedById: ids.admin
      }
    });
  });

  it("denies restricted drawing reads and audits an allowed sensitive read", async () => {
    const cad = await availableFile(ids.projectA, "DWG-RESTRICTED-READ.dwg", "RESTRICTED");
    const createdResponse = await createMechanicalDrawingRoute(
      commandRequest(
        `http://localhost/api/projects/${ids.projectA}/drawings`,
        {
          drawingNumber: `DWG-RESTRICTED-READ-${suffix}`,
          title: "严格受限图纸读取",
          drawingType: "ASSEMBLY",
          cadSourceFileId: cad.id,
          pdfPreviewFileId: null,
          stepExchangeFileIds: [],
          reason: "建立严格受限读取图纸"
        },
        `restricted-read-create-${suffix}`
      ),
      { params: Promise.resolve({ projectId: ids.projectA }) }
    );
    expect(createdResponse.status).toBe(201);
    const created = (await createdResponse.json()) as { drawing: { id: string } };
    const url = `http://localhost/api/projects/${ids.projectA}/drawings/${created.drawing.id}`;

    const denied = await getMechanicalDrawingRoute(
      new Request(url, {
        headers: {
          "x-apm-user-id": ids.engineer,
          "x-request-id": `restricted-read-denied-${suffix}`
        }
      }),
      { params: Promise.resolve({ projectId: ids.projectA, drawingId: created.drawing.id }) }
    );
    expect(denied.status).toBe(403);
    const allowed = await getMechanicalDrawingRoute(
      new Request(url, {
        headers: { "x-apm-user-id": ids.admin, "x-request-id": `restricted-read-allowed-${suffix}` }
      }),
      { params: Promise.resolve({ projectId: ids.projectA, drawingId: created.drawing.id }) }
    );
    expect(allowed.status).toBe(200);
    const listed = await listMechanicalDrawingsRoute(
      new Request(`http://localhost/api/projects/${ids.projectA}/drawings`, {
        headers: { "x-apm-user-id": ids.admin, "x-request-id": `restricted-list-allowed-${suffix}` }
      }),
      { params: Promise.resolve({ projectId: ids.projectA }) }
    );
    expect(listed.status).toBe(200);
    await expect(
      db.auditLog.count({
        where: {
          action: "SENSITIVE_FILE_READ",
          objectType: "FILE_OBJECT",
          objectId: cad.id,
          actorId: ids.admin
        }
      })
    ).resolves.toBe(2);
    await expect(
      db.auditLog.count({
        where: {
          action: "AUTHORIZATION_DENIED",
          objectType: "FILE_OBJECT",
          objectId: cad.id,
          actorId: ids.engineer
        }
      })
    ).resolves.toBe(1);
  });

  it("denies publishing a restricted drawing version without sensitive-file access", async () => {
    const cad = await availableFile(ids.projectA, "DWG-RESTRICTED-PUBLISH.dwg", "RESTRICTED");
    const createdResponse = await createMechanicalDrawingRoute(
      commandRequest(
        `http://localhost/api/projects/${ids.projectA}/drawings`,
        {
          drawingNumber: `DWG-RESTRICTED-PUBLISH-${suffix}`,
          title: "严格受限图纸发布",
          drawingType: "ASSEMBLY",
          cadSourceFileId: cad.id,
          pdfPreviewFileId: null,
          stepExchangeFileIds: [],
          reason: "建立严格受限发布图纸"
        },
        `restricted-publish-create-${suffix}`
      ),
      { params: Promise.resolve({ projectId: ids.projectA }) }
    );
    expect(createdResponse.status).toBe(201);
    const created = (await createdResponse.json()) as {
      drawing: { id: string; document: { versions: Array<{ id: string }> } };
      resourceVersion: number;
    };
    const documentVersionId = created.drawing.document.versions[0]!.id;
    const response = await publishMechanicalDrawingVersionRoute(
      commandRequest(
        `http://localhost/api/projects/${ids.projectA}/drawings/${created.drawing.id}/versions/${documentVersionId}/publish`,
        { version: created.resourceVersion, reason: "无敏感权限不得发布严格受限图纸" },
        `restricted-publish-${suffix}`,
        ids.engineer
      ),
      {
        params: Promise.resolve({
          projectId: ids.projectA,
          drawingId: created.drawing.id,
          documentVersionId
        })
      }
    );
    expect(response.status).toBe(403);
    await expect(
      db.controlledDocumentVersion.findUniqueOrThrow({ where: { id: documentVersionId } })
    ).resolves.toMatchObject({ status: "DRAFT" });
  });

  it("denies confirmation of restricted drawing import candidates without sensitive-file access", async () => {
    const cad = await availableFile(ids.projectA, "DWG-RESTRICTED-IMPORT.dwg", "RESTRICTED");
    const pdf = await availableFile(ids.projectA, "DWG-RESTRICTED-IMPORT.pdf", "RESTRICTED");
    const batchResponse = await createMechanicalDrawingImportRoute(
      commandRequest(
        `http://localhost/api/projects/${ids.projectA}/drawing-imports`,
        { fileIds: [cad.id, pdf.id], reason: "建立严格受限图纸导入候选" },
        `restricted-import-create-${suffix}`
      ),
      { params: Promise.resolve({ projectId: ids.projectA }) }
    );
    expect(batchResponse.status).toBe(201);
    const batch = (await batchResponse.json()) as {
      batch: { id: string; items: Array<{ id: string }> };
      resourceVersion: number;
    };
    const candidate = batch.batch.items[0]!;
    const response = await confirmMechanicalDrawingImportRoute(
      commandRequest(
        `http://localhost/api/projects/${ids.projectA}/drawing-imports/${batch.batch.id}/confirm`,
        {
          version: batch.resourceVersion,
          decisions: [
            {
              itemId: candidate.id,
              action: "CONFIRM",
              drawingNumber: `DWG-RESTRICTED-IMPORT-${suffix}`,
              title: "严格受限批量图纸",
              drawingType: "ASSEMBLY"
            }
          ],
          reason: "无敏感权限不得确认严格受限导入"
        },
        `restricted-import-confirm-${suffix}`,
        ids.engineer
      ),
      { params: Promise.resolve({ projectId: ids.projectA, batchId: batch.batch.id }) }
    );
    expect(response.status).toBe(403);
    await expect(
      db.mechanicalDrawing.count({
        where: { projectId: ids.projectA, drawingNumber: `DWG-RESTRICTED-IMPORT-${suffix}` }
      })
    ).resolves.toBe(0);
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
