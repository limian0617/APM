import { randomUUID } from "node:crypto";

import {
  PrismaClient,
  type AssetImpactDispositionType,
  type AssetProjectImpactStatus,
  type Prisma
} from "@prisma/client";
import { beforeAll, describe, expect, it } from "vitest";

import { db } from "@/lib/db";
import type { AuditContext } from "@/modules/audit/contracts/audit";
import { payloadHash } from "@/modules/governance/domain/idempotency";
import { generateAcceptanceReport } from "@/modules/acceptance/application/acceptance-report-service";
import { MemoryObjectStorage } from "@/modules/documents/infrastructure/memory-object-storage";

import {
  createAssetReleaseRecall,
  createAssetUpgradeCandidate,
  listAssetReleaseRecalls,
  listAssetUpgradeCandidates,
  reviseAssetReleaseRecall
} from "../application/asset-upgrade-impact-service";
import { adoptProjectAssetUpgrade } from "../application/asset-upgrade-adoption-service";
import {
  createProjectAssetReference,
  createProjectAssetUsage,
  retireProjectAssetUsage
} from "../application/project-asset-usage-service";
import {
  closeProjectAssetImpact,
  decideProjectAssetImpactRiskAcceptance,
  getProjectAssetImpact,
  listProjectAssetImpacts,
  projectAssetImpactsFromSourceEvent,
  recordProjectAssetImpactDisposition,
  requestProjectAssetImpactRiskAcceptance,
  refreshProjectAssetImpact
} from "../application/project-asset-impact-service";

import {
  buildAssetDeactivationImpactAssessmentSource,
  buildAssetImpactAssessmentSource,
  buildAssetReleaseRecallAffectedVersionSet
} from "../domain/asset-upgrade-impact";

const describeDatabase = process.env.RUN_DATABASE_INTEGRATION === "1" ? describe : describe.skip;
const suffix = randomUUID().slice(0, 8);
const ids = {
  actor: `asset-impact-actor-${suffix}`,
  project: `asset-impact-project-${suffix}`,
  sourceFile: `asset-impact-source-file-${suffix}`,
  sourceDocument: `asset-impact-source-document-${suffix}`,
  sourceDocumentVersion: `asset-impact-source-document-version-${suffix}`,
  rndProject: `asset-impact-rnd-${suffix}`,
  recallAsset: `asset-impact-recall-asset-${suffix}`,
  disabledAsset: `asset-impact-disabled-asset-${suffix}`,
  release: `asset-impact-release-${suffix}`,
  releaseVersion: `asset-impact-release-version-${suffix}`,
  secondReleaseVersion: `asset-impact-second-release-version-${suffix}`,
  recall: `asset-impact-recall-${suffix}`,
  affectedVersion: `asset-impact-affected-version-${suffix}`,
  secondAffectedVersion: `asset-impact-second-affected-version-${suffix}`,
  recallRevision: `asset-impact-recall-revision-${suffix}`
};

const checksum = "a".repeat(64);
const authorizationActor = {
  id: ids.actor,
  name: "资产升级影响测试操作人",
  status: "ACTIVE" as const,
  departmentId: null,
  systemRoles: ["TECHNICAL_ASSET_MAINTAINER"],
  grants: []
};

function auditContext(operationId: string): AuditContext {
  return {
    actorId: ids.actor,
    requestId: `request-${operationId}`,
    traceId: null,
    source: "API",
    sourceIp: null,
    userAgent: "Vitest",
    reason: null,
    projectId: null,
    departmentId: null,
    operationId
  };
}

function recallAssessmentSource(input: {
  recallId: string;
  recallRevisionId: string;
  recallRevisionNumber: number;
  recallRevisionSnapshotChecksum: string;
  recallRevisionKind: "ISSUED" | "CORRECTED" | "WITHDRAWN" | "REISSUED";
  recallRevisionState: "ACTIVE" | "WITHDRAWN";
  projectFactsWatermark: string;
}) {
  const source = buildAssetImpactAssessmentSource(input);
  return {
    recallId: input.recallId,
    recallRevisionId: input.recallRevisionId,
    sourceWatermark: source.sourceWatermark,
    snapshotJson: source
  };
}

async function appendDisableEvent(
  transaction: Prisma.TransactionClient,
  input: { assetId: string; rndProjectId: string; eventId: string }
) {
  const asset = await transaction.technicalAsset.findUniqueOrThrow({
    where: { id: input.assetId }
  });
  const latest = await transaction.technicalAssetEvent.findFirst({
    where: { technicalAssetId: input.assetId },
    orderBy: { sequence: "desc" },
    select: { sequence: true }
  });
  await transaction.technicalAssetEvent.create({
    data: {
      id: input.eventId,
      rndProjectId: input.rndProjectId,
      technicalAssetId: input.assetId,
      sequence: (latest?.sequence ?? 0) + 1,
      eventType: "STATUS_CHANGED",
      fromStatus: "VALIDATED",
      toStatus: "DISABLED",
      reason: "停用 exact 资产事实",
      snapshotJson: {
        rndProjectId: asset.rndProjectId,
        technicalAssetId: asset.id,
        assetNumber: asset.assetNumber,
        assetType: asset.assetType,
        name: asset.name,
        description: asset.description,
        ownerId: asset.ownerId,
        status: asset.status,
        version: asset.version
      },
      actorId: ids.actor
    }
  });
}

async function createPublishedReleaseVersion(input: {
  releaseCode: string;
  revision: number;
  releaseId?: string;
  releaseVersionId?: string;
  technicalAssetId?: string;
}) {
  const technicalAssetId = input.technicalAssetId ?? ids.recallAsset;
  const releaseId = input.releaseId ?? `asset-impact-release-${input.releaseCode}-${suffix}`;
  const releaseVersionId =
    input.releaseVersionId ?? `asset-impact-release-version-${input.releaseCode}-${suffix}`;
  await db.assetRelease.create({
    data: {
      id: releaseId,
      technicalAssetId,
      releaseCode: input.releaseCode,
      createdById: ids.actor
    }
  });
  await db.assetReleaseVersion.create({
    data: {
      id: releaseVersionId,
      releaseId,
      technicalAssetId,
      revision: input.revision,
      status: "PUBLISHED",
      snapshotChecksum: checksum,
      sourceWatermark: `watermark-${input.releaseCode}`,
      createdById: ids.actor,
      publishedById: ids.actor,
      publishedAt: new Date()
    }
  });
  return { releaseId, releaseVersionId };
}

async function transactionTimeouts(transaction: Prisma.TransactionClient) {
  await transaction.$executeRawUnsafe("SET LOCAL lock_timeout = '5s'");
  await transaction.$executeRawUnsafe("SET LOCAL statement_timeout = '10s'");
  await transaction.$executeRawUnsafe("SET LOCAL TIME ZONE 'Asia/Shanghai'");
}

async function createOpenImpact(label: string) {
  const prefix = `asset-impact-state-${label}-${suffix}`;
  const projectId = `${prefix}-project`;
  const membershipId = `${prefix}-membership`;
  const impactId = `${prefix}-impact`;
  const assessmentId = `${prefix}-assessment-1`;
  const ownerSnapshot = {
    membershipId,
    userId: ids.actor,
    projectRole: "PROJECT_MANAGER"
  };
  const dueAt = new Date(Date.now() + 86_400_000);
  await db.project.create({
    data: {
      id: projectId,
      code: `IMPACT-STATE-${label}-${suffix}`.toUpperCase(),
      name: `资产影响状态 ${label}`,
      createdById: ids.actor
    }
  });
  await db.projectMember.create({
    data: {
      id: membershipId,
      projectId,
      userId: ids.actor,
      projectRole: "PROJECT_MANAGER",
      assignedById: ids.actor
    }
  });
  await db.$transaction(async (transaction) => {
    await transaction.assetProjectImpact.create({
      data: {
        id: impactId,
        projectId,
        technicalAssetId: ids.recallAsset,
        sourceType: "RECALL",
        sourceKey: `RECALL:${ids.recall}`,
        recallId: ids.recall
      }
    });
    await transaction.assetImpactAssessmentRevision.create({
      data: {
        id: assessmentId,
        impactId,
        projectId,
        technicalAssetId: ids.recallAsset,
        sequence: 1,
        kind: "INITIAL",
        ...recallAssessmentSource({
          recallId: ids.recall,
          recallRevisionId: ids.recallRevision,
          recallRevisionNumber: 1,
          recallRevisionSnapshotChecksum: "c".repeat(64),
          recallRevisionKind: "ISSUED",
          recallRevisionState: "ACTIVE",
          projectFactsWatermark: `${prefix}-project-facts-1`
        }),
        snapshotChecksum: "8".repeat(64),
        frozenAt: new Date(0),
        ownerMembershipId: membershipId,
        ownerMembershipSnapshotJson: ownerSnapshot,
        dueAt
      }
    });
    await transaction.assetProjectImpact.update({
      where: { id: impactId },
      data: { currentAssessmentRevisionId: assessmentId, ownerMembershipId: membershipId, dueAt }
    });
  });
  return { prefix, projectId, membershipId, impactId, assessmentId, ownerSnapshot, dueAt };
}

async function createProjectImpactProjectionFixture(
  label: string,
  options?: { withUsage?: boolean }
) {
  const prefix = `asset-impact-projection-${label}-${suffix}`;
  const projectId = `${prefix}-project`;
  const membershipId = `${prefix}-membership`;
  const releaseCode = `REL-PROJECTION-${label}-${suffix}`.toUpperCase();
  await db.project.create({
    data: {
      id: projectId,
      code: `IMPACT-PROJECTION-${label}-${suffix}`.toUpperCase(),
      name: `资产影响投影服务测试项目 ${label}`,
      createdById: ids.actor
    }
  });
  await db.projectMember.create({
    data: {
      id: membershipId,
      projectId,
      userId: ids.actor,
      projectRole: "PROJECT_MANAGER",
      assignedById: ids.actor
    }
  });
  const release = await createPublishedReleaseVersion({ releaseCode, revision: 1 });
  const component = await db.assetComponentSnapshot.create({
    data: {
      releaseVersionId: release.releaseVersionId,
      technicalAssetId: ids.recallAsset,
      position: 1,
      componentType: "VALIDATION_REPORT",
      sourceProjectId: ids.project,
      sourceDocumentVersionId: ids.sourceDocumentVersion,
      sourceFileId: ids.sourceFile,
      sourceVersion: 1,
      sourceStatus: "PUBLISHED",
      sourceChecksum: checksum,
      sourceFileSha256: checksum,
      sourceFileMimeType: "application/pdf",
      sourceFileSize: 128n,
      snapshotJson: { files: [{ fileId: ids.sourceFile, sha256: checksum }] }
    }
  });
  const referenceId = `${prefix}-reference`;
  await db.projectAssetReference.create({
    data: {
      id: referenceId,
      projectId,
      technicalAssetId: ids.recallAsset,
      assetReleaseId: release.releaseId,
      assetReleaseVersionId: release.releaseVersionId,
      releaseCode,
      releaseRevision: 1,
      snapshotChecksum: checksum,
      sourceWatermark: `watermark-${releaseCode}`,
      createdById: ids.actor
    }
  });
  const usage = options?.withUsage
    ? await createProjectAssetUsage({
        projectId,
        referenceId,
        referenceVersion: 1,
        usageKey: `${prefix}-usage`,
        componentSnapshotId: component.id,
        quantity: "1",
        configuration: { purpose: `投影 ${label} 并发冻结事实` },
        scopeType: "PROJECT",
        scopeId: projectId,
        actorId: ids.actor,
        reason: `投影 ${label} 召回前实际使用`,
        authorizationActor,
        auditContext: auditContext(`${prefix}-usage-create`)
      })
    : null;
  const issued = await createAssetReleaseRecall({
    technicalAssetId: ids.recallAsset,
    releaseId: release.releaseId,
    releaseResourceVersion: 1,
    scope: "RELEASE_VERSION",
    targetReleaseVersionId: release.releaseVersionId,
    sourceAssetReleaseVersionId: release.releaseVersionId,
    severity: "HIGH",
    reason: `投影 ${label} 测试召回`,
    evidence: { componentSnapshotId: component.id },
    actorId: ids.actor,
    authorizationActor,
    auditContext: auditContext(`${prefix}-recall-issue`)
  });
  return {
    prefix,
    projectId,
    membershipId,
    release,
    component,
    referenceId,
    usage,
    issued,
    event: {
      eventType: "asset.release-recall.issued" as const,
      sourceId: issued.recallRevision.id,
      eventFingerprint: `${prefix}-fingerprint-1`
    }
  };
}

async function createServiceAdoptionFixture(label: string, options?: { withUsage?: boolean }) {
  const fixture = await createProjectImpactProjectionFixture(label, options);
  const impact = (await projectAssetImpactsFromSourceEvent(fixture.event)).items[0]!;
  for (const [action, version] of [
    ["ACKNOWLEDGE", 1],
    ["START_ASSESSMENT", 2],
    ["PLAN_UPGRADE", 3]
  ] as const) {
    await recordProjectAssetImpactDisposition({
      projectId: fixture.projectId,
      impactId: impact.impactId,
      action,
      version,
      reason: `并发升级采用准备 ${action}`,
      evidence: { action },
      actorId: ids.actor,
      authorizationActor,
      auditContext: auditContext(`${fixture.prefix}-${action.toLowerCase()}`)
    });
  }
  const targetCode = `REL-${label}-ADOPTION-TARGET-${suffix}`.toUpperCase();
  const targetRelease = await createPublishedReleaseVersion({
    releaseCode: targetCode,
    revision: 2
  });
  const targetComponent = await db.assetComponentSnapshot.create({
    data: {
      releaseVersionId: targetRelease.releaseVersionId,
      technicalAssetId: ids.recallAsset,
      position: 1,
      componentType: "VALIDATION_REPORT",
      sourceProjectId: ids.project,
      sourceDocumentVersionId: ids.sourceDocumentVersion,
      sourceFileId: ids.sourceFile,
      sourceVersion: 1,
      sourceStatus: "PUBLISHED",
      sourceChecksum: checksum,
      sourceFileSha256: checksum,
      sourceFileMimeType: "application/pdf",
      sourceFileSize: 128n,
      snapshotJson: { files: [{ fileId: ids.sourceFile, sha256: checksum }] }
    }
  });
  const sourceReference = await db.projectAssetReference.findUniqueOrThrow({
    where: { id: fixture.referenceId }
  });
  const candidate = await db.assetUpgradeCandidate.create({
    data: {
      technicalAssetId: ids.recallAsset,
      sourceAssetReleaseId: fixture.release.releaseId,
      sourceAssetReleaseVersionId: fixture.release.releaseVersionId,
      sourceRevision: sourceReference.releaseRevision,
      sourceSnapshotChecksum: sourceReference.snapshotChecksum,
      sourceWatermark: sourceReference.sourceWatermark,
      targetAssetReleaseId: targetRelease.releaseId,
      targetAssetReleaseVersionId: targetRelease.releaseVersionId,
      targetRevision: 2,
      targetSnapshotChecksum: checksum,
      targetWatermark: `watermark-${targetCode}`,
      compatibilitySnapshotJson: { level: "FULL" },
      compatibilitySnapshotChecksum: "6".repeat(64),
      createdById: ids.actor
    }
  });
  return {
    fixture,
    impact,
    targetRelease,
    adoptionInput: {
      projectId: fixture.projectId,
      candidateId: candidate.id,
      impactId: impact.impactId,
      impactVersion: 4,
      sourceReferenceId: sourceReference.id,
      sourceReferenceVersion: sourceReference.version,
      reason: `并发采用 ${label}`,
      mappings: fixture.usage
        ? [
            {
              sourceUsageId: fixture.usage.usage.id,
              sourceUsageVersion: fixture.usage.usage.resourceVersion,
              targetUsageKey: `${fixture.prefix}-target-usage`,
              targetComponentSnapshotId: targetComponent.id,
              migrationMode: "COPY" as const
            }
          ]
        : [],
      actorId: ids.actor,
      authorizationActor,
      auditContext: auditContext(`${fixture.prefix}-adopt`)
    },
    recallInput: {
      technicalAssetId: ids.recallAsset,
      releaseId: targetRelease.releaseId,
      releaseResourceVersion: 1,
      scope: "RELEASE_VERSION" as const,
      targetReleaseVersionId: targetRelease.releaseVersionId,
      sourceAssetReleaseVersionId: targetRelease.releaseVersionId,
      severity: "HIGH" as const,
      reason: `并发召回 ${label}`,
      evidence: { targetReleaseVersionId: targetRelease.releaseVersionId },
      actorId: ids.actor,
      authorizationActor,
      auditContext: auditContext(`${fixture.prefix}-target-recall`)
    }
  };
}

async function createWithdrawnServiceAdoptionFixture(label: string) {
  const fixture = await createServiceAdoptionFixture(label);
  await reviseAssetReleaseRecall({
    technicalAssetId: ids.recallAsset,
    recallId: fixture.fixture.issued.recall.id,
    version: fixture.fixture.issued.resourceVersion,
    kind: "WITHDRAWN",
    sourceAssetReleaseVersionId: fixture.fixture.release.releaseVersionId,
    severity: "LOW",
    reason: "撤回 source recall 以验证合法 usage create 并发",
    evidence: { componentSnapshotId: fixture.fixture.component.id },
    actorId: ids.actor,
    authorizationActor,
    auditContext: auditContext(`${fixture.fixture.prefix}-source-recall-withdraw`)
  });
  const refreshed = await refreshProjectAssetImpact({
    projectId: fixture.fixture.projectId,
    impactId: fixture.impact.impactId,
    version: fixture.adoptionInput.impactVersion,
    reason: "刷新到已撤回 source recall",
    evidence: { recallWithdrawn: true },
    actorId: ids.actor,
    authorizationActor,
    auditContext: auditContext(`${fixture.fixture.prefix}-withdrawn-impact-refresh`)
  });
  let version = refreshed.resourceVersion;
  for (const action of ["ACKNOWLEDGE", "START_ASSESSMENT", "PLAN_UPGRADE"] as const) {
    const result = await recordProjectAssetImpactDisposition({
      projectId: fixture.fixture.projectId,
      impactId: fixture.impact.impactId,
      action,
      version,
      reason: `撤回召回后的升级采用准备 ${action}`,
      evidence: { action, recallWithdrawn: true },
      actorId: ids.actor,
      authorizationActor,
      auditContext: auditContext(`${fixture.fixture.prefix}-withdrawn-${action.toLowerCase()}`)
    });
    version = result.resourceVersion;
  }
  return {
    ...fixture,
    adoptionInput: { ...fixture.adoptionInput, impactVersion: version }
  };
}

async function applyImpactDisposition(
  transaction: Prisma.TransactionClient,
  input: {
    fixture: Awaited<ReturnType<typeof createOpenImpact>>;
    id: string;
    assessmentRevisionId: string;
    sequence: number;
    type: AssetImpactDispositionType;
    fromStatus: AssetProjectImpactStatus;
    toStatus: AssetProjectImpactStatus;
    nextVersion: number;
    actorId?: string;
    actorMembershipId?: string;
    actorMembershipSnapshotJson?: Prisma.InputJsonValue;
    mitigationAdoptionId?: string;
    riskAcceptanceRequestId?: string;
    riskAcceptanceDecisionId?: string;
  }
) {
  const actorId = input.actorId ?? ids.actor;
  const actorMembershipId = input.actorMembershipId ?? input.fixture.membershipId;
  const actorMembershipSnapshotJson =
    input.actorMembershipSnapshotJson ?? input.fixture.ownerSnapshot;
  await transaction.assetImpactDisposition.create({
    data: {
      id: input.id,
      impactId: input.fixture.impactId,
      projectId: input.fixture.projectId,
      technicalAssetId: ids.recallAsset,
      assessmentRevisionId: input.assessmentRevisionId,
      sequence: input.sequence,
      type: input.type,
      fromStatus: input.fromStatus,
      toStatus: input.toStatus,
      reason: `${input.type} 并发原子写入`,
      evidenceJson: { dispositionType: input.type },
      actorId,
      actorMembershipId,
      actorMembershipSnapshotJson,
      ownerMembershipId: input.fixture.membershipId,
      ownerMembershipSnapshotJson: input.fixture.ownerSnapshot,
      dueAt: input.fixture.dueAt,
      mitigationAdoptionId: input.mitigationAdoptionId,
      riskAcceptanceRequestId: input.riskAcceptanceRequestId,
      riskAcceptanceDecisionId: input.riskAcceptanceDecisionId
    }
  });
  await transaction.assetProjectImpact.update({
    where: { id: input.fixture.impactId },
    data: {
      currentAssessmentRevisionId: input.assessmentRevisionId,
      status: input.toStatus,
      version: input.nextVersion
    }
  });
}

async function createZeroUsageAdoptionFixture(label: string) {
  const fixture = await createOpenImpact(label);
  const sourceCode = `REL-${label}-SOURCE-${suffix}`.toUpperCase();
  const targetCode = `REL-${label}-TARGET-${suffix}`.toUpperCase();
  const sourceRelease = await createPublishedReleaseVersion({
    releaseCode: sourceCode,
    revision: 1
  });
  const targetRelease = await createPublishedReleaseVersion({
    releaseCode: targetCode,
    revision: 1
  });
  for (const [sequence, type, fromStatus, toStatus, nextVersion] of [
    [1, "ACKNOWLEDGED", "OPEN", "ACKNOWLEDGED", 2],
    [2, "ASSESSING", "ACKNOWLEDGED", "ASSESSING", 3],
    [3, "UPGRADE_PLANNED", "ASSESSING", "UPGRADE_PLANNED", 4]
  ] as const) {
    await db.$transaction(async (transaction) => {
      await applyImpactDisposition(transaction, {
        fixture,
        id: `${fixture.prefix}-${type.toLowerCase()}-disposition`,
        assessmentRevisionId: fixture.assessmentId,
        sequence,
        type,
        fromStatus,
        toStatus,
        nextVersion
      });
    });
  }
  const sourceReferenceId = `${fixture.prefix}-source-reference`;
  const targetReferenceId = `${fixture.prefix}-target-reference`;
  const referenceData = (id: string, release: typeof sourceRelease, releaseCode: string) => ({
    id,
    projectId: fixture.projectId,
    technicalAssetId: ids.recallAsset,
    assetReleaseId: release.releaseId,
    assetReleaseVersionId: release.releaseVersionId,
    releaseCode,
    releaseRevision: 1,
    snapshotChecksum: checksum,
    sourceWatermark: `watermark-${releaseCode}`,
    createdById: ids.actor
  });
  await db.projectAssetReference.createMany({
    data: [
      referenceData(sourceReferenceId, sourceRelease, sourceCode),
      referenceData(targetReferenceId, targetRelease, targetCode)
    ]
  });
  const candidateId = `${fixture.prefix}-candidate`;
  await db.assetUpgradeCandidate.create({
    data: {
      id: candidateId,
      technicalAssetId: ids.recallAsset,
      sourceAssetReleaseId: sourceRelease.releaseId,
      sourceAssetReleaseVersionId: sourceRelease.releaseVersionId,
      sourceRevision: 1,
      sourceSnapshotChecksum: checksum,
      sourceWatermark: `watermark-${sourceCode}`,
      targetAssetReleaseId: targetRelease.releaseId,
      targetAssetReleaseVersionId: targetRelease.releaseVersionId,
      targetRevision: 1,
      targetSnapshotChecksum: checksum,
      targetWatermark: `watermark-${targetCode}`,
      compatibilitySnapshotJson: {},
      compatibilitySnapshotChecksum: "6".repeat(64),
      createdById: ids.actor
    }
  });
  const adoptionId = `${fixture.prefix}-adoption`;
  return {
    ...fixture,
    sourceRelease,
    targetRelease,
    sourceCode,
    targetCode,
    sourceReferenceId,
    targetReferenceId,
    candidateId,
    adoptionId,
    adoptionData: {
      id: adoptionId,
      candidateId,
      projectId: fixture.projectId,
      impactId: fixture.impactId,
      technicalAssetId: ids.recallAsset,
      sourceReferenceId,
      sourceReferenceVersion: 1,
      targetReferenceId,
      targetReferenceVersion: 1,
      sourceAssetReleaseId: sourceRelease.releaseId,
      sourceAssetReleaseVersionId: sourceRelease.releaseVersionId,
      sourceRevision: 1,
      sourceSnapshotChecksum: checksum,
      sourceWatermark: `watermark-${sourceCode}`,
      targetAssetReleaseId: targetRelease.releaseId,
      targetAssetReleaseVersionId: targetRelease.releaseVersionId,
      targetRevision: 1,
      targetSnapshotChecksum: checksum,
      targetWatermark: `watermark-${targetCode}`,
      reason: `并发采用 ${label}`,
      actorId: ids.actor,
      adoptedAt: new Date(0)
    },
    referenceData
  };
}

async function adoptZeroUsageUpgrade(
  fixture: Awaited<ReturnType<typeof createZeroUsageAdoptionFixture>>,
  signal?: () => void
) {
  await db.$transaction(async (transaction) => {
    await transactionTimeouts(transaction);
    await transaction.assetUpgradeAdoption.create({ data: fixture.adoptionData });
    signal?.();
    if (signal) {
      await transaction.$queryRaw`SELECT 1 AS "waited" FROM pg_sleep(0.15)`;
    }
    await transaction.projectAssetReference.update({
      where: { id: fixture.sourceReferenceId },
      data: {
        status: "RETIRED",
        version: 2,
        retiredById: ids.actor,
        retireReason: "并发测试完成零 usage 原子采用"
      }
    });
  });
}

describeDatabase("APM-064 PostgreSQL asset upgrade and impact contracts", () => {
  beforeAll(async () => {
    await db.user.create({
      data: {
        id: ids.actor,
        employeeNo: `ASSET-IMPACT-${suffix}`.toUpperCase(),
        name: "资产升级影响测试操作人"
      }
    });
    await db.project.create({
      data: {
        id: ids.project,
        code: `ASSET-IMPACT-${suffix}`.toUpperCase(),
        name: "资产升级影响测试项目",
        createdById: ids.actor
      }
    });
    await db.fileObject.create({
      data: {
        id: ids.sourceFile,
        projectId: ids.project,
        uploadedById: ids.actor,
        originalName: "asset-impact-source.pdf",
        declaredMimeType: "application/pdf",
        verifiedMimeType: "application/pdf",
        declaredSize: 128n,
        verifiedSize: 128n,
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
        id: ids.sourceDocument,
        projectId: ids.project,
        code: `IMPACT.SOURCE.${suffix}`.toUpperCase(),
        title: "资产影响来源文档",
        createdById: ids.actor,
        versions: {
          create: {
            id: ids.sourceDocumentVersion,
            version: 1,
            status: "DRAFT",
            sourceFileId: ids.sourceFile,
            sourceFileSha256: checksum,
            sourceMimeType: "application/pdf",
            sourceFileSize: 128n,
            createdById: ids.actor
          }
        }
      }
    });
    await db.$transaction(async (transaction) => {
      await transaction.controlledDocumentVersion.update({
        where: { id: ids.sourceDocumentVersion },
        data: { status: "PUBLISHED", publishedById: ids.actor, publishedAt: new Date() }
      });
      await transaction.controlledDocument.update({
        where: { id: ids.sourceDocument },
        data: { currentPublishedVersionId: ids.sourceDocumentVersion, version: 2 }
      });
    });
    await db.rndProject.create({
      data: {
        id: ids.rndProject,
        code: `RND.IMPACT.${suffix}`.toUpperCase(),
        name: "资产升级影响测试研发项目",
        ownerId: ids.actor,
        status: "IN_DEVELOPMENT",
        createdById: ids.actor
      }
    });
    await db.technicalAsset.createMany({
      data: [
        {
          id: ids.recallAsset,
          rndProjectId: ids.rndProject,
          assetNumber: `AST.IMPACT.RECALL.${suffix}`.toUpperCase(),
          assetType: "MECHANICAL",
          name: "召回影响测试资产",
          ownerId: ids.actor,
          status: "VALIDATED",
          createdById: ids.actor
        },
        {
          id: ids.disabledAsset,
          rndProjectId: ids.rndProject,
          assetNumber: `AST.IMPACT.DISABLED.${suffix}`.toUpperCase(),
          assetType: "MECHANICAL",
          name: "停用状态测试资产",
          ownerId: ids.actor,
          status: "VALIDATED",
          createdById: ids.actor
        }
      ]
    });
    await createPublishedReleaseVersion({
      releaseCode: `REL-IMPACT-${suffix}`.toUpperCase(),
      revision: 1,
      releaseId: ids.release,
      releaseVersionId: ids.releaseVersion
    });
  });

  it("grants risk decision reachability only to the accepted independent project roles", async () => {
    await expect(
      db.rolePermission.findMany({
        where: {
          roleId: { in: ["role-quality", "role-department-lead"] },
          permissionId: {
            in: ["permission-project-asset-usage-read", "permission-project-asset-usage-manage"]
          }
        },
        orderBy: [{ roleId: "asc" }, { permissionId: "asc" }]
      })
    ).resolves.toEqual([
      {
        roleId: "role-department-lead",
        permissionId: "permission-project-asset-usage-manage",
        scope: "PROJECT"
      },
      {
        roleId: "role-department-lead",
        permissionId: "permission-project-asset-usage-read",
        scope: "PROJECT"
      },
      {
        roleId: "role-quality",
        permissionId: "permission-project-asset-usage-manage",
        scope: "PROJECT"
      },
      {
        roleId: "role-quality",
        permissionId: "permission-project-asset-usage-read",
        scope: "PROJECT"
      }
    ]);
    await expect(
      db.rolePermission.count({
        where: {
          roleId: "role-finance",
          permissionId: {
            in: ["permission-project-asset-usage-read", "permission-project-asset-usage-manage"]
          }
        }
      })
    ).resolves.toBe(0);
  });

  it("creates and reads exact recall revisions and upgrade candidates through the application service", async () => {
    const prefix = `asset-impact-service-${suffix}`;
    const sourceRelease = await createPublishedReleaseVersion({
      releaseCode: `REL-SERVICE-SOURCE-${suffix}`.toUpperCase(),
      revision: 1
    });
    const targetRelease = await createPublishedReleaseVersion({
      releaseCode: `REL-SERVICE-TARGET-${suffix}`.toUpperCase(),
      revision: 1
    });
    for (const [position, versionId] of [
      [1, sourceRelease.releaseVersionId],
      [2, targetRelease.releaseVersionId]
    ] as const) {
      await db.assetComponentSnapshot.create({
        data: {
          releaseVersionId: versionId,
          technicalAssetId: ids.recallAsset,
          position: 1,
          componentType: "VALIDATION_REPORT",
          sourceProjectId: ids.project,
          sourceDocumentVersionId: ids.sourceDocumentVersion,
          sourceFileId: ids.sourceFile,
          sourceVersion: 1,
          sourceStatus: "PUBLISHED",
          sourceChecksum: checksum,
          sourceFileSha256: checksum,
          sourceFileMimeType: "application/pdf",
          sourceFileSize: 128n,
          snapshotJson: {
            files: [
              {
                fileId: ids.sourceFile,
                sha256: checksum,
                mimeType: "application/pdf",
                size: 128
              }
            ],
            fixturePosition: position
          }
        }
      });
    }

    const issued = await createAssetReleaseRecall({
      technicalAssetId: ids.recallAsset,
      releaseId: sourceRelease.releaseId,
      releaseResourceVersion: 1,
      scope: "RELEASE_VERSION",
      targetReleaseVersionId: sourceRelease.releaseVersionId,
      sourceAssetReleaseVersionId: sourceRelease.releaseVersionId,
      severity: "HIGH",
      reason: "service exact recall issue",
      evidence: { reportId: `${prefix}-report` },
      actorId: ids.actor,
      authorizationActor,
      auditContext: auditContext(`${prefix}-issue`)
    });
    expect(issued).toMatchObject({
      resourceVersion: 1,
      recallRevision: { revision: 1, kind: "ISSUED", state: "ACTIVE" }
    });
    await expect(
      db.assetReleaseRecallRevision.findUniqueOrThrow({
        where: { id: issued.recallRevision.id },
        select: { snapshotJson: true }
      })
    ).resolves.toMatchObject({
      snapshotJson: {
        sourceAssetReleaseId: sourceRelease.releaseId,
        sourceAssetReleaseVersionId: sourceRelease.releaseVersionId,
        sourceRevision: 1,
        sourceSnapshotChecksum: checksum,
        sourceWatermark: `watermark-${`REL-SERVICE-SOURCE-${suffix}`.toUpperCase()}`
      }
    });
    const withdrawn = await reviseAssetReleaseRecall({
      technicalAssetId: ids.recallAsset,
      recallId: issued.recall.id,
      version: issued.resourceVersion,
      kind: "WITHDRAWN",
      sourceAssetReleaseVersionId: sourceRelease.releaseVersionId,
      severity: "LOW",
      reason: "service exact recall withdrawal",
      evidence: { reportId: `${prefix}-withdrawal` },
      actorId: ids.actor,
      authorizationActor,
      auditContext: auditContext(`${prefix}-withdraw`)
    });
    expect(withdrawn).toMatchObject({
      resourceVersion: 2,
      recallRevision: { revision: 2, kind: "WITHDRAWN", state: "WITHDRAWN" }
    });
    await expect(
      db.assetReleaseRecallRevision.findUniqueOrThrow({
        where: { id: withdrawn.recallRevision.id },
        select: { snapshotJson: true }
      })
    ).resolves.toMatchObject({
      snapshotJson: {
        sourceAssetReleaseId: sourceRelease.releaseId,
        sourceAssetReleaseVersionId: sourceRelease.releaseVersionId,
        sourceRevision: 1,
        sourceSnapshotChecksum: checksum,
        sourceWatermark: `watermark-${`REL-SERVICE-SOURCE-${suffix}`.toUpperCase()}`
      }
    });
    const recallOutboxCountBeforeRead = await db.outboxEvent.count({
      where: { aggregateId: issued.recall.id }
    });
    const recalls = await listAssetReleaseRecalls({
      technicalAssetId: ids.recallAsset,
      releaseId: sourceRelease.releaseId,
      limit: 20,
      actorId: ids.actor,
      canManage: true,
      auditContext: auditContext(`${prefix}-recall-read`)
    });
    expect(recalls).toMatchObject({
      items: [
        {
          id: issued.recall.id,
          currentState: "WITHDRAWN",
          resourceVersion: 2,
          allowedActions: ["REISSUE"]
        }
      ],
      allowedActions: ["CREATE"],
      outboxEventId: null
    });
    const nonOwnerId = `${prefix}-non-owner`;
    await db.user.create({
      data: {
        id: nonOwnerId,
        employeeNo: `${prefix}-non-owner`.toUpperCase(),
        name: "非资产 Owner"
      }
    });
    const nonOwnerRecalls = await listAssetReleaseRecalls({
      technicalAssetId: ids.recallAsset,
      releaseId: sourceRelease.releaseId,
      limit: 20,
      actorId: nonOwnerId,
      canManage: true,
      auditContext: auditContext(`${prefix}-recall-read-non-owner`)
    });
    expect(nonOwnerRecalls.allowedActions).toEqual([]);
    expect(nonOwnerRecalls.items[0]?.allowedActions).toEqual([]);
    await expect(
      listAssetReleaseRecalls({
        technicalAssetId: ids.recallAsset,
        releaseId: sourceRelease.releaseId,
        limit: 20,
        actorId: ids.actor,
        canManage: true,
        auditContext: auditContext(`${prefix}-recall-read`)
      })
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      db.auditLog.count({
        where: { operationId: `${prefix}-recall-read`, result: "SUCCESS" }
      })
    ).resolves.toBe(1);
    await expect(db.outboxEvent.count({ where: { aggregateId: issued.recall.id } })).resolves.toBe(
      recallOutboxCountBeforeRead
    );

    const compatibility = {
      level: "FULL",
      summary: "Exact replacement validated",
      constraints: [],
      evidence: { qualificationId: `${prefix}-qualification` }
    };
    const candidate = await createAssetUpgradeCandidate({
      technicalAssetId: ids.recallAsset,
      assetVersion: 1,
      sourceAssetReleaseVersionId: sourceRelease.releaseVersionId,
      targetAssetReleaseVersionId: targetRelease.releaseVersionId,
      compatibility,
      reason: "service exact upgrade candidate",
      actorId: ids.actor,
      authorizationActor,
      auditContext: auditContext(`${prefix}-candidate-create`)
    });
    expect(candidate.candidate).toMatchObject({
      sourceAssetReleaseVersionId: sourceRelease.releaseVersionId,
      targetAssetReleaseVersionId: targetRelease.releaseVersionId,
      compatibilitySnapshotChecksum: payloadHash(compatibility).hash,
      resourceVersion: 1
    });
    expect(candidate.resourceVersion).toBe(1);
    const candidateOutboxCountBeforeRead = await db.outboxEvent.count({
      where: { aggregateId: candidate.candidate.id }
    });
    const candidates = await listAssetUpgradeCandidates({
      technicalAssetId: ids.recallAsset,
      limit: 20,
      actorId: ids.actor,
      canManage: true,
      auditContext: auditContext(`${prefix}-candidate-read`)
    });
    expect(candidates.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: candidate.candidate.id, resourceVersion: 1 })
      ])
    );
    expect(candidates.allowedActions).toEqual(["CREATE"]);
    const disabledAssetId = `${prefix}-disabled-asset`;
    await db.technicalAsset.create({
      data: {
        id: disabledAssetId,
        rndProjectId: ids.rndProject,
        assetNumber: `${prefix}.disabled`.toUpperCase(),
        assetType: "MECHANICAL",
        name: "停用升级候选测试资产",
        ownerId: ids.actor,
        status: "DISABLED",
        createdById: ids.actor
      }
    });
    const disabledCandidates = await listAssetUpgradeCandidates({
      technicalAssetId: disabledAssetId,
      limit: 20,
      actorId: ids.actor,
      canManage: true,
      auditContext: auditContext(`${prefix}-candidate-read-disabled`)
    });
    expect(disabledCandidates.allowedActions).toEqual([]);

    const completedRndProjectId = `${prefix}-completed-rnd`;
    const completedAssetId = `${prefix}-completed-asset`;
    await db.rndProject.create({
      data: {
        id: completedRndProjectId,
        code: `${prefix}.completed`.toUpperCase(),
        name: "已完成研发项目",
        ownerId: ids.actor,
        status: "COMPLETED",
        createdById: ids.actor
      }
    });
    await db.technicalAsset.create({
      data: {
        id: completedAssetId,
        rndProjectId: completedRndProjectId,
        assetNumber: `${prefix}.completed`.toUpperCase(),
        assetType: "MECHANICAL",
        name: "已完成研发项目升级候选测试资产",
        ownerId: ids.actor,
        status: "VALIDATED",
        createdById: ids.actor
      }
    });
    const completedCandidates = await listAssetUpgradeCandidates({
      technicalAssetId: completedAssetId,
      limit: 20,
      actorId: ids.actor,
      canManage: true,
      auditContext: auditContext(`${prefix}-candidate-read-completed`)
    });
    expect(completedCandidates.allowedActions).toEqual([]);
    await expect(
      listAssetUpgradeCandidates({
        technicalAssetId: ids.recallAsset,
        limit: 20,
        actorId: ids.actor,
        canManage: true,
        auditContext: auditContext(`${prefix}-candidate-read`)
      })
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      db.auditLog.count({
        where: { operationId: `${prefix}-candidate-read`, result: "SUCCESS" }
      })
    ).resolves.toBe(1);
    await expect(
      db.outboxEvent.count({ where: { aggregateId: candidate.candidate.id } })
    ).resolves.toBe(candidateOutboxCountBeforeRead);
    await expect(
      db.auditLog.count({
        where: {
          operationId: {
            in: [
              `${prefix}-issue`,
              `${prefix}-withdraw`,
              `${prefix}-recall-read`,
              `${prefix}-candidate-create`,
              `${prefix}-candidate-read`
            ]
          },
          result: "SUCCESS"
        }
      })
    ).resolves.toBe(5);
    await expect(
      db.outboxEvent.count({
        where: {
          id: { in: [issued.outboxEventId, withdrawn.outboxEventId, candidate.outboxEventId] }
        }
      })
    ).resolves.toBe(3);
  });

  it("replays an exact impact event fingerprint and requires refresh for a newer recall revision", async () => {
    const { prefix, projectId, release, component, issued, event } =
      await createProjectImpactProjectionFixture("replay");
    const created = await projectAssetImpactsFromSourceEvent(event);
    expect(created.items).toEqual([
      expect.objectContaining({
        projectId,
        created: true,
        replayed: false,
        refreshRequired: false
      })
    ]);
    const impactId = created.items[0]!.impactId;
    const countsAfterCreate = {
      assessments: await db.assetImpactAssessmentRevision.count({ where: { impactId } }),
      audits: await db.auditLog.count({ where: { objectId: impactId, result: "SUCCESS" } }),
      outbox: await db.outboxEvent.count({ where: { aggregateId: impactId } })
    };
    await expect(projectAssetImpactsFromSourceEvent(event)).resolves.toMatchObject({
      items: [{ impactId, replayed: true, refreshRequired: false }]
    });
    await expect(
      projectAssetImpactsFromSourceEvent({
        ...event,
        eventFingerprint: `${prefix}-fingerprint-conflict`
      })
    ).rejects.toMatchObject({
      code: "ASSET_IMPACT_EVENT_FINGERPRINT_CONFLICT",
      status: 409
    });
    await expect(
      Promise.all([
        db.assetImpactAssessmentRevision.count({ where: { impactId } }),
        db.auditLog.count({ where: { objectId: impactId, result: "SUCCESS" } }),
        db.outboxEvent.count({ where: { aggregateId: impactId } })
      ])
    ).resolves.toEqual([
      countsAfterCreate.assessments,
      countsAfterCreate.audits,
      countsAfterCreate.outbox
    ]);

    const corrected = await reviseAssetReleaseRecall({
      technicalAssetId: ids.recallAsset,
      recallId: issued.recall.id,
      version: issued.resourceVersion,
      kind: "CORRECTED",
      sourceAssetReleaseVersionId: release.releaseVersionId,
      severity: "MEDIUM",
      reason: "投影来源修订漂移",
      evidence: { componentSnapshotId: component.id, correction: true },
      actorId: ids.actor,
      authorizationActor,
      auditContext: auditContext(`${prefix}-recall-correct`)
    });
    const beforeRefreshRequired = await db.assetProjectImpact.findUniqueOrThrow({
      where: { id: impactId },
      select: { currentAssessmentRevisionId: true, version: true }
    });
    await expect(
      projectAssetImpactsFromSourceEvent({
        eventType: "asset.release-recall.revised",
        sourceId: corrected.recallRevision.id,
        eventFingerprint: `${prefix}-fingerprint-2`
      })
    ).resolves.toMatchObject({
      items: [
        {
          impactId,
          created: false,
          replayed: false,
          refreshRequired: true,
          currentSourceId: issued.recallRevision.id,
          availableSourceId: corrected.recallRevision.id,
          auditId: null,
          outboxEventId: null
        }
      ]
    });
    await expect(
      Promise.all([
        db.assetProjectImpact.findUniqueOrThrow({
          where: { id: impactId },
          select: { currentAssessmentRevisionId: true, version: true }
        }),
        db.assetImpactAssessmentRevision.count({ where: { impactId } }),
        db.auditLog.count({ where: { objectId: impactId, result: "SUCCESS" } }),
        db.outboxEvent.count({ where: { aggregateId: impactId } })
      ])
    ).resolves.toEqual([
      beforeRefreshRequired,
      countsAfterCreate.assessments,
      countsAfterCreate.audits,
      countsAfterCreate.outbox
    ]);
  });

  it("keeps delayed recall revision events monotonic without impersonating the current revision", async () => {
    const { prefix, projectId, release, component, issued, event } =
      await createProjectImpactProjectionFixture("delayed");
    const corrected = await reviseAssetReleaseRecall({
      technicalAssetId: ids.recallAsset,
      recallId: issued.recall.id,
      version: issued.resourceVersion,
      kind: "CORRECTED",
      sourceAssetReleaseVersionId: release.releaseVersionId,
      severity: "MEDIUM",
      reason: "在 ISSUED worker 延迟期间更正召回",
      evidence: { componentSnapshotId: component.id, delayedCorrection: true },
      actorId: ids.actor,
      authorizationActor,
      auditContext: auditContext(`${prefix}-recall-correct`)
    });

    const delayedInitial = await projectAssetImpactsFromSourceEvent(event);
    const impactId = delayedInitial.items[0]!.impactId;
    const initial = await db.assetImpactAssessmentRevision.findFirstOrThrow({
      where: { impactId, sequence: 1 }
    });
    expect(initial).toMatchObject({
      recallRevisionId: issued.recallRevision.id,
      snapshotJson: {
        recallRevisionId: issued.recallRevision.id,
        recallRevisionNumber: 1,
        projectionFingerprint: event.eventFingerprint
      }
    });
    const countsAfterInitial = await Promise.all([
      db.assetImpactAssessmentRevision.count({ where: { impactId } }),
      db.auditLog.count({ where: { objectId: impactId, result: "SUCCESS" } }),
      db.outboxEvent.count({ where: { aggregateId: impactId } })
    ]);
    const correctedEvent = {
      eventType: "asset.release-recall.revised" as const,
      sourceId: corrected.recallRevision.id,
      eventFingerprint: `${prefix}-fingerprint-2`
    };
    await expect(projectAssetImpactsFromSourceEvent(correctedEvent)).resolves.toMatchObject({
      items: [
        {
          impactId,
          replayed: false,
          refreshRequired: true,
          currentSourceId: issued.recallRevision.id,
          availableSourceId: corrected.recallRevision.id,
          auditId: null,
          outboxEventId: null
        }
      ]
    });
    await expect(
      Promise.all([
        db.assetImpactAssessmentRevision.count({ where: { impactId } }),
        db.auditLog.count({ where: { objectId: impactId, result: "SUCCESS" } }),
        db.outboxEvent.count({ where: { aggregateId: impactId } })
      ])
    ).resolves.toEqual(countsAfterInitial);

    const refreshed = await refreshProjectAssetImpact({
      projectId,
      impactId,
      version: 1,
      reason: "项目显式刷新到 corrected revision",
      evidence: { recallRevisionId: corrected.recallRevision.id },
      actorId: ids.actor,
      authorizationActor,
      auditContext: auditContext(`${prefix}-refresh`)
    });
    const countsAfterRefresh = await Promise.all([
      db.assetImpactAssessmentRevision.count({ where: { impactId } }),
      db.auditLog.count({ where: { objectId: impactId, result: "SUCCESS" } }),
      db.outboxEvent.count({ where: { aggregateId: impactId } })
    ]);
    await expect(projectAssetImpactsFromSourceEvent(event)).resolves.toMatchObject({
      items: [
        {
          impactId,
          replayed: true,
          refreshRequired: false,
          currentSourceId: corrected.recallRevision.id,
          availableSourceId: corrected.recallRevision.id,
          auditId: null,
          outboxEventId: null
        }
      ]
    });
    await expect(projectAssetImpactsFromSourceEvent(correctedEvent)).resolves.toMatchObject({
      items: [
        {
          impactId,
          replayed: true,
          refreshRequired: false,
          currentSourceId: corrected.recallRevision.id,
          availableSourceId: corrected.recallRevision.id
        }
      ]
    });
    await expect(
      Promise.all([
        db.assetProjectImpact.findUniqueOrThrow({
          where: { id: impactId },
          select: { currentAssessmentRevisionId: true, version: true }
        }),
        db.assetImpactAssessmentRevision.count({ where: { impactId } }),
        db.auditLog.count({ where: { objectId: impactId, result: "SUCCESS" } }),
        db.outboxEvent.count({ where: { aggregateId: impactId } })
      ])
    ).resolves.toEqual([
      {
        currentAssessmentRevisionId: refreshed.item.currentAssessmentRevisionId,
        version: 2
      },
      ...countsAfterRefresh
    ]);
  });

  it("refreshes and records basic project dispositions with exact versions and owner facts", async () => {
    const { prefix, projectId, release, component, issued, event } =
      await createProjectImpactProjectionFixture("commands");
    const created = await projectAssetImpactsFromSourceEvent(event);
    const impactId = created.items[0]!.impactId;
    const corrected = await reviseAssetReleaseRecall({
      technicalAssetId: ids.recallAsset,
      recallId: issued.recall.id,
      version: issued.resourceVersion,
      kind: "CORRECTED",
      sourceAssetReleaseVersionId: release.releaseVersionId,
      severity: "MEDIUM",
      reason: "项目刷新命令读取新的 exact recall revision",
      evidence: { componentSnapshotId: component.id, correction: true },
      actorId: ids.actor,
      authorizationActor,
      auditContext: auditContext(`${prefix}-recall-correct`)
    });
    const writeCounts = async () =>
      Promise.all([
        db.assetImpactAssessmentRevision.count({ where: { impactId } }),
        db.assetImpactDisposition.count({ where: { impactId } }),
        db.auditLog.count({ where: { objectId: impactId, result: "SUCCESS" } }),
        db.outboxEvent.count({ where: { aggregateId: impactId } })
      ]);
    const beforeInvalid = await writeCounts();
    await expect(
      refreshProjectAssetImpact({
        projectId,
        impactId,
        version: 1,
        reason: "空 evidence 必须在服务入口拒绝",
        evidence: {},
        actorId: ids.actor,
        authorizationActor,
        auditContext: auditContext(`${prefix}-refresh-empty-evidence`)
      })
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED", status: 422 });
    await expect(writeCounts()).resolves.toEqual(beforeInvalid);
    await expect(
      refreshProjectAssetImpact({
        projectId,
        impactId,
        version: 2,
        reason: "stale refresh",
        evidence: { report: "stale" },
        actorId: ids.actor,
        authorizationActor,
        auditContext: auditContext(`${prefix}-refresh-stale`)
      })
    ).rejects.toMatchObject({ code: "ASSET_IMPACT_VERSION_CONFLICT", status: 409 });
    await expect(writeCounts()).resolves.toEqual(beforeInvalid);

    const outboxBeforeReads = await db.outboxEvent.count({ where: { aggregateId: impactId } });
    const list = await listProjectAssetImpacts({
      projectId,
      limit: 50,
      actorId: ids.actor,
      authorizationActor,
      canManage: true,
      auditContext: auditContext(`${prefix}-list`)
    });
    expect(list).toMatchObject({
      items: [{ id: impactId, refreshRequired: true, allowedActions: ["REFRESH"] }],
      outboxEventId: null
    });
    const detail = await getProjectAssetImpact({
      projectId,
      impactId,
      actorId: ids.actor,
      authorizationActor,
      canManage: true,
      auditContext: auditContext(`${prefix}-detail`)
    });
    expect(detail).toMatchObject({
      item: {
        id: impactId,
        refreshRequired: true,
        currentSourceId: issued.recallRevision.id,
        availableSourceId: corrected.recallRevision.id,
        allowedActions: ["REFRESH"]
      },
      outboxEventId: null
    });
    await expect(db.outboxEvent.count({ where: { aggregateId: impactId } })).resolves.toBe(
      outboxBeforeReads
    );
    await expect(
      getProjectAssetImpact({
        projectId: ids.project,
        impactId,
        actorId: ids.actor,
        authorizationActor,
        canManage: true,
        auditContext: auditContext(`${prefix}-cross-project-detail`)
      })
    ).rejects.toMatchObject({ code: "ASSET_PROJECT_IMPACT_NOT_FOUND", status: 404 });
    await expect(
      db.auditLog.count({
        where: { operationId: `${prefix}-cross-project-detail`, result: "SUCCESS" }
      })
    ).resolves.toBe(0);

    const refreshed = await refreshProjectAssetImpact({
      projectId,
      impactId,
      version: 1,
      reason: "刷新到新的召回修订",
      evidence: { recallRevisionId: corrected.recallRevision.id },
      actorId: ids.actor,
      authorizationActor,
      auditContext: auditContext(`${prefix}-refresh`)
    });
    expect(refreshed).toMatchObject({
      item: { id: impactId, status: "OPEN", resourceVersion: 2 },
      resourceVersion: 2,
      allowedActions: ["ACKNOWLEDGE"]
    });
    expect(refreshed.item.dueAt!.getTime()).toBeGreaterThan(Date.now());
    await expect(
      db.assetImpactAssessmentRevision.findUniqueOrThrow({
        where: { id: refreshed.item.currentAssessmentRevisionId! }
      })
    ).resolves.toMatchObject({
      kind: "REFRESH",
      sequence: 2,
      actorId: ids.actor,
      recallRevisionId: corrected.recallRevision.id
    });

    await expect(
      recordProjectAssetImpactDisposition({
        projectId,
        impactId,
        action: "START_ASSESSMENT",
        version: 2,
        reason: "OPEN 不能直接进入 ASSESSING",
        evidence: { review: "invalid transition" },
        actorId: ids.actor,
        authorizationActor,
        auditContext: auditContext(`${prefix}-invalid-transition`)
      })
    ).rejects.toMatchObject({ code: "ASSET_IMPACT_TRANSITION_INVALID", status: 409 });
    const beforeOwnerDenial = await writeCounts();
    const otherActorId = `${prefix}-other-actor`;
    await db.user.create({
      data: {
        id: otherActorId,
        employeeNo: `${prefix}-other`.toUpperCase(),
        name: "非 Owner 项目成员"
      }
    });
    await db.projectMember.create({
      data: {
        id: `${prefix}-other-membership`,
        projectId,
        userId: otherActorId,
        projectRole: "ENGINEER",
        assignedById: ids.actor
      }
    });
    await expect(
      recordProjectAssetImpactDisposition({
        projectId,
        impactId,
        action: "ACKNOWLEDGE",
        version: 2,
        reason: "非 Owner 不得确认",
        evidence: { review: "owner denied" },
        actorId: otherActorId,
        authorizationActor: { ...authorizationActor, id: otherActorId },
        auditContext: { ...auditContext(`${prefix}-owner-denied`), actorId: otherActorId }
      })
    ).rejects.toMatchObject({ code: "ASSET_IMPACT_OWNER_REQUIRED", status: 403 });
    await expect(writeCounts()).resolves.toEqual(beforeOwnerDenial);
    const outsiderId = `${prefix}-outsider`;
    await db.user.create({
      data: {
        id: outsiderId,
        employeeNo: `${prefix}-outsider`.toUpperCase(),
        name: "非项目成员"
      }
    });
    await expect(
      recordProjectAssetImpactDisposition({
        projectId,
        impactId,
        action: "ACKNOWLEDGE",
        version: 2,
        reason: "非项目成员不得确认",
        evidence: { review: "membership denied" },
        actorId: outsiderId,
        authorizationActor: { ...authorizationActor, id: outsiderId },
        auditContext: { ...auditContext(`${prefix}-membership-denied`), actorId: outsiderId }
      })
    ).rejects.toMatchObject({
      code: "ASSET_IMPACT_ACTOR_MEMBERSHIP_REQUIRED",
      status: 403
    });
    await expect(writeCounts()).resolves.toEqual(beforeOwnerDenial);

    const command = (
      action: "ACKNOWLEDGE" | "START_ASSESSMENT" | "PLAN_UPGRADE",
      version: number
    ) =>
      recordProjectAssetImpactDisposition({
        projectId,
        impactId,
        action,
        version,
        reason: `项目 Owner 执行 ${action}`,
        evidence: { action },
        actorId: ids.actor,
        authorizationActor,
        auditContext: auditContext(`${prefix}-${action.toLowerCase()}`)
      });
    await expect(command("ACKNOWLEDGE", 2)).resolves.toMatchObject({
      item: { status: "ACKNOWLEDGED", resourceVersion: 3 }
    });
    await expect(command("ACKNOWLEDGE", 2)).rejects.toMatchObject({
      code: "ASSET_IMPACT_VERSION_CONFLICT",
      status: 409
    });
    await expect(command("START_ASSESSMENT", 3)).resolves.toMatchObject({
      item: { status: "ASSESSING", resourceVersion: 4 }
    });
    await expect(command("PLAN_UPGRADE", 4)).resolves.toMatchObject({
      item: { status: "UPGRADE_PLANNED", resourceVersion: 5 }
    });
    await expect(writeCounts()).resolves.toEqual([
      2,
      4,
      beforeInvalid[2] + 5,
      beforeInvalid[3] + 4
    ]);
  });

  it("requires refresh before a risk command can use a stale recall assessment", async () => {
    const { prefix, projectId, release, component, issued, event } =
      await createProjectImpactProjectionFixture("stale-risk-command");
    const created = await projectAssetImpactsFromSourceEvent(event);
    const impactId = created.items[0]!.impactId;
    await recordProjectAssetImpactDisposition({
      projectId,
      impactId,
      action: "ACKNOWLEDGE",
      version: 1,
      reason: "确认召回影响",
      evidence: { reviewId: `${prefix}-acknowledge` },
      actorId: ids.actor,
      authorizationActor,
      auditContext: auditContext(`${prefix}-acknowledge`)
    });
    await recordProjectAssetImpactDisposition({
      projectId,
      impactId,
      action: "START_ASSESSMENT",
      version: 2,
      reason: "开始召回影响评估",
      evidence: { reviewId: `${prefix}-assessment` },
      actorId: ids.actor,
      authorizationActor,
      auditContext: auditContext(`${prefix}-assessment`)
    });
    await reviseAssetReleaseRecall({
      technicalAssetId: ids.recallAsset,
      recallId: issued.recall.id,
      version: issued.resourceVersion,
      kind: "CORRECTED",
      sourceAssetReleaseVersionId: release.releaseVersionId,
      severity: "MEDIUM",
      reason: "在风险申请前更正召回",
      evidence: { componentSnapshotId: component.id, correction: true },
      actorId: ids.actor,
      authorizationActor,
      auditContext: auditContext(`${prefix}-recall-correct`)
    });
    const operationId = `${prefix}-stale-request`;
    const before = await Promise.all([
      db.assetImpactRiskAcceptanceRequest.count({ where: { impactId } }),
      db.assetImpactDisposition.count({ where: { impactId } }),
      db.auditLog.count({ where: { operationId } }),
      db.outboxEvent.count({ where: { aggregateId: impactId } })
    ]);
    await expect(
      requestProjectAssetImpactRiskAcceptance({
        projectId,
        impactId,
        version: 3,
        reason: "错误地基于旧召回事实申请风险接受",
        evidence: { riskRegisterId: `${prefix}-risk-register` },
        actorId: ids.actor,
        authorizationActor,
        auditContext: auditContext(operationId)
      })
    ).rejects.toMatchObject({ code: "ASSET_IMPACT_REFRESH_REQUIRED", status: 409 });
    await expect(
      Promise.all([
        db.assetImpactRiskAcceptanceRequest.count({ where: { impactId } }),
        db.assetImpactDisposition.count({ where: { impactId } }),
        db.auditLog.count({ where: { operationId } }),
        db.outboxEvent.count({ where: { aggregateId: impactId } })
      ])
    ).resolves.toEqual(before);
  });

  it("serializes recall corrections and impact commands in both commit orders", async () => {
    const command = async (
      fixture: Awaited<ReturnType<typeof createProjectImpactProjectionFixture>>,
      impactId: string,
      operationId: string,
      signal?: () => void
    ) =>
      db.$transaction(async (transaction) => {
        await transactionTimeouts(transaction);
        const result = await recordProjectAssetImpactDisposition(
          {
            projectId: fixture.projectId,
            impactId,
            action: "ACKNOWLEDGE",
            version: 1,
            reason: "按冻结召回事实确认影响",
            evidence: { operationId },
            actorId: ids.actor,
            authorizationActor,
            auditContext: auditContext(operationId)
          },
          transaction
        );
        signal?.();
        if (signal) await transaction.$queryRaw`SELECT 1 FROM pg_sleep(0.15)`;
        return result;
      });
    const correction = async (
      fixture: Awaited<ReturnType<typeof createProjectImpactProjectionFixture>>,
      operationId: string,
      signal?: () => void
    ) =>
      db.$transaction(async (transaction) => {
        await transactionTimeouts(transaction);
        const result = await reviseAssetReleaseRecall(
          {
            technicalAssetId: ids.recallAsset,
            recallId: fixture.issued.recall.id,
            version: fixture.issued.resourceVersion,
            kind: "CORRECTED",
            sourceAssetReleaseVersionId: fixture.release.releaseVersionId,
            severity: "MEDIUM",
            reason: "并发更正召回事实",
            evidence: { componentSnapshotId: fixture.component.id, operationId },
            actorId: ids.actor,
            authorizationActor,
            auditContext: auditContext(operationId)
          },
          transaction
        );
        signal?.();
        if (signal) await transaction.$queryRaw`SELECT 1 FROM pg_sleep(0.15)`;
        return result;
      });

    const commandFirst = await createProjectImpactProjectionFixture("command-recall-first");
    const commandFirstImpact = (await projectAssetImpactsFromSourceEvent(commandFirst.event))
      .items[0]!;
    let commandLocked!: () => void;
    const commandBarrier = new Promise<void>((resolve) => (commandLocked = resolve));
    const commandWinner = command(
      commandFirst,
      commandFirstImpact.impactId,
      `${commandFirst.prefix}-command`,
      commandLocked
    );
    await commandBarrier;
    const laterCorrection = correction(commandFirst, `${commandFirst.prefix}-correction`);
    const commandFirstResults = await Promise.allSettled([commandWinner, laterCorrection]);
    expect(commandFirstResults.map(({ status }) => status)).toEqual(["fulfilled", "fulfilled"]);
    for (const result of commandFirstResults) {
      expect(result.status === "rejected" ? String(result.reason) : "").not.toMatch(/40P01/u);
    }
    await expect(
      recordProjectAssetImpactDisposition({
        projectId: commandFirst.projectId,
        impactId: commandFirstImpact.impactId,
        action: "START_ASSESSMENT",
        version: 2,
        reason: "更正后旧评估不可继续处置",
        evidence: { stale: true },
        actorId: ids.actor,
        authorizationActor,
        auditContext: auditContext(`${commandFirst.prefix}-stale-follow-up`)
      })
    ).rejects.toMatchObject({ code: "ASSET_IMPACT_REFRESH_REQUIRED", status: 409 });

    const correctionFirst = await createProjectImpactProjectionFixture("recall-command-first");
    const correctionFirstImpact = (await projectAssetImpactsFromSourceEvent(correctionFirst.event))
      .items[0]!;
    const blockedOperationId = `${correctionFirst.prefix}-blocked-command`;
    const before = await Promise.all([
      db.assetImpactDisposition.count({ where: { impactId: correctionFirstImpact.impactId } }),
      db.auditLog.count({ where: { operationId: blockedOperationId } }),
      db.outboxEvent.count({ where: { aggregateId: correctionFirstImpact.impactId } })
    ]);
    let correctionLocked!: () => void;
    const correctionBarrier = new Promise<void>((resolve) => (correctionLocked = resolve));
    const correctionWinner = correction(
      correctionFirst,
      `${correctionFirst.prefix}-correction`,
      correctionLocked
    );
    await correctionBarrier;
    const blockedCommand = command(
      correctionFirst,
      correctionFirstImpact.impactId,
      blockedOperationId
    );
    const correctionFirstResults = await Promise.allSettled([correctionWinner, blockedCommand]);
    expect(correctionFirstResults[0]?.status).toBe("fulfilled");
    expect(correctionFirstResults[1]).toMatchObject({
      status: "rejected",
      reason: expect.objectContaining({ code: "ASSET_IMPACT_REFRESH_REQUIRED", status: 409 })
    });
    expect(
      correctionFirstResults[1]?.status === "rejected"
        ? String(correctionFirstResults[1].reason)
        : ""
    ).not.toMatch(/40P01/u);
    await expect(
      Promise.all([
        db.assetImpactDisposition.count({ where: { impactId: correctionFirstImpact.impactId } }),
        db.auditLog.count({ where: { operationId: blockedOperationId } }),
        db.outboxEvent.count({ where: { aggregateId: correctionFirstImpact.impactId } })
      ])
    ).resolves.toEqual(before);
  });

  it("serializes usage retirement and creation against impact commands", async () => {
    const command = async (
      fixture: Awaited<ReturnType<typeof createProjectImpactProjectionFixture>>,
      impactId: string,
      version: number,
      operationId: string,
      signal?: () => void
    ) =>
      db.$transaction(async (transaction) => {
        await transactionTimeouts(transaction);
        const result = await recordProjectAssetImpactDisposition(
          {
            projectId: fixture.projectId,
            impactId,
            action: "ACKNOWLEDGE",
            version,
            reason: "按冻结 usage 事实确认影响",
            evidence: { operationId },
            actorId: ids.actor,
            authorizationActor,
            auditContext: auditContext(operationId)
          },
          transaction
        );
        signal?.();
        if (signal) await transaction.$queryRaw`SELECT 1 FROM pg_sleep(0.15)`;
        return result;
      });
    const retire = async (
      fixture: Awaited<ReturnType<typeof createProjectImpactProjectionFixture>>,
      signal?: () => void
    ) =>
      db.$transaction(async (transaction) => {
        await transactionTimeouts(transaction);
        const result = await retireProjectAssetUsage(
          {
            projectId: fixture.projectId,
            usageId: fixture.usage!.usage.id,
            version: fixture.usage!.resourceVersion,
            actorId: ids.actor,
            reason: "并发退役冻结 usage",
            authorizationActor,
            auditContext: auditContext(`${fixture.prefix}-usage-retire`)
          },
          transaction
        );
        signal?.();
        if (signal) await transaction.$queryRaw`SELECT 1 FROM pg_sleep(0.15)`;
        return result;
      });

    const commandFirst = await createProjectImpactProjectionFixture("command-retire-first", {
      withUsage: true
    });
    const commandFirstImpact = (await projectAssetImpactsFromSourceEvent(commandFirst.event))
      .items[0]!;
    let commandLocked!: () => void;
    const commandBarrier = new Promise<void>((resolve) => (commandLocked = resolve));
    const commandWinner = command(
      commandFirst,
      commandFirstImpact.impactId,
      1,
      `${commandFirst.prefix}-command`,
      commandLocked
    );
    await commandBarrier;
    const laterRetire = retire(commandFirst);
    const commandFirstResults = await Promise.allSettled([commandWinner, laterRetire]);
    expect(commandFirstResults.map(({ status }) => status)).toEqual(["fulfilled", "fulfilled"]);
    for (const result of commandFirstResults) {
      expect(result.status === "rejected" ? String(result.reason) : "").not.toMatch(/40P01/u);
    }

    const retireFirst = await createProjectImpactProjectionFixture("retire-command-first", {
      withUsage: true
    });
    const retireFirstImpact = (await projectAssetImpactsFromSourceEvent(retireFirst.event))
      .items[0]!;
    const blockedOperationId = `${retireFirst.prefix}-blocked-command`;
    const before = await Promise.all([
      db.assetImpactDisposition.count({ where: { impactId: retireFirstImpact.impactId } }),
      db.auditLog.count({ where: { operationId: blockedOperationId } }),
      db.outboxEvent.count({ where: { aggregateId: retireFirstImpact.impactId } })
    ]);
    let usageLocked!: () => void;
    const usageBarrier = new Promise<void>((resolve) => (usageLocked = resolve));
    const retireWinner = retire(retireFirst, usageLocked);
    await usageBarrier;
    const blockedCommand = command(retireFirst, retireFirstImpact.impactId, 1, blockedOperationId);
    const retireFirstResults = await Promise.allSettled([retireWinner, blockedCommand]);
    expect(retireFirstResults[0]?.status).toBe("fulfilled");
    expect(retireFirstResults[1]).toMatchObject({
      status: "rejected",
      reason: expect.objectContaining({ code: "ASSET_IMPACT_REFRESH_REQUIRED", status: 409 })
    });
    expect(
      retireFirstResults[1]?.status === "rejected" ? String(retireFirstResults[1].reason) : ""
    ).not.toMatch(/40P01/u);
    await expect(
      Promise.all([
        db.assetImpactDisposition.count({ where: { impactId: retireFirstImpact.impactId } }),
        db.auditLog.count({ where: { operationId: blockedOperationId } }),
        db.outboxEvent.count({ where: { aggregateId: retireFirstImpact.impactId } })
      ])
    ).resolves.toEqual(before);

    const withdrawnFixture = async (label: string) => {
      const fixture = await createProjectImpactProjectionFixture(label);
      const impact = (await projectAssetImpactsFromSourceEvent(fixture.event)).items[0]!;
      await reviseAssetReleaseRecall({
        technicalAssetId: ids.recallAsset,
        recallId: fixture.issued.recall.id,
        version: fixture.issued.resourceVersion,
        kind: "WITHDRAWN",
        sourceAssetReleaseVersionId: fixture.release.releaseVersionId,
        severity: "LOW",
        reason: "允许后续 usage 写入的召回撤回",
        evidence: { componentSnapshotId: fixture.component.id },
        actorId: ids.actor,
        authorizationActor,
        auditContext: auditContext(`${fixture.prefix}-withdraw`)
      });
      const refreshed = await refreshProjectAssetImpact({
        projectId: fixture.projectId,
        impactId: impact.impactId,
        version: 1,
        reason: "刷新到已撤回召回事实",
        evidence: { recallWithdrawn: true },
        actorId: ids.actor,
        authorizationActor,
        auditContext: auditContext(`${fixture.prefix}-refresh`)
      });
      return { ...fixture, impactId: impact.impactId, impactVersion: refreshed.resourceVersion };
    };
    const createUsage = async (
      fixture: Awaited<ReturnType<typeof withdrawnFixture>>,
      signal?: () => void
    ) =>
      db.$transaction(async (transaction) => {
        await transactionTimeouts(transaction);
        const result = await createProjectAssetUsage(
          {
            projectId: fixture.projectId,
            referenceId: fixture.referenceId,
            referenceVersion: 1,
            usageKey: `${fixture.prefix}-post-withdrawal-usage`,
            componentSnapshotId: fixture.component.id,
            quantity: "1",
            configuration: { purpose: "召回撤回后的新增 usage" },
            scopeType: "PROJECT",
            scopeId: fixture.projectId,
            actorId: ids.actor,
            reason: "并发新增 usage",
            authorizationActor,
            auditContext: auditContext(`${fixture.prefix}-usage-create-after-withdrawal`)
          },
          transaction
        );
        signal?.();
        if (signal) await transaction.$queryRaw`SELECT 1 FROM pg_sleep(0.15)`;
        return result;
      });

    const createCommandFirst = await withdrawnFixture("command-create-first");
    let createCommandLocked!: () => void;
    const createCommandBarrier = new Promise<void>((resolve) => (createCommandLocked = resolve));
    const createCommandWinner = command(
      createCommandFirst,
      createCommandFirst.impactId,
      createCommandFirst.impactVersion,
      `${createCommandFirst.prefix}-command`,
      createCommandLocked
    );
    await createCommandBarrier;
    const laterCreate = createUsage(createCommandFirst);
    const createCommandResults = await Promise.allSettled([createCommandWinner, laterCreate]);
    expect(createCommandResults.map(({ status }) => status)).toEqual(["fulfilled", "fulfilled"]);
    for (const result of createCommandResults) {
      expect(result.status === "rejected" ? String(result.reason) : "").not.toMatch(/40P01/u);
    }

    const createFirst = await withdrawnFixture("create-command-first");
    const createBlockedOperationId = `${createFirst.prefix}-blocked-command`;
    const beforeCreateBlocked = await Promise.all([
      db.assetImpactDisposition.count({ where: { impactId: createFirst.impactId } }),
      db.auditLog.count({ where: { operationId: createBlockedOperationId } }),
      db.outboxEvent.count({ where: { aggregateId: createFirst.impactId } })
    ]);
    let createLocked!: () => void;
    const createBarrier = new Promise<void>((resolve) => (createLocked = resolve));
    const createWinner = createUsage(createFirst, createLocked);
    await createBarrier;
    const createBlockedCommand = command(
      createFirst,
      createFirst.impactId,
      createFirst.impactVersion,
      createBlockedOperationId
    );
    const createFirstResults = await Promise.allSettled([createWinner, createBlockedCommand]);
    expect(createFirstResults[0]?.status).toBe("fulfilled");
    expect(createFirstResults[1]).toMatchObject({
      status: "rejected",
      reason: expect.objectContaining({ code: "ASSET_IMPACT_REFRESH_REQUIRED", status: 409 })
    });
    expect(
      createFirstResults[1]?.status === "rejected" ? String(createFirstResults[1].reason) : ""
    ).not.toMatch(/40P01/u);
    await expect(
      Promise.all([
        db.assetImpactDisposition.count({ where: { impactId: createFirst.impactId } }),
        db.auditLog.count({ where: { operationId: createBlockedOperationId } }),
        db.outboxEvent.count({ where: { aggregateId: createFirst.impactId } })
      ])
    ).resolves.toEqual(beforeCreateBlocked);
  });

  it("serializes acceptance report generation against impact commands", async () => {
    const command = async (
      fixture: Awaited<ReturnType<typeof createProjectImpactProjectionFixture>>,
      impactId: string,
      operationId: string,
      signal?: () => void
    ) =>
      db.$transaction(async (transaction) => {
        await transactionTimeouts(transaction);
        const result = await recordProjectAssetImpactDisposition(
          {
            projectId: fixture.projectId,
            impactId,
            action: "ACKNOWLEDGE",
            version: 1,
            reason: "按冻结报告绑定确认影响",
            evidence: { operationId },
            actorId: ids.actor,
            authorizationActor,
            auditContext: auditContext(operationId)
          },
          transaction
        );
        signal?.();
        if (signal) await transaction.$queryRaw`SELECT 1 FROM pg_sleep(0.15)`;
        return result;
      });
    const lockedBatch = async (
      fixture: Awaited<ReturnType<typeof createProjectImpactProjectionFixture>>
    ) => {
      const template = await db.acceptanceTemplate.create({
        data: {
          code: `${fixture.prefix}-acceptance`.toUpperCase(),
          name: "资产影响并发验收模板",
          acceptanceType: "FAT",
          currentVersion: 1,
          createdById: ids.actor,
          versions: {
            create: {
              version: 1,
              acceptanceType: "FAT",
              snapshotChecksum: checksum,
              createdById: ids.actor
            }
          }
        },
        include: { versions: true }
      });
      return db.acceptanceBatch.create({
        data: {
          projectId: fixture.projectId,
          acceptanceType: "FAT",
          scopeType: "PROJECT",
          scopeId: fixture.projectId,
          templateVersionId: template.versions[0]!.id,
          status: "LOCKED",
          createdById: ids.actor,
          lockedById: ids.actor,
          lockedAt: new Date()
        }
      });
    };
    const generate = async (
      fixture: Awaited<ReturnType<typeof createProjectImpactProjectionFixture>>,
      batch: Awaited<ReturnType<typeof lockedBatch>>,
      operationId: string,
      signal?: () => void
    ) => {
      const storage = new MemoryObjectStorage();
      return db.$transaction(async (transaction) => {
        await transactionTimeouts(transaction);
        const result = await generateAcceptanceReport(
          {
            projectId: fixture.projectId,
            batchId: batch.id,
            version: batch.version,
            actorId: ids.actor,
            storage,
            auditContext: auditContext(operationId)
          },
          transaction
        );
        signal?.();
        if (signal) await transaction.$queryRaw`SELECT 1 FROM pg_sleep(0.15)`;
        return result;
      });
    };

    const commandFirst = await createProjectImpactProjectionFixture("command-report-first", {
      withUsage: true
    });
    const commandFirstImpact = (await projectAssetImpactsFromSourceEvent(commandFirst.event))
      .items[0]!;
    const commandFirstBatch = await lockedBatch(commandFirst);
    let commandLocked!: () => void;
    const commandBarrier = new Promise<void>((resolve) => (commandLocked = resolve));
    const commandWinner = command(
      commandFirst,
      commandFirstImpact.impactId,
      `${commandFirst.prefix}-command`,
      commandLocked
    );
    await commandBarrier;
    const laterReport = generate(commandFirst, commandFirstBatch, `${commandFirst.prefix}-report`);
    const commandFirstResults = await Promise.allSettled([commandWinner, laterReport]);
    expect(commandFirstResults.map(({ status }) => status)).toEqual(["fulfilled", "fulfilled"]);
    for (const result of commandFirstResults) {
      expect(result.status === "rejected" ? String(result.reason) : "").not.toMatch(/40P01/u);
    }

    const reportFirst = await createProjectImpactProjectionFixture("report-command-first", {
      withUsage: true
    });
    const reportFirstImpact = (await projectAssetImpactsFromSourceEvent(reportFirst.event))
      .items[0]!;
    const reportFirstBatch = await lockedBatch(reportFirst);
    const blockedOperationId = `${reportFirst.prefix}-blocked-command`;
    const before = await Promise.all([
      db.assetImpactDisposition.count({ where: { impactId: reportFirstImpact.impactId } }),
      db.auditLog.count({ where: { operationId: blockedOperationId } }),
      db.outboxEvent.count({ where: { aggregateId: reportFirstImpact.impactId } })
    ]);
    let reportLocked!: () => void;
    const reportBarrier = new Promise<void>((resolve) => (reportLocked = resolve));
    const reportWinner = generate(
      reportFirst,
      reportFirstBatch,
      `${reportFirst.prefix}-report`,
      reportLocked
    );
    await reportBarrier;
    const blockedCommand = command(reportFirst, reportFirstImpact.impactId, blockedOperationId);
    const reportFirstResults = await Promise.allSettled([reportWinner, blockedCommand]);
    expect(reportFirstResults[0]?.status).toBe("fulfilled");
    expect(reportFirstResults[1]).toMatchObject({
      status: "rejected",
      reason: expect.objectContaining({ code: "ASSET_IMPACT_REFRESH_REQUIRED", status: 409 })
    });
    expect(
      reportFirstResults[1]?.status === "rejected" ? String(reportFirstResults[1].reason) : ""
    ).not.toMatch(/40P01/u);
    await expect(
      Promise.all([
        db.assetImpactDisposition.count({ where: { impactId: reportFirstImpact.impactId } }),
        db.auditLog.count({ where: { operationId: blockedOperationId } }),
        db.outboxEvent.count({ where: { aggregateId: reportFirstImpact.impactId } })
      ])
    ).resolves.toEqual(before);
  });

  it("rolls back the projected root, INITIAL pointer, success audit and Outbox atomically", async () => {
    const { prefix, projectId, issued, event } =
      await createProjectImpactProjectionFixture("rollback");
    const functionName = `test_reject_asset_impact_outbox_${suffix}`;
    const triggerName = `test_reject_asset_impact_outbox_trigger_${suffix}`;
    const beforeOutbox = await db.outboxEvent.count({
      where: { eventType: "asset.impact.assessed" }
    });
    await db.$executeRawUnsafe(`
      CREATE FUNCTION "${functionName}"() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.event_type = 'asset.impact.assessed' THEN
          RAISE EXCEPTION 'test rejects asset impact outbox';
        END IF;
        RETURN NEW;
      END $$
    `);
    await db.$executeRawUnsafe(`
      CREATE TRIGGER "${triggerName}" BEFORE INSERT ON "outbox_events"
      FOR EACH ROW EXECUTE FUNCTION "${functionName}"()
    `);
    try {
      await expect(projectAssetImpactsFromSourceEvent(event)).rejects.toThrow(
        /test rejects asset impact outbox/u
      );
    } finally {
      await db.$executeRawUnsafe(`DROP TRIGGER IF EXISTS "${triggerName}" ON "outbox_events"`);
      await db.$executeRawUnsafe(`DROP FUNCTION IF EXISTS "${functionName}"()`);
    }
    await expect(
      Promise.all([
        db.assetProjectImpact.count({
          where: { projectId, sourceKey: `RECALL:${issued.recall.id}` }
        }),
        db.assetImpactAssessmentRevision.count({ where: { projectId } }),
        db.auditLog.count({
          where: {
            operationId: `asset-impact:RECALL:${issued.recall.id}:${projectId}`,
            result: "SUCCESS"
          }
        }),
        db.outboxEvent.count({ where: { eventType: "asset.impact.assessed" } })
      ])
    ).resolves.toEqual([0, 0, 0, beforeOutbox]);
    expect(prefix).toContain("rollback");
  });

  it("allows only VALIDATED to DISABLED, never VALIDATED to CANCELED", async () => {
    await expect(
      db.$executeRawUnsafe(
        `UPDATE "technical_assets" SET "status" = 'CANCELED', "version" = 2 WHERE "id" = '${ids.disabledAsset}'`
      )
    ).rejects.toThrow(/invalid technical asset transition/u);
    await expect(
      db.$executeRawUnsafe(
        `UPDATE "technical_assets" SET "status" = 'DISABLED', "version" = 2 WHERE "id" = '${ids.disabledAsset}'`
      )
    ).rejects.toThrow(/requires its exact status event before commit/u);
    await expect(
      db.$transaction(async (transaction) => {
        await transaction.technicalAsset.update({
          where: { id: ids.disabledAsset },
          data: { status: "DISABLED", version: 2 }
        });
        await transaction.technicalAssetEvent.create({
          data: {
            id: `asset-impact-disabled-wrong-event-${suffix}`,
            rndProjectId: ids.rndProject,
            technicalAssetId: ids.disabledAsset,
            sequence: 1,
            eventType: "STATUS_CHANGED",
            fromStatus: "VALIDATED",
            toStatus: "DISABLED",
            reason: "错误事件快照应回滚",
            snapshotJson: {
              rndProjectId: ids.rndProject,
              technicalAssetId: ids.disabledAsset,
              status: "DISABLED",
              version: 999
            },
            actorId: ids.actor
          }
        });
      })
    ).rejects.toThrow(/requires its exact status event before commit/u);
    await db.$transaction(async (transaction) => {
      await transaction.technicalAsset.update({
        where: { id: ids.disabledAsset },
        data: { status: "DISABLED", version: 2 }
      });
      await appendDisableEvent(transaction, {
        assetId: ids.disabledAsset,
        rndProjectId: ids.rndProject,
        eventId: `asset-impact-disabled-event-${suffix}`
      });
    });
    await expect(
      db.technicalAsset.findUniqueOrThrow({ where: { id: ids.disabledAsset } })
    ).resolves.toMatchObject({
      status: "DISABLED",
      version: 2
    });
  });

  it("rejects direct Release and ReleaseVersion inserts after asset or R&D shutdown", async () => {
    await expect(
      db.$executeRaw`
        INSERT INTO "asset_releases" ("id", "technical_asset_id", "release_code", "created_by_id", "updated_at")
        VALUES (${`asset-impact-disabled-release-${suffix}`}, ${ids.disabledAsset}, ${`REL-DISABLED-${suffix}`.toUpperCase()}, ${ids.actor}, CURRENT_TIMESTAMP)
      `
    ).rejects.toThrow(/unavailable for a new release fact/u);

    const versionAssetId = `asset-impact-version-disabled-${suffix}`;
    const versionReleaseId = `asset-impact-version-release-${suffix}`;
    await db.technicalAsset.create({
      data: {
        id: versionAssetId,
        rndProjectId: ids.rndProject,
        assetNumber: `AST.IMPACT.VERSION.DISABLED.${suffix}`.toUpperCase(),
        assetType: "MECHANICAL",
        name: "停用后版本插入测试资产",
        ownerId: ids.actor,
        status: "VALIDATED",
        createdById: ids.actor
      }
    });
    await db.assetRelease.create({
      data: {
        id: versionReleaseId,
        technicalAssetId: versionAssetId,
        releaseCode: `REL-VERSION-${suffix}`.toUpperCase(),
        createdById: ids.actor
      }
    });
    await db.$transaction(async (transaction) => {
      await transaction.technicalAsset.update({
        where: { id: versionAssetId },
        data: { status: "DISABLED", version: 2 }
      });
      await appendDisableEvent(transaction, {
        assetId: versionAssetId,
        rndProjectId: ids.rndProject,
        eventId: `asset-impact-version-disabled-event-${suffix}`
      });
    });
    await expect(
      db.$executeRaw`
        INSERT INTO "asset_release_versions" (
          "id", "release_id", "technical_asset_id", "revision", "status",
          "snapshot_checksum", "source_watermark", "created_by_id"
        ) VALUES (
          ${`asset-impact-disabled-version-${suffix}`}, ${versionReleaseId}, ${versionAssetId}, 1,
          'DRAFT', ${checksum}, 'disabled-version-watermark', ${ids.actor}
        )
      `
    ).rejects.toThrow(/unavailable for a new release fact/u);

    const canceledRndId = `asset-impact-canceled-rnd-${suffix}`;
    const canceledRndAssetId = `asset-impact-canceled-rnd-asset-${suffix}`;
    await db.rndProject.create({
      data: {
        id: canceledRndId,
        code: `RND.CANCELED.${suffix}`.toUpperCase(),
        name: "已取消研发项目",
        ownerId: ids.actor,
        status: "CANCELED",
        createdById: ids.actor
      }
    });
    await db.technicalAsset.create({
      data: {
        id: canceledRndAssetId,
        rndProjectId: canceledRndId,
        assetNumber: `AST.IMPACT.RND.CANCELED.${suffix}`.toUpperCase(),
        assetType: "MECHANICAL",
        name: "研发取消后的资产",
        ownerId: ids.actor,
        status: "VALIDATED",
        createdById: ids.actor
      }
    });
    await expect(
      db.$executeRaw`
        INSERT INTO "asset_releases" ("id", "technical_asset_id", "release_code", "created_by_id", "updated_at")
        VALUES (${`asset-impact-canceled-rnd-release-${suffix}`}, ${canceledRndAssetId}, ${`REL-RND-CANCELED-${suffix}`.toUpperCase()}, ${ids.actor}, CURRENT_TIMESTAMP)
      `
    ).rejects.toThrow(/unavailable for a new release fact/u);
  });

  it("rejects every new release and project asset fact after the R&D project is completed", async () => {
    const prefix = `asset-impact-completed-rnd-${suffix}`;
    const rndProjectId = `${prefix}-rnd`;
    const assetId = `${prefix}-asset`;
    const releaseId = `${prefix}-release`;
    const firstVersionId = `${prefix}-version-1`;
    const secondVersionId = `${prefix}-version-2`;
    const firstComponentId = `${prefix}-component-1`;
    const secondComponentId = `${prefix}-component-2`;
    const referenceId = `${prefix}-reference`;
    const usageId = `${prefix}-usage`;
    const releaseCode = `REL-COMPLETED-${suffix}`.toUpperCase();
    const firstWatermark = `${prefix}-watermark-1`;
    const secondWatermark = `${prefix}-watermark-2`;

    await db.rndProject.create({
      data: {
        id: rndProjectId,
        code: `RND.COMPLETED.${suffix}`.toUpperCase(),
        name: "已完成研发项目写入门禁",
        ownerId: ids.actor,
        status: "IN_DEVELOPMENT",
        createdById: ids.actor
      }
    });
    await db.technicalAsset.create({
      data: {
        id: assetId,
        rndProjectId,
        assetNumber: `AST.IMPACT.RND.COMPLETED.${suffix}`.toUpperCase(),
        assetType: "MECHANICAL",
        name: "研发完成后的资产事实门禁",
        ownerId: ids.actor,
        status: "VALIDATED",
        createdById: ids.actor
      }
    });
    await db.assetRelease.create({
      data: { id: releaseId, technicalAssetId: assetId, releaseCode, createdById: ids.actor }
    });
    await db.assetReleaseVersion.createMany({
      data: [
        {
          id: firstVersionId,
          releaseId,
          technicalAssetId: assetId,
          revision: 1,
          status: "PUBLISHED",
          snapshotChecksum: checksum,
          sourceWatermark: firstWatermark,
          createdById: ids.actor,
          publishedById: ids.actor,
          publishedAt: new Date()
        },
        {
          id: secondVersionId,
          releaseId,
          technicalAssetId: assetId,
          revision: 2,
          status: "PUBLISHED",
          snapshotChecksum: "b".repeat(64),
          sourceWatermark: secondWatermark,
          createdById: ids.actor,
          publishedById: ids.actor,
          publishedAt: new Date()
        }
      ]
    });
    const componentData = (id: string, position: number) => ({
      id,
      releaseVersionId: firstVersionId,
      technicalAssetId: assetId,
      position,
      componentType: "MECHANICAL_DRAWING" as const,
      sourceProjectId: ids.project,
      sourceDocumentVersionId: ids.sourceDocumentVersion,
      sourceFileId: ids.sourceFile,
      sourceVersion: 1,
      sourceStatus: "PUBLISHED" as const,
      sourceChecksum: checksum,
      sourceFileSha256: checksum,
      sourceFileMimeType: "application/pdf",
      sourceFileSize: 128n,
      snapshotJson: { files: [{ fileId: ids.sourceFile, sha256: checksum }] }
    });
    await db.assetComponentSnapshot.createMany({
      data: [componentData(firstComponentId, 1), componentData(secondComponentId, 2)]
    });
    await db.projectAssetReference.create({
      data: {
        id: referenceId,
        projectId: ids.project,
        technicalAssetId: assetId,
        assetReleaseId: releaseId,
        assetReleaseVersionId: firstVersionId,
        releaseCode,
        releaseRevision: 1,
        snapshotChecksum: checksum,
        sourceWatermark: firstWatermark,
        createdById: ids.actor
      }
    });
    await db.projectAssetUsage.create({
      data: {
        id: usageId,
        usageKey: `COMPLETED-RND-USAGE-${suffix}`.toUpperCase(),
        projectId: ids.project,
        referenceId,
        technicalAssetId: assetId,
        assetReleaseId: releaseId,
        assetReleaseVersionId: firstVersionId,
        componentSnapshotId: firstComponentId,
        releaseRevision: 1,
        snapshotChecksum: checksum,
        sourceWatermark: firstWatermark,
        quantity: "1",
        configurationJson: { purpose: "研发完成前合法使用" },
        scopeType: "PROJECT",
        scopeId: ids.project,
        createdById: ids.actor
      }
    });
    for (const [status, version] of [
      ["VALIDATION", 2],
      ["RELEASE_REVIEW", 3],
      ["COMPLETED", 4]
    ] as const) {
      await db.rndProject.update({ where: { id: rndProjectId }, data: { status, version } });
    }

    const unavailable = /unavailable for (a new release fact|new project asset facts)/u;
    await expect(
      db.$executeRaw`
        INSERT INTO "asset_releases" (
          "id", "technical_asset_id", "release_code", "created_by_id", "updated_at"
        ) VALUES (
          ${`${prefix}-blocked-release`}, ${assetId}, ${`REL-COMPLETED-BLOCKED-${suffix}`.toUpperCase()},
          ${ids.actor}, CURRENT_TIMESTAMP
        )
      `
    ).rejects.toThrow(unavailable);
    await expect(
      db.$executeRaw`
        INSERT INTO "asset_release_versions" (
          "id", "release_id", "technical_asset_id", "revision", "status",
          "snapshot_checksum", "source_watermark", "created_by_id"
        ) VALUES (
          ${`${prefix}-blocked-version`}, ${releaseId}, ${assetId}, 3, 'DRAFT',
          ${"c".repeat(64)}, ${`${prefix}-watermark-3`}, ${ids.actor}
        )
      `
    ).rejects.toThrow(unavailable);
    await expect(
      db.$executeRaw`
        INSERT INTO "asset_upgrade_candidates" (
          "id", "technical_asset_id",
          "source_asset_release_id", "source_asset_release_version_id", "source_revision",
          "source_snapshot_checksum", "source_watermark",
          "target_asset_release_id", "target_asset_release_version_id", "target_revision",
          "target_snapshot_checksum", "target_watermark",
          "compatibility_snapshot_json", "compatibility_snapshot_checksum", "created_by_id"
        ) VALUES (
          ${`${prefix}-blocked-candidate`}, ${assetId},
          ${releaseId}, ${firstVersionId}, 1, ${checksum}, ${firstWatermark},
          ${releaseId}, ${secondVersionId}, 2, ${"b".repeat(64)}, ${secondWatermark},
          ${JSON.stringify({ basis: "completed R&D project must reject candidate" })}::jsonb,
          ${"d".repeat(64)}, ${ids.actor}
        )
      `
    ).rejects.toThrow(/exact allowed source and target ReleaseVersion facts/u);
    await expect(
      db.$executeRaw`
        INSERT INTO "project_asset_references" (
          "id", "project_id", "technical_asset_id", "asset_release_id", "asset_release_version_id",
          "release_code", "release_revision", "snapshot_checksum", "source_watermark",
          "created_by_id", "updated_at"
        ) VALUES (
          ${`${prefix}-blocked-reference`}, ${ids.project}, ${assetId}, ${releaseId}, ${secondVersionId},
          ${releaseCode}, 2, ${"b".repeat(64)}, ${secondWatermark}, ${ids.actor}, CURRENT_TIMESTAMP
        )
      `
    ).rejects.toThrow(unavailable);
    await expect(
      db.$executeRaw`
        INSERT INTO "project_asset_usages" (
          "id", "usage_key", "project_id", "reference_id", "technical_asset_id", "asset_release_id",
          "asset_release_version_id", "component_snapshot_id", "release_revision", "snapshot_checksum",
          "source_watermark", "quantity", "configuration_json", "scope_type", "scope_id",
          "created_by_id", "updated_at"
        ) VALUES (
          ${`${prefix}-blocked-usage`}, ${`COMPLETED-RND-BLOCKED-USAGE-${suffix}`.toUpperCase()},
          ${ids.project}, ${referenceId}, ${assetId}, ${releaseId}, ${firstVersionId}, ${secondComponentId},
          1, ${checksum}, ${firstWatermark}, 1, ${JSON.stringify({ purpose: "研发完成后应拒绝" })}::jsonb,
          'PROJECT', ${ids.project}, ${ids.actor}, CURRENT_TIMESTAMP
        )
      `
    ).rejects.toThrow(unavailable);
    await expect(
      db.$executeRaw`
        INSERT INTO "project_asset_derivations" (
          "id", "project_id", "source_reference_id", "source_usage_id", "source_technical_asset_id",
          "source_asset_release_id", "source_asset_release_version_id", "source_component_snapshot_id",
          "source_release_revision", "source_snapshot_checksum", "source_watermark",
          "target_controlled_document_version_id", "target_file_id", "target_source_file_sha256",
          "target_type", "target_document_version", "target_document_version_status", "target_file_status",
          "target_binding_key", "reason", "created_by_id"
        ) VALUES (
          ${`${prefix}-blocked-derivation`}, ${ids.project}, ${referenceId}, ${usageId}, ${assetId},
          ${releaseId}, ${firstVersionId}, ${firstComponentId}, 1, ${checksum}, ${firstWatermark},
          ${ids.sourceDocumentVersion}, ${ids.sourceFile}, ${checksum}, 'CONTROLLED_DOCUMENT_VERSION',
          1, 'PUBLISHED', 'AVAILABLE',
          ${`CONTROLLED_DOCUMENT_VERSION:${ids.sourceDocumentVersion}:-:${ids.sourceFile}`},
          '研发完成后派生应拒绝', ${ids.actor}
        )
      `
    ).rejects.toThrow(unavailable);
  });

  it("allows a complete historical Recall after its R&D project completes and asset is disabled", async () => {
    const prefix = `asset-impact-safe-recall-${suffix}`;
    const rndProjectId = `${prefix}-rnd`;
    const assetId = `${prefix}-asset`;
    const releaseId = `${prefix}-release`;
    const releaseVersionId = `${prefix}-version`;
    const recallId = `${prefix}-recall`;
    const recallRevisionId = `${prefix}-revision`;
    const watermark = `${prefix}-watermark`;
    await db.rndProject.create({
      data: {
        id: rndProjectId,
        code: `RND.SAFE.RECALL.${suffix}`.toUpperCase(),
        name: "终态历史安全召回",
        ownerId: ids.actor,
        status: "IN_DEVELOPMENT",
        createdById: ids.actor
      }
    });
    await db.technicalAsset.create({
      data: {
        id: assetId,
        rndProjectId,
        assetNumber: `AST.IMPACT.SAFE.RECALL.${suffix}`.toUpperCase(),
        assetType: "MECHANICAL",
        name: "终态历史安全召回资产",
        ownerId: ids.actor,
        status: "VALIDATED",
        createdById: ids.actor
      }
    });
    await db.assetRelease.create({
      data: {
        id: releaseId,
        technicalAssetId: assetId,
        releaseCode: `REL-SAFE-RECALL-${suffix}`.toUpperCase(),
        createdById: ids.actor
      }
    });
    await db.assetReleaseVersion.create({
      data: {
        id: releaseVersionId,
        releaseId,
        technicalAssetId: assetId,
        revision: 1,
        status: "PUBLISHED",
        snapshotChecksum: checksum,
        sourceWatermark: watermark,
        createdById: ids.actor,
        publishedById: ids.actor,
        publishedAt: new Date()
      }
    });
    for (const [status, version] of [
      ["VALIDATION", 2],
      ["RELEASE_REVIEW", 3],
      ["COMPLETED", 4]
    ] as const) {
      await db.rndProject.update({ where: { id: rndProjectId }, data: { status, version } });
    }
    await db.$transaction(async (transaction) => {
      await transaction.technicalAsset.update({
        where: { id: assetId },
        data: { status: "DISABLED", version: 2 }
      });
      await appendDisableEvent(transaction, {
        assetId,
        rndProjectId,
        eventId: `${prefix}-disabled-event`
      });
    });
    const affected = buildAssetReleaseRecallAffectedVersionSet({
      scope: "RELEASE_VERSION",
      releaseId,
      targetReleaseVersionId: releaseVersionId,
      versions: [
        {
          assetReleaseVersionId: releaseVersionId,
          releaseId,
          technicalAssetId: assetId,
          revision: 1,
          snapshotChecksum: checksum,
          sourceWatermark: watermark,
          status: "PUBLISHED"
        }
      ]
    });
    await db.$transaction(async (transaction) => {
      await transaction.assetReleaseRecall.create({
        data: {
          id: recallId,
          technicalAssetId: assetId,
          releaseId,
          targetReleaseVersionId: releaseVersionId,
          targetKey: `RELEASE_VERSION:${releaseVersionId}`,
          scope: "RELEASE_VERSION",
          affectedVersionSetChecksum: affected.affectedVersionSetChecksum,
          createdById: ids.actor
        }
      });
      await transaction.assetReleaseRecallAffectedVersion.create({
        data: {
          id: `${prefix}-affected`,
          recallId,
          technicalAssetId: assetId,
          releaseId,
          assetReleaseVersionId: releaseVersionId,
          revision: 1,
          snapshotChecksum: checksum,
          sourceWatermark: watermark,
          status: "PUBLISHED"
        }
      });
      await transaction.assetReleaseRecallRevision.create({
        data: {
          id: recallRevisionId,
          recallId,
          technicalAssetId: assetId,
          revision: 1,
          kind: "ISSUED",
          state: "ACTIVE",
          severity: "HIGH",
          reason: "终态资产仍允许历史安全召回",
          affectedVersionSetChecksum: affected.affectedVersionSetChecksum,
          affectedVersionCount: 1,
          sourceAssetReleaseId: releaseId,
          sourceAssetReleaseVersionId: releaseVersionId,
          sourceRevision: 1,
          sourceSnapshotChecksum: checksum,
          sourceWatermark: watermark,
          evidenceJson: { basis: "risk-review-request" },
          snapshotJson: {
            affectedVersionSetChecksum: affected.affectedVersionSetChecksum,
            sourceWatermark: watermark
          },
          snapshotChecksum: "7".repeat(64),
          actorId: ids.actor,
          effectiveAt: new Date(0)
        }
      });
      await transaction.assetReleaseRecall.update({
        where: { id: recallId },
        data: { currentRevisionId: recallRevisionId, currentState: "ACTIVE" }
      });
    });
    await expect(
      db.assetReleaseRecall.findUniqueOrThrow({ where: { id: recallId } })
    ).resolves.toMatchObject({ currentRevisionId: recallRevisionId, currentState: "ACTIVE" });
  });

  it("rejects direct project asset facts for draft, recalled, and disabled exact sources", async () => {
    const draftReleaseId = `asset-impact-draft-release-${suffix}`;
    const draftVersionId = `asset-impact-draft-version-${suffix}`;
    await db.assetRelease.create({
      data: {
        id: draftReleaseId,
        technicalAssetId: ids.recallAsset,
        releaseCode: `REL-DRAFT-${suffix}`.toUpperCase(),
        createdById: ids.actor
      }
    });
    await db.assetReleaseVersion.create({
      data: {
        id: draftVersionId,
        releaseId: draftReleaseId,
        technicalAssetId: ids.recallAsset,
        revision: 1,
        status: "DRAFT",
        snapshotChecksum: checksum,
        sourceWatermark: "draft-watermark",
        createdById: ids.actor
      }
    });
    await expect(
      db.projectAssetReference.create({
        data: {
          id: `asset-impact-draft-reference-${suffix}`,
          projectId: ids.project,
          technicalAssetId: ids.recallAsset,
          assetReleaseId: draftReleaseId,
          assetReleaseVersionId: draftVersionId,
          releaseCode: `REL-DRAFT-${suffix}`.toUpperCase(),
          releaseRevision: 1,
          snapshotChecksum: checksum,
          sourceWatermark: "draft-watermark",
          createdById: ids.actor
        }
      })
    ).rejects.toThrow(/exact PUBLISHED ReleaseVersion/u);

    const assetId = `asset-impact-facts-disabled-${suffix}`;
    const releaseId = `asset-impact-facts-release-${suffix}`;
    const versionId = `asset-impact-facts-version-${suffix}`;
    const componentId = `asset-impact-facts-component-${suffix}`;
    const referenceId = `asset-impact-facts-reference-${suffix}`;
    const usageId = `asset-impact-facts-usage-${suffix}`;
    await db.technicalAsset.create({
      data: {
        id: assetId,
        rndProjectId: ids.rndProject,
        assetNumber: `AST.IMPACT.FACTS.DISABLED.${suffix}`.toUpperCase(),
        assetType: "MECHANICAL",
        name: "停用后项目资产事实测试",
        ownerId: ids.actor,
        status: "VALIDATED",
        createdById: ids.actor
      }
    });
    await db.assetRelease.create({
      data: {
        id: releaseId,
        technicalAssetId: assetId,
        releaseCode: `REL-FACTS-${suffix}`.toUpperCase(),
        createdById: ids.actor
      }
    });
    await db.assetReleaseVersion.create({
      data: {
        id: versionId,
        releaseId,
        technicalAssetId: assetId,
        revision: 1,
        status: "PUBLISHED",
        snapshotChecksum: checksum,
        sourceWatermark: "facts-watermark",
        createdById: ids.actor,
        publishedById: ids.actor,
        publishedAt: new Date()
      }
    });
    await db.assetComponentSnapshot.create({
      data: {
        id: componentId,
        releaseVersionId: versionId,
        technicalAssetId: assetId,
        position: 1,
        componentType: "MECHANICAL_DRAWING",
        sourceProjectId: ids.project,
        sourceDocumentVersionId: ids.sourceDocumentVersion,
        sourceFileId: ids.sourceFile,
        sourceVersion: 1,
        sourceStatus: "PUBLISHED",
        sourceChecksum: checksum,
        sourceFileSha256: checksum,
        sourceFileMimeType: "application/pdf",
        sourceFileSize: 128n,
        snapshotJson: { files: [{ fileId: ids.sourceFile, sha256: checksum }] }
      }
    });
    await db.projectAssetReference.create({
      data: {
        id: referenceId,
        projectId: ids.project,
        technicalAssetId: assetId,
        assetReleaseId: releaseId,
        assetReleaseVersionId: versionId,
        releaseCode: `REL-FACTS-${suffix}`.toUpperCase(),
        releaseRevision: 1,
        snapshotChecksum: checksum,
        sourceWatermark: "facts-watermark",
        createdById: ids.actor
      }
    });
    await db.projectAssetUsage.create({
      data: {
        id: usageId,
        usageKey: `FACTS-USAGE-${suffix}`.toUpperCase(),
        projectId: ids.project,
        referenceId,
        technicalAssetId: assetId,
        assetReleaseId: releaseId,
        assetReleaseVersionId: versionId,
        componentSnapshotId: componentId,
        releaseRevision: 1,
        snapshotChecksum: checksum,
        sourceWatermark: "facts-watermark",
        quantity: "1",
        configurationJson: { purpose: "停用并发门禁" },
        scopeType: "PROJECT",
        scopeId: ids.project,
        createdById: ids.actor
      }
    });
    await db.projectAssetDerivation.create({
      data: {
        id: `asset-impact-facts-derivation-before-disable-${suffix}`,
        projectId: ids.project,
        sourceReferenceId: referenceId,
        sourceUsageId: usageId,
        sourceTechnicalAssetId: assetId,
        sourceAssetReleaseId: releaseId,
        sourceAssetReleaseVersionId: versionId,
        sourceComponentSnapshotId: componentId,
        sourceReleaseRevision: 1,
        sourceSnapshotChecksum: checksum,
        sourceWatermark: "facts-watermark",
        targetControlledDocumentVersionId: ids.sourceDocumentVersion,
        targetFileId: ids.sourceFile,
        targetSourceFileSha256: checksum,
        targetType: "CONTROLLED_DOCUMENT_VERSION",
        targetDocumentVersion: 1,
        targetDocumentVersionStatus: "PUBLISHED",
        targetFileStatus: "AVAILABLE",
        targetBindingKey: `CONTROLLED_DOCUMENT_VERSION:${ids.sourceDocumentVersion}:-:${ids.sourceFile}`,
        reason: "停用前合法派生",
        createdById: ids.actor
      }
    });
    await db.$transaction(async (transaction) => {
      await transaction.technicalAsset.update({
        where: { id: assetId },
        data: { status: "DISABLED", version: 2 }
      });
      await appendDisableEvent(transaction, {
        assetId,
        rndProjectId: ids.rndProject,
        eventId: `asset-impact-facts-disabled-event-${suffix}`
      });
    });
    await expect(
      db.projectAssetUsage.create({
        data: {
          id: `asset-impact-facts-usage-after-disable-${suffix}`,
          usageKey: `FACTS-USAGE-DISABLED-${suffix}`.toUpperCase(),
          projectId: ids.project,
          referenceId,
          technicalAssetId: assetId,
          assetReleaseId: releaseId,
          assetReleaseVersionId: versionId,
          componentSnapshotId: componentId,
          releaseRevision: 1,
          snapshotChecksum: checksum,
          sourceWatermark: "facts-watermark",
          quantity: "1",
          configurationJson: { purpose: "停用后应拒绝" },
          scopeType: "PROJECT",
          scopeId: ids.project,
          createdById: ids.actor
        }
      })
    ).rejects.toThrow(/unavailable for new project asset facts/u);
    await expect(
      db.projectAssetDerivation.create({
        data: {
          id: `asset-impact-facts-derivation-after-disable-${suffix}`,
          projectId: ids.project,
          sourceReferenceId: referenceId,
          sourceUsageId: usageId,
          sourceTechnicalAssetId: assetId,
          sourceAssetReleaseId: releaseId,
          sourceAssetReleaseVersionId: versionId,
          sourceComponentSnapshotId: componentId,
          sourceReleaseRevision: 1,
          sourceSnapshotChecksum: checksum,
          sourceWatermark: "facts-watermark",
          targetControlledDocumentVersionId: ids.sourceDocumentVersion,
          targetFileId: ids.sourceFile,
          targetSourceFileSha256: checksum,
          targetType: "CONTROLLED_DOCUMENT_VERSION",
          targetDocumentVersion: 1,
          targetDocumentVersionStatus: "PUBLISHED",
          targetFileStatus: "AVAILABLE",
          targetBindingKey: `CONTROLLED_DOCUMENT_VERSION:${ids.sourceDocumentVersion}:-:${ids.sourceFile}`,
          reason: "停用后派生应拒绝",
          createdById: ids.actor
        }
      })
    ).rejects.toThrow(/unavailable for new project asset facts/u);
    await expect(db.projectAssetUsage.count({ where: { referenceId } })).resolves.toBe(1);
    await expect(
      db.projectAssetDerivation.count({ where: { sourceReferenceId: referenceId } })
    ).resolves.toBe(1);
  });

  it("freezes a multi-version Recall root atomically and rejects future mutation", async () => {
    const releaseCode = `REL-IMPACT-${suffix}`.toUpperCase();
    await db.assetReleaseVersion.update({
      where: { id: ids.releaseVersion },
      data: { status: "SUPERSEDED", supersededAt: new Date() }
    });
    await db.assetReleaseVersion.create({
      data: {
        id: ids.secondReleaseVersion,
        releaseId: ids.release,
        technicalAssetId: ids.recallAsset,
        revision: 2,
        status: "PUBLISHED",
        snapshotChecksum: "b".repeat(64),
        sourceWatermark: `watermark-${releaseCode}-2`,
        createdById: ids.actor,
        publishedById: ids.actor,
        publishedAt: new Date()
      }
    });
    const affected = buildAssetReleaseRecallAffectedVersionSet({
      scope: "RELEASE",
      releaseId: ids.release,
      versions: [
        {
          assetReleaseVersionId: ids.releaseVersion,
          releaseId: ids.release,
          technicalAssetId: ids.recallAsset,
          revision: 1,
          snapshotChecksum: checksum,
          sourceWatermark: `watermark-${releaseCode}`,
          status: "SUPERSEDED"
        },
        {
          assetReleaseVersionId: ids.secondReleaseVersion,
          releaseId: ids.release,
          technicalAssetId: ids.recallAsset,
          revision: 2,
          snapshotChecksum: "b".repeat(64),
          sourceWatermark: `watermark-${releaseCode}-2`,
          status: "PUBLISHED"
        }
      ]
    });

    await db.$transaction(async (transaction) => {
      await transaction.assetReleaseRecall.create({
        data: {
          id: ids.recall,
          technicalAssetId: ids.recallAsset,
          releaseId: ids.release,
          targetKey: `RELEASE:${ids.release}`,
          scope: "RELEASE",
          affectedVersionSetChecksum: affected.affectedVersionSetChecksum,
          createdById: ids.actor
        }
      });
      await transaction.assetReleaseRecallAffectedVersion.create({
        data: {
          id: ids.affectedVersion,
          recallId: ids.recall,
          technicalAssetId: ids.recallAsset,
          releaseId: ids.release,
          assetReleaseVersionId: ids.releaseVersion,
          revision: 1,
          snapshotChecksum: checksum,
          sourceWatermark: `watermark-${releaseCode}`,
          status: "SUPERSEDED"
        }
      });
      await transaction.assetReleaseRecallAffectedVersion.create({
        data: {
          id: ids.secondAffectedVersion,
          recallId: ids.recall,
          technicalAssetId: ids.recallAsset,
          releaseId: ids.release,
          assetReleaseVersionId: ids.secondReleaseVersion,
          revision: 2,
          snapshotChecksum: "b".repeat(64),
          sourceWatermark: `watermark-${releaseCode}-2`,
          status: "PUBLISHED"
        }
      });
      await transaction.assetReleaseRecallRevision.create({
        data: {
          id: ids.recallRevision,
          recallId: ids.recall,
          technicalAssetId: ids.recallAsset,
          revision: 1,
          kind: "ISSUED",
          state: "ACTIVE",
          severity: "HIGH",
          reason: "冻结 exact ReleaseVersion 召回事实",
          affectedVersionSetChecksum: affected.affectedVersionSetChecksum,
          affectedVersionCount: 2,
          sourceAssetReleaseId: ids.release,
          sourceAssetReleaseVersionId: ids.releaseVersion,
          sourceRevision: 1,
          sourceSnapshotChecksum: checksum,
          sourceWatermark: `watermark-${releaseCode}`,
          evidenceJson: { basis: "risk-review-request" },
          snapshotJson: {
            affectedVersionSetChecksum: affected.affectedVersionSetChecksum,
            sourceWatermark: `watermark-${releaseCode}`
          },
          snapshotChecksum: "c".repeat(64),
          actorId: ids.actor,
          effectiveAt: new Date(0)
        }
      });
      await transaction.assetReleaseRecall.update({
        where: { id: ids.recall },
        data: { currentRevisionId: ids.recallRevision, currentState: "ACTIVE" }
      });
    });

    const root = await db.assetReleaseRecall.findUniqueOrThrow({
      where: { id: ids.recall },
      include: { currentRevision: true, affectedVersions: true }
    });
    expect(root.currentRevision).toMatchObject({
      id: ids.recallRevision,
      affectedVersionSetChecksum: affected.affectedVersionSetChecksum
    });
    expect(root.currentRevision?.effectiveAt.getTime()).toBeGreaterThan(new Date(0).getTime());
    expect(root.affectedVersions).toHaveLength(2);
    const recalledProjectId = `asset-impact-recalled-project-${suffix}`;
    await db.project.create({
      data: {
        id: recalledProjectId,
        code: `ASSET-RECALLED-${suffix}`.toUpperCase(),
        name: "召回后引用拒绝项目",
        createdById: ids.actor
      }
    });
    await expect(
      db.projectAssetReference.create({
        data: {
          id: `asset-impact-recalled-reference-${suffix}`,
          projectId: recalledProjectId,
          technicalAssetId: ids.recallAsset,
          assetReleaseId: ids.release,
          assetReleaseVersionId: ids.secondReleaseVersion,
          releaseCode: `REL-IMPACT-${suffix}`.toUpperCase(),
          releaseRevision: 2,
          snapshotChecksum: "b".repeat(64),
          sourceWatermark: `watermark-${`REL-IMPACT-${suffix}`.toUpperCase()}-2`,
          createdById: ids.actor
        }
      })
    ).rejects.toThrow(/subject to an active recall/u);
    await expect(
      db.assetReleaseRecallAffectedVersion.update({
        where: { id: ids.affectedVersion },
        data: { sourceWatermark: "tampered" }
      })
    ).rejects.toThrow(/append-only/u);
    await expect(
      db.$executeRawUnsafe('TRUNCATE TABLE "asset_release_recall_affected_versions"')
    ).rejects.toThrow(/append-only/u);
  });

  it("requires every Recall revision to advance and apply the exact current pointer", async () => {
    const root = await db.assetReleaseRecall.findUniqueOrThrow({ where: { id: ids.recall } });
    const anchor = await db.assetReleaseRecallAffectedVersion.findUniqueOrThrow({
      where: {
        recallId_assetReleaseVersionId: {
          recallId: ids.recall,
          assetReleaseVersionId: ids.releaseVersion
        }
      }
    });
    const revisionData = (revision: number) => ({
      id: `asset-impact-recall-revision-${revision}-${suffix}`,
      recallId: ids.recall,
      technicalAssetId: ids.recallAsset,
      revision,
      kind: "CORRECTED" as const,
      state: "ACTIVE" as const,
      severity: "HIGH" as const,
      reason: `召回修订 ${revision}`,
      affectedVersionSetChecksum: root.affectedVersionSetChecksum!,
      affectedVersionCount: 2,
      sourceAssetReleaseId: anchor.releaseId,
      sourceAssetReleaseVersionId: anchor.assetReleaseVersionId,
      sourceRevision: anchor.revision,
      sourceSnapshotChecksum: anchor.snapshotChecksum,
      sourceWatermark: anchor.sourceWatermark,
      evidenceJson: {},
      snapshotJson: {
        affectedVersionSetChecksum: root.affectedVersionSetChecksum!,
        sourceWatermark: anchor.sourceWatermark
      },
      snapshotChecksum: "d".repeat(64),
      actorId: ids.actor,
      effectiveAt: new Date(0)
    });

    await expect(db.assetReleaseRecallRevision.create({ data: revisionData(2) })).rejects.toThrow(
      /exact current pointer/u
    );
    await expect(
      db.$transaction(async (transaction) => {
        await transaction.assetReleaseRecallRevision.create({ data: revisionData(2) });
        await transaction.assetReleaseRecallRevision.create({ data: revisionData(3) });
        await transaction.assetReleaseRecall.update({
          where: { id: ids.recall },
          data: {
            currentRevisionId: `asset-impact-recall-revision-3-${suffix}`,
            currentState: "ACTIVE",
            version: 3
          }
        });
      })
    ).rejects.toThrow(/previous exact current revision/u);
    await expect(
      db.assetReleaseRecallRevision.count({ where: { recallId: ids.recall } })
    ).resolves.toBe(1);
  });

  it("binds recall corrections and project refreshes to their exact revision facts", async () => {
    const root = await db.assetReleaseRecall.findUniqueOrThrow({ where: { id: ids.recall } });
    const anchor = await db.assetReleaseRecallAffectedVersion.findUniqueOrThrow({
      where: {
        recallId_assetReleaseVersionId: {
          recallId: ids.recall,
          assetReleaseVersionId: ids.releaseVersion
        }
      }
    });
    const otherRelease = await createPublishedReleaseVersion({
      releaseCode: `REL-RECALL-EXACT-${suffix}`.toUpperCase(),
      revision: 1
    });
    const correctedRevisionId = `asset-impact-recall-corrected-${suffix}`;
    const correction = {
      id: correctedRevisionId,
      recallId: ids.recall,
      technicalAssetId: ids.recallAsset,
      revision: 2,
      kind: "CORRECTED" as const,
      state: "ACTIVE" as const,
      severity: "HIGH" as const,
      reason: "召回修订冻结同一 exact release anchor",
      affectedVersionSetChecksum: root.affectedVersionSetChecksum!,
      affectedVersionCount: 2,
      sourceAssetReleaseId: anchor.releaseId,
      sourceAssetReleaseVersionId: anchor.assetReleaseVersionId,
      sourceRevision: anchor.revision,
      sourceSnapshotChecksum: anchor.snapshotChecksum,
      sourceWatermark: anchor.sourceWatermark,
      evidenceJson: { correction: "exact-source" },
      snapshotJson: {
        affectedVersionSetChecksum: root.affectedVersionSetChecksum!,
        sourceWatermark: anchor.sourceWatermark
      },
      snapshotChecksum: "d".repeat(64),
      actorId: ids.actor,
      effectiveAt: new Date(0)
    };
    await expect(
      db.assetReleaseRecallRevision.create({
        data: {
          ...correction,
          id: `${correctedRevisionId}-wrong-release`,
          sourceAssetReleaseId: otherRelease.releaseId
        }
      })
    ).rejects.toThrow(/23503|23514|frozen affected-version set/u);

    const otherRecallId = `asset-impact-other-recall-${suffix}`;
    const otherRecallRevisionId = `${otherRecallId}-revision`;
    const otherAffected = buildAssetReleaseRecallAffectedVersionSet({
      scope: "RELEASE_VERSION",
      releaseId: otherRelease.releaseId,
      targetReleaseVersionId: otherRelease.releaseVersionId,
      versions: [
        {
          assetReleaseVersionId: otherRelease.releaseVersionId,
          releaseId: otherRelease.releaseId,
          technicalAssetId: ids.recallAsset,
          revision: 1,
          snapshotChecksum: checksum,
          sourceWatermark: `watermark-${`REL-RECALL-EXACT-${suffix}`.toUpperCase()}`,
          status: "PUBLISHED"
        }
      ]
    });
    await db.$transaction(async (transaction) => {
      await transaction.assetReleaseRecall.create({
        data: {
          id: otherRecallId,
          technicalAssetId: ids.recallAsset,
          releaseId: otherRelease.releaseId,
          targetReleaseVersionId: otherRelease.releaseVersionId,
          targetKey: `RELEASE_VERSION:${otherRelease.releaseVersionId}`,
          scope: "RELEASE_VERSION",
          affectedVersionSetChecksum: otherAffected.affectedVersionSetChecksum,
          createdById: ids.actor
        }
      });
      await transaction.assetReleaseRecallAffectedVersion.create({
        data: {
          id: `${otherRecallId}-affected`,
          recallId: otherRecallId,
          technicalAssetId: ids.recallAsset,
          releaseId: otherRelease.releaseId,
          assetReleaseVersionId: otherRelease.releaseVersionId,
          revision: 1,
          snapshotChecksum: checksum,
          sourceWatermark: `watermark-${`REL-RECALL-EXACT-${suffix}`.toUpperCase()}`,
          status: "PUBLISHED"
        }
      });
      await transaction.assetReleaseRecallRevision.create({
        data: {
          id: otherRecallRevisionId,
          recallId: otherRecallId,
          technicalAssetId: ids.recallAsset,
          revision: 1,
          kind: "ISSUED",
          state: "ACTIVE",
          severity: "HIGH",
          reason: "独立召回用于 exact revision 反例",
          affectedVersionSetChecksum: otherAffected.affectedVersionSetChecksum,
          affectedVersionCount: 1,
          sourceAssetReleaseId: otherRelease.releaseId,
          sourceAssetReleaseVersionId: otherRelease.releaseVersionId,
          sourceRevision: 1,
          sourceSnapshotChecksum: checksum,
          sourceWatermark: `watermark-${`REL-RECALL-EXACT-${suffix}`.toUpperCase()}`,
          evidenceJson: { source: "other-recall" },
          snapshotJson: {
            affectedVersionSetChecksum: otherAffected.affectedVersionSetChecksum,
            sourceWatermark: `watermark-${`REL-RECALL-EXACT-${suffix}`.toUpperCase()}`
          },
          snapshotChecksum: "e".repeat(64),
          actorId: ids.actor,
          effectiveAt: new Date(0)
        }
      });
      await transaction.assetReleaseRecall.update({
        where: { id: otherRecallId },
        data: { currentRevisionId: otherRecallRevisionId, currentState: "ACTIVE" }
      });
    });

    const fixture = await createOpenImpact("exact-recall-refresh");
    const missingRevisionSource = recallAssessmentSource({
      recallId: ids.recall,
      recallRevisionId: ids.recallRevision,
      recallRevisionNumber: 1,
      recallRevisionSnapshotChecksum: "c".repeat(64),
      recallRevisionKind: "ISSUED",
      recallRevisionState: "ACTIVE",
      projectFactsWatermark: `${fixture.prefix}-missing-revision`
    });
    await expect(
      db.assetImpactAssessmentRevision.create({
        data: {
          id: `${fixture.prefix}-missing-recall-revision`,
          impactId: fixture.impactId,
          projectId: fixture.projectId,
          technicalAssetId: ids.recallAsset,
          sequence: 2,
          kind: "REFRESH",
          recallId: ids.recall,
          recallRevisionId: null,
          sourceWatermark: missingRevisionSource.sourceWatermark,
          snapshotJson: missingRevisionSource.snapshotJson,
          snapshotChecksum: "1".repeat(64),
          frozenAt: new Date(0),
          actorId: ids.actor,
          actorMembershipId: fixture.membershipId,
          actorMembershipSnapshotJson: fixture.ownerSnapshot,
          ownerMembershipId: fixture.membershipId,
          ownerMembershipSnapshotJson: fixture.ownerSnapshot,
          dueAt: fixture.dueAt
        }
      })
    ).rejects.toThrow(/23514|exact recall revision source facts/u);
    const wrongRecallSource = recallAssessmentSource({
      recallId: ids.recall,
      recallRevisionId: otherRecallRevisionId,
      recallRevisionNumber: 1,
      recallRevisionSnapshotChecksum: "e".repeat(64),
      recallRevisionKind: "ISSUED",
      recallRevisionState: "ACTIVE",
      projectFactsWatermark: `${fixture.prefix}-wrong-recall`
    });
    await expect(
      db.assetImpactAssessmentRevision.create({
        data: {
          id: `${fixture.prefix}-wrong-recall-revision`,
          impactId: fixture.impactId,
          projectId: fixture.projectId,
          technicalAssetId: ids.recallAsset,
          sequence: 2,
          kind: "REFRESH",
          ...wrongRecallSource,
          snapshotChecksum: "2".repeat(64),
          frozenAt: new Date(0),
          actorId: ids.actor,
          actorMembershipId: fixture.membershipId,
          actorMembershipSnapshotJson: fixture.ownerSnapshot,
          ownerMembershipId: fixture.membershipId,
          ownerMembershipSnapshotJson: fixture.ownerSnapshot,
          dueAt: fixture.dueAt
        }
      })
    ).rejects.toThrow(/23503|23514|exact recall revision source facts/u);

    await db.$transaction(async (transaction) => {
      await transaction.assetReleaseRecallRevision.create({ data: correction });
      await transaction.assetReleaseRecall.update({
        where: { id: ids.recall },
        data: { currentRevisionId: correctedRevisionId, currentState: "ACTIVE", version: 2 }
      });
    });
    const refreshId = `${fixture.prefix}-corrected-refresh`;
    const correctedSource = recallAssessmentSource({
      recallId: ids.recall,
      recallRevisionId: correctedRevisionId,
      recallRevisionNumber: 2,
      recallRevisionSnapshotChecksum: "d".repeat(64),
      recallRevisionKind: "CORRECTED",
      recallRevisionState: "ACTIVE",
      projectFactsWatermark: `${fixture.prefix}-project-facts-1`
    });
    await db.$transaction(async (transaction) => {
      await transaction.assetImpactAssessmentRevision.create({
        data: {
          id: refreshId,
          impactId: fixture.impactId,
          projectId: fixture.projectId,
          technicalAssetId: ids.recallAsset,
          sequence: 2,
          kind: "REFRESH",
          ...correctedSource,
          snapshotChecksum: "f".repeat(64),
          frozenAt: new Date(0),
          actorId: ids.actor,
          actorMembershipId: fixture.membershipId,
          actorMembershipSnapshotJson: fixture.ownerSnapshot,
          ownerMembershipId: fixture.membershipId,
          ownerMembershipSnapshotJson: fixture.ownerSnapshot,
          dueAt: fixture.dueAt
        }
      });
      await applyImpactDisposition(transaction, {
        fixture,
        id: `${fixture.prefix}-corrected-refresh-disposition`,
        assessmentRevisionId: refreshId,
        sequence: 1,
        type: "REFRESHED",
        fromStatus: "OPEN",
        toStatus: "OPEN",
        nextVersion: 2
      });
    });
    const assessments = await db.assetImpactAssessmentRevision.findMany({
      where: { impactId: fixture.impactId },
      orderBy: { sequence: "asc" }
    });
    expect(assessments).toHaveLength(2);
    expect(assessments[1]).toMatchObject({
      recallId: ids.recall,
      recallRevisionId: correctedRevisionId,
      sourceWatermark: correctedSource.sourceWatermark,
      snapshotChecksum: "f".repeat(64)
    });
    expect(assessments[1]!.sourceWatermark).not.toBe(assessments[0]!.sourceWatermark);
    expect(assessments[1]!.snapshotChecksum).not.toBe(assessments[0]!.snapshotChecksum);
  });

  it("binds deactivation impacts to the exact disabled event and INITIAL assessment", async () => {
    const event = await db.technicalAssetEvent.findUniqueOrThrow({
      where: { id: `asset-impact-disabled-event-${suffix}` }
    });
    await expect(
      db.assetProjectImpact.create({
        data: {
          id: `asset-impact-wrong-deactivation-${suffix}`,
          projectId: ids.project,
          technicalAssetId: ids.recallAsset,
          sourceType: "ASSET_DEACTIVATION",
          sourceKey: `ASSET_DEACTIVATION:${event.id}`,
          technicalAssetEventId: event.id
        }
      })
    ).rejects.toThrow(/23514|exact VALIDATED to DISABLED event/u);

    const impactId = `asset-impact-deactivation-${suffix}`;
    const assessmentId = `${impactId}-initial`;
    const source = buildAssetDeactivationImpactAssessmentSource({
      technicalAssetId: ids.disabledAsset,
      technicalAssetEventId: event.id,
      eventSequence: event.sequence,
      eventSnapshot: event.snapshotJson,
      projectFactsWatermark: `${impactId}-project-facts`
    });
    await db.$transaction(async (transaction) => {
      await transaction.assetProjectImpact.create({
        data: {
          id: impactId,
          projectId: ids.project,
          technicalAssetId: ids.disabledAsset,
          sourceType: "ASSET_DEACTIVATION",
          sourceKey: `ASSET_DEACTIVATION:${event.id}`,
          technicalAssetEventId: event.id
        }
      });
      await transaction.assetImpactAssessmentRevision.create({
        data: {
          id: assessmentId,
          impactId,
          projectId: ids.project,
          technicalAssetId: ids.disabledAsset,
          sequence: 1,
          kind: "INITIAL",
          sourceWatermark: source.sourceWatermark,
          snapshotJson: source,
          snapshotChecksum: "4".repeat(64),
          frozenAt: new Date(0)
        }
      });
      await transaction.assetProjectImpact.update({
        where: { id: impactId },
        data: { currentAssessmentRevisionId: assessmentId }
      });
    });
    await expect(
      db.assetProjectImpact.findUniqueOrThrow({ where: { id: impactId } })
    ).resolves.toMatchObject({
      sourceType: "ASSET_DEACTIVATION",
      technicalAssetEventId: event.id,
      currentAssessmentRevisionId: assessmentId,
      status: "OPEN",
      version: 1
    });
  });

  it("rejects an impact root that commits without its exact INITIAL assessment", async () => {
    await expect(
      db.$executeRaw`
        INSERT INTO "asset_project_impacts" (
          "id", "project_id", "technical_asset_id", "source_type", "source_key", "recall_id", "updated_at"
        ) VALUES (
          ${`asset-impact-incomplete-root-${suffix}`}, ${ids.project}, ${ids.recallAsset}, 'RECALL',
          ${`RECALL:${ids.recall}`}, ${ids.recall}, CURRENT_TIMESTAMP
        )
      `
    ).rejects.toThrow(/requires an exact INITIAL assessment before commit/u);
  });

  it("serializes recall/reference and disable/project-fact races in both commit orders without deadlocks", async () => {
    const createRecallRace = async (label: string) => {
      const projectId = `asset-impact-race-${label}-project-${suffix}`;
      const releaseCode = `REL-RACE-${label}-${suffix}`.toUpperCase();
      const release = await createPublishedReleaseVersion({ releaseCode, revision: 1 });
      await db.project.create({
        data: {
          id: projectId,
          code: `RACE-${label}-${suffix}`.toUpperCase(),
          name: `召回并发 ${label}`,
          createdById: ids.actor
        }
      });
      return {
        label,
        projectId,
        releaseCode,
        ...release,
        watermark: `watermark-${releaseCode}`,
        recallId: `asset-impact-race-${label}-recall-${suffix}`,
        revisionId: `asset-impact-race-${label}-revision-${suffix}`,
        referenceId: `asset-impact-race-${label}-reference-${suffix}`
      };
    };
    const referenceData = (fixture: Awaited<ReturnType<typeof createRecallRace>>) => ({
      id: fixture.referenceId,
      projectId: fixture.projectId,
      technicalAssetId: ids.recallAsset,
      assetReleaseId: fixture.releaseId,
      assetReleaseVersionId: fixture.releaseVersionId,
      releaseCode: fixture.releaseCode,
      releaseRevision: 1,
      snapshotChecksum: checksum,
      sourceWatermark: fixture.watermark,
      createdById: ids.actor
    });
    const issueRecall = async (
      transaction: Prisma.TransactionClient,
      fixture: Awaited<ReturnType<typeof createRecallRace>>,
      afterRoot?: () => void
    ) => {
      await transactionTimeouts(transaction);
      const affected = buildAssetReleaseRecallAffectedVersionSet({
        scope: "RELEASE_VERSION",
        releaseId: fixture.releaseId,
        targetReleaseVersionId: fixture.releaseVersionId,
        versions: [
          {
            assetReleaseVersionId: fixture.releaseVersionId,
            releaseId: fixture.releaseId,
            technicalAssetId: ids.recallAsset,
            revision: 1,
            snapshotChecksum: checksum,
            sourceWatermark: fixture.watermark,
            status: "PUBLISHED"
          }
        ]
      });
      await transaction.assetReleaseRecall.create({
        data: {
          id: fixture.recallId,
          technicalAssetId: ids.recallAsset,
          releaseId: fixture.releaseId,
          targetReleaseVersionId: fixture.releaseVersionId,
          targetKey: `RELEASE_VERSION:${fixture.releaseVersionId}`,
          scope: "RELEASE_VERSION",
          affectedVersionSetChecksum: affected.affectedVersionSetChecksum,
          createdById: ids.actor
        }
      });
      afterRoot?.();
      await transaction.assetReleaseRecallAffectedVersion.create({
        data: {
          id: `${fixture.recallId}-affected`,
          recallId: fixture.recallId,
          technicalAssetId: ids.recallAsset,
          releaseId: fixture.releaseId,
          assetReleaseVersionId: fixture.releaseVersionId,
          revision: 1,
          snapshotChecksum: checksum,
          sourceWatermark: fixture.watermark,
          status: "PUBLISHED"
        }
      });
      await transaction.assetReleaseRecallRevision.create({
        data: {
          id: fixture.revisionId,
          recallId: fixture.recallId,
          technicalAssetId: ids.recallAsset,
          revision: 1,
          kind: "ISSUED",
          state: "ACTIVE",
          severity: "HIGH",
          reason: `并发召回 ${fixture.label}`,
          affectedVersionSetChecksum: affected.affectedVersionSetChecksum,
          affectedVersionCount: 1,
          sourceAssetReleaseId: fixture.releaseId,
          sourceAssetReleaseVersionId: fixture.releaseVersionId,
          sourceRevision: 1,
          sourceSnapshotChecksum: checksum,
          sourceWatermark: fixture.watermark,
          evidenceJson: {},
          snapshotJson: {
            affectedVersionSetChecksum: affected.affectedVersionSetChecksum,
            sourceWatermark: fixture.watermark
          },
          snapshotChecksum: "3".repeat(64),
          actorId: ids.actor,
          effectiveAt: new Date(0)
        }
      });
      await transaction.assetReleaseRecall.update({
        where: { id: fixture.recallId },
        data: { currentRevisionId: fixture.revisionId, currentState: "ACTIVE" }
      });
    };

    const referenceFirst = await createRecallRace("REFERENCE-FIRST");
    let referenceInserted!: () => void;
    const referenceInsertedBarrier = new Promise<void>((resolve) => (referenceInserted = resolve));
    const referenceFirstWrite = db.$transaction(async (transaction) => {
      await transactionTimeouts(transaction);
      await transaction.projectAssetReference.create({ data: referenceData(referenceFirst) });
      referenceInserted();
      await transaction.$queryRaw`SELECT 1 AS "waited" FROM pg_sleep(0.15)`;
    });
    await referenceInsertedBarrier;
    const referenceFirstRecall = db.$transaction((transaction) =>
      issueRecall(transaction, referenceFirst)
    );
    const referenceFirstResults = await Promise.allSettled([
      referenceFirstWrite,
      referenceFirstRecall
    ]);
    expect(referenceFirstResults.map((result) => result.status)).toEqual([
      "fulfilled",
      "fulfilled"
    ]);
    const historicalReference = await db.projectAssetReference.findUniqueOrThrow({
      where: { id: referenceFirst.referenceId }
    });
    const laterRecallRevision = await db.assetReleaseRecallRevision.findUniqueOrThrow({
      where: { id: referenceFirst.revisionId }
    });
    expect(historicalReference.createdAt.getTime()).toBeLessThanOrEqual(
      laterRecallRevision.effectiveAt.getTime()
    );

    const recallFirst = await createRecallRace("RECALL-FIRST");
    let recallRootInserted!: () => void;
    const recallRootBarrier = new Promise<void>((resolve) => (recallRootInserted = resolve));
    const recallFirstWrite = db.$transaction(async (transaction) => {
      await issueRecall(transaction, recallFirst, recallRootInserted);
      await transaction.$queryRaw`SELECT 1 AS "waited" FROM pg_sleep(0.15)`;
    });
    await recallRootBarrier;
    const blockedReference = db.$transaction(async (transaction) => {
      await transactionTimeouts(transaction);
      await transaction.projectAssetReference.create({ data: referenceData(recallFirst) });
    });
    const recallFirstResults = await Promise.allSettled([recallFirstWrite, blockedReference]);
    expect(recallFirstResults[0]?.status).toBe("fulfilled");
    expect(recallFirstResults[1]?.status).toBe("rejected");
    const blockedReferenceError =
      recallFirstResults[1]?.status === "rejected" ? String(recallFirstResults[1].reason) : "";
    expect(blockedReferenceError).toMatch(/23514/u);
    expect(blockedReferenceError).not.toMatch(/40P01/u);
    await expect(
      db.projectAssetReference.count({ where: { id: recallFirst.referenceId } })
    ).resolves.toBe(0);

    const createDisableRace = async (label: string, createUsage: boolean) => {
      const assetId = `asset-impact-disable-race-${label}-asset-${suffix}`;
      const releaseCode = `REL-DISABLE-RACE-${label}-${suffix}`.toUpperCase();
      await db.technicalAsset.create({
        data: {
          id: assetId,
          rndProjectId: ids.rndProject,
          assetNumber: `AST.DISABLE.RACE.${label}.${suffix}`.toUpperCase(),
          assetType: "MECHANICAL",
          name: `停用并发 ${label}`,
          ownerId: ids.actor,
          status: "VALIDATED",
          createdById: ids.actor
        }
      });
      const release = await createPublishedReleaseVersion({
        releaseCode,
        revision: 1,
        technicalAssetId: assetId
      });
      const componentId = `asset-impact-disable-race-${label}-component-${suffix}`;
      const referenceId = `asset-impact-disable-race-${label}-reference-${suffix}`;
      const usageId = `asset-impact-disable-race-${label}-usage-${suffix}`;
      const watermark = `watermark-${releaseCode}`;
      await db.assetComponentSnapshot.create({
        data: {
          id: componentId,
          releaseVersionId: release.releaseVersionId,
          technicalAssetId: assetId,
          position: 1,
          componentType: "MECHANICAL_DRAWING",
          sourceProjectId: ids.project,
          sourceDocumentVersionId: ids.sourceDocumentVersion,
          sourceFileId: ids.sourceFile,
          sourceVersion: 1,
          sourceStatus: "PUBLISHED",
          sourceChecksum: checksum,
          sourceFileSha256: checksum,
          sourceFileMimeType: "application/pdf",
          sourceFileSize: 128n,
          snapshotJson: { files: [{ fileId: ids.sourceFile, sha256: checksum }] }
        }
      });
      await db.projectAssetReference.create({
        data: {
          id: referenceId,
          projectId: ids.project,
          technicalAssetId: assetId,
          assetReleaseId: release.releaseId,
          assetReleaseVersionId: release.releaseVersionId,
          releaseCode,
          releaseRevision: 1,
          snapshotChecksum: checksum,
          sourceWatermark: watermark,
          createdById: ids.actor
        }
      });
      const usageData = (id: string, usageKey: string) => ({
        id,
        usageKey,
        projectId: ids.project,
        referenceId,
        technicalAssetId: assetId,
        assetReleaseId: release.releaseId,
        assetReleaseVersionId: release.releaseVersionId,
        componentSnapshotId: componentId,
        releaseRevision: 1,
        snapshotChecksum: checksum,
        sourceWatermark: watermark,
        quantity: "1",
        configurationJson: { purpose: `停用并发 ${label}` },
        scopeType: "PROJECT" as const,
        scopeId: ids.project,
        createdById: ids.actor
      });
      if (createUsage) await db.projectAssetUsage.create({ data: usageData(usageId, usageId) });
      return {
        label,
        assetId,
        ...release,
        componentId,
        referenceId,
        usageId,
        watermark,
        usageData
      };
    };

    const usageFirst = await createDisableRace("USAGE-FIRST", false);
    let usageInserted!: () => void;
    const usageBarrier = new Promise<void>((resolve) => (usageInserted = resolve));
    const usageWrite = db.$transaction(async (transaction) => {
      await transactionTimeouts(transaction);
      await transaction.projectAssetUsage.create({
        data: usageFirst.usageData(usageFirst.usageId, usageFirst.usageId)
      });
      usageInserted();
      await transaction.$queryRaw`SELECT 1 AS "waited" FROM pg_sleep(0.15)`;
    });
    await usageBarrier;
    const laterDisable = db.$transaction(async (transaction) => {
      await transactionTimeouts(transaction);
      await transaction.technicalAsset.update({
        where: { id: usageFirst.assetId },
        data: { status: "DISABLED", version: 2 }
      });
      await appendDisableEvent(transaction, {
        assetId: usageFirst.assetId,
        rndProjectId: ids.rndProject,
        eventId: `${usageFirst.assetId}-disabled-event`
      });
      const [row] = await transaction.$queryRaw<{ disabledAt: Date }[]>`
        SELECT CURRENT_TIMESTAMP AS "disabledAt"
      `;
      return row!.disabledAt;
    });
    const usageFirstResults = await Promise.allSettled([usageWrite, laterDisable]);
    expect(usageFirstResults.map((result) => result.status)).toEqual(["fulfilled", "fulfilled"]);
    const usageHistorical = await db.projectAssetUsage.findUniqueOrThrow({
      where: { id: usageFirst.usageId }
    });
    const usageDisabledAt =
      usageFirstResults[1]?.status === "fulfilled" ? usageFirstResults[1].value : new Date(0);
    expect(usageHistorical.createdAt.getTime()).toBeLessThanOrEqual(usageDisabledAt.getTime());

    const disableFirst = await createDisableRace("DISABLE-FIRST", true);
    let assetDisabled!: () => void;
    const assetDisabledBarrier = new Promise<void>((resolve) => (assetDisabled = resolve));
    const disableWrite = db.$transaction(async (transaction) => {
      await transactionTimeouts(transaction);
      await transaction.technicalAsset.update({
        where: { id: disableFirst.assetId },
        data: { status: "DISABLED", version: 2 }
      });
      await appendDisableEvent(transaction, {
        assetId: disableFirst.assetId,
        rndProjectId: ids.rndProject,
        eventId: `${disableFirst.assetId}-disabled-event`
      });
      const [row] = await transaction.$queryRaw<{ disabledAt: Date }[]>`
        SELECT CURRENT_TIMESTAMP AS "disabledAt"
      `;
      assetDisabled();
      await transaction.$queryRaw`SELECT 1 AS "waited" FROM pg_sleep(0.15)`;
      return row!.disabledAt;
    });
    await assetDisabledBarrier;
    const usageAfterDisable = db.$transaction(async (transaction) => {
      await transactionTimeouts(transaction);
      await transaction.projectAssetUsage.create({
        data: disableFirst.usageData(
          `${disableFirst.usageId}-blocked`,
          `${disableFirst.usageId}-blocked`
        )
      });
    });
    const derivationAfterDisable = db.$transaction(async (transaction) => {
      await transactionTimeouts(transaction);
      await transaction.projectAssetDerivation.create({
        data: {
          id: `asset-impact-disable-race-derivation-${suffix}`,
          projectId: ids.project,
          sourceReferenceId: disableFirst.referenceId,
          sourceUsageId: disableFirst.usageId,
          sourceTechnicalAssetId: disableFirst.assetId,
          sourceAssetReleaseId: disableFirst.releaseId,
          sourceAssetReleaseVersionId: disableFirst.releaseVersionId,
          sourceComponentSnapshotId: disableFirst.componentId,
          sourceReleaseRevision: 1,
          sourceSnapshotChecksum: checksum,
          sourceWatermark: disableFirst.watermark,
          targetControlledDocumentVersionId: ids.sourceDocumentVersion,
          targetFileId: ids.sourceFile,
          targetSourceFileSha256: checksum,
          targetType: "CONTROLLED_DOCUMENT_VERSION",
          targetDocumentVersion: 1,
          targetDocumentVersionStatus: "PUBLISHED",
          targetFileStatus: "AVAILABLE",
          targetBindingKey: `CONTROLLED_DOCUMENT_VERSION:${ids.sourceDocumentVersion}:-:${ids.sourceFile}:race`,
          reason: "停用提交后的并发派生应拒绝",
          createdById: ids.actor
        }
      });
    });
    const disableFirstResults = await Promise.allSettled([
      disableWrite,
      usageAfterDisable,
      derivationAfterDisable
    ]);
    expect(disableFirstResults[0]?.status).toBe("fulfilled");
    expect(disableFirstResults.slice(1).map((result) => result.status)).toEqual([
      "rejected",
      "rejected"
    ]);
    for (const result of disableFirstResults.slice(1)) {
      const message = result.status === "rejected" ? String(result.reason) : "";
      expect(message).toMatch(/23514/u);
      expect(message).not.toMatch(/40P01/u);
    }
    const disableCommittedAt =
      disableFirstResults[0]?.status === "fulfilled" ? disableFirstResults[0].value : new Date(0);
    const [forbidden] = await db.$queryRaw<
      {
        referencesAfterRecall: bigint;
        usagesAfterDisable: bigint;
        derivationsAfterDisable: bigint;
      }[]
    >`
      SELECT
        (
          SELECT count(*) FROM "project_asset_references" reference
          JOIN "asset_release_recall_affected_versions" affected
            ON affected."asset_release_version_id" = reference."asset_release_version_id"
          JOIN "asset_release_recalls" recall ON recall."id" = affected."recall_id"
          JOIN "asset_release_recall_revisions" revision ON revision."id" = recall."current_revision_id"
          WHERE recall."current_state" = 'ACTIVE' AND reference."created_at" > revision."effective_at"
        ) AS "referencesAfterRecall",
        (
          SELECT count(*) FROM "project_asset_usages"
          WHERE "technical_asset_id" = ${disableFirst.assetId} AND "created_at" > ${disableCommittedAt}
        ) AS "usagesAfterDisable",
        (
          SELECT count(*) FROM "project_asset_derivations"
          WHERE "source_technical_asset_id" = ${disableFirst.assetId} AND "created_at" > ${disableCommittedAt}
        ) AS "derivationsAfterDisable"
    `;
    expect(forbidden).toEqual({
      referencesAfterRecall: 0n,
      usagesAfterDisable: 0n,
      derivationsAfterDisable: 0n
    });
  });

  it("serializes impact refresh and disposition races in both lock orders without stale append facts", async () => {
    const refresh = async (
      fixture: Awaited<ReturnType<typeof createOpenImpact>>,
      signal?: () => void
    ) => {
      const assessmentId = `${fixture.prefix}-assessment-2`;
      const dispositionId = `${fixture.prefix}-refresh-disposition`;
      await db.$transaction(async (transaction) => {
        await transactionTimeouts(transaction);
        await transaction.assetImpactAssessmentRevision.create({
          data: {
            id: assessmentId,
            impactId: fixture.impactId,
            projectId: fixture.projectId,
            technicalAssetId: ids.recallAsset,
            sequence: 2,
            kind: "REFRESH",
            ...recallAssessmentSource({
              recallId: ids.recall,
              recallRevisionId: ids.recallRevision,
              recallRevisionNumber: 1,
              recallRevisionSnapshotChecksum: "c".repeat(64),
              recallRevisionKind: "ISSUED",
              recallRevisionState: "ACTIVE",
              projectFactsWatermark: `${fixture.prefix}-project-facts-2`
            }),
            snapshotChecksum: "9".repeat(64),
            frozenAt: new Date(0),
            actorId: ids.actor,
            actorMembershipId: fixture.membershipId,
            actorMembershipSnapshotJson: fixture.ownerSnapshot,
            ownerMembershipId: fixture.membershipId,
            ownerMembershipSnapshotJson: fixture.ownerSnapshot,
            dueAt: fixture.dueAt
          }
        });
        signal?.();
        if (signal) {
          await transaction.$queryRaw`SELECT 1 AS "waited" FROM pg_sleep(0.15)`;
        }
        await applyImpactDisposition(transaction, {
          fixture,
          id: dispositionId,
          assessmentRevisionId: assessmentId,
          sequence: 1,
          type: "REFRESHED",
          fromStatus: "OPEN",
          toStatus: "OPEN",
          nextVersion: 2
        });
      });
      return { assessmentId, dispositionId };
    };
    const acknowledge = async (
      fixture: Awaited<ReturnType<typeof createOpenImpact>>,
      signal?: () => void
    ) => {
      const dispositionId = `${fixture.prefix}-acknowledge-disposition`;
      await db.$transaction(async (transaction) => {
        await transactionTimeouts(transaction);
        await applyImpactDisposition(transaction, {
          fixture,
          id: dispositionId,
          assessmentRevisionId: fixture.assessmentId,
          sequence: 1,
          type: "ACKNOWLEDGED",
          fromStatus: "OPEN",
          toStatus: "ACKNOWLEDGED",
          nextVersion: 2
        });
        signal?.();
        if (signal) {
          await transaction.$queryRaw`SELECT 1 AS "waited" FROM pg_sleep(0.15)`;
        }
      });
      return { dispositionId };
    };
    const expectSerializedFailure = (result: PromiseSettledResult<unknown>) => {
      expect(result.status).toBe("rejected");
      const message = result.status === "rejected" ? String(result.reason) : "";
      expect(message).toMatch(/23514|40001/u);
      expect(message).not.toMatch(/40P01/u);
    };

    const refreshFirst = await createOpenImpact("refresh-first");
    let refreshLocked!: () => void;
    const refreshLockedBarrier = new Promise<void>((resolve) => (refreshLocked = resolve));
    const refreshWinner = refresh(refreshFirst, refreshLocked);
    await refreshLockedBarrier;
    const staleAcknowledge = acknowledge(refreshFirst);
    const refreshFirstResults = await Promise.allSettled([refreshWinner, staleAcknowledge]);
    expect(refreshFirstResults[0]?.status).toBe("fulfilled");
    expectSerializedFailure(refreshFirstResults[1]!);
    const refreshFacts = await db.assetProjectImpact.findUniqueOrThrow({
      where: { id: refreshFirst.impactId },
      include: { assessmentRevisions: true, dispositions: true }
    });
    expect(refreshFacts).toMatchObject({
      status: "OPEN",
      version: 2,
      currentAssessmentRevisionId: `${refreshFirst.prefix}-assessment-2`
    });
    expect(refreshFacts.assessmentRevisions).toHaveLength(2);
    expect(refreshFacts.dispositions).toHaveLength(1);
    expect(refreshFacts.dispositions[0]).toMatchObject({ type: "REFRESHED", toStatus: "OPEN" });
    await expect(
      db.assetImpactDisposition.count({
        where: { id: `${refreshFirst.prefix}-acknowledge-disposition` }
      })
    ).resolves.toBe(0);

    const dispositionFirst = await createOpenImpact("disposition-first");
    let dispositionLocked!: () => void;
    const dispositionLockedBarrier = new Promise<void>((resolve) => (dispositionLocked = resolve));
    const dispositionWinner = acknowledge(dispositionFirst, dispositionLocked);
    await dispositionLockedBarrier;
    const staleRefresh = refresh(dispositionFirst);
    const dispositionFirstResults = await Promise.allSettled([dispositionWinner, staleRefresh]);
    expect(dispositionFirstResults[0]?.status).toBe("fulfilled");
    expectSerializedFailure(dispositionFirstResults[1]!);
    const dispositionFacts = await db.assetProjectImpact.findUniqueOrThrow({
      where: { id: dispositionFirst.impactId },
      include: { assessmentRevisions: true, dispositions: true }
    });
    expect(dispositionFacts).toMatchObject({
      status: "ACKNOWLEDGED",
      version: 2,
      currentAssessmentRevisionId: dispositionFirst.assessmentId
    });
    expect(dispositionFacts.assessmentRevisions).toHaveLength(1);
    expect(dispositionFacts.dispositions).toHaveLength(1);
    expect(dispositionFacts.dispositions[0]).toMatchObject({
      type: "ACKNOWLEDGED",
      toStatus: "ACKNOWLEDGED"
    });
    await expect(
      db.assetImpactAssessmentRevision.count({
        where: { id: `${dispositionFirst.prefix}-assessment-2` }
      })
    ).resolves.toBe(0);
    await expect(
      db.assetImpactDisposition.count({
        where: { id: `${dispositionFirst.prefix}-refresh-disposition` }
      })
    ).resolves.toBe(0);
  });

  it("commits exactly one complete risk decision when approval and rejection race", async () => {
    const fixture = await createOpenImpact("risk-decision");
    await db.$transaction(async (transaction) => {
      await applyImpactDisposition(transaction, {
        fixture,
        id: `${fixture.prefix}-acknowledge-disposition`,
        assessmentRevisionId: fixture.assessmentId,
        sequence: 1,
        type: "ACKNOWLEDGED",
        fromStatus: "OPEN",
        toStatus: "ACKNOWLEDGED",
        nextVersion: 2
      });
    });
    await db.$transaction(async (transaction) => {
      await applyImpactDisposition(transaction, {
        fixture,
        id: `${fixture.prefix}-assessing-disposition`,
        assessmentRevisionId: fixture.assessmentId,
        sequence: 2,
        type: "ASSESSING",
        fromStatus: "ACKNOWLEDGED",
        toStatus: "ASSESSING",
        nextVersion: 3
      });
    });

    const approvers = [
      {
        label: "approval",
        decision: "APPROVED" as const,
        role: "QUALITY" as const,
        userId: `${fixture.prefix}-quality-user`,
        membershipId: `${fixture.prefix}-quality-membership`
      },
      {
        label: "rejection",
        decision: "REJECTED" as const,
        role: "DEPARTMENT_LEAD" as const,
        userId: `${fixture.prefix}-lead-user`,
        membershipId: `${fixture.prefix}-lead-membership`
      }
    ];
    await db.user.createMany({
      data: approvers.map((approver) => ({
        id: approver.userId,
        employeeNo: `RISK-${approver.label}-${suffix}`.toUpperCase(),
        name: `风险接受 ${approver.label} 审批人`
      }))
    });
    await db.projectMember.createMany({
      data: approvers.map((approver) => ({
        id: approver.membershipId,
        projectId: fixture.projectId,
        userId: approver.userId,
        projectRole: approver.role,
        assignedById: ids.actor
      }))
    });

    const requestId = `${fixture.prefix}-request`;
    await db.$transaction(async (transaction) => {
      await transaction.assetImpactRiskAcceptanceRequest.create({
        data: {
          id: requestId,
          impactId: fixture.impactId,
          projectId: fixture.projectId,
          technicalAssetId: ids.recallAsset,
          requestedById: ids.actor,
          requestedMembershipId: fixture.membershipId,
          requestedMembershipSnapshotJson: fixture.ownerSnapshot,
          sourceActorId: ids.actor,
          sourceActorSnapshotJson: { actorId: ids.actor },
          evidenceJson: { basis: "risk-review-request" },
          reason: "申请独立角色确认风险接受",
          requestedAt: new Date(0)
        }
      });
      await applyImpactDisposition(transaction, {
        fixture,
        id: `${fixture.prefix}-request-disposition`,
        assessmentRevisionId: fixture.assessmentId,
        sequence: 3,
        type: "RISK_ACCEPTANCE_REQUESTED",
        fromStatus: "ASSESSING",
        toStatus: "RISK_ACCEPTANCE_PENDING",
        nextVersion: 4,
        riskAcceptanceRequestId: requestId
      });
    });

    const decide = async (approver: (typeof approvers)[number], signal?: () => void) => {
      const decisionId = `${fixture.prefix}-${approver.label}-decision`;
      const dispositionId = `${fixture.prefix}-${approver.label}-disposition`;
      const membershipSnapshot = {
        membershipId: approver.membershipId,
        userId: approver.userId,
        projectRole: approver.role
      };
      await db.$transaction(async (transaction) => {
        await transactionTimeouts(transaction);
        await transaction.assetImpactRiskAcceptanceDecision.create({
          data: {
            id: decisionId,
            requestId,
            impactId: fixture.impactId,
            projectId: fixture.projectId,
            technicalAssetId: ids.recallAsset,
            decision: approver.decision,
            actorId: approver.userId,
            actorMembershipId: approver.membershipId,
            actorMembershipSnapshotJson: membershipSnapshot,
            evidenceJson: { basis: `${approver.decision.toLowerCase()}-decision` },
            reason: `${approver.decision} risk acceptance`,
            decidedAt: new Date(0)
          }
        });
        signal?.();
        if (signal) {
          await transaction.$queryRaw`SELECT 1 AS "waited" FROM pg_sleep(0.15)`;
        }
        await transaction.assetImpactRiskAcceptanceRequest.update({
          where: { id: requestId },
          data: { status: approver.decision, version: 2 }
        });
        await applyImpactDisposition(transaction, {
          fixture,
          id: dispositionId,
          assessmentRevisionId: fixture.assessmentId,
          sequence: 4,
          type:
            approver.decision === "APPROVED"
              ? "RISK_ACCEPTANCE_APPROVED"
              : "RISK_ACCEPTANCE_REJECTED",
          fromStatus: "RISK_ACCEPTANCE_PENDING",
          toStatus: approver.decision === "APPROVED" ? "ACCEPTED_RISK" : "ASSESSING",
          nextVersion: 5,
          actorId: approver.userId,
          actorMembershipId: approver.membershipId,
          actorMembershipSnapshotJson: membershipSnapshot,
          riskAcceptanceRequestId: requestId,
          riskAcceptanceDecisionId: decisionId
        });
      });
      return { decisionId, dispositionId };
    };

    let approvalLocked!: () => void;
    const approvalLockedBarrier = new Promise<void>((resolve) => (approvalLocked = resolve));
    const approval = decide(approvers[0]!, approvalLocked);
    await approvalLockedBarrier;
    const rejection = decide(approvers[1]!);
    const results = await Promise.allSettled([approval, rejection]);
    expect(results[0]?.status).toBe("fulfilled");
    expect(results[1]?.status).toBe("rejected");
    const rejectionMessage = results[1]?.status === "rejected" ? String(results[1].reason) : "";
    expect(rejectionMessage).toMatch(/23505|23514|40001/u);
    expect(rejectionMessage).not.toMatch(/40P01/u);

    await expect(
      db.assetImpactRiskAcceptanceRequest.findUniqueOrThrow({ where: { id: requestId } })
    ).resolves.toMatchObject({ status: "APPROVED", version: 2 });
    await expect(
      db.assetProjectImpact.findUniqueOrThrow({ where: { id: fixture.impactId } })
    ).resolves.toMatchObject({
      status: "ACCEPTED_RISK",
      version: 5,
      currentAssessmentRevisionId: fixture.assessmentId
    });
    await expect(
      db.assetImpactRiskAcceptanceDecision.findMany({ where: { requestId } })
    ).resolves.toMatchObject([
      {
        id: `${fixture.prefix}-approval-decision`,
        decision: "APPROVED",
        actorId: approvers[0]!.userId
      }
    ]);
    await expect(
      db.assetImpactDisposition.findMany({
        where: { riskAcceptanceRequestId: requestId, riskAcceptanceDecisionId: { not: null } }
      })
    ).resolves.toMatchObject([
      {
        id: `${fixture.prefix}-approval-disposition`,
        type: "RISK_ACCEPTANCE_APPROVED",
        fromStatus: "RISK_ACCEPTANCE_PENDING",
        toStatus: "ACCEPTED_RISK",
        riskAcceptanceDecisionId: `${fixture.prefix}-approval-decision`
      }
    ]);
    await expect(
      db.assetImpactRiskAcceptanceDecision.count({
        where: { id: `${fixture.prefix}-rejection-decision` }
      })
    ).resolves.toBe(0);
    await expect(
      db.assetImpactDisposition.count({
        where: { id: `${fixture.prefix}-rejection-disposition` }
      })
    ).resolves.toBe(0);
  });

  it("allows only the exact controlled risk request decision update", async () => {
    const approve = async (
      label: string,
      requestMutation: Prisma.AssetImpactRiskAcceptanceRequestUpdateInput = {}
    ) => {
      const fixture = await createOpenImpact(`risk-request-immutable-${label}`);
      for (const [sequence, type, fromStatus, toStatus, nextVersion] of [
        [1, "ACKNOWLEDGED", "OPEN", "ACKNOWLEDGED", 2],
        [2, "ASSESSING", "ACKNOWLEDGED", "ASSESSING", 3]
      ] as const) {
        await db.$transaction((transaction) =>
          applyImpactDisposition(transaction, {
            fixture,
            id: `${fixture.prefix}-${type.toLowerCase()}-disposition`,
            assessmentRevisionId: fixture.assessmentId,
            sequence,
            type,
            fromStatus,
            toStatus,
            nextVersion
          })
        );
      }
      const approverId = `${fixture.prefix}-quality-user`;
      const approverMembershipId = `${fixture.prefix}-quality-membership`;
      await db.user.create({
        data: {
          id: approverId,
          employeeNo: `RISK-IMMUTABLE-${label}-${suffix}`.toUpperCase(),
          name: `风险事实保护 ${label}`
        }
      });
      await db.projectMember.create({
        data: {
          id: approverMembershipId,
          projectId: fixture.projectId,
          userId: approverId,
          projectRole: "QUALITY",
          assignedById: ids.actor
        }
      });
      const requestId = `${fixture.prefix}-request`;
      await db.$transaction(async (transaction) => {
        await transaction.assetImpactRiskAcceptanceRequest.create({
          data: {
            id: requestId,
            impactId: fixture.impactId,
            projectId: fixture.projectId,
            technicalAssetId: ids.recallAsset,
            requestedById: ids.actor,
            requestedMembershipId: fixture.membershipId,
            requestedMembershipSnapshotJson: fixture.ownerSnapshot,
            sourceActorId: ids.actor,
            sourceActorSnapshotJson: { actorId: ids.actor },
            evidenceJson: { basis: "immutable-request" },
            reason: "请求独立风险审批",
            requestedAt: new Date(0)
          }
        });
        await applyImpactDisposition(transaction, {
          fixture,
          id: `${fixture.prefix}-request-disposition`,
          assessmentRevisionId: fixture.assessmentId,
          sequence: 3,
          type: "RISK_ACCEPTANCE_REQUESTED",
          fromStatus: "ASSESSING",
          toStatus: "RISK_ACCEPTANCE_PENDING",
          nextVersion: 4,
          riskAcceptanceRequestId: requestId
        });
      });
      const decisionId = `${fixture.prefix}-decision`;
      const approverSnapshot = {
        membershipId: approverMembershipId,
        userId: approverId,
        projectRole: "QUALITY"
      };
      await db.$transaction(async (transaction) => {
        await transaction.assetImpactRiskAcceptanceDecision.create({
          data: {
            id: decisionId,
            requestId,
            impactId: fixture.impactId,
            projectId: fixture.projectId,
            technicalAssetId: ids.recallAsset,
            decision: "APPROVED",
            actorId: approverId,
            actorMembershipId: approverMembershipId,
            actorMembershipSnapshotJson: approverSnapshot,
            evidenceJson: { basis: "independent-approval" },
            reason: "独立审批通过",
            decidedAt: new Date(0)
          }
        });
        await transaction.assetImpactRiskAcceptanceRequest.update({
          where: { id: requestId },
          data: { status: "APPROVED", version: 2, ...requestMutation }
        });
        await applyImpactDisposition(transaction, {
          fixture,
          id: `${fixture.prefix}-approval-disposition`,
          assessmentRevisionId: fixture.assessmentId,
          sequence: 4,
          type: "RISK_ACCEPTANCE_APPROVED",
          fromStatus: "RISK_ACCEPTANCE_PENDING",
          toStatus: "ACCEPTED_RISK",
          nextVersion: 5,
          actorId: approverId,
          actorMembershipId: approverMembershipId,
          actorMembershipSnapshotJson: approverSnapshot,
          riskAcceptanceRequestId: requestId,
          riskAcceptanceDecisionId: decisionId
        });
      });
      return { fixture, requestId };
    };

    await expect(approve("id", { id: `tampered-request-id-${suffix}` })).rejects.toThrow(
      /23503|23514|55000|append-only|risk acceptance request only supports/u
    );
    await expect(
      approve("requestor-snapshot", {
        requestedMembershipSnapshotJson: { membershipId: "tampered" }
      })
    ).rejects.toThrow(/23514|risk acceptance request only supports/u);
    await expect(
      approve("source-snapshot", { sourceActorSnapshotJson: { actorId: "tampered" } })
    ).rejects.toThrow(/23514|risk acceptance request only supports/u);

    const accepted = await approve("controlled");
    await expect(
      db.assetImpactRiskAcceptanceRequest.findUniqueOrThrow({ where: { id: accepted.requestId } })
    ).resolves.toMatchObject({ status: "APPROVED", version: 2 });
    await expect(
      db.assetProjectImpact.findUniqueOrThrow({ where: { id: accepted.fixture.impactId } })
    ).resolves.toMatchObject({ status: "ACCEPTED_RISK", version: 5 });
  });

  it("executes risk request, independent decisions, detail discovery and closure through the service", async () => {
    const assessingImpact = async (label: string) => {
      const fixture = await createProjectImpactProjectionFixture(`risk-service-${label}`);
      const impactId = (await projectAssetImpactsFromSourceEvent(fixture.event)).items[0]!.impactId;
      for (const [action, version] of [
        ["ACKNOWLEDGE", 1],
        ["START_ASSESSMENT", 2]
      ] as const) {
        await recordProjectAssetImpactDisposition({
          projectId: fixture.projectId,
          impactId,
          action,
          version,
          reason: `风险接受服务推进 ${action}`,
          evidence: { action },
          actorId: ids.actor,
          authorizationActor,
          auditContext: auditContext(`${fixture.prefix}-${action.toLowerCase()}`)
        });
      }
      return { ...fixture, impactId };
    };
    const independent = async (
      fixture: Awaited<ReturnType<typeof assessingImpact>>,
      label: string
    ) => {
      const actorId = `${fixture.prefix}-${label}-user`;
      const membershipId = `${fixture.prefix}-${label}-membership`;
      const role = label === "quality" ? ("QUALITY" as const) : ("DEPARTMENT_LEAD" as const);
      await db.user.create({
        data: {
          id: actorId,
          employeeNo: `RISK-SERVICE-${fixture.prefix}-${label}`.toUpperCase(),
          name: `风险服务 ${label}`
        }
      });
      await db.projectMember.create({
        data: {
          id: membershipId,
          projectId: fixture.projectId,
          userId: actorId,
          projectRole: role,
          assignedById: ids.actor
        }
      });
      return {
        actorId,
        authorizationActor: {
          id: actorId,
          name: `风险服务 ${label}`,
          status: "ACTIVE" as const,
          departmentId: null,
          systemRoles: [role],
          grants: []
        }
      };
    };
    const request = async (fixture: Awaited<ReturnType<typeof assessingImpact>>, label: string) =>
      requestProjectAssetImpactRiskAcceptance({
        projectId: fixture.projectId,
        impactId: fixture.impactId,
        version: 3,
        reason: `申请风险接受 ${label}`,
        evidence: { riskRegisterId: `${fixture.prefix}-risk-register` },
        actorId: ids.actor,
        authorizationActor,
        auditContext: auditContext(`${fixture.prefix}-request`)
      });

    const approvedFixture = await assessingImpact("approve");
    const quality = await independent(approvedFixture, "quality");
    const requested = await request(approvedFixture, "approve");
    expect(requested).toMatchObject({
      impact: { status: "RISK_ACCEPTANCE_PENDING", resourceVersion: 4 },
      riskAcceptanceRequest: { status: "PENDING", resourceVersion: 1 },
      allowedActions: []
    });
    const detail = await getProjectAssetImpact({
      projectId: approvedFixture.projectId,
      impactId: approvedFixture.impactId,
      actorId: quality.actorId,
      authorizationActor: quality.authorizationActor,
      canManage: true,
      auditContext: {
        ...auditContext(`${approvedFixture.prefix}-detail`),
        actorId: quality.actorId
      }
    });
    expect(detail).toMatchObject({
      item: {
        currentRiskAcceptanceRequest: {
          requestId: requested.riskAcceptanceRequest.id,
          status: "PENDING",
          resourceVersion: 1,
          decision: null
        },
        allowedActions: ["APPROVE_RISK", "REJECT_RISK"]
      },
      allowedActions: ["APPROVE_RISK", "REJECT_RISK"]
    });
    const approved = await decideProjectAssetImpactRiskAcceptance({
      projectId: approvedFixture.projectId,
      impactId: approvedFixture.impactId,
      requestId: requested.riskAcceptanceRequest.id,
      version: 1,
      decision: "APPROVE",
      reason: "独立质量批准风险接受",
      evidence: { approvalRecordId: `${approvedFixture.prefix}-approval` },
      actorId: quality.actorId,
      authorizationActor: quality.authorizationActor,
      auditContext: {
        ...auditContext(`${approvedFixture.prefix}-approve`),
        actorId: quality.actorId
      }
    });
    expect(approved).toMatchObject({
      impact: { status: "ACCEPTED_RISK", resourceVersion: 5 },
      riskAcceptanceRequest: { status: "APPROVED", resourceVersion: 2 },
      riskAcceptanceDecision: { decision: "APPROVED", actorId: quality.actorId }
    });
    const closed = await closeProjectAssetImpact({
      projectId: approvedFixture.projectId,
      impactId: approvedFixture.impactId,
      version: 5,
      reason: "经独立审批后关闭风险",
      evidence: { closureRecordId: `${approvedFixture.prefix}-closure` },
      actorId: ids.actor,
      authorizationActor,
      auditContext: auditContext(`${approvedFixture.prefix}-close`)
    });
    expect(closed).toMatchObject({
      impact: { status: "CLOSED", resourceVersion: 6 },
      allowedActions: []
    });

    const rejectedFixture = await assessingImpact("reject");
    const lead = await independent(rejectedFixture, "lead");
    const rejectionRequest = await request(rejectedFixture, "reject");
    const rejected = await decideProjectAssetImpactRiskAcceptance({
      projectId: rejectedFixture.projectId,
      impactId: rejectedFixture.impactId,
      requestId: rejectionRequest.riskAcceptanceRequest.id,
      version: 1,
      decision: "REJECT",
      reason: "独立负责人拒绝风险接受",
      evidence: { rejectionRecordId: `${rejectedFixture.prefix}-rejection` },
      actorId: lead.actorId,
      authorizationActor: lead.authorizationActor,
      auditContext: { ...auditContext(`${rejectedFixture.prefix}-reject`), actorId: lead.actorId }
    });
    expect(rejected).toMatchObject({
      impact: { status: "ASSESSING", resourceVersion: 5 },
      riskAcceptanceRequest: { status: "REJECTED", resourceVersion: 2 },
      riskAcceptanceDecision: { decision: "REJECTED", actorId: lead.actorId }
    });

    const raceFixture = await assessingImpact("race");
    const raceQuality = await independent(raceFixture, "quality");
    const raceLead = await independent(raceFixture, "lead");
    const raceRequest = await request(raceFixture, "race");
    const decide = (actor: typeof raceQuality, decision: "APPROVE" | "REJECT", label: string) =>
      decideProjectAssetImpactRiskAcceptance({
        projectId: raceFixture.projectId,
        impactId: raceFixture.impactId,
        requestId: raceRequest.riskAcceptanceRequest.id,
        version: 1,
        decision,
        reason: `并发 ${label} 风险接受`,
        evidence: { decisionRecordId: `${raceFixture.prefix}-${label}` },
        actorId: actor.actorId,
        authorizationActor: actor.authorizationActor,
        auditContext: {
          ...auditContext(`${raceFixture.prefix}-${label}`),
          actorId: actor.actorId
        }
      });
    const raceResults = await Promise.allSettled([
      decide(raceQuality, "APPROVE", "approve"),
      decide(raceLead, "REJECT", "reject")
    ]);
    expect(raceResults.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    expect(raceResults.filter(({ status }) => status === "rejected")).toHaveLength(1);
    expect(raceResults.find(({ status }) => status === "rejected")).toMatchObject({
      reason: { code: "ASSET_RISK_ACCEPTANCE_VERSION_CONFLICT", status: 409 }
    });
    await expect(
      db.assetImpactRiskAcceptanceDecision.count({
        where: { requestId: raceRequest.riskAcceptanceRequest.id }
      })
    ).resolves.toBe(1);
    await expect(
      db.assetImpactDisposition.count({
        where: {
          riskAcceptanceRequestId: raceRequest.riskAcceptanceRequest.id,
          riskAcceptanceDecisionId: { not: null }
        }
      })
    ).resolves.toBe(1);
    await expect(
      db.auditLog.count({
        where: {
          objectType: "ASSET_IMPACT_RISK_ACCEPTANCE_DECISION",
          projectId: raceFixture.projectId,
          result: "SUCCESS"
        }
      })
    ).resolves.toBe(1);
    await expect(
      db.outboxEvent.count({
        where: {
          aggregateId: raceFixture.impactId,
          eventType: "asset.impact.risk-acceptance.decided"
        }
      })
    ).resolves.toBe(1);
  });

  it("default-denies non-independent, stale and cross-project risk decisions without partial writes", async () => {
    const sourceFixture = await createProjectImpactProjectionFixture("risk-service-denied");
    const impactId = (await projectAssetImpactsFromSourceEvent(sourceFixture.event)).items[0]!
      .impactId;
    const fixture = { ...sourceFixture, impactId };
    for (const [action, version] of [
      ["ACKNOWLEDGE", 1],
      ["START_ASSESSMENT", 2]
    ] as const) {
      await recordProjectAssetImpactDisposition({
        projectId: fixture.projectId,
        impactId: fixture.impactId,
        action,
        version,
        reason: `风险拒绝服务推进 ${action}`,
        evidence: { action },
        actorId: ids.actor,
        authorizationActor,
        auditContext: auditContext(`${fixture.prefix}-${action.toLowerCase()}`)
      });
    }
    const requested = await requestProjectAssetImpactRiskAcceptance({
      projectId: fixture.projectId,
      impactId: fixture.impactId,
      version: 3,
      reason: "申请独立风险判断",
      evidence: { riskRegisterId: `${fixture.prefix}-risk-register` },
      actorId: ids.actor,
      authorizationActor,
      auditContext: auditContext(`${fixture.prefix}-request`)
    });
    const selfMembershipId = `${fixture.prefix}-self-quality-membership`;
    await db.projectMember.create({
      data: {
        id: selfMembershipId,
        projectId: fixture.projectId,
        userId: ids.actor,
        projectRole: "QUALITY",
        assignedById: ids.actor
      }
    });
    const decisionInput = {
      projectId: fixture.projectId,
      impactId: fixture.impactId,
      requestId: requested.riskAcceptanceRequest.id,
      version: 1,
      decision: "APPROVE" as const,
      reason: "不允许的自审批",
      evidence: { approvalRecordId: `${fixture.prefix}-self` },
      actorId: ids.actor,
      authorizationActor,
      auditContext: auditContext(`${fixture.prefix}-self-approve`)
    };
    const before = await Promise.all([
      db.assetImpactRiskAcceptanceDecision.count({ where: { requestId: decisionInput.requestId } }),
      db.assetImpactDisposition.count({
        where: { riskAcceptanceRequestId: decisionInput.requestId }
      }),
      db.auditLog.count({ where: { operationId: decisionInput.auditContext.operationId } }),
      db.outboxEvent.count({ where: { aggregateId: fixture.impactId } })
    ]);
    await expect(decideProjectAssetImpactRiskAcceptance(decisionInput)).rejects.toMatchObject({
      code: "ASSET_RISK_APPROVAL_INDEPENDENCE_REQUIRED",
      status: 403
    });
    await expect(
      decideProjectAssetImpactRiskAcceptance({ ...decisionInput, version: 2 })
    ).rejects.toMatchObject({ code: "ASSET_RISK_ACCEPTANCE_VERSION_CONFLICT", status: 409 });
    await expect(
      decideProjectAssetImpactRiskAcceptance({
        ...decisionInput,
        projectId: ids.project,
        auditContext: auditContext(`${fixture.prefix}-cross-project`)
      })
    ).rejects.toMatchObject({ code: "ASSET_RISK_ACCEPTANCE_REQUEST_NOT_FOUND", status: 404 });
    await expect(
      Promise.all([
        db.assetImpactRiskAcceptanceDecision.count({
          where: { requestId: decisionInput.requestId }
        }),
        db.assetImpactDisposition.count({
          where: { riskAcceptanceRequestId: decisionInput.requestId }
        }),
        db.auditLog.count({ where: { operationId: decisionInput.auditContext.operationId } }),
        db.outboxEvent.count({ where: { aggregateId: fixture.impactId } })
      ])
    ).resolves.toEqual(before);
  });

  it("serializes reverse-pair candidate inserts by exact release and version id order", async () => {
    const prefix = `asset-impact-candidate-race-${suffix}`;
    const oldCode = `REL-CANDIDATE-OLD-${suffix}`.toUpperCase();
    const newCode = `REL-CANDIDATE-NEW-${suffix}`.toUpperCase();
    const oldRelease = await createPublishedReleaseVersion({ releaseCode: oldCode, revision: 1 });
    const newRelease = await createPublishedReleaseVersion({ releaseCode: newCode, revision: 1 });
    const candidateData = (
      id: string,
      source: typeof oldRelease,
      sourceCode: string,
      target: typeof oldRelease,
      targetCode: string
    ) => ({
      id,
      technicalAssetId: ids.recallAsset,
      sourceAssetReleaseId: source.releaseId,
      sourceAssetReleaseVersionId: source.releaseVersionId,
      sourceRevision: 1,
      sourceSnapshotChecksum: checksum,
      sourceWatermark: `watermark-${sourceCode}`,
      targetAssetReleaseId: target.releaseId,
      targetAssetReleaseVersionId: target.releaseVersionId,
      targetRevision: 1,
      targetSnapshotChecksum: checksum,
      targetWatermark: `watermark-${targetCode}`,
      compatibilitySnapshotJson: {},
      compatibilitySnapshotChecksum: "7".repeat(64),
      createdById: ids.actor
    });
    const forwardId = `${prefix}-forward`;
    const reverseId = `${prefix}-reverse`;
    let forwardInserted!: () => void;
    const forwardInsertedBarrier = new Promise<void>((resolve) => (forwardInserted = resolve));
    const forward = db.$transaction(async (transaction) => {
      await transactionTimeouts(transaction);
      await transaction.assetUpgradeCandidate.create({
        data: candidateData(forwardId, oldRelease, oldCode, newRelease, newCode)
      });
      forwardInserted();
      await transaction.$queryRaw`SELECT 1 AS "waited" FROM pg_sleep(0.15)`;
    });
    await forwardInsertedBarrier;
    const reverse = db.$transaction(async (transaction) => {
      await transactionTimeouts(transaction);
      await transaction.assetUpgradeCandidate.create({
        data: candidateData(reverseId, newRelease, newCode, oldRelease, oldCode)
      });
    });
    const results = await Promise.allSettled([forward, reverse]);
    expect(results.map((result) => result.status)).toEqual(["fulfilled", "fulfilled"]);
    for (const result of results) {
      const message = result.status === "rejected" ? String(result.reason) : "";
      expect(message).not.toMatch(/40P01/u);
    }
    await expect(
      db.assetUpgradeCandidate.findMany({
        where: { id: { in: [forwardId, reverseId] } },
        orderBy: { id: "asc" }
      })
    ).resolves.toMatchObject([
      {
        id: forwardId,
        sourceAssetReleaseVersionId: oldRelease.releaseVersionId,
        targetAssetReleaseVersionId: newRelease.releaseVersionId
      },
      {
        id: reverseId,
        sourceAssetReleaseVersionId: newRelease.releaseVersionId,
        targetAssetReleaseVersionId: oldRelease.releaseVersionId
      }
    ]);
  });

  it("serializes adoption against target recall and impact refresh without deadlocks", async () => {
    const adoptionFirst = await createServiceAdoptionFixture("adoption-lock-first");
    let adoptionLocked!: () => void;
    const adoptionBarrier = new Promise<void>((resolve) => (adoptionLocked = resolve));
    const adoptionWrite = db.$transaction(async (transaction) => {
      await transactionTimeouts(transaction);
      await transaction.$queryRaw`SELECT "id" FROM "projects" WHERE "id" = ${adoptionFirst.fixture.projectId} FOR UPDATE`;
      await transaction.$queryRaw`SELECT "id" FROM "rnd_projects" WHERE "id" = ${ids.rndProject} FOR UPDATE`;
      await transaction.$queryRaw`SELECT "id" FROM "technical_assets" WHERE "id" = ${ids.recallAsset} FOR UPDATE`;
      adoptionLocked();
      await transaction.$queryRaw`SELECT 1 AS "waited" FROM pg_sleep(0.15)`;
      return adoptProjectAssetUpgrade(adoptionFirst.adoptionInput, transaction);
    });
    await adoptionBarrier;
    const laterRecall = createAssetReleaseRecall(adoptionFirst.recallInput);
    const laterRefresh = refreshProjectAssetImpact({
      projectId: adoptionFirst.fixture.projectId,
      impactId: adoptionFirst.impact.impactId,
      version: 4,
      reason: "采用提交后的刷新必须稳定冲突",
      evidence: { race: "adoption-first" },
      actorId: ids.actor,
      authorizationActor,
      auditContext: auditContext(`${adoptionFirst.fixture.prefix}-refresh-race`)
    });
    const adoptionFirstResults = await Promise.allSettled([
      adoptionWrite,
      laterRecall,
      laterRefresh
    ]);
    expect(adoptionFirstResults.slice(0, 2).map((result) => result.status)).toEqual([
      "fulfilled",
      "fulfilled"
    ]);
    expect(adoptionFirstResults[2]).toMatchObject({
      status: "rejected",
      reason: { code: "ASSET_IMPACT_VERSION_CONFLICT", status: 409 }
    });
    for (const result of adoptionFirstResults) {
      if (result.status === "rejected") expect(String(result.reason)).not.toMatch(/40P01/u);
    }

    const recallFirst = await createServiceAdoptionFixture("recall-lock-first");
    let recallLocked!: () => void;
    const recallBarrier = new Promise<void>((resolve) => (recallLocked = resolve));
    const recallWrite = db.$transaction(async (transaction) => {
      await transactionTimeouts(transaction);
      await transaction.$queryRaw`SELECT "id" FROM "rnd_projects" WHERE "id" = ${ids.rndProject} FOR UPDATE`;
      await transaction.$queryRaw`SELECT "id" FROM "technical_assets" WHERE "id" = ${ids.recallAsset} FOR UPDATE`;
      recallLocked();
      await transaction.$queryRaw`SELECT 1 AS "waited" FROM pg_sleep(0.15)`;
      return createAssetReleaseRecall(recallFirst.recallInput, transaction);
    });
    await recallBarrier;
    const blockedAdoption = adoptProjectAssetUpgrade(recallFirst.adoptionInput);
    const recallFirstResults = await Promise.allSettled([recallWrite, blockedAdoption]);
    expect(recallFirstResults[0]?.status).toBe("fulfilled");
    expect(recallFirstResults[1]).toMatchObject({
      status: "rejected",
      reason: { code: "ASSET_UPGRADE_TARGET_ACTIVE_RECALL", status: 409 }
    });
    for (const result of recallFirstResults) {
      if (result.status === "rejected") expect(String(result.reason)).not.toMatch(/40P01/u);
    }
    await expect(
      db.assetUpgradeAdoption.count({
        where: {
          projectId: recallFirst.fixture.projectId,
          sourceReferenceId: recallFirst.adoptionInput.sourceReferenceId
        }
      })
    ).resolves.toBe(0);

    const refreshFirst = await createServiceAdoptionFixture("refresh-lock-first");
    await reviseAssetReleaseRecall({
      technicalAssetId: ids.recallAsset,
      recallId: refreshFirst.fixture.issued.recall.id,
      version: 1,
      kind: "CORRECTED",
      sourceAssetReleaseVersionId: refreshFirst.fixture.release.releaseVersionId,
      severity: "HIGH",
      reason: "并发刷新前修订召回事实",
      evidence: { race: "refresh-first" },
      actorId: ids.actor,
      authorizationActor,
      auditContext: auditContext(`${refreshFirst.fixture.prefix}-recall-correct`)
    });
    let refreshLocked!: () => void;
    const refreshBarrier = new Promise<void>((resolve) => (refreshLocked = resolve));
    const refreshWrite = db.$transaction(async (transaction) => {
      await transactionTimeouts(transaction);
      await transaction.$queryRaw`SELECT "id" FROM "projects" WHERE "id" = ${refreshFirst.fixture.projectId} FOR UPDATE`;
      await transaction.$queryRaw`SELECT "id" FROM "rnd_projects" WHERE "id" = ${ids.rndProject} FOR UPDATE`;
      await transaction.$queryRaw`SELECT "id" FROM "technical_assets" WHERE "id" = ${ids.recallAsset} FOR UPDATE`;
      refreshLocked();
      await transaction.$queryRaw`SELECT 1 AS "waited" FROM pg_sleep(0.15)`;
      return refreshProjectAssetImpact(
        {
          projectId: refreshFirst.fixture.projectId,
          impactId: refreshFirst.impact.impactId,
          version: 4,
          reason: "刷新先提交应使采用版本稳定冲突",
          evidence: { race: "refresh-first" },
          actorId: ids.actor,
          authorizationActor,
          auditContext: auditContext(`${refreshFirst.fixture.prefix}-refresh-first`)
        },
        transaction
      );
    });
    await refreshBarrier;
    const adoptionAfterRefresh = adoptProjectAssetUpgrade(refreshFirst.adoptionInput);
    const refreshFirstResults = await Promise.allSettled([refreshWrite, adoptionAfterRefresh]);
    expect(refreshFirstResults[0]?.status).toBe("fulfilled");
    expect(refreshFirstResults[1]).toMatchObject({
      status: "rejected",
      reason: { code: "ASSET_IMPACT_VERSION_CONFLICT", status: 409 }
    });
    for (const result of refreshFirstResults) {
      if (result.status === "rejected") expect(String(result.reason)).not.toMatch(/40P01/u);
    }
    await expect(
      db.assetUpgradeAdoption.count({
        where: {
          projectId: refreshFirst.fixture.projectId,
          sourceReferenceId: refreshFirst.adoptionInput.sourceReferenceId
        }
      })
    ).resolves.toBe(0);
  });

  it("serializes adoption against exact reference and source usage create or retire commands", async () => {
    const race = async <T>(
      first: (transaction: Prisma.TransactionClient, signal: () => void) => Promise<T>,
      second: () => Promise<unknown>
    ) => {
      let signaled!: () => void;
      const barrier = new Promise<void>((resolve) => (signaled = resolve));
      const firstWrite = db.$transaction(async (transaction) => {
        await transactionTimeouts(transaction);
        const result = await first(transaction, signaled);
        await transaction.$queryRaw`SELECT 1 AS "waited" FROM pg_sleep(0.15)`;
        return result;
      });
      await barrier;
      const results = await Promise.allSettled([firstWrite, second()]);
      for (const result of results) {
        if (result.status === "rejected") expect(String(result.reason)).not.toMatch(/40P01/u);
      }
      return results;
    };
    const createTargetReference = (
      fixture: Awaited<ReturnType<typeof createServiceAdoptionFixture>>,
      operation: string,
      transaction?: Prisma.TransactionClient
    ) =>
      createProjectAssetReference(
        {
          projectId: fixture.fixture.projectId,
          assetReleaseId: fixture.targetRelease.releaseId,
          assetReleaseVersionId: fixture.targetRelease.releaseVersionId,
          projectVersion: 1,
          actorId: ids.actor,
          reason: `并发 exact reference ${operation}`,
          authorizationActor,
          auditContext: auditContext(`${fixture.fixture.prefix}-${operation}`)
        },
        transaction
      );
    const createSourceUsage = (
      fixture: Awaited<ReturnType<typeof createWithdrawnServiceAdoptionFixture>>,
      operation: string,
      transaction?: Prisma.TransactionClient
    ) =>
      createProjectAssetUsage(
        {
          projectId: fixture.fixture.projectId,
          referenceId: fixture.adoptionInput.sourceReferenceId,
          referenceVersion: fixture.adoptionInput.sourceReferenceVersion,
          usageKey: `${fixture.fixture.prefix}-${operation}`,
          componentSnapshotId: fixture.fixture.component.id,
          quantity: "1",
          configuration: { purpose: `无 active recall 并发 usage ${operation}` },
          scopeType: "PROJECT",
          scopeId: fixture.fixture.projectId,
          actorId: ids.actor,
          reason: `无 active recall 并发 source usage ${operation}`,
          authorizationActor,
          auditContext: auditContext(`${fixture.fixture.prefix}-${operation}`)
        },
        transaction
      );
    const forbiddenRetiredReferenceActiveUsage = async (projectId: string) => {
      const [row] = await db.$queryRaw<Array<{ count: bigint }>>`
        SELECT count(*) AS "count"
          FROM "project_asset_references" reference
          JOIN "project_asset_usages" usage
            ON usage."reference_id" = reference."id"
           AND usage."project_id" = reference."project_id"
         WHERE reference."project_id" = ${projectId}
           AND reference."status" = 'RETIRED'
           AND usage."status" = 'ACTIVE'
      `;
      return Number(row?.count ?? 0n);
    };
    const adoptionFirstReference = await createServiceAdoptionFixture("adopt-first-reference");
    const adoptionFirstReferenceResults = await race(
      async (transaction, signal) => {
        const result = await adoptProjectAssetUpgrade(
          adoptionFirstReference.adoptionInput,
          transaction
        );
        signal();
        return result;
      },
      () => createTargetReference(adoptionFirstReference, "late-reference")
    );
    expect(adoptionFirstReferenceResults[0]?.status).toBe("fulfilled");
    expect(adoptionFirstReferenceResults[1]?.status).toBe("rejected");

    const referenceFirst = await createServiceAdoptionFixture("reference-first-adopt");
    const referenceFirstResults = await race(
      async (transaction, signal) => {
        const result = await createTargetReference(referenceFirst, "early-reference", transaction);
        signal();
        return result;
      },
      () => adoptProjectAssetUpgrade(referenceFirst.adoptionInput)
    );
    expect(referenceFirstResults[0]?.status).toBe("fulfilled");
    expect(referenceFirstResults[1]).toMatchObject({
      status: "rejected",
      reason: { code: "ASSET_UPGRADE_TARGET_ALREADY_REFERENCED", status: 409 }
    });
    await expect(
      db.assetUpgradeAdoption.count({
        where: {
          projectId: referenceFirst.fixture.projectId,
          sourceReferenceId: referenceFirst.adoptionInput.sourceReferenceId
        }
      })
    ).resolves.toBe(0);

    const adoptionFirstCreate = await createWithdrawnServiceAdoptionFixture(
      "adopt-first-usage-create"
    );
    const lateCreateOperation = "late-source-usage";
    const adoptionFirstCreateResults = await race(
      async (transaction, signal) => {
        const result = await adoptProjectAssetUpgrade(
          adoptionFirstCreate.adoptionInput,
          transaction
        );
        signal();
        return result;
      },
      () => createSourceUsage(adoptionFirstCreate, lateCreateOperation)
    );
    expect(adoptionFirstCreateResults[0]?.status).toBe("fulfilled");
    expect(adoptionFirstCreateResults[1]).toMatchObject({
      status: "rejected",
      reason: { code: "PROJECT_ASSET_VERSION_CONFLICT", status: 409 }
    });
    await expect(
      Promise.all([
        forbiddenRetiredReferenceActiveUsage(adoptionFirstCreate.fixture.projectId),
        db.projectAssetUsage.count({
          where: {
            projectId: adoptionFirstCreate.fixture.projectId,
            usageKey: `${adoptionFirstCreate.fixture.prefix}-${lateCreateOperation}`
          }
        }),
        db.auditLog.count({
          where: {
            operationId: `${adoptionFirstCreate.fixture.prefix}-${lateCreateOperation}`,
            result: "SUCCESS"
          }
        })
      ])
    ).resolves.toEqual([0, 0, 0]);

    const createFirstAdoption = await createWithdrawnServiceAdoptionFixture(
      "usage-create-first-adopt"
    );
    const adoptionOutboxBefore = await db.outboxEvent.count({
      where: { eventType: "project.asset-upgrade.adopted" }
    });
    const createFirstResults = await race(
      async (transaction, signal) => {
        const result = await createSourceUsage(
          createFirstAdoption,
          "early-source-usage",
          transaction
        );
        signal();
        return result;
      },
      () => adoptProjectAssetUpgrade(createFirstAdoption.adoptionInput)
    );
    expect(createFirstResults[0]?.status).toBe("fulfilled");
    expect(createFirstResults[1]).toMatchObject({
      status: "rejected",
      reason: { code: "ASSET_IMPACT_REFRESH_REQUIRED", status: 409 }
    });
    await expect(
      Promise.all([
        forbiddenRetiredReferenceActiveUsage(createFirstAdoption.fixture.projectId),
        db.assetUpgradeAdoption.count({
          where: {
            projectId: createFirstAdoption.fixture.projectId,
            sourceReferenceId: createFirstAdoption.adoptionInput.sourceReferenceId
          }
        }),
        db.projectAssetReference.count({
          where: {
            projectId: createFirstAdoption.fixture.projectId,
            assetReleaseVersionId: createFirstAdoption.targetRelease.releaseVersionId
          }
        }),
        db.auditLog.count({
          where: {
            operationId: createFirstAdoption.adoptionInput.auditContext.operationId,
            action: "ASSET_UPGRADE_ADOPTED",
            result: "SUCCESS"
          }
        }),
        db.outboxEvent.count({ where: { eventType: "project.asset-upgrade.adopted" } })
      ])
    ).resolves.toEqual([0, 0, 0, 0, adoptionOutboxBefore]);

    const adoptionFirstRetire = await createServiceAdoptionFixture("adopt-first-retire", {
      withUsage: true
    });
    const adoptionFirstRetireResults = await race(
      async (transaction, signal) => {
        const result = await adoptProjectAssetUpgrade(
          adoptionFirstRetire.adoptionInput,
          transaction
        );
        signal();
        return result;
      },
      () =>
        retireProjectAssetUsage({
          projectId: adoptionFirstRetire.fixture.projectId,
          usageId: adoptionFirstRetire.fixture.usage!.usage.id,
          version: 1,
          actorId: ids.actor,
          reason: "采用后并发退役",
          authorizationActor,
          auditContext: auditContext(`${adoptionFirstRetire.fixture.prefix}-late-retire`)
        })
    );
    expect(adoptionFirstRetireResults[0]?.status).toBe("fulfilled");
    expect(adoptionFirstRetireResults[1]?.status).toBe("rejected");

    const retireFirst = await createServiceAdoptionFixture("retire-first-adopt", {
      withUsage: true
    });
    const retireFirstResults = await race(
      async (transaction, signal) => {
        const result = await retireProjectAssetUsage(
          {
            projectId: retireFirst.fixture.projectId,
            usageId: retireFirst.fixture.usage!.usage.id,
            version: 1,
            actorId: ids.actor,
            reason: "采用前并发退役",
            authorizationActor,
            auditContext: auditContext(`${retireFirst.fixture.prefix}-early-retire`)
          },
          transaction
        );
        signal();
        return result;
      },
      () => adoptProjectAssetUpgrade(retireFirst.adoptionInput)
    );
    expect(retireFirstResults[0]?.status).toBe("fulfilled");
    expect(retireFirstResults[1]).toMatchObject({
      status: "rejected",
      reason: { code: "ASSET_IMPACT_REFRESH_REQUIRED", status: 409 }
    });
    await expect(
      Promise.all([
        db.assetUpgradeAdoption.count({
          where: {
            projectId: retireFirst.fixture.projectId,
            sourceReferenceId: retireFirst.adoptionInput.sourceReferenceId
          }
        }),
        db.projectAssetReference.count({
          where: {
            projectId: retireFirst.fixture.projectId,
            assetReleaseVersionId: retireFirst.targetRelease.releaseVersionId
          }
        })
      ])
    ).resolves.toEqual([0, 0]);
  });

  it("atomically adopts a COPY upgrade and records exact mitigation, audit and Outbox facts", async () => {
    const fixture = await createProjectImpactProjectionFixture("adoption-service", {
      withUsage: true
    });
    const impact = (await projectAssetImpactsFromSourceEvent(fixture.event)).items[0]!;
    for (const [action, version] of [
      ["ACKNOWLEDGE", 1],
      ["START_ASSESSMENT", 2],
      ["PLAN_UPGRADE", 3]
    ] as const) {
      await recordProjectAssetImpactDisposition({
        projectId: fixture.projectId,
        impactId: impact.impactId,
        action,
        version,
        reason: `升级采用准备 ${action}`,
        evidence: { action },
        actorId: ids.actor,
        authorizationActor,
        auditContext: auditContext(`${fixture.prefix}-${action.toLowerCase()}`)
      });
    }

    const targetCode = `REL-ADOPTION-SERVICE-TARGET-${suffix}`.toUpperCase();
    const targetRelease = await createPublishedReleaseVersion({
      releaseCode: targetCode,
      revision: 2
    });
    const targetComponent = await db.assetComponentSnapshot.create({
      data: {
        releaseVersionId: targetRelease.releaseVersionId,
        technicalAssetId: ids.recallAsset,
        position: 1,
        componentType: "VALIDATION_REPORT",
        sourceProjectId: ids.project,
        sourceDocumentVersionId: ids.sourceDocumentVersion,
        sourceFileId: ids.sourceFile,
        sourceVersion: 1,
        sourceStatus: "PUBLISHED",
        sourceChecksum: checksum,
        sourceFileSha256: checksum,
        sourceFileMimeType: "application/pdf",
        sourceFileSize: 128n,
        snapshotJson: { files: [{ fileId: ids.sourceFile, sha256: checksum }] }
      }
    });
    const sourceReference = await db.projectAssetReference.findUniqueOrThrow({
      where: { id: fixture.referenceId }
    });
    const candidate = await db.assetUpgradeCandidate.create({
      data: {
        technicalAssetId: ids.recallAsset,
        sourceAssetReleaseId: fixture.release.releaseId,
        sourceAssetReleaseVersionId: fixture.release.releaseVersionId,
        sourceRevision: sourceReference.releaseRevision,
        sourceSnapshotChecksum: sourceReference.snapshotChecksum,
        sourceWatermark: sourceReference.sourceWatermark,
        targetAssetReleaseId: targetRelease.releaseId,
        targetAssetReleaseVersionId: targetRelease.releaseVersionId,
        targetRevision: 2,
        targetSnapshotChecksum: checksum,
        targetWatermark: `watermark-${targetCode}`,
        compatibilitySnapshotJson: { level: "FULL" },
        compatibilitySnapshotChecksum: "6".repeat(64),
        createdById: ids.actor
      }
    });
    const sourceUsage = await db.projectAssetUsage.findUniqueOrThrow({
      where: { id: fixture.usage!.usage.id }
    });
    const operationId = `${fixture.prefix}-adopt`;
    const failedOperationId = `${fixture.prefix}-adopt-invalid-scope`;
    await expect(
      adoptProjectAssetUpgrade({
        projectId: fixture.projectId,
        candidateId: candidate.id,
        impactId: impact.impactId,
        impactVersion: 4,
        sourceReferenceId: sourceReference.id,
        sourceReferenceVersion: sourceReference.version,
        reason: "拒绝不完整的模块 scope override",
        mappings: [
          {
            sourceUsageId: sourceUsage.id,
            sourceUsageVersion: sourceUsage.version,
            targetUsageKey: `${fixture.prefix}-invalid-target-usage`,
            targetComponentSnapshotId: targetComponent.id,
            migrationMode: "OVERRIDE",
            quantity: "1.5",
            configuration: { purpose: "不应落库" },
            scopeType: "MODULE",
            scopeId: `${fixture.prefix}-missing-module`,
            deliveryUnitId: null,
            moduleId: null
          }
        ],
        actorId: ids.actor,
        authorizationActor,
        auditContext: auditContext(failedOperationId)
      })
    ).rejects.toMatchObject({ code: "PROJECT_ASSET_SCOPE_INVALID" });
    await expect(
      db.projectAssetReference.count({
        where: {
          projectId: fixture.projectId,
          assetReleaseVersionId: targetRelease.releaseVersionId
        }
      })
    ).resolves.toBe(0);
    await expect(
      db.assetUpgradeAdoption.count({
        where: { projectId: fixture.projectId, sourceReferenceId: sourceReference.id }
      })
    ).resolves.toBe(0);
    await expect(
      db.auditLog.count({ where: { requestId: `request-${failedOperationId}` } })
    ).resolves.toBe(0);
    await expect(
      db.assetProjectImpact.findUniqueOrThrow({ where: { id: impact.impactId } })
    ).resolves.toMatchObject({ status: "UPGRADE_PLANNED", version: 4 });

    const result = await adoptProjectAssetUpgrade({
      projectId: fixture.projectId,
      candidateId: candidate.id,
      impactId: impact.impactId,
      impactVersion: 4,
      sourceReferenceId: sourceReference.id,
      sourceReferenceVersion: sourceReference.version,
      reason: "采用 exact target release version",
      mappings: [
        {
          sourceUsageId: sourceUsage.id,
          sourceUsageVersion: sourceUsage.version,
          targetUsageKey: `${fixture.prefix}-target-usage`,
          targetComponentSnapshotId: targetComponent.id,
          migrationMode: "COPY"
        }
      ],
      actorId: ids.actor,
      authorizationActor,
      auditContext: auditContext(operationId)
    });

    expect(result.impact).toMatchObject({ status: "MITIGATED", resourceVersion: 5 });
    await expect(
      db.projectAssetReference.findUniqueOrThrow({ where: { id: sourceReference.id } })
    ).resolves.toMatchObject({ status: "RETIRED", version: 2 });
    await expect(
      db.projectAssetUsage.findUniqueOrThrow({ where: { id: sourceUsage.id } })
    ).resolves.toMatchObject({ status: "RETIRED", version: 2 });
    const targetReference = await db.projectAssetReference.findUniqueOrThrow({
      where: { id: result.adoption.targetReferenceId }
    });
    const targetUsage = await db.projectAssetUsage.findFirstOrThrow({
      where: { projectId: fixture.projectId, referenceId: targetReference.id }
    });
    expect(targetReference).toMatchObject({
      status: "ACTIVE",
      assetReleaseVersionId: targetRelease.releaseVersionId
    });
    expect(targetUsage).toMatchObject({
      status: "ACTIVE",
      componentSnapshotId: targetComponent.id,
      quantity: sourceUsage.quantity,
      configurationJson: sourceUsage.configurationJson,
      scopeType: sourceUsage.scopeType,
      scopeId: sourceUsage.scopeId
    });
    const frozenMapping = await db.assetUpgradeUsageMapping.findFirstOrThrow({
      where: { adoptionId: result.adoption.id }
    });
    expect(frozenMapping).toMatchObject({
      sourceUsageId: sourceUsage.id,
      targetUsageId: targetUsage.id,
      migrationMode: "COPY"
    });
    expect(frozenMapping.mappingSnapshotJson).toMatchObject({
      source: {
        usageId: sourceUsage.id,
        usageVersion: 1,
        quantity: sourceUsage.quantity.toString(),
        configuration: sourceUsage.configurationJson,
        scopeType: sourceUsage.scopeType,
        scopeId: sourceUsage.scopeId
      },
      target: {
        usageId: targetUsage.id,
        usageVersion: 1,
        quantity: targetUsage.quantity.toString(),
        configuration: targetUsage.configurationJson,
        scopeType: targetUsage.scopeType,
        scopeId: targetUsage.scopeId
      }
    });
    await expect(
      db.assetImpactDisposition.findFirstOrThrow({
        where: { impactId: impact.impactId, type: "MITIGATED" }
      })
    ).resolves.toMatchObject({ mitigationAdoptionId: result.adoption.id });
    await expect(
      db.auditLog.count({
        where: { operationId, action: "ASSET_UPGRADE_ADOPTED", result: "SUCCESS" }
      })
    ).resolves.toBe(1);
    await expect(
      db.outboxEvent.count({
        where: {
          aggregateId: result.adoption.id,
          eventType: "project.asset-upgrade.adopted"
        }
      })
    ).resolves.toBe(1);
    await expect(
      db.projectAssetDerivation.count({
        where: { projectId: fixture.projectId, sourceReferenceId: targetReference.id }
      })
    ).resolves.toBe(0);
  });

  it("serializes target recall and zero-usage adoption in both commit orders", async () => {
    const createFixture = async (label: string) => {
      const fixture = await createOpenImpact(`recall-adoption-${label}`);
      const sourceCode = `REL-RECALL-ADOPT-SOURCE-${label}-${suffix}`.toUpperCase();
      const targetCode = `REL-RECALL-ADOPT-TARGET-${label}-${suffix}`.toUpperCase();
      const sourceRelease = await createPublishedReleaseVersion({
        releaseCode: sourceCode,
        revision: 1
      });
      const targetRelease = await createPublishedReleaseVersion({
        releaseCode: targetCode,
        revision: 1
      });
      for (const [sequence, type, fromStatus, toStatus, nextVersion] of [
        [1, "ACKNOWLEDGED", "OPEN", "ACKNOWLEDGED", 2],
        [2, "ASSESSING", "ACKNOWLEDGED", "ASSESSING", 3],
        [3, "UPGRADE_PLANNED", "ASSESSING", "UPGRADE_PLANNED", 4]
      ] as const) {
        await db.$transaction(async (transaction) => {
          await applyImpactDisposition(transaction, {
            fixture,
            id: `${fixture.prefix}-${type.toLowerCase()}-disposition`,
            assessmentRevisionId: fixture.assessmentId,
            sequence,
            type,
            fromStatus,
            toStatus,
            nextVersion
          });
        });
      }
      const sourceReferenceId = `${fixture.prefix}-source-reference`;
      const targetReferenceId = `${fixture.prefix}-target-reference`;
      const referenceData = (id: string, release: typeof sourceRelease, releaseCode: string) => ({
        id,
        projectId: fixture.projectId,
        technicalAssetId: ids.recallAsset,
        assetReleaseId: release.releaseId,
        assetReleaseVersionId: release.releaseVersionId,
        releaseCode,
        releaseRevision: 1,
        snapshotChecksum: checksum,
        sourceWatermark: `watermark-${releaseCode}`,
        createdById: ids.actor
      });
      await db.projectAssetReference.createMany({
        data: [
          referenceData(sourceReferenceId, sourceRelease, sourceCode),
          referenceData(targetReferenceId, targetRelease, targetCode)
        ]
      });
      const candidateId = `${fixture.prefix}-candidate`;
      await db.assetUpgradeCandidate.create({
        data: {
          id: candidateId,
          technicalAssetId: ids.recallAsset,
          sourceAssetReleaseId: sourceRelease.releaseId,
          sourceAssetReleaseVersionId: sourceRelease.releaseVersionId,
          sourceRevision: 1,
          sourceSnapshotChecksum: checksum,
          sourceWatermark: `watermark-${sourceCode}`,
          targetAssetReleaseId: targetRelease.releaseId,
          targetAssetReleaseVersionId: targetRelease.releaseVersionId,
          targetRevision: 1,
          targetSnapshotChecksum: checksum,
          targetWatermark: `watermark-${targetCode}`,
          compatibilitySnapshotJson: {},
          compatibilitySnapshotChecksum: "6".repeat(64),
          createdById: ids.actor
        }
      });
      const adoptionId = `${fixture.prefix}-adoption`;
      return {
        ...fixture,
        sourceRelease,
        targetRelease,
        sourceCode,
        targetCode,
        sourceReferenceId,
        targetReferenceId,
        candidateId,
        adoptionId,
        adoptionData: {
          id: adoptionId,
          candidateId,
          projectId: fixture.projectId,
          impactId: fixture.impactId,
          technicalAssetId: ids.recallAsset,
          sourceReferenceId,
          sourceReferenceVersion: 1,
          targetReferenceId,
          targetReferenceVersion: 1,
          sourceAssetReleaseId: sourceRelease.releaseId,
          sourceAssetReleaseVersionId: sourceRelease.releaseVersionId,
          sourceRevision: 1,
          sourceSnapshotChecksum: checksum,
          sourceWatermark: `watermark-${sourceCode}`,
          targetAssetReleaseId: targetRelease.releaseId,
          targetAssetReleaseVersionId: targetRelease.releaseVersionId,
          targetRevision: 1,
          targetSnapshotChecksum: checksum,
          targetWatermark: `watermark-${targetCode}`,
          reason: `并发采用 ${label}`,
          actorId: ids.actor,
          adoptedAt: new Date(0)
        }
      };
    };
    const adopt = async (fixture: Awaited<ReturnType<typeof createFixture>>, signal?: () => void) =>
      db.$transaction(async (transaction) => {
        await transactionTimeouts(transaction);
        await transaction.assetUpgradeAdoption.create({ data: fixture.adoptionData });
        signal?.();
        if (signal) {
          await transaction.$queryRaw`SELECT 1 AS "waited" FROM pg_sleep(0.15)`;
        }
        await transaction.projectAssetReference.update({
          where: { id: fixture.sourceReferenceId },
          data: {
            status: "RETIRED",
            version: 2,
            retiredById: ids.actor,
            retireReason: "并发测试完成零 usage 原子采用"
          }
        });
      });
    const issueTargetRecall = async (
      fixture: Awaited<ReturnType<typeof createFixture>>,
      signal?: () => void
    ) => {
      const recallId = `${fixture.prefix}-target-recall`;
      const recallRevisionId = `${fixture.prefix}-target-recall-revision`;
      const affected = buildAssetReleaseRecallAffectedVersionSet({
        scope: "RELEASE_VERSION",
        releaseId: fixture.targetRelease.releaseId,
        targetReleaseVersionId: fixture.targetRelease.releaseVersionId,
        versions: [
          {
            assetReleaseVersionId: fixture.targetRelease.releaseVersionId,
            releaseId: fixture.targetRelease.releaseId,
            technicalAssetId: ids.recallAsset,
            revision: 1,
            snapshotChecksum: checksum,
            sourceWatermark: `watermark-${fixture.targetCode}`,
            status: "PUBLISHED"
          }
        ]
      });
      await db.$transaction(async (transaction) => {
        await transactionTimeouts(transaction);
        await transaction.assetReleaseRecall.create({
          data: {
            id: recallId,
            technicalAssetId: ids.recallAsset,
            releaseId: fixture.targetRelease.releaseId,
            targetReleaseVersionId: fixture.targetRelease.releaseVersionId,
            targetKey: `RELEASE_VERSION:${fixture.targetRelease.releaseVersionId}`,
            scope: "RELEASE_VERSION",
            affectedVersionSetChecksum: affected.affectedVersionSetChecksum,
            createdById: ids.actor
          }
        });
        signal?.();
        if (signal) {
          await transaction.$queryRaw`SELECT 1 AS "waited" FROM pg_sleep(0.15)`;
        }
        await transaction.assetReleaseRecallAffectedVersion.create({
          data: {
            id: `${recallId}-affected`,
            recallId,
            technicalAssetId: ids.recallAsset,
            releaseId: fixture.targetRelease.releaseId,
            assetReleaseVersionId: fixture.targetRelease.releaseVersionId,
            revision: 1,
            snapshotChecksum: checksum,
            sourceWatermark: `watermark-${fixture.targetCode}`,
            status: "PUBLISHED"
          }
        });
        await transaction.assetReleaseRecallRevision.create({
          data: {
            id: recallRevisionId,
            recallId,
            technicalAssetId: ids.recallAsset,
            revision: 1,
            kind: "ISSUED",
            state: "ACTIVE",
            severity: "HIGH",
            reason: "并发测试 target exact version 召回",
            affectedVersionSetChecksum: affected.affectedVersionSetChecksum,
            affectedVersionCount: 1,
            sourceAssetReleaseId: fixture.targetRelease.releaseId,
            sourceAssetReleaseVersionId: fixture.targetRelease.releaseVersionId,
            sourceRevision: 1,
            sourceSnapshotChecksum: checksum,
            sourceWatermark: `watermark-${fixture.targetCode}`,
            evidenceJson: {},
            snapshotJson: {
              affectedVersionSetChecksum: affected.affectedVersionSetChecksum,
              sourceWatermark: `watermark-${fixture.targetCode}`
            },
            snapshotChecksum: "5".repeat(64),
            actorId: ids.actor,
            effectiveAt: new Date(0)
          }
        });
        await transaction.assetReleaseRecall.update({
          where: { id: recallId },
          data: { currentRevisionId: recallRevisionId, currentState: "ACTIVE" }
        });
      });
      return { recallId, recallRevisionId };
    };

    const adoptionFirst = await createFixture("adoption-first");
    let adoptionInserted!: () => void;
    const adoptionInsertedBarrier = new Promise<void>((resolve) => (adoptionInserted = resolve));
    const historicalAdoption = adopt(adoptionFirst, adoptionInserted);
    await adoptionInsertedBarrier;
    const laterRecall = issueTargetRecall(adoptionFirst);
    const adoptionFirstResults = await Promise.allSettled([historicalAdoption, laterRecall]);
    expect(adoptionFirstResults.map((result) => result.status)).toEqual(["fulfilled", "fulfilled"]);
    for (const result of adoptionFirstResults) {
      const message = result.status === "rejected" ? String(result.reason) : "";
      expect(message).not.toMatch(/40P01/u);
    }
    const historicalFact = await db.assetUpgradeAdoption.findUniqueOrThrow({
      where: { id: adoptionFirst.adoptionId }
    });
    const laterRecallFact = await db.assetReleaseRecall.findUniqueOrThrow({
      where: {
        technicalAssetId_targetKey: {
          technicalAssetId: ids.recallAsset,
          targetKey: `RELEASE_VERSION:${adoptionFirst.targetRelease.releaseVersionId}`
        }
      },
      include: { currentRevision: true }
    });
    expect(historicalFact.adoptedAt.getTime()).toBeLessThanOrEqual(
      laterRecallFact.currentRevision!.effectiveAt.getTime()
    );
    await expect(
      db.projectAssetReference.findUniqueOrThrow({ where: { id: adoptionFirst.sourceReferenceId } })
    ).resolves.toMatchObject({ status: "RETIRED", version: 2 });

    const recallFirst = await createFixture("recall-first");
    let recallRootInserted!: () => void;
    const recallRootInsertedBarrier = new Promise<void>(
      (resolve) => (recallRootInserted = resolve)
    );
    const recallWinner = issueTargetRecall(recallFirst, recallRootInserted);
    await recallRootInsertedBarrier;
    const blockedAdoption = adopt(recallFirst);
    const recallFirstResults = await Promise.allSettled([recallWinner, blockedAdoption]);
    expect(recallFirstResults[0]?.status).toBe("fulfilled");
    expect(recallFirstResults[1]?.status).toBe("rejected");
    const blockedAdoptionMessage =
      recallFirstResults[1]?.status === "rejected" ? String(recallFirstResults[1].reason) : "";
    expect(blockedAdoptionMessage).toMatch(/23514/u);
    expect(blockedAdoptionMessage).not.toMatch(/40P01/u);
    await expect(
      db.assetUpgradeAdoption.count({ where: { id: recallFirst.adoptionId } })
    ).resolves.toBe(0);
    await expect(
      db.projectAssetReference.findUniqueOrThrow({ where: { id: recallFirst.sourceReferenceId } })
    ).resolves.toMatchObject({ status: "ACTIVE", version: 1 });
    await expect(
      db.projectAssetReference.findUniqueOrThrow({ where: { id: recallFirst.targetReferenceId } })
    ).resolves.toMatchObject({ status: "ACTIVE", version: 1 });
  });

  it("serializes a third exact reference and adoption by their project lock time boundary", async () => {
    const createThirdReference = async (
      fixture: Awaited<ReturnType<typeof createZeroUsageAdoptionFixture>>,
      input: {
        id: string;
        release: Awaited<ReturnType<typeof createPublishedReleaseVersion>>;
        releaseCode: string;
        signal?: () => void;
      }
    ) =>
      db.$transaction(async (transaction) => {
        await transactionTimeouts(transaction);
        await transaction.projectAssetReference.create({
          data: fixture.referenceData(input.id, input.release, input.releaseCode)
        });
        input.signal?.();
        if (input.signal) {
          await transaction.$queryRaw`SELECT 1 AS "waited" FROM pg_sleep(0.15)`;
        }
      });

    const referenceFirst = await createZeroUsageAdoptionFixture(
      `reference-adoption-reference-first-${suffix}`
    );
    const referenceFirstCode = `REL-REFERENCE-FIRST-THIRD-${suffix}`.toUpperCase();
    const referenceFirstRelease = await createPublishedReleaseVersion({
      releaseCode: referenceFirstCode,
      revision: 1
    });
    const referenceFirstId = `${referenceFirst.prefix}-third-reference`;
    let referenceInserted!: () => void;
    const referenceInsertedBarrier = new Promise<void>((resolve) => (referenceInserted = resolve));
    const thirdReferenceWinner = createThirdReference(referenceFirst, {
      id: referenceFirstId,
      release: referenceFirstRelease,
      releaseCode: referenceFirstCode,
      signal: referenceInserted
    });
    await referenceInsertedBarrier;
    const adoptionAfterReference = adoptZeroUsageUpgrade(referenceFirst);
    const referenceFirstResults = await Promise.allSettled([
      thirdReferenceWinner,
      adoptionAfterReference
    ]);
    expect(referenceFirstResults.map((result) => result.status)).toEqual([
      "fulfilled",
      "fulfilled"
    ]);
    for (const result of referenceFirstResults) {
      const message = result.status === "rejected" ? String(result.reason) : "";
      expect(message).not.toMatch(/40P01/u);
    }
    await expect(
      db.assetUpgradeAdoption.count({ where: { id: referenceFirst.adoptionId } })
    ).resolves.toBe(1);
    await expect(
      db.projectAssetReference.findMany({
        where: {
          id: {
            in: [
              referenceFirst.sourceReferenceId,
              referenceFirst.targetReferenceId,
              referenceFirstId
            ]
          }
        },
        orderBy: { id: "asc" }
      })
    ).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: referenceFirst.sourceReferenceId,
          status: "RETIRED",
          version: 2
        }),
        expect.objectContaining({
          id: referenceFirst.targetReferenceId,
          status: "ACTIVE",
          version: 1
        }),
        expect.objectContaining({ id: referenceFirstId, status: "ACTIVE", version: 1 })
      ])
    );

    const adoptionFirst = await createZeroUsageAdoptionFixture(
      `reference-adoption-adoption-first-${suffix}`
    );
    const adoptionFirstCode = `REL-ADOPTION-FIRST-THIRD-${suffix}`.toUpperCase();
    const adoptionFirstRelease = await createPublishedReleaseVersion({
      releaseCode: adoptionFirstCode,
      revision: 1
    });
    const adoptionFirstReferenceId = `${adoptionFirst.prefix}-third-reference`;
    let adoptionInserted!: () => void;
    const adoptionInsertedBarrier = new Promise<void>((resolve) => (adoptionInserted = resolve));
    const adoptionWinner = adoptZeroUsageUpgrade(adoptionFirst, adoptionInserted);
    await adoptionInsertedBarrier;
    const laterReference = createThirdReference(adoptionFirst, {
      id: adoptionFirstReferenceId,
      release: adoptionFirstRelease,
      releaseCode: adoptionFirstCode
    });
    const adoptionFirstResults = await Promise.allSettled([adoptionWinner, laterReference]);
    expect(adoptionFirstResults.map((result) => result.status)).toEqual(["fulfilled", "fulfilled"]);
    for (const result of adoptionFirstResults) {
      const message = result.status === "rejected" ? String(result.reason) : "";
      expect(message).not.toMatch(/40P01/u);
    }
    const [adoptionFact, laterReferenceFact] = await Promise.all([
      db.assetUpgradeAdoption.findUniqueOrThrow({ where: { id: adoptionFirst.adoptionId } }),
      db.projectAssetReference.findUniqueOrThrow({ where: { id: adoptionFirstReferenceId } })
    ]);
    expect(adoptionFact.adoptedAt.getTime()).toBeLessThanOrEqual(
      laterReferenceFact.createdAt.getTime()
    );
    await expect(
      db.projectAssetReference.findUniqueOrThrow({ where: { id: adoptionFirst.sourceReferenceId } })
    ).resolves.toMatchObject({ status: "RETIRED", version: 2 });
    await expect(
      db.projectAssetReference.count({
        where: {
          projectId: adoptionFirst.projectId,
          technicalAssetId: ids.recallAsset,
          status: "ACTIVE"
        }
      })
    ).resolves.toBe(2);
    expect(laterReferenceFact).toMatchObject({ status: "ACTIVE", version: 1 });
  });

  it("rejects a direct MITIGATED disposition without an exact same-impact adoption", async () => {
    const fixture = await createZeroUsageAdoptionFixture("mitigation-binding");
    await expect(
      db.$transaction(async (transaction) => {
        await transaction.$executeRaw`
          INSERT INTO "asset_impact_dispositions" (
            "id", "impact_id", "project_id", "technical_asset_id", "assessment_revision_id",
            "sequence", "type", "from_status", "to_status", "reason", "evidence_json",
            "actor_id", "actor_membership_id", "actor_membership_snapshot_json",
            "owner_membership_id", "owner_membership_snapshot_json", "due_at"
          )
          SELECT
            ${`${fixture.prefix}-mitigated-without-adoption`}, impact."id", impact."project_id",
            impact."technical_asset_id", assessment."id", 4, 'MITIGATED', 'UPGRADE_PLANNED',
            'MITIGATED', '缺少同 impact adoption 的伪造缓解',
            ${JSON.stringify({ proof: "missing-adoption" })}::jsonb, ${ids.actor},
            assessment."owner_membership_id", assessment."owner_membership_snapshot_json",
            assessment."owner_membership_id", assessment."owner_membership_snapshot_json",
            assessment."due_at"
          FROM "asset_project_impacts" impact
          JOIN "asset_impact_assessment_revisions" assessment
            ON assessment."id" = impact."current_assessment_revision_id"
          WHERE impact."id" = ${fixture.impactId}
        `;
        await transaction.$executeRaw`
          UPDATE "asset_project_impacts"
             SET "status" = 'MITIGATED', "version" = 5
           WHERE "id" = ${fixture.impactId}
        `;
      })
    ).rejects.toThrow(/MITIGATED disposition requires its exact same-impact adoption/u);
  });

  it("binds MITIGATED to an exact same-impact adoption and requires closure evidence", async () => {
    const first = await createZeroUsageAdoptionFixture("mitigation-first");
    const second = await createZeroUsageAdoptionFixture("mitigation-second");
    await adoptZeroUsageUpgrade(first);
    await expect(
      db.$transaction(async (transaction) => {
        await applyImpactDisposition(transaction, {
          fixture: second,
          id: `${second.prefix}-cross-impact-mitigation`,
          assessmentRevisionId: second.assessmentId,
          sequence: 4,
          type: "MITIGATED",
          fromStatus: "UPGRADE_PLANNED",
          toStatus: "MITIGATED",
          nextVersion: 5,
          mitigationAdoptionId: first.adoptionId
        });
      })
    ).rejects.toThrow(/MITIGATED disposition requires its exact same-impact adoption/u);

    await adoptZeroUsageUpgrade(second);
    await db.$transaction(async (transaction) => {
      await applyImpactDisposition(transaction, {
        fixture: second,
        id: `${second.prefix}-mitigated`,
        assessmentRevisionId: second.assessmentId,
        sequence: 4,
        type: "MITIGATED",
        fromStatus: "UPGRADE_PLANNED",
        toStatus: "MITIGATED",
        nextVersion: 5,
        mitigationAdoptionId: second.adoptionId
      });
    });
    await expect(
      db.assetProjectImpact.findUniqueOrThrow({ where: { id: second.impactId } })
    ).resolves.toMatchObject({ status: "MITIGATED", version: 5 });

    await expect(
      db.$transaction(async (transaction) => {
        await transaction.$executeRaw`
          INSERT INTO "asset_impact_dispositions" (
            "id", "impact_id", "project_id", "technical_asset_id", "assessment_revision_id",
            "sequence", "type", "from_status", "to_status", "reason", "evidence_json",
            "actor_id", "actor_membership_id", "actor_membership_snapshot_json",
            "owner_membership_id", "owner_membership_snapshot_json", "due_at"
          )
          SELECT
            ${`${second.prefix}-empty-evidence-close`}, impact."id", impact."project_id",
            impact."technical_asset_id", assessment."id", 5, 'CLOSED', 'MITIGATED', 'CLOSED',
            '空证据关闭应拒绝', '{}'::jsonb, ${ids.actor}, assessment."owner_membership_id",
            assessment."owner_membership_snapshot_json", assessment."owner_membership_id",
            assessment."owner_membership_snapshot_json", assessment."due_at"
          FROM "asset_project_impacts" impact
          JOIN "asset_impact_assessment_revisions" assessment
            ON assessment."id" = impact."current_assessment_revision_id"
          WHERE impact."id" = ${second.impactId}
        `;
        await transaction.$executeRaw`
          UPDATE "asset_project_impacts" SET "status" = 'CLOSED', "version" = 6
           WHERE "id" = ${second.impactId}
        `;
      })
    ).rejects.toThrow(/23514/u);

    await db.$transaction(async (transaction) => {
      await applyImpactDisposition(transaction, {
        fixture: second,
        id: `${second.prefix}-closed`,
        assessmentRevisionId: second.assessmentId,
        sequence: 5,
        type: "CLOSED",
        fromStatus: "MITIGATED",
        toStatus: "CLOSED",
        nextVersion: 6
      });
    });
    await expect(
      db.assetProjectImpact.findUniqueOrThrow({ where: { id: second.impactId } })
    ).resolves.toMatchObject({ status: "CLOSED", version: 6 });
  });

  it("writes every APM-064 authoritative timestamp as UTC under an Asia/Shanghai session", async () => {
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl)
      throw new Error("DATABASE_URL is required for the APM-064 timezone regression.");
    const url = new URL(databaseUrl);
    url.searchParams.set("connection_limit", "1");
    const timezoneDb = new PrismaClient({ datasources: { db: { url: url.toString() } } });
    try {
      await timezoneDb.$connect();
      await timezoneDb.$executeRawUnsafe("SET TIME ZONE 'Asia/Shanghai'");
      const [facts] = await timezoneDb.$queryRaw<
        {
          now: Date;
          createdAt: Date;
          adoptedAt: Date;
          effectiveAt: Date;
          frozenAt: Date;
          requestedAt: Date;
          decidedAt: Date;
          adoptionBeforeReference: boolean;
        }[]
      >`
        SELECT
          timezone('UTC', CURRENT_TIMESTAMP) AS "now",
          (SELECT max("created_at") FROM "asset_upgrade_candidates") AS "createdAt",
          (SELECT max("adopted_at") FROM "asset_upgrade_adoptions") AS "adoptedAt",
          (SELECT max("effective_at") FROM "asset_release_recall_revisions") AS "effectiveAt",
          (SELECT max("frozen_at") FROM "asset_impact_assessment_revisions") AS "frozenAt",
          (SELECT max("requested_at") FROM "asset_impact_risk_acceptance_requests") AS "requestedAt",
          (SELECT max("decided_at") FROM "asset_impact_risk_acceptance_decisions") AS "decidedAt",
          EXISTS (
            SELECT 1
              FROM "asset_upgrade_adoptions" adoption
              JOIN "project_asset_references" reference
                ON reference."project_id" = adoption."project_id"
               AND reference."id" LIKE '%third-reference'
             WHERE adoption."id" LIKE '%reference-adoption-adoption-first%'
               AND adoption."adopted_at" <= reference."created_at"
          ) AS "adoptionBeforeReference"
      `;
      expect(facts).toBeDefined();
      expect(facts!.adoptionBeforeReference).toBe(true);
      for (const timestamp of [
        facts!.createdAt,
        facts!.adoptedAt,
        facts!.effectiveAt,
        facts!.frozenAt,
        facts!.requestedAt,
        facts!.decidedAt
      ]) {
        expect(Math.abs(facts!.now.getTime() - timestamp.getTime())).toBeLessThan(15_000);
      }
    } finally {
      await timezoneDb.$disconnect();
    }
  });

  it("validates exact candidates and atomically adopts a zero-usage reference without changing APM-063 cardinality", async () => {
    const prefix = `asset-impact-adoption-${suffix}`;
    const projectId = `${prefix}-project`;
    const membershipId = `${prefix}-membership`;
    const sourceRelease = await createPublishedReleaseVersion({
      releaseCode: `REL-ADOPT-SOURCE-${suffix}`.toUpperCase(),
      revision: 1
    });
    const targetRelease = await createPublishedReleaseVersion({
      releaseCode: `REL-ADOPT-TARGET-${suffix}`.toUpperCase(),
      revision: 1
    });
    const extraRelease = await createPublishedReleaseVersion({
      releaseCode: `REL-ADOPT-EXTRA-${suffix}`.toUpperCase(),
      revision: 1
    });
    await db.project.create({
      data: {
        id: projectId,
        code: `ASSET-ADOPT-${suffix}`.toUpperCase(),
        name: "资产升级采用测试项目",
        createdById: ids.actor
      }
    });
    await db.projectMember.create({
      data: {
        id: membershipId,
        projectId,
        userId: ids.actor,
        projectRole: "PROJECT_MANAGER",
        assignedById: ids.actor
      }
    });

    const sourceReferenceId = `${prefix}-source-reference`;
    const targetReferenceId = `${prefix}-target-reference`;
    const extraReferenceId = `${prefix}-extra-reference`;
    const referenceData = (
      id: string,
      release: { releaseId: string; releaseVersionId: string },
      releaseCode: string
    ) => ({
      id,
      projectId,
      technicalAssetId: ids.recallAsset,
      assetReleaseId: release.releaseId,
      assetReleaseVersionId: release.releaseVersionId,
      releaseCode,
      releaseRevision: 1,
      snapshotChecksum: checksum,
      sourceWatermark: `watermark-${releaseCode}`,
      createdById: ids.actor
    });
    await db.projectAssetReference.create({
      data: referenceData(
        sourceReferenceId,
        sourceRelease,
        `REL-ADOPT-SOURCE-${suffix}`.toUpperCase()
      )
    });

    const affected = buildAssetReleaseRecallAffectedVersionSet({
      scope: "RELEASE_VERSION",
      releaseId: sourceRelease.releaseId,
      targetReleaseVersionId: sourceRelease.releaseVersionId,
      versions: [
        {
          assetReleaseVersionId: sourceRelease.releaseVersionId,
          releaseId: sourceRelease.releaseId,
          technicalAssetId: ids.recallAsset,
          revision: 1,
          snapshotChecksum: checksum,
          sourceWatermark: `watermark-${`REL-ADOPT-SOURCE-${suffix}`.toUpperCase()}`,
          status: "PUBLISHED"
        }
      ]
    });
    const recallId = `${prefix}-recall`;
    const recallRevisionId = `${prefix}-recall-revision`;
    await db.$transaction(async (transaction) => {
      await transaction.assetReleaseRecall.create({
        data: {
          id: recallId,
          technicalAssetId: ids.recallAsset,
          releaseId: sourceRelease.releaseId,
          targetReleaseVersionId: sourceRelease.releaseVersionId,
          targetKey: `RELEASE_VERSION:${sourceRelease.releaseVersionId}`,
          scope: "RELEASE_VERSION",
          affectedVersionSetChecksum: affected.affectedVersionSetChecksum,
          createdById: ids.actor
        }
      });
      await transaction.assetReleaseRecallAffectedVersion.create({
        data: {
          id: `${prefix}-affected-version`,
          recallId,
          technicalAssetId: ids.recallAsset,
          releaseId: sourceRelease.releaseId,
          assetReleaseVersionId: sourceRelease.releaseVersionId,
          revision: 1,
          snapshotChecksum: checksum,
          sourceWatermark: `watermark-${`REL-ADOPT-SOURCE-${suffix}`.toUpperCase()}`,
          status: "PUBLISHED"
        }
      });
      await transaction.assetReleaseRecallRevision.create({
        data: {
          id: recallRevisionId,
          recallId,
          technicalAssetId: ids.recallAsset,
          revision: 1,
          kind: "ISSUED",
          state: "ACTIVE",
          severity: "HIGH",
          reason: "升级采用 source exact version 召回",
          affectedVersionSetChecksum: affected.affectedVersionSetChecksum,
          affectedVersionCount: 1,
          sourceAssetReleaseId: sourceRelease.releaseId,
          sourceAssetReleaseVersionId: sourceRelease.releaseVersionId,
          sourceRevision: 1,
          sourceSnapshotChecksum: checksum,
          sourceWatermark: `watermark-${`REL-ADOPT-SOURCE-${suffix}`.toUpperCase()}`,
          evidenceJson: {},
          snapshotJson: {
            affectedVersionSetChecksum: affected.affectedVersionSetChecksum,
            sourceWatermark: `watermark-${`REL-ADOPT-SOURCE-${suffix}`.toUpperCase()}`
          },
          snapshotChecksum: "e".repeat(64),
          actorId: ids.actor,
          effectiveAt: new Date(0)
        }
      });
      await transaction.assetReleaseRecall.update({
        where: { id: recallId },
        data: { currentRevisionId: recallRevisionId, currentState: "ACTIVE" }
      });
    });

    const impactId = `${prefix}-impact`;
    const assessmentId = `${prefix}-assessment`;
    const ownerSnapshot = {
      membershipId,
      userId: ids.actor,
      projectRole: "PROJECT_MANAGER"
    };
    const dueAt = new Date(Date.now() + 86_400_000);
    await db.$transaction(async (transaction) => {
      await transaction.assetProjectImpact.create({
        data: {
          id: impactId,
          projectId,
          technicalAssetId: ids.recallAsset,
          sourceType: "RECALL",
          sourceKey: `RECALL:${recallId}`,
          recallId
        }
      });
      await transaction.assetImpactAssessmentRevision.create({
        data: {
          id: assessmentId,
          impactId,
          projectId,
          technicalAssetId: ids.recallAsset,
          sequence: 1,
          kind: "INITIAL",
          ...recallAssessmentSource({
            recallId,
            recallRevisionId,
            recallRevisionNumber: 1,
            recallRevisionSnapshotChecksum: "e".repeat(64),
            recallRevisionKind: "ISSUED",
            recallRevisionState: "ACTIVE",
            projectFactsWatermark: `${prefix}-project-facts-1`
          }),
          snapshotChecksum: "f".repeat(64),
          frozenAt: new Date(0),
          ownerMembershipId: membershipId,
          ownerMembershipSnapshotJson: ownerSnapshot,
          dueAt
        }
      });
      await transaction.assetProjectImpact.update({
        where: { id: impactId },
        data: { currentAssessmentRevisionId: assessmentId, ownerMembershipId: membershipId, dueAt }
      });
    });
    const transitions = [
      ["ACKNOWLEDGED", "OPEN", "ACKNOWLEDGED"],
      ["ASSESSING", "ACKNOWLEDGED", "ASSESSING"],
      ["UPGRADE_PLANNED", "ASSESSING", "UPGRADE_PLANNED"]
    ] as const;
    let impactVersion = 1;
    for (const [type, fromStatus, toStatus] of transitions) {
      impactVersion += 1;
      await db.$transaction(async (transaction) => {
        await transaction.assetImpactDisposition.create({
          data: {
            id: `${prefix}-disposition-${impactVersion}`,
            impactId,
            projectId,
            technicalAssetId: ids.recallAsset,
            assessmentRevisionId: assessmentId,
            sequence: impactVersion - 1,
            type,
            fromStatus,
            toStatus,
            reason: `推进到 ${toStatus}`,
            evidenceJson: { dispositionType: type },
            actorId: ids.actor,
            actorMembershipId: membershipId,
            actorMembershipSnapshotJson: ownerSnapshot,
            ownerMembershipId: membershipId,
            ownerMembershipSnapshotJson: ownerSnapshot,
            dueAt
          }
        });
        await transaction.assetProjectImpact.update({
          where: { id: impactId },
          data: { status: toStatus, version: impactVersion }
        });
      });
    }

    await expect(
      db.assetUpgradeCandidate.create({
        data: {
          id: `${prefix}-invalid-candidate`,
          technicalAssetId: ids.recallAsset,
          sourceAssetReleaseId: sourceRelease.releaseId,
          sourceAssetReleaseVersionId: `${prefix}-missing-version`,
          sourceRevision: 1,
          sourceSnapshotChecksum: checksum,
          sourceWatermark: "missing-watermark",
          targetAssetReleaseId: targetRelease.releaseId,
          targetAssetReleaseVersionId: targetRelease.releaseVersionId,
          targetRevision: 1,
          targetSnapshotChecksum: checksum,
          targetWatermark: `watermark-${`REL-ADOPT-TARGET-${suffix}`.toUpperCase()}`,
          compatibilitySnapshotJson: {},
          compatibilitySnapshotChecksum: "1".repeat(64),
          createdById: ids.actor
        }
      })
    ).rejects.toThrow(/exact allowed source and target ReleaseVersion facts/u);

    const candidateId = `${prefix}-candidate`;
    await db.assetUpgradeCandidate.create({
      data: {
        id: candidateId,
        technicalAssetId: ids.recallAsset,
        sourceAssetReleaseId: sourceRelease.releaseId,
        sourceAssetReleaseVersionId: sourceRelease.releaseVersionId,
        sourceRevision: 1,
        sourceSnapshotChecksum: checksum,
        sourceWatermark: `watermark-${`REL-ADOPT-SOURCE-${suffix}`.toUpperCase()}`,
        targetAssetReleaseId: targetRelease.releaseId,
        targetAssetReleaseVersionId: targetRelease.releaseVersionId,
        targetRevision: 1,
        targetSnapshotChecksum: checksum,
        targetWatermark: `watermark-${`REL-ADOPT-TARGET-${suffix}`.toUpperCase()}`,
        compatibilitySnapshotJson: {},
        compatibilitySnapshotChecksum: "2".repeat(64),
        createdById: ids.actor
      }
    });
    await db.projectAssetReference.create({
      data: referenceData(
        targetReferenceId,
        targetRelease,
        `REL-ADOPT-TARGET-${suffix}`.toUpperCase()
      )
    });
    await db.projectAssetReference.create({
      data: referenceData(extraReferenceId, extraRelease, `REL-ADOPT-EXTRA-${suffix}`.toUpperCase())
    });
    const adoptionData = {
      id: `${prefix}-adoption`,
      candidateId,
      projectId,
      impactId,
      technicalAssetId: ids.recallAsset,
      sourceReferenceId,
      sourceReferenceVersion: 1,
      targetReferenceId,
      targetReferenceVersion: 1,
      sourceAssetReleaseId: sourceRelease.releaseId,
      sourceAssetReleaseVersionId: sourceRelease.releaseVersionId,
      sourceRevision: 1,
      sourceSnapshotChecksum: checksum,
      sourceWatermark: `watermark-${`REL-ADOPT-SOURCE-${suffix}`.toUpperCase()}`,
      targetAssetReleaseId: targetRelease.releaseId,
      targetAssetReleaseVersionId: targetRelease.releaseVersionId,
      targetRevision: 1,
      targetSnapshotChecksum: checksum,
      targetWatermark: `watermark-${`REL-ADOPT-TARGET-${suffix}`.toUpperCase()}`,
      reason: "采用 exact target ReleaseVersion",
      actorId: ids.actor,
      adoptedAt: new Date(0)
    };
    await expect(
      db.$transaction(async (transaction) => {
        for (const status of ["VALIDATION", "RELEASE_REVIEW", "COMPLETED"] as const) {
          await transaction.rndProject.update({
            where: { id: ids.rndProject },
            data: { status, version: { increment: 1 } }
          });
        }
        await transaction.assetUpgradeAdoption.create({ data: adoptionData });
        await transaction.projectAssetReference.update({
          where: { id: sourceReferenceId },
          data: {
            status: "RETIRED",
            version: 2,
            retiredById: ids.actor,
            retireReason: "COMPLETED R&D 不得提交升级采用"
          }
        });
      })
    ).rejects.toThrow(/exact candidate, impact, and source\/target reference facts/u);
    await expect(db.assetUpgradeAdoption.count({ where: { id: adoptionData.id } })).resolves.toBe(
      0
    );
    await expect(
      db.projectAssetReference.findUniqueOrThrow({ where: { id: sourceReferenceId } })
    ).resolves.toMatchObject({ status: "ACTIVE", version: 1 });
    await db.$transaction(async (transaction) => {
      await transaction.assetUpgradeAdoption.create({ data: adoptionData });
      await transaction.projectAssetReference.update({
        where: { id: sourceReferenceId },
        data: {
          status: "RETIRED",
          version: 2,
          retiredById: ids.actor,
          retireReason: "完成零 usage 原子升级采用"
        }
      });
    });
    await expect(
      db.assetUpgradeUsageMapping.count({ where: { adoptionId: adoptionData.id } })
    ).resolves.toBe(0);
    await expect(
      db.projectAssetReference.findUniqueOrThrow({ where: { id: sourceReferenceId } })
    ).resolves.toMatchObject({ status: "RETIRED" });
    await expect(
      db.projectAssetReference.findUniqueOrThrow({ where: { id: extraReferenceId } })
    ).resolves.toMatchObject({ status: "ACTIVE", version: 1 });
    await db.projectAssetReference.update({
      where: { id: targetReferenceId },
      data: {
        status: "RETIRED",
        version: 2,
        retiredById: ids.actor,
        retireReason: "验证 target 历史唯一后退役"
      }
    });
    await expect(
      db.projectAssetReference.create({
        data: referenceData(
          `${prefix}-duplicate-target-reference`,
          targetRelease,
          `REL-ADOPT-TARGET-${suffix}`.toUpperCase()
        )
      })
    ).rejects.toMatchObject({ code: "P2002" });
  });

  it("enforces the full Recall root key, cause XOR/composite relation, active reference cardinality, and Alert source enum", async () => {
    await expect(
      db.assetReleaseRecall.create({
        data: {
          id: `asset-impact-duplicate-recall-${suffix}`,
          technicalAssetId: ids.recallAsset,
          releaseId: ids.release,
          targetKey: `RELEASE:${ids.release}`,
          scope: "RELEASE",
          createdById: ids.actor
        }
      })
    ).rejects.toMatchObject({ code: "P2002" });
    await expect(
      db.assetProjectImpact.create({
        data: {
          id: `asset-impact-cross-asset-${suffix}`,
          projectId: ids.project,
          technicalAssetId: ids.disabledAsset,
          sourceType: "RECALL",
          sourceKey: `RECALL:${ids.recall}`,
          recallId: ids.recall
        }
      })
    ).rejects.toThrow(/23514[\s\S]*recall impact must bind its exact recall source/u);

    const first = await createPublishedReleaseVersion({
      releaseCode: `REL-CARDINALITY-A-${suffix}`.toUpperCase(),
      revision: 1
    });
    const second = await createPublishedReleaseVersion({
      releaseCode: `REL-CARDINALITY-B-${suffix}`.toUpperCase(),
      revision: 1
    });
    await db.projectAssetReference.create({
      data: {
        id: `asset-impact-reference-a-${suffix}`,
        projectId: ids.project,
        technicalAssetId: ids.recallAsset,
        assetReleaseId: first.releaseId,
        assetReleaseVersionId: first.releaseVersionId,
        releaseCode: `REL-CARDINALITY-A-${suffix}`.toUpperCase(),
        releaseRevision: 1,
        snapshotChecksum: checksum,
        sourceWatermark: `watermark-${`REL-CARDINALITY-A-${suffix}`.toUpperCase()}`,
        createdById: ids.actor
      }
    });
    await expect(
      db.projectAssetReference.create({
        data: {
          id: `asset-impact-reference-b-${suffix}`,
          projectId: ids.project,
          technicalAssetId: ids.recallAsset,
          assetReleaseId: second.releaseId,
          assetReleaseVersionId: second.releaseVersionId,
          releaseCode: `REL-CARDINALITY-B-${suffix}`.toUpperCase(),
          releaseRevision: 1,
          snapshotChecksum: checksum,
          sourceWatermark: `watermark-${`REL-CARDINALITY-B-${suffix}`.toUpperCase()}`,
          createdById: ids.actor
        }
      })
    ).resolves.toMatchObject({ status: "ACTIVE" });
    await expect(
      db.$queryRaw<{ source: string }[]>`SELECT 'ASSET_IMPACT'::"AlertSourceType" AS source`
    ).resolves.toEqual([{ source: "ASSET_IMPACT" }]);
  });
});
