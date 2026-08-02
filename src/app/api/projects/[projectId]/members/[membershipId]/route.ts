import { ProjectStatus } from "@prisma/client";

import { PERMISSIONS } from "@/lib/auth/permissions";
import { authorizeProjectRequest } from "@/lib/auth/project-guard";
import { auditContextFromRequest } from "@/modules/audit/application/context";
import {
  endProjectMembership,
  parseIfMatchVersion,
  ProjectMemberError
} from "@/lib/projects/members";

type RouteContext = { params: Promise<{ projectId: string; membershipId: string }> };

export async function DELETE(request: Request, context: RouteContext) {
  const { projectId, membershipId } = await context.params;
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
    const projectVersion = parseIfMatchVersion(request.headers.get("if-match"));
    const auditContext = auditContextFromRequest(request, {
      actorId: guard.actor.id,
      projectId,
      departmentId: guard.project.departmentId
    });
    const result = await endProjectMembership({
      projectId,
      membershipId,
      actorId: guard.actor.id,
      projectVersion,
      auditContext
    });
    return Response.json(result);
  } catch (error) {
    if (error instanceof ProjectMemberError) {
      return Response.json(
        { error: { code: error.code, message: error.message } },
        { status: error.status }
      );
    }
    throw error;
  }
}
