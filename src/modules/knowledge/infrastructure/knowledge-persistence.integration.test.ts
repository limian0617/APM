import { randomUUID } from "node:crypto";

import { beforeAll, describe, expect, it } from "vitest";

import { db } from "@/lib/db";

const describeDatabase = process.env.RUN_DATABASE_INTEGRATION === "1" ? describe : describe.skip;
const suffix = randomUUID().slice(0, 8);
const ids = {
  user: `knowledge-persistence-user-${suffix}`,
  sourceProject: `knowledge-persistence-source-${suffix}`,
  otherProject: `knowledge-persistence-other-${suffix}`,
  targetMembership: `knowledge-persistence-target-member-${suffix}`,
  entryA: `knowledge-persistence-entry-a-${suffix}`,
  entryB: `knowledge-persistence-entry-b-${suffix}`,
  versionA: `knowledge-persistence-version-a-${suffix}`,
  versionB: `knowledge-persistence-version-b-${suffix}`
};

function checksum(value: string) {
  return value.padEnd(64, "0").slice(0, 64);
}

const sourceTemplateChecksum = "5".repeat(64);
const snapshotChecksum = "6".repeat(64);

async function createReadyProjects() {
  const publishedAt = new Date("2026-08-15T00:00:00.000Z");
  const template = await db.projectTemplate.create({
    data: {
      code: `KNOWLEDGE.PERSISTENCE.TEMPLATE.${suffix}`.toUpperCase(),
      name: "Knowledge persistence fixture template",
      status: "ACTIVE",
      currentVersion: 1,
      createdById: ids.user,
      updatedById: ids.user,
      versions: {
        create: {
          version: 1,
          status: "PUBLISHED",
          name: "Knowledge persistence fixture template",
          checksum: sourceTemplateChecksum,
          publishedById: ids.user,
          publishedAt
        }
      }
    },
    include: { versions: true }
  });
  const version = template.versions[0]!;
  for (const project of [
    {
      id: ids.sourceProject,
      code: `KNOWLEDGE.SOURCE.${suffix}`.toUpperCase(),
      name: "Knowledge source project",
      status: "CLOSED" as const
    },
    {
      id: ids.otherProject,
      code: `KNOWLEDGE.OTHER.${suffix}`.toUpperCase(),
      name: "Knowledge other project",
      status: "IN_PROGRESS" as const
    }
  ]) {
    await db.project.create({
      data: {
        ...project,
        initializationStatus: "READY",
        projectType: "CUSTOMER_DELIVERY",
        equipmentShape: "SINGLE_MACHINE",
        structureStatus: "READY",
        sourceTemplateVersionId: version.id,
        sourceTemplateChecksum: version.checksum,
        initializedAt: publishedAt,
        createdById: ids.user
      }
    });
    await db.projectTemplateSnapshot.create({
      data: {
        projectId: project.id,
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
}

async function createArchiveAndRetrospective(projectId: string, label: string) {
  const archive = await db.projectArchive.create({ data: { projectId } });
  const archiveA = await db.projectArchiveVersion.create({
    data: {
      archiveId: archive.id,
      projectId,
      version: 1,
      status: "READY",
      manifestChecksum: checksum(`${label}-archive-a-manifest`),
      sourceWatermark: checksum(`${label}-archive-a-watermark`),
      snapshotJson: { label, archive: "A" },
      externalPublicationApplicability: "NOT_APPLICABLE",
      externalPublicationReason: "External publication is not applicable.",
      archiveSourceFormulaVersion: "V2",
      retrospectiveInputApplicability: "APPLICABLE",
      retrospectiveInputWatermarkVersion: "RETROSPECTIVE.INPUT@1",
      retrospectiveInputSnapshotJson: { label, input: true },
      retrospectiveInputWatermark: checksum(`${label}-retrospective-input`),
      createdById: ids.user
    }
  });
  const archiveB = await db.projectArchiveVersion.create({
    data: {
      archiveId: archive.id,
      projectId,
      version: 2,
      status: "FINALIZED",
      manifestChecksum: checksum(`${label}-archive-b-manifest`),
      sourceWatermark: checksum(`${label}-archive-b-watermark`),
      snapshotJson: { label, archive: "B" },
      externalPublicationApplicability: "NOT_APPLICABLE",
      externalPublicationReason: "External publication is not applicable.",
      archiveSourceFormulaVersion: "V2",
      retrospectiveInputApplicability: "APPLICABLE",
      retrospectiveInputWatermarkVersion: "RETROSPECTIVE.INPUT@1",
      retrospectiveInputSnapshotJson: { label, input: true },
      retrospectiveInputWatermark: checksum(`${label}-retrospective-input`),
      createdById: ids.user,
      finalizedAt: new Date()
    }
  });
  const retrospective = await db.projectRetrospective.create({
    data: {
      projectId,
      version: 1,
      createdById: ids.user,
      updatedById: ids.user
    }
  });
  const retrospectiveVersion = await db.projectRetrospectiveVersion.create({
    data: {
      projectId,
      retrospectiveId: retrospective.id,
      versionNo: 1,
      status: "APPROVED",
      retrospectiveInputArchiveVersionId: archiveA.id,
      retrospectiveInputManifestChecksum: archiveA.manifestChecksum,
      retrospectiveInputSourceWatermark: archiveA.sourceWatermark,
      retrospectiveInputWatermarkVersion: "RETROSPECTIVE.INPUT@1",
      retrospectiveInputWatermark: archiveA.retrospectiveInputWatermark!,
      projectSnapshotJson: { label },
      deliverySummaryJson: { label },
      successfulPracticesJson: [],
      shortcomingsJson: [],
      improvementsJson: [],
      knowledgeDispositionJson: { disposition: "INTERNAL" },
      ipDeclarationJson: { sanitized: true },
      contentChecksum: checksum(`${label}-retrospective-content`),
      createdById: ids.user
    }
  });
  return { archiveA, archiveB, retrospectiveVersion };
}

function knowledgeVersionData(input: { id: string; entryId: string }) {
  return {
    id: input.id,
    entryId: input.entryId,
    sourceProjectId: ids.sourceProject,
    versionNo: 1,
    status: "PUBLISHED" as const,
    title: "Sanitized knowledge",
    sanitizedSummary: "Sanitized internal experience.",
    experienceType: "COMMISSIONING",
    discipline: "ELECTRICAL",
    normalizedKeywordsJson: ["knowledge"],
    normalizedKeywordsText: "knowledge",
    applicableProjectTypesJson: ["CUSTOMER_DELIVERY"],
    applicableStageCodesJson: ["S5"],
    preconditions: "Controlled condition.",
    recommendedPractice: "Use the controlled practice.",
    antiPatterns: "Do not include customer data.",
    limitations: "Internal use only.",
    ipSanitizationDeclaration: "Customer information removed.",
    internalReusable: true,
    contentChecksum: checksum(input.id),
    createdById: ids.user,
    submittedById: ids.user,
    submittedAt: new Date(),
    publishedById: ids.user,
    publishedAt: new Date()
  };
}

describeDatabase("APM-104 PostgreSQL knowledge composite foreign keys", () => {
  let sourceGraph: Awaited<ReturnType<typeof createArchiveAndRetrospective>>;
  let otherGraph: Awaited<ReturnType<typeof createArchiveAndRetrospective>>;

  beforeAll(async () => {
    await db.user.create({
      data: {
        id: ids.user,
        employeeNo: `KNOWLEDGE-PERSISTENCE-${suffix}`.toUpperCase(),
        name: "Knowledge persistence integration user"
      }
    });
    await createReadyProjects();
    await db.projectMember.create({
      data: {
        id: ids.targetMembership,
        projectId: ids.otherProject,
        userId: ids.user,
        projectRole: "PROJECT_MANAGER",
        assignedById: ids.user
      }
    });
    sourceGraph = await createArchiveAndRetrospective(ids.sourceProject, "source");
    otherGraph = await createArchiveAndRetrospective(ids.otherProject, "other");
    await db.knowledgeEntry.createMany({
      data: [
        {
          id: ids.entryA,
          code: `KNOWLEDGE.ENTRY.A.${suffix}`.toUpperCase(),
          status: "ACTIVE",
          createdById: ids.user,
          updatedById: ids.user
        },
        {
          id: ids.entryB,
          code: `KNOWLEDGE.ENTRY.B.${suffix}`.toUpperCase(),
          status: "ACTIVE",
          createdById: ids.user,
          updatedById: ids.user
        }
      ]
    });
    await db.knowledgeEntryVersion.create({
      data: knowledgeVersionData({ id: ids.versionA, entryId: ids.entryA })
    });
    await db.knowledgeEntryVersion.create({
      data: knowledgeVersionData({ id: ids.versionB, entryId: ids.entryB })
    });
  });

  it("rejects a source-project knowledge version that references another project's archive and retrospective", async () => {
    await expect(
      db.knowledgeEntrySource.create({
        data: {
          knowledgeVersionId: ids.versionA,
          sourceProjectId: ids.sourceProject,
          finalArchiveVersionId: otherGraph.archiveB.id,
          finalArchiveFormula: "V2",
          finalArchiveManifestChecksum: otherGraph.archiveB.manifestChecksum,
          finalArchiveSourceWatermark: otherGraph.archiveB.sourceWatermark,
          retrospectiveInputArchiveVersionId: otherGraph.archiveA.id,
          retrospectiveInputFormula: "V2",
          retrospectiveInputManifestChecksum: sourceGraph.archiveA.manifestChecksum,
          retrospectiveInputSourceWatermark: sourceGraph.archiveA.sourceWatermark,
          retrospectiveInputWatermark: sourceGraph.archiveA.retrospectiveInputWatermark!,
          retrospectiveVersionId: otherGraph.retrospectiveVersion.id,
          retrospectiveVersionNo: otherGraph.retrospectiveVersion.versionNo,
          retrospectiveContentChecksum: otherGraph.retrospectiveVersion.contentChecksum,
          issueId: null,
          issueHistoryId: null,
          issueHistorySequence: null,
          sourceChecksum: checksum("cross-project-source"),
          sanitizedSnapshotJson: { sanitized: true }
        }
      })
    ).rejects.toMatchObject({ code: "P2003" });
  });

  it("rejects a review that pairs an entry with another entry's version", async () => {
    await expect(
      db.knowledgeEntryReview.create({
        data: {
          projectId: ids.sourceProject,
          knowledgeEntryId: ids.entryA,
          knowledgeVersionId: ids.versionB,
          decision: "PUBLISH",
          reason: "Cross-entry review must be rejected.",
          ipConfirmed: true,
          sanitizationConfirmed: true,
          reviewerId: ids.user,
          reviewedAt: new Date(),
          sourceChecksum: checksum("cross-entry-review")
        }
      })
    ).rejects.toMatchObject({ code: "P2003" });
  });

  it("rejects a reuse record that pairs an entry with another entry's version", async () => {
    await expect(
      db.knowledgeReuseRecord.create({
        data: {
          targetProjectId: ids.otherProject,
          targetDeliveryUnitId: null,
          knowledgeEntryId: ids.entryA,
          knowledgeVersionId: ids.versionB,
          scenario: "Cross-entry reuse must be rejected.",
          evidenceSummary: "Manual confirmation input.",
          confirmedById: ids.targetMembership,
          confirmedAt: new Date(),
          idempotencyKey: `cross-entry-reuse-${suffix}`
        }
      })
    ).rejects.toMatchObject({ code: "P2003" });
  });
});
