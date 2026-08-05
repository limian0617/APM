import { PERMISSIONS } from "@/lib/auth/permissions";
import { authorizeProjectRequest } from "@/lib/auth/project-guard";
import { auditContextFromRequest } from "@/modules/audit/application/context";
import { authorizeResourceLoadPeopleRead } from "@/modules/cockpit/application/resource-load-authorization";
import {
  getLatestProjectResourceLoad,
  getProjectResourceLoadById
} from "@/modules/cockpit/application/resource-load-projection-service";
import { resourceLoadProjectionErrorResponse } from "@/modules/cockpit/contracts/resource-load-http";
import { withRequestObservability } from "@/modules/observability/application/request-observer";
import { parsePath } from "@/modules/platform-api/contracts/dto";
import { apiContractErrorResponse } from "@/modules/platform-api/contracts/errors";
import { projectPathSchema } from "@/modules/platform-api/contracts/internal-routes";

type RouteContext = { params: Promise<{ projectId: string }> };

function withoutPeople(
  projection: Exclude<Awaited<ReturnType<typeof getLatestProjectResourceLoad>>["projection"], null>
) {
  return {
    projectionId: projection.projectionId,
    projectId: projection.projectId,
    sourceChecksum: projection.sourceChecksum,
    calculatedAt: projection.calculatedAt,
    peopleCount: projection.peopleCount,
    departments: projection.departments.map((department) => ({
      departmentId: department.departmentId,
      plannedDays: department.plannedDays,
      activeTaskCount: department.activeTaskCount,
      disciplines: department.disciplines.map((discipline) => ({
        discipline: discipline.discipline,
        plannedDays: discipline.plannedDays,
        activeTaskCount: discipline.activeTaskCount,
        people: []
      }))
    }))
  };
}

async function readResourceLoad(request: Request, context: RouteContext) {
  const { projectId } = await context.params;
  const guard = await authorizeProjectRequest(request, projectId, PERMISSIONS.PROJECT_READ);
  if (!guard.authorized) return guard.response;

  try {
    const path = parsePath(projectPathSchema, { projectId });
    const aggregate = await getLatestProjectResourceLoad(path.projectId, false);
    if (!aggregate.projection) {
      return Response.json({ ...aggregate, peopleIncluded: false });
    }

    const peopleIncluded = await authorizeResourceLoadPeopleRead({
      actor: guard.actor,
      project: guard.project,
      projectionId: aggregate.projection.projectionId,
      peopleCount: aggregate.projection.peopleCount,
      auditContext: auditContextFromRequest(request, {
        actorId: guard.actor.id,
        projectId: path.projectId,
        departmentId: guard.project.departmentId
      })
    });
    const result = peopleIncluded
      ? {
          ...aggregate,
          projection: await getProjectResourceLoadById(
            path.projectId,
            aggregate.projection.projectionId,
            true
          )
        }
      : { ...aggregate, projection: withoutPeople(aggregate.projection) };
    return Response.json({
      ...result,
      peopleIncluded: peopleIncluded && result.projection !== null
    });
  } catch (error) {
    return (
      apiContractErrorResponse(error) ??
      resourceLoadProjectionErrorResponse(error) ??
      Promise.reject(error)
    );
  }
}

export const GET = withRequestObservability(
  { module: "cockpit", operation: "read-resource-load" },
  readResourceLoad
);
