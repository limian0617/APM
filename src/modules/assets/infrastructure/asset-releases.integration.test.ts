import { randomUUID } from "node:crypto";

import { beforeAll, describe, expect, it } from "vitest";

import { db } from "@/lib/db";
import type { AuditContext } from "@/modules/audit/contracts/audit";
import { publishControlledDocumentVersion } from "@/modules/documents/application/controlled-document-service";
import { executeIdempotentCommand } from "@/modules/platform-api/application/idempotent-command";

import {
  createAssetRelease,
  createAssetReleaseRevision,
  getAssetRelease,
  publishAssetReleaseVersion
} from "../application/asset-release-service";

const describeDatabase = process.env.RUN_DATABASE_INTEGRATION === "1" ? describe : describe.skip;
const suffix = randomUUID().slice(0, 8);
const ids = {
  actor: `asset-release-actor-${suffix}`,
  owner: `asset-release-owner-${suffix}`,
  rndProject: `asset-release-rnd-${suffix}`,
  technicalAsset: `asset-release-technical-${suffix}`,
  project: `asset-release-project-${suffix}`,
  file: `asset-release-file-${suffix}`,
  document: `asset-release-document-${suffix}`
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

const sourceChecksum = "a".repeat(64);

describeDatabase("APM-062 PostgreSQL asset Releases", () => {
  beforeAll(async () => {
    await db.user.createMany({
      data: [
        {
          id: ids.actor,
          employeeNo: `ASSET-RELEASE-ACTOR-${suffix}`,
          name: "资产 Release 操作人",
          departmentId: "engineering"
        },
        {
          id: ids.owner,
          employeeNo: `ASSET-RELEASE-OWNER-${suffix}`,
          name: "资产 Release Owner",
          departmentId: "engineering"
        }
      ]
    });
    await db.rndProject.create({
      data: {
        id: ids.rndProject,
        code: `RND.RELEASE.${suffix}`.toUpperCase(),
        name: "Release 测试研发项目",
        ownerId: ids.owner,
        createdById: ids.actor
      }
    });
    await db.technicalAsset.create({
      data: {
        id: ids.technicalAsset,
        rndProjectId: ids.rndProject,
        assetNumber: `AST.RELEASE.${suffix}`.toUpperCase(),
        assetType: "SOFTWARE",
        name: "Release 测试软件资产",
        ownerId: ids.owner,
        createdById: ids.actor
      }
    });
    await db.project.create({
      data: {
        id: ids.project,
        code: `RELEASE-SOURCE-${suffix}`.toUpperCase(),
        name: "Release 来源项目",
        createdById: ids.actor
      }
    });
    await db.fileObject.create({
      data: {
        id: ids.file,
        projectId: ids.project,
        uploadedById: ids.actor,
        originalName: "software-release.zip",
        declaredMimeType: "application/zip",
        verifiedMimeType: "application/zip",
        declaredSize: 1024n,
        verifiedSize: 1024n,
        sha256: sourceChecksum,
        objectKey: randomUUID(),
        storageArea: "CONTROLLED",
        status: "AVAILABLE",
        sensitivity: "INTERNAL",
        scannedAt: new Date()
      }
    });
    await db.controlledDocument.create({
      data: {
        id: ids.document,
        projectId: ids.project,
        code: `SW.RELEASE.${suffix}`.toUpperCase(),
        title: "Release 软件包",
        createdById: ids.actor,
        versions: {
          create: {
            version: 1,
            sourceFileId: ids.file,
            sourceFileSha256: sourceChecksum,
            sourceMimeType: "application/zip",
            sourceFileSize: 1024n,
            createdById: ids.actor
          }
        }
      }
    });
    const draft = await db.controlledDocumentVersion.findFirstOrThrow({
      where: { documentId: ids.document, projectId: ids.project }
    });
    await publishControlledDocumentVersion({
      projectId: ids.project,
      documentId: ids.document,
      documentVersionId: draft.id,
      version: 1,
      reason: "发布 Release 来源文档",
      actorId: ids.actor,
      auditContext: context(ids.actor, `source-publish-${suffix}`, ids.project)
    });
  });

  it("creates, publishes, reads, and preserves a traceable Release snapshot", async () => {
    const created = await createAssetRelease({
      technicalAssetId: ids.technicalAsset,
      releaseCode: `rel-${suffix}`,
      releaseNotes: "首版软件 Release",
      components: [
        {
          position: 1,
          componentType: "SOFTWARE",
          sourceProjectId: ids.project,
          sourceDocumentVersionId: (
            await db.controlledDocumentVersion.findFirstOrThrow({
              where: { documentId: ids.document, status: "PUBLISHED" }
            })
          ).id,
          sourceVersion: 1,
          sourceStatus: "PUBLISHED",
          sourceChecksum,
          files: [
            { fileId: ids.file, sha256: sourceChecksum, mimeType: "application/zip", size: 1024 }
          ],
          metadata: {
            gitRef: "refs/tags/release-1",
            platform: "linux-amd64",
            packageChecksum: sourceChecksum
          }
        }
      ],
      actorId: ids.actor,
      auditContext: context(ids.actor, `release-create-${suffix}`)
    });
    expect(created.release).toMatchObject({
      technicalAssetId: ids.technicalAsset,
      releaseCode: `REL-${suffix}`.toUpperCase(),
      version: 2
    });
    expect(created.releaseVersion).toMatchObject({ revision: 1, status: "DRAFT" });

    const published = await publishAssetReleaseVersion({
      technicalAssetId: ids.technicalAsset,
      releaseId: created.release.id,
      releaseVersionId: created.releaseVersion.id,
      version: created.resourceVersion,
      releaseVersion: created.releaseVersion.revision,
      actorId: ids.actor,
      reason: "冻结首版软件 Release",
      auditContext: context(ids.actor, `release-publish-${suffix}`)
    });
    expect(published.releaseVersion).toMatchObject({ revision: 1, status: "PUBLISHED" });
    expect(published.releaseVersion.components[0]).toMatchObject({
      sourceProjectId: ids.project,
      sourceDocumentVersionId: expect.any(String),
      sourceFileSha256: sourceChecksum
    });

    const read = await getAssetRelease({
      technicalAssetId: ids.technicalAsset,
      releaseId: created.release.id
    });
    expect(read.release.versions[0]).toMatchObject({ status: "PUBLISHED", revision: 1 });
    await expect(
      db.auditLog.count({
        where: { operationId: { in: [`release-create-${suffix}`, `release-publish-${suffix}`] } }
      })
    ).resolves.toBeGreaterThanOrEqual(2);
    await expect(
      db.outboxEvent.count({ where: { aggregateId: created.release.id } })
    ).resolves.toBeGreaterThanOrEqual(2);
  });

  it("replays an identical create command and rejects a stale publish", async () => {
    const operation = `release-idempotent-${suffix}`;
    const key = `release-idempotent-key-${suffix}`;
    const request = { technicalAssetId: ids.technicalAsset, releaseCode: `REL-IDEMP-${suffix}` };
    const beforeReleases = await db.assetRelease.count({
      where: { technicalAssetId: ids.technicalAsset }
    });
    const execute = () =>
      executeIdempotentCommand({
        actorId: ids.actor,
        operation,
        idempotencyKey: key,
        request,
        execute: async (transaction) => ({
          status: 201,
          body: await createAssetRelease(
            {
              technicalAssetId: ids.technicalAsset,
              releaseCode: request.releaseCode,
              releaseNotes: null,
              components: [
                {
                  position: 0,
                  componentType: "SOFTWARE",
                  sourceProjectId: ids.project,
                  sourceDocumentVersionId: "invalid",
                  sourceVersion: 1,
                  sourceStatus: "PUBLISHED",
                  sourceChecksum,
                  files: [
                    {
                      fileId: ids.file,
                      sha256: sourceChecksum,
                      mimeType: "application/zip",
                      size: 1024
                    }
                  ],
                  metadata: {}
                }
              ],
              actorId: ids.actor,
              auditContext: context(ids.actor, operation)
            },
            transaction
          )
        })
      });
    await expect(execute()).rejects.toMatchObject({ code: "INVALID_COMPONENT_POSITION" });
    await expect(
      db.assetRelease.count({ where: { technicalAssetId: ids.technicalAsset } })
    ).resolves.toBe(beforeReleases);
    await expect(
      db.apiIdempotencyRecord.findUnique({
        where: {
          actorId_operation_idempotencyKey: { actorId: ids.actor, operation, idempotencyKey: key }
        }
      })
    ).resolves.toBeNull();
    await expect(
      publishAssetReleaseVersion({
        technicalAssetId: ids.technicalAsset,
        releaseId: "missing-release",
        releaseVersionId: "missing-version",
        version: 1,
        releaseVersion: 1,
        actorId: ids.actor,
        reason: "过期发布",
        auditContext: context(ids.actor, `release-stale-${suffix}`)
      })
    ).rejects.toMatchObject({ code: "ASSET_RELEASE_NOT_FOUND", status: 404 });
  });

  it("creates a new immutable revision and supersedes only the prior published version", async () => {
    const release = await db.assetRelease.findFirstOrThrow({
      where: { technicalAssetId: ids.technicalAsset },
      include: { currentVersion: { include: { components: true } } }
    });
    const current = release.currentVersion;
    if (!current) throw new Error("published Release fixture missing");
    const sourceVersion = await db.controlledDocumentVersion.findFirstOrThrow({
      where: { documentId: ids.document, status: "PUBLISHED" }
    });
    const draft = await createAssetReleaseRevision({
      technicalAssetId: ids.technicalAsset,
      releaseId: release.id,
      version: release.version,
      releaseNotes: "修订软件 Release",
      components: [
        {
          position: 1,
          componentType: "SOFTWARE",
          sourceProjectId: ids.project,
          sourceDocumentVersionId: sourceVersion.id,
          sourceVersion: 1,
          sourceStatus: "PUBLISHED",
          sourceChecksum,
          files: [
            { fileId: ids.file, sha256: sourceChecksum, mimeType: "application/zip", size: 1024 }
          ],
          metadata: { gitRef: "refs/tags/release-2", packageChecksum: sourceChecksum }
        }
      ],
      actorId: ids.actor,
      reason: "创建 Release 修订",
      auditContext: context(ids.actor, `release-revision-${suffix}`)
    });
    expect(draft.releaseVersion).toMatchObject({ revision: 2, status: "DRAFT" });
    const published = await publishAssetReleaseVersion({
      technicalAssetId: ids.technicalAsset,
      releaseId: release.id,
      releaseVersionId: draft.releaseVersion.id,
      version: draft.resourceVersion,
      releaseVersion: 2,
      actorId: ids.actor,
      reason: "发布 Release 修订",
      auditContext: context(ids.actor, `release-revision-publish-${suffix}`)
    });
    expect(published.releaseVersion).toMatchObject({ revision: 2, status: "PUBLISHED" });
    await expect(
      db.assetReleaseVersion.findUniqueOrThrow({ where: { id: current.id } })
    ).resolves.toMatchObject({ status: "SUPERSEDED", releaseNotes: "首版软件 Release" });
    await expect(
      db.assetComponentSnapshot.findFirstOrThrow({ where: { releaseVersionId: current.id } })
    ).resolves.toMatchObject({ snapshotJson: current.components[0]!.snapshotJson });
  });

  it("rejects physical mutation of a published version and its components", async () => {
    const release = await db.assetRelease.findFirstOrThrow({
      where: { technicalAssetId: ids.technicalAsset },
      include: { currentVersion: { include: { components: true } } }
    });
    const published = release.currentVersion;
    if (!published) throw new Error("published Release fixture missing");
    await expect(
      db.assetReleaseVersion.update({
        where: { id: published.id },
        data: { releaseNotes: "篡改" }
      })
    ).rejects.toThrow(/immutable/u);
    await expect(db.assetReleaseVersion.delete({ where: { id: published.id } })).rejects.toThrow(
      /cannot be deleted/u
    );
    await expect(
      db.$executeRawUnsafe(
        `TRUNCATE TABLE "asset_impact_alert_projection_attempts", "asset_impact_dispositions", "asset_impact_risk_acceptance_decisions", "asset_impact_risk_acceptance_requests", "asset_impact_assessment_revisions", "asset_project_impacts", "asset_release_recall_affected_versions", "asset_release_recall_revisions", "asset_release_recalls", "asset_upgrade_usage_mappings", "asset_upgrade_adoptions", "asset_upgrade_candidates", "project_asset_derivations", "project_asset_usages", "project_asset_references", "asset_component_snapshots", "asset_release_versions", "asset_releases"`
      )
    ).rejects.toThrow(/cannot be truncated|TRUNCATE is forbidden/u);
  });
});
