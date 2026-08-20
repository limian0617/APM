import { createHash, randomUUID } from "node:crypto";

import { beforeAll, describe, expect, it } from "vitest";

import { db } from "@/lib/db";
import type { AuditContext } from "@/modules/audit/contracts/audit";
import {
  publishAssetReleaseVersion,
  createAssetRelease
} from "@/modules/assets/application/asset-release-service";
import {
  createProjectAssetReference,
  createProjectAssetUsage,
  getAssetUsageSnapshotForAcceptance,
  retireProjectAssetUsage
} from "@/modules/assets/application/project-asset-usage-service";
import { AUDIT_ACTIONS, AUDIT_OBJECT_TYPES } from "@/modules/audit/domain/vocabulary";
import { publishControlledDocumentVersion } from "@/modules/documents/application/controlled-document-service";
import { MemoryObjectStorage } from "@/modules/documents/infrastructure/memory-object-storage";
import { sha256Bytes } from "@/modules/acceptance/infrastructure/acceptance-report-renderer";

import {
  createAcceptanceBatch,
  createAcceptanceTemplateVersion,
  lockAcceptanceBatch,
  recordAcceptanceResultRevision,
  startAcceptanceBatch
} from "./acceptance-service";
import {
  AcceptanceReportServiceError,
  generateAcceptanceReport,
  getAcceptanceReport,
  listAcceptanceReports,
  recordAcceptanceConfirmation
} from "./acceptance-report-service";

const describeDatabase = process.env.RUN_DATABASE_INTEGRATION === "1" ? describe : describe.skip;
const suffix = randomUUID().slice(0, 8);
const actorId = `acceptance-report-actor-${suffix}`;
const projectId = `acceptance-report-project-${suffix}`;
const otherProjectId = `acceptance-report-other-${suffix}`;
const storage = new MemoryObjectStorage();
const assetAuthorizationActor = {
  id: actorId,
  name: "验收报告集成测试人",
  status: "ACTIVE" as const,
  departmentId: "quality",
  systemRoles: [],
  grants: []
};

class TamperedReportStorage extends MemoryObjectStorage {
  override async readObject(input: { area: "CONTROLLED" | "QUARANTINE"; objectKey: string }) {
    const source = await super.readObject(input);
    return (async function* () {
      let changed = false;
      for await (const chunk of source) {
        const copy = chunk.slice();
        if (!changed && copy.byteLength > 0) {
          copy[0] = (copy[0] ?? 0) ^ 0xff;
          changed = true;
        }
        yield copy;
      }
    })();
  }
}

async function readStorageBytes(storage: MemoryObjectStorage, objectKey: string) {
  const stream = await storage.readObject({ area: "CONTROLLED", objectKey });
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return new Uint8Array(Buffer.concat(chunks));
}

function auditContext(operationId: string, project = projectId): AuditContext {
  return {
    actorId,
    requestId: `acceptance-report-request-${operationId}`,
    traceId: createHash("sha256").update(operationId).digest("hex").slice(0, 32),
    source: "API",
    sourceIp: "127.0.0.1",
    userAgent: "Vitest",
    reason: null,
    projectId: project,
    departmentId: "quality",
    operationId
  };
}

async function lockedBatch() {
  const template = await createAcceptanceTemplateVersion({
    template: {
      code: `ACCEPTANCE.REPORT.${randomUUID().slice(0, 8)}`,
      name: "报告验收模板",
      acceptanceType: "FAT",
      items: [
        {
          code: "POWER",
          name: "上电",
          position: 1,
          method: "观察",
          acceptanceCriteria: "正常",
          unit: "V",
          required: true,
          evidenceRequired: false,
          applicableScope: "PROJECT",
          defaultDiscipline: "电气"
        }
      ]
    },
    actorId,
    auditContext: auditContext(`template-${randomUUID()}`)
  });
  const item = template.templateVersion.items[0];
  if (!item) throw new Error("missing frozen template item");
  const batch = await createAcceptanceBatch({
    projectId,
    acceptanceType: "FAT",
    scopeType: "PROJECT",
    scopeId: projectId,
    templateVersionId: template.templateVersion.id,
    version: 0,
    actorId,
    auditContext: auditContext(`batch-${randomUUID()}`)
  });
  const started = await startAcceptanceBatch({
    projectId,
    batchId: batch.batch.id,
    version: batch.resourceVersion,
    actorId,
    auditContext: auditContext(`start-${randomUUID()}`)
  });
  const result = await recordAcceptanceResultRevision({
    projectId,
    batchId: batch.batch.id,
    itemId: item.id,
    version: started.resourceVersion,
    decision: "PASS",
    measuredValue: "230",
    measuredUnit: "V",
    actorId,
    auditContext: auditContext(`result-${randomUUID()}`)
  });
  const locked = await lockAcceptanceBatch({
    projectId,
    batchId: batch.batch.id,
    version: result.resourceVersion,
    actorId,
    auditContext: auditContext(`lock-${randomUUID()}`)
  });
  return { batch: locked.batch, result: result.revision };
}

async function recordPublishedProjectAssetUsage() {
  const assetSuffix = randomUUID().slice(0, 8);
  const checksum = createHash("sha256").update(`asset-usage-${assetSuffix}`).digest("hex");
  const sourceFileId = `acceptance-report-source-file-${assetSuffix}`;
  const sourceDocumentId = `acceptance-report-source-document-${assetSuffix}`;
  const rndProjectId = `acceptance-report-rnd-${assetSuffix}`;
  const technicalAssetId = `acceptance-report-asset-${assetSuffix}`;

  await db.fileObject.create({
    data: {
      id: sourceFileId,
      projectId,
      uploadedById: actorId,
      originalName: `asset-usage-${assetSuffix}.zip`,
      declaredMimeType: "application/zip",
      verifiedMimeType: "application/zip",
      declaredSize: 1024n,
      verifiedSize: 1024n,
      sha256: checksum,
      objectKey: randomUUID(),
      storageArea: "CONTROLLED",
      status: "AVAILABLE",
      sensitivity: "INTERNAL",
      scannedAt: new Date()
    }
  });
  await db.controlledDocument.create({
    data: {
      id: sourceDocumentId,
      projectId,
      code: `AST-USAGE-${assetSuffix}`.toUpperCase(),
      title: "项目资产使用来源",
      createdById: actorId,
      versions: {
        create: {
          version: 1,
          sourceFileId,
          sourceFileSha256: checksum,
          sourceMimeType: "application/zip",
          sourceFileSize: 1024n,
          createdById: actorId
        }
      }
    }
  });
  const sourceVersion = await db.controlledDocumentVersion.findFirstOrThrow({
    where: { documentId: sourceDocumentId, projectId }
  });
  await publishControlledDocumentVersion({
    projectId,
    documentId: sourceDocumentId,
    documentVersionId: sourceVersion.id,
    version: 1,
    reason: "发布项目资产使用来源",
    actorId,
    auditContext: auditContext(`asset-usage-source-${assetSuffix}`)
  });
  await db.rndProject.create({
    data: {
      id: rndProjectId,
      code: `RND.ASSET.USAGE.${assetSuffix}`.toUpperCase(),
      name: "项目资产使用研发项目",
      ownerId: actorId,
      createdById: actorId,
      status: "IN_DEVELOPMENT"
    }
  });
  await db.technicalAsset.create({
    data: {
      id: technicalAssetId,
      rndProjectId,
      assetNumber: `AST.USAGE.${assetSuffix}`.toUpperCase(),
      assetType: "SOFTWARE",
      name: "项目资产使用测试资产",
      ownerId: actorId,
      createdById: actorId,
      status: "VALIDATED"
    }
  });
  const createdRelease = await createAssetRelease({
    technicalAssetId,
    releaseCode: `rel-${assetSuffix}`,
    releaseNotes: "项目资产使用精确 Release",
    components: [
      {
        position: 1,
        componentType: "SOFTWARE",
        sourceProjectId: projectId,
        sourceDocumentVersionId: sourceVersion.id,
        sourceVersion: 1,
        sourceStatus: "PUBLISHED",
        sourceChecksum: checksum,
        files: [
          { fileId: sourceFileId, sha256: checksum, mimeType: "application/zip", size: 1024 }
        ],
        metadata: { packageChecksum: checksum }
      }
    ],
    actorId,
    auditContext: auditContext(`asset-usage-release-${assetSuffix}`)
  });
  const publishedRelease = await publishAssetReleaseVersion({
    technicalAssetId,
    releaseId: createdRelease.release.id,
    releaseVersionId: createdRelease.releaseVersion.id,
    version: createdRelease.resourceVersion,
    releaseVersion: createdRelease.releaseVersion.revision,
    actorId,
    reason: "发布项目资产使用精确 Release",
    auditContext: auditContext(`asset-usage-publish-${assetSuffix}`)
  });
  const component = publishedRelease.releaseVersion.components[0];
  if (!component) throw new Error("published asset Release component missing");
  const project = await db.project.findUniqueOrThrow({ where: { id: projectId } });
  const reference = await createProjectAssetReference({
    projectId,
    assetReleaseId: createdRelease.release.id,
    assetReleaseVersionId: publishedRelease.releaseVersion.id,
    projectVersion: project.version,
    actorId,
    reason: "记录验收报告后发生的精确项目资产引用",
    auditContext: auditContext(`asset-usage-reference-${assetSuffix}`),
    authorizationActor: assetAuthorizationActor
  });
  const usage = await createProjectAssetUsage({
    projectId,
    referenceId: reference.reference.id,
    referenceVersion: reference.resourceVersion,
    usageKey: `asset-usage-${assetSuffix}`,
    componentSnapshotId: component.id,
    quantity: "1.000000",
    configuration: { purpose: "FAT 验收使用", parameters: {}, notes: null },
    scopeType: "PROJECT",
    scopeId: projectId,
    actorId,
    reason: "记录验收报告后发生的实际使用",
    auditContext: auditContext(`asset-usage-record-${assetSuffix}`),
    authorizationActor: assetAuthorizationActor
  });
  return { usage, authorizationActor: assetAuthorizationActor };
}

describeDatabase("APM-102 controlled acceptance reports", () => {
  beforeAll(async () => {
    await db.user.create({
      data: {
        id: actorId,
        employeeNo: `ACCEPTANCE-REPORT-${suffix}`.toUpperCase(),
        name: "验收报告集成测试人",
        departmentId: "quality"
      }
    });
    await db.project.createMany({
      data: [
        {
          id: projectId,
          code: `ACCEPTANCE-REPORT-${suffix}`.toUpperCase(),
          name: "验收报告测试项目",
          departmentId: "quality",
          createdById: actorId
        },
        {
          id: otherProjectId,
          code: `ACCEPTANCE-OTHER-${suffix}`.toUpperCase(),
          name: "另一验收报告测试项目",
          departmentId: "quality",
          createdById: actorId
        }
      ]
    });
  });

  it("freezes a LOCKED batch once, stores a controlled PDF, and keeps list reads non-sensitive", async () => {
    const { batch } = await lockedBatch();
    const firstOperationId = `report-${randomUUID()}`;
    const generated = await generateAcceptanceReport({
      projectId,
      batchId: batch.id,
      version: batch.version,
      actorId,
      storage,
      auditContext: auditContext(firstOperationId)
    });
    expect(generated).toMatchObject({ repeated: false, report: { status: "READY", projectId } });
    const reportId = (generated.report as unknown as { id: string }).id;
    const replayOperationId = `report-repeat-${randomUUID()}`;
    const repeated = await generateAcceptanceReport({
      projectId,
      batchId: batch.id,
      version: batch.version,
      actorId,
      storage,
      auditContext: auditContext(replayOperationId)
    });
    expect(repeated).toMatchObject({ repeated: true, report: { id: reportId } });
    const persisted = await db.acceptanceReport.findUniqueOrThrow({
      where: { id_projectId: { id: reportId, projectId } },
      include: { pdfFile: true, controlledDocumentVersion: { include: { document: true } } }
    });
    expect(persisted).toMatchObject({
      status: "READY",
      pdfFile: { status: "AVAILABLE", storageArea: "CONTROLLED" },
      controlledDocumentVersion: { status: "PUBLISHED" }
    });
    expect(persisted.snapshotChecksum).toMatch(/^[0-9a-f]{64}$/u);
    expect(persisted.pdfSha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(persisted.pdfSha256).toBe(persisted.pdfFile.sha256);
    expect(persisted.pdfFile.objectKey).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
    );
    expect(persisted.pdfSha256).toBe(persisted.controlledDocumentVersion.sourceFileSha256);
    expect(persisted.controlledDocumentVersion).toMatchObject({
      version: persisted.reportVersion,
      document: {
        code: `ACCEPTANCE-${persisted.acceptanceType}-${persisted.sourceBatchId}`.toUpperCase()
      }
    });
    const storedPdf = await readStorageBytes(storage, persisted.pdfFile.objectKey);
    expect(sha256Bytes(storedPdf)).toBe(persisted.pdfSha256);
    await expect(
      db.acceptanceReport.update({
        where: { id: reportId },
        data: { snapshotChecksum: "0".repeat(64) }
      })
    ).rejects.toThrow();
    await expect(
      db.acceptanceReport.update({
        where: { id: reportId },
        data: { status: "SUPERSEDED", reportNumber: "FORGED-REPORT" }
      })
    ).rejects.toThrow();
    const listing = await listAcceptanceReports({ projectId });
    expect(listing.reports[0]).not.toHaveProperty("snapshotJson");
    await expect(
      db.outboxEvent.count({
        where: { aggregateId: reportId, eventType: "acceptance.report.generated" }
      })
    ).resolves.toBe(1);
    await expect(
      db.auditLog.count({
        where: {
          actorId,
          action: AUDIT_ACTIONS.PROJECT_ASSET_USAGE_SNAPSHOT_READ,
          objectType: AUDIT_OBJECT_TYPES.PROJECT_ASSET_USAGE_SNAPSHOT,
          objectId: projectId,
          operationId: `${replayOperationId}:historical-replay`
        }
      })
    ).resolves.toBe(1);
  });

  it("reuses an immutable report when an active usage is retired after its frozenAt", async () => {
    const { usage, authorizationActor } = await recordPublishedProjectAssetUsage();
    const { batch } = await lockedBatch();
    const first = await generateAcceptanceReport({
      projectId,
      batchId: batch.id,
      version: batch.version,
      actorId,
      storage,
      auditContext: auditContext(`report-asset-history-old-${randomUUID()}`)
    });
    const firstReport = first.report as unknown as { id: string };
    const persistedFirst = await db.acceptanceReport.findUniqueOrThrow({
      where: { id_projectId: { id: firstReport.id, projectId } }
    });
    const oldSnapshot = persistedFirst.snapshotJson as {
      frozenAt: string;
      assetUsage: { frozenAt: string; usageSnapshotChecksum: string };
    };

    await retireProjectAssetUsage({
      projectId,
      usageId: usage.usage.id,
      version: usage.resourceVersion,
      actorId,
      reason: "旧报告冻结后退役实际使用",
      auditContext: auditContext(`asset-usage-retire-${randomUUID()}`),
      authorizationActor
    });

    const operationId = `report-asset-history-replay-${randomUUID()}`;
    const repeated = await generateAcceptanceReport({
      projectId,
      batchId: batch.id,
      version: batch.version,
      actorId,
      storage,
      auditContext: auditContext(operationId)
    });
    expect(repeated).toMatchObject({ repeated: true, report: { id: firstReport.id } });
    const current = await db.acceptanceReport.findUniqueOrThrow({
      where: { id_projectId: { id: firstReport.id, projectId } }
    });
    expect(current).toMatchObject({
      status: "READY",
      snapshotChecksum: persistedFirst.snapshotChecksum
    });

    const reads = await db.auditLog.findMany({
      where: {
        actorId,
        action: AUDIT_ACTIONS.PROJECT_ASSET_USAGE_SNAPSHOT_READ,
        objectType: AUDIT_OBJECT_TYPES.PROJECT_ASSET_USAGE_SNAPSHOT,
        objectId: projectId,
        operationId: `${operationId}:historical-replay`
      },
      orderBy: { operationId: "asc" }
    });
    expect(reads).toHaveLength(1);
    const historicalSnapshot = await getAssetUsageSnapshotForAcceptance({
      projectId,
      acceptanceType: "FAT",
      scopeType: "PROJECT",
      scopeId: projectId,
      frozenAt: new Date(oldSnapshot.frozenAt)
    });
    const historicalEntries = (
      historicalSnapshot.snapshot as {
        entries: Array<{ version: number; usageVersion: number }>;
      }
    ).entries;
    expect(historicalEntries).toEqual([expect.objectContaining({ version: 1, usageVersion: 1 })]);
    expect(reads[0]?.afterJson).toMatchObject({
      frozenAt: oldSnapshot.frozenAt,
      usageSnapshotChecksum: historicalSnapshot.usageSnapshotChecksum
    });
    expect(historicalSnapshot.usageSnapshotChecksum).toBe(
      oldSnapshot.assetUsage.usageSnapshotChecksum
    );
    await expect(
      db.acceptanceReport.count({ where: { projectId, sourceBatchId: batch.id } })
    ).resolves.toBe(1);
  });

  it("rejects publication when stored PDF bytes no longer match report and FileObject metadata", async () => {
    const { batch } = await lockedBatch();
    const tamperedStorage = new TamperedReportStorage();

    await expect(
      generateAcceptanceReport({
        projectId,
        batchId: batch.id,
        version: batch.version,
        actorId,
        storage: tamperedStorage,
        auditContext: auditContext(`report-tamper-${randomUUID()}`)
      })
    ).rejects.toMatchObject({ code: "ACCEPTANCE_REPORT_PDF_HASH_MISMATCH", status: 409 });
    await expect(
      db.acceptanceReport.count({ where: { projectId, sourceBatchId: batch.id } })
    ).resolves.toBe(0);
  });

  it("creates a new immutable report and document version without overwriting its superseded predecessor", async () => {
    const { batch } = await lockedBatch();
    const secondOperationId = `report-second-version-${randomUUID()}`;
    const first = await generateAcceptanceReport({
      projectId,
      batchId: batch.id,
      version: batch.version,
      actorId,
      storage,
      auditContext: auditContext(`report-first-version-${randomUUID()}`)
    });
    const firstReport = first.report as unknown as { id: string; snapshotChecksum: string };
    const second = await generateAcceptanceReport({
      projectId,
      batchId: batch.id,
      version: batch.version,
      supersedesReportId: firstReport.id,
      actorId,
      storage,
      auditContext: auditContext(secondOperationId)
    });
    const secondReport = second.report as unknown as { id: string; supersedesReportId: string };
    const [persistedFirst, persistedSecond] = await Promise.all([
      db.acceptanceReport.findUniqueOrThrow({ where: { id: firstReport.id } }),
      db.acceptanceReport.findUniqueOrThrow({ where: { id: secondReport.id } })
    ]);

    expect(persistedFirst).toMatchObject({
      id: firstReport.id,
      status: "SUPERSEDED",
      snapshotChecksum: firstReport.snapshotChecksum
    });
    expect(persistedSecond).toMatchObject({
      status: "READY",
      supersedesReportId: firstReport.id
    });
    expect(persistedSecond.reportVersion).toBe(persistedFirst.reportVersion + 1);
    expect(persistedSecond.controlledDocumentVersionId).not.toBe(
      persistedFirst.controlledDocumentVersionId
    );
    await expect(
      db.auditLog.count({
        where: {
          actorId,
          action: AUDIT_ACTIONS.PROJECT_ASSET_USAGE_SNAPSHOT_READ,
          objectType: AUDIT_OBJECT_TYPES.PROJECT_ASSET_USAGE_SNAPSHOT,
          objectId: projectId,
          operationId: `${secondOperationId}:current-authoritative`
        }
      })
    ).resolves.toBe(1);
  });

  it("accepts only a precise ready report with scanned restricted evidence and appends corrections", async () => {
    const { batch } = await lockedBatch();
    const generated = await generateAcceptanceReport({
      projectId,
      batchId: batch.id,
      version: batch.version,
      actorId,
      storage,
      auditContext: auditContext(`confirmation-report-${randomUUID()}`)
    });
    const report = generated.report as unknown as {
      id: string;
      reportVersion: number;
      snapshotChecksum: string;
    };
    const evidence = await db.fileObject.create({
      data: {
        projectId,
        uploadedById: actorId,
        originalName: "customer-signed-fat.pdf",
        declaredMimeType: "application/pdf",
        verifiedMimeType: "application/pdf",
        declaredSize: 12n,
        verifiedSize: 12n,
        sha256: createHash("sha256").update("signed evidence").digest("hex"),
        objectKey: randomUUID(),
        storageArea: "CONTROLLED",
        status: "AVAILABLE",
        sensitivity: "RESTRICTED",
        scanEngine: "test",
        scannerVersion: "1",
        scannedAt: new Date()
      }
    });
    const command = {
      projectId,
      reportId: report.id,
      version: report.reportVersion,
      reportChecksum: report.snapshotChecksum,
      decision: "ACCEPTED" as const,
      customerOrganization: "测试客户",
      customerRepresentative: "客户代表",
      representativeTitle: "质量经理",
      confirmationChannel: "SIGNED_DOCUMENT" as const,
      customerConfirmedAt: "2026-08-09T10:00:00.000Z",
      comment: "同意验收",
      evidenceFileIds: [evidence.id],
      actorId,
      auditContext: auditContext(`confirmation-${randomUUID()}`)
    };
    const confirmation = await recordAcceptanceConfirmation(command);
    expect(confirmation.confirmation).toMatchObject({ reportId: report.id, decision: "ACCEPTED" });
    await expect(
      db.acceptanceConfirmationEvidence.findFirstOrThrow({
        where: { confirmationId: confirmation.confirmation.id, fileObjectId: evidence.id }
      })
    ).resolves.toMatchObject({
      projectId,
      confirmationId: confirmation.confirmation.id,
      fileObjectId: evidence.id,
      fileSha256: evidence.sha256
    });
    await expect(
      db.acceptanceConfirmation.update({
        where: { id: confirmation.confirmation.id },
        data: { status: "SUPERSEDED", comment: "不能篡改不可变确认事实" }
      })
    ).rejects.toThrow();
    await expect(
      recordAcceptanceConfirmation({ ...command, reportChecksum: "f".repeat(64) })
    ).rejects.toMatchObject({ code: "ACCEPTANCE_REPORT_CHECKSUM_CONFLICT", status: 409 });
    const corrected = await recordAcceptanceConfirmation({
      ...command,
      decision: "ACCEPTED_WITH_RESERVATIONS",
      comment: "附条件接受",
      supersedesConfirmationId: confirmation.confirmation.id,
      auditContext: auditContext(`confirmation-correction-${randomUUID()}`)
    });
    expect(corrected.confirmation.supersedesConfirmationId).toBe(confirmation.confirmation.id);
    await expect(
      db.acceptanceConfirmation.findUniqueOrThrow({ where: { id: confirmation.confirmation.id } })
    ).resolves.toMatchObject({ status: "SUPERSEDED" });
    const publicView = await getAcceptanceReport({
      projectId,
      reportId: report.id,
      sensitive: false
    });
    expect(publicView.report).not.toHaveProperty("snapshotJson");
    expect(publicView.report.confirmations[0]).not.toHaveProperty("customerRepresentative");
    const sensitiveView = await getAcceptanceReport({
      projectId,
      reportId: report.id,
      sensitive: true
    });
    expect(sensitiveView.report.confirmations[0]).toMatchObject({
      customerRepresentative: "客户代表",
      evidence: [{ fileId: evidence.id }]
    });
    await expect(
      getAcceptanceReport({ projectId: otherProjectId, reportId: report.id, sensitive: true })
    ).rejects.toBeInstanceOf(AcceptanceReportServiceError);
  });
});
