import { PERMISSIONS } from "@/lib/auth/permissions";
import { authorizeSystemRequest } from "@/lib/auth/system-guard";
import { auditContextFromRequest } from "@/modules/audit/application/context";
import { AUDIT_OBJECT_TYPES } from "@/modules/audit/domain/vocabulary";
import {
  setManufacturingCategoryEnabled,
  updateManufacturingCategory
} from "@/modules/drawings/application/manufacturing-configuration-service";
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
  manufacturingCategoryPathSchema,
  setManufacturingConfigurationStatusBodySchema,
  updateManufacturingConfigurationBodySchema
} from "@/modules/platform-api/contracts/internal-routes";

type RouteContext = { params: Promise<{ categoryId: string }> };

async function updateCategory(request: Request, context: RouteContext) {
  const params = await context.params;
  const guard = await authorizeSystemRequest(
    request,
    PERMISSIONS.CONFIGURATION_WRITE,
    AUDIT_OBJECT_TYPES.MANUFACTURING_CATEGORY,
    params.categoryId
  );
  if (!guard.authorized) return guard.response;
  try {
    const path = parsePath(manufacturingCategoryPathSchema, params);
    const body = await parseJsonBody(request, updateManufacturingConfigurationBodySchema);
    const { idempotencyKey } = parseIdempotencyHeaders(request);
    return await idempotentCommandResponse({
      actorId: guard.actor.id,
      operation: "configuration.manufacturing-category.update",
      idempotencyKey,
      request: { path, body },
      execute: async (transaction) => ({
        status: 200,
        body: await updateManufacturingCategory(
          {
            ...body,
            categoryId: path.categoryId,
            actorId: guard.actor.id,
            auditContext: auditContextFromRequest(request, {
              actorId: guard.actor.id,
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

async function setCategoryStatus(request: Request, context: RouteContext) {
  const params = await context.params;
  const guard = await authorizeSystemRequest(
    request,
    PERMISSIONS.CONFIGURATION_WRITE,
    AUDIT_OBJECT_TYPES.MANUFACTURING_CATEGORY,
    params.categoryId
  );
  if (!guard.authorized) return guard.response;
  try {
    const path = parsePath(manufacturingCategoryPathSchema, params);
    const body = await parseJsonBody(request, setManufacturingConfigurationStatusBodySchema);
    const { idempotencyKey } = parseIdempotencyHeaders(request);
    return await idempotentCommandResponse({
      actorId: guard.actor.id,
      operation: "configuration.manufacturing-category.status",
      idempotencyKey,
      request: { path, body },
      execute: async (transaction) => ({
        status: 200,
        body: await setManufacturingCategoryEnabled(
          {
            ...body,
            categoryId: path.categoryId,
            actorId: guard.actor.id,
            auditContext: auditContextFromRequest(request, {
              actorId: guard.actor.id,
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

export const PUT = withRequestObservability(
  { module: "drawings", operation: "update-manufacturing-category" },
  updateCategory
);
export const PATCH = withRequestObservability(
  { module: "drawings", operation: "set-manufacturing-category-status" },
  setCategoryStatus
);
