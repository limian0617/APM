import { PERMISSIONS } from "@/lib/auth/permissions";
import { authorizeSystemRequest } from "@/lib/auth/system-guard";
import { auditContextFromRequest } from "@/modules/audit/application/context";
import { AUDIT_OBJECT_TYPES } from "@/modules/audit/domain/vocabulary";
import {
  createManufacturingCategory,
  listManufacturingCategories
} from "@/modules/drawings/application/manufacturing-configuration-service";
import { manufacturingClassificationErrorResponse } from "@/modules/drawings/contracts/manufacturing-classification-http";
import { withRequestObservability } from "@/modules/observability/application/request-observer";
import { idempotentCommandResponse } from "@/modules/platform-api/application/idempotent-command";
import {
  parseIdempotencyHeaders,
  parseJsonBody,
  parseQuery
} from "@/modules/platform-api/contracts/dto";
import { apiContractErrorResponse } from "@/modules/platform-api/contracts/errors";
import {
  createManufacturingConfigurationBodySchema,
  manufacturingConfigurationQuerySchema
} from "@/modules/platform-api/contracts/internal-routes";

async function listCategories(request: Request) {
  const guard = await authorizeSystemRequest(
    request,
    PERMISSIONS.CONFIGURATION_READ,
    AUDIT_OBJECT_TYPES.MANUFACTURING_CATEGORY
  );
  if (!guard.authorized) return guard.response;
  try {
    const query = parseQuery(request, manufacturingConfigurationQuerySchema);
    return Response.json(await listManufacturingCategories({ activeOnly: query.activeOnly }));
  } catch (error) {
    const response =
      apiContractErrorResponse(error) ?? manufacturingClassificationErrorResponse(error);
    if (response) return response;
    throw error;
  }
}

async function createCategory(request: Request) {
  const guard = await authorizeSystemRequest(
    request,
    PERMISSIONS.CONFIGURATION_WRITE,
    AUDIT_OBJECT_TYPES.MANUFACTURING_CATEGORY
  );
  if (!guard.authorized) return guard.response;
  try {
    const body = await parseJsonBody(request, createManufacturingConfigurationBodySchema);
    const { idempotencyKey } = parseIdempotencyHeaders(request);
    return await idempotentCommandResponse({
      actorId: guard.actor.id,
      operation: "configuration.manufacturing-category.create",
      idempotencyKey,
      request: { body },
      execute: async (transaction) => ({
        status: 201,
        body: await createManufacturingCategory(
          {
            ...body,
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

export const GET = withRequestObservability(
  { module: "drawings", operation: "list-manufacturing-categories" },
  listCategories
);
export const POST = withRequestObservability(
  { module: "drawings", operation: "create-manufacturing-category" },
  createCategory
);
