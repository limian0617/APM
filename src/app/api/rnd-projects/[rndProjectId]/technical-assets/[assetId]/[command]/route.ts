import { PERMISSIONS } from "@/lib/auth/permissions";
import { authorizeSystemRequest } from "@/lib/auth/system-guard";
import { auditContextFromRequest } from "@/modules/audit/application/context";
import { AUDIT_OBJECT_TYPES } from "@/modules/audit/domain/vocabulary";
import {
  recordTechnicalAssetValidation,
  transitionTechnicalAsset
} from "@/modules/assets/application/technical-asset-service";
import { technicalAssetErrorResponse } from "@/modules/assets/contracts/technical-asset-http";
import { withRequestObservability } from "@/modules/observability/application/request-observer";
import { idempotentCommandResponse } from "@/modules/platform-api/application/idempotent-command";
import {
  parseIdempotencyHeaders,
  parseJsonBody,
  parsePath
} from "@/modules/platform-api/contracts/dto";
import { apiContractErrorResponse } from "@/modules/platform-api/contracts/errors";
import {
  technicalAssetCommandBodySchema,
  technicalAssetCommandPathSchema,
  technicalAssetValidationBodySchema
} from "@/modules/platform-api/contracts/internal-routes";

type RouteContext = { params: Promise<{ rndProjectId: string; assetId: string; command: string }> };

async function commandTechnicalAssetRoute(request: Request, context: RouteContext) {
  const params = await context.params;
  const readGuard = await authorizeSystemRequest(
    request,
    PERMISSIONS.TECHNICAL_ASSET_READ,
    AUDIT_OBJECT_TYPES.TECHNICAL_ASSET,
    params.assetId
  );
  if (!readGuard.authorized) return readGuard.response;
  try {
    const path = parsePath(technicalAssetCommandPathSchema, params);
    const permission =
      path.command === "record-validation"
        ? PERMISSIONS.TECHNICAL_ASSET_VALIDATE
        : PERMISSIONS.TECHNICAL_ASSET_MANAGE;
    const commandGuard = await authorizeSystemRequest(
      request,
      permission,
      AUDIT_OBJECT_TYPES.TECHNICAL_ASSET,
      path.assetId
    );
    if (!commandGuard.authorized) return commandGuard.response;
    const body = await parseJsonBody(
      request,
      path.command === "record-validation"
        ? technicalAssetValidationBodySchema
        : technicalAssetCommandBodySchema
    );
    const { idempotencyKey } = parseIdempotencyHeaders(request);
    const auditContext = auditContextFromRequest(request, {
      actorId: commandGuard.actor.id,
      reason: body.reason
    });
    return await idempotentCommandResponse({
      actorId: commandGuard.actor.id,
      operation: `assets.technical-asset.${path.command}`,
      idempotencyKey,
      request: { path, body },
      execute: async (transaction) => {
        if (path.command === "record-validation") {
          const validationBody = body as {
            version: number;
            decision: "PASSED" | "FAILED";
            evidence: string;
            reason: string;
          };
          return {
            status: 200,
            body: await recordTechnicalAssetValidation(
              {
                rndProjectId: path.rndProjectId,
                assetId: path.assetId,
                ...body,
                ...validationBody,
                actorId: commandGuard.actor.id,
                auditContext
              },
              transaction
            )
          };
        }
        return {
          status: 200,
          body: await transitionTechnicalAsset(
            {
              rndProjectId: path.rndProjectId,
              assetId: path.assetId,
              ...body,
              toStatus: path.command === "submit-validation" ? "VALIDATION_PENDING" : "CANCELED",
              actorId: commandGuard.actor.id,
              auditContext
            },
            transaction
          )
        };
      }
    });
  } catch (error) {
    const response = apiContractErrorResponse(error) ?? technicalAssetErrorResponse(error);
    if (response) return response;
    throw error;
  }
}

export const POST = withRequestObservability(
  { module: "technical-assets", operation: "command-technical-asset" },
  commandTechnicalAssetRoute
);
