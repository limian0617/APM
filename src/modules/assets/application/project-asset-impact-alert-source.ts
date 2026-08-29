import type { AssetProjectImpactStatus, Prisma } from "@prisma/client";

export class AssetImpactAlertSourceError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number
  ) {
    super(message);
  }
}

const activeStatuses = new Set<AssetProjectImpactStatus>([
  "OPEN",
  "ACKNOWLEDGED",
  "ASSESSING",
  "UPGRADE_PLANNED",
  "RISK_ACCEPTANCE_PENDING"
]);
const resolvedStatuses = new Set<AssetProjectImpactStatus>([
  "MITIGATED",
  "ACCEPTED_RISK",
  "CLOSED"
]);

function identity(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > 191) {
    throw new AssetImpactAlertSourceError(
      "ASSET_IMPACT_SOURCE_IDENTITY_INVALID",
      `${field} 无效。`,
      422
    );
  }
  return value.trim();
}

function operationalBoolean(snapshot: Prisma.JsonValue, field: string): boolean {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) {
    throw new AssetImpactAlertSourceError(
      "ASSET_IMPACT_SOURCE_SNAPSHOT_INVALID",
      "项目资产影响当前评估快照无效。",
      409
    );
  }
  const value = (snapshot as Record<string, Prisma.JsonValue>)[field];
  if (typeof value !== "boolean") {
    throw new AssetImpactAlertSourceError(
      "ASSET_IMPACT_SOURCE_SNAPSHOT_INVALID",
      `项目资产影响当前评估快照 ${field} 无效。`,
      409
    );
  }
  return value;
}

export async function readAssetImpactAlertSource(
  client: Prisma.TransactionClient,
  input: {
    projectId: unknown;
    impactId: unknown;
    eventAssessmentRevisionId?: unknown | null;
  }
) {
  const projectId = identity(input.projectId, "projectId");
  const impactId = identity(input.impactId, "impactId");
  const eventAssessmentRevisionId =
    input.eventAssessmentRevisionId === null || input.eventAssessmentRevisionId === undefined
      ? null
      : identity(input.eventAssessmentRevisionId, "eventAssessmentRevisionId");

  const [project] = await client.$queryRaw<Array<{ id: string; status: string }>>`
    SELECT "id", "status"::text AS "status"
    FROM "projects"
    WHERE "id" = ${projectId}
    FOR UPDATE
  `;
  if (!project) {
    throw new AssetImpactAlertSourceError(
      "ASSET_IMPACT_SOURCE_NOT_FOUND",
      "项目资产影响不存在或不属于该项目。",
      404
    );
  }

  const [lockedImpact] = await client.$queryRaw<Array<{ id: string }>>`
    SELECT "id"
    FROM "asset_project_impacts"
    WHERE "id" = ${impactId} AND "project_id" = ${projectId}
    FOR UPDATE
  `;
  if (!lockedImpact) {
    throw new AssetImpactAlertSourceError(
      "ASSET_IMPACT_SOURCE_NOT_FOUND",
      "项目资产影响不存在或不属于该项目。",
      404
    );
  }

  const impact = await client.assetProjectImpact.findFirst({
    where: { id: impactId, projectId },
    select: {
      id: true,
      projectId: true,
      technicalAssetId: true,
      sourceType: true,
      sourceKey: true,
      status: true,
      version: true,
      currentAssessmentRevisionId: true
    }
  });
  if (!impact?.currentAssessmentRevisionId) {
    throw new AssetImpactAlertSourceError(
      "ASSET_IMPACT_SOURCE_NOT_READY",
      "项目资产影响缺少当前评估修订。",
      409
    );
  }

  const assessment = await client.assetImpactAssessmentRevision.findFirst({
    where: {
      id: impact.currentAssessmentRevisionId,
      impactId: impact.id,
      projectId,
      technicalAssetId: impact.technicalAssetId
    },
    select: {
      id: true,
      impactId: true,
      projectId: true,
      technicalAssetId: true,
      sequence: true,
      snapshotChecksum: true,
      sourceWatermark: true,
      frozenAt: true,
      ownerMembershipId: true,
      dueAt: true,
      snapshotJson: true
    }
  });
  if (!assessment) {
    throw new AssetImpactAlertSourceError(
      "ASSET_IMPACT_SOURCE_NOT_READY",
      "项目资产影响当前评估修订无效。",
      409
    );
  }

  if (eventAssessmentRevisionId && eventAssessmentRevisionId !== assessment.id) {
    const eventAssessment = await client.assetImpactAssessmentRevision.findFirst({
      where: {
        id: eventAssessmentRevisionId,
        impactId: impact.id,
        projectId,
        technicalAssetId: impact.technicalAssetId
      },
      select: { id: true }
    });
    if (!eventAssessment) {
      throw new AssetImpactAlertSourceError(
        "ASSET_IMPACT_EVENT_RELATION_INVALID",
        "资产影响事件评估修订与当前项目资产影响不一致。",
        409
      );
    }
  }

  const desiredState = activeStatuses.has(impact.status)
    ? "ACTIVE"
    : resolvedStatuses.has(impact.status)
      ? "RESOLVED"
      : null;
  if (!desiredState) {
    throw new AssetImpactAlertSourceError(
      "ASSET_IMPACT_SOURCE_STATUS_INVALID",
      "项目资产影响状态无法投影为预警。",
      409
    );
  }
  const historicalOnly = operationalBoolean(assessment.snapshotJson, "historicalOnly");
  const manualAssignmentRequired = operationalBoolean(
    assessment.snapshotJson,
    "manualAssignmentRequired"
  );

  return {
    projectId,
    projectStatus: project.status,
    impactId: impact.id,
    impactVersion: impact.version,
    technicalAssetId: impact.technicalAssetId,
    impactSourceType: impact.sourceType,
    impactSourceKey: impact.sourceKey,
    impactStatus: impact.status,
    assessmentRevisionId: assessment.id,
    assessmentSequence: assessment.sequence,
    snapshotChecksum: assessment.snapshotChecksum,
    sourceWatermark: assessment.sourceWatermark,
    frozenAt: assessment.frozenAt,
    ownerMembershipId: assessment.ownerMembershipId,
    dueAt: assessment.dueAt,
    historicalOnly,
    manualAssignmentRequired,
    alertSourceKey: `ASSET_IMPACT:${impact.id}`,
    desiredState
  } as const;
}

export type AssetImpactAlertSource = Awaited<ReturnType<typeof readAssetImpactAlertSource>>;
