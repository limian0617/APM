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
import { configureReadinessPolicy } from "@/modules/procurement/application/readiness-service";
import { configureProjectProcurement } from "@/modules/procurement/application/procurement-settings-service";
import {
  appendProcurementFulfillmentEvent,
  reverseProcurementFulfillmentEvent
} from "@/modules/procurement/application/fulfillment-event-service";

const describeDatabase = process.env.RUN_DATABASE_INTEGRATION === "1" ? describe : describe.skip;
const suffix = randomUUID().slice(0, 8);
const actorId = `event-admin-${suffix}`;
const projectId = `event-project-${suffix}`;
let eventId = "";
let requirementId = "";
let requirementRevisionId = "";

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
    await configureReadinessPolicy({
      projectId,
      inspectionRequired: false,
      arrivalAutoUsable: true,
      criticalRule: {},
      dueGraceDays: 0,
      gateThreshold: {},
      reason: "事件测试配置到货自动可用",
      actorId,
      auditContext: context("readiness-policy")
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
    requirementId = confirmed.requirement.id;
    requirementRevisionId = confirmed.requirement.currentRevision!.id;
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

  it("rejects an invalid unit and an outsourced event for a standard requirement in PostgreSQL", async () => {
    const base = {
      projectId,
      requirementId,
      requirementRevisionId,
      quantity: new Prisma.Decimal("1"),
      businessOccurredAt: new Date("2026-08-07T00:00:00Z"),
      source: "LOCAL" as const,
      reason: "数据库约束测试",
      createdById: actorId
    };
    await expect(
      db.procurementFulfillmentEvent.create({
        data: { ...base, eventType: "PURCHASE_ARRIVED", trackingUnit: "M" }
      })
    ).rejects.toThrow();
    await expect(
      db.procurementFulfillmentEvent.create({
        data: { ...base, eventType: "OUTSOURCED_DISPATCHED", trackingUnit: "PCS" }
      })
    ).rejects.toThrow();
  });

  it("records acceptance facts and one reversal with audit and outbox records", async () => {
    const arrival = await appendProcurementFulfillmentEvent({
      projectId,
      requirementId,
      requirementRevisionId,
      eventType: "PURCHASE_ARRIVED",
      quantity: "1",
      trackingUnit: "PCS",
      businessOccurredAt: "2026-08-07T00:00:00.000Z",
      reason: "补充到货",
      actorId,
      auditContext: context("arrival")
    });
    expect(arrival.events).toHaveLength(2);
    expect(arrival.events[1]).toMatchObject({
      eventType: "MARKED_USABLE",
      quantity: "1",
      derivedFromEventId: arrival.events[0]!.id
    });
    expect(arrival.auditIds).toHaveLength(2);
    expect(arrival.outboxEventIds).toHaveLength(2);

    const accepted = await appendProcurementFulfillmentEvent({
      projectId,
      requirementId,
      requirementRevisionId,
      eventType: "ACCEPTED",
      quantity: "2",
      trackingUnit: "PCS",
      businessOccurredAt: "2026-08-07T01:00:00.000Z",
      reason: "验收合格",
      actorId,
      auditContext: context("accepted")
    });
    const reversed = await reverseProcurementFulfillmentEvent({
      projectId,
      eventId: accepted.events[0]!.id,
      version: accepted.resourceVersion,
      reason: "录入错误，冲销验收",
      actorId,
      auditContext: context("reverse")
    });
    expect(reversed.events[0]).toMatchObject({
      eventType: "REVERSED",
      quantity: accepted.events[0]!.quantity,
      trackingUnit: "PCS",
      reversesEventId: accepted.events[0]!.id
    });
    expect(reversed.auditIds).toHaveLength(1);
    expect(reversed.outboxEventIds).toHaveLength(1);

    const reversedAutomaticArrival = await reverseProcurementFulfillmentEvent({
      projectId,
      eventId: arrival.events[0]!.id,
      version: reversed.resourceVersion,
      reason: "冲销自动可用的到货",
      actorId,
      auditContext: context("reverse-automatic-arrival")
    });
    expect(reversedAutomaticArrival.events).toHaveLength(2);
    expect(reversedAutomaticArrival.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          eventType: "REVERSED",
          reversesEventId: arrival.events[0]!.id
        }),
        expect.objectContaining({
          eventType: "REVERSED",
          reversesEventId: arrival.events[1]!.id
        })
      ])
    );
    expect(reversedAutomaticArrival.auditIds).toHaveLength(2);
    expect(reversedAutomaticArrival.outboxEventIds).toHaveLength(2);

    await expect(
      reverseProcurementFulfillmentEvent({
        projectId,
        eventId: accepted.events[0]!.id,
        version: reversed.resourceVersion,
        reason: "重复冲销",
        actorId,
        auditContext: context("reverse-again")
      })
    ).rejects.toThrow(
      expect.objectContaining({ code: "PROC_EVENT_ALREADY_REVERSED", status: 409 })
    );
  });
});
