import { PERMISSIONS } from "@/lib/auth/permissions";
import { authorizeProjectRequest } from "@/lib/auth/project-guard";
import { auditContextFromRequest } from "@/modules/audit/application/context";
import {
  listSupplierMatches,
  updateSupplierManufacturingCapability
} from "@/modules/drawings/application/supplier-manufacturing-capability-service";
import { manufacturingClassificationErrorResponse } from "@/modules/drawings/contracts/manufacturing-classification-http";
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
  drawingSupplierCapabilityPathSchema,
  drawingSupplierCapabilityQuerySchema,
  updateSupplierManufacturingCapabilityBodySchema
} from "@/modules/platform-api/contracts/internal-routes";

type RouteContext = { params: Promise<{ projectId: string; supplierReferenceId: string }> };

async function readCapabilities(request: Request, context: RouteContext) {
  const params = await context.params;
  const guard = await authorizeProjectRequest(
    request,
    params.projectId,
    PERMISSIONS.PROJECT_PROCUREMENT_READ
  );
  if (!guard.authorized) return guard.response;
  try {
    const path = parsePath(drawingSupplierCapabilityPathSchema, params);
    const query = parseQuery(request, drawingSupplierCapabilityQuerySchema);
    const matches = await listSupplierMatches({
      projectId: path.projectId,
      categoryCode: query.categoryCode,
      processTagCodes: query.processTagCodes
    });
    return Response.json({
      ...matches,
      matches: matches.matches.filter(
        (match) => match.supplierReferenceId === path.supplierReferenceId
      )
    });
  } catch (error) {
    const response =
      apiContractErrorResponse(error) ?? manufacturingClassificationErrorResponse(error);
    if (response) return response;
    throw error;
  }
}

async function updateCapability(request: Request, context: RouteContext) {
  const params = await context.params;
  const guard = await authorizeProjectRequest(
    request,
    params.projectId,
    PERMISSIONS.PROJECT_PROCUREMENT_TRACKING_MANAGE
  );
  if (!guard.authorized) return guard.response;
  try {
    const path = parsePath(drawingSupplierCapabilityPathSchema, params);
    const body = await parseJsonBody(request, updateSupplierManufacturingCapabilityBodySchema);
    const { idempotencyKey } = parseIdempotencyHeaders(request);
    return await idempotentCommandResponse({
      actorId: guard.actor.id,
      operation: "projects.drawing-supplier-capability.update",
      idempotencyKey,
      request: { path, body },
      execute: async (transaction) => ({
        status: 200,
        body: await updateSupplierManufacturingCapability(
          {
            projectId: path.projectId,
            supplierReferenceId: path.supplierReferenceId,
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
  { module: "drawings", operation: "read-supplier-capabilities" },
  readCapabilities
);
export const PUT = withRequestObservability(
  { module: "drawings", operation: "update-supplier-capability" },
  updateCapability
);
