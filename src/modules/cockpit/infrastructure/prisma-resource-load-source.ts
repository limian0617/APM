import { PlanningTaskStatus, type Prisma } from "@prisma/client";

import type { ResourceLoadSourceRow } from "../domain/resource-load";

function iso(value: Date): string {
  return value.toISOString();
}

export type ResourceLoadProjectionSource = {
  rows: ResourceLoadSourceRow[];
  sourceVersions: Record<string, unknown>;
};

export async function loadResourceLoadProjectionSource(
  client: Prisma.TransactionClient,
  projectId: string
): Promise<ResourceLoadProjectionSource | null> {
  const project = await client.project.findUnique({
    where: { id: projectId },
    select: { id: true, version: true, updatedAt: true }
  });
  if (!project) return null;

  const tasks = await client.planningTask.findMany({
    where: {
      projectId,
      status: { in: [PlanningTaskStatus.NOT_STARTED, PlanningTaskStatus.IN_PROGRESS] }
    },
    select: {
      id: true,
      code: true,
      name: true,
      version: true,
      status: true,
      plannedStartAt: true,
      plannedFinishAt: true,
      ownerMembership: {
        select: {
          id: true,
          version: true,
          departmentId: true,
          projectRole: true,
          user: { select: { id: true, name: true } }
        }
      }
    },
    orderBy: { id: "asc" }
  });

  return {
    rows: tasks.map((task) => ({
      ownerMembershipId: task.ownerMembership.id,
      personId: task.ownerMembership.user.id,
      personName: task.ownerMembership.user.name,
      departmentId: task.ownerMembership.departmentId,
      discipline: task.ownerMembership.projectRole,
      taskId: task.id,
      taskCode: task.code,
      taskName: task.name,
      plannedStartAt: task.plannedStartAt,
      plannedFinishAt: task.plannedFinishAt
    })),
    sourceVersions: {
      project: { id: project.id, version: project.version, updatedAt: iso(project.updatedAt) },
      tasks: tasks.map((task) => ({
        taskId: task.id,
        version: task.version,
        status: task.status,
        ownerMembershipId: task.ownerMembership.id,
        personId: task.ownerMembership.user.id,
        personName: task.ownerMembership.user.name,
        membershipVersion: task.ownerMembership.version,
        departmentId: task.ownerMembership.departmentId,
        discipline: task.ownerMembership.projectRole,
        plannedStartAt: iso(task.plannedStartAt),
        plannedFinishAt: iso(task.plannedFinishAt)
      }))
    }
  };
}
