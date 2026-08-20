import { PERMISSIONS } from "@/lib/auth/permissions";
import { authorizeProjectRequest } from "@/lib/auth/project-guard";
import { authorizeSystemRequest } from "@/lib/auth/system-guard";
import { auditContextFromRequest } from "@/modules/audit/application/context";
import { AUDIT_OBJECT_TYPES } from "@/modules/audit/domain/vocabulary";
import { createKnowledgeEntryVersion } from "@/modules/knowledge/application/knowledge-entry-service";
import {
  createKnowledgeEntryVersionBodySchema,
  knowledgeCommandContractErrorResponse,
  knowledgeEntryPathSchema,
  knowledgeServiceErrorResponse
} from "@/modules/knowledge/contracts/knowledge-http";
import { withRequestObservability } from "@/modules/observability/application/request-observer";
import { idempotentCommandResponse } from "@/modules/platform-api/application/idempotent-command";
import {
  parseIdempotencyHeaders,
  parseJsonBody,
  parsePath
} from "@/modules/platform-api/contracts/dto";

type RouteContext = { params: Promise<{ entryId: string }> };

async function createKnowledgeVersion(request: Request, context: RouteContext) {
  const { entryId } = await context.params;
  const globalGuard = await authorizeSystemRequest(
    request,
    PERMISSIONS.KNOWLEDGE_REVIEW,
    AUDIT_OBJECT_TYPES.KNOWLEDGE_ENTRY,
    entryId
  );
  if (!globalGuard.authorized) return globalGuard.response;
  try {
    const path = parsePath(knowledgeEntryPathSchema, { entryId });
    const body = await parseJsonBody(request, createKnowledgeEntryVersionBodySchema);
    const sourceGuard = await authorizeProjectRequest(
      request,
      body.sourceProjectId,
      PERMISSIONS.PROJECT_RETROSPECTIVE_READ
    );
    if (!sourceGuard.authorized) return sourceGuard.response;
    const { idempotencyKey } = parseIdempotencyHeaders(request);
    return await idempotentCommandResponse({
      actorId: globalGuard.actor.id,
      operation: "knowledge.entry-version.create",
      idempotencyKey,
      request: { path, body },
      execute: async (transaction) => ({
        status: 201,
        body: await createKnowledgeEntryVersion(
          {
            ...body,
            entryId: path.entryId,
            actorId: globalGuard.actor.id,
            idempotencyKey,
            sourceRead: { knowledgePermissionAllowed: true, sourceProjectReadAllowed: true },
            auditContext: auditContextFromRequest(request, {
              actorId: globalGuard.actor.id,
              projectId: body.sourceProjectId,
              departmentId: sourceGuard.project.departmentId
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
  { module: "knowledge", operation: "create-knowledge-entry-version" },
  createKnowledgeVersion
);
