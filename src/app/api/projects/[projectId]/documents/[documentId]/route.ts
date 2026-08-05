import { PERMISSIONS } from "@/lib/auth/permissions";
import { authorizeProjectRequest } from "@/lib/auth/project-guard";
import { auditContextFromRequest } from "@/modules/audit/application/context";
import { getControlledDocument } from "@/modules/documents/application/controlled-document-service";
import { controlledDocumentErrorResponse } from "@/modules/documents/contracts/controlled-document-http";
import { withRequestObservability } from "@/modules/observability/application/request-observer";
import { parsePath } from "@/modules/platform-api/contracts/dto";
import { apiContractErrorResponse } from "@/modules/platform-api/contracts/errors";
import { controlledDocumentPathSchema } from "@/modules/platform-api/contracts/internal-routes";

type RouteContext = { params: Promise<{ projectId: string; documentId: string }> };

async function readDocument(request: Request, context: RouteContext) {
  const { projectId, documentId } = await context.params;
  const guard = await authorizeProjectRequest(
    request,
    projectId,
    PERMISSIONS.CONTROLLED_DOCUMENT_READ
  );
  if (!guard.authorized) return guard.response;
  try {
    const path = parsePath(controlledDocumentPathSchema, { projectId, documentId });
    return Response.json(
      await getControlledDocument({
        ...path,
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
    const response = apiContractErrorResponse(error) ?? controlledDocumentErrorResponse(error);
    if (response) return response;
    throw error;
  }
}

export const GET = withRequestObservability(
  { module: "documents", operation: "read-controlled-document" },
  readDocument
);
