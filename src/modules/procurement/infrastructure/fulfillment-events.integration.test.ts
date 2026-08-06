import { randomUUID } from "node:crypto";

import { Prisma } from "@prisma/client";
import { beforeAll, describe, expect, it } from "vitest";

import { db } from "@/lib/db";
import type { AuditContext } from "@/modules/audit/contracts/audit";
import {
  createMaterialReference,
  createMaterialRequirementDraft,
  confirmMaterialRequirement
} from "@/modules/procurement/application/material-requirement-service";
import { configureProjectProcurement } from "@/modules/procurement/application/procurement-settings-service";

const describeDatabase = process.env.RUN_DATABASE_INTEGRATION === "1" ? describe : describe.skip;
const suffix = randomUUID().slice(0, 8);
const actorId = `event-admin-${suffix}`;
const projectId = `event-project-${suffix}`;
let eventId = "";

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

describeDatabase("APM-091A PostgreSQL fulfillment event immutability", () => {
  beforeAll(async () => {
    await db.user.create({
      data: {
        id: actorId,
        employeeNo: `EVENT-${suffix}`.toUpperCase(),
        name: "履约事件测试人",
        departmentId: "engineering"
      }
    });
    await db.project.create({
      data: {
        id: projectId,
        code: `EVENT-${suffix}`.toUpperCase(),
        name: "履约事件测试项目",
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
      reason: "事件测试启用本地模式",
      actorId,
      auditContext: context("settings")
    });
    const material = await createMaterialReference({
      projectId,
      source: "LOCAL",
      code: `MAT-${suffix}`.toUpperCase(),
      name: "事件物料",
      trackingUnit: "PCS",
      actorId,
      auditContext: context("material")
    });
    const draft = await createMaterialRequirementDraft({
      projectId,
      materialReferenceId: material.materialReference.id,
      quantity: "2",
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
      reason: "确认事件需求",
      actorId,
      auditContext: context("confirm")
    });
    const event = await db.procurementFulfillmentEvent.create({
      data: {
        projectId,
        requirementId: confirmed.requirement.id,
        requirementRevisionId: confirmed.requirement.currentRevision!.id,
        eventType: "PURCHASE_ARRIVED",
        quantity: new Prisma.Decimal("1"),
        trackingUnit: "PCS",
        businessOccurredAt: new Date("2026-08-07T00:00:00Z"),
        source: "LOCAL",
        reason: "测试到货",
        createdById: actorId
      }
    });
    eventId = event.id;
  });

  it("rejects update, delete and truncate of an event fact", async () => {
    await expect(
      db.$executeRaw`UPDATE procurement_fulfillment_events SET reason = 'changed' WHERE id = ${eventId}`
    ).rejects.toThrow();
    await expect(
      db.$executeRaw`DELETE FROM procurement_fulfillment_events WHERE id = ${eventId}`
    ).rejects.toThrow();
    await expect(db.$executeRaw`TRUNCATE procurement_fulfillment_events`).rejects.toThrow();
  });
});
