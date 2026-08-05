import { randomUUID } from "node:crypto";

import { beforeAll, describe, expect, it } from "vitest";

import { db } from "@/lib/db";
import type { AuditContext } from "@/modules/audit/contracts/audit";

import {
  createProjectAlertRule,
  requestProjectAlertScan,
  runProjectAlertScan,
  transitionProjectAlert,
  updateProjectAlertRule
} from "../application/alert-service";

const describeDatabase = process.env.RUN_DATABASE_INTEGRATION === "1" ? describe : describe.skip;
const suffix = randomUUID().slice(0, 8);
const ids = {
  manager: `alert-manager-${suffix}`,
  owner: `alert-owner-${suffix}`,
  escalation: `alert-escalation-${suffix}`
};

function auditContext(operationId: string, projectId: string): AuditContext {
  return {
    actorId: ids.manager,
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

async function seedProject(label: string) {
  const project = await db.project.create({
    data: {
      code: `APM034.${label}.${suffix}`.toUpperCase(),
      name: `APM-034 ${label}`,
      departmentId: "engineering",
      createdById: ids.manager
    }
  });
  const [manager, owner, escalation] = await Promise.all([
    db.projectMember.create({
      data: {
        projectId: project.id,
        userId: ids.manager,
        projectRole: "PROJECT_MANAGER",
        departmentId: "engineering",
        assignedById: ids.manager
      }
    }),
    db.projectMember.create({
      data: {
        projectId: project.id,
        userId: ids.owner,
        projectRole: "ENGINEER",
        departmentId: "engineering",
        assignedById: ids.manager
      }
    }),
    db.projectMember.create({
      data: {
        projectId: project.id,
        userId: ids.escalation,
        projectRole: "DEPARTMENT_LEAD",
        departmentId: "engineering",
        assignedById: ids.manager
      }
    })
  ]);
  return { project, manager, owner, escalation };
}

describeDatabase("APM-034 PostgreSQL alert governance", () => {
  beforeAll(async () => {
    await db.user.createMany({
      data: [
        {
          id: ids.manager,
          employeeNo: `APM034-MANAGER-${suffix}`,
          name: "Alert manager",
          departmentId: "engineering"
        },
        {
          id: ids.owner,
          employeeNo: `APM034-OWNER-${suffix}`,
          name: "Alert owner",
          departmentId: "engineering"
        },
        {
          id: ids.escalation,
          employeeNo: `APM034-ESCALATION-${suffix}`,
          name: "Alert escalation",
          departmentId: "engineering"
        }
      ]
    });
  });

  it("creates scoped rules, deduplicates repeated scans, and records lifecycle facts", async () => {
    const facts = await seedProject("SCAN");
    const created = await createProjectAlertRule({
      projectId: facts.project.id,
      code: "SCHEDULE.STALE",
      name: "Schedule forecast stale",
      sourceType: "SCHEDULE_FORECAST_STALE",
      condition: { maximumAgeDays: 1 },
      probability: "MEDIUM",
      impact: "HIGH",
      ownerMembershipId: facts.owner.id,
      escalationMembershipId: facts.escalation.id,
      escalationAfterDays: 0,
      actorId: ids.manager,
      auditContext: auditContext("rule-create", facts.project.id)
    });
    const scanRequest = await requestProjectAlertScan({
      projectId: facts.project.id,
      idempotencyKey: `scan-${suffix}`,
      actorId: ids.manager,
      auditContext: auditContext("scan-request", facts.project.id)
    });
    const scanReplay = await requestProjectAlertScan({
      projectId: facts.project.id,
      idempotencyKey: `scan-${suffix}`,
      actorId: ids.manager,
      auditContext: auditContext("scan-request-replay", facts.project.id)
    });
    expect(scanReplay).toMatchObject({ repeated: true, scan: { id: scanRequest.scan.id } });

    const firstRun = await runProjectAlertScan({
      projectId: facts.project.id,
      scanId: scanRequest.scan.id
    });
    const secondRun = await runProjectAlertScan({
      projectId: facts.project.id,
      scanId: scanRequest.scan.id
    });
    expect(firstRun).toMatchObject({
      repeated: false,
      triggeredCount: 1,
      scan: { status: "SUCCEEDED" }
    });
    expect(secondRun).toMatchObject({ repeated: true, triggeredCount: 0 });

    const alert = await db.projectAlert.findFirstOrThrow({
      where: { projectId: facts.project.id, ruleId: created.rule.id }
    });
    expect(alert.escalatedAt).not.toBeNull();
    await expect(
      transitionProjectAlert({
        projectId: facts.project.id,
        alertId: alert.id,
        action: "ACKNOWLEDGE",
        version: alert.version,
        reason: "Owner has received the warning",
        actorId: ids.owner,
        auditContext: auditContext("alert-acknowledge", facts.project.id)
      })
    ).resolves.toMatchObject({ alert: { status: "ACKNOWLEDGED" } });
    await expect(
      transitionProjectAlert({
        projectId: facts.project.id,
        alertId: alert.id,
        action: "CLOSE",
        version: 2,
        reason: "Owner cannot close alone",
        actorId: ids.owner,
        auditContext: auditContext("alert-owner-close", facts.project.id)
      })
    ).rejects.toMatchObject({ code: "ALERT_CLOSE_FORBIDDEN", status: 403 });

    const acknowledged = await db.projectAlert.findUniqueOrThrow({ where: { id: alert.id } });
    const resolved = await transitionProjectAlert({
      projectId: facts.project.id,
      alertId: alert.id,
      action: "RESOLVE",
      version: acknowledged.version,
      reason: "Forecast has been refreshed",
      actorId: ids.owner,
      auditContext: auditContext("alert-resolve", facts.project.id)
    });
    await expect(
      transitionProjectAlert({
        projectId: facts.project.id,
        alertId: alert.id,
        action: "CLOSE",
        version: resolved.alert.version,
        reason: "Project manager confirms closure",
        actorId: ids.manager,
        auditContext: auditContext("alert-close", facts.project.id)
      })
    ).resolves.toMatchObject({ alert: { status: "CLOSED" } });
    await expect(db.projectAlertEvent.count({ where: { alertId: alert.id } })).resolves.toBe(5);
    await expect(
      db.$executeRaw`DELETE FROM "project_alert_events" WHERE "alert_id" = ${alert.id}`
    ).rejects.toThrow();
  });

  it("uses optimistic versions for rule updates and blocks physical removal of alert facts", async () => {
    const facts = await seedProject("RULE");
    const foreign = await seedProject("FOREIGN");
    const created = await createProjectAlertRule({
      projectId: facts.project.id,
      code: "MILESTONE.OVERDUE",
      name: "Milestone overdue",
      sourceType: "MILESTONE_OVERDUE",
      condition: { thresholdDays: 1 },
      probability: "LOW",
      impact: "MEDIUM",
      ownerMembershipId: facts.owner.id,
      escalationMembershipId: facts.escalation.id,
      escalationAfterDays: 2,
      actorId: ids.manager,
      auditContext: auditContext("rule-create-two", facts.project.id)
    });
    const updated = await updateProjectAlertRule({
      projectId: facts.project.id,
      ruleId: created.rule.id,
      version: created.rule.version,
      code: "MILESTONE.OVERDUE",
      name: "Milestone overdue",
      sourceType: "MILESTONE_OVERDUE",
      condition: { thresholdDays: 2 },
      probability: "LOW",
      impact: "MEDIUM",
      ownerMembershipId: facts.owner.id,
      escalationMembershipId: facts.escalation.id,
      escalationAfterDays: 2,
      status: "DISABLED",
      reason: "Temporarily disable after project close",
      actorId: ids.manager,
      auditContext: auditContext("rule-disable", facts.project.id)
    });
    expect(updated.rule).toMatchObject({ status: "DISABLED", version: 2 });
    await expect(
      createProjectAlertRule({
        projectId: facts.project.id,
        code: "FOREIGN.MEMBER",
        name: "Foreign member must be rejected",
        sourceType: "MILESTONE_OVERDUE",
        condition: { thresholdDays: 1 },
        probability: "LOW",
        impact: "MEDIUM",
        ownerMembershipId: foreign.owner.id,
        escalationMembershipId: facts.escalation.id,
        escalationAfterDays: 2,
        actorId: ids.manager,
        auditContext: auditContext("foreign-member", facts.project.id)
      })
    ).rejects.toMatchObject({ code: "MEMBERSHIP_INVALID", status: 422 });
    await expect(
      updateProjectAlertRule({
        projectId: facts.project.id,
        ruleId: created.rule.id,
        version: 1,
        code: "MILESTONE.OVERDUE",
        name: "Milestone overdue",
        sourceType: "MILESTONE_OVERDUE",
        condition: { thresholdDays: 2 },
        probability: "LOW",
        impact: "MEDIUM",
        ownerMembershipId: facts.owner.id,
        escalationMembershipId: facts.escalation.id,
        escalationAfterDays: 2,
        status: "DISABLED",
        reason: "Stale update",
        actorId: ids.manager,
        auditContext: auditContext("rule-stale", facts.project.id)
      })
    ).rejects.toMatchObject({ code: "VERSION_CONFLICT", status: 409 });
    await expect(
      db.$executeRaw`DELETE FROM "project_alert_rules" WHERE "id" = ${created.rule.id}`
    ).rejects.toThrow();
  });

  it("persists a failed scan when an active rule loses its configured owner", async () => {
    const facts = await seedProject("FAILED-SCAN");
    await createProjectAlertRule({
      projectId: facts.project.id,
      code: "SCHEDULE.FAILED",
      name: "Schedule stale failure test",
      sourceType: "SCHEDULE_FORECAST_STALE",
      condition: { maximumAgeDays: 1 },
      probability: "MEDIUM",
      impact: "HIGH",
      ownerMembershipId: facts.owner.id,
      escalationMembershipId: facts.escalation.id,
      escalationAfterDays: 1,
      actorId: ids.manager,
      auditContext: auditContext("failed-rule", facts.project.id)
    });
    await db.projectMember.update({
      where: { id: facts.owner.id },
      data: { leftAt: new Date(), leftById: ids.manager }
    });
    const requested = await requestProjectAlertScan({
      projectId: facts.project.id,
      idempotencyKey: `failed-scan-${suffix}`,
      actorId: ids.manager,
      auditContext: auditContext("failed-scan-request", facts.project.id)
    });
    await expect(
      runProjectAlertScan({ projectId: facts.project.id, scanId: requested.scan.id })
    ).rejects.toMatchObject({ code: "MEMBERSHIP_INVALID", status: 422 });
    await expect(
      db.projectAlertScan.findUniqueOrThrow({ where: { id: requested.scan.id } })
    ).resolves.toMatchObject({ status: "FAILED", errorCode: "ALERT_SCAN_FAILED" });
  });
});
