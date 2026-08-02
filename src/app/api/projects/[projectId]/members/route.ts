import { ProjectStatus } from "@prisma/client";

import { PERMISSIONS } from "@/lib/auth/permissions";
import { authorizeProjectRequest } from "@/lib/auth/project-guard";
import { db } from "@/lib/db";
import { auditContextFromRequest } from "@/modules/audit/application/context";
import { withRequestObservability } from "@/modules/observability/application/request-observer";
import { idempotentCommandResponse } from "@/modules/platform-api/application/idempotent-command";
import {
  parseIdempotencyHeaders,
  parseJsonBody,
  parsePath
} from "@/modules/platform-api/contracts/dto";
import {
  apiContractErrorResponse,
  apiErrorResponse
} from "@/modules/platform-api/contracts/errors";
import {
  addProjectMemberBodySchema,
  projectPathSchema
} from "@/modules/platform-api/contracts/internal-routes";
import {
  addProjectMember,
  parseAddProjectMemberInput,
  ProjectMemberError
} from "@/lib/projects/members";

type RouteContext = { params: Promise<{ projectId: string }> };

function memberErrorResponse(error: ProjectMemberError): Response {
  return apiErrorResponse({ status: error.status, code: error.code, message: error.message });
}

async function listMembers(request: Request, context: RouteContext) {
  const { projectId } = await context.params;
  const guard = await authorizeProjectRequest(request, projectId, PERMISSIONS.PROJECT_MEMBER_READ);
  if (!guard.authorized) {
    return guard.response;
  }

  const memberships = await db.projectMember.findMany({
    where: { projectId, leftAt: null },
    orderBy: [{ projectRole: "asc" }, { joinedAt: "asc" }],
    select: {
      id: true,
      projectRole: true,
      departmentId: true,
      joinedAt: true,
      version: true,
      user: {
        select: {
          id: true,
          employeeNo: true,
          name: true,
          email: true,
          departmentId: true,
          status: true
        }
      }
    }
  });

  return Response.json({
    project: {
      id: guard.project.id,
      code: guard.project.code,
      name: guard.project.name,
      version: guard.project.version
    },
    memberships
  });
}

async function addMember(request: Request, context: RouteContext) {
  const { projectId } = await context.params;
  const guard = await authorizeProjectRequest(
    request,
    projectId,
    PERMISSIONS.PROJECT_MEMBER_MANAGE
  );
  if (!guard.authorized) {
    return guard.response;
  }

  try {
    const path = parsePath(projectPathSchema, { projectId });
    const body = await parseJsonBody(request, addProjectMemberBodySchema);
    const { idempotencyKey } = parseIdempotencyHeaders(request);
    const member = parseAddProjectMemberInput(body);
    if (
      guard.project.status === ProjectStatus.CLOSED ||
      guard.project.status === ProjectStatus.CANCELED
    ) {
      return apiErrorResponse({
        status: 409,
        code: "PROJECT_READ_ONLY",
        message: "已结项或已取消的项目禁止修改成员。"
      });
    }
    const auditContext = auditContextFromRequest(request, {
      actorId: guard.actor.id,
      projectId: path.projectId,
      departmentId: guard.project.departmentId
    });
    return await idempotentCommandResponse({
      actorId: guard.actor.id,
      operation: "projects.member.add",
      idempotencyKey,
      request: { path, body },
      execute: async (transaction) => ({
        status: 201,
        body: await addProjectMember(
          {
            projectId: path.projectId,
            actorId: guard.actor.id,
            member,
            auditContext
          },
          transaction
        )
      })
    });
  } catch (error) {
    const contractResponse = apiContractErrorResponse(error);
    if (contractResponse) return contractResponse;
    if (error instanceof ProjectMemberError) {
      return memberErrorResponse(error);
    }
    throw error;
  }
}

export const GET = withRequestObservability(
  { module: "projects", operation: "list-members" },
  listMembers
);
export const POST = withRequestObservability(
  { module: "projects", operation: "add-member" },
  addMember
);
