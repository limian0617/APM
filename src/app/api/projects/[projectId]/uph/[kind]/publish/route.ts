import { PERMISSIONS } from "@/lib/auth/permissions";
import { authorizeProjectRequest } from "@/lib/auth/project-guard";
import { auditContextFromRequest } from "@/modules/audit/application/context";
import { withRequestObservability } from "@/modules/observability/application/request-observer";
import { idempotentCommandResponse } from "@/modules/platform-api/application/idempotent-command";
import {
  assertIfMatchMatches,
  parseIdempotencyHeaders,
  parseIfMatchHeader,
  parseJsonBody,
  parsePath
} from "@/modules/platform-api/contracts/dto";
import { z } from "zod";

import { publishUphDefinition } from "@/modules/uph/application/uph-definition-service";
import { uphApiErrorResponse } from "@/modules/uph/application/uph-api-errors";
import { uphVersionCommandBodySchema } from "@/modules/uph/contracts/uph-http";

const pathSchema = z.strictObject({
  projectId: z.string().trim().min(1),
  kind: z.enum(["TOPOLOGY", "CT", "FORMULA"])
});
type Context = { params: Promise<{ projectId: string; kind: string }> };

async function publish(request: Request, context: Context) {
  const raw = await context.params;
  const path = parsePath(pathSchema, raw);
  const guard = await authorizeProjectRequest(
    request,
    path.projectId,
    PERMISSIONS.PROJECT_UPH_PUBLISH,
    { requireProjectMembership: true }
  );
  if (!guard.authorized) return guard.response;
  try {
    const body = await parseJsonBody(request, uphVersionCommandBodySchema);
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
      operation: "projects.uph.definition.publish",
      idempotencyKey,
      request: { path, body },
      execute: async (transaction) => ({
        status: 200,
        body: await publishUphDefinition(
          {
            ...path,
            ...body,
            actorId: guard.actor.id,
            authorizationActor: guard.actor,
            auditContext
          },
          transaction
        )
      })
    });
  } catch (error) {
    return uphApiErrorResponse(error) ?? Promise.reject(error);
  }
}

export const POST = withRequestObservability(
  { module: "uph", operation: "publish-uph-definition" },
  publish
);
