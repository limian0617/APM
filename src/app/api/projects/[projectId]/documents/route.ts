import { PERMISSIONS } from "@/lib/auth/permissions";
import { authorizeProjectRequest } from "@/lib/auth/project-guard";
import { auditContextFromRequest } from "@/modules/audit/application/context";
import {
  createControlledDocument,
  listControlledDocuments
} from "@/modules/documents/application/controlled-document-service";
import { controlledDocumentErrorResponse } from "@/modules/documents/contracts/controlled-document-http";
import { withRequestObservability } from "@/modules/observability/application/request-observer";
import { idempotentCommandResponse } from "@/modules/platform-api/application/idempotent-command";
import {
  parseIdempotencyHeaders,
  parseJsonBody,
  parsePath,
  parseQuery
} from "@/modules/platform-api/contracts/dto";
import { apiContractErrorResponse } from "@/modules/platform-api/contracts/errors";
import {
  controlledDocumentQuerySchema,
  createControlledDocumentBodySchema,
  projectPathSchema
} from "@/modules/platform-api/contracts/internal-routes";

type RouteContext = { params: Promise<{ projectId: string }> };

function errorResponse(error: unknown): Response | null {
  return apiContractErrorResponse(error) ?? controlledDocumentErrorResponse(error);
}

async function listDocuments(request: Request, context: RouteContext) {
  const { projectId } = await context.params;
  const guard = await authorizeProjectRequest(
    request,
    projectId,
    PERMISSIONS.CONTROLLED_DOCUMENT_READ
  );
  if (!guard.authorized) return guard.response;
  try {
    const path = parsePath(projectPathSchema, { projectId });
    const query = parseQuery(request, controlledDocumentQuerySchema);
    return Response.json(
      await listControlledDocuments({
        projectId: path.projectId,
        ...query,
        sourceFileAccess: {
          actor: guard.actor,
          project: guard.project,
          auditContext: auditContextFromRequest(request, {
            actorId: guard.actor.id,
            projectId: path.projectId,
            departmentId: guard.project.departmentId
          }),
          method: request.method,
          path: new URL(request.url).pathname
        }
      })
    );
  } catch (error) {
    const response = errorResponse(error);
    if (response) return response;
    throw error;
  }
}

async function createDocument(request: Request, context: RouteContext) {
  const { projectId } = await context.params;
  const guard = await authorizeProjectRequest(
    request,
    projectId,
    PERMISSIONS.CONTROLLED_DOCUMENT_MANAGE
  );
  if (!guard.authorized) return guard.response;
  try {
    const path = parsePath(projectPathSchema, { projectId });
    const body = await parseJsonBody(request, createControlledDocumentBodySchema);
    const { idempotencyKey } = parseIdempotencyHeaders(request);
    const auditContext = auditContextFromRequest(request, {
      actorId: guard.actor.id,
      projectId: path.projectId,
      departmentId: guard.project.departmentId,
      reason: body.reason
    });
    return await idempotentCommandResponse({
      actorId: guard.actor.id,
      operation: "projects.controlled-document.create",
      idempotencyKey,
      request: { path, body },
      execute: async (transaction) => ({
        status: 201,
        body: await createControlledDocument(
          {
            projectId: path.projectId,
            ...body,
            actorId: guard.actor.id,
            auditContext,
            sourceFileAccess: {
              actor: guard.actor,
              project: guard.project,
              auditContext,
              method: request.method,
              path: new URL(request.url).pathname
            }
          },
          transaction
        )
      })
    });
  } catch (error) {
    const response = errorResponse(error);
    if (response) return response;
    throw error;
  }
}

export const GET = withRequestObservability(
  { module: "documents", operation: "list-controlled-documents" },
  listDocuments
);
export const POST = withRequestObservability(
  { module: "documents", operation: "create-controlled-document" },
  createDocument
);
