import { PERMISSIONS } from "@/lib/auth/permissions";
import { authorizeProjectRequest } from "@/lib/auth/project-guard";
import { db } from "@/lib/db";
import { auditContextFromRequest } from "@/modules/audit/application/context";
import { withRequestObservability } from "@/modules/observability/application/request-observer";
import { idempotentCommandResponse } from "@/modules/platform-api/application/idempotent-command";
import {
  parseIdempotencyHeaders,
  parseJsonBody,
  parsePath
} from "@/modules/platform-api/contracts/dto";
import { apiContractErrorResponse } from "@/modules/platform-api/contracts/errors";
import {
  initializeProjectStructureBodySchema,
  projectPathSchema
} from "@/modules/platform-api/contracts/internal-routes";
import { initializeProjectStructure } from "@/modules/projects/application/project-structure";
import { projectStructureErrorResponse } from "@/modules/projects/contracts/project-http";

type RouteContext = { params: Promise<{ projectId: string }> };

async function readStructure(request: Request, context: RouteContext) {
  const { projectId } = await context.params;
  const guard = await authorizeProjectRequest(request, projectId, PERMISSIONS.PROJECT_READ);
  if (!guard.authorized) return guard.response;

  try {
    const path = parsePath(projectPathSchema, { projectId });
    const project = await db.project.findUniqueOrThrow({
      where: { id: path.projectId },
      select: {
        id: true,
        code: true,
        name: true,
        projectType: true,
        equipmentShape: true,
        structureStatus: true,
        version: true,
        deliveryUnits: {
          orderBy: [{ position: "asc" }, { code: "asc" }],
          select: {
            id: true,
            parentId: true,
            unitType: true,
            code: true,
            name: true,
            status: true,
            position: true,
            version: true
          }
        },
        projectModules: {
          orderBy: [{ deliveryUnitId: "asc" }, { position: "asc" }, { code: "asc" }],
          select: {
            id: true,
            deliveryUnitId: true,
            code: true,
            name: true,
            status: true,
            position: true,
            version: true
          }
        }
      }
    });
    return Response.json({ project });
  } catch (error) {
    return apiContractErrorResponse(error) ?? Promise.reject(error);
  }
}

async function initializeStructure(request: Request, context: RouteContext) {
  const { projectId } = await context.params;
  const guard = await authorizeProjectRequest(request, projectId, PERMISSIONS.PROJECT_PLAN_UPDATE);
  if (!guard.authorized) return guard.response;

  try {
    const path = parsePath(projectPathSchema, { projectId });
    const body = await parseJsonBody(request, initializeProjectStructureBodySchema);
    const { idempotencyKey } = parseIdempotencyHeaders(request);
    return await idempotentCommandResponse({
      actorId: guard.actor.id,
      operation: "projects.structure.initialize",
      idempotencyKey,
      request: { path, body },
      execute: async (transaction) => ({
        status: 201,
        body: await initializeProjectStructure(
          {
            projectId: path.projectId,
            ...body,
            actorId: guard.actor.id,
            auditContext: auditContextFromRequest(request, {
              actorId: guard.actor.id,
              projectId: path.projectId,
              departmentId: guard.project.departmentId,
              reason: body.reason
            })
          },
          transaction
        )
      })
    });
  } catch (error) {
    return (
      apiContractErrorResponse(error) ??
      projectStructureErrorResponse(error) ??
      Promise.reject(error)
    );
  }
}

export const GET = withRequestObservability(
  { module: "projects", operation: "read-structure" },
  readStructure
);
export const POST = withRequestObservability(
  { module: "projects", operation: "initialize-structure" },
  initializeStructure
);
