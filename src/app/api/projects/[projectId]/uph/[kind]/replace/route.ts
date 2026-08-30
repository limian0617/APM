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

import { replaceSignedUphDraft } from "@/modules/uph/application/uph-definition-service";
import { uphApiErrorResponse } from "@/modules/uph/application/uph-api-errors";
import { uphDraftCorrectionCommandBodySchema } from "@/modules/uph/contracts/uph-http";

const pathSchema = z.strictObject({
  projectId: z.string().trim().min(1),
  kind: z.enum(["TOPOLOGY", "CT", "FORMULA"])
});
type Context = { params: Promise<{ projectId: string; kind: string }> };

async function replace(request: Request, context: Context) {
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
    const body = await parseJsonBody(request, uphDraftCorrectionCommandBodySchema);
    if (body.kind !== path.kind)
      return Response.json(
        { error: { code: "VALIDATION_FAILED", message: "定义类型不一致。" } },
        { status: 422 }
      );
    assertIfMatchMatches(parseIfMatchHeader(request), body.projectVersion, "projectVersion");
    const { idempotencyKey } = parseIdempotencyHeaders(request);
    const auditContext = auditContextFromRequest(request, {
      actorId: guard.actor.id,
      projectId: path.projectId,
      departmentId: guard.project.departmentId,
      reason: body.reason
    });
    return await idempotentCommandResponse({
      actorId: guard.actor.id,
      operation: "projects.uph.definition.replace-signed-draft",
      idempotencyKey,
      request: { path, body },
      execute: async (transaction) => ({
        status: 201,
        body: await replaceSignedUphDraft(
          {
            projectId: path.projectId,
            kind: path.kind,
            reason: body.reason,
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
    return uphApiErrorResponse(error) ?? Promise.reject(error);
  }
}

export const POST = withRequestObservability(
  { module: "uph", operation: "replace-uph-draft" },
  replace
);
