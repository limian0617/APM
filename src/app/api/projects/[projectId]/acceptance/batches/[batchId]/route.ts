import { PERMISSIONS } from "@/lib/auth/permissions";
import { decideAuthorization } from "@/lib/auth/authorize";
import { authorizeProjectRequest } from "@/lib/auth/project-guard";
import { getAcceptanceBatch } from "@/modules/acceptance/application/acceptance-service";
import {
  acceptanceBatchPathSchema,
  acceptanceServiceErrorResponse
} from "@/modules/acceptance/contracts/acceptance-http";
import { withRequestObservability } from "@/modules/observability/application/request-observer";
import { parsePath } from "@/modules/platform-api/contracts/dto";
import { apiContractErrorResponse } from "@/modules/platform-api/contracts/errors";

type RouteContext = { params: Promise<{ projectId: string; batchId: string }> };

async function readBatch(request: Request, context: RouteContext) {
  const params = await context.params;
  const guard = await authorizeProjectRequest(
    request,
    params.projectId,
    PERMISSIONS.ACCEPTANCE_READ
  );
  if (!guard.authorized) return guard.response;
  try {
    const path = parsePath(acceptanceBatchPathSchema, params);
    const context = {
      projectId: path.projectId,
      resourceDepartmentId: guard.project.departmentId,
      memberRoles: guard.project.memberRoles
    };
    const canResult = decideAuthorization(
      guard.actor,
      PERMISSIONS.ACCEPTANCE_RESULT_UPDATE,
      context
    ).allowed;
    const canReview = decideAuthorization(
      guard.actor,
      PERMISSIONS.ACCEPTANCE_REVIEW,
      context
    ).allowed;
    const canCreateFailureIssue = decideAuthorization(
      guard.actor,
      PERMISSIONS.PROJECT_ISSUE_CREATE,
      context
    ).allowed;
    const canLinkFailureIssue = decideAuthorization(
      guard.actor,
      PERMISSIONS.PROJECT_ISSUE_UPDATE,
      context
    ).allowed;
    const allowedActions = [
      ...(canReview ? ["CREATE_BATCH", "LOCK_BATCH"] : []),
      ...(canResult ? ["START_BATCH", "RECORD_RESULT", "REVISE_RESULT"] : []),
      ...(canCreateFailureIssue ? ["CREATE_FAILURE_ISSUE"] : []),
      ...(canLinkFailureIssue ? ["LINK_FAILURE_ISSUE"] : [])
    ];
    return Response.json(await getAcceptanceBatch(path.projectId, path.batchId, allowedActions));
  } catch (error) {
    return (
      apiContractErrorResponse(error) ??
      acceptanceServiceErrorResponse(error) ??
      Promise.reject(error)
    );
  }
}

export const GET = withRequestObservability(
  { module: "acceptance", operation: "read-batch" },
  readBatch
);
