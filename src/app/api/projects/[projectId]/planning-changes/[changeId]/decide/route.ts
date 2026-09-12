import { PERMISSIONS } from "@/lib/auth/permissions";
import { authorizeProjectRequest } from "@/lib/auth/project-guard";
import { auditContextFromRequest } from "@/modules/audit/application/context";
import { withRequestObservability } from "@/modules/observability/application/request-observer";
import { idempotentCommandResponse } from "@/modules/platform-api/application/idempotent-command";
import {
  assertIfMatchMatches,
  parseIdempotencyHeaders,
  parseIfMatchHeader,
  parseJsonBody,
  parsePath
} from "@/modules/platform-api/contracts/dto";
import { apiContractErrorResponse } from "@/modules/platform-api/contracts/errors";
import {
  decidePlanningChangeBodySchema,
  planningChangePathSchema
} from "@/modules/platform-api/contracts/internal-routes";
import { decidePlanningChange } from "@/modules/planning/application/planning-change-service";
import { planningChangeErrorResponse } from "@/modules/planning/contracts/planning-http";

type RouteContext = { params: Promise<{ projectId: string; changeId: string }> };

async function decide(request: Request, context: RouteContext) {
  const raw = await context.params;
  // 审批资格由服务层按冻结审批人快照判定；此处只要求项目读权限。
  const guard = await authorizeProjectRequest(request, raw.projectId, PERMISSIONS.PROJECT_READ);
  if (!guard.authorized) return guard.response;
  try {
    const path = parsePath(planningChangePathSchema, raw);
    const body = await parseJsonBody(request, decidePlanningChangeBodySchema);
    assertIfMatchMatches(parseIfMatchHeader(request), body.version, "version");
    const { idempotencyKey } = parseIdempotencyHeaders(request);
    return await idempotentCommandResponse({
      actorId: guard.actor.id,
      operation: "planning.change.decide",
      idempotencyKey,
      request: { path, body },
      execute: async (transaction) => ({
        status: 200,
        body: await decidePlanningChange(
          {
            projectId: path.projectId,
            changeId: path.changeId,
            actorId: guard.actor.id,
            version: body.version,
            decision: body.decision,
            reason: body.reason,
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
      apiContractErrorResponse(error) ?? planningChangeErrorResponse(error) ?? Promise.reject(error)
    );
  }
}

export const POST = withRequestObservability(
  { module: "planning", operation: "planning.change.decide" },
  decide
);
