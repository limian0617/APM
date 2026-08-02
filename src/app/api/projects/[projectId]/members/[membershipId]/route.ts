import { ProjectStatus } from "@prisma/client";

import { PERMISSIONS } from "@/lib/auth/permissions";
import { authorizeProjectRequest } from "@/lib/auth/project-guard";
import { auditContextFromRequest } from "@/modules/audit/application/context";
import {
  endProjectMembership,
  parseIfMatchVersion,
  ProjectMemberError
} from "@/lib/projects/members";
import { withRequestObservability } from "@/modules/observability/application/request-observer";
import { idempotentCommandResponse } from "@/modules/platform-api/application/idempotent-command";
import { parseHeaders, parsePath } from "@/modules/platform-api/contracts/dto";
import {
  apiContractErrorResponse,
  apiErrorResponse
} from "@/modules/platform-api/contracts/errors";
import {
  membershipCommandHeadersSchema,
  projectMembershipPathSchema
} from "@/modules/platform-api/contracts/internal-routes";

type RouteContext = { params: Promise<{ projectId: string; membershipId: string }> };

async function endMembership(request: Request, context: RouteContext) {
  const { projectId, membershipId } = await context.params;
  const guard = await authorizeProjectRequest(
    request,
    projectId,
    PERMISSIONS.PROJECT_MEMBER_MANAGE
  );
  if (!guard.authorized) {
    return guard.response;
  }

  try {
    const path = parsePath(projectMembershipPathSchema, { projectId, membershipId });
    const headers = parseHeaders(request, membershipCommandHeadersSchema, {
      idempotencyKey: "idempotency-key",
      ifMatch: "if-match"
    });
    const projectVersion = parseIfMatchVersion(headers.ifMatch);
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
      operation: "projects.member.end",
      idempotencyKey: headers.idempotencyKey,
      request: { path, projectVersion },
      execute: async (transaction) => ({
        status: 200,
        body: await endProjectMembership(
          {
            projectId: path.projectId,
            membershipId: path.membershipId,
            actorId: guard.actor.id,
            projectVersion,
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
      return apiErrorResponse({ status: error.status, code: error.code, message: error.message });
    }
    throw error;
  }
}

export const DELETE = withRequestObservability(
  { module: "projects", operation: "end-membership" },
  endMembership
);
