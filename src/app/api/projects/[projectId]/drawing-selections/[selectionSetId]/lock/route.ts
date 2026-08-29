import { PERMISSIONS } from "@/lib/auth/permissions";
import { authorizeProjectRequest } from "@/lib/auth/project-guard";
import { auditContextFromRequest } from "@/modules/audit/application/context";
import { lockDrawingSelectionSet } from "@/modules/drawings/application/drawing-selection-service";
import { manufacturingClassificationErrorResponse } from "@/modules/drawings/contracts/manufacturing-classification-http";
import { withRequestObservability } from "@/modules/observability/application/request-observer";
import { idempotentCommandResponse } from "@/modules/platform-api/application/idempotent-command";
import {
  parseIdempotencyHeaders,
  parseJsonBody,
  parsePath
} from "@/modules/platform-api/contracts/dto";
import { apiContractErrorResponse } from "@/modules/platform-api/contracts/errors";
import {
  drawingSelectionSetPathSchema,
  lockDrawingSelectionSetBodySchema
} from "@/modules/platform-api/contracts/internal-routes";

type RouteContext = { params: Promise<{ projectId: string; selectionSetId: string }> };

async function lockSelectionSet(request: Request, context: RouteContext) {
  const params = await context.params;
  const guard = await authorizeProjectRequest(
    request,
    params.projectId,
    PERMISSIONS.PROJECT_PROCUREMENT_TRACKING_MANAGE
  );
  if (!guard.authorized) return guard.response;
  try {
    const path = parsePath(drawingSelectionSetPathSchema, params);
    const body = await parseJsonBody(request, lockDrawingSelectionSetBodySchema);
    const { idempotencyKey } = parseIdempotencyHeaders(request);
    return await idempotentCommandResponse({
      actorId: guard.actor.id,
      operation: "projects.drawing-selection-set.lock",
      idempotencyKey,
      request: { path, body },
      execute: async (transaction) => ({
        status: 200,
        body: await lockDrawingSelectionSet(
          {
            ...path,
            ...body,
            actorId: guard.actor.id,
            auditContext: auditContextFromRequest(request, {
              actorId: guard.actor.id,
              projectId: path.projectId,
              departmentId: guard.project.departmentId,
              reason: body.reason
            })
          },
          transaction
        )
      })
    });
  } catch (error) {
    const response =
      apiContractErrorResponse(error) ?? manufacturingClassificationErrorResponse(error);
    if (response) return response;
    throw error;
  }
}

export const POST = withRequestObservability(
  { module: "drawings", operation: "lock-drawing-selection-set" },
  lockSelectionSet
);
