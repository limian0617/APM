import { PERMISSIONS } from "@/lib/auth/permissions";
import { authorizeProjectRequest } from "@/lib/auth/project-guard";
import { auditContextFromRequest } from "@/modules/audit/application/context";
import { createDocumentReview } from "@/modules/documents/application/controlled-document-service";
import { controlledDocumentErrorResponse } from "@/modules/documents/contracts/controlled-document-http";
import { withRequestObservability } from "@/modules/observability/application/request-observer";
import { idempotentCommandResponse } from "@/modules/platform-api/application/idempotent-command";
import {
  parseIdempotencyHeaders,
  parseJsonBody,
  parsePath
} from "@/modules/platform-api/contracts/dto";
import { apiContractErrorResponse } from "@/modules/platform-api/contracts/errors";
import {
  controlledDocumentVersionPathSchema,
  createDocumentReviewBodySchema
} from "@/modules/platform-api/contracts/internal-routes";

type RouteContext = {
  params: Promise<{ projectId: string; documentId: string; documentVersionId: string }>;
};

async function requestReview(request: Request, context: RouteContext) {
  const { projectId, documentId, documentVersionId } = await context.params;
  const guard = await authorizeProjectRequest(
    request,
    projectId,
    PERMISSIONS.CONTROLLED_DOCUMENT_MANAGE
  );
  if (!guard.authorized) return guard.response;
  try {
    const path = parsePath(controlledDocumentVersionPathSchema, {
      projectId,
      documentId,
      documentVersionId
    });
    const body = await parseJsonBody(request, createDocumentReviewBodySchema);
    const { idempotencyKey } = parseIdempotencyHeaders(request);
    const auditContext = auditContextFromRequest(request, {
      actorId: guard.actor.id,
      projectId: path.projectId,
      departmentId: guard.project.departmentId,
      reason: body.reason
    });
    return await idempotentCommandResponse({
      actorId: guard.actor.id,
      operation: "projects.controlled-document.request-review",
      idempotencyKey,
      request: { path, body },
      execute: async (transaction) => ({
        status: 201,
        body: await createDocumentReview(
          { ...path, ...body, actorId: guard.actor.id, auditContext },
          transaction
        )
      })
    });
  } catch (error) {
    const response = apiContractErrorResponse(error) ?? controlledDocumentErrorResponse(error);
    if (response) return response;
    throw error;
  }
}

export const POST = withRequestObservability(
  { module: "documents", operation: "request-controlled-document-review" },
  requestReview
);
