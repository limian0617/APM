import { PERMISSIONS } from "@/lib/auth/permissions";
import { authorizeProjectRequest } from "@/lib/auth/project-guard";
import { auditContextFromRequest } from "@/modules/audit/application/context";
import { confirmKnowledgeReuse } from "@/modules/knowledge/application/knowledge-reuse-service";
import {
  knowledgeCommandContractErrorResponse,
  knowledgeReuseBodySchema,
  knowledgeServiceErrorResponse,
  projectKnowledgeReusePathSchema
} from "@/modules/knowledge/contracts/knowledge-http";
import { withRequestObservability } from "@/modules/observability/application/request-observer";
import { idempotentCommandResponse } from "@/modules/platform-api/application/idempotent-command";
import {
  parseIdempotencyHeaders,
  parseJsonBody,
  parsePath
} from "@/modules/platform-api/contracts/dto";

type RouteContext = { params: Promise<{ projectId: string }> };

async function confirmReuse(request: Request, context: RouteContext) {
  const { projectId } = await context.params;
  const guard = await authorizeProjectRequest(
    request,
    projectId,
    PERMISSIONS.KNOWLEDGE_REUSE_CONFIRM
  );
  if (!guard.authorized) return guard.response;
  try {
    const path = parsePath(projectKnowledgeReusePathSchema, { projectId });
    const body = await parseJsonBody(request, knowledgeReuseBodySchema);
    const { idempotencyKey } = parseIdempotencyHeaders(request);
    return await idempotentCommandResponse({
      actorId: guard.actor.id,
      operation: "projects.knowledge-reuse.confirm",
      idempotencyKey,
      request: { path, body },
      execute: async (transaction) => ({
        status: 201,
        body: await confirmKnowledgeReuse(
          {
            targetProjectId: path.projectId,
            ...body,
            actorId: guard.actor.id,
            idempotencyKey,
            targetProjectAccess: true,
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
      knowledgeCommandContractErrorResponse(error) ??
      knowledgeServiceErrorResponse(error) ??
      Promise.reject(error)
    );
  }
}

export const POST = withRequestObservability(
  { module: "knowledge", operation: "confirm-knowledge-reuse" },
  confirmReuse
);
