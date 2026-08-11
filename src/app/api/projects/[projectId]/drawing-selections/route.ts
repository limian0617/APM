import { decideAuthorization } from "@/lib/auth/authorize";
import { PERMISSIONS } from "@/lib/auth/permissions";
import { authorizeProjectRequest } from "@/lib/auth/project-guard";
import { auditContextFromRequest } from "@/modules/audit/application/context";
import {
  createDrawingSelectionSet,
  listDrawingSelectionSets
} from "@/modules/drawings/application/drawing-selection-service";
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
  createDrawingSelectionSetBodySchema,
  projectPathSchema
} from "@/modules/platform-api/contracts/internal-routes";

type RouteContext = { params: Promise<{ projectId: string }> };

async function createSelectionSet(request: Request, context: RouteContext) {
  const { projectId } = await context.params;
  const guard = await authorizeProjectRequest(
    request,
    projectId,
    PERMISSIONS.PROJECT_PROCUREMENT_TRACKING_MANAGE
  );
  if (!guard.authorized) return guard.response;
  try {
    const path = parsePath(projectPathSchema, { projectId });
    const body = await parseJsonBody(request, createDrawingSelectionSetBodySchema);
    const { idempotencyKey } = parseIdempotencyHeaders(request);
    return await idempotentCommandResponse({
      actorId: guard.actor.id,
      operation: "projects.drawing-selection-set.create",
      idempotencyKey,
      request: { path, body },
      execute: async (transaction) => ({
        status: 201,
        body: await createDrawingSelectionSet(
          {
            projectId: path.projectId,
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

async function listSelectionSets(request: Request, context: RouteContext) {
  const { projectId } = await context.params;
  const guard = await authorizeProjectRequest(
    request,
    projectId,
    PERMISSIONS.CONTROLLED_DOCUMENT_READ
  );
  if (!guard.authorized) return guard.response;
  try {
    const path = parsePath(projectPathSchema, { projectId });
    const selectionSets = (await listDrawingSelectionSets(path)) as Array<{
      status: string;
      [key: string]: unknown;
    }>;
    const canManage = decideAuthorization(
      guard.actor,
      PERMISSIONS.PROJECT_PROCUREMENT_TRACKING_MANAGE,
      {
        projectId: guard.project.id,
        resourceDepartmentId: guard.project.departmentId,
        memberRoles: guard.project.memberRoles
      }
    ).allowed;
    return Response.json({
      selectionSets: selectionSets.map((selectionSet) => ({
        ...selectionSet,
        allowedActions: canManage && selectionSet.status === "DRAFT" ? ["ADD_ITEM", "LOCK"] : []
      })),
      allowedActions: canManage ? ["CREATE_SELECTION"] : []
    });
  } catch (error) {
    const response =
      apiContractErrorResponse(error) ?? manufacturingClassificationErrorResponse(error);
    if (response) return response;
    throw error;
  }
}

export const GET = withRequestObservability(
  { module: "drawings", operation: "list-drawing-selection-sets" },
  listSelectionSets
);
export const POST = withRequestObservability(
  { module: "drawings", operation: "create-drawing-selection-set" },
  createSelectionSet
);
