import { randomUUID } from "node:crypto";

import { beforeAll, describe, expect, it } from "vitest";

import { db } from "@/lib/db";
import type { AuditContext } from "@/modules/audit/contracts/audit";
import {
  confirmMaterialRequirement,
  createMaterialReference,
  createMaterialRequirementDraft,
  reviseMaterialRequirement
} from "@/modules/procurement/application/material-requirement-service";
import { configureProjectProcurement } from "@/modules/procurement/application/procurement-settings-service";

const describeDatabase = process.env.RUN_DATABASE_INTEGRATION === "1" ? describe : describe.skip;
const suffix = randomUUID().slice(0, 8);
const actorId = `procurement-admin-${suffix}`;
const projectId = `procurement-project-${suffix}`;

function context(operationId: string): AuditContext {
  return {
    actorId,
    requestId: `request-${operationId}`,
    traceId: `trace-${operationId}`,
    source: "API",
    sourceIp: null,
    userAgent: "Vitest",
    reason: null,
    projectId,
    departmentId: "engineering",
    operationId
  };
}

describeDatabase("APM-090A PostgreSQL procurement foundation", () => {
  beforeAll(async () => {
    await db.user.create({
      data: {
        id: actorId,
        employeeNo: `PROCUREMENT-${suffix}`.toUpperCase(),
        name: "采购集成测试人",
        departmentId: "engineering"
      }
    });
    await db.project.create({
      data: {
        id: projectId,
        code: `PROC-${suffix}`.toUpperCase(),
        name: "采购基础测试项目",
        departmentId: "engineering",
        createdById: actorId
      }
    });
    await db.companyCapability.update({
      where: { code: "PROCUREMENT_COLLABORATION" },
      data: { enabled: true }
    });
    await db.projectCapability.create({
      data: {
        projectId,
        capabilityCode: "PROCUREMENT_COLLABORATION",
        templateAllowed: true,
        templateRequired: false,
        selectedEnabled: true,
        createdById: actorId,
        updatedById: actorId
      }
    });
    await configureProjectProcurement({
      projectId,
      mode: "LOCAL",
      version: 0,
      reason: "启用本地采购台账测试模式",
      actorId,
      auditContext: context("settings")
    });
  });

  it("creates, confirms and revises an immutable requirement with audit and outbox facts", async () => {
    const material = await createMaterialReference({
      projectId,
      source: "LOCAL",
      code: `MAT-${suffix}`,
      name: "标准测试物料",
      trackingUnit: "PCS",
      actorId,
      auditContext: context("material")
    });
    const draft = await createMaterialRequirementDraft({
      projectId,
      materialReferenceId: material.materialReference.id,
      quantity: "10",
      trackingUnit: "PCS",
      requiredOn: "2026-09-01",
      isCritical: true,
      businessType: "STANDARD_PURCHASE",
      source: "MANUAL",
      actorId,
      auditContext: context("draft")
    });
    const confirmed = await confirmMaterialRequirement({
      projectId,
      requirementId: draft.requirement.id,
      version: draft.resourceVersion,
      reason: "确认物料需求",
      actorId,
      auditContext: context("confirm")
    });
    const revised = await reviseMaterialRequirement({
      projectId,
      requirementId: draft.requirement.id,
      version: confirmed.resourceVersion,
      materialReferenceId: material.materialReference.id,
      quantity: "12",
      trackingUnit: "PCS",
      requiredOn: "2026-09-03",
      isCritical: true,
      businessType: "STANDARD_PURCHASE",
      source: "CHANGE",
      reason: "需求日期和数量变更",
      actorId,
      auditContext: context("revise")
    });

    expect(revised.requirement.currentRevision).toMatchObject({ revision: 2, status: "CONFIRMED" });
    await expect(
      db.projectMaterialRequirementRevision.findMany({
        where: { requirementId: draft.requirement.id },
        orderBy: { revision: "asc" }
      })
    ).resolves.toMatchObject([
      [{ revision: 1, status: "SUPERSEDED", quantity: { toString: expect.any(Function) } }][0],
      { revision: 2, status: "CONFIRMED" }
    ]);
    await expect(
      db.auditLog.count({ where: { projectId, objectType: "PROJECT_MATERIAL_REQUIREMENT" } })
    ).resolves.toBeGreaterThanOrEqual(3);
    await expect(
      db.outboxEvent.count({ where: { aggregateType: "PROJECT_MATERIAL_REQUIREMENT" } })
    ).resolves.toBeGreaterThanOrEqual(3);
  });

  it("rejects a project requirement when the capability is effectively disabled", async () => {
    await db.projectCapability.update({
      where: {
        projectId_capabilityCode: { projectId, capabilityCode: "PROCUREMENT_COLLABORATION" }
      },
      data: { selectedEnabled: false }
    });
    const before = await db.projectMaterialRequirement.count({ where: { projectId } });
    await expect(
      createMaterialRequirementDraft({
        projectId,
        materialReferenceId: "missing",
        quantity: "1",
        trackingUnit: "PCS",
        requiredOn: "2026-09-01",
        isCritical: false,
        businessType: "STANDARD_PURCHASE",
        source: "MANUAL",
        actorId,
        auditContext: context("disabled")
      })
    ).rejects.toMatchObject({ code: "PROC_CAPABILITY_DISABLED", status: 409 });
    await expect(db.projectMaterialRequirement.count({ where: { projectId } })).resolves.toBe(
      before
    );
  });
});
