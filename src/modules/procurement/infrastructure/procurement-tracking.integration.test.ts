import { randomUUID } from "node:crypto";

import { beforeAll, describe, expect, it } from "vitest";

import { db } from "@/lib/db";
import type { AuditContext } from "@/modules/audit/contracts/audit";
import {
  confirmMaterialRequirement,
  createMaterialReference,
  createMaterialRequirementDraft
} from "@/modules/procurement/application/material-requirement-service";
import { configureProjectProcurement } from "@/modules/procurement/application/procurement-settings-service";
import {
  createProcurementTrackingLine,
  updateLocalProcurementTrackingLine
} from "@/modules/procurement/application/procurement-tracking-service";
import { createReadyProcurementProject } from "@/modules/procurement/infrastructure/procurement-test-fixtures";

const describeDatabase = process.env.RUN_DATABASE_INTEGRATION === "1" ? describe : describe.skip;
const suffix = randomUUID().slice(0, 8);
const actorId = `tracking-admin-${suffix}`;
const projectId = `tracking-project-${suffix}`;

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

describeDatabase("APM-090B PostgreSQL procurement tracking", () => {
  let requirementId = "";
  let revisionId = "";

  beforeAll(async () => {
    await db.user.create({
      data: {
        id: actorId,
        employeeNo: `TRACKING-${suffix}`.toUpperCase(),
        name: "采购跟踪测试人",
        departmentId: "engineering"
      }
    });
    await createReadyProcurementProject({
      id: projectId,
      code: `TRACK-${suffix}`.toUpperCase(),
      name: "采购跟踪测试项目",
      departmentId: "engineering",
      createdById: actorId
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
      reason: "启用本地采购跟踪测试",
      actorId,
      auditContext: context("settings")
    });
    const material = await createMaterialReference({
      projectId,
      source: "LOCAL",
      code: `MAT-${suffix}`.toUpperCase(),
      name: "跟踪物料",
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
      isCritical: false,
      businessType: "STANDARD_PURCHASE",
      source: "MANUAL",
      actorId,
      auditContext: context("draft")
    });
    const confirmed = await confirmMaterialRequirement({
      projectId,
      requirementId: draft.requirement.id,
      version: draft.resourceVersion,
      reason: "确认跟踪需求",
      actorId,
      auditContext: context("confirm")
    });
    requirementId = confirmed.requirement.id;
    revisionId = confirmed.requirement.currentRevision?.id ?? "";
  });

  it("keeps local tracking writes, optimistic locking, audit and outbox atomic", async () => {
    const created = await createProcurementTrackingLine({
      projectId,
      requirementId,
      requirementRevisionId: revisionId,
      businessType: "STANDARD_PURCHASE",
      orderedQuantity: "10",
      promisedOn: "2026-08-30",
      actorId,
      auditContext: context("create"),
      reason: "建立本地跟踪行"
    });
    expect(created.line.source).toBe("LOCAL");
    const updated = await updateLocalProcurementTrackingLine({
      projectId,
      trackingLineId: created.line.id,
      version: created.line.version,
      orderedQuantity: "11",
      promisedOn: "2026-09-02",
      actorId,
      auditContext: context("update"),
      reason: "更新承诺日期"
    });
    expect(updated.line.version).toBe(2);
    await expect(
      updateLocalProcurementTrackingLine({
        projectId,
        trackingLineId: created.line.id,
        version: 1,
        orderedQuantity: "12",
        actorId,
        auditContext: context("conflict"),
        reason: "过期版本"
      })
    ).rejects.toMatchObject({ code: "VERSION_CONFLICT", status: 409 });
    await expect(
      db.auditLog.count({ where: { projectId, objectType: "PROCUREMENT_TRACKING_LINE" } })
    ).resolves.toBeGreaterThanOrEqual(2);
    await expect(
      db.outboxEvent.count({ where: { aggregateType: "PROCUREMENT_TRACKING_LINE" } })
    ).resolves.toBeGreaterThanOrEqual(2);
  });
});
