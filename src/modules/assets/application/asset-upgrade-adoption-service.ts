import { Prisma, type AssetProjectImpactStatus } from "@prisma/client";
import { createHash } from "node:crypto";

import type { AuthorizationActor } from "@/lib/auth/authorize";
import { db, inTransaction } from "@/lib/db";
import type { AuditContext } from "@/modules/audit/contracts/audit";
import {
  ASSET_UPGRADE_IMPACT_AUDIT_FIELDS,
  AUDIT_ACTIONS,
  AUDIT_OBJECT_TYPES,
  AUDIT_RESULTS
} from "@/modules/audit/domain/vocabulary";
import { writeAudit } from "@/modules/audit/infrastructure/write-audit";
import { payloadHash } from "@/modules/governance/domain/idempotency";
import { appendOutboxEvent } from "@/modules/governance/infrastructure/outbox";

import {
  assertImpactAssessmentCurrent,
  lockImpactSource,
  ProjectAssetImpactServiceError
} from "./project-asset-impact-service";
import {
  assertSourceFilesAvailableAndAuthorized,
  createProjectAssetReference,
  createProjectAssetUsage,
  retireProjectAssetReference,
  retireProjectAssetUsage
} from "./project-asset-usage-service";
import { ProjectAssetUsageError } from "../domain/project-asset-usage";

type Client = Prisma.TransactionClient;
type AdoptionMapping = {
  sourceUsageId: string;
  sourceUsageVersion: number;
  targetUsageKey: string;
  targetComponentSnapshotId: string;
  migrationMode: "COPY" | "OVERRIDE";
  quantity?: string;
  configuration?: unknown;
  scopeType?: string;
  scopeId?: string;
  deliveryUnitId?: string | null;
  moduleId?: string | null;
};

type AdoptionInput = {
  projectId: string;
  candidateId: string;
  impactId: string;
  impactVersion: number;
  sourceReferenceId: string;
  sourceReferenceVersion: number;
  reason: string;
  mappings: AdoptionMapping[];
  actorId: string;
  authorizationActor: AuthorizationActor;
  auditContext: AuditContext;
};

function error(code: string, message: string, status = 409): never {
  throw new ProjectAssetImpactServiceError(code, message, status);
}

function childContext(context: AuditContext, suffix: string, reason: string): AuditContext {
  const base = context.operationId ?? "asset-upgrade-adoption";
  const tail = `:${suffix}`;
  const operationId =
    base.length + tail.length <= 191
      ? `${base}${tail}`
      : `${base.slice(0, 191 - tail.length - 17)}:${createHash("sha256")
          .update(base)
          .digest("hex")
          .slice(0, 16)}${tail}`;
  return { ...context, operationId, reason };
}

function positiveVersion(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    error("ASSET_UPGRADE_USAGE_MAPPING_INVALID", `${field}必须是正整数。`, 422);
  }
  return value as number;
}

function text(value: unknown, field: string, max = 191): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > max) {
    error("ASSET_UPGRADE_USAGE_MAPPING_INVALID", `${field}格式无效。`, 422);
  }
  return value.trim();
}

function actorMembershipSnapshot(member: {
  id: string;
  userId: string;
  projectRole: string;
  departmentId: string | null;
  version: number;
}) {
  return {
    membershipId: member.id,
    userId: member.userId,
    projectRole: member.projectRole,
    departmentId: member.departmentId,
    version: member.version
  };
}

async function databaseNow(client: Client) {
  const [row] = await client.$queryRaw<Array<{ now: Date }>>`SELECT CURRENT_TIMESTAMP AS "now"`;
  if (!row) throw new Error("无法读取数据库时间。");
  return row.now;
}

function mapDatabaseError(caught: unknown): never {
  if (caught instanceof ProjectAssetImpactServiceError) throw caught;
  if (caught instanceof Prisma.PrismaClientKnownRequestError) {
    if (caught.code === "P2025") {
      error("ASSET_UPGRADE_IMPACT_NOT_FOUND", "升级采用关系不存在或不可访问。", 404);
    }
    if (
      caught.code === "P2002" ||
      caught.code === "P2003" ||
      caught.code === "P2004" ||
      caught.code === "P2034"
    ) {
      error("ASSET_UPGRADE_IMPACT_RELATION_CONFLICT", "升级采用关系或状态发生冲突。", 409);
    }
  }
  throw caught;
}

export async function recordAssetUpgradeAdoptionFailure(input: {
  projectId: string;
  objectId: string;
  context: AuditContext;
  error: unknown;
}) {
  if (
    !(input.error instanceof ProjectAssetImpactServiceError) &&
    !(input.error instanceof ProjectAssetUsageError) &&
    !(input.error instanceof Prisma.PrismaClientKnownRequestError)
  ) {
    return;
  }
  const reason =
    input.error instanceof Prisma.PrismaClientKnownRequestError
      ? `PRISMA_${input.error.code}`
      : input.error.code;
  await writeAudit(db, {
    action: AUDIT_ACTIONS.ASSET_UPGRADE_ADOPTED,
    objectType: AUDIT_OBJECT_TYPES.ASSET_UPGRADE_ADOPTION,
    objectId: input.objectId,
    result: AUDIT_RESULTS.FAILURE,
    context: { ...input.context, projectId: input.projectId, reason },
    after: {
      value: { projectId: input.projectId, reason },
      allowedFields: ASSET_UPGRADE_IMPACT_AUDIT_FIELDS
    }
  });
}

export async function adoptProjectAssetUpgrade(input: AdoptionInput, transaction?: Client) {
  try {
    return await inTransaction(transaction, async (client) => {
      const reason = text(input.reason, "reason", 1024);
      if (
        input.authorizationActor.id !== input.actorId ||
        input.authorizationActor.status !== "ACTIVE"
      ) {
        error("ASSET_IMPACT_ACTOR_INVALID", "资产升级采用操作人无效。", 403);
      }

      await client.$queryRaw`SELECT "id" FROM "projects" WHERE "id" = ${input.projectId} FOR UPDATE`;
      const project = await client.project.findUnique({
        where: { id: input.projectId },
        select: { id: true, status: true, version: true }
      });
      if (!project) error("PROJECT_NOT_FOUND", "项目不存在。", 404);
      if (project.status === "CLOSED" || project.status === "CANCELED") {
        error("PROJECT_READ_ONLY", "已关闭或取消项目不可执行升级采用。", 409);
      }

      const actorMembership = await client.projectMember.findFirst({
        where: {
          projectId: input.projectId,
          userId: input.actorId,
          leftAt: null,
          user: { status: "ACTIVE" }
        },
        orderBy: { id: "asc" }
      });
      if (!actorMembership)
        error("ASSET_IMPACT_ACTOR_MEMBERSHIP_REQUIRED", "操作人不是有效项目成员。", 403);

      const sourceReferenceIdentity = await client.projectAssetReference.findFirst({
        where: {
          id: input.sourceReferenceId,
          projectId: input.projectId
        },
        select: { id: true }
      });
      if (!sourceReferenceIdentity)
        error("PROJECT_ASSET_REFERENCE_NOT_FOUND", "源资产引用不存在。", 404);
      await client.$queryRaw`SELECT "id" FROM "project_asset_references" WHERE "id" = ${sourceReferenceIdentity.id} AND "project_id" = ${input.projectId} FOR UPDATE`;
      const sourceReference = await client.projectAssetReference.findFirst({
        where: {
          id: sourceReferenceIdentity.id,
          projectId: input.projectId
        }
      });
      if (!sourceReference) error("PROJECT_ASSET_REFERENCE_NOT_FOUND", "源资产引用不存在。", 404);
      if (
        sourceReference.version !==
        positiveVersion(input.sourceReferenceVersion, "sourceReferenceVersion")
      ) {
        error("ASSET_UPGRADE_SOURCE_REFERENCE_VERSION_CONFLICT", "源资产引用版本冲突。", 409);
      }
      if (sourceReference.status !== "ACTIVE")
        error("PROJECT_ASSET_REFERENCE_RETIRED", "源资产引用已退役。", 409);

      await client.$queryRaw`SELECT "id" FROM "project_asset_usages" WHERE "project_id" = ${input.projectId} AND "reference_id" = ${sourceReference.id} AND "status" = 'ACTIVE' ORDER BY "id" FOR UPDATE`;
      const usages = await client.projectAssetUsage.findMany({
        where: {
          projectId: input.projectId,
          referenceId: sourceReference.id,
          technicalAssetId: sourceReference.technicalAssetId,
          status: "ACTIVE"
        },
        orderBy: { id: "asc" }
      });

      const candidateIdentity = await client.assetUpgradeCandidate.findUnique({
        where: { id: input.candidateId },
        select: {
          id: true,
          technicalAssetId: true,
          sourceAssetReleaseId: true,
          sourceAssetReleaseVersionId: true,
          targetAssetReleaseId: true,
          targetAssetReleaseVersionId: true
        }
      });
      if (!candidateIdentity) error("ASSET_UPGRADE_CANDIDATE_NOT_FOUND", "升级候选不存在。", 404);
      const assetIdentity = await client.technicalAsset.findUnique({
        where: { id: candidateIdentity.technicalAssetId },
        select: { rndProjectId: true }
      });
      if (!assetIdentity) error("TECHNICAL_ASSET_NOT_FOUND", "技术资产不存在。", 404);
      const impactIdentity = await client.assetProjectImpact.findFirst({
        where: {
          id: input.impactId,
          projectId: input.projectId,
          technicalAssetId: candidateIdentity.technicalAssetId
        },
        select: {
          id: true,
          technicalAssetId: true,
          recallId: true,
          technicalAssetEventId: true
        }
      });
      if (!impactIdentity) error("ASSET_PROJECT_IMPACT_NOT_FOUND", "项目资产影响不存在。", 404);
      await client.$queryRaw`SELECT "id" FROM "rnd_projects" WHERE "id" = ${assetIdentity.rndProjectId} FOR UPDATE`;
      await client.$queryRaw`SELECT "id" FROM "technical_assets" WHERE "id" = ${candidateIdentity.technicalAssetId} FOR UPDATE`;
      const releaseIds = [
        ...new Set([candidateIdentity.sourceAssetReleaseId, candidateIdentity.targetAssetReleaseId])
      ].sort();
      await client.$queryRaw`SELECT "id" FROM "asset_releases" WHERE "technical_asset_id" = ${candidateIdentity.technicalAssetId} AND "id" IN (${Prisma.join(releaseIds)}) ORDER BY "id" FOR UPDATE`;
      const releaseVersionIds = [
        ...new Set([
          candidateIdentity.sourceAssetReleaseVersionId,
          candidateIdentity.targetAssetReleaseVersionId
        ])
      ].sort();
      await client.$queryRaw`SELECT "id" FROM "asset_release_versions" WHERE "technical_asset_id" = ${candidateIdentity.technicalAssetId} AND "id" IN (${Prisma.join(releaseVersionIds)}) ORDER BY "id" FOR UPDATE`;
      await lockImpactSource(client, impactIdentity);
      const targetRecallRows = await client.$queryRaw<Array<{ id: string }>>`
        SELECT recall."id"
          FROM "asset_release_recalls" recall
          JOIN "asset_release_recall_revisions" revision
            ON revision."id" = recall."current_revision_id"
          JOIN "asset_release_recall_affected_versions" affected
            ON affected."recall_id" = recall."id"
         WHERE recall."technical_asset_id" = ${candidateIdentity.technicalAssetId}
           AND recall."current_state" = 'ACTIVE'
           AND revision."state" = 'ACTIVE'
           AND affected."asset_release_version_id" = ${candidateIdentity.targetAssetReleaseVersionId}
         ORDER BY recall."id"
         FOR UPDATE OF recall, revision
      `;
      if (targetRecallRows.length)
        error("ASSET_UPGRADE_TARGET_ACTIVE_RECALL", "目标版本存在活动召回。", 409);
      await client.$queryRaw`SELECT "id" FROM "asset_upgrade_candidates" WHERE "id" = ${candidateIdentity.id} AND "technical_asset_id" = ${candidateIdentity.technicalAssetId} FOR UPDATE`;
      const candidate = await client.assetUpgradeCandidate.findUnique({
        where: { id: candidateIdentity.id },
        select: {
          id: true,
          technicalAssetId: true,
          sourceAssetReleaseId: true,
          sourceAssetReleaseVersionId: true,
          sourceRevision: true,
          sourceSnapshotChecksum: true,
          sourceWatermark: true,
          targetAssetReleaseId: true,
          targetAssetReleaseVersionId: true,
          targetRevision: true,
          targetSnapshotChecksum: true,
          targetWatermark: true
        }
      });
      if (!candidate) error("ASSET_UPGRADE_CANDIDATE_NOT_FOUND", "升级候选不存在。", 404);
      if (
        sourceReference.technicalAssetId !== candidate.technicalAssetId ||
        sourceReference.assetReleaseId !== candidate.sourceAssetReleaseId ||
        sourceReference.assetReleaseVersionId !== candidate.sourceAssetReleaseVersionId
      ) {
        error("PROJECT_ASSET_REFERENCE_NOT_FOUND", "源资产引用不存在。", 404);
      }

      await client.$queryRaw`SELECT "id" FROM "asset_project_impacts" WHERE "id" = ${impactIdentity.id} AND "project_id" = ${input.projectId} FOR UPDATE`;
      const impact = await client.assetProjectImpact.findFirst({
        where: {
          id: impactIdentity.id,
          projectId: input.projectId,
          technicalAssetId: candidate.technicalAssetId
        },
        include: { currentAssessmentRevision: true, ownerMembership: true }
      });
      if (!impact) error("ASSET_PROJECT_IMPACT_NOT_FOUND", "项目资产影响不存在。", 404);
      if (impact.version !== positiveVersion(input.impactVersion, "impactVersion")) {
        error("ASSET_IMPACT_VERSION_CONFLICT", "项目资产影响版本冲突。", 409);
      }
      if (impact.status !== "UPGRADE_PLANNED") {
        error(
          "ASSET_IMPACT_TRANSITION_INVALID",
          "只有 UPGRADE_PLANNED 影响可以执行升级采用。",
          409
        );
      }

      const asset = await client.technicalAsset.findUnique({
        where: { id: candidate.technicalAssetId },
        include: { rndProject: true }
      });
      if (!asset) error("TECHNICAL_ASSET_NOT_FOUND", "技术资产不存在。", 404);
      if (
        asset.status !== "VALIDATED" ||
        asset.rndProject.status === "COMPLETED" ||
        asset.rndProject.status === "CANCELED"
      ) {
        error("ASSET_SOURCE_NOT_READY", "当前技术资产状态不允许升级采用。", 409);
      }

      const targetVersion = await client.assetReleaseVersion.findFirst({
        where: {
          id: candidate.targetAssetReleaseVersionId,
          releaseId: candidate.targetAssetReleaseId,
          technicalAssetId: candidate.technicalAssetId
        }
      });
      const targetRelease = await client.assetRelease.findFirst({
        where: { id: candidate.targetAssetReleaseId, technicalAssetId: candidate.technicalAssetId }
      });
      if (!targetVersion || !targetRelease)
        error("ASSET_RELEASE_VERSION_NOT_FOUND", "目标 ReleaseVersion 不存在。", 404);
      if (targetVersion.status !== "PUBLISHED") {
        error(
          "ASSET_UPGRADE_TARGET_VERSION_NOT_PUBLISHED",
          "目标 ReleaseVersion 必须为 PUBLISHED。",
          409
        );
      }
      await assertImpactAssessmentCurrent(client, impact);
      const owner = impact.ownerMembership;
      const assessment = impact.currentAssessmentRevision;
      if (
        !owner ||
        !assessment ||
        !assessment.ownerMembershipId ||
        !assessment.ownerMembershipSnapshotJson ||
        !assessment.dueAt
      ) {
        error("ASSET_IMPACT_OWNER_REQUIRED", "升级采用缺少当前项目 Owner 评估事实。", 409);
      }
      const historicalTargetReference = await client.projectAssetReference.findFirst({
        where: {
          projectId: input.projectId,
          technicalAssetId: candidate.technicalAssetId,
          assetReleaseVersionId: targetVersion.id
        },
        select: { id: true }
      });
      if (historicalTargetReference) {
        error(
          "ASSET_UPGRADE_TARGET_ALREADY_REFERENCED",
          "项目历史上已引用目标 ReleaseVersion。",
          409
        );
      }
      const existingAdoption = await client.assetUpgradeAdoption.findFirst({
        where: { projectId: input.projectId, sourceReferenceId: sourceReference.id },
        select: { id: true }
      });
      if (existingAdoption) {
        error("ASSET_UPGRADE_ADOPTION_ALREADY_EXISTS", "源资产引用已经完成升级采用。", 409);
      }

      await assertSourceFilesAvailableAndAuthorized(client, {
        technicalAssetId: candidate.technicalAssetId,
        assetReleaseVersionIds: [candidate.sourceAssetReleaseVersionId, targetVersion.id],
        authorizationActor: input.authorizationActor
      });

      const mappingBySource = new Map<string, AdoptionMapping>();
      const targetKeys = new Set<string>();
      for (const mapping of input.mappings ?? []) {
        if (mappingBySource.has(mapping.sourceUsageId)) {
          error("ASSET_UPGRADE_USAGE_MAPPING_INVALID", "同一源 usage 不得重复映射。", 422);
        }
        const key = text(mapping.targetUsageKey, "targetUsageKey");
        if (targetKeys.has(key))
          error("ASSET_UPGRADE_USAGE_MAPPING_INVALID", "targetUsageKey 不得重复。", 422);
        targetKeys.add(key);
        mappingBySource.set(mapping.sourceUsageId, { ...mapping, targetUsageKey: key });
      }
      if (
        mappingBySource.size !== usages.length ||
        usages.some((usage) => !mappingBySource.has(usage.id))
      ) {
        error(
          "ASSET_UPGRADE_USAGE_MAPPING_INCOMPLETE",
          "映射必须完整覆盖全部 ACTIVE source usage。",
          409
        );
      }
      for (const key of targetKeys) {
        const existing = await client.projectAssetUsage.findFirst({
          where: { projectId: input.projectId, usageKey: key },
          select: { id: true }
        });
        if (existing)
          error("ASSET_UPGRADE_USAGE_KEY_CONFLICT", "targetUsageKey 已被项目历史事实使用。", 409);
      }

      let targetUsageIndex = 0;
      for (const mapping of mappingBySource.values()) {
        const sourceUsage = usages.find((usage) => usage.id === mapping.sourceUsageId)!;
        if (
          sourceUsage.version !== positiveVersion(mapping.sourceUsageVersion, "sourceUsageVersion")
        ) {
          error("ASSET_UPGRADE_SOURCE_USAGE_VERSION_CONFLICT", "源 usage 版本冲突。", 409);
        }
        const targetComponent = await client.assetComponentSnapshot.findFirst({
          where: {
            id: mapping.targetComponentSnapshotId,
            releaseVersionId: targetVersion.id,
            technicalAssetId: candidate.technicalAssetId
          }
        });
        if (!targetComponent)
          error(
            "ASSET_UPGRADE_USAGE_MAPPING_INVALID",
            "目标组件不属于目标 exact ReleaseVersion。",
            409
          );
        if (
          mapping.migrationMode === "COPY" &&
          [
            mapping.quantity,
            mapping.configuration,
            mapping.scopeType,
            mapping.scopeId,
            mapping.deliveryUnitId,
            mapping.moduleId
          ].some((value) => value !== undefined)
        ) {
          error("ASSET_UPGRADE_USAGE_MAPPING_INVALID", "COPY 映射不得包含 override 字段。", 422);
        }
        if (
          mapping.migrationMode === "OVERRIDE" &&
          [mapping.quantity, mapping.configuration, mapping.scopeType, mapping.scopeId].some(
            (value) => value === undefined
          )
        ) {
          error(
            "ASSET_UPGRADE_USAGE_MAPPING_INVALID",
            "OVERRIDE 映射必须提供完整 override 字段。",
            422
          );
        }
      }

      const targetReferenceResult = await createProjectAssetReference(
        {
          projectId: input.projectId,
          assetReleaseId: targetRelease.id,
          assetReleaseVersionId: targetVersion.id,
          projectVersion: project.version,
          actorId: input.actorId,
          reason,
          authorizationActor: input.authorizationActor,
          auditContext: childContext(input.auditContext, "target-reference", reason)
        },
        client
      );
      const targetReferenceId = targetReferenceResult.reference.id;
      const targetUsages: Array<{
        id: string;
        usageKey: string;
        version: number;
        quantity: string;
        configuration: unknown;
        scopeType: string;
        scopeId: string;
        deliveryUnitId: string | null;
        moduleId: string | null;
      }> = [];
      const mappingRows: Array<{
        source: (typeof usages)[number];
        mapping: AdoptionMapping;
        target: (typeof targetUsages)[number];
        componentId: string;
      }> = [];
      for (const mapping of mappingBySource.values()) {
        const source = usages.find((usage) => usage.id === mapping.sourceUsageId)!;
        const copied = mapping.migrationMode === "COPY";
        const targetUsageResult = await createProjectAssetUsage(
          {
            projectId: input.projectId,
            referenceId: targetReferenceId,
            usageKey: mapping.targetUsageKey,
            referenceVersion: targetReferenceResult.resourceVersion,
            componentSnapshotId: mapping.targetComponentSnapshotId,
            quantity: copied ? source.quantity.toString() : mapping.quantity!,
            configuration: copied ? source.configurationJson : mapping.configuration,
            scopeType: copied ? source.scopeType : mapping.scopeType!,
            scopeId: copied ? source.scopeId : mapping.scopeId!,
            deliveryUnitId: copied ? source.deliveryUnitId : mapping.deliveryUnitId,
            moduleId: copied ? source.moduleId : mapping.moduleId,
            actorId: input.actorId,
            reason,
            authorizationActor: input.authorizationActor,
            auditContext: childContext(
              input.auditContext,
              `target-usage-${++targetUsageIndex}`,
              reason
            )
          },
          client
        );
        targetUsages.push({
          id: targetUsageResult.usage.id,
          usageKey: mapping.targetUsageKey,
          version: targetUsageResult.resourceVersion,
          quantity: targetUsageResult.usage.quantity,
          configuration: targetUsageResult.usage.configuration,
          scopeType: targetUsageResult.usage.scopeType,
          scopeId: targetUsageResult.usage.scopeId,
          deliveryUnitId: targetUsageResult.usage.deliveryUnitId,
          moduleId: targetUsageResult.usage.moduleId
        });
        mappingRows.push({
          source,
          mapping,
          target: targetUsages.at(-1)!,
          componentId: mapping.targetComponentSnapshotId
        });
      }

      const now = await databaseNow(client);
      const adoption = await client.assetUpgradeAdoption.create({
        data: {
          candidateId: candidate.id,
          projectId: input.projectId,
          impactId: impact.id,
          technicalAssetId: candidate.technicalAssetId,
          sourceReferenceId: sourceReference.id,
          sourceReferenceVersion: sourceReference.version,
          targetReferenceId,
          targetReferenceVersion: targetReferenceResult.resourceVersion,
          sourceAssetReleaseId: candidate.sourceAssetReleaseId,
          sourceAssetReleaseVersionId: candidate.sourceAssetReleaseVersionId,
          sourceRevision: candidate.sourceRevision,
          sourceSnapshotChecksum: candidate.sourceSnapshotChecksum,
          sourceWatermark: candidate.sourceWatermark,
          targetAssetReleaseId: candidate.targetAssetReleaseId,
          targetAssetReleaseVersionId: candidate.targetAssetReleaseVersionId,
          targetRevision: candidate.targetRevision,
          targetSnapshotChecksum: candidate.targetSnapshotChecksum,
          targetWatermark: candidate.targetWatermark,
          reason,
          actorId: input.actorId,
          adoptedAt: now
        }
      });

      for (const row of mappingRows) {
        const snapshot = payloadHash({
          adoptionId: adoption.id,
          migrationMode: row.mapping.migrationMode,
          source: {
            usageId: row.source.id,
            usageVersion: row.source.version,
            usageKey: row.source.usageKey,
            referenceId: sourceReference.id,
            referenceVersion: sourceReference.version,
            releaseId: candidate.sourceAssetReleaseId,
            releaseVersionId: candidate.sourceAssetReleaseVersionId,
            revision: candidate.sourceRevision,
            snapshotChecksum: candidate.sourceSnapshotChecksum,
            sourceWatermark: candidate.sourceWatermark,
            componentSnapshotId: row.source.componentSnapshotId,
            quantity: row.source.quantity.toString(),
            configuration: row.source.configurationJson,
            scopeType: row.source.scopeType,
            scopeId: row.source.scopeId,
            deliveryUnitId: row.source.deliveryUnitId,
            moduleId: row.source.moduleId
          },
          target: {
            usageId: row.target.id,
            usageVersion: row.target.version,
            usageKey: row.target.usageKey,
            referenceId: targetReferenceId,
            referenceVersion: targetReferenceResult.resourceVersion,
            releaseId: candidate.targetAssetReleaseId,
            releaseVersionId: candidate.targetAssetReleaseVersionId,
            revision: candidate.targetRevision,
            snapshotChecksum: candidate.targetSnapshotChecksum,
            sourceWatermark: candidate.targetWatermark,
            componentSnapshotId: row.componentId,
            quantity: row.target.quantity,
            configuration: row.target.configuration,
            scopeType: row.target.scopeType,
            scopeId: row.target.scopeId,
            deliveryUnitId: row.target.deliveryUnitId,
            moduleId: row.target.moduleId
          },
          sourceUsageId: row.source.id,
          sourceUsageVersion: row.source.version,
          sourceUsageKey: row.source.usageKey,
          sourceReferenceId: sourceReference.id,
          sourceReferenceVersion: sourceReference.version,
          targetUsageId: row.target.id,
          targetUsageVersion: row.target.version,
          targetUsageKey: row.target.usageKey,
          targetReferenceId,
          targetReferenceVersion: targetReferenceResult.resourceVersion,
          sourceReleaseId: candidate.sourceAssetReleaseId,
          sourceReleaseVersionId: candidate.sourceAssetReleaseVersionId,
          sourceRevision: candidate.sourceRevision,
          sourceSnapshotChecksum: candidate.sourceSnapshotChecksum,
          sourceWatermark: candidate.sourceWatermark,
          targetReleaseId: candidate.targetAssetReleaseId,
          targetReleaseVersionId: candidate.targetAssetReleaseVersionId,
          targetRevision: candidate.targetRevision,
          targetSnapshotChecksum: candidate.targetSnapshotChecksum,
          targetWatermark: candidate.targetWatermark,
          sourceComponentSnapshotId: row.source.componentSnapshotId,
          targetComponentSnapshotId: row.componentId,
          quantity: row.target.quantity,
          configuration: row.target.configuration,
          scopeType: row.target.scopeType,
          scopeId: row.target.scopeId,
          deliveryUnitId: row.target.deliveryUnitId,
          moduleId: row.target.moduleId
        });
        await client.assetUpgradeUsageMapping.create({
          data: {
            adoptionId: adoption.id,
            projectId: input.projectId,
            technicalAssetId: candidate.technicalAssetId,
            sourceUsageId: row.source.id,
            sourceUsageVersion: row.source.version,
            sourceReferenceId: sourceReference.id,
            sourceAssetReleaseId: candidate.sourceAssetReleaseId,
            sourceAssetReleaseVersionId: candidate.sourceAssetReleaseVersionId,
            sourceComponentSnapshotId: row.source.componentSnapshotId,
            targetUsageId: row.target.id,
            targetUsageKey: row.target.usageKey,
            targetUsageVersion: row.target.version,
            targetReferenceId,
            targetAssetReleaseId: candidate.targetAssetReleaseId,
            targetAssetReleaseVersionId: candidate.targetAssetReleaseVersionId,
            targetComponentSnapshotId: row.componentId,
            migrationMode: row.mapping.migrationMode,
            mappingSnapshotJson: snapshot.value as Prisma.InputJsonValue,
            mappingSnapshotChecksum: snapshot.hash
          }
        });
      }

      for (const [index, usage] of usages.entries()) {
        await retireProjectAssetUsage(
          {
            projectId: input.projectId,
            usageId: usage.id,
            version: usage.version,
            actorId: input.actorId,
            reason,
            authorizationActor: input.authorizationActor,
            auditContext: childContext(input.auditContext, `source-usage-${index + 1}`, reason)
          },
          client
        );
      }
      await retireProjectAssetReference(
        {
          projectId: input.projectId,
          referenceId: sourceReference.id,
          version: sourceReference.version,
          actorId: input.actorId,
          reason,
          authorizationActor: input.authorizationActor,
          auditContext: childContext(input.auditContext, "source-reference", reason)
        },
        client
      );

      const sequence =
        (await client.assetImpactDisposition.count({ where: { impactId: impact.id } })) + 1;
      const disposition = await client.assetImpactDisposition.create({
        data: {
          impactId: impact.id,
          projectId: input.projectId,
          technicalAssetId: candidate.technicalAssetId,
          assessmentRevisionId: assessment.id,
          sequence,
          type: "MITIGATED",
          fromStatus: "UPGRADE_PLANNED",
          toStatus: "MITIGATED",
          reason,
          evidenceJson: { adoptionId: adoption.id } as Prisma.InputJsonValue,
          actorId: input.actorId,
          actorMembershipId: actorMembership.id,
          actorMembershipSnapshotJson: actorMembershipSnapshot(actorMembership),
          ownerMembershipId: owner.id,
          ownerMembershipSnapshotJson:
            assessment.ownerMembershipSnapshotJson as Prisma.InputJsonValue,
          dueAt: assessment.dueAt,
          mitigationAdoptionId: adoption.id
        }
      });
      const updatedImpact = await client.assetProjectImpact.update({
        where: { id: impact.id },
        data: { status: "MITIGATED", version: { increment: 1 } }
      });
      const facts = {
        projectId: input.projectId,
        impactId: impact.id,
        technicalAssetId: candidate.technicalAssetId,
        adoptionId: adoption.id,
        sourceReferenceId: sourceReference.id,
        targetReferenceId,
        sourceReferenceVersion: sourceReference.version,
        targetReferenceVersion: targetReferenceResult.resourceVersion,
        mappingCount: mappingRows.length,
        targetUsageCount: targetUsages.length,
        dispositionId: disposition.id,
        fromStatus: "UPGRADE_PLANNED" as AssetProjectImpactStatus,
        toStatus: updatedImpact.status,
        resourceVersion: updatedImpact.version,
        reason
      };
      const audit = await writeAudit(client, {
        action: AUDIT_ACTIONS.ASSET_UPGRADE_ADOPTED,
        objectType: AUDIT_OBJECT_TYPES.ASSET_UPGRADE_ADOPTION,
        objectId: adoption.id,
        context: {
          ...input.auditContext,
          actorId: input.actorId,
          projectId: input.projectId,
          reason
        },
        after: { value: facts, allowedFields: ASSET_UPGRADE_IMPACT_AUDIT_FIELDS }
      });
      const outbox = await appendOutboxEvent(client, {
        eventType: "project.asset-upgrade.adopted",
        aggregateType: "ASSET_UPGRADE_ADOPTION",
        aggregateId: adoption.id,
        idempotencyKey: `asset-upgrade-adoption:${adoption.id}`,
        payload: facts
      });
      return {
        item: { ...adoption, resourceVersion: 1, allowedActions: [] },
        adoption: { ...adoption, resourceVersion: 1, allowedActions: [] },
        impact: { ...updatedImpact, resourceVersion: updatedImpact.version },
        resourceVersion: 1,
        allowedActions: [],
        auditId: audit.id,
        outboxEventId: outbox.id
      };
    });
  } catch (caught) {
    mapDatabaseError(caught);
  }
}
