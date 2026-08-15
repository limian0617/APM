import { authorizeSystemRequest } from "@/lib/auth/system-guard";
import { decideAuthorization } from "@/lib/auth/authorize";
import { db } from "@/lib/db";
import { PERMISSIONS } from "@/lib/auth/permissions";
import { authorizeProjectRequest } from "@/lib/auth/project-guard";
import { auditContextFromRequest } from "@/modules/audit/application/context";
import { AUDIT_OBJECT_TYPES } from "@/modules/audit/domain/vocabulary";
import { createKnowledgeEntryVersion } from "@/modules/knowledge/application/knowledge-entry-service";
import { resolveKnowledgeReusePageContext } from "@/modules/knowledge/application/knowledge-authorization-query";
import { getKnowledgeSearchCapability } from "@/modules/knowledge/application/knowledge-search-capability";
import { searchPublishedKnowledge } from "@/modules/knowledge/application/knowledge-search-service";
import {
  createKnowledgeEntryBodySchema,
  knowledgeCommandContractErrorResponse,
  knowledgePageStateQuerySchema,
  knowledgeSearchQuerySchema,
  knowledgeServiceErrorResponse,
  type PublicKnowledgeVersionDto
} from "@/modules/knowledge/contracts/knowledge-http";
import { buildKnowledgePageState } from "@/modules/knowledge/contracts/knowledge-page-state";
import { createKnowledgeSearchRepository } from "@/modules/knowledge/infrastructure/knowledge-repository";
import { withRequestObservability } from "@/modules/observability/application/request-observer";
import { idempotentCommandResponse } from "@/modules/platform-api/application/idempotent-command";
import {
  parseIdempotencyHeaders,
  parseJsonBody,
  parseQuery
} from "@/modules/platform-api/contracts/dto";

function publicKnowledgeDto(input: {
  entryCode: string;
  version: number;
  title: string;
  sanitizedSummary: string;
  experienceType: string;
  discipline: string;
  keywords: string[];
  applicableProjectTypes: string[];
  applicableStageCodes: string[];
  status: "PUBLISHED" | "SUPERSEDED" | "REVOKED";
}): PublicKnowledgeVersionDto {
  return {
    entryCode: input.entryCode,
    version: input.version,
    title: input.title,
    sanitizedSummary: input.sanitizedSummary,
    experienceType: input.experienceType,
    discipline: input.discipline,
    keywords: [...input.keywords],
    applicableProjectTypes: [...input.applicableProjectTypes],
    applicableStageCodes: [...input.applicableStageCodes],
    status: input.status
  };
}

function knowledgePageStateForActor(input: {
  actor: Parameters<typeof decideAuthorization>[0];
  itemCount: number;
  canConfirmReuse: boolean;
  canCorrectReuse: boolean;
}) {
  return buildKnowledgePageState({
    authorization: "ALLOWED",
    search: input.itemCount ? { itemCount: input.itemCount } : null,
    loading: false,
    error: false,
    stale: false,
    canCreate: decideAuthorization(input.actor, PERMISSIONS.KNOWLEDGE_REVIEW).allowed,
    canConfirmReuse: input.canConfirmReuse,
    canCorrectReuse: input.canCorrectReuse
  });
}

async function resolvePageActionContext(
  request: Request,
  input: { targetProjectId?: string; reuseId?: string }
): Promise<{ canConfirmReuse: boolean; canCorrectReuse: boolean; response?: Response }> {
  if (!input.targetProjectId) return { canConfirmReuse: false, canCorrectReuse: false };
  const targetGuard = await authorizeProjectRequest(
    request,
    input.targetProjectId,
    PERMISSIONS.KNOWLEDGE_REUSE_CONFIRM
  );
  if (!targetGuard.authorized) {
    return { canConfirmReuse: false, canCorrectReuse: false, response: targetGuard.response };
  }
  const context = await resolveKnowledgeReusePageContext(
    { targetProjectId: input.targetProjectId, reuseId: input.reuseId },
    db
  );
  return { canConfirmReuse: true, canCorrectReuse: context.canCorrectReuse };
}

async function listKnowledge(request: Request) {
  const guard = await authorizeSystemRequest(
    request,
    PERMISSIONS.KNOWLEDGE_READ,
    AUDIT_OBJECT_TYPES.KNOWLEDGE_ENTRY,
    null
  );
  if (!guard.authorized) return guard.response;
  try {
    if (new URL(request.url).searchParams.get("view") === "PAGE_STATE") {
      const query = parseQuery(request, knowledgePageStateQuerySchema);
      const actions = await resolvePageActionContext(request, query);
      if (actions.response) return actions.response;
      return Response.json({
        pageState: knowledgePageStateForActor({ actor: guard.actor, itemCount: 0, ...actions }),
        items: []
      });
    }
    const query = parseQuery(request, knowledgeSearchQuerySchema);
    const { targetProjectId, reuseId, ...searchQuery } = query;
    const actions = await resolvePageActionContext(request, { targetProjectId, reuseId });
    if (actions.response) return actions.response;
    const result = await searchPublishedKnowledge(searchQuery, {
      getCapability: () => getKnowledgeSearchCapability(db),
      repository: createKnowledgeSearchRepository(db)
    });
    const pageState = knowledgePageStateForActor({
      actor: guard.actor,
      itemCount: result.items.length,
      ...actions
    });
    return Response.json({
      capability: result.capability,
      warningCode: result.warningCode,
      nextCursor: result.nextCursor,
      pageState,
      items: result.items.map(publicKnowledgeDto)
    });
  } catch (error) {
    return (
      knowledgeCommandContractErrorResponse(error) ??
      knowledgeServiceErrorResponse(error) ??
      Promise.reject(error)
    );
  }
}

async function createKnowledge(request: Request) {
  const globalGuard = await authorizeSystemRequest(
    request,
    PERMISSIONS.KNOWLEDGE_REVIEW,
    AUDIT_OBJECT_TYPES.KNOWLEDGE_ENTRY,
    null
  );
  if (!globalGuard.authorized) return globalGuard.response;
  try {
    const body = await parseJsonBody(request, createKnowledgeEntryBodySchema);
    const sourceGuard = await authorizeProjectRequest(
      request,
      body.sourceProjectId,
      PERMISSIONS.PROJECT_RETROSPECTIVE_READ
    );
    if (!sourceGuard.authorized) return sourceGuard.response;
    const { idempotencyKey } = parseIdempotencyHeaders(request);
    return await idempotentCommandResponse({
      actorId: globalGuard.actor.id,
      operation: "knowledge.entry.create",
      idempotencyKey,
      request: { body },
      execute: async (transaction) => ({
        status: 201,
        body: await createKnowledgeEntryVersion(
          {
            ...body,
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

export const GET = withRequestObservability(
  { module: "knowledge", operation: "search-published-knowledge" },
  listKnowledge
);
export const POST = withRequestObservability(
  { module: "knowledge", operation: "create-knowledge-entry-version" },
  createKnowledge
);
