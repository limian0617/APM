import { randomUUID } from "node:crypto";

import { beforeAll, describe, expect, it } from "vitest";

import { db } from "@/lib/db";
import type { AuditContext } from "@/modules/audit/contracts/audit";

import {
  createRndProject,
  createTechnicalAsset,
  deactivateTechnicalAsset,
  getTechnicalAsset,
  recordTechnicalAssetValidation,
  transitionRndProject,
  transitionTechnicalAsset
} from "../application/technical-asset-service";

const describeDatabase = process.env.RUN_DATABASE_INTEGRATION === "1" ? describe : describe.skip;
const suffix = randomUUID().slice(0, 8);
const ids = {
  assetMaintainer: `asset-maintainer-${suffix}`,
  owner: `asset-owner-${suffix}`,
  validator: `asset-validator-${suffix}`,
  disabledValidator: `asset-disabled-validator-${suffix}`
};

const authorizationActor = {
  id: ids.owner,
  name: "资产 Owner",
  status: "ACTIVE" as const,
  departmentId: "engineering",
  systemRoles: ["TECHNICAL_ASSET_MAINTAINER"],
  grants: []
};

function context(actorId: string, operationId: string): AuditContext {
  return {
    actorId,
    requestId: `request-${operationId}`,
    traceId: `trace-${operationId}`,
    source: "API",
    sourceIp: null,
    userAgent: "Vitest",
    reason: null,
    projectId: null,
    departmentId: "engineering",
    operationId
  };
}

describeDatabase("APM-061 PostgreSQL technical asset masters", () => {
  beforeAll(async () => {
    await db.user.createMany({
      data: [
        {
          id: ids.assetMaintainer,
          employeeNo: `AST-MAINTAINER-${suffix}`,
          name: "技术资产维护人",
          departmentId: "engineering"
        },
        {
          id: ids.owner,
          employeeNo: `AST-OWNER-${suffix}`,
          name: "资产 Owner",
          departmentId: "engineering"
        },
        {
          id: ids.validator,
          employeeNo: `AST-VALIDATOR-${suffix}`,
          name: "独立验证人",
          departmentId: "quality"
        },
        {
          id: ids.disabledValidator,
          employeeNo: `AST-DISABLED-${suffix}`,
          name: "禁用验证人",
          departmentId: "quality",
          status: "DISABLED"
        }
      ]
    });
  });

  it("creates an internal R&D project and its independently numbered asset with initial history", async () => {
    const created = await createRndProject({
      code: `RND.FEEDER.${suffix}`,
      name: "标准上料模组研发",
      description: "企业标准机械资产研发",
      departmentId: "engineering",
      ownerId: ids.owner,
      reason: "立项独立研发项目",
      actorId: ids.assetMaintainer,
      auditContext: context(ids.assetMaintainer, `rnd-create-${suffix}`)
    });
    const asset = await createTechnicalAsset({
      rndProjectId: created.rndProject.id,
      assetNumber: `AST.MECH.FEEDER.${suffix}`,
      name: "标准上料模组",
      description: "可复用机械资产主记录",
      assetType: "MECHANICAL",
      ownerId: ids.owner,
      reason: "建立企业技术资产主记录",
      actorId: ids.assetMaintainer,
      auditContext: context(ids.assetMaintainer, `asset-create-${suffix}`)
    });

    expect(created.rndProject).toMatchObject({
      code: `RND.FEEDER.${suffix}`.toUpperCase(),
      ownerId: ids.owner,
      status: "PROPOSED",
      version: 1
    });
    expect(asset.asset).toMatchObject({
      rndProjectId: created.rndProject.id,
      assetNumber: `AST.MECH.FEEDER.${suffix}`.toUpperCase(),
      ownerId: ids.owner,
      assetType: "MECHANICAL",
      status: "DRAFT",
      version: 1
    });
    await expect(
      db.rndProjectEvent.count({
        where: { rndProjectId: created.rndProject.id, eventType: "CREATED" }
      })
    ).resolves.toBe(1);
    await expect(
      db.technicalAssetEvent.count({
        where: { technicalAssetId: asset.asset.id, eventType: "CREATED" }
      })
    ).resolves.toBe(1);
    await expect(
      db.auditLog.count({
        where: { action: { in: ["RND_PROJECT_CREATED", "TECHNICAL_ASSET_CREATED"] } }
      })
    ).resolves.toBeGreaterThanOrEqual(2);
    await expect(
      db.outboxEvent.count({
        where: { eventType: { in: ["rnd-project.created", "technical-asset.created"] } }
      })
    ).resolves.toBeGreaterThanOrEqual(2);
  });

  it("keeps lifecycle evidence immutable, rejects cross-R&D access, and requires an independent validator", async () => {
    const rnd = await createRndProject({
      code: `RND.VALIDATION.${suffix}`,
      name: "验证流程研发",
      departmentId: "engineering",
      ownerId: ids.owner,
      reason: "建立研发验证样本",
      actorId: ids.assetMaintainer,
      auditContext: context(ids.assetMaintainer, `rnd-validation-create-${suffix}`)
    });
    const otherRnd = await createRndProject({
      code: `RND.OTHER.${suffix}`,
      name: "隔离验证研发",
      departmentId: "engineering",
      ownerId: ids.owner,
      reason: "建立隔离研发样本",
      actorId: ids.assetMaintainer,
      auditContext: context(ids.assetMaintainer, `rnd-other-create-${suffix}`)
    });
    const asset = await createTechnicalAsset({
      rndProjectId: rnd.rndProject.id,
      assetNumber: `AST.SOFTWARE.VALIDATION.${suffix}`,
      name: "通用软件资产",
      assetType: "SOFTWARE",
      ownerId: ids.owner,
      reason: "建立验证样本资产",
      actorId: ids.assetMaintainer,
      auditContext: context(ids.assetMaintainer, `asset-validation-create-${suffix}`)
    });

    const inDevelopment = await transitionRndProject({
      rndProjectId: rnd.rndProject.id,
      version: rnd.resourceVersion,
      toStatus: "IN_DEVELOPMENT",
      reason: "研发启动",
      actorId: ids.assetMaintainer,
      auditContext: context(ids.assetMaintainer, `rnd-start-${suffix}`)
    });
    const validation = await transitionRndProject({
      rndProjectId: rnd.rndProject.id,
      version: inDevelopment.resourceVersion,
      toStatus: "VALIDATION",
      reason: "研发完成，提交验证",
      actorId: ids.assetMaintainer,
      auditContext: context(ids.assetMaintainer, `rnd-validation-${suffix}`)
    });
    const pending = await transitionTechnicalAsset({
      rndProjectId: rnd.rndProject.id,
      assetId: asset.asset.id,
      version: asset.resourceVersion,
      toStatus: "VALIDATION_PENDING",
      reason: "提交独立验证",
      actorId: ids.assetMaintainer,
      auditContext: context(ids.assetMaintainer, `asset-pending-${suffix}`)
    });

    await expect(
      getTechnicalAsset({ rndProjectId: otherRnd.rndProject.id, assetId: asset.asset.id })
    ).rejects.toMatchObject({ code: "TECHNICAL_ASSET_NOT_FOUND", status: 404 });
    await expect(
      recordTechnicalAssetValidation({
        rndProjectId: rnd.rndProject.id,
        assetId: asset.asset.id,
        version: pending.resourceVersion,
        decision: "PASSED",
        evidence: "Owner 不能验证本人资产",
        reason: "错误的自验尝试",
        actorId: ids.owner,
        auditContext: context(ids.owner, `asset-self-validation-${suffix}`)
      })
    ).rejects.toMatchObject({ code: "VALIDATOR_MUST_BE_INDEPENDENT", status: 422 });
    await expect(
      recordTechnicalAssetValidation({
        rndProjectId: rnd.rndProject.id,
        assetId: asset.asset.id,
        version: pending.resourceVersion,
        decision: "PASSED",
        evidence: "禁用人员不能验证",
        reason: "错误的禁用验证尝试",
        actorId: ids.disabledValidator,
        auditContext: context(ids.disabledValidator, `asset-disabled-validation-${suffix}`)
      })
    ).rejects.toMatchObject({ code: "VALIDATOR_DISABLED", status: 409 });

    const validated = await recordTechnicalAssetValidation({
      rndProjectId: rnd.rndProject.id,
      assetId: asset.asset.id,
      version: pending.resourceVersion,
      decision: "PASSED",
      evidence: "独立测试报告已通过",
      reason: "独立验证结论通过",
      actorId: ids.validator,
      auditContext: context(ids.validator, `asset-validation-pass-${suffix}`)
    });

    expect(validation.rndProject.status).toBe("VALIDATION");
    expect(validated.asset).toMatchObject({ status: "VALIDATED", version: 3 });
    await expect(
      db.technicalAssetValidation.findFirstOrThrow({ where: { technicalAssetId: asset.asset.id } })
    ).resolves.toMatchObject({
      rndProjectId: rnd.rndProject.id,
      validatorId: ids.validator,
      decision: "PASSED",
      evidence: "独立测试报告已通过"
    });
    const event = await db.technicalAssetEvent.findFirstOrThrow({
      where: { technicalAssetId: asset.asset.id, eventType: "VALIDATED" }
    });
    await expect(
      db.technicalAssetEvent.update({ where: { id: event.id }, data: { reason: "篡改历史" } })
    ).rejects.toThrow(/append-only/u);
    await expect(db.technicalAsset.delete({ where: { id: asset.asset.id } })).rejects.toThrow(
      /cannot be deleted/u
    );
    await expect(
      db.$executeRawUnsafe(
        `TRUNCATE TABLE "asset_impact_alert_projection_attempts", "asset_upgrade_usage_mappings", "asset_upgrade_adoptions", "asset_upgrade_candidates", "asset_impact_risk_acceptance_decisions", "asset_impact_risk_acceptance_requests", "asset_impact_dispositions", "asset_impact_assessment_revisions", "asset_project_impacts", "asset_release_recall_affected_versions", "asset_release_recall_revisions", "asset_release_recalls", "project_asset_derivations", "project_asset_usages", "project_asset_references", "asset_component_snapshots", "asset_release_versions", "asset_releases", "technical_asset_validations", "technical_asset_events", "technical_assets", "rnd_project_events", "rnd_projects"`
      )
    ).rejects.toThrow(/cannot be truncated|TRUNCATE is forbidden/u);
  });

  it("requires the dedicated deactivation command for VALIDATED to DISABLED", async () => {
    const rndProject = await db.rndProject.create({
      data: {
        id: `rnd-deactivate-${suffix}`,
        code: `RND.DEACTIVATE.${suffix}`.toUpperCase(),
        name: "停用命令边界",
        ownerId: ids.owner,
        createdById: ids.assetMaintainer
      }
    });
    const asset = await db.technicalAsset.create({
      data: {
        id: `asset-deactivate-${suffix}`,
        rndProjectId: rndProject.id,
        assetNumber: `AST.DEACTIVATE.${suffix}`.toUpperCase(),
        assetType: "MECHANICAL",
        name: "停用命令边界资产",
        ownerId: ids.owner,
        status: "VALIDATED",
        createdById: ids.assetMaintainer
      }
    });

    await expect(
      transitionTechnicalAsset({
        rndProjectId: rndProject.id,
        assetId: asset.id,
        version: asset.version,
        toStatus: "DISABLED",
        reason: "不得绕过专用停用命令",
        actorId: ids.owner,
        auditContext: context(ids.owner, `asset-generic-disable-${suffix}`)
      })
    ).rejects.toMatchObject({ code: "TECHNICAL_ASSET_DEACTIVATION_COMMAND_REQUIRED", status: 409 });

    const deactivated = await deactivateTechnicalAsset({
      assetId: asset.id,
      version: asset.version,
      reason: "资产停止新的项目使用",
      actorId: ids.owner,
      authorizationActor,
      auditContext: context(ids.owner, `asset-dedicated-disable-${suffix}`)
    });
    expect(deactivated.asset).toMatchObject({ status: "DISABLED", version: 2 });
    await expect(
      db.technicalAssetEvent.count({
        where: {
          technicalAssetId: asset.id,
          fromStatus: "VALIDATED",
          toStatus: "DISABLED"
        }
      })
    ).resolves.toBe(1);
    await expect(
      db.auditLog.count({
        where: { objectId: deactivated.auditId, action: "TECHNICAL_ASSET_DISABLED" }
      })
    ).resolves.toBe(0);
    await expect(
      db.auditLog.count({
        where: { id: deactivated.auditId, action: "TECHNICAL_ASSET_DISABLED" }
      })
    ).resolves.toBe(1);
    await expect(
      db.outboxEvent.count({
        where: { id: deactivated.outboxEventId, eventType: "asset.technical-asset.deactivated" }
      })
    ).resolves.toBe(1);
  });

  it("rolls back the asset, event, and success audit when the deactivation outbox conflicts", async () => {
    const rndProject = await db.rndProject.create({
      data: {
        id: `rnd-deactivate-rollback-${suffix}`,
        code: `RND.DEACTIVATE.ROLLBACK.${suffix}`.toUpperCase(),
        name: "停用事务回滚",
        ownerId: ids.owner,
        createdById: ids.assetMaintainer
      }
    });
    const asset = await db.technicalAsset.create({
      data: {
        id: `asset-deactivate-rollback-${suffix}`,
        rndProjectId: rndProject.id,
        assetNumber: `AST.DEACTIVATE.ROLLBACK.${suffix}`.toUpperCase(),
        assetType: "MECHANICAL",
        name: "停用事务回滚资产",
        ownerId: ids.owner,
        status: "VALIDATED",
        createdById: ids.assetMaintainer
      }
    });
    await db.outboxEvent.create({
      data: {
        eventType: "asset.technical-asset.deactivated",
        aggregateType: "TECHNICAL_ASSET",
        aggregateId: asset.id,
        payload: {},
        payloadHash: "0".repeat(64),
        idempotencyKey: `${asset.id}:v2`
      }
    });

    await expect(
      deactivateTechnicalAsset({
        assetId: asset.id,
        version: asset.version,
        reason: "制造 Outbox 冲突",
        actorId: ids.owner,
        authorizationActor,
        auditContext: context(ids.owner, `asset-disable-rollback-${suffix}`)
      })
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_REUSED" });
    await expect(
      db.technicalAsset.findUniqueOrThrow({ where: { id: asset.id } })
    ).resolves.toMatchObject({
      status: "VALIDATED",
      version: 1
    });
    await expect(
      db.technicalAssetEvent.count({
        where: { technicalAssetId: asset.id, toStatus: "DISABLED" }
      })
    ).resolves.toBe(0);
    await expect(
      db.auditLog.count({
        where: {
          operationId: `asset-disable-rollback-${suffix}`,
          action: "TECHNICAL_ASSET_DISABLED"
        }
      })
    ).resolves.toBe(0);
  });
});
