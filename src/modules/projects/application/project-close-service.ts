import { Prisma, type PrismaClient } from "@prisma/client";

import { db } from "@/lib/db";
import {
  buildProjectArchiveManifest,
  type ArchiveManifestSourceInput
} from "@/modules/archives/application/archive-manifest-service";
import {
  readProjectArchiveSources,
  type ArchiveSourceClient
} from "@/modules/archives/application/archive-source-reader";
import type { AuditContext } from "@/modules/audit/contracts/audit";
import {
  ARCHIVE_VERSION_AUDIT_FIELDS,
  AUDIT_ACTIONS,
  AUDIT_OBJECT_TYPES,
  AUDIT_SOURCES
} from "@/modules/audit/domain/vocabulary";
import { writeAudit } from "@/modules/audit/infrastructure/write-audit";
import { appendOutboxEvent } from "@/modules/governance/infrastructure/outbox";

export type ProjectCloseFacts = {
  projectId: string;
  projectStatus: string;
  projectVersion: number;
  expectedProjectVersion: number;
  g9Approved: boolean;
  g9ArchiveVersionId: string | null;
  archiveVersionId: string | null;
  archiveStatus: string | null;
  manifestChecksum: string | null;
  g9ManifestChecksum: string | null;
  sourceWatermark: string | null;
  g9SourceWatermark: string | null;
  sourceFactsCurrent: boolean;
  openResidualItemIds: readonly string[];
};

export class ProjectCloseError extends Error {
  constructor(
    readonly code:
      | "PROJECT_G9_NOT_APPROVED"
      | "PROJECT_ARCHIVE_NOT_READY"
      | "PROJECT_ARCHIVE_FACTS_STALE"
      | "PROJECT_RESIDUALS_OPEN"
      | "PROJECT_VERSION_CONFLICT"
      | "PROJECT_NOT_FOUND"
      | "PROJECT_ALREADY_CLOSED",
    message: string,
    readonly status = 409
  ) {
    super(message);
    this.name = "ProjectCloseError";
  }
}

export function assertProjectCanClose(facts: ProjectCloseFacts): void {
  if (facts.expectedProjectVersion !== facts.projectVersion) {
    throw new ProjectCloseError("PROJECT_VERSION_CONFLICT", "项目已变化，请刷新后重试。");
  }
  if (facts.projectStatus === "CLOSED") {
    throw new ProjectCloseError("PROJECT_ALREADY_CLOSED", "项目已经结项。");
  }
  if (!facts.g9Approved || !facts.g9ArchiveVersionId) {
    throw new ProjectCloseError("PROJECT_G9_NOT_APPROVED", "项目级 G9 尚未批准。");
  }
  if (
    !facts.archiveVersionId ||
    facts.archiveVersionId !== facts.g9ArchiveVersionId ||
    facts.archiveStatus !== "READY" ||
    !facts.manifestChecksum ||
    !facts.sourceWatermark
  ) {
    throw new ProjectCloseError("PROJECT_ARCHIVE_NOT_READY", "归档版本不是确切的 READY 版本。");
  }
  if (
    facts.manifestChecksum !== facts.g9ManifestChecksum ||
    facts.sourceWatermark !== facts.g9SourceWatermark ||
    !facts.sourceFactsCurrent
  ) {
    throw new ProjectCloseError(
      "PROJECT_ARCHIVE_FACTS_STALE",
      "归档事实已偏离 G9 快照，请重新检查。"
    );
  }
  if (facts.openResidualItemIds.length > 0) {
    throw new ProjectCloseError("PROJECT_RESIDUALS_OPEN", "仍存在未闭环遗留项，不能结项。");
  }
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function workerContext(actorId: string, projectId: string, operationId: string): AuditContext {
  return {
    actorId,
    requestId: null,
    traceId: operationId,
    source: AUDIT_SOURCES.API,
    sourceIp: null,
    userAgent: null,
    reason: null,
    projectId,
    departmentId: null,
    operationId
  };
}

export async function closeProject(input: {
  projectId: string;
  archiveVersionId: string;
  g9SubmissionId: string;
  expectedProjectVersion: number;
  actorId: string;
  operationId: string;
  client?: PrismaClient | Prisma.TransactionClient;
}) {
  const operation = async (transaction: Prisma.TransactionClient) => {
    await transaction.$queryRaw`SELECT id FROM "projects" WHERE id = ${input.projectId} FOR UPDATE`;
    const project = await transaction.project.findUnique({
      where: { id: input.projectId },
      select: { id: true, status: true, version: true, finalArchiveVersionId: true }
    });
    if (!project) throw new ProjectCloseError("PROJECT_NOT_FOUND", "项目不存在。", 404);
    if (project.status === "CLOSED" && project.finalArchiveVersionId === input.archiveVersionId) {
      return {
        projectId: project.id,
        status: "CLOSED" as const,
        finalArchiveVersionId: input.archiveVersionId,
        idempotent: true
      };
    }
    const submission = await transaction.gateSubmission.findFirst({
      where: {
        id: input.g9SubmissionId,
        projectId: input.projectId,
        status: "APPROVED",
        gateInstance: { scope: "PROJECT", gateDefinition: { code: "G9" } }
      },
      include: { gateCheckSnapshot: { include: { results: true } } }
    });
    const closureResult = submission?.gateCheckSnapshot.results.find(
      (result) => result.checkerCode === "CLOSURE.ARCHIVE.G9" && result.checkerVersion === 1
    );
    const evidence = closureResult?.evidenceJson;
    const evidenceRecord =
      evidence && typeof evidence === "object" && !Array.isArray(evidence)
        ? (evidence as Record<string, unknown>)
        : {};
    const archive = await transaction.projectArchiveVersion.findFirst({
      where: { id: input.archiveVersionId, projectId: input.projectId },
      select: {
        id: true,
        status: true,
        manifestChecksum: true,
        sourceWatermark: true
      }
    });
    const openResiduals = await transaction.residualItem.findMany({
      where: { projectId: input.projectId, status: { not: "CLOSED" } },
      select: { id: true }
    });
    let sourceFactsCurrent = false;
    if (archive) {
      try {
        const currentManifest = await buildProjectArchiveManifest({
          projectId: input.projectId,
          readSources: (projectId) =>
            readProjectArchiveSources({
              projectId,
              client: transaction as unknown as ArchiveSourceClient
            }) as Promise<readonly ArchiveManifestSourceInput[]>
        });
        sourceFactsCurrent = currentManifest.sourceWatermark === archive.sourceWatermark;
      } catch {
        sourceFactsCurrent = false;
      }
    }
    assertProjectCanClose({
      projectId: project.id,
      projectStatus: project.status,
      projectVersion: project.version,
      expectedProjectVersion: input.expectedProjectVersion,
      g9Approved: Boolean(submission && closureResult?.status === "PASSED"),
      g9ArchiveVersionId: text(evidenceRecord.archiveVersionId),
      archiveVersionId: archive?.id ?? null,
      archiveStatus: archive?.status ?? null,
      manifestChecksum: archive?.manifestChecksum ?? null,
      g9ManifestChecksum: text(evidenceRecord.manifestChecksum),
      sourceWatermark: archive?.sourceWatermark ?? null,
      g9SourceWatermark: text(evidenceRecord.sourceWatermark),
      sourceFactsCurrent,
      openResidualItemIds: openResiduals.map((residual) => residual.id)
    });
    const now = new Date();
    await transaction.projectArchiveVersion.update({
      where: { id: input.archiveVersionId },
      data: { status: "FINALIZED", finalizedAt: now }
    });
    const closed = await transaction.project.updateMany({
      where: {
        id: input.projectId,
        version: input.expectedProjectVersion,
        status: { not: "CLOSED" }
      },
      data: {
        status: "CLOSED",
        finalArchiveVersionId: input.archiveVersionId,
        version: { increment: 1 }
      }
    });
    if (closed.count !== 1) {
      throw new ProjectCloseError("PROJECT_VERSION_CONFLICT", "项目已变化，请刷新后重试。", 409);
    }
    await writeAudit(transaction, {
      action: AUDIT_ACTIONS.PROJECT_CLOSED,
      objectType: AUDIT_OBJECT_TYPES.PROJECT,
      objectId: input.projectId,
      context: workerContext(input.actorId, input.projectId, input.operationId),
      after: {
        value: {
          projectId: input.projectId,
          finalArchiveVersionId: input.archiveVersionId,
          status: "CLOSED",
          manifestChecksum: archive?.manifestChecksum,
          sourceWatermark: archive?.sourceWatermark
        },
        allowedFields: ARCHIVE_VERSION_AUDIT_FIELDS
      }
    });
    await appendOutboxEvent(transaction, {
      eventType: "project.closed",
      aggregateType: AUDIT_OBJECT_TYPES.PROJECT,
      aggregateId: input.projectId,
      idempotencyKey: `${input.projectId}:closed:${input.archiveVersionId}`,
      payload: {
        projectId: input.projectId,
        finalArchiveVersionId: input.archiveVersionId,
        closedAt: now.toISOString()
      },
      traceId: input.operationId
    });
    return {
      projectId: input.projectId,
      status: "CLOSED" as const,
      finalArchiveVersionId: input.archiveVersionId,
      idempotent: false
    };
  };
  if (input.client) return operation(input.client as Prisma.TransactionClient);
  return db.$transaction(operation, {
    isolationLevel: Prisma.TransactionIsolationLevel.Serializable
  });
}
