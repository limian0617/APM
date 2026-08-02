import { PERMISSIONS } from "@/lib/auth/permissions";
import { authorizeSystemRequest } from "@/lib/auth/system-guard";
import { auditContextFromRequest } from "@/modules/audit/application/context";
import { AUDIT_OBJECT_TYPES } from "@/modules/audit/domain/vocabulary";
import { replayDeadLetterJob, ReplayJobError } from "@/modules/governance/application/replay-job";

type RouteContext = { params: Promise<{ jobId: string }> };

export async function POST(request: Request, context: RouteContext) {
  const { jobId } = await context.params;
  const guard = await authorizeSystemRequest(
    request,
    PERMISSIONS.JOB_REPLAY,
    AUDIT_OBJECT_TYPES.PERSISTENT_JOB,
    jobId
  );
  if (!guard.authorized) {
    return guard.response;
  }

  try {
    const body = await request.json();
    const input =
      body && typeof body === "object" && !Array.isArray(body)
        ? (body as Record<string, unknown>)
        : {};
    const auditContext = auditContextFromRequest(request, {
      actorId: guard.actor.id,
      reason: typeof input.reason === "string" ? input.reason : null
    });
    return Response.json(
      await replayDeadLetterJob({
        jobId,
        actor: guard.actor,
        reason: input.reason,
        auditContext
      }),
      { status: 202 }
    );
  } catch (error) {
    if (error instanceof ReplayJobError) {
      return Response.json(
        { error: { code: error.code, message: error.message } },
        { status: error.status }
      );
    }
    if (error instanceof SyntaxError) {
      return Response.json(
        { error: { code: "INVALID_JSON", message: "请求体不是有效 JSON。" } },
        { status: 400 }
      );
    }
    throw error;
  }
}
