import { PERMISSIONS } from "@/lib/auth/permissions";
import { authorizeProjectRequest } from "@/lib/auth/project-guard";
import { auditContextFromRequest } from "@/modules/audit/application/context";
import { correctKnowledgeReuse } from "@/modules/knowledge/application/knowledge-reuse-service";
import {
  knowledgeCommandContractErrorResponse,
  knowledgeCorrectionBodySchema,
  knowledgeServiceErrorResponse,
  projectKnowledgeReuseCorrectionPathSchema
} from "@/modules/knowledge/contracts/knowledge-http";
import { withRequestObservability } from "@/modules/observability/application/request-observer";
import { idempotentCommandResponse } from "@/modules/platform-api/application/idempotent-command";
import {
  parseIdempotencyHeaders,
  parseJsonBody,
  parsePath
} from "@/modules/platform-api/contracts/dto";

type RouteContext = { params: Promise<{ projectId: string; reuseId: string }> };

async function correctReuse(request: Request, context: RouteContext) {
  const { projectId, reuseId } = await context.params;
  const guard = await authorizeProjectRequest(
    request,
    projectId,
    PERMISSIONS.KNOWLEDGE_REUSE_CONFIRM
  );
  if (!guard.authorized) return guard.response;
  try {
    const path = parsePath(projectKnowledgeReuseCorrectionPathSchema, { projectId, reuseId });
    const body = await parseJsonBody(request, knowledgeCorrectionBodySchema);
    const { idempotencyKey } = parseIdempotencyHeaders(request);
    return await idempotentCommandResponse({
      actorId: guard.actor.id,
      operation: "projects.knowledge-reuse.correct",
      idempotencyKey,
      request: { path, body },
      execute: async (transaction) => ({
        status: 200,
        body: await correctKnowledgeReuse(
          {
            targetProjectId: path.projectId,
            reuseRecordId: path.reuseId,
            ...body,
            actorId: guard.actor.id,
            idempotencyKey,
            targetProjectAccess: true,
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
      knowledgeCommandContractErrorResponse(error) ??
      knowledgeServiceErrorResponse(error) ??
      Promise.reject(error)
    );
  }
}

export const POST = withRequestObservability(
  { module: "knowledge", operation: "correct-knowledge-reuse" },
  correctReuse
);
