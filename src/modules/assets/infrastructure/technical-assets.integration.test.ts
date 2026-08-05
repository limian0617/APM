import { randomUUID } from "node:crypto";

import { beforeAll, describe, expect, it } from "vitest";

import { db } from "@/lib/db";
import type { AuditContext } from "@/modules/audit/contracts/audit";

import {
  createRndProject,
  createTechnicalAsset,
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
        `TRUNCATE TABLE "technical_asset_validations", "technical_asset_events", "technical_assets", "rnd_project_events", "rnd_projects"`
      )
    ).rejects.toThrow(/cannot be truncated/u);
  });
});
