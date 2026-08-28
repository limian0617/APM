import { PERMISSIONS } from "@/lib/auth/permissions";
import { authorizeProjectRequest } from "@/lib/auth/project-guard";
import { auditContextFromRequest } from "@/modules/audit/application/context";
import { voidControlledDocument } from "@/modules/documents/application/controlled-document-service";
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
  controlledDocumentPathSchema,
  voidControlledDocumentBodySchema
} from "@/modules/platform-api/contracts/internal-routes";

type RouteContext = { params: Promise<{ projectId: string; documentId: string }> };

async function voidDocument(request: Request, context: RouteContext) {
  const { projectId, documentId } = await context.params;
  const guard = await authorizeProjectRequest(
    request,
    projectId,
    PERMISSIONS.CONTROLLED_DOCUMENT_MANAGE
  );
  if (!guard.authorized) return guard.response;
  try {
    const path = parsePath(controlledDocumentPathSchema, { projectId, documentId });
    const body = await parseJsonBody(request, voidControlledDocumentBodySchema);
    const { idempotencyKey } = parseIdempotencyHeaders(request);
    return await idempotentCommandResponse({
      actorId: guard.actor.id,
      operation: "projects.controlled-document.void",
      idempotencyKey,
      request: { path, body },
      execute: async (transaction) => ({
        status: 200,
        body: await voidControlledDocument(
          {
            projectId: path.projectId,
            documentId: path.documentId,
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
    const response = apiContractErrorResponse(error) ?? controlledDocumentErrorResponse(error);
    if (response) return response;
    throw error;
  }
}

export const POST = withRequestObservability(
  { module: "documents", operation: "void-controlled-document" },
  voidDocument
);
