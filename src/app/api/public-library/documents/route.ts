import { PERMISSIONS } from "@/lib/auth/permissions";
import { authorizeSystemRequest } from "@/lib/auth/system-guard";
import { auditContextFromRequest } from "@/modules/audit/application/context";
import { AUDIT_OBJECT_TYPES } from "@/modules/audit/domain/vocabulary";
import {
  createPublicLibraryDocument,
  listPublicLibraryDocuments
} from "@/modules/documents/application/public-library-service";
import { publicLibraryErrorResponse } from "@/modules/documents/contracts/public-library-http";
import { withRequestObservability } from "@/modules/observability/application/request-observer";
import { idempotentCommandResponse } from "@/modules/platform-api/application/idempotent-command";
import {
  parseIdempotencyHeaders,
  parseJsonBody,
  parseQuery
} from "@/modules/platform-api/contracts/dto";
import { apiContractErrorResponse } from "@/modules/platform-api/contracts/errors";
import {
  createPublicLibraryDocumentBodySchema,
  publicLibraryDocumentQuerySchema
} from "@/modules/platform-api/contracts/internal-routes";

function errorResponse(error: unknown): Response | null {
  return apiContractErrorResponse(error) ?? publicLibraryErrorResponse(error);
}

async function listDocuments(request: Request) {
  const guard = await authorizeSystemRequest(
    request,
    PERMISSIONS.CONTROLLED_DOCUMENT_READ,
    AUDIT_OBJECT_TYPES.PUBLIC_LIBRARY_DOCUMENT
  );
  if (!guard.authorized) return guard.response;
  try {
    const query = parseQuery(request, publicLibraryDocumentQuerySchema);
    return Response.json(
      await listPublicLibraryDocuments({
        ...query,
        sourceFileAccess: {
          actor: guard.actor,
          auditContext: auditContextFromRequest(request, { actorId: guard.actor.id }),
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

async function createDocument(request: Request) {
  const guard = await authorizeSystemRequest(
    request,
    PERMISSIONS.CONTROLLED_DOCUMENT_MANAGE,
    AUDIT_OBJECT_TYPES.PUBLIC_LIBRARY_DOCUMENT
  );
  if (!guard.authorized) return guard.response;
  try {
    const body = await parseJsonBody(request, createPublicLibraryDocumentBodySchema);
    const { idempotencyKey } = parseIdempotencyHeaders(request);
    const auditContext = auditContextFromRequest(request, {
      actorId: guard.actor.id,
      reason: body.reason
    });
    return await idempotentCommandResponse({
      actorId: guard.actor.id,
      operation: "public-library.document.create",
      idempotencyKey,
      request: { body },
      execute: async (transaction) => ({
        status: 201,
        body: await createPublicLibraryDocument(
          {
            ...body,
            actorId: guard.actor.id,
            auditContext,
            sourceFileAccess: {
              actor: guard.actor,
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
  { module: "public-library", operation: "list-documents" },
  listDocuments
);
export const POST = withRequestObservability(
  { module: "public-library", operation: "create-document" },
  createDocument
);
