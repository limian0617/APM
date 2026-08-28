import { PERMISSIONS } from "@/lib/auth/permissions";
import { authorizeProjectRequest } from "@/lib/auth/project-guard";
import { auditContextFromRequest } from "@/modules/audit/application/context";
import {
  createProjectPublicLibraryReference,
  listProjectPublicLibraryReferences
} from "@/modules/documents/application/public-library-service";
import { publicLibraryErrorResponse } from "@/modules/documents/contracts/public-library-http";
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
  createProjectPublicLibraryReferenceBodySchema,
  projectPathSchema,
  projectPublicLibraryReferenceQuerySchema
} from "@/modules/platform-api/contracts/internal-routes";

type RouteContext = { params: Promise<{ projectId: string }> };

function errorResponse(error: unknown): Response | null {
  return apiContractErrorResponse(error) ?? publicLibraryErrorResponse(error);
}

async function listReferences(request: Request, context: RouteContext) {
  const { projectId } = await context.params;
  const guard = await authorizeProjectRequest(
    request,
    projectId,
    PERMISSIONS.CONTROLLED_DOCUMENT_READ,
    { requireProjectMembership: true }
  );
  if (!guard.authorized) return guard.response;

  try {
    const path = parsePath(projectPathSchema, { projectId });
    const query = parseQuery(request, projectPublicLibraryReferenceQuerySchema);
    return Response.json(
      await listProjectPublicLibraryReferences({ projectId: path.projectId, ...query })
    );
  } catch (error) {
    const response = errorResponse(error);
    if (response) return response;
    throw error;
  }
}

async function createReference(request: Request, context: RouteContext) {
  const { projectId } = await context.params;
  const guard = await authorizeProjectRequest(
    request,
    projectId,
    PERMISSIONS.CONTROLLED_DOCUMENT_MANAGE,
    { requireProjectMembership: true }
  );
  if (!guard.authorized) return guard.response;

  try {
    const path = parsePath(projectPathSchema, { projectId });
    const body = await parseJsonBody(request, createProjectPublicLibraryReferenceBodySchema);
    const { idempotencyKey } = parseIdempotencyHeaders(request);
    const auditContext = auditContextFromRequest(request, {
      actorId: guard.actor.id,
      projectId: path.projectId,
      departmentId: guard.project.departmentId,
      reason: body.reason
    });
    return await idempotentCommandResponse({
      actorId: guard.actor.id,
      operation: "projects.public-library-reference.create",
      idempotencyKey,
      request: { path, body },
      execute: async (transaction) => ({
        status: 201,
        body: await createProjectPublicLibraryReference(
          {
            projectId: path.projectId,
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
  { module: "documents", operation: "list-project-public-library-references" },
  listReferences
);
export const POST = withRequestObservability(
  { module: "documents", operation: "create-project-public-library-reference" },
  createReference
);
