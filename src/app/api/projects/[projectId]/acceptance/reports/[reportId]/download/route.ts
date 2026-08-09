import { db } from "@/lib/db";
import { PERMISSIONS } from "@/lib/auth/permissions";
import { authorizeProjectRequest } from "@/lib/auth/project-guard";
import { auditContextFromRequest } from "@/modules/audit/application/context";
import {
  ACCEPTANCE_REPORT_AUDIT_FIELDS,
  AUDIT_ACTIONS,
  AUDIT_OBJECT_TYPES
} from "@/modules/audit/domain/vocabulary";
import { writeAudit } from "@/modules/audit/infrastructure/write-audit";
import { acceptanceReportPathSchema } from "@/modules/acceptance/contracts/acceptance-report-http";
import {
  findFileAuthorizationTarget,
  issueFileDownloadUrl
} from "@/modules/documents/application/file-download-service";
import { createS3ObjectStorageFromEnvironment } from "@/modules/documents/infrastructure/s3-object-storage";
import { withRequestObservability } from "@/modules/observability/application/request-observer";
import { parsePath } from "@/modules/platform-api/contracts/dto";
import { apiContractErrorResponse } from "@/modules/platform-api/contracts/errors";

type RouteContext = { params: Promise<{ projectId: string; reportId: string }> };

async function downloadReport(request: Request, context: RouteContext) {
  const params = await context.params;
  const guard = await authorizeProjectRequest(
    request,
    params.projectId,
    PERMISSIONS.ACCEPTANCE_READ
  );
  if (!guard.authorized) return guard.response;
  try {
    const path = parsePath(acceptanceReportPathSchema, params);
    const report = await db.acceptanceReport.findFirst({
      where: {
        id: path.reportId,
        projectId: path.projectId,
        status: { in: ["READY", "PUBLISHED"] }
      },
      select: { id: true, pdfFileId: true, snapshotChecksum: true, pdfSha256: true }
    });
    if (!report) {
      return Response.json(
        { error: { code: "ACCEPTANCE_REPORT_NOT_FOUND", message: "可下载验收报告不存在。" } },
        { status: 404 }
      );
    }
    const file = await findFileAuthorizationTarget(path.projectId, report.pdfFileId);
    if (!file)
      return Response.json(
        { error: { code: "FILE_NOT_FOUND", message: "报告文件不存在。" } },
        { status: 404 }
      );
    const auditContext = auditContextFromRequest(request, {
      actorId: guard.actor.id,
      projectId: path.projectId,
      departmentId: guard.project.departmentId,
      reason: "下载受控 FAT/SAT 验收报告"
    });
    const response = await issueFileDownloadUrl({
      file,
      actorId: guard.actor.id,
      auditContext,
      storage: createS3ObjectStorageFromEnvironment()
    });
    await writeAudit(db, {
      action: AUDIT_ACTIONS.ACCEPTANCE_REPORT_DOWNLOADED,
      objectType: AUDIT_OBJECT_TYPES.ACCEPTANCE_REPORT,
      objectId: report.id,
      context: auditContext,
      metadata: {
        value: {
          projectId: path.projectId,
          reportId: report.id,
          snapshotChecksum: report.snapshotChecksum,
          pdfSha256: report.pdfSha256
        },
        allowedFields: ACCEPTANCE_REPORT_AUDIT_FIELDS
      }
    });
    return Response.json(response);
  } catch (error) {
    return apiContractErrorResponse(error) ?? Promise.reject(error);
  }
}

export const GET = withRequestObservability(
  { module: "acceptance", operation: "download-report" },
  downloadReport
);
