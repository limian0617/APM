import { PERMISSIONS } from "@/lib/auth/permissions";
import { authorizeProjectRequest } from "@/lib/auth/project-guard";
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
  milestoneAchieveBodySchema,
  milestoneCommandPathSchema,
  milestoneLinkTaskBodySchema,
  milestoneVoidBodySchema,
  milestoneVoidTaskLinkBodySchema
} from "@/modules/platform-api/contracts/internal-routes";
import {
  linkMilestoneTask,
  manuallyAchieveProjectMilestone,
  voidMilestoneTaskLink,
  voidProjectMilestone
} from "@/modules/projects/application/milestone-service";
import { projectExecutionErrorResponse } from "@/modules/planning/contracts/project-execution-http";

type RouteContext = {
  params: Promise<{ projectId: string; milestoneId: string; command: string }>;
};

async function commandMilestone(request: Request, context: RouteContext) {
  const params = await context.params;
  try {
    const path = parsePath(milestoneCommandPathSchema, params);
    const guard = await authorizeProjectRequest(
      request,
      path.projectId,
      PERMISSIONS.PROJECT_PLAN_UPDATE
    );
    if (!guard.authorized) return guard.response;
    const { idempotencyKey } = parseIdempotencyHeaders(request);
    if (path.command === "achieve") {
      const body = await parseJsonBody(request, milestoneAchieveBodySchema);
      return await idempotentCommandResponse({
        actorId: guard.actor.id,
        operation: "projects.milestone.achieve",
        idempotencyKey,
        request: { path, body },
        execute: async (transaction) => ({
          status: 200,
          body: await manuallyAchieveProjectMilestone(
            {
              projectId: path.projectId,
              milestoneId: path.milestoneId,
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
    }
    if (path.command === "void") {
      const body = await parseJsonBody(request, milestoneVoidBodySchema);
      return await idempotentCommandResponse({
        actorId: guard.actor.id,
        operation: "projects.milestone.void",
        idempotencyKey,
        request: { path, body },
        execute: async (transaction) => ({
          status: 200,
          body: await voidProjectMilestone(
            {
              projectId: path.projectId,
              milestoneId: path.milestoneId,
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
    }
    if (path.command === "link-task") {
      const body = await parseJsonBody(request, milestoneLinkTaskBodySchema);
      return await idempotentCommandResponse({
        actorId: guard.actor.id,
        operation: "projects.milestone.link-task",
        idempotencyKey,
        request: { path, body },
        execute: async (transaction) => ({
          status: 200,
          body: await linkMilestoneTask(
            {
              projectId: path.projectId,
              milestoneId: path.milestoneId,
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
    }
    const body = await parseJsonBody(request, milestoneVoidTaskLinkBodySchema);
    return await idempotentCommandResponse({
      actorId: guard.actor.id,
      operation: "projects.milestone.void-task-link",
      idempotencyKey,
      request: { path, body },
      execute: async (transaction) => ({
        status: 200,
        body: await voidMilestoneTaskLink(
          {
            projectId: path.projectId,
            milestoneId: path.milestoneId,
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
      projectExecutionErrorResponse(error) ??
      Promise.reject(error)
    );
  }
}

export const POST = withRequestObservability(
  { module: "projects", operation: "command-project-milestone" },
  commandMilestone
);
