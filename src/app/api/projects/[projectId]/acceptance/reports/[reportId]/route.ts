import { decideAuthorization } from "@/lib/auth/authorize";
import { db } from "@/lib/db";
import { PERMISSIONS } from "@/lib/auth/permissions";
import { authorizeProjectRequest } from "@/lib/auth/project-guard";
import { auditContextFromRequest } from "@/modules/audit/application/context";
import { getAcceptanceReport } from "@/modules/acceptance/application/acceptance-report-service";
import { acceptanceReportPathSchema } from "@/modules/acceptance/contracts/acceptance-report-http";
import { acceptanceServiceErrorResponse } from "@/modules/acceptance/contracts/acceptance-http";
import {
  AUDIT_ACTIONS,
  AUDIT_OBJECT_TYPES,
  ACCEPTANCE_CONFIRMATION_AUDIT_FIELDS
} from "@/modules/audit/domain/vocabulary";
import { writeAudit } from "@/modules/audit/infrastructure/write-audit";
import { withRequestObservability } from "@/modules/observability/application/request-observer";
import { parsePath } from "@/modules/platform-api/contracts/dto";
import { apiContractErrorResponse } from "@/modules/platform-api/contracts/errors";

type RouteContext = { params: Promise<{ projectId: string; reportId: string }> };

async function getReport(request: Request, context: RouteContext) {
  const params = await context.params;
  const guard = await authorizeProjectRequest(
    request,
    params.projectId,
    PERMISSIONS.ACCEPTANCE_READ
  );
  if (!guard.authorized) return guard.response;
  try {
    const path = parsePath(acceptanceReportPathSchema, params);
    const sensitiveRequested = new URL(request.url).searchParams.get("sensitive") === "true";
    const sensitive =
      sensitiveRequested &&
      decideAuthorization(guard.actor, PERMISSIONS.SENSITIVE_CONFIRMATION_READ, {
        projectId: path.projectId,
        resourceDepartmentId: guard.project.departmentId,
        memberRoles: guard.project.memberRoles
      }).allowed;
    if (sensitiveRequested && !sensitive) {
      return Response.json(
        { error: { code: "FORBIDDEN", message: "无权读取敏感客户确认信息。" } },
        { status: 403 }
      );
    }
    const result = await getAcceptanceReport({ ...path, sensitive });
    if (sensitive) {
      await writeAudit(db, {
        action: AUDIT_ACTIONS.ACCEPTANCE_CONFIRMATION_READ,
        objectType: AUDIT_OBJECT_TYPES.ACCEPTANCE_REPORT,
        objectId: path.reportId,
        context: auditContextFromRequest(request, {
          actorId: guard.actor.id,
          projectId: path.projectId,
          departmentId: guard.project.departmentId,
          reason: "读取敏感客户确认信息"
        }),
        metadata: {
          value: { projectId: path.projectId, reportId: path.reportId },
          allowedFields: ACCEPTANCE_CONFIRMATION_AUDIT_FIELDS
        }
      });
    }
    return Response.json(result);
  } catch (error) {
    return (
      apiContractErrorResponse(error) ??
      acceptanceServiceErrorResponse(error) ??
      Promise.reject(error)
    );
  }
}

export const GET = withRequestObservability(
  { module: "acceptance", operation: "get-report" },
  getReport
);
