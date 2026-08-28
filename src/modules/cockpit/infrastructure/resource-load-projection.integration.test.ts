import { randomUUID } from "node:crypto";

import { beforeAll, describe, expect, it } from "vitest";

import { db } from "@/lib/db";
import type { AuditContext } from "@/modules/audit/contracts/audit";

import {
  getLatestProjectResourceLoad,
  refreshProjectResourceLoad
} from "../application/resource-load-projection-service";

const describeDatabase = process.env.RUN_DATABASE_INTEGRATION === "1" ? describe : describe.skip;
const suffix = randomUUID().slice(0, 8);
const actorId = `resource-manager-${suffix}`;

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

describeDatabase("APM-042 PostgreSQL resource-load projections", () => {
  beforeAll(async () => {
    await db.user.create({
      data: {
        id: actorId,
        employeeNo: `APM042-MANAGER-${suffix}`,
        name: "Resource manager",
        departmentId: "engineering"
      }
    });
  });

  it("materializes immutable current load, reuses equal sources, and becomes stale after a task change", async () => {
    const project = await db.project.create({
      data: {
        code: `APM042.${suffix}`.toUpperCase(),
        name: "APM-042 resource load",
        departmentId: "engineering",
        createdById: actorId
      }
    });
    const membership = await db.projectMember.create({
      data: {
        projectId: project.id,
        userId: actorId,
        projectRole: "ENGINEER",
        departmentId: "engineering",
        assignedById: actorId
      }
    });
    const node = await db.wbsNode.create({
      data: {
        projectId: project.id,
        code: "DESIGN",
        name: "Design",
        position: 1,
        createdById: actorId,
        updatedById: actorId
      }
    });
    const task = await db.planningTask.create({
      data: {
        projectId: project.id,
        wbsNodeId: node.id,
        ownerMembershipId: membership.id,
        code: "MECHANICAL.DESIGN",
        name: "Mechanical design",
        position: 1,
        plannedStartAt: new Date("2026-08-03T09:00:00.000Z"),
        plannedFinishAt: new Date("2026-08-05T17:00:00.000Z"),
        plannedDurationMinutes: 1_440,
        remainingDurationMinutes: 1_440,
        forecastFinishAt: new Date("2026-08-05T17:00:00.000Z"),
        weight: 100,
        createdById: actorId,
        updatedById: actorId
      }
    });

    const first = await refreshProjectResourceLoad({
      projectId: project.id,
      reason: "Create resource-load snapshot",
      actorId,
      auditContext: auditContext(project.id, "resource-first")
    });
    const replay = await refreshProjectResourceLoad({
      projectId: project.id,
      reason: "Repeat equal resource-load snapshot",
      actorId,
      auditContext: auditContext(project.id, "resource-replay")
    });

    expect(first).toMatchObject({
      reused: false,
      projection: {
        projectId: project.id,
        departments: [
          expect.objectContaining({
            departmentId: "engineering",
            plannedDays: 3,
            activeTaskCount: 1
          })
        ]
      }
    });
    expect(replay).toMatchObject({
      reused: true,
      projection: { projectionId: first.projection.projectionId }
    });
    await expect(
      db.resourceLoadProjection.count({ where: { projectId: project.id } })
    ).resolves.toBe(1);
    await expect(
      db.auditLog.count({
        where: { projectId: project.id, action: "COCKPIT_RESOURCE_LOAD_REFRESHED" }
      })
    ).resolves.toBe(1);
    await expect(
      db.outboxEvent.count({
        where: {
          aggregateId: first.projection.projectionId,
          eventType: "cockpit.resource-load.refreshed"
        }
      })
    ).resolves.toBe(1);
    await expect(
      db.$executeRaw`UPDATE "resource_load_projections" SET "source_checksum" = ${"f".repeat(64)} WHERE "id" = ${first.projection.projectionId}`
    ).rejects.toThrow();
    await expect(
      db.$executeRaw`DELETE FROM "resource_load_task_projections" WHERE "projection_id" = ${first.projection.projectionId}`
    ).rejects.toThrow();
    await expect(getLatestProjectResourceLoad(project.id, false)).resolves.toMatchObject({
      status: "READY"
    });

    await db.user.update({
      where: { id: actorId },
      data: { name: "Renamed resource manager" }
    });
    await expect(getLatestProjectResourceLoad(project.id, true)).resolves.toMatchObject({
      status: "STALE",
      projection: {
        projectionId: first.projection.projectionId,
        departments: [
          {
            disciplines: [
              {
                people: [expect.objectContaining({ personName: "Resource manager" })]
              }
            ]
          }
        ]
      }
    });

    const renamed = await refreshProjectResourceLoad({
      projectId: project.id,
      reason: "Refresh after resource member rename",
      actorId,
      auditContext: auditContext(project.id, "resource-renamed")
    });
    await expect(getLatestProjectResourceLoad(project.id, true)).resolves.toMatchObject({
      status: "READY",
      projection: {
        projectionId: renamed.projection.projectionId,
        departments: [
          {
            disciplines: [
              {
                people: [expect.objectContaining({ personName: "Renamed resource manager" })]
              }
            ]
          }
        ]
      }
    });

    await db.planningTask.update({
      where: { id: task.id },
      data: {
        plannedFinishAt: new Date("2026-08-06T17:00:00.000Z"),
        forecastFinishAt: new Date("2026-08-06T17:00:00.000Z"),
        version: { increment: 1 }
      }
    });

    await expect(getLatestProjectResourceLoad(project.id, false)).resolves.toMatchObject({
      status: "STALE"
    });
  });
});
