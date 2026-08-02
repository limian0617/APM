import type { Prisma } from "@prisma/client";

import { db } from "@/lib/db";

import type { AuthorizationActor } from "./authorize";
import type { PermissionScope } from "./permissions";

const actorInclude = {
  roleAssignments: {
    where: { revokedAt: null },
    include: {
      role: {
        include: {
          permissions: {
            include: { permission: true }
          }
        }
      }
    }
  }
} satisfies Prisma.UserInclude;

export type ProjectAuthorizationTarget = {
  id: string;
  code: string;
  name: string;
  status: string;
  version: number;
  departmentId: string | null;
  memberRoles: string[];
};

export async function loadAuthorizationActor(userId: string): Promise<AuthorizationActor | null> {
  const user = await db.user.findUnique({
    where: { id: userId },
    include: actorInclude
  });

  if (!user) {
    return null;
  }

  return {
    id: user.id,
    name: user.name,
    status: user.status,
    departmentId: user.departmentId,
    systemRoles: user.roleAssignments.map(({ role }) => role.code),
    grants: user.roleAssignments.flatMap(({ role }) =>
      role.permissions.map(({ permission, scope }) => ({
        permission: permission.code,
        scope: scope as PermissionScope,
        systemRole: role.code
      }))
    )
  };
}

export async function loadProjectAuthorizationTarget(
  projectId: string,
  actorId: string
): Promise<ProjectAuthorizationTarget | null> {
  const project = await db.project.findUnique({
    where: { id: projectId },
    select: {
      id: true,
      code: true,
      name: true,
      status: true,
      version: true,
      departmentId: true,
      members: {
        where: { userId: actorId, leftAt: null },
        select: { projectRole: true }
      }
    }
  });

  if (!project) {
    return null;
  }

  return {
    ...project,
    memberRoles: project.members.map(({ projectRole }) => projectRole)
  };
}
