import { Prisma } from "@prisma/client";

import { db, inTransaction } from "@/lib/db";
import type { AuditContext } from "@/modules/audit/contracts/audit";
import {
  ARCHIVE_VERSION_AUDIT_FIELDS,
  AUDIT_ACTIONS,
  AUDIT_OBJECT_TYPES
} from "@/modules/audit/domain/vocabulary";
import { writeAudit } from "@/modules/audit/infrastructure/write-audit";
import { appendOutboxEvent } from "@/modules/governance/infrastructure/outbox";
import {
  assertProjectWritable,
  ProjectWritePolicyError
} from "@/modules/projects/domain/project-write-policy";
import { apiErrorResponse } from "@/modules/platform-api/contracts/errors";
import { ARCHIVE_SOURCE_FORMULAS } from "../domain/archive-source-formula";

export class ArchiveServiceError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 422
  ) {
    super(message);
    this.name = "ArchiveServiceError";
  }
}

export function archiveServiceErrorResponse(error: unknown): Response | null {
  if (!(error instanceof ArchiveServiceError)) return null;
  return apiErrorResponse({ status: error.status, code: error.code, message: error.message });
}

function archiveView(version: Record<string, any>) {
  return {
    id: version.id,
    projectId: version.projectId,
    version: version.version,
    status: version.status,
    manifestChecksum: version.manifestChecksum,
    sourceWatermark: version.sourceWatermark,
    archiveSourceFormulaVersion: version.archiveSourceFormulaVersion,
    retrospectiveInputApplicability: version.retrospectiveInputApplicability,
    retrospectiveInputWatermarkVersion: version.retrospectiveInputWatermarkVersion,
    retrospectiveInputWatermark: version.retrospectiveInputWatermark,
    createdAt: version.createdAt?.toISOString?.() ?? version.createdAt,
    finalizedAt: version.finalizedAt?.toISOString?.() ?? version.finalizedAt,
    itemCount: version.manifestItems?.length ?? 0,
    latestIntegrityCheck: version.integrityChecks?.[0]
      ? {
          id: version.integrityChecks[0].id,
          status: version.integrityChecks[0].status,
          checkedAt: version.integrityChecks[0].checkedAt?.toISOString?.() ?? null
        }
      : null
  };
}

export async function listProjectArchives(input: { projectId: string }) {
  const [project, archive] = await Promise.all([
    db.project.findUnique({
      where: { id: input.projectId },
      select: { id: true, status: true, version: true, finalArchiveVersionId: true }
    }),
    db.projectArchive.findUnique({
      where: { projectId: input.projectId },
      include: {
        versions: {
          include: {
            manifestItems: { select: { id: true } },
            integrityChecks: { orderBy: { sequence: "desc" }, take: 1 }
          },
          orderBy: { version: "desc" }
        }
      }
    })
  ]);
  if (!project) throw new ArchiveServiceError("PROJECT_NOT_FOUND", "项目不存在。", 404);
  return {
    projectId: input.projectId,
    project: {
      status: project.status,
      version: project.version,
      finalArchiveVersionId: project.finalArchiveVersionId
    },
    archive: archive
      ? {
          id: archive.id,
          finalArchiveVersionId: archive.finalArchiveVersionId,
          versions: archive.versions.map(archiveView)
        }
      : null
  };
}

export async function requestArchiveGeneration(
  input: { projectId: string; version: number; actorId: string; auditContext: AuditContext },
  transaction?: Prisma.TransactionClient
) {
  return inTransaction(transaction, async (client) => {
    const project = await client.project.findUnique({
      where: { id: input.projectId },
      select: { id: true, status: true, version: true }
    });
    if (!project) throw new ArchiveServiceError("PROJECT_NOT_FOUND", "项目不存在。", 404);
    try {
      assertProjectWritable(project.status);
    } catch (error) {
      if (error instanceof ProjectWritePolicyError)
        throw new ArchiveServiceError(error.code, error.message, error.status);
      throw error;
    }
    if (project.version !== input.version) {
      throw new ArchiveServiceError("PROJECT_VERSION_CONFLICT", "项目已变化，请刷新后重试。", 409);
    }
    const key = `${input.projectId}:archive.generate:v${input.version}`;
    const event = await appendOutboxEvent(client, {
      eventType: "archive.generate",
      aggregateType: AUDIT_OBJECT_TYPES.PROJECT_ARCHIVE,
      aggregateId: input.projectId,
      idempotencyKey: key,
      payload: {
        projectId: input.projectId,
        requestedById: input.actorId,
        archiveSourceFormulaVersion: ARCHIVE_SOURCE_FORMULAS.V2
      }
    });
    const audit = await writeAudit(client, {
      action: AUDIT_ACTIONS.PROJECT_ARCHIVE_GENERATION_REQUESTED,
      objectType: AUDIT_OBJECT_TYPES.PROJECT_ARCHIVE,
      objectId: input.projectId,
      context: { ...input.auditContext, actorId: input.actorId, projectId: input.projectId },
      after: {
        value: {
          projectId: input.projectId,
          generationEventId: event.id,
          expectedProjectVersion: input.version
        },
        allowedFields: ARCHIVE_VERSION_AUDIT_FIELDS
      }
    });
    return {
      projectId: input.projectId,
      status: "QUEUED" as const,
      outboxEventId: event.id,
      auditId: audit.id
    };
  });
}

export async function requestArchiveIntegrityRecheck(
  input: {
    projectId: string;
    archiveVersionId: string;
    version: number;
    actorId: string;
    auditContext: AuditContext;
  },
  transaction?: Prisma.TransactionClient
) {
  return inTransaction(transaction, async (client) => {
    const version = await client.projectArchiveVersion.findFirst({
      where: { id: input.archiveVersionId, projectId: input.projectId },
      select: { id: true, projectId: true, version: true, status: true }
    });
    if (!version)
      throw new ArchiveServiceError("ARCHIVE_VERSION_NOT_FOUND", "归档版本不存在。", 404);
    if (version.version !== input.version) {
      throw new ArchiveServiceError(
        "ARCHIVE_VERSION_CONFLICT",
        "归档版本已变化，请刷新后重试。",
        409
      );
    }
    if (!(["READY", "FAILED"] as const).includes(version.status as "READY" | "FAILED")) {
      throw new ArchiveServiceError("ARCHIVE_RECHECK_INVALID", "当前归档版本不能重新检查。", 409);
    }
    const updated = await client.projectArchiveVersion.updateMany({
      where: { id: version.id, status: version.status as "READY" | "FAILED" },
      data: { status: "VERIFYING" }
    });
    if (updated.count !== 1)
      throw new ArchiveServiceError("ARCHIVE_VERSION_CONFLICT", "归档版本已变化。", 409);
    const event = await appendOutboxEvent(client, {
      eventType: "archive.integrity.check",
      aggregateType: AUDIT_OBJECT_TYPES.PROJECT_ARCHIVE_VERSION,
      aggregateId: version.id,
      idempotencyKey: `${version.id}:integrity:retry:v${version.version}`,
      payload: { projectId: input.projectId, archiveVersionId: version.id }
    });
    const audit = await writeAudit(client, {
      action: AUDIT_ACTIONS.PROJECT_ARCHIVE_INTEGRITY_CHECK_REQUESTED,
      objectType: AUDIT_OBJECT_TYPES.PROJECT_ARCHIVE_VERSION,
      objectId: version.id,
      context: { ...input.auditContext, actorId: input.actorId, projectId: input.projectId },
      after: {
        value: { projectId: input.projectId, archiveVersionId: version.id, status: "VERIFYING" },
        allowedFields: ARCHIVE_VERSION_AUDIT_FIELDS
      }
    });
    return {
      archiveVersionId: version.id,
      status: "VERIFYING" as const,
      outboxEventId: event.id,
      auditId: audit.id
    };
  });
}
