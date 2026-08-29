import { randomUUID } from "node:crypto";

import { beforeAll, describe, expect, it } from "vitest";

import { db } from "@/lib/db";
import type { AuditContext } from "@/modules/audit/contracts/audit";
import {
  createProjectPublicLibraryReference,
  createPublicLibraryDocument,
  createPublicLibraryDocumentDraft,
  publishPublicLibraryDocumentVersion
} from "@/modules/documents/application/public-library-service";

const describeDatabase = process.env.RUN_DATABASE_INTEGRATION === "1" ? describe : describe.skip;
const suffix = randomUUID().slice(0, 8);
const ids = {
  admin: `public-library-admin-${suffix}`,
  project: `public-library-project-${suffix}`
};

function context(
  actorId: string,
  operationId: string,
  projectId: string | null = null
): AuditContext {
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

async function availableFile(label: string) {
  return db.fileObject.create({
    data: {
      projectId: ids.project,
      uploadedById: ids.admin,
      originalName: `${label}.zip`,
      declaredMimeType: "application/zip",
      verifiedMimeType: "application/zip",
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

describeDatabase("APM-060 PostgreSQL public-library facts", () => {
  beforeAll(async () => {
    await db.user.create({
      data: {
        id: ids.admin,
        employeeNo: `PUBLIC-LIBRARY-ADMIN-${suffix}`,
        name: "Public library administrator",
        departmentId: "engineering"
      }
    });
    await db.userRole.create({
      data: { id: `public-library-role-${suffix}`, userId: ids.admin, roleId: "role-admin" }
    });
    await db.project.create({
      data: {
        id: ids.project,
        code: `PUBLIC-LIBRARY-${suffix}`.toUpperCase(),
        name: "公共资料库引用测试项目",
        departmentId: "engineering",
        createdById: ids.admin
      }
    });
  });

  it("preserves the exact public version/hash on a project reference after a newer version is published", async () => {
    const v1File = await availableFile("tool-v1");
    const created = await createPublicLibraryDocument({
      code: `TOOL.${suffix}`,
      title: "厂商调试工具",
      materialType: "TOOL",
      sourceFileId: v1File.id,
      applicableModels: ["AX-100"],
      applicablePlatforms: ["Windows 11"],
      reason: "建立企业工具资料",
      actorId: ids.admin,
      auditContext: context(ids.admin, `create-${suffix}`)
    });
    const publishedV1 = await publishPublicLibraryDocumentVersion({
      documentId: created.document.id,
      documentVersionId: created.document.versions[0]!.id,
      version: created.resourceVersion,
      reason: "发布已验证工具",
      actorId: ids.admin,
      auditContext: context(ids.admin, `publish-v1-${suffix}`)
    });
    const reference = await createProjectPublicLibraryReference({
      projectId: ids.project,
      publicDocumentVersionId: publishedV1.document.currentPublishedVersion!.id,
      reason: "项目验证采用该版本",
      actorId: ids.admin,
      auditContext: context(ids.admin, `reference-v1-${suffix}`, ids.project)
    });
    const v2File = await availableFile("tool-v2");
    const draftV2 = await createPublicLibraryDocumentDraft({
      documentId: created.document.id,
      version: publishedV1.resourceVersion,
      sourceFileId: v2File.id,
      applicableModels: ["AX-200"],
      applicablePlatforms: ["Windows 11"],
      reason: "厂商发布新版本",
      actorId: ids.admin,
      auditContext: context(ids.admin, `draft-v2-${suffix}`)
    });
    await publishPublicLibraryDocumentVersion({
      documentId: created.document.id,
      documentVersionId: draftV2.document.versions.at(-1)!.id,
      version: draftV2.resourceVersion,
      reason: "发布新版本",
      actorId: ids.admin,
      auditContext: context(ids.admin, `publish-v2-${suffix}`)
    });

    const persistedReference = await db.projectPublicLibraryReference.findUniqueOrThrow({
      where: { id: reference.reference.id }
    });
    expect(persistedReference.publicDocumentVersionId).toBe(
      publishedV1.document.currentPublishedVersion!.id
    );
    expect(persistedReference.sourceFileSha256).toBe(v1File.sha256);
    expect(persistedReference.documentVersion).toBe(1);
  });

  it("rejects a project reference to an unpublished public version", async () => {
    const file = await availableFile("draft-only");
    const created = await createPublicLibraryDocument({
      code: `DRAFT.${suffix}`,
      title: "尚未发布资料",
      materialType: "MANUAL",
      sourceFileId: file.id,
      applicableModels: [],
      applicablePlatforms: [],
      reason: "建立待审核资料",
      actorId: ids.admin,
      auditContext: context(ids.admin, `draft-create-${suffix}`)
    });
    await expect(
      createProjectPublicLibraryReference({
        projectId: ids.project,
        publicDocumentVersionId: created.document.versions[0]!.id,
        reason: "不能引用草稿",
        actorId: ids.admin,
        auditContext: context(ids.admin, `draft-reference-${suffix}`, ids.project)
      })
    ).rejects.toMatchObject({ code: "PUBLIC_LIBRARY_VERSION_NOT_PUBLISHED" });
  });
});
