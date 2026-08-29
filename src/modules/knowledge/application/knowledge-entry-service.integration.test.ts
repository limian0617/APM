import { randomUUID } from "node:crypto";

import { beforeAll, describe, expect, it } from "vitest";

import { db } from "@/lib/db";
import type { AuditContext } from "@/modules/audit/contracts/audit";

import {
  reviewKnowledgeEntryVersion,
  revokeKnowledgeEntryVersion
} from "./knowledge-entry-service";

const describeDatabase = process.env.RUN_DATABASE_INTEGRATION === "1" ? describe : describe.skip;
const suffix = randomUUID().slice(0, 8);
const ids = {
  author: `knowledge-entry-author-${suffix}`,
  reviewer: `knowledge-entry-reviewer-${suffix}`,
  project: `knowledge-entry-project-${suffix}`,
  entry: `knowledge-entry-${suffix}`,
  version: `knowledge-entry-version-${suffix}`
};

const checksum = (value: string) => value.padEnd(64, "0").slice(0, 64);
const sourceTemplateChecksum = "1".repeat(64);
const snapshotChecksum = "2".repeat(64);
const auditContext = (actorId: string, operationId: string): AuditContext => ({
  actorId,
  source: "API" as const,
  requestId: `knowledge-entry-${operationId}`,
  traceId: null,
  sourceIp: null,
  userAgent: "Vitest",
  reason: "APM-104 knowledge entry integration test",
  projectId: null,
  departmentId: null,
  operationId
});

async function createReadySourceProject() {
  const publishedAt = new Date("2026-08-15T00:00:00.000Z");
  const template = await db.projectTemplate.create({
    data: {
      code: `KNOWLEDGE.ENTRY.TEMPLATE.${suffix}`.toUpperCase(),
      name: "Knowledge entry fixture template",
      status: "ACTIVE",
      currentVersion: 1,
      createdById: ids.author,
      updatedById: ids.author,
      versions: {
        create: {
          version: 1,
          status: "PUBLISHED",
          name: "Knowledge entry fixture template",
          checksum: sourceTemplateChecksum,
          publishedById: ids.author,
          publishedAt
        }
      }
    },
    include: { versions: true }
  });
  const version = template.versions[0]!;
  await db.project.create({
    data: {
      id: ids.project,
      code: `KNOWLEDGE.ENTRY.${suffix}`.toUpperCase(),
      name: "Knowledge entry source project",
      status: "CLOSED",
      initializationStatus: "READY",
      projectType: "CUSTOMER_DELIVERY",
      equipmentShape: "SINGLE_MACHINE",
      structureStatus: "READY",
      sourceTemplateVersionId: version.id,
      sourceTemplateChecksum: version.checksum,
      initializedAt: publishedAt,
      createdById: ids.author
    }
  });
  await db.projectTemplateSnapshot.create({
    data: {
      projectId: ids.project,
      sourceTemplateVersionId: version.id,
      sourceTemplateChecksum: version.checksum,
      snapshotChecksum,
      templateCode: template.code,
      templateName: version.name,
      templateVersion: version.version,
      templatePublishedAt: version.publishedAt
    }
  });
}

async function createSourceGraph() {
  const archive = await db.projectArchive.create({ data: { projectId: ids.project } });
  const archiveA = await db.projectArchiveVersion.create({
    data: {
      archiveId: archive.id,
      projectId: ids.project,
      version: 1,
      status: "READY",
      manifestChecksum: checksum("a"),
      sourceWatermark: checksum("b"),
      snapshotJson: { archive: "A" },
      externalPublicationApplicability: "NOT_APPLICABLE",
      externalPublicationReason: "Not applicable.",
      archiveSourceFormulaVersion: "V2",
      retrospectiveInputApplicability: "APPLICABLE",
      retrospectiveInputWatermarkVersion: "RETROSPECTIVE.INPUT@1",
      retrospectiveInputSnapshotJson: { input: "A" },
      retrospectiveInputWatermark: checksum("c"),
      createdById: ids.author
    }
  });
  const archiveB = await db.projectArchiveVersion.create({
    data: {
      archiveId: archive.id,
      projectId: ids.project,
      version: 2,
      status: "FINALIZED",
      manifestChecksum: checksum("d"),
      sourceWatermark: checksum("e"),
      snapshotJson: { archive: "B" },
      externalPublicationApplicability: "NOT_APPLICABLE",
      externalPublicationReason: "Not applicable.",
      archiveSourceFormulaVersion: "V2",
      retrospectiveInputApplicability: "APPLICABLE",
      retrospectiveInputWatermarkVersion: "RETROSPECTIVE.INPUT@1",
      retrospectiveInputSnapshotJson: { input: "B" },
      retrospectiveInputWatermark: checksum("c"),
      createdById: ids.author,
      finalizedAt: new Date()
    }
  });
  const retrospective = await db.projectRetrospective.create({
    data: {
      projectId: ids.project,
      version: 1,
      createdById: ids.author,
      updatedById: ids.author
    }
  });
  const retrospectiveVersion = await db.projectRetrospectiveVersion.create({
    data: {
      projectId: ids.project,
      retrospectiveId: retrospective.id,
      versionNo: 1,
      status: "APPROVED",
      retrospectiveInputArchiveVersionId: archiveA.id,
      retrospectiveInputManifestChecksum: archiveA.manifestChecksum,
      retrospectiveInputSourceWatermark: archiveA.sourceWatermark,
      retrospectiveInputWatermarkVersion: "RETROSPECTIVE.INPUT@1",
      retrospectiveInputWatermark: archiveA.retrospectiveInputWatermark!,
      projectSnapshotJson: { project: ids.project },
      deliverySummaryJson: { completed: true },
      successfulPracticesJson: [],
      shortcomingsJson: [],
      improvementsJson: [],
      knowledgeDispositionJson: { disposition: "INTERNAL" },
      ipDeclarationJson: { sanitized: true },
      contentChecksum: checksum("f"),
      createdById: ids.author
    }
  });
  return { archiveA, archiveB, retrospectiveVersion };
}

describeDatabase("APM-104 PostgreSQL knowledge publish and revoke", () => {
  beforeAll(async () => {
    await db.user.createMany({
      data: [
        {
          id: ids.author,
          employeeNo: `KNOWLEDGE-ENTRY-AUTHOR-${suffix}`.toUpperCase(),
          name: "Knowledge entry author"
        },
        {
          id: ids.reviewer,
          employeeNo: `KNOWLEDGE-ENTRY-REVIEWER-${suffix}`.toUpperCase(),
          name: "Knowledge entry reviewer"
        }
      ]
    });
    await createReadySourceProject();
    const graph = await createSourceGraph();
    await db.knowledgeEntry.create({
      data: {
        id: ids.entry,
        code: `KNOWLEDGE.ENTRY.${suffix}`.toUpperCase(),
        status: "ACTIVE",
        version: 1,
        createdById: ids.author,
        updatedById: ids.author
      }
    });
    await db.knowledgeEntryVersion.create({
      data: {
        id: ids.version,
        entryId: ids.entry,
        sourceProjectId: ids.project,
        versionNo: 1,
        status: "IN_REVIEW",
        title: "脱敏调试经验",
        sanitizedSummary: "已脱敏并可供内部复用的调试经验。",
        experienceType: "COMMISSIONING",
        discipline: "ELECTRICAL",
        normalizedKeywordsJson: ["伺服", "调试"],
        normalizedKeywordsText: "伺服 调试",
        applicableProjectTypesJson: ["CUSTOMER_DELIVERY"],
        applicableStageCodesJson: ["S5"],
        preconditions: "已确认参数基线。",
        recommendedPractice: "逐步调整并记录结果。",
        antiPatterns: "不得复制客户原始数据。",
        limitations: "仅适用于受控调试。",
        ipSanitizationDeclaration: "已完成知识产权与脱敏检查。",
        internalReusable: true,
        contentChecksum: checksum("g"),
        createdById: ids.author,
        submittedById: ids.author,
        submittedAt: new Date()
      }
    });
    await db.knowledgeEntrySource.create({
      data: {
        knowledgeVersionId: ids.version,
        sourceProjectId: ids.project,
        finalArchiveVersionId: graph.archiveB.id,
        finalArchiveFormula: "V2",
        finalArchiveManifestChecksum: graph.archiveB.manifestChecksum,
        finalArchiveSourceWatermark: graph.archiveB.sourceWatermark,
        retrospectiveInputArchiveVersionId: graph.archiveA.id,
        retrospectiveInputFormula: "V2",
        retrospectiveInputManifestChecksum: graph.archiveA.manifestChecksum,
        retrospectiveInputSourceWatermark: graph.archiveA.sourceWatermark,
        retrospectiveInputWatermark: graph.archiveA.retrospectiveInputWatermark!,
        retrospectiveVersionId: graph.retrospectiveVersion.id,
        retrospectiveVersionNo: graph.retrospectiveVersion.versionNo,
        retrospectiveContentChecksum: graph.retrospectiveVersion.contentChecksum,
        issueId: null,
        issueHistoryId: null,
        issueHistorySequence: null,
        sourceChecksum: checksum("h"),
        sanitizedSnapshotJson: { category: "FUNCTION", severity: "LOW", status: "CLOSED" }
      }
    });
  });

  it("publishes the exact in-review version then revokes it with atomic audit and Outbox facts", async () => {
    const published = await reviewKnowledgeEntryVersion({
      entryId: ids.entry,
      versionId: ids.version,
      expectedEntryVersion: 1,
      decision: "PUBLISH",
      reason: "独立审核确认脱敏且允许内部复用。",
      ipConfirmed: true,
      sanitizationConfirmed: true,
      actorId: ids.reviewer,
      idempotencyKey: `knowledge-publish-${suffix}`,
      auditContext: auditContext(ids.reviewer, `publish-${suffix}`),
      sourceRead: { knowledgePermissionAllowed: true, sourceProjectReadAllowed: true }
    });
    expect(published).toMatchObject({ status: "PUBLISHED", entryVersion: 2 });
    await expect(
      db.knowledgeEntry.findUniqueOrThrow({ where: { id: ids.entry } })
    ).resolves.toMatchObject({
      status: "ACTIVE",
      version: 2,
      currentPublishedVersionId: ids.version
    });

    const revoked = await revokeKnowledgeEntryVersion({
      entryId: ids.entry,
      versionId: ids.version,
      expectedEntryVersion: 2,
      reason: "后续合规审查要求撤销该知识。",
      actorId: ids.reviewer,
      idempotencyKey: `knowledge-revoke-${suffix}`,
      auditContext: auditContext(ids.reviewer, `revoke-${suffix}`),
      sourceRead: { knowledgePermissionAllowed: true, sourceProjectReadAllowed: true }
    });
    expect(revoked).toMatchObject({ status: "REVOKED" });
    await expect(
      db.knowledgeEntry.findUniqueOrThrow({ where: { id: ids.entry } })
    ).resolves.toMatchObject({ status: "REVOKED", version: 3, currentPublishedVersionId: null });
    await expect(
      db.auditLog.count({
        where: {
          projectId: ids.project,
          action: { in: ["KNOWLEDGE_ENTRY_PUBLISHED", "KNOWLEDGE_ENTRY_REVIEWED"] }
        }
      })
    ).resolves.toBe(2);
    await expect(
      db.outboxEvent.count({
        where: {
          aggregateId: ids.version,
          eventType: {
            in: ["knowledge.entry-version.published", "knowledge.entry-version.revoked"]
          }
        }
      })
    ).resolves.toBe(2);
  });
});
