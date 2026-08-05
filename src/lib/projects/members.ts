import { Prisma, ProjectRole, UserStatus } from "@prisma/client";

import { inTransaction } from "@/lib/db";
import { PROJECT_ROLE_VALUES, type ProjectRoleCode } from "@/lib/auth/permissions";
import type { AuditContext } from "@/modules/audit/contracts/audit";
import {
  AUDIT_ACTIONS,
  AUDIT_OBJECT_TYPES,
  PROJECT_MEMBER_AUDIT_FIELDS
} from "@/modules/audit/domain/vocabulary";
import { writeAudit } from "@/modules/audit/infrastructure/write-audit";

export type AddProjectMemberInput = {
  userId: string;
  projectRole: ProjectRoleCode;
  departmentId: string | null;
  projectVersion: number;
};

export class ProjectMemberError extends Error {
  constructor(
    readonly code:
      | "INVALID_INPUT"
      | "USER_NOT_FOUND"
      | "MEMBER_ALREADY_ACTIVE"
      | "MEMBER_NOT_FOUND"
      | "LAST_PROJECT_MANAGER"
      | "VERSION_CONFLICT",
    message: string,
    readonly status: number
  ) {
    super(message);
    this.name = "ProjectMemberError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseAddProjectMemberInput(value: unknown): AddProjectMemberInput {
  if (!isRecord(value)) {
    throw new ProjectMemberError("INVALID_INPUT", "请求体必须是 JSON 对象。", 400);
  }

  const userId = typeof value.userId === "string" ? value.userId.trim() : "";
  const projectRole = value.projectRole;
  const projectVersion = value.projectVersion;
  const departmentId =
    value.departmentId === null || value.departmentId === undefined
      ? null
      : typeof value.departmentId === "string"
        ? value.departmentId.trim()
        : undefined;

  if (!userId || userId.length > 191) {
    throw new ProjectMemberError("INVALID_INPUT", "userId 不能为空。", 400);
  }
  if (
    typeof projectRole !== "string" ||
    !PROJECT_ROLE_VALUES.includes(projectRole as ProjectRoleCode)
  ) {
    throw new ProjectMemberError("INVALID_INPUT", "projectRole 不是有效的项目角色。", 400);
  }
  if (!Number.isSafeInteger(projectVersion) || (projectVersion as number) < 1) {
    throw new ProjectMemberError("INVALID_INPUT", "projectVersion 必须是正整数。", 400);
  }
  if (departmentId === undefined || (departmentId !== null && departmentId.length > 191)) {
    throw new ProjectMemberError("INVALID_INPUT", "departmentId 格式无效。", 400);
  }

  return {
    userId,
    projectRole: projectRole as ProjectRoleCode,
    departmentId: departmentId || null,
    projectVersion: projectVersion as number
  };
}

export function parseIfMatchVersion(header: string | null): number {
  const normalized = header?.trim().replace(/^W\//, "").replace(/^"|"$/g, "") ?? "";
  const version = Number(normalized);
  if (!Number.isSafeInteger(version) || version < 1) {
    throw new ProjectMemberError(
      "INVALID_INPUT",
      "必须通过 If-Match 请求头提供有效的项目版本。",
      400
    );
  }
  return version;
}

export async function addProjectMember(
  input: {
    projectId: string;
    actorId: string;
    member: AddProjectMemberInput;
    auditContext: AuditContext;
  },
  transaction?: Prisma.TransactionClient
) {
  try {
    return await inTransaction(transaction, async (client) => {
      const targetUser = await client.user.findFirst({
        where: { id: input.member.userId, status: UserStatus.ACTIVE },
        select: { id: true, name: true, email: true, departmentId: true }
      });
      if (!targetUser) {
        throw new ProjectMemberError("USER_NOT_FOUND", "目标用户不存在或已停用。", 404);
      }

      const projectUpdate = await client.project.updateMany({
        where: { id: input.projectId, version: input.member.projectVersion },
        data: { version: { increment: 1 } }
      });
      if (projectUpdate.count !== 1) {
        throw new ProjectMemberError("VERSION_CONFLICT", "项目成员已发生变化，请刷新后重试。", 409);
      }

      const activeMembership = await client.projectMember.findFirst({
        where: {
          projectId: input.projectId,
          userId: input.member.userId,
          projectRole: input.member.projectRole as ProjectRole,
          leftAt: null
        }
      });
      if (activeMembership) {
        throw new ProjectMemberError("MEMBER_ALREADY_ACTIVE", "该用户已拥有相同的项目角色。", 409);
      }

      const membership = await client.projectMember.create({
        data: {
          projectId: input.projectId,
          userId: input.member.userId,
          projectRole: input.member.projectRole as ProjectRole,
          departmentId: input.member.departmentId ?? targetUser.departmentId,
          assignedById: input.actorId
        },
        include: {
          user: {
            select: { id: true, employeeNo: true, name: true, email: true, departmentId: true }
          }
        }
      });

      const audit = await writeAudit(client, {
        action: AUDIT_ACTIONS.PROJECT_MEMBER_ADDED,
        objectType: AUDIT_OBJECT_TYPES.PROJECT_MEMBER,
        objectId: membership.id,
        context: {
          ...input.auditContext,
          actorId: input.actorId,
          projectId: input.projectId,
          departmentId: membership.departmentId
        },
        after: {
          value: {
            projectId: input.projectId,
            userId: membership.userId,
            projectRole: membership.projectRole,
            departmentId: membership.departmentId,
            version: membership.version
          },
          allowedFields: PROJECT_MEMBER_AUDIT_FIELDS
        }
      });

      return { membership, projectVersion: input.member.projectVersion + 1, auditId: audit.id };
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      throw new ProjectMemberError("MEMBER_ALREADY_ACTIVE", "该用户已拥有相同的项目角色。", 409);
    }
    throw error;
  }
}

export async function endProjectMembership(
  input: {
    projectId: string;
    membershipId: string;
    actorId: string;
    projectVersion: number;
    auditContext: AuditContext;
  },
  transaction?: Prisma.TransactionClient
) {
  return inTransaction(transaction, async (client) => {
    const membership = await client.projectMember.findFirst({
      where: { id: input.membershipId, projectId: input.projectId, leftAt: null }
    });
    if (!membership) {
      throw new ProjectMemberError("MEMBER_NOT_FOUND", "有效项目成员记录不存在。", 404);
    }

    if (membership.projectRole === ProjectRole.PROJECT_MANAGER) {
      const activeProjectManagerCount = await client.projectMember.count({
        where: {
          projectId: input.projectId,
          projectRole: ProjectRole.PROJECT_MANAGER,
          leftAt: null
        }
      });
      if (activeProjectManagerCount <= 1) {
        throw new ProjectMemberError(
          "LAST_PROJECT_MANAGER",
          "项目至少需要保留一名有效项目经理。",
          409
        );
      }
    }

    const projectUpdate = await client.project.updateMany({
      where: { id: input.projectId, version: input.projectVersion },
      data: { version: { increment: 1 } }
    });
    if (projectUpdate.count !== 1) {
      throw new ProjectMemberError("VERSION_CONFLICT", "项目成员已发生变化，请刷新后重试。", 409);
    }

    const leftAt = new Date();
    const endedMembership = await client.projectMember.update({
      where: { id: membership.id },
      data: {
        leftAt,
        leftById: input.actorId,
        version: { increment: 1 }
      }
    });

    const audit = await writeAudit(client, {
      action: AUDIT_ACTIONS.PROJECT_MEMBER_ENDED,
      objectType: AUDIT_OBJECT_TYPES.PROJECT_MEMBER,
      objectId: membership.id,
      context: {
        ...input.auditContext,
        actorId: input.actorId,
        projectId: membership.projectId,
        departmentId: membership.departmentId
      },
      before: {
        value: {
          projectId: membership.projectId,
          userId: membership.userId,
          projectRole: membership.projectRole,
          departmentId: membership.departmentId,
          leftAt: null,
          version: membership.version
        },
        allowedFields: PROJECT_MEMBER_AUDIT_FIELDS
      },
      after: {
        value: {
          projectId: membership.projectId,
          userId: membership.userId,
          projectRole: membership.projectRole,
          departmentId: membership.departmentId,
          leftAt: leftAt.toISOString(),
          version: endedMembership.version
        },
        allowedFields: PROJECT_MEMBER_AUDIT_FIELDS
      }
    });

    return {
      membership: endedMembership,
      projectVersion: input.projectVersion + 1,
      auditId: audit.id
    };
  });
}
