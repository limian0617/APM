import { PERMISSIONS } from "@/lib/auth/permissions";
import { authorizeProjectRequest } from "@/lib/auth/project-guard";
import { auditContextFromRequest } from "@/modules/audit/application/context";
import { withRequestObservability } from "@/modules/observability/application/request-observer";
import { idempotentCommandResponse } from "@/modules/platform-api/application/idempotent-command";
import {
  parseDto,
  parseIdempotencyHeaders,
  parseJsonBody,
  parsePath
} from "@/modules/platform-api/contracts/dto";
import { apiContractErrorResponse } from "@/modules/platform-api/contracts/errors";
import {
  procurementCommandSchema,
  projectPathSchema,
  requirementCommandBodySchema,
  reviseMaterialRequirementBodySchema
} from "@/modules/platform-api/contracts/internal-routes";
import {
  cancelMaterialRequirement,
  confirmMaterialRequirement,
  reviseMaterialRequirement
} from "@/modules/procurement/application/material-requirement-service";
import {
  procurementServiceErrorResponse,
  type RequirementCommandBody,
  type ReviseMaterialRequirementBody
} from "@/modules/procurement/contracts/procurement-http";

type RouteContext = {
  params: Promise<{ projectId: string; requirementId: string; command: string }>;
};

async function command(request: Request, context: RouteContext) {
  const { projectId, requirementId, command: rawCommand } = await context.params;
  const guard = await authorizeProjectRequest(
    request,
    projectId,
    PERMISSIONS.PROJECT_PROCUREMENT_REQUIREMENT_MANAGE
  );
  if (!guard.authorized) return guard.response;
  try {
    const path = parsePath(projectPathSchema, { projectId });
    const commandName = parseDto(procurementCommandSchema, rawCommand, "path.command");
    const body =
      commandName === "revise"
        ? await parseJsonBody(request, reviseMaterialRequirementBodySchema)
        : await parseJsonBody(request, requirementCommandBodySchema);
    const { idempotencyKey } = parseIdempotencyHeaders(request);
    return await idempotentCommandResponse({
      actorId: guard.actor.id,
      operation: `projects.procurement.material-requirement.${commandName}`,
      idempotencyKey,
      request: { path: { ...path, requirementId, command: commandName }, body },
      execute: async (transaction) => {
        const common = {
          projectId: path.projectId,
          requirementId,
          actorId: guard.actor.id,
          auditContext: auditContextFromRequest(request, {
            actorId: guard.actor.id,
            projectId: path.projectId,
            departmentId: guard.project.departmentId,
            reason: body.reason
          })
        };
        if (commandName === "confirm")
          return {
            status: 200,
            body: await confirmMaterialRequirement({ ...common, ...body }, transaction)
          };
        if (commandName === "cancel")
          return {
            status: 200,
            body: await cancelMaterialRequirement(
              { ...common, ...(body as RequirementCommandBody) },
              transaction
            )
          };
        const revisionBody = body as ReviseMaterialRequirementBody;
        return {
          status: 200,
          body: await reviseMaterialRequirement(
            { ...common, ...revisionBody, source: revisionBody.sourceType },
            transaction
          )
        };
      }
    });
  } catch (error) {
    return (
      apiContractErrorResponse(error) ??
      procurementServiceErrorResponse(error) ??
      Promise.reject(error)
    );
  }
}

export const POST = withRequestObservability(
  { module: "procurement", operation: "material-requirement-command" },
  command
);
