import { PERMISSIONS } from "@/lib/auth/permissions";
import { authorizeProjectRequest } from "@/lib/auth/project-guard";
import { auditContextFromRequest } from "@/modules/audit/application/context";
import {
  getDrawingClassification,
  updateDrawingClassification
} from "@/modules/drawings/application/drawing-classification-service";
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
  mechanicalDrawingPathSchema,
  updateDrawingClassificationBodySchema
} from "@/modules/platform-api/contracts/internal-routes";

type RouteContext = { params: Promise<{ projectId: string; drawingId: string }> };

async function readClassification(request: Request, context: RouteContext) {
  const params = await context.params;
  const guard = await authorizeProjectRequest(
    request,
    params.projectId,
    PERMISSIONS.CONTROLLED_DOCUMENT_READ
  );
  if (!guard.authorized) return guard.response;
  try {
    const path = parsePath(mechanicalDrawingPathSchema, params);
    return Response.json(await getDrawingClassification(path));
  } catch (error) {
    const response =
      apiContractErrorResponse(error) ?? manufacturingClassificationErrorResponse(error);
    if (response) return response;
    throw error;
  }
}

async function updateClassification(request: Request, context: RouteContext) {
  const params = await context.params;
  const guard = await authorizeProjectRequest(
    request,
    params.projectId,
    PERMISSIONS.CONTROLLED_DOCUMENT_MANAGE
  );
  if (!guard.authorized) return guard.response;
  try {
    const path = parsePath(mechanicalDrawingPathSchema, params);
    const body = await parseJsonBody(request, updateDrawingClassificationBodySchema);
    const { idempotencyKey } = parseIdempotencyHeaders(request);
    return await idempotentCommandResponse({
      actorId: guard.actor.id,
      operation: "projects.drawing-classification.update",
      idempotencyKey,
      request: { path, body },
      execute: async (transaction) => ({
        status: 200,
        body: await updateDrawingClassification(
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

export const GET = withRequestObservability(
  { module: "drawings", operation: "read-drawing-classification" },
  readClassification
);
export const PUT = withRequestObservability(
  { module: "drawings", operation: "update-drawing-classification" },
  updateClassification
);
