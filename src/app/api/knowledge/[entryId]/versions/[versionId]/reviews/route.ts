import { PERMISSIONS } from "@/lib/auth/permissions";
import { db } from "@/lib/db";
import { authorizeProjectRequest } from "@/lib/auth/project-guard";
import { authorizeSystemRequest } from "@/lib/auth/system-guard";
import { auditContextFromRequest } from "@/modules/audit/application/context";
import { AUDIT_OBJECT_TYPES } from "@/modules/audit/domain/vocabulary";
import { reviewKnowledgeEntryVersion } from "@/modules/knowledge/application/knowledge-entry-service";
import { resolveKnowledgeVersionSourceProject } from "@/modules/knowledge/application/knowledge-authorization-query";
import {
  knowledgeCommandContractErrorResponse,
  knowledgeReviewBodySchema,
  knowledgeServiceErrorResponse,
  knowledgeVersionPathSchema
} from "@/modules/knowledge/contracts/knowledge-http";
import { withRequestObservability } from "@/modules/observability/application/request-observer";
import { idempotentCommandResponse } from "@/modules/platform-api/application/idempotent-command";
import {
  parseIdempotencyHeaders,
  parseJsonBody,
  parsePath
} from "@/modules/platform-api/contracts/dto";

type RouteContext = { params: Promise<{ entryId: string; versionId: string }> };

async function reviewKnowledgeVersion(request: Request, context: RouteContext) {
  const { entryId, versionId } = await context.params;
  const globalGuard = await authorizeSystemRequest(
    request,
    PERMISSIONS.KNOWLEDGE_REVIEW,
    AUDIT_OBJECT_TYPES.KNOWLEDGE_ENTRY_VERSION,
    versionId
  );
  if (!globalGuard.authorized) return globalGuard.response;
  try {
    const path = parsePath(knowledgeVersionPathSchema, { entryId, versionId });
    const body = await parseJsonBody(request, knowledgeReviewBodySchema);
    const source = await resolveKnowledgeVersionSourceProject(path, db);
    const sourceGuard = await authorizeProjectRequest(
      request,
      source.sourceProjectId,
      PERMISSIONS.PROJECT_RETROSPECTIVE_READ
    );
    if (!sourceGuard.authorized) return sourceGuard.response;
    const { idempotencyKey } = parseIdempotencyHeaders(request);
    return await idempotentCommandResponse({
      actorId: globalGuard.actor.id,
      operation: "knowledge.entry-version.review",
      idempotencyKey,
      request: { path, body },
      execute: async (transaction) => ({
        status: 200,
        body: await reviewKnowledgeEntryVersion(
          {
            entryId: path.entryId,
            versionId: path.versionId,
            expectedEntryVersion: body.expectedEntryVersion,
            decision: body.decision,
            reason: body.reason,
            ipConfirmed: body.ipConfirmed,
            sanitizationConfirmed: body.sanitizationConfirmed,
            actorId: globalGuard.actor.id,
            idempotencyKey,
            sourceRead: { knowledgePermissionAllowed: true, sourceProjectReadAllowed: true },
            auditContext: auditContextFromRequest(request, {
              actorId: globalGuard.actor.id,
              projectId: source.sourceProjectId,
              departmentId: sourceGuard.project.departmentId,
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
  { module: "knowledge", operation: "review-knowledge-entry-version" },
  reviewKnowledgeVersion
);
