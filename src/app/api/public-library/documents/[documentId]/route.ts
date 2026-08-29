import { PERMISSIONS } from "@/lib/auth/permissions";
import { authorizeSystemRequest } from "@/lib/auth/system-guard";
import { auditContextFromRequest } from "@/modules/audit/application/context";
import { AUDIT_OBJECT_TYPES } from "@/modules/audit/domain/vocabulary";
import { getPublicLibraryDocument } from "@/modules/documents/application/public-library-service";
import { publicLibraryErrorResponse } from "@/modules/documents/contracts/public-library-http";
import { withRequestObservability } from "@/modules/observability/application/request-observer";
import { parsePath } from "@/modules/platform-api/contracts/dto";
import { apiContractErrorResponse } from "@/modules/platform-api/contracts/errors";
import { publicLibraryDocumentPathSchema } from "@/modules/platform-api/contracts/internal-routes";

type RouteContext = { params: Promise<{ documentId: string }> };

async function readDocument(request: Request, context: RouteContext) {
  const { documentId } = await context.params;
  const guard = await authorizeSystemRequest(
    request,
    PERMISSIONS.CONTROLLED_DOCUMENT_READ,
    AUDIT_OBJECT_TYPES.PUBLIC_LIBRARY_DOCUMENT,
    documentId
  );
  if (!guard.authorized) return guard.response;
  try {
    const path = parsePath(publicLibraryDocumentPathSchema, { documentId });
    return Response.json(
      await getPublicLibraryDocument({
        ...path,
        sourceFileAccess: {
          actor: guard.actor,
          auditContext: auditContextFromRequest(request, { actorId: guard.actor.id }),
          method: request.method,
          path: new URL(request.url).pathname
        }
      })
    );
  } catch (error) {
    const response = apiContractErrorResponse(error) ?? publicLibraryErrorResponse(error);
    if (response) return response;
    throw error;
  }
}

export const GET = withRequestObservability(
  { module: "public-library", operation: "read-document" },
  readDocument
);
