import { Prisma, type PrismaClient } from "@prisma/client";

import { db } from "@/lib/db";
import type { AuditContext } from "@/modules/audit/contracts/audit";
import {
  ARCHIVE_VERSION_AUDIT_FIELDS,
  AUDIT_ACTIONS,
  AUDIT_OBJECT_TYPES,
  AUDIT_SOURCES
} from "@/modules/audit/domain/vocabulary";
import { writeAudit } from "@/modules/audit/infrastructure/write-audit";
import type { JobExecution, JobHandler } from "@/modules/governance/contracts/jobs";
import type { JsonValue } from "@/modules/governance/domain/idempotency";
import { appendOutboxEvent } from "@/modules/governance/infrastructure/outbox";

import {
  buildProjectArchiveManifest,
  type ArchiveManifestSourceInput,
  type ProjectArchiveManifest
} from "./archive-manifest-service";
import { readProjectArchiveSources } from "./archive-source-reader";

type ArchiveGenerationPayload = {
  projectId: string;
  requestedById: string;
};

export type ArchiveVersionWriter = (input: {
  projectId: string;
  requestedById: string;
  generationJobId: string;
  manifest: ProjectArchiveManifest;
}) => Promise<{ id: string; version: number }>;

function parsePayload(job: JobExecution): ArchiveGenerationPayload {
  if (!job.payload || typeof job.payload !== "object" || Array.isArray(job.payload)) {
    throw new TypeError("归档生成作业负载无效。");
  }
  const value = job.payload as Record<string, JsonValue>;
  const projectId = typeof value.projectId === "string" ? value.projectId.trim() : "";
  const requestedById = typeof value.requestedById === "string" ? value.requestedById.trim() : "";
  if (!projectId || !requestedById || projectId.length > 191 || requestedById.length > 191) {
    throw new TypeError("归档生成作业负载无效。");
  }
  return { projectId, requestedById };
}

export function createArchiveGenerationHandler(input: {
  readSources: (projectId: string) => Promise<readonly ArchiveManifestSourceInput[]>;
  createVersion: ArchiveVersionWriter;
  scheduleIntegrityCheck: (input: {
    projectId: string;
    archiveVersionId: string;
    generationJobId: string;
  }) => Promise<void>;
}): JobHandler {
  return async (job) => {
    const payload = parsePayload(job);
    const manifest = await buildProjectArchiveManifest({
      projectId: payload.projectId,
      readSources: input.readSources
    });
    const version = await input.createVersion({
      projectId: payload.projectId,
      requestedById: payload.requestedById,
      generationJobId: job.id,
      manifest
    });
    await input.scheduleIntegrityCheck({
      projectId: payload.projectId,
      archiveVersionId: version.id,
      generationJobId: job.id
    });
  };
}

async function databaseNow(client: Prisma.TransactionClient): Promise<Date> {
  const [row] = await client.$queryRaw<Array<{ now: Date }>>`
    SELECT CURRENT_TIMESTAMP AS "now"
  `;
  if (!row) throw new Error("无法读取数据库时间。");
  return row.now;
}

function workerAuditContext(job: JobExecution, projectId: string, actorId: string): AuditContext {
  return {
    actorId,
    requestId: null,
    traceId: job.traceId ?? job.id,
    source: AUDIT_SOURCES.WORKER,
    sourceIp: null,
    userAgent: null,
    reason: null,
    projectId,
    departmentId: null,
    operationId: job.idempotencyKey
  };
}

export function createPrismaArchiveGenerationHandler(input?: {
  client?: PrismaClient;
  readSources?: (projectId: string) => Promise<readonly ArchiveManifestSourceInput[]>;
}): JobHandler {
  const client = input?.client ?? db;
  const readSources =
    input?.readSources ??
    (async (projectId: string) => readProjectArchiveSources({ projectId, client }));
  return async (job) => {
    const payload = parsePayload(job);
    const manifest = await buildProjectArchiveManifest({
      projectId: payload.projectId,
      readSources
    });
    await client.$transaction(async (transaction) => {
      const existing = await transaction.projectArchiveVersion.findUnique({
        where: { generationJobId: job.id }
      });
      if (existing) {
        await appendOutboxEvent(transaction, {
          eventType: "archive.integrity.check",
          aggregateType: AUDIT_OBJECT_TYPES.PROJECT_ARCHIVE_VERSION,
          aggregateId: existing.id,
          idempotencyKey: `${existing.id}:integrity:1`,
          payload: {
            projectId: payload.projectId,
            archiveVersionId: existing.id,
            generationJobId: job.id
          },
          traceId: job.traceId
        });
        return;
      }

      const archive = await transaction.projectArchive.upsert({
        where: { projectId: payload.projectId },
        create: { projectId: payload.projectId },
        update: {}
      });
      const latest = await transaction.projectArchiveVersion.findFirst({
        where: { archiveId: archive.id, projectId: payload.projectId },
        orderBy: { version: "desc" },
        select: { version: true }
      });
      const versionNumber = (latest?.version ?? 0) + 1;
      const created = await transaction.projectArchiveVersion.create({
        data: {
          archiveId: archive.id,
          projectId: payload.projectId,
          version: versionNumber,
          status: "VERIFYING",
          manifestChecksum: manifest.manifestChecksum,
          sourceWatermark: manifest.sourceWatermark,
          snapshotJson: manifest.snapshotJson as Prisma.InputJsonValue,
          externalPublicationApplicability: "NOT_APPLICABLE",
          externalPublicationReason: manifest.externalPublication.reason,
          createdById: payload.requestedById,
          generationJobId: job.id,
          manifestItems: {
            create: manifest.items.map((item) => ({
              position: item.position,
              sourceType: item.sourceType as never,
              sourceId: item.sourceId,
              sourceVersion: item.sourceVersion,
              sourceChecksum: item.sourceChecksum,
              fileObjectId: item.fileObjectId,
              fileSha256: item.fileSha256,
              fileMimeType: item.fileMimeType,
              fileSize: item.fileSize,
              snapshotJson: item.snapshotJson as Prisma.InputJsonValue
            }))
          }
        },
        select: { id: true, version: true }
      });
      await appendOutboxEvent(transaction, {
        eventType: "archive.integrity.check",
        aggregateType: AUDIT_OBJECT_TYPES.PROJECT_ARCHIVE_VERSION,
        aggregateId: created.id,
        idempotencyKey: `${created.id}:integrity:1`,
        payload: {
          projectId: payload.projectId,
          archiveVersionId: created.id,
          generationJobId: job.id
        },
        traceId: job.traceId
      });
      await writeAudit(transaction, {
        action: AUDIT_ACTIONS.PROJECT_ARCHIVE_GENERATED,
        objectType: AUDIT_OBJECT_TYPES.PROJECT_ARCHIVE_VERSION,
        objectId: created.id,
        context: workerAuditContext(job, payload.projectId, payload.requestedById),
        after: {
          value: {
            projectId: payload.projectId,
            archiveVersionId: created.id,
            version: created.version,
            manifestChecksum: manifest.manifestChecksum,
            sourceWatermark: manifest.sourceWatermark
          },
          allowedFields: ARCHIVE_VERSION_AUDIT_FIELDS
        },
        metadata: {
          value: { generationJobId: job.id, itemCount: manifest.items.length },
          allowedFields: ARCHIVE_VERSION_AUDIT_FIELDS
        }
      });
      await databaseNow(transaction);
    });
  };
}
