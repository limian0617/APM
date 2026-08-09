import { randomUUID } from "node:crypto";

import { Prisma, PrismaClient } from "@prisma/client";
import { beforeAll, describe, expect, it } from "vitest";

import { db } from "@/lib/db";
import type { AuditContext } from "@/modules/audit/contracts/audit";
import {
  cancelMaterialRequirement,
  createMaterialReference,
  createMaterialRequirementDraft,
  confirmMaterialRequirement,
  reviseMaterialRequirement
} from "@/modules/procurement/application/material-requirement-service";
import { configureProjectProcurement } from "@/modules/procurement/application/procurement-settings-service";
import {
  createProcurementTrackingLine,
  updateLocalProcurementTrackingLine
} from "@/modules/procurement/application/procurement-tracking-service";
import {
  configureReadinessPolicy,
  requestReadinessRecalculation
} from "@/modules/procurement/application/readiness-service";
import { createReadinessRecalculationHandler } from "@/modules/procurement/application/readiness-recalculation-handler";
import {
  appendProcurementFulfillmentEvent,
  reverseProcurementFulfillmentEvent
} from "@/modules/procurement/application/fulfillment-event-service";
import type { JobExecution } from "@/modules/governance/contracts/jobs";

const describeDatabase = process.env.RUN_DATABASE_INTEGRATION === "1" ? describe : describe.skip;
const suffix = randomUUID().slice(0, 8);
const actorId = `readiness-admin-${suffix}`;
const projectId = `readiness-project-${suffix}`;
let requirementId = "";
let requirementRevisionId = "";
let trackingLineId = "";

function context(operationId: string): AuditContext {
  return {
    actorId,
    requestId: `request-${operationId}`,
    traceId: "a".repeat(32),
    source: "API",
    sourceIp: null,
    userAgent: "Vitest",
    reason: null,
    projectId,
    departmentId: "engineering",
    operationId
  };
}

function job(inputWatermark: string): JobExecution {
  return {
    id: `readiness-job-${inputWatermark.slice(0, 8)}`,
    jobType: "procurement.readiness-recalculation.requested",
    payload: {
      projectId,
      inputWatermark,
      formulaVersion: "PROCUREMENT.READINESS@1"
    },
    payloadHash: "a".repeat(64),
    idempotencyKey: `readiness-${inputWatermark}`,
    traceId: "a".repeat(32),
    attemptId: `attempt-${inputWatermark.slice(0, 8)}`,
    attemptNumber: 1,
    maxAttempts: 3,
    isReplay: false,
    workerId: "readiness-integration-test"
  };
}

function writeTriggeredJob(payload: JobExecution["payload"]): JobExecution {
  return {
    id: `write-triggered-readiness-${randomUUID().slice(0, 8)}`,
    jobType: "procurement.readiness-recalculation.requested",
    payload,
    payloadHash: "a".repeat(64),
    idempotencyKey: `write-triggered-readiness-${randomUUID().slice(0, 8)}`,
    traceId: "a".repeat(32),
    attemptId: `write-triggered-attempt-${randomUUID().slice(0, 8)}`,
    attemptNumber: 1,
    maxAttempts: 3,
    isReplay: false,
    workerId: "readiness-integration-test"
  };
}

describeDatabase("APM-091B PostgreSQL readiness publication", () => {
  beforeAll(async () => {
    await db.user.create({
      data: {
        id: actorId,
        employeeNo: `READINESS-${suffix}`.toUpperCase(),
        name: "齐套计算测试人",
        departmentId: "engineering"
      }
    });
    await db.project.create({
      data: {
        id: projectId,
        code: `READINESS-${suffix}`.toUpperCase(),
        name: "齐套计算测试项目",
        departmentId: "engineering",
        createdById: actorId,
        initializationStatus: "READY",
        capabilityConfigurationStatus: "READY",
        capabilitiesConfiguredAt: new Date()
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
      reason: "齐套测试启用本地模式",
      actorId,
      auditContext: context("settings")
    });
    await configureReadinessPolicy({
      projectId,
      inspectionRequired: true,
      arrivalAutoUsable: false,
      criticalRule: {},
      dueGraceDays: 0,
      gateThreshold: {},
      reason: "齐套测试冻结政策",
      actorId,
      auditContext: context("policy")
    });
    const material = await createMaterialReference({
      projectId,
      source: "LOCAL",
      code: `READINESS-MAT-${suffix}`.toUpperCase(),
      name: "齐套测试物料",
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
      reason: "确认齐套测试需求",
      actorId,
      auditContext: context("confirm")
    });
    requirementId = confirmed.requirement.id;
    requirementRevisionId = confirmed.requirement.currentRevision!.id;
    const tracking = await createProcurementTrackingLine({
      projectId,
      requirementId,
      requirementRevisionId,
      businessType: "STANDARD_PURCHASE",
      orderedQuantity: "2",
      actorId,
      auditContext: context("tracking"),
      reason: "齐套事务隔离测试跟踪行"
    });
    trackingLineId = tracking.line.id;
  });

  it("queues readiness recalculation atomically for policy, confirmed requirements, and tracking", async () => {
    const requests = await db.outboxEvent.findMany({
      where: {
        eventType: "procurement.readiness-recalculation.requested",
        aggregateId: projectId
      },
      orderBy: { occurredAt: "asc" }
    });

    expect(requests).toHaveLength(3);
    expect(
      requests.every((event) => event.payload && (event.payload as any).projectId === projectId)
    ).toBe(true);
  });

  it("does not duplicate snapshots, audit, or published outbox events when the same handler runs twice", async () => {
    const request = await requestReadinessRecalculation({
      projectId,
      actorId,
      reason: "首次齐套计算",
      auditContext: context("request-1")
    });
    const handler = createReadinessRecalculationHandler();
    await handler(job(request.inputWatermark));
    await handler(job(request.inputWatermark));

    expect(
      await db.procurementReadinessResult.count({
        where: { projectId, inputWatermark: request.inputWatermark }
      })
    ).toBe(2);
    expect(
      await db.auditLog.count({
        where: { projectId, action: "PROCUREMENT_READINESS_CALCULATED" }
      })
    ).toBe(1);
    expect(
      await db.outboxEvent.count({
        where: { eventType: "procurement.readiness.published", aggregateId: projectId }
      })
    ).toBe(1);
  });

  it("publishes a new immutable snapshot after an input event and retains the prior snapshot", async () => {
    const before = await db.procurementReadinessResult.findFirstOrThrow({
      where: { projectId, scopeType: "PROJECT" },
      orderBy: { calculatedAt: "asc" }
    });
    await appendProcurementFulfillmentEvent({
      projectId,
      requirementId,
      requirementRevisionId,
      eventType: "ACCEPTED",
      quantity: "2",
      trackingUnit: "PCS",
      businessOccurredAt: "2026-08-07T00:00:00.000Z",
      reason: "齐套测试验收",
      actorId,
      auditContext: context("accepted")
    });
    const request = await db.outboxEvent.findFirstOrThrow({
      where: {
        eventType: "procurement.readiness-recalculation.requested",
        aggregateId: projectId
      },
      orderBy: { occurredAt: "desc" }
    });
    await createReadinessRecalculationHandler()(
      writeTriggeredJob(request.payload as unknown as JobExecution["payload"])
    );

    const results = await db.procurementReadinessResult.findMany({
      where: { projectId, scopeType: "PROJECT" },
      orderBy: { calculatedAt: "asc" }
    });
    expect(results).toHaveLength(2);
    expect(results[0]!.id).toBe(before.id);
    expect(results[0]!.inputWatermark).not.toBe(results[1]!.inputWatermark);
    expect(results[1]!.status).toBe("READY");
  });

  it("does not combine an earlier requirement read with a concurrent tracking write in one snapshot", async () => {
    const concurrent = new PrismaClient();
    try {
      const before = await db.procurementTrackingLine.findUniqueOrThrow({
        where: { id: trackingLineId },
        select: { version: true }
      });
      let snapshotTrackingVersion = -1;
      await db.$transaction(
        async (client) => {
          await client.projectMaterialRequirement.findUniqueOrThrow({
            where: { id: requirementId },
            select: { version: true }
          });
          const firstTracking = await client.procurementTrackingLine.findUniqueOrThrow({
            where: { id: trackingLineId },
            select: { version: true }
          });
          await concurrent.procurementTrackingLine.update({
            where: { id: trackingLineId },
            data: { supplierConfirmationStatus: "CONCURRENT", version: { increment: 1 } }
          });
          const secondTracking = await client.procurementTrackingLine.findUniqueOrThrow({
            where: { id: trackingLineId },
            select: { version: true }
          });
          snapshotTrackingVersion = secondTracking.version;
          expect(secondTracking.version).toBe(firstTracking.version);
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead }
      );
      const committed = await db.procurementTrackingLine.findUniqueOrThrow({
        where: { id: trackingLineId },
        select: { version: true }
      });

      expect(snapshotTrackingVersion).toBe(before.version);
      expect(committed.version).toBe(before.version + 1);
    } finally {
      await concurrent.$disconnect();
    }
  });

  it("queues each remaining readiness-affecting procurement write exactly once", async () => {
    const before = await db.outboxEvent.count({
      where: {
        eventType: "procurement.readiness-recalculation.requested",
        aggregateId: projectId
      }
    });
    const material = await createMaterialReference({
      projectId,
      source: "LOCAL",
      code: `READINESS-REVISION-${suffix}`.toUpperCase(),
      name: "齐套修订测试物料",
      trackingUnit: "PCS",
      actorId,
      auditContext: context("revision-material")
    });
    const draft = await createMaterialRequirementDraft({
      projectId,
      materialReferenceId: material.materialReference.id,
      quantity: "1",
      trackingUnit: "PCS",
      requiredOn: "2026-09-02",
      isCritical: false,
      businessType: "STANDARD_PURCHASE",
      source: "MANUAL",
      actorId,
      auditContext: context("revision-draft")
    });
    const confirmed = await confirmMaterialRequirement({
      projectId,
      requirementId: draft.requirement.id,
      version: draft.resourceVersion,
      reason: "确认修订测试需求",
      actorId,
      auditContext: context("revision-confirm")
    });
    const revised = await reviseMaterialRequirement({
      projectId,
      requirementId: confirmed.requirement.id,
      version: confirmed.resourceVersion,
      materialReferenceId: material.materialReference.id,
      quantity: "1",
      trackingUnit: "PCS",
      requiredOn: "2026-09-03",
      isCritical: false,
      businessType: "STANDARD_PURCHASE",
      source: "MANUAL",
      actorId,
      reason: "修订齐套测试需求",
      auditContext: context("revision-revise")
    });
    await cancelMaterialRequirement({
      projectId,
      requirementId: revised.requirement.id,
      version: revised.resourceVersion,
      reason: "取消齐套测试需求",
      actorId,
      auditContext: context("revision-cancel")
    });
    const tracking = await db.procurementTrackingLine.findUniqueOrThrow({
      where: { id: trackingLineId },
      select: { version: true }
    });
    await updateLocalProcurementTrackingLine({
      projectId,
      trackingLineId,
      version: tracking.version,
      supplierConfirmationStatus: "UPDATED",
      actorId,
      auditContext: context("tracking-update"),
      reason: "更新齐套测试跟踪行"
    });
    const appended = await appendProcurementFulfillmentEvent({
      projectId,
      requirementId,
      requirementRevisionId,
      eventType: "MARKED_USABLE",
      quantity: "2",
      trackingUnit: "PCS",
      businessOccurredAt: "2026-08-08T00:00:00.000Z",
      reason: "齐套反向测试履约事件",
      actorId,
      auditContext: context("reverse-append")
    });
    const currentRequirement = await db.projectMaterialRequirement.findUniqueOrThrow({
      where: { id: requirementId },
      select: { version: true }
    });
    await reverseProcurementFulfillmentEvent({
      projectId,
      eventId: appended.events[0]!.id,
      version: currentRequirement.version,
      reason: "反向齐套测试履约事件",
      actorId,
      auditContext: context("reverse")
    });

    await expect(
      db.outboxEvent.count({
        where: {
          eventType: "procurement.readiness-recalculation.requested",
          aggregateId: projectId
        }
      })
    ).resolves.toBe(before + 6);
  });
});
