import { PERMISSIONS } from "@/lib/auth/permissions";
import { authorizeProjectRequest } from "@/lib/auth/project-guard";
import { auditContextFromRequest } from "@/modules/audit/application/context";
import { withRequestObservability } from "@/modules/observability/application/request-observer";
import { idempotentCommandResponse } from "@/modules/platform-api/application/idempotent-command";
import {
  parseIdempotencyHeaders,
  parseIfMatchHeader,
  parseJsonBody,
  parsePath,
  parseQuery,
  assertIfMatchMatches
} from "@/modules/platform-api/contracts/dto";
import { z } from "zod";

import {
  createUphDefinition,
  getUphDefinition
} from "@/modules/uph/application/uph-definition-service";
import { uphApiErrorResponse } from "@/modules/uph/application/uph-api-errors";
import {
  uphDefinitionBodySchema,
  uphPatchDefinitionBodySchema,
  uphSelectionQuerySchemaByKind
} from "@/modules/uph/contracts/uph-http";

const pathSchema = z.strictObject({
  projectId: z.string().trim().min(1),
  kind: z.enum(["TOPOLOGY", "CT", "FORMULA"])
});
type Context = { params: Promise<{ projectId: string; kind: string }> };

function errorResponse(error: unknown): Response | undefined {
  return uphApiErrorResponse(error) ?? undefined;
}

async function create(request: Request, context: Context) {
  const raw = await context.params;
  const path = parsePath(pathSchema, raw);
  const guard = await authorizeProjectRequest(
    request,
    path.projectId,
    PERMISSIONS.PROJECT_UPH_DEFINITION_MANAGE,
    { requireProjectMembership: true }
  );
  if (!guard.authorized) return guard.response;
  try {
    const body = await parseJsonBody(request, uphDefinitionBodySchema);
    if (body.kind !== path.kind)
      return Response.json(
        { error: { code: "VALIDATION_FAILED", message: "定义类型不一致。" } },
        { status: 422 }
      );
    const { idempotencyKey } = parseIdempotencyHeaders(request);
    const auditContext = auditContextFromRequest(request, {
      actorId: guard.actor.id,
      projectId: path.projectId,
      departmentId: guard.project.departmentId,
      reason: null
    });
    return await idempotentCommandResponse({
      actorId: guard.actor.id,
      operation: "projects.uph.definition.create",
      idempotencyKey,
      request: { path, body },
      execute: async (transaction) => ({
        status: 201,
        body: await createUphDefinition(
          {
            projectId: path.projectId,
            actorId: guard.actor.id,
            authorizationActor: guard.actor,
            body,
            auditContext
          },
          transaction
        )
      })
    });
  } catch (error) {
    return errorResponse(error) ?? Promise.reject(error);
  }
}

async function update(request: Request, context: Context) {
  const raw = await context.params;
  const path = parsePath(pathSchema, raw);
  const guard = await authorizeProjectRequest(
    request,
    path.projectId,
    PERMISSIONS.PROJECT_UPH_DEFINITION_MANAGE,
    { requireProjectMembership: true }
  );
  if (!guard.authorized) return guard.response;
  try {
    const body = await parseJsonBody(request, uphPatchDefinitionBodySchema);
    if (body.kind !== path.kind)
      return Response.json(
        { error: { code: "VALIDATION_FAILED", message: "定义类型不一致。" } },
        { status: 422 }
      );
    assertIfMatchMatches(parseIfMatchHeader(request), body.resourceVersion, "resourceVersion");
    const { idempotencyKey } = parseIdempotencyHeaders(request);
    const auditContext = auditContextFromRequest(request, {
      actorId: guard.actor.id,
      projectId: path.projectId,
      departmentId: guard.project.departmentId,
      reason: null
    });
    return await idempotentCommandResponse({
      actorId: guard.actor.id,
      operation: "projects.uph.definition.update",
      idempotencyKey,
      request: { path, body },
      execute: async (transaction) => ({
        status: 200,
        body: await createUphDefinition(
          {
            projectId: path.projectId,
            actorId: guard.actor.id,
            authorizationActor: guard.actor,
            body,
            auditContext
          },
          transaction
        )
      })
    });
  } catch (error) {
    return errorResponse(error) ?? Promise.reject(error);
  }
}

async function read(request: Request, context: Context) {
  const raw = await context.params;
  const path = parsePath(pathSchema, raw);
  const guard = await authorizeProjectRequest(
    request,
    path.projectId,
    PERMISSIONS.PROJECT_UPH_READ,
    { requireProjectMembership: true }
  );
  if (!guard.authorized) return guard.response;
  try {
    const query = parseQuery(request, uphSelectionQuerySchemaByKind[path.kind]);
    const projectModuleId =
      path.kind === "CT" && "projectModuleId" in query && typeof query.projectModuleId === "string"
        ? query.projectModuleId
        : undefined;
    if (path.kind === "CT" && query.selection !== "exact" && !projectModuleId)
      throw new Error("CT current query was accepted without project module scope");
    if (path.kind !== "CT" && projectModuleId)
      throw new Error("Non-CT query was accepted with project module scope");
    if (query.selection === "exact") {
      if (typeof query.versionId !== "string")
        throw new Error("Exact UPH query was accepted without a version id");
      return Response.json(
        await getUphDefinition({
          projectId: path.projectId,
          kind: path.kind,
          selection: query.selection,
          versionId: query.versionId,
          authorizationActor: guard.actor,
          projectMemberRoles: guard.project.memberRoles
        })
      );
    }
    return Response.json(
      await getUphDefinition({
        projectId: path.projectId,
        kind: path.kind,
        selection: query.selection,
        authorizationActor: guard.actor,
        projectMemberRoles: guard.project.memberRoles,
        ...(projectModuleId ? { projectModuleId } : {})
      })
    );
  } catch (error) {
    return errorResponse(error) ?? Promise.reject(error);
  }
}

export const POST = withRequestObservability(
  { module: "uph", operation: "create-uph-definition" },
  create
);
export const PATCH = withRequestObservability(
  { module: "uph", operation: "update-uph-definition" },
  update
);
export const GET = withRequestObservability(
  { module: "uph", operation: "read-uph-definition" },
  read
);
