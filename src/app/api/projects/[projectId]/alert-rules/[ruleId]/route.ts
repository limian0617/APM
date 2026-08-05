import { PERMISSIONS } from "@/lib/auth/permissions";
import { authorizeProjectRequest } from "@/lib/auth/project-guard";
import { auditContextFromRequest } from "@/modules/audit/application/context";
import { updateProjectAlertRule } from "@/modules/governance/application/alert-service";
import {
  alertServiceErrorResponse,
  parseAlertRuleUpdatePayload
} from "@/modules/governance/contracts/alert-http";
import { withRequestObservability } from "@/modules/observability/application/request-observer";
import { idempotentCommandResponse } from "@/modules/platform-api/application/idempotent-command";
import {
  parseIdempotencyHeaders,
  parseJsonBody,
  parsePath
} from "@/modules/platform-api/contracts/dto";
import { apiContractErrorResponse } from "@/modules/platform-api/contracts/errors";
import {
  projectAlertRulePathSchema,
  updateProjectAlertRuleBodySchema
} from "@/modules/platform-api/contracts/internal-routes";

type RouteContext = { params: Promise<{ projectId: string; ruleId: string }> };

async function editRule(request: Request, context: RouteContext) {
  const params = await context.params;
  const guard = await authorizeProjectRequest(
    request,
    params.projectId,
    PERMISSIONS.PROJECT_ALERT_MANAGE
  );
  if (!guard.authorized) return guard.response;
  try {
    const path = parsePath(projectAlertRulePathSchema, params);
    const body = parseAlertRuleUpdatePayload(
      await parseJsonBody(request, updateProjectAlertRuleBodySchema)
    );
    const { idempotencyKey } = parseIdempotencyHeaders(request);
    return await idempotentCommandResponse({
      actorId: guard.actor.id,
      operation: "projects.alert-rule.update",
      idempotencyKey,
      request: { path, body },
      execute: async (transaction) => ({
        status: 200,
        body: await updateProjectAlertRule(
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
    return (
      apiContractErrorResponse(error) ?? alertServiceErrorResponse(error) ?? Promise.reject(error)
    );
  }
}

export const PATCH = withRequestObservability(
  { module: "governance", operation: "update-alert-rule" },
  editRule
);
