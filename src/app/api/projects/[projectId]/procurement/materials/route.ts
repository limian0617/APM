import { PERMISSIONS } from "@/lib/auth/permissions";
import { authorizeProjectRequest } from "@/lib/auth/project-guard";
import { auditContextFromRequest } from "@/modules/audit/application/context";
import { withRequestObservability } from "@/modules/observability/application/request-observer";
import { idempotentCommandResponse } from "@/modules/platform-api/application/idempotent-command";
import {
  parseIdempotencyHeaders,
  parseJsonBody,
  parsePath,
  parseQuery
} from "@/modules/platform-api/contracts/dto";
import { apiContractErrorResponse } from "@/modules/platform-api/contracts/errors";
import {
  createMaterialReferenceBodySchema,
  procurementListQuerySchema,
  projectPathSchema
} from "@/modules/platform-api/contracts/internal-routes";
import {
  createMaterialReference,
  listMaterialReferences
} from "@/modules/procurement/application/material-requirement-service";
import { procurementServiceErrorResponse } from "@/modules/procurement/contracts/procurement-http";

type RouteContext = { params: Promise<{ projectId: string }> };

async function listMaterials(request: Request, context: RouteContext) {
  const { projectId } = await context.params;
  const guard = await authorizeProjectRequest(
    request,
    projectId,
    PERMISSIONS.PROJECT_PROCUREMENT_READ
  );
  if (!guard.authorized) return guard.response;
  try {
    const path = parsePath(projectPathSchema, { projectId });
    const query = parseQuery(request, procurementListQuerySchema);
    return Response.json(
      await listMaterialReferences({
        ...query,
        projectId: path.projectId,
        status: query.status as "ACTIVE" | "DISABLED" | undefined
      })
    );
  } catch (error) {
    return (
      apiContractErrorResponse(error) ??
      procurementServiceErrorResponse(error) ??
      Promise.reject(error)
    );
  }
}

async function createMaterial(request: Request, context: RouteContext) {
  const { projectId } = await context.params;
  const guard = await authorizeProjectRequest(
    request,
    projectId,
    PERMISSIONS.PROJECT_PROCUREMENT_REQUIREMENT_MANAGE
  );
  if (!guard.authorized) return guard.response;
  try {
    const path = parsePath(projectPathSchema, { projectId });
    const body = await parseJsonBody(request, createMaterialReferenceBodySchema);
    const { idempotencyKey } = parseIdempotencyHeaders(request);
    return await idempotentCommandResponse({
      actorId: guard.actor.id,
      operation: "projects.procurement.material-reference.create",
      idempotencyKey,
      request: { path, body },
      execute: async (transaction) => ({
        status: 201,
        body: await createMaterialReference(
          {
            projectId: path.projectId,
            ...body,
            actorId: guard.actor.id,
            auditContext: auditContextFromRequest(request, {
              actorId: guard.actor.id,
              projectId: path.projectId,
              departmentId: guard.project.departmentId
            })
          },
          transaction
        )
      })
    });
  } catch (error) {
    return (
      apiContractErrorResponse(error) ??
      procurementServiceErrorResponse(error) ??
      Promise.reject(error)
    );
  }
}

export const GET = withRequestObservability(
  { module: "procurement", operation: "list-material-references" },
  listMaterials
);
export const POST = withRequestObservability(
  { module: "procurement", operation: "create-material-reference" },
  createMaterial
);
