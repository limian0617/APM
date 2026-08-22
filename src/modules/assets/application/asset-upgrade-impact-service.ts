import { Prisma } from "@prisma/client";

import type { AuthorizationActor } from "@/lib/auth/authorize";
import { inTransaction } from "@/lib/db";
import type { AuditContext } from "@/modules/audit/contracts/audit";
import {
  ASSET_UPGRADE_IMPACT_AUDIT_FIELDS,
  AUDIT_ACTIONS,
  AUDIT_OBJECT_TYPES
} from "@/modules/audit/domain/vocabulary";
import { writeAudit } from "@/modules/audit/infrastructure/write-audit";
import { payloadHash, type JsonValue } from "@/modules/governance/domain/idempotency";
import { appendOutboxEvent } from "@/modules/governance/infrastructure/outbox";

import {
  assertAssetReleaseRecallRevision,
  assertAssetReleaseRecallRevisionSource,
  assertAssetUpgradeCandidate,
  buildAssetReleaseRecallAffectedVersionSet,
  buildAssetReleaseRecallTargetKey,
  type AssetReleaseRecallRevisionKind,
  type AssetReleaseRecallScope
} from "../domain/asset-upgrade-impact";
import { assertSourceFilesAvailableAndAuthorized } from "./project-asset-usage-service";

type Client = Prisma.TransactionClient;
type Severity = "LOW" | "MEDIUM" | "HIGH";

export class AssetUpgradeImpactServiceError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number
  ) {
    super(message);
  }
}

function text(value: unknown, field: string, maximumLength = 1024) {
  if (typeof value !== "string" || !value.trim() || value.trim().length > maximumLength) {
    throw new AssetUpgradeImpactServiceError("INVALID_INPUT", `${field}格式无效。`, 422);
  }
  return value.trim();
}

function positiveVersion(value: unknown, field: string) {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new AssetUpgradeImpactServiceError("INVALID_INPUT", `${field}必须是正整数。`, 422);
  }
  return value as number;
}

function canonicalObject(value: unknown, field: string): JsonValue {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new AssetUpgradeImpactServiceError(
      "INVALID_INPUT",
      `${field}必须是非空 JSON 对象。`,
      422
    );
  }
  const canonical = payloadHash(value).value;
  if (!canonical || Array.isArray(canonical) || Object.keys(canonical).length === 0) {
    throw new AssetUpgradeImpactServiceError(
      "INVALID_INPUT",
      `${field}必须是非空 JSON 对象。`,
      422
    );
  }
  return canonical;
}

function commandContext(input: {
  auditContext: AuditContext;
  actorId: string;
  reason: string;
  departmentId: string | null;
}): AuditContext {
  return {
    ...input.auditContext,
    actorId: input.actorId,
    reason: input.reason,
    departmentId: input.departmentId,
    projectId: null
  };
}

async function lockAsset(client: Client, technicalAssetId: string) {
  const identity = await client.technicalAsset.findUnique({
    where: { id: technicalAssetId },
    select: { rndProjectId: true }
  });
  if (!identity) {
    throw new AssetUpgradeImpactServiceError(
      "TECHNICAL_ASSET_NOT_FOUND",
      "企业技术资产不存在。",
      404
    );
  }
  await client.$queryRaw`SELECT "id" FROM "rnd_projects" WHERE "id" = ${identity.rndProjectId} FOR UPDATE`;
  await client.$queryRaw`SELECT "id" FROM "technical_assets" WHERE "id" = ${technicalAssetId} FOR UPDATE`;
  const asset = await client.technicalAsset.findUnique({
    where: { id: technicalAssetId },
    include: { rndProject: { select: { status: true, departmentId: true } } }
  });
  if (!asset) {
    throw new AssetUpgradeImpactServiceError(
      "TECHNICAL_ASSET_NOT_FOUND",
      "企业技术资产不存在。",
      404
    );
  }
  return asset;
}

function assertOwner(asset: { ownerId: string }, actor: AuthorizationActor, actorId: string) {
  if (actor.id !== actorId || actor.status !== "ACTIVE" || asset.ownerId !== actorId) {
    throw new AssetUpgradeImpactServiceError(
      "TECHNICAL_ASSET_OWNER_REQUIRED",
      "只有处于启用状态的企业技术资产 Owner 可以执行该命令。",
      403
    );
  }
}

async function lockRelease(client: Client, technicalAssetId: string, releaseId: string) {
  await client.$queryRaw`SELECT "id" FROM "asset_releases" WHERE "id" = ${releaseId} AND "technical_asset_id" = ${technicalAssetId} FOR UPDATE`;
  const release = await client.assetRelease.findFirst({
    where: { id: releaseId, technicalAssetId }
  });
  if (!release) {
    throw new AssetUpgradeImpactServiceError(
      "ASSET_RELEASE_NOT_FOUND",
      "资产 Release 不存在。",
      404
    );
  }
  return release;
}

async function lockReleaseVersions(client: Client, technicalAssetId: string, ids: string[]) {
  const sorted = [...new Set(ids)].sort();
  await client.$queryRaw`SELECT "id" FROM "asset_release_versions" WHERE "technical_asset_id" = ${technicalAssetId} AND "id" IN (${Prisma.join(sorted)}) ORDER BY "id" FOR UPDATE`;
  return client.assetReleaseVersion.findMany({
    where: { technicalAssetId, id: { in: sorted } },
    orderBy: { id: "asc" }
  });
}

function serializeRecall(
  recall: {
    id: string;
    technicalAssetId: string;
    releaseId: string;
    targetReleaseVersionId: string | null;
    targetKey: string;
    scope: string;
    currentRevisionId: string | null;
    currentState: string;
    version: number;
    affectedVersionSetChecksum: string | null;
    createdAt: Date;
    updatedAt: Date;
  },
  canManage = true
) {
  return {
    ...recall,
    createdAt: recall.createdAt.toISOString(),
    updatedAt: recall.updatedAt.toISOString(),
    resourceVersion: recall.version,
    allowedActions: canManage
      ? recall.currentState === "ACTIVE"
        ? ["CORRECT", "WITHDRAW"]
        : ["REISSUE"]
      : []
  };
}

function serializeRecallRevision(revision: {
  id: string;
  recallId: string;
  revision: number;
  kind: string;
  state: string;
  severity: string;
  reason: string;
  snapshotChecksum: string;
  effectiveAt: Date;
}) {
  return { ...revision, effectiveAt: revision.effectiveAt.toISOString() };
}

function serializeCandidate(candidate: {
  id: string;
  technicalAssetId: string;
  sourceAssetReleaseId: string;
  sourceAssetReleaseVersionId: string;
  sourceRevision: number;
  sourceSnapshotChecksum: string;
  sourceWatermark: string;
  targetAssetReleaseId: string;
  targetAssetReleaseVersionId: string;
  targetRevision: number;
  targetSnapshotChecksum: string;
  targetWatermark: string;
  compatibilitySnapshotJson: unknown;
  compatibilitySnapshotChecksum: string;
  createdAt: Date;
}) {
  return {
    ...candidate,
    compatibilitySnapshotJson: candidate.compatibilitySnapshotJson,
    createdAt: candidate.createdAt.toISOString(),
    resourceVersion: 1,
    allowedActions: []
  };
}

function mapDatabaseError(
  error: unknown,
  duplicateCode = "ASSET_UPGRADE_IMPACT_ALREADY_EXISTS"
): never {
  if (error instanceof AssetUpgradeImpactServiceError) throw error;
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    if (error.code === "P2002") {
      throw new AssetUpgradeImpactServiceError(
        duplicateCode,
        "相同目标的资产升级影响事实已存在。",
        409
      );
    }
    if (error.code === "P2025") {
      throw new AssetUpgradeImpactServiceError(
        "ASSET_UPGRADE_IMPACT_NOT_FOUND",
        "资产升级影响事实不存在。",
        404
      );
    }
    if (error.code === "P2003" || error.code === "P2004") {
      throw new AssetUpgradeImpactServiceError(
        "ASSET_UPGRADE_IMPACT_CONFLICT",
        "资产升级影响关系或状态不允许该操作。",
        409
      );
    }
  }
  throw error;
}

export async function createAssetReleaseRecall(
  input: {
    technicalAssetId: string;
    releaseId: string;
    releaseResourceVersion: unknown;
    scope: AssetReleaseRecallScope;
    targetReleaseVersionId?: string | null;
    sourceAssetReleaseVersionId: string;
    severity: Severity;
    reason: unknown;
    evidence: unknown;
    actorId: string;
    authorizationActor: AuthorizationActor;
    auditContext: AuditContext;
  },
  transaction?: Client
) {
  const releaseResourceVersion = positiveVersion(
    input.releaseResourceVersion,
    "releaseResourceVersion"
  );
  const reason = text(input.reason, "reason");
  const evidence = canonicalObject(input.evidence, "evidence");
  try {
    return await inTransaction(transaction, async (client) => {
      const asset = await lockAsset(client, input.technicalAssetId);
      assertOwner(asset, input.authorizationActor, input.actorId);
      const release = await lockRelease(client, asset.id, input.releaseId);
      if (release.version !== releaseResourceVersion) {
        throw new AssetUpgradeImpactServiceError(
          "VERSION_CONFLICT",
          "资产 Release 已发生变化，请刷新后重试。",
          409
        );
      }
      await client.$queryRaw`SELECT "id" FROM "asset_release_versions" WHERE "release_id" = ${release.id} AND "technical_asset_id" = ${asset.id} AND "status" IN ('PUBLISHED', 'SUPERSEDED') ORDER BY "id" FOR UPDATE`;
      const eligible = await client.assetReleaseVersion.findMany({
        where: {
          releaseId: release.id,
          technicalAssetId: asset.id,
          status: { in: ["PUBLISHED", "SUPERSEDED"] }
        },
        orderBy: { id: "asc" }
      });
      const affectedInput =
        input.scope === "RELEASE_VERSION"
          ? eligible.filter((version) => version.id === input.targetReleaseVersionId)
          : eligible;
      const frozen = buildAssetReleaseRecallAffectedVersionSet({
        scope: input.scope,
        releaseId: release.id,
        targetReleaseVersionId: input.targetReleaseVersionId,
        versions: affectedInput.map((version) => ({
          assetReleaseVersionId: version.id,
          releaseId: version.releaseId,
          technicalAssetId: version.technicalAssetId,
          revision: version.revision,
          snapshotChecksum: version.snapshotChecksum,
          sourceWatermark: version.sourceWatermark,
          status: version.status as "PUBLISHED" | "SUPERSEDED"
        }))
      });
      const source = frozen.affectedVersions.find(
        (version) => version.assetReleaseVersionId === input.sourceAssetReleaseVersionId
      );
      if (!source) {
        throw new AssetUpgradeImpactServiceError(
          "RECALL_REVISION_SOURCE_MISMATCH",
          "召回来源版本必须属于冻结 affected-version set。",
          409
        );
      }
      await assertSourceFilesAvailableAndAuthorized(client, {
        technicalAssetId: asset.id,
        assetReleaseVersionIds: frozen.affectedVersions.map(
          ({ assetReleaseVersionId }) => assetReleaseVersionId
        ),
        authorizationActor: input.authorizationActor
      });
      const targetKey = buildAssetReleaseRecallTargetKey({
        scope: input.scope,
        releaseId: release.id,
        releaseVersionId: input.targetReleaseVersionId
      });
      const recall = await client.assetReleaseRecall.create({
        data: {
          technicalAssetId: asset.id,
          releaseId: release.id,
          targetReleaseVersionId:
            input.scope === "RELEASE_VERSION" ? input.targetReleaseVersionId : null,
          targetKey,
          scope: input.scope,
          affectedVersionSetChecksum: frozen.affectedVersionSetChecksum,
          createdById: input.actorId
        }
      });
      await client.assetReleaseRecallAffectedVersion.createMany({
        data: frozen.affectedVersions.map((version) => ({
          recallId: recall.id,
          technicalAssetId: asset.id,
          releaseId: release.id,
          assetReleaseVersionId: version.assetReleaseVersionId,
          revision: version.revision,
          snapshotChecksum: version.snapshotChecksum,
          sourceWatermark: version.sourceWatermark,
          status: version.status
        }))
      });
      const snapshot = payloadHash({
        recallId: recall.id,
        technicalAssetId: asset.id,
        releaseId: release.id,
        scope: input.scope,
        targetKey,
        targetReleaseVersionId: recall.targetReleaseVersionId,
        revision: 1,
        kind: "ISSUED",
        state: "ACTIVE",
        severity: input.severity,
        affectedVersionSetChecksum: frozen.affectedVersionSetChecksum,
        affectedVersions: frozen.affectedVersions,
        sourceAssetReleaseId: source.releaseId,
        sourceAssetReleaseVersionId: source.assetReleaseVersionId,
        sourceRevision: source.revision,
        sourceSnapshotChecksum: source.snapshotChecksum,
        sourceWatermark: source.sourceWatermark,
        evidence
      });
      const revision = await client.assetReleaseRecallRevision.create({
        data: {
          recallId: recall.id,
          technicalAssetId: asset.id,
          revision: 1,
          kind: "ISSUED",
          state: "ACTIVE",
          severity: input.severity,
          reason,
          affectedVersionSetChecksum: frozen.affectedVersionSetChecksum,
          affectedVersionCount: frozen.affectedVersions.length,
          sourceAssetReleaseVersionId: source.assetReleaseVersionId,
          sourceAssetReleaseId: source.releaseId,
          sourceRevision: source.revision,
          sourceSnapshotChecksum: source.snapshotChecksum,
          sourceWatermark: source.sourceWatermark,
          evidenceJson: evidence as Prisma.InputJsonValue,
          snapshotJson: snapshot.value as Prisma.InputJsonValue,
          snapshotChecksum: snapshot.hash,
          actorId: input.actorId
        }
      });
      const updated = await client.assetReleaseRecall.update({
        where: { id: recall.id },
        data: { currentRevisionId: revision.id, currentState: "ACTIVE" }
      });
      const auditFacts = {
        technicalAssetId: asset.id,
        releaseId: release.id,
        recallId: recall.id,
        recallRevisionId: revision.id,
        scope: recall.scope,
        targetKey,
        targetReleaseVersionId: recall.targetReleaseVersionId,
        revision: revision.revision,
        kind: revision.kind,
        state: revision.state,
        severity: revision.severity,
        affectedVersionCount: revision.affectedVersionCount,
        affectedVersionSetChecksum: revision.affectedVersionSetChecksum,
        sourceAssetReleaseId: revision.sourceAssetReleaseId,
        sourceAssetReleaseVersionId: revision.sourceAssetReleaseVersionId,
        sourceRevision: revision.sourceRevision,
        sourceSnapshotChecksum: revision.sourceSnapshotChecksum,
        sourceWatermark: revision.sourceWatermark,
        resourceVersion: updated.version,
        reason
      };
      const audit = await writeAudit(client, {
        action: AUDIT_ACTIONS.ASSET_RELEASE_RECALL_ISSUED,
        objectType: AUDIT_OBJECT_TYPES.ASSET_RELEASE_RECALL,
        objectId: recall.id,
        context: commandContext({
          auditContext: input.auditContext,
          actorId: input.actorId,
          reason,
          departmentId: asset.rndProject.departmentId
        }),
        after: { value: auditFacts, allowedFields: ASSET_UPGRADE_IMPACT_AUDIT_FIELDS }
      });
      const outbox = await appendOutboxEvent(client, {
        eventType: "asset.release-recall.issued",
        aggregateType: "ASSET_RELEASE_RECALL",
        aggregateId: recall.id,
        idempotencyKey: `${recall.id}:revision:1`,
        payload: auditFacts
      });
      return {
        item: serializeRecall(updated),
        recall: serializeRecall(updated),
        recallRevision: serializeRecallRevision(revision),
        resourceVersion: updated.version,
        allowedActions: ["CORRECT", "WITHDRAW"],
        auditId: audit.id,
        outboxEventId: outbox.id
      };
    });
  } catch (error) {
    mapDatabaseError(error, "ASSET_RECALL_ALREADY_EXISTS");
  }
}

export async function reviseAssetReleaseRecall(
  input: {
    technicalAssetId: string;
    recallId: string;
    version: unknown;
    kind: Exclude<AssetReleaseRecallRevisionKind, "ISSUED">;
    sourceAssetReleaseVersionId: string;
    severity: Severity;
    reason: unknown;
    evidence: unknown;
    actorId: string;
    authorizationActor: AuthorizationActor;
    auditContext: AuditContext;
  },
  transaction?: Client
) {
  const expectedVersion = positiveVersion(input.version, "version");
  const reason = text(input.reason, "reason");
  const evidence = canonicalObject(input.evidence, "evidence");
  try {
    return await inTransaction(transaction, async (client) => {
      const asset = await lockAsset(client, input.technicalAssetId);
      assertOwner(asset, input.authorizationActor, input.actorId);
      const identity = await client.assetReleaseRecall.findFirst({
        where: { id: input.recallId, technicalAssetId: asset.id },
        select: {
          releaseId: true,
          affectedVersions: { select: { assetReleaseVersionId: true } }
        }
      });
      if (!identity) {
        throw new AssetUpgradeImpactServiceError("ASSET_RECALL_NOT_FOUND", "资产召回不存在。", 404);
      }
      await lockRelease(client, asset.id, identity.releaseId);
      await lockReleaseVersions(
        client,
        asset.id,
        identity.affectedVersions.map((version) => version.assetReleaseVersionId)
      );
      await client.$queryRaw`SELECT "id" FROM "asset_release_recalls" WHERE "id" = ${input.recallId} AND "technical_asset_id" = ${asset.id} FOR UPDATE`;
      const recall = await client.assetReleaseRecall.findFirst({
        where: { id: input.recallId, technicalAssetId: asset.id },
        include: {
          currentRevision: true,
          affectedVersions: { orderBy: { assetReleaseVersionId: "asc" } }
        }
      });
      if (!recall || !recall.currentRevision) {
        throw new AssetUpgradeImpactServiceError("ASSET_RECALL_NOT_FOUND", "资产召回不存在。", 404);
      }
      if (recall.version !== expectedVersion) {
        throw new AssetUpgradeImpactServiceError(
          "ASSET_RECALL_VERSION_CONFLICT",
          "资产召回已发生变化，请刷新后重试。",
          409
        );
      }
      const source = recall.affectedVersions.find(
        (version) => version.assetReleaseVersionId === input.sourceAssetReleaseVersionId
      );
      if (!source) {
        throw new AssetUpgradeImpactServiceError(
          "RECALL_REVISION_SOURCE_MISMATCH",
          "召回修订来源版本必须属于冻结 affected-version set。",
          409
        );
      }
      assertAssetReleaseRecallRevisionSource({
        sourceAssetReleaseId: source.releaseId,
        sourceAssetReleaseVersionId: source.assetReleaseVersionId,
        technicalAssetId: source.technicalAssetId,
        anchor: {
          releaseId: recall.releaseId,
          assetReleaseVersionId: source.assetReleaseVersionId,
          technicalAssetId: asset.id
        }
      });
      await assertSourceFilesAvailableAndAuthorized(client, {
        technicalAssetId: asset.id,
        assetReleaseVersionIds: recall.affectedVersions.map(
          ({ assetReleaseVersionId }) => assetReleaseVersionId
        ),
        authorizationActor: input.authorizationActor
      });
      const nextRevision = recall.currentRevision.revision + 1;
      const state = assertAssetReleaseRecallRevision({
        currentState: recall.currentState,
        currentRevision: recall.currentRevision.revision,
        nextRevision,
        kind: input.kind,
        affectedVersionSetChecksum: recall.affectedVersionSetChecksum!,
        expectedAffectedVersionSetChecksum: recall.currentRevision.affectedVersionSetChecksum
      });
      const snapshot = payloadHash({
        recallId: recall.id,
        technicalAssetId: asset.id,
        releaseId: recall.releaseId,
        scope: recall.scope,
        targetKey: recall.targetKey,
        targetReleaseVersionId: recall.targetReleaseVersionId,
        revision: nextRevision,
        kind: input.kind,
        state,
        severity: input.severity,
        affectedVersionSetChecksum: recall.affectedVersionSetChecksum,
        affectedVersions: recall.affectedVersions.map((version) => ({
          assetReleaseVersionId: version.assetReleaseVersionId,
          releaseId: version.releaseId,
          technicalAssetId: version.technicalAssetId,
          revision: version.revision,
          snapshotChecksum: version.snapshotChecksum,
          sourceWatermark: version.sourceWatermark,
          status: version.status
        })),
        sourceAssetReleaseId: source.releaseId,
        sourceAssetReleaseVersionId: source.assetReleaseVersionId,
        sourceRevision: source.revision,
        sourceSnapshotChecksum: source.snapshotChecksum,
        sourceWatermark: source.sourceWatermark,
        evidence
      });
      const revision = await client.assetReleaseRecallRevision.create({
        data: {
          recallId: recall.id,
          technicalAssetId: asset.id,
          revision: nextRevision,
          kind: input.kind,
          state,
          severity: input.severity,
          reason,
          affectedVersionSetChecksum: recall.affectedVersionSetChecksum!,
          affectedVersionCount: recall.affectedVersions.length,
          sourceAssetReleaseVersionId: source.assetReleaseVersionId,
          sourceAssetReleaseId: source.releaseId,
          sourceRevision: source.revision,
          sourceSnapshotChecksum: source.snapshotChecksum,
          sourceWatermark: source.sourceWatermark,
          evidenceJson: evidence as Prisma.InputJsonValue,
          snapshotJson: snapshot.value as Prisma.InputJsonValue,
          snapshotChecksum: snapshot.hash,
          actorId: input.actorId
        }
      });
      const updated = await client.assetReleaseRecall.update({
        where: { id: recall.id },
        data: {
          currentRevisionId: revision.id,
          currentState: state,
          version: { increment: 1 }
        }
      });
      const facts = {
        technicalAssetId: asset.id,
        releaseId: recall.releaseId,
        recallId: recall.id,
        recallRevisionId: revision.id,
        revision: revision.revision,
        kind: revision.kind,
        state: revision.state,
        severity: revision.severity,
        affectedVersionCount: revision.affectedVersionCount,
        affectedVersionSetChecksum: revision.affectedVersionSetChecksum,
        sourceAssetReleaseId: revision.sourceAssetReleaseId,
        sourceAssetReleaseVersionId: revision.sourceAssetReleaseVersionId,
        sourceRevision: revision.sourceRevision,
        sourceSnapshotChecksum: revision.sourceSnapshotChecksum,
        sourceWatermark: revision.sourceWatermark,
        resourceVersion: updated.version,
        reason
      };
      const audit = await writeAudit(client, {
        action: AUDIT_ACTIONS.ASSET_RELEASE_RECALL_REVISED,
        objectType: AUDIT_OBJECT_TYPES.ASSET_RELEASE_RECALL,
        objectId: recall.id,
        context: commandContext({
          auditContext: input.auditContext,
          actorId: input.actorId,
          reason,
          departmentId: asset.rndProject.departmentId
        }),
        after: { value: facts, allowedFields: ASSET_UPGRADE_IMPACT_AUDIT_FIELDS }
      });
      const outbox = await appendOutboxEvent(client, {
        eventType: "asset.release-recall.revised",
        aggregateType: "ASSET_RELEASE_RECALL",
        aggregateId: recall.id,
        idempotencyKey: `${recall.id}:revision:${revision.revision}`,
        payload: facts
      });
      return {
        item: serializeRecall(updated),
        recall: serializeRecall(updated),
        recallRevision: serializeRecallRevision(revision),
        resourceVersion: updated.version,
        allowedActions: state === "ACTIVE" ? ["CORRECT", "WITHDRAW"] : ["REISSUE"],
        auditId: audit.id,
        outboxEventId: outbox.id
      };
    });
  } catch (error) {
    mapDatabaseError(error);
  }
}

export async function listAssetReleaseRecalls(input: {
  technicalAssetId: string;
  releaseId: string;
  cursor?: string;
  limit: number;
  actorId: string;
  canManage: boolean;
  auditContext: AuditContext;
}) {
  try {
    return await inTransaction(undefined, async (client) => {
      const asset = await client.technicalAsset.findUnique({
        where: { id: input.technicalAssetId }
      });
      if (!asset) {
        throw new AssetUpgradeImpactServiceError(
          "TECHNICAL_ASSET_NOT_FOUND",
          "企业技术资产不存在。",
          404
        );
      }
      const release = await client.assetRelease.findFirst({
        where: { id: input.releaseId, technicalAssetId: input.technicalAssetId }
      });
      if (!release) {
        throw new AssetUpgradeImpactServiceError(
          "ASSET_RELEASE_NOT_FOUND",
          "资产 Release 不存在。",
          404
        );
      }
      const rows = await client.assetReleaseRecall.findMany({
        where: { technicalAssetId: input.technicalAssetId, releaseId: input.releaseId },
        orderBy: { id: "asc" },
        ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
        take: input.limit + 1
      });
      const page = rows.slice(0, input.limit);
      const canManage = input.canManage && asset.ownerId === input.actorId;
      const audit = await writeAudit(client, {
        action: AUDIT_ACTIONS.ASSET_RELEASE_RECALL_READ,
        objectType: AUDIT_OBJECT_TYPES.ASSET_RELEASE_RECALL,
        objectId: release.id,
        context: { ...input.auditContext, actorId: input.actorId, projectId: null },
        after: {
          value: {
            technicalAssetId: input.technicalAssetId,
            releaseId: release.id,
            returnedCount: page.length
          },
          allowedFields: ASSET_UPGRADE_IMPACT_AUDIT_FIELDS
        }
      });
      return {
        items: page.map((recall) => serializeRecall(recall, canManage)),
        nextCursor: rows.length > input.limit ? (page.at(-1)?.id ?? null) : null,
        allowedActions: canManage ? ["CREATE"] : [],
        auditId: audit.id,
        outboxEventId: null
      };
    });
  } catch (error) {
    mapDatabaseError(error);
  }
}

export async function createAssetUpgradeCandidate(
  input: {
    technicalAssetId: string;
    assetVersion: unknown;
    sourceAssetReleaseVersionId: string;
    targetAssetReleaseVersionId: string;
    compatibility: unknown;
    reason: unknown;
    actorId: string;
    authorizationActor: AuthorizationActor;
    auditContext: AuditContext;
  },
  transaction?: Client
) {
  const assetVersion = positiveVersion(input.assetVersion, "assetVersion");
  const sourceAssetReleaseVersionId = text(
    input.sourceAssetReleaseVersionId,
    "sourceAssetReleaseVersionId",
    191
  );
  const targetAssetReleaseVersionId = text(
    input.targetAssetReleaseVersionId,
    "targetAssetReleaseVersionId",
    191
  );
  if (sourceAssetReleaseVersionId === targetAssetReleaseVersionId) {
    throw new AssetUpgradeImpactServiceError(
      "ASSET_UPGRADE_CANDIDATE_INVALID",
      "升级候选的 source 与 target exact ReleaseVersion 不能相同。",
      422
    );
  }
  const reason = text(input.reason, "reason");
  const compatibility = canonicalObject(input.compatibility, "compatibility");
  try {
    return await inTransaction(transaction, async (client) => {
      const asset = await lockAsset(client, input.technicalAssetId);
      assertOwner(asset, input.authorizationActor, input.actorId);
      if (asset.version !== assetVersion) {
        throw new AssetUpgradeImpactServiceError(
          "VERSION_CONFLICT",
          "企业技术资产已发生变化，请刷新后重试。",
          409
        );
      }
      if (
        asset.status !== "VALIDATED" ||
        asset.rndProject.status === "COMPLETED" ||
        asset.rndProject.status === "CANCELED"
      ) {
        throw new AssetUpgradeImpactServiceError(
          "ASSET_UPGRADE_CANDIDATE_SOURCE_UNAVAILABLE",
          "当前企业技术资产状态不允许创建升级候选。",
          409
        );
      }
      const identities = await client.assetReleaseVersion.findMany({
        where: {
          technicalAssetId: asset.id,
          id: { in: [sourceAssetReleaseVersionId, targetAssetReleaseVersionId] }
        },
        select: { id: true, releaseId: true }
      });
      if (identities.length !== 2) {
        throw new AssetUpgradeImpactServiceError(
          "ASSET_RELEASE_VERSION_NOT_FOUND",
          "升级候选的 exact ReleaseVersion 不存在。",
          404
        );
      }
      const releaseIds = identities.map((version) => version.releaseId).sort();
      await client.$queryRaw`SELECT "id" FROM "asset_releases" WHERE "technical_asset_id" = ${asset.id} AND "id" IN (${Prisma.join(releaseIds)}) ORDER BY "id" FOR UPDATE`;
      const versions = await lockReleaseVersions(client, asset.id, [
        sourceAssetReleaseVersionId,
        targetAssetReleaseVersionId
      ]);
      const source = versions.find((version) => version.id === sourceAssetReleaseVersionId);
      const target = versions.find((version) => version.id === targetAssetReleaseVersionId);
      if (!source || !target) {
        throw new AssetUpgradeImpactServiceError(
          "ASSET_RELEASE_VERSION_NOT_FOUND",
          "升级候选的 exact ReleaseVersion 不存在。",
          404
        );
      }
      const releases = await client.assetRelease.findMany({
        where: { technicalAssetId: asset.id, id: { in: releaseIds } }
      });
      if (releases.length !== new Set(releaseIds).size) {
        throw new AssetUpgradeImpactServiceError(
          "ASSET_RELEASE_NOT_FOUND",
          "升级候选的 exact Release 不存在。",
          404
        );
      }
      if (target.status !== "PUBLISHED") {
        throw new AssetUpgradeImpactServiceError(
          "ASSET_UPGRADE_TARGET_VERSION_NOT_PUBLISHED",
          "升级候选 target 必须是 exact PUBLISHED ReleaseVersion。",
          409
        );
      }
      assertAssetUpgradeCandidate({
        technicalAssetId: asset.id,
        source: {
          releaseId: source.releaseId,
          releaseVersionId: source.id,
          revision: source.revision,
          snapshotChecksum: source.snapshotChecksum,
          sourceWatermark: source.sourceWatermark,
          status: source.status
        },
        target: {
          releaseId: target.releaseId,
          releaseVersionId: target.id,
          revision: target.revision,
          snapshotChecksum: target.snapshotChecksum,
          sourceWatermark: target.sourceWatermark,
          status: target.status
        }
      });
      await assertSourceFilesAvailableAndAuthorized(client, {
        technicalAssetId: asset.id,
        assetReleaseVersionIds: [source.id, target.id],
        authorizationActor: input.authorizationActor
      });
      const compatibilitySnapshot = payloadHash(compatibility);
      const candidate = await client.assetUpgradeCandidate.create({
        data: {
          technicalAssetId: asset.id,
          sourceAssetReleaseId: source.releaseId,
          sourceAssetReleaseVersionId: source.id,
          sourceRevision: source.revision,
          sourceSnapshotChecksum: source.snapshotChecksum,
          sourceWatermark: source.sourceWatermark,
          targetAssetReleaseId: target.releaseId,
          targetAssetReleaseVersionId: target.id,
          targetRevision: target.revision,
          targetSnapshotChecksum: target.snapshotChecksum,
          targetWatermark: target.sourceWatermark,
          compatibilitySnapshotJson: compatibilitySnapshot.value as Prisma.InputJsonValue,
          compatibilitySnapshotChecksum: compatibilitySnapshot.hash,
          createdById: input.actorId
        }
      });
      const facts = {
        technicalAssetId: asset.id,
        candidateId: candidate.id,
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
        compatibilitySnapshotChecksum: candidate.compatibilitySnapshotChecksum,
        reason
      };
      const audit = await writeAudit(client, {
        action: AUDIT_ACTIONS.ASSET_UPGRADE_CANDIDATE_CREATED,
        objectType: AUDIT_OBJECT_TYPES.ASSET_UPGRADE_CANDIDATE,
        objectId: candidate.id,
        context: commandContext({
          auditContext: input.auditContext,
          actorId: input.actorId,
          reason,
          departmentId: asset.rndProject.departmentId
        }),
        after: { value: facts, allowedFields: ASSET_UPGRADE_IMPACT_AUDIT_FIELDS }
      });
      const outbox = await appendOutboxEvent(client, {
        eventType: "asset.upgrade-candidate.created",
        aggregateType: "ASSET_UPGRADE_CANDIDATE",
        aggregateId: candidate.id,
        idempotencyKey: `${candidate.id}:created`,
        payload: facts
      });
      return {
        item: serializeCandidate(candidate),
        candidate: serializeCandidate(candidate),
        resourceVersion: 1,
        allowedActions: [],
        auditId: audit.id,
        outboxEventId: outbox.id
      };
    });
  } catch (error) {
    mapDatabaseError(error, "ASSET_UPGRADE_CANDIDATE_ALREADY_EXISTS");
  }
}

export async function listAssetUpgradeCandidates(input: {
  technicalAssetId: string;
  cursor?: string;
  limit: number;
  actorId: string;
  canManage: boolean;
  auditContext: AuditContext;
}) {
  try {
    return await inTransaction(undefined, async (client) => {
      const asset = await client.technicalAsset.findUnique({
        where: { id: input.technicalAssetId },
        include: { rndProject: { select: { status: true } } }
      });
      if (!asset) {
        throw new AssetUpgradeImpactServiceError(
          "TECHNICAL_ASSET_NOT_FOUND",
          "企业技术资产不存在。",
          404
        );
      }
      const rows = await client.assetUpgradeCandidate.findMany({
        where: { technicalAssetId: input.technicalAssetId },
        orderBy: { id: "asc" },
        ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
        take: input.limit + 1
      });
      const page = rows.slice(0, input.limit);
      const canCreate =
        input.canManage &&
        asset.ownerId === input.actorId &&
        asset.status === "VALIDATED" &&
        asset.rndProject.status !== "COMPLETED" &&
        asset.rndProject.status !== "CANCELED";
      const audit = await writeAudit(client, {
        action: AUDIT_ACTIONS.ASSET_UPGRADE_CANDIDATE_READ,
        objectType: AUDIT_OBJECT_TYPES.ASSET_UPGRADE_CANDIDATE,
        objectId: asset.id,
        context: { ...input.auditContext, actorId: input.actorId, projectId: null },
        after: {
          value: { technicalAssetId: asset.id, returnedCount: page.length },
          allowedFields: ASSET_UPGRADE_IMPACT_AUDIT_FIELDS
        }
      });
      return {
        items: page.map(serializeCandidate),
        nextCursor: rows.length > input.limit ? (page.at(-1)?.id ?? null) : null,
        allowedActions: canCreate ? ["CREATE"] : [],
        auditId: audit.id,
        outboxEventId: null
      };
    });
  } catch (error) {
    mapDatabaseError(error);
  }
}
