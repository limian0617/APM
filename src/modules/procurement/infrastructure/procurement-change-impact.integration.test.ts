import { randomUUID } from "node:crypto";

import { beforeAll, describe, expect, it } from "vitest";

import { db } from "@/lib/db";
import type { AuditContext } from "@/modules/audit/contracts/audit";
import { resolveProcurementChangeImpact } from "@/modules/procurement/application/change-impact-service";

const describeDatabase = process.env.RUN_DATABASE_INTEGRATION === "1" ? describe : describe.skip;
const suffix = randomUUID().slice(0, 8);
const projectId = `change-impact-project-${suffix}`;
const ownerUserId = `change-owner-${suffix}`;
const trackingUserId = `change-tracking-${suffix}`;
let impactId = "";
let ownerObligationId = "";
let trackingObligationId = "";

function context(actorId: string, operationId: string): AuditContext {
  return {
    actorId,
    requestId: `request-${operationId}`,
    traceId: "b".repeat(32),
    source: "API",
    sourceIp: null,
    userAgent: "Vitest",
    reason: null,
    projectId,
    departmentId: "engineering",
    operationId
  };
}

describeDatabase("APM-091B PostgreSQL procurement change impact concurrency", () => {
  beforeAll(async () => {
    await db.user.createMany({
      data: [
        {
          id: ownerUserId,
          employeeNo: `CHANGE-OWNER-${suffix}`.toUpperCase(),
          name: "采购负责人"
        },
        {
          id: trackingUserId,
          employeeNo: `CHANGE-TRACK-${suffix}`.toUpperCase(),
          name: "采购跟踪人"
        }
      ]
    });
    await db.project.create({
      data: {
        id: projectId,
        code: `CHANGE-${suffix}`.toUpperCase(),
        name: "采购变更并发测试项目",
        departmentId: "engineering",
        createdById: ownerUserId
      }
    });
    const [ownerMembership, trackingMembership] = await Promise.all([
      db.projectMember.create({
        data: {
          projectId,
          userId: ownerUserId,
          projectRole: "PROCUREMENT",
          departmentId: "engineering",
          assignedById: ownerUserId
        }
      }),
      db.projectMember.create({
        data: {
          projectId,
          userId: trackingUserId,
          projectRole: "PROJECT_MANAGER",
          departmentId: "engineering",
          assignedById: ownerUserId
        }
      })
    ]);
    const material = await db.materialReference.create({
      data: {
        projectId,
        source: "LOCAL",
        code: `CHANGE-MAT-${suffix}`.toUpperCase(),
        name: "采购变更测试物料",
        trackingUnit: "PCS",
        createdById: ownerUserId,
        updatedById: ownerUserId
      }
    });
    const requirement = await db.projectMaterialRequirement.create({
      data: { projectId, status: "CONFIRMED", createdById: ownerUserId, updatedById: ownerUserId }
    });
    const revision = await db.projectMaterialRequirementRevision.create({
      data: {
        projectId,
        requirementId: requirement.id,
        revision: 1,
        materialReferenceId: material.id,
        materialCodeSnapshot: material.code,
        materialNameSnapshot: material.name,
        quantity: "1",
        trackingUnit: "PCS",
        requiredOn: new Date("2026-09-01T00:00:00.000Z"),
        businessType: "STANDARD_PURCHASE",
        source: "MANUAL",
        status: "CONFIRMED",
        confirmedById: ownerUserId,
        confirmedAt: new Date("2026-08-08T00:00:00.000Z"),
        createdById: ownerUserId
      }
    });
    await db.projectMaterialRequirement.update({
      where: { id: requirement.id },
      data: { currentRevisionId: revision.id }
    });
    const impact = await db.procurementChangeImpact.create({
      data: {
        projectId,
        requirementId: requirement.id,
        previousRevisionId: revision.id,
        type: "CANCELED",
        changedFieldsJson: ["canceled"],
        detectedById: ownerUserId,
        obligations: {
          create: [
            {
              projectId,
              type: "PROCUREMENT_OWNER",
              subjectId: ownerMembership.id
            },
            {
              projectId,
              type: "OLD_TRACKING",
              subjectId: trackingMembership.id
            }
          ]
        }
      },
      include: { obligations: { orderBy: { type: "asc" } } }
    });
    impactId = impact.id;
    ownerObligationId = impact.obligations.find(
      (obligation) => obligation.type === "PROCUREMENT_OWNER"
    )!.id;
    trackingObligationId = impact.obligations.find(
      (obligation) => obligation.type === "OLD_TRACKING"
    )!.id;
  });

  it("resolves exactly once after two final obligations complete concurrently", async () => {
    await Promise.all([
      resolveProcurementChangeImpact({
        projectId,
        impactId,
        obligationId: ownerObligationId,
        version: 1,
        disposition: "OWNER_PLAN_CONFIRMED",
        evidenceReference: "owner-plan:concurrent",
        reason: "采购负责人确认处置",
        actorId: ownerUserId,
        auditContext: context(ownerUserId, "owner-resolution")
      }),
      resolveProcurementChangeImpact({
        projectId,
        impactId,
        obligationId: trackingObligationId,
        version: 1,
        disposition: "CONTINUE_USE",
        evidenceReference: "tracking-disposition:concurrent",
        reason: "旧跟踪行继续使用确认",
        actorId: trackingUserId,
        auditContext: context(trackingUserId, "tracking-resolution")
      })
    ]);

    await expect(
      db.procurementChangeImpact.findUniqueOrThrow({ where: { id: impactId } })
    ).resolves.toMatchObject({ status: "RESOLVED", version: 2 });
    await expect(
      db.procurementChangeImpactResolution.count({ where: { impactId, projectId } })
    ).resolves.toBe(2);
    await expect(
      db.auditLog.count({
        where: { projectId, action: "PROCUREMENT_CHANGE_IMPACT_RESOLVED", objectId: impactId }
      })
    ).resolves.toBe(1);
    await expect(
      db.outboxEvent.count({
        where: {
          aggregateId: impactId,
          eventType: "procurement.change-impact.resolved"
        }
      })
    ).resolves.toBe(1);
  });
});
