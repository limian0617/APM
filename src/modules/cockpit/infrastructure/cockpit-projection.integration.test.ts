import { randomUUID } from "node:crypto";

import { beforeAll, describe, expect, it } from "vitest";

import { db } from "@/lib/db";
import type { AuditContext } from "@/modules/audit/contracts/audit";

import { refreshProjectCockpitProjection } from "../application/cockpit-projection-service";

const describeDatabase = process.env.RUN_DATABASE_INTEGRATION === "1" ? describe : describe.skip;
const suffix = randomUUID().slice(0, 8);
const actorId = `cockpit-manager-${suffix}`;

function auditContext(projectId: string, operationId: string): AuditContext {
  return {
    actorId,
    requestId: `request-${operationId}`,
    traceId: null,
    source: "API",
    sourceIp: null,
    userAgent: "Vitest",
    reason: null,
    projectId,
    departmentId: "engineering",
    operationId
  };
}

describeDatabase("APM-040 PostgreSQL cockpit projections", () => {
  beforeAll(async () => {
    await db.user.create({
      data: {
        id: actorId,
        employeeNo: `APM040-MANAGER-${suffix}`,
        name: "Cockpit manager",
        departmentId: "engineering"
      }
    });
  });

  it("materializes an immutable unknown projection and reuses an unchanged source snapshot", async () => {
    const project = await db.project.create({
      data: {
        code: `APM040.${suffix}`.toUpperCase(),
        name: "APM-040 cockpit projection",
        departmentId: "engineering",
        createdById: actorId
      }
    });

    const first = await refreshProjectCockpitProjection({
      projectId: project.id,
      reason: "首次生成驾驶舱读模型",
      actorId,
      auditContext: auditContext(project.id, "cockpit-first")
    });
    const replay = await refreshProjectCockpitProjection({
      projectId: project.id,
      reason: "重复生成相同驾驶舱读模型",
      actorId,
      auditContext: auditContext(project.id, "cockpit-replay")
    });

    expect(first).toMatchObject({
      reused: false,
      projection: { projectId: project.id, health: "UNKNOWN" }
    });
    expect(replay).toMatchObject({
      reused: true,
      projection: { projectionId: first.projection.projectionId }
    });
    await expect(db.cockpitProjection.count({ where: { projectId: project.id } })).resolves.toBe(1);
    await expect(
      db.auditLog.count({
        where: { projectId: project.id, action: "COCKPIT_PROJECTION_REFRESHED" }
      })
    ).resolves.toBe(1);
    await expect(
      db.outboxEvent.count({
        where: {
          aggregateId: first.projection.projectionId,
          eventType: "cockpit.projection.refreshed"
        }
      })
    ).resolves.toBe(1);
    await expect(
      db.$executeRaw`UPDATE "cockpit_projections" SET "health" = 'HEALTHY' WHERE "id" = ${first.projection.projectionId}`
    ).rejects.toThrow();
    await expect(
      db.$executeRaw`DELETE FROM "cockpit_exception_projections" WHERE "projection_id" = ${first.projection.projectionId}`
    ).rejects.toThrow();
  });

  it("projects an active high-risk alert with its source rule into a critical snapshot", async () => {
    const project = await db.project.create({
      data: {
        code: `APM040.ALERT.${suffix}`.toUpperCase(),
        name: "APM-040 cockpit alert projection",
        departmentId: "engineering",
        createdById: actorId
      }
    });
    const membership = await db.projectMember.create({
      data: {
        projectId: project.id,
        userId: actorId,
        projectRole: "PROJECT_MANAGER",
        departmentId: "engineering",
        assignedById: actorId
      }
    });
    const rule = await db.projectAlertRule.create({
      data: {
        projectId: project.id,
        code: "COCKPIT.HIGH.RISK",
        name: "驾驶舱高风险预警",
        sourceType: "MILESTONE_OVERDUE",
        conditionJson: {},
        probability: "HIGH",
        impact: "HIGH",
        ownerMembershipId: membership.id,
        escalationMembershipId: membership.id,
        escalationAfterDays: 1,
        createdById: actorId,
        updatedById: actorId
      }
    });
    const alert = await db.projectAlert.create({
      data: {
        projectId: project.id,
        ruleId: rule.id,
        sourceType: "MILESTONE_OVERDUE",
        sourceKey: "milestone-cockpit-alert",
        sourceSnapshot: {},
        probability: "HIGH",
        impact: "HIGH",
        ownerUserId: actorId,
        ownerMembershipSnapshot: {},
        escalationUserId: actorId,
        escalationMembershipSnapshot: {}
      }
    });

    const result = await refreshProjectCockpitProjection({
      projectId: project.id,
      reason: "生成高风险预警驾驶舱投影",
      actorId,
      auditContext: auditContext(project.id, "cockpit-high-risk")
    });

    expect(result).toMatchObject({
      reused: false,
      projection: {
        health: "CRITICAL",
        exceptions: [
          {
            kind: "HIGH_RISK_ALERT",
            sourceKey: alert.id,
            severity: "CRITICAL"
          }
        ]
      }
    });
    expect(result.projection.sourceVersions).toMatchObject({
      highRiskAlerts: [{ alertId: alert.id, ruleCode: rule.code, status: "TRIGGERED" }]
    });
    await expect(
      db.auditLog.count({
        where: { projectId: project.id, action: "COCKPIT_PROJECTION_REFRESHED" }
      })
    ).resolves.toBe(1);
    await expect(
      db.outboxEvent.count({
        where: {
          aggregateId: result.projection.projectionId,
          eventType: "cockpit.projection.refreshed"
        }
      })
    ).resolves.toBe(1);
  });
});
