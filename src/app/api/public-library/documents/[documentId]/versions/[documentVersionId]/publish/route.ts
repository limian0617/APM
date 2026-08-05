import { PERMISSIONS } from "@/lib/auth/permissions";
import { authorizeSystemRequest } from "@/lib/auth/system-guard";
import { auditContextFromRequest } from "@/modules/audit/application/context";
import { AUDIT_OBJECT_TYPES } from "@/modules/audit/domain/vocabulary";
import { publishPublicLibraryDocumentVersion } from "@/modules/documents/application/public-library-service";
import { publicLibraryErrorResponse } from "@/modules/documents/contracts/public-library-http";
import { withRequestObservability } from "@/modules/observability/application/request-observer";
import { idempotentCommandResponse } from "@/modules/platform-api/application/idempotent-command";
import {
  parseIdempotencyHeaders,
  parseJsonBody,
  parsePath
} from "@/modules/platform-api/contracts/dto";
import { apiContractErrorResponse } from "@/modules/platform-api/contracts/errors";
import {
  publicLibraryDocumentVersionPathSchema,
  publishPublicLibraryDocumentVersionBodySchema
} from "@/modules/platform-api/contracts/internal-routes";

type RouteContext = { params: Promise<{ documentId: string; documentVersionId: string }> };

async function publishVersion(request: Request, context: RouteContext) {
  const { documentId, documentVersionId } = await context.params;
  const guard = await authorizeSystemRequest(
    request,
    PERMISSIONS.CONTROLLED_DOCUMENT_MANAGE,
    AUDIT_OBJECT_TYPES.PUBLIC_LIBRARY_DOCUMENT_VERSION,
    documentVersionId
  );
  if (!guard.authorized) return guard.response;
  try {
    const path = parsePath(publicLibraryDocumentVersionPathSchema, {
      documentId,
      documentVersionId
    });
    const body = await parseJsonBody(request, publishPublicLibraryDocumentVersionBodySchema);
    const { idempotencyKey } = parseIdempotencyHeaders(request);
    return await idempotentCommandResponse({
      actorId: guard.actor.id,
      operation: "public-library.document.version.publish",
      idempotencyKey,
      request: { path, body },
      execute: async (transaction) => ({
        status: 200,
        body: await publishPublicLibraryDocumentVersion(
          {
            ...path,
            ...body,
            actorId: guard.actor.id,
            auditContext: auditContextFromRequest(request, {
              actorId: guard.actor.id,
              reason: body.reason
            })
          },
          transaction
        )
      })
    });
  } catch (error) {
    const response = apiContractErrorResponse(error) ?? publicLibraryErrorResponse(error);
    if (response) return response;
    throw error;
  }
}

export const POST = withRequestObservability(
  { module: "public-library", operation: "publish-document-version" },
  publishVersion
);
