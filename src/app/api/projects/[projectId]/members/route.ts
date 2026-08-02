import { ProjectStatus } from "@prisma/client";

import { PERMISSIONS } from "@/lib/auth/permissions";
import { authorizeProjectRequest } from "@/lib/auth/project-guard";
import { db } from "@/lib/db";
import { auditContextFromRequest } from "@/modules/audit/application/context";
import { withRequestObservability } from "@/modules/observability/application/request-observer";
import {
  addProjectMember,
  parseAddProjectMemberInput,
  ProjectMemberError
} from "@/lib/projects/members";

type RouteContext = { params: Promise<{ projectId: string }> };

function memberErrorResponse(error: ProjectMemberError): Response {
  return Response.json(
    { error: { code: error.code, message: error.message } },
    { status: error.status }
  );
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

  if (
    guard.project.status === ProjectStatus.CLOSED ||
    guard.project.status === ProjectStatus.CANCELED
  ) {
    return Response.json(
      { error: { code: "PROJECT_READ_ONLY", message: "已结项或已取消的项目禁止修改成员。" } },
      { status: 409 }
    );
  }

  try {
    const body = await request.json();
    const member = parseAddProjectMemberInput(body);
    const auditContext = auditContextFromRequest(request, {
      actorId: guard.actor.id,
      projectId,
      departmentId: guard.project.departmentId
    });
    const result = await addProjectMember({
      projectId,
      actorId: guard.actor.id,
      member,
      auditContext
    });
    return Response.json(result, { status: 201 });
  } catch (error) {
    if (error instanceof ProjectMemberError) {
      return memberErrorResponse(error);
    }
    if (error instanceof SyntaxError) {
      return Response.json(
        { error: { code: "INVALID_JSON", message: "请求体不是有效 JSON。" } },
        { status: 400 }
      );
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
