import { randomUUID } from "node:crypto";

import { beforeAll, describe, expect, it } from "vitest";

import { GET as readControlledDocumentRoute } from "@/app/api/projects/[projectId]/documents/[documentId]/route";
import { POST as createControlledDocumentRoute } from "@/app/api/projects/[projectId]/documents/route";
import { POST as createControlledDocumentDraftRoute } from "@/app/api/projects/[projectId]/documents/[documentId]/versions/route";
import { db } from "@/lib/db";
import type { AuditContext } from "@/modules/audit/contracts/audit";
import {
  createControlledDocument,
  createControlledDocumentDraft,
  publishControlledDocumentVersion,
  voidControlledDocument
} from "@/modules/documents/application/controlled-document-service";

const describeDatabase = process.env.RUN_DATABASE_INTEGRATION === "1" ? describe : describe.skip;
const suffix = randomUUID().slice(0, 8);
const ids = {
  admin: `document-admin-${suffix}`,
  engineer: `document-engineer-${suffix}`,
  outsider: `document-outsider-${suffix}`,
  projectA: `document-project-a-${suffix}`,
  projectB: `document-project-b-${suffix}`
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

function commandRequest(url: string, body: unknown, key: string, actorId?: string) {
  const headers = new Headers({
    "content-type": "application/json",
    "idempotency-key": key,
    "x-request-id": `request-${key}`
  });
  if (actorId) headers.set("x-apm-user-id", actorId);
  return new Request(url, { method: "POST", headers, body: JSON.stringify(body) });
}

function readRequest(url: string, key: string, actorId: string) {
  return new Request(url, {
    headers: {
      "x-apm-user-id": actorId,
      "x-request-id": `request-${key}`
    }
  });
}

async function availableFile(
  projectId: string,
  label: string,
  sensitivity: "INTERNAL" | "RESTRICTED" = "INTERNAL"
) {
  return db.fileObject.create({
    data: {
      projectId,
      uploadedById: ids.admin,
      originalName: `${label}.pdf`,
      declaredMimeType: "application/pdf",
      verifiedMimeType: "application/pdf",
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

describeDatabase("APM-050 PostgreSQL controlled document facts", () => {
  beforeAll(async () => {
    await db.user.createMany({
      data: [
        {
          id: ids.admin,
          employeeNo: `DOCUMENT-ADMIN-${suffix}`,
          name: "Document administrator",
          departmentId: "engineering"
        },
        {
          id: ids.outsider,
          employeeNo: `DOCUMENT-OUTSIDER-${suffix}`,
          name: "Document outsider",
          departmentId: "engineering"
        },
        {
          id: ids.engineer,
          employeeNo: `DOCUMENT-ENGINEER-${suffix}`,
          name: "Document engineer",
          departmentId: "engineering"
        }
      ]
    });
    await db.userRole.createMany({
      data: [
        { id: `document-role-admin-${suffix}`, userId: ids.admin, roleId: "role-admin" },
        { id: `document-role-outsider-${suffix}`, userId: ids.outsider, roleId: "role-engineer" },
        { id: `document-role-engineer-${suffix}`, userId: ids.engineer, roleId: "role-engineer" }
      ]
    });
    await db.project.createMany({
      data: [
        {
          id: ids.projectA,
          code: `DOCUMENT-A-${suffix}`.toUpperCase(),
          name: "受控文档测试项目 A",
          departmentId: "engineering",
          createdById: ids.admin
        },
        {
          id: ids.projectB,
          code: `DOCUMENT-B-${suffix}`.toUpperCase(),
          name: "受控文档测试项目 B",
          departmentId: "other",
          createdById: ids.admin
        }
      ]
    });
    await db.projectMember.create({
      data: {
        id: `document-membership-engineer-${suffix}`,
        projectId: ids.projectA,
        userId: ids.engineer,
        projectRole: "ENGINEER",
        departmentId: "engineering",
        assignedById: ids.admin
      }
    });
  });

  it("rejects rewriting published facts while superseding or voiding a version", async () => {
    for (const transition of ["SUPERSEDED", "VOIDED"] as const) {
      const source = await availableFile(ids.projectA, `published-fact-${transition}`);
      const created = await createControlledDocument({
        projectId: ids.projectA,
        code: `PUBLISHED.${transition}.${suffix}`,
        title: `发布事实 ${transition}`,
        sourceFileId: source.id,
        reason: "建立发布事实保护测试文档",
        actorId: ids.admin,
        auditContext: context(ids.admin, `published-fact-create-${transition}-${suffix}`)
      });
      const published = await publishControlledDocumentVersion({
        projectId: ids.projectA,
        documentId: created.document.id,
        documentVersionId: created.document.versions[0]!.id,
        version: created.resourceVersion,
        reason: "发布用于验证历史事实保护的版本",
        actorId: ids.admin,
        auditContext: context(ids.admin, `published-fact-publish-${transition}-${suffix}`)
      });
      const version = published.document.versions[0]!;
      await expect(
        db.$transaction(async (transaction) => {
          const now = new Date();
          await transaction.controlledDocument.update({
            where: { id: created.document.id },
            data:
              transition === "VOIDED"
                ? {
                    status: "VOIDED",
                    currentPublishedVersionId: null,
                    voidedById: ids.admin,
                    voidedAt: now,
                    voidReason: "测试直接作废时不得改写发布事实",
                    version: { increment: 1 }
                  }
                : { currentPublishedVersionId: null, version: { increment: 1 } }
          });
          await transaction.controlledDocumentVersion.update({
            where: { id: version.id },
            data:
              transition === "VOIDED"
                ? {
                    status: transition,
                    publishedById: ids.outsider,
                    publishedAt: new Date(new Date(version.publishedAt!).getTime() + 1_000),
                    voidedById: ids.admin,
                    voidedAt: now,
                    voidReason: "测试直接作废时不得改写发布事实"
                  }
                : {
                    status: transition,
                    publishedById: ids.outsider,
                    publishedAt: new Date(new Date(version.publishedAt!).getTime() + 1_000)
                  }
          });
        })
      ).rejects.toThrow(/published.*immutable|immutable.*published/u);
    }
  });

  it("rejects restricted source attachment for a document manager without sensitive-file access", async () => {
    const restricted = await availableFile(ids.projectA, "restricted-attach", "RESTRICTED");
    const createUrl = `http://localhost/api/projects/${ids.projectA}/documents`;
    const blockedCreate = await createControlledDocumentRoute(
      commandRequest(
        createUrl,
        {
          code: `RESTRICTED.CREATE.${suffix}`,
          title: "受限源文件文档",
          sourceFileId: restricted.id,
          reason: "验证受限文件不可由普通工程师引用"
        },
        `restricted-create-${suffix}`,
        ids.engineer
      ),
      { params: Promise.resolve({ projectId: ids.projectA }) }
    );
    expect(blockedCreate.status).toBe(403);

    const initial = await availableFile(ids.projectA, "internal-draft");
    const created = await createControlledDocument({
      projectId: ids.projectA,
      code: `RESTRICTED.DRAFT.${suffix}`,
      title: "受限草稿源文件文档",
      sourceFileId: initial.id,
      reason: "建立可迭代受控文档",
      actorId: ids.admin,
      auditContext: context(ids.admin, `restricted-draft-create-${suffix}`)
    });
    const blockedDraft = await createControlledDocumentDraftRoute(
      commandRequest(
        `http://localhost/api/projects/${ids.projectA}/documents/${created.document.id}/versions`,
        {
          version: created.resourceVersion,
          sourceFileId: restricted.id,
          reason: "验证受限文件不可被普通工程师作为草稿源文件"
        },
        `restricted-draft-${suffix}`,
        ids.engineer
      ),
      { params: Promise.resolve({ projectId: ids.projectA, documentId: created.document.id }) }
    );
    expect(blockedDraft.status).toBe(403);
  });

  it("denies restricted document reads without permission and audits allowed sensitive reads", async () => {
    const restricted = await availableFile(ids.projectA, "restricted-read", "RESTRICTED");
    const createUrl = `http://localhost/api/projects/${ids.projectA}/documents`;
    const createdResponse = await createControlledDocumentRoute(
      commandRequest(
        createUrl,
        {
          code: `RESTRICTED.READ.${suffix}`,
          title: "严格受限受控文档",
          sourceFileId: restricted.id,
          reason: "建立严格受限受控文档"
        },
        `restricted-read-create-${suffix}`,
        ids.admin
      ),
      { params: Promise.resolve({ projectId: ids.projectA }) }
    );
    expect(createdResponse.status).toBe(201);
    const created = (await createdResponse.json()) as { document: { id: string } };
    const url = `http://localhost/api/projects/${ids.projectA}/documents/${created.document.id}`;

    const denied = await readControlledDocumentRoute(
      readRequest(url, `restricted-read-denied-${suffix}`, ids.engineer),
      { params: Promise.resolve({ projectId: ids.projectA, documentId: created.document.id }) }
    );
    expect(denied.status).toBe(403);

    const allowed = await readControlledDocumentRoute(
      readRequest(url, `restricted-read-allowed-${suffix}`, ids.admin),
      { params: Promise.resolve({ projectId: ids.projectA, documentId: created.document.id }) }
    );
    expect(allowed.status).toBe(200);
    await expect(
      db.auditLog.count({
        where: {
          action: "SENSITIVE_FILE_READ",
          objectType: "FILE_OBJECT",
          objectId: restricted.id,
          actorId: ids.admin
        }
      })
    ).resolves.toBe(1);
  });

  it("preserves each draft and published file hash while keeping one current published version", async () => {
    const sourceOne = await availableFile(ids.projectA, "design-v1");
    const sourceTwo = await availableFile(ids.projectA, "design-v2");
    const created = await createControlledDocument({
      projectId: ids.projectA,
      code: `DESIGN.${suffix}`,
      title: "机械设计说明书",
      sourceFileId: sourceOne.id,
      reason: "建立机械设计受控文档",
      actorId: ids.admin,
      auditContext: context(ids.admin, `create-${suffix}`)
    });
    const firstDraft = created.document.versions[0]!;
    const firstPublished = await publishControlledDocumentVersion({
      projectId: ids.projectA,
      documentId: created.document.id,
      documentVersionId: firstDraft.id,
      version: created.resourceVersion,
      reason: "首次发布机械设计说明书",
      actorId: ids.admin,
      auditContext: context(ids.admin, `publish-one-${suffix}`)
    });
    const secondDraft = await createControlledDocumentDraft({
      projectId: ids.projectA,
      documentId: created.document.id,
      version: firstPublished.resourceVersion,
      sourceFileId: sourceTwo.id,
      reason: "设计变更后建立第二版草稿",
      actorId: ids.admin,
      auditContext: context(ids.admin, `draft-two-${suffix}`)
    });
    const draftTwo = secondDraft.document.versions.find(({ version }) => version === 2);
    expect(draftTwo).toMatchObject({ status: "DRAFT", sourceFileSha256: sourceTwo.sha256 });
    const secondPublished = await publishControlledDocumentVersion({
      projectId: ids.projectA,
      documentId: created.document.id,
      documentVersionId: draftTwo!.id,
      version: secondDraft.resourceVersion,
      reason: "发布设计变更第二版",
      actorId: ids.admin,
      auditContext: context(ids.admin, `publish-two-${suffix}`)
    });

    expect(secondPublished.document).toMatchObject({
      currentPublishedVersionId: draftTwo!.id,
      versions: [
        { version: 1, status: "SUPERSEDED", sourceFileSha256: sourceOne.sha256 },
        { version: 2, status: "PUBLISHED", sourceFileSha256: sourceTwo.sha256 }
      ]
    });
    await expect(
      db.controlledDocumentVersion.count({
        where: { documentId: created.document.id, status: "PUBLISHED" }
      })
    ).resolves.toBe(1);

    const voided = await voidControlledDocument({
      projectId: ids.projectA,
      documentId: created.document.id,
      version: secondPublished.resourceVersion,
      reason: "项目取消，作废设计资料",
      actorId: ids.admin,
      auditContext: context(ids.admin, `void-${suffix}`)
    });
    expect(voided.document).toMatchObject({
      status: "VOIDED",
      currentPublishedVersionId: null,
      versions: [
        { version: 1, status: "SUPERSEDED" },
        { version: 2, status: "VOIDED" }
      ]
    });
    await expect(
      db.auditLog.count({ where: { projectId: ids.projectA, objectId: created.document.id } })
    ).resolves.toBe(2);
    await expect(
      db.outboxEvent.count({
        where: { aggregateId: { in: [created.document.id, firstDraft.id, draftTwo!.id] } }
      })
    ).resolves.toBe(5);
  });

  it("rejects unscanned or foreign files and blocks direct historical mutation", async () => {
    const unavailable = await db.fileObject.create({
      data: {
        projectId: ids.projectA,
        uploadedById: ids.admin,
        originalName: "pending.pdf",
        declaredMimeType: "application/pdf",
        declaredSize: 1024n,
        objectKey: randomUUID(),
        storageArea: "QUARANTINE",
        status: "PENDING_SCAN",
        sensitivity: "INTERNAL"
      }
    });
    await expect(
      createControlledDocument({
        projectId: ids.projectA,
        code: `PENDING.${suffix}`,
        title: "待扫描文档",
        sourceFileId: unavailable.id,
        reason: "错误地尝试引用待扫描文件",
        actorId: ids.admin,
        auditContext: context(ids.admin, `pending-${suffix}`)
      })
    ).rejects.toMatchObject({ code: "DOCUMENT_FILE_NOT_AVAILABLE", status: 409 });

    const source = await availableFile(ids.projectA, "immutable");
    const foreignSource = await availableFile(ids.projectB, "foreign");
    const created = await createControlledDocument({
      projectId: ids.projectA,
      code: `IMMUTABLE.${suffix}`,
      title: "不可修改文档",
      sourceFileId: source.id,
      reason: "建立不可修改验证文档",
      actorId: ids.admin,
      auditContext: context(ids.admin, `immutable-${suffix}`)
    });
    const draft = created.document.versions[0]!;

    await expect(
      db.controlledDocumentVersion.create({
        data: {
          documentId: created.document.id,
          projectId: ids.projectA,
          version: 2,
          sourceFileId: foreignSource.id,
          sourceFileSha256: foreignSource.sha256!,
          sourceMimeType: foreignSource.verifiedMimeType!,
          sourceFileSize: foreignSource.verifiedSize!,
          createdById: ids.admin
        }
      })
    ).rejects.toThrow(/available verified source file/u);
    await expect(
      db.controlledDocumentVersion.update({
        where: { id: draft.id },
        data: { sourceFileSha256: "b".repeat(64) }
      })
    ).rejects.toThrow(/immutable|snapshot/u);
    await expect(
      db.controlledDocument.delete({ where: { id: created.document.id } })
    ).rejects.toThrow(/cannot be deleted/u);
    await expect(
      db.$executeRawUnsafe(
        'TRUNCATE TABLE "document_review_comment_resolutions", "document_review_comments", "document_review_events", "document_reviews", "gate_submission_document_references", "document_version_relations", "controlled_document_versions", "controlled_documents", "mechanical_drawing_import_item_files", "mechanical_drawing_import_items", "mechanical_drawing_import_batches", "mechanical_drawing_version_files", "mechanical_drawings"'
      )
    ).rejects.toThrow(/cannot be truncated/u);
  });

  it("enforces command authorization and idempotent replay without duplicate document facts", async () => {
    const source = await availableFile(ids.projectA, "api");
    const url = `http://localhost/api/projects/${ids.projectA}/documents`;
    const body = {
      code: `API.${suffix}`,
      title: "API 受控文档",
      sourceFileId: source.id,
      reason: "通过 API 建立文档"
    };
    const forbidden = await createControlledDocumentRoute(
      commandRequest(url, body, `document-forbidden-${suffix}`, ids.outsider),
      { params: Promise.resolve({ projectId: ids.projectA }) }
    );
    expect(forbidden.status).toBe(403);

    const key = `document-create-${suffix}`;
    const first = await createControlledDocumentRoute(commandRequest(url, body, key, ids.admin), {
      params: Promise.resolve({ projectId: ids.projectA })
    });
    const replay = await createControlledDocumentRoute(commandRequest(url, body, key, ids.admin), {
      params: Promise.resolve({ projectId: ids.projectA })
    });
    const conflict = await createControlledDocumentRoute(
      commandRequest(url, { ...body, title: "同一键的不同命令" }, key, ids.admin),
      { params: Promise.resolve({ projectId: ids.projectA }) }
    );
    expect(first.status).toBe(201);
    expect(replay.status).toBe(201);
    expect(replay.headers.get("idempotency-replayed")).toBe("true");
    expect(conflict.status).toBe(409);
    await expect(conflict.json()).resolves.toMatchObject({
      error: { code: "IDEMPOTENCY_KEY_REUSED" }
    });
    await expect(
      db.controlledDocument.count({
        where: { projectId: ids.projectA, code: body.code.toUpperCase() }
      })
    ).resolves.toBe(1);
  });
});
