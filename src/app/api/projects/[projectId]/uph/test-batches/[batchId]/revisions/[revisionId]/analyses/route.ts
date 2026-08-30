import { PERMISSIONS } from "@/lib/auth/permissions";
import { authorizeProjectRequest } from "@/lib/auth/project-guard";
import { auditContextFromRequest } from "@/modules/audit/application/context";
import { withRequestObservability } from "@/modules/observability/application/request-observer";
import { idempotentCommandResponse } from "@/modules/platform-api/application/idempotent-command";
import {
  parseIdempotencyHeaders,
  parseJsonBody,
  parsePath,
  parseQuery
} from "@/modules/platform-api/contracts/dto";
import { createUphAnalysis, listUphAnalyses } from "@/modules/uph/application/uph-analysis-service";
import { uphApiErrorResponse } from "@/modules/uph/application/uph-api-errors";
import {
  createUphAnalysisBodySchema,
  listUphAnalysesQuerySchema,
  uphAnalysisCollectionPathSchema
} from "@/modules/uph/contracts/uph-analysis-http";

type Context = {
  params: Promise<{ projectId: string; batchId: string; revisionId: string }>;
};

function auditContext(
  request: Request,
  input: {
    actorId: string;
    projectId: string;
    departmentId: string | null;
  }
) {
  return auditContextFromRequest(request, {
    actorId: input.actorId,
    projectId: input.projectId,
    departmentId: input.departmentId,
    reason: null
  });
}

async function create(request: Request, context: Context) {
  try {
    const raw = await context.params;
    const path = parsePath(uphAnalysisCollectionPathSchema, raw);
    const guard = await authorizeProjectRequest(
      request,
      path.projectId,
      PERMISSIONS.PROJECT_UPH_ANALYZE,
      { requireProjectMembership: true }
    );
    if (!guard.authorized) return guard.response;

    const body = await parseJsonBody(request, createUphAnalysisBodySchema);
    const { idempotencyKey } = parseIdempotencyHeaders(request);
    const requestAuditContext = auditContext(request, {
      actorId: guard.actor.id,
      projectId: path.projectId,
      departmentId: guard.project.departmentId
    });
    const serviceInput = {
      ...path,
      actorId: guard.actor.id,
      authorizationActor: guard.actor,
      projectMemberRoles: guard.project.memberRoles,
      auditContext: requestAuditContext
    };

    return await idempotentCommandResponse({
      actorId: guard.actor.id,
      operation: "projects.uph.analysis.create",
      idempotencyKey,
      request: { path, body },
      execute: async (transaction) => ({
        status: 201,
        body: await createUphAnalysis(serviceInput, transaction)
      })
    });
  } catch (error) {
    return uphApiErrorResponse(error) ?? Promise.reject(error);
  }
}

async function list(request: Request, context: Context) {
  try {
    const raw = await context.params;
    const path = parsePath(uphAnalysisCollectionPathSchema, raw);
    const guard = await authorizeProjectRequest(
      request,
      path.projectId,
      PERMISSIONS.PROJECT_UPH_READ,
      { requireProjectMembership: true }
    );
    if (!guard.authorized) return guard.response;

    const query = parseQuery(request, listUphAnalysesQuerySchema);
    const requestAuditContext = auditContext(request, {
      actorId: guard.actor.id,
      projectId: path.projectId,
      departmentId: guard.project.departmentId
    });
    return Response.json(
      await listUphAnalyses({
        ...path,
        ...query,
        actorId: guard.actor.id,
        authorizationActor: guard.actor,
        projectMemberRoles: guard.project.memberRoles,
        auditContext: requestAuditContext
      })
    );
  } catch (error) {
    return uphApiErrorResponse(error) ?? Promise.reject(error);
  }
}

export const POST = withRequestObservability(
  { module: "uph", operation: "create-analysis" },
  create
);
export const GET = withRequestObservability({ module: "uph", operation: "list-analyses" }, list);
