import { randomUUID } from "node:crypto";

import { beforeAll, describe, expect, it } from "vitest";

import { db } from "@/lib/db";

const describeDatabase = process.env.RUN_DATABASE_INTEGRATION === "1" ? describe : describe.skip;
const suffix = randomUUID().slice(0, 8);
const ids = {
  admin: `milestone-admin-${suffix}`
};

async function seedProject(label: string) {
  const project = await db.project.create({
    data: {
      code: `P25.${label}.${suffix}`.toUpperCase(),
      name: `${label} milestone constraint project`,
      createdById: ids.admin
    }
  });
  const membership = await db.projectMember.create({
    data: {
      projectId: project.id,
      userId: ids.admin,
      projectRole: "PROJECT_MANAGER",
      departmentId: "engineering",
      assignedById: ids.admin
    }
  });
  const wbsNode = await db.wbsNode.create({
    data: {
      projectId: project.id,
      code: "ROOT",
      name: "Milestone test root",
      position: 0,
      createdById: ids.admin,
      updatedById: ids.admin
    }
  });
  const plannedStartAt = new Date("2026-08-03T00:00:00.000Z");
  const plannedFinishAt = new Date("2026-08-03T08:00:00.000Z");
  const task = await db.planningTask.create({
    data: {
      projectId: project.id,
      wbsNodeId: wbsNode.id,
      ownerMembershipId: membership.id,
      code: "PLAN",
      name: "Milestone test task",
      position: 0,
      plannedStartAt,
      plannedFinishAt,
      plannedDurationMinutes: 480,
      weight: 1,
      remainingDurationMinutes: 480,
      forecastFinishAt: plannedFinishAt,
      createdById: ids.admin,
      updatedById: ids.admin
    }
  });

  return { project, task };
}

describeDatabase("APM-025 PostgreSQL project milestone facts", () => {
  beforeAll(async () => {
    await db.user.create({
      data: {
        id: ids.admin,
        employeeNo: `MILESTONE-ADMIN-${suffix}`,
        name: "Milestone administrator",
        departmentId: "engineering"
      }
    });
  });

  it("rejects cross-project or duplicate task links and protects immutable milestone events", async () => {
    const current = await seedProject("CURRENT");
    const foreign = await seedProject("FOREIGN");
    const milestone = await db.projectMilestone.create({
      data: {
        projectId: current.project.id,
        code: "DESIGN.FREEZE",
        name: "Design freeze",
        position: 10,
        createdById: ids.admin,
        updatedById: ids.admin
      }
    });
    const event = await db.projectMilestoneEvent.create({
      data: {
        projectId: current.project.id,
        milestoneId: milestone.id,
        sequence: 1,
        eventType: "CREATED",
        fromStatus: null,
        toStatus: "PENDING",
        reason: "Create milestone fact",
        snapshotJson: { status: "PENDING" },
        actorId: ids.admin
      }
    });

    await expect(
      db.projectMilestoneTaskLink.create({
        data: {
          projectId: current.project.id,
          milestoneId: milestone.id,
          taskId: foreign.task.id,
          status: "ACTIVE",
          createdById: ids.admin
        }
      })
    ).rejects.toThrow(/same project/u);

    await db.projectMilestoneTaskLink.create({
      data: {
        projectId: current.project.id,
        milestoneId: milestone.id,
        taskId: current.task.id,
        status: "ACTIVE",
        createdById: ids.admin
      }
    });
    await expect(
      db.projectMilestoneTaskLink.create({
        data: {
          projectId: current.project.id,
          milestoneId: milestone.id,
          taskId: current.task.id,
          status: "ACTIVE",
          createdById: ids.admin
        }
      })
    ).rejects.toThrow(/unique constraint/u);

    await expect(
      db.projectMilestoneEvent.update({
        where: { id: event.id },
        data: { reason: "tampered" }
      })
    ).rejects.toThrow(/append-only/u);
    await expect(db.projectMilestoneEvent.delete({ where: { id: event.id } })).rejects.toThrow(
      /append-only/u
    );
    await expect(db.$executeRawUnsafe('TRUNCATE TABLE "project_milestone_events"')).rejects.toThrow(
      /append-only/u
    );
  });
});
